import { afterEach, describe, expect, test } from 'bun:test';
import { Deferred, Effect, Exit, Option, Scope } from 'effect';
import { TestClock } from 'effect/testing';

import { WrongCode } from '../src/failure.js';
import type { OAuthProvider } from '../src/oauth.js';
import { isEmailAddress, makeSignInFlow, RESEND_SECONDS, type SignInActions, type SignInFlowOptions } from '../src/sign-in-flow.js';

/** An app failure besides the package's `WrongCode`. */
class Down extends Error {
  readonly _tag = 'Down';
}
type Failure = WrongCode | Down;

/** Actions whose outcome each test sets, recording what they were called with. */
const scripted = () => {
  const calls: Array<[string, string]> = [];
  const outcome: { send: Effect.Effect<void, Failure>; code: Effect.Effect<void, Failure>; oauth: Effect.Effect<void, Failure> } = {
    send: Effect.void,
    code: Effect.void,
    oauth: Effect.void,
  };
  const actions: SignInActions<Failure> = {
    sendCode: (email) => Effect.suspend(() => (calls.push(['sendCode', email]), outcome.send)),
    signInWithCode: (code) => Effect.suspend(() => (calls.push(['signInWithCode', code]), outcome.code)),
    signInWith: (provider: OAuthProvider) => Effect.suspend(() => (calls.push(['signInWith', provider]), outcome.oauth)),
  };
  return { calls, outcome, actions };
};

/** Runs `body` with a flow over `actions` on a `TestClock`, in a scope closed after it. */
const withFlow = <A>(actions: SignInActions<Failure>, body: (flow: Effect.Success<ReturnType<typeof makeSignInFlow<Failure, never>>>) => Effect.Effect<A>, options?: SignInFlowOptions<Failure>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeSignInFlow(actions, options), body)).pipe(Effect.provide(TestClock.layer())));

/** Lets forked fibers run. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 5 }));

describe('the email step', () => {
  test('an email missing or malformed is its field’s problem, and nothing is sent; typing clears it', async () => {
    const { calls, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* flow.submitEmail;
        const missing = (yield* flow.state).emailProblem;
        yield* flow.setEmail('  artist ');
        yield* flow.submitEmail;
        const malformed = (yield* flow.state).emailProblem;
        yield* flow.setEmail('artist@');
        return { missing, malformed, cleared: (yield* flow.state).emailProblem };
      }),
    );
    expect(seen).toEqual({ missing: Option.some('Missing'), malformed: Option.some('Malformed'), cleared: Option.none() });
    expect(calls).toEqual([]);
  });

  test('the app’s own check of an address', async () => {
    const { calls, actions } = scripted();
    const problem = await withFlow(
      actions,
      (flow) =>
        Effect.gen(function* () {
          yield* flow.setEmail('a@b');
          yield* flow.submitEmail;
          return (yield* flow.state).emailProblem;
        }),
      { isEmail: (email) => /\.\w+$/.test(email) },
    );
    expect(problem).toEqual(Option.some('Malformed'));
    expect(calls).toEqual([]);
    expect([isEmailAddress('a@b'), isEmailAddress('name@example.com'), isEmailAddress('a b@c.d'), isEmailAddress('ä@b.c')]).toEqual([true, true, false, false]);
  });

  test('a sent code: the code step, the trimmed email sent once, Resend in 30 s (TestClock)', async () => {
    const { calls, actions } = scripted();
    const changes: number[] = [];
    const seen = await withFlow(
      actions,
      (flow) =>
        Effect.gen(function* () {
          yield* flow.setEmail(' artist@example.com ');
          yield* flow.submitEmail;
          yield* settle;
          const sent = yield* flow.state;
          yield* flow.resend;
          yield* TestClock.adjust('10 seconds');
          const later = (yield* flow.state).resendIn;
          yield* TestClock.adjust('20 seconds');
          const ready = (yield* flow.state).resendIn;
          yield* flow.resend;
          yield* settle;
          return { step: sent.step, running: sent.running, resendIn: sent.resendIn, later, ready, again: (yield* flow.state).resendIn };
        }),
      { onChange: (state) => changes.push(state.resendIn) },
    );
    expect(seen).toEqual({ step: 'code', running: Option.none(), resendIn: RESEND_SECONDS, later: 20, ready: 0, again: 30 });
    expect(calls).toEqual([
      ['sendCode', 'artist@example.com'],
      ['sendCode', 'artist@example.com'],
    ]);
    expect(changes).toContain(1);
  });

  test('a code not sent is the alert line’s; editing the email clears it, and nothing runs twice at once', async () => {
    const { calls, outcome, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void, Failure>();
        outcome.send = Deferred.await(gate);
        yield* flow.setEmail('artist@example.com');
        yield* flow.submitEmail;
        const running = (yield* flow.state).running;
        yield* flow.submitEmail;
        yield* flow.continueWith('google');
        yield* flow.differentEmail;
        yield* Deferred.fail(gate, new Down());
        yield* settle;
        const failed = yield* flow.state;
        yield* flow.setCode('1');
        const afterCode = (yield* flow.state).failure;
        yield* flow.setEmail('artist@example.co');
        return { running, step: failed.step, from: Option.map(failed.failure, (f) => [f.from, f.error._tag]), afterCode: Option.isSome(afterCode), afterEmail: (yield* flow.state).failure };
      }),
    );
    expect(seen).toEqual({ running: Option.some('send'), step: 'email', from: Option.some(['send', 'Down']), afterCode: false, afterEmail: Option.none() });
    expect(calls).toEqual([['sendCode', 'artist@example.com']]);
  });
});

describe('the code step', () => {
  const toCode = (flow: Effect.Success<ReturnType<typeof makeSignInFlow<Failure, never>>>) =>
    Effect.gen(function* () {
      yield* flow.setEmail('artist@example.com');
      yield* flow.submitEmail;
      yield* settle;
    });

  test('a wrong code is the field’s: emptied, `onWrongCode`; typing clears it', async () => {
    const { calls, outcome, actions } = scripted();
    outcome.code = Effect.fail(new WrongCode({ cause: 'invalid_credentials', code: 'invalid_credentials' }));
    let refocused = 0;
    const seen = await withFlow(
      actions,
      (flow) =>
        Effect.gen(function* () {
          yield* toCode(flow);
          yield* flow.setCode('12345');
          yield* flow.submitCode();
          yield* flow.setCode('123456');
          yield* flow.submitCode();
          yield* settle;
          const wrong = yield* flow.state;
          yield* flow.setCode('1');
          return { code: wrong.code, failure: Option.map(wrong.failure, (f) => [f.from, f.error._tag]), cleared: (yield* flow.state).failure };
        }),
      { onWrongCode: () => refocused++ },
    );
    expect(seen).toEqual({ code: '', failure: Option.some(['code', 'WrongCode']), cleared: Option.none() });
    expect(refocused).toBe(1);
    expect(calls.at(-1)).toEqual(['signInWithCode', '123456']);
  });

  test('another failure is the alert line’s, the code kept; a code given to submitCode is used', async () => {
    const { calls, outcome, actions } = scripted();
    outcome.code = Effect.fail(new Down());
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* toCode(flow);
        yield* flow.submitCode('654321');
        yield* settle;
        return yield* flow.state;
      }),
    );
    expect(seen.code).toBe('654321');
    expect(Option.map(seen.failure, (f) => f.from)).toEqual(Option.some('code'));
    expect(calls.at(-1)).toEqual(['signInWithCode', '654321']);
  });

  test('signed in: nothing shows; a defect only ends the busy state', async () => {
    const { outcome, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* toCode(flow);
        yield* flow.submitCode('123456');
        yield* settle;
        const signedIn = yield* flow.state;
        outcome.code = Effect.die('boom');
        yield* flow.submitCode('123456');
        yield* settle;
        return { signedIn: [signedIn.running, signedIn.failure], died: [(yield* flow.state).running, (yield* flow.state).failure] };
      }),
    );
    expect(seen as unknown).toEqual({ signedIn: [Option.none(), Option.none()], died: [Option.none(), Option.none()] });
  });

  test('Use a Different Email: the email step, the code and the failure cleared, the email kept; not while checking', async () => {
    const { outcome, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* toCode(flow);
        const gate = yield* Deferred.make<void, Failure>();
        outcome.code = Deferred.await(gate);
        yield* flow.submitCode('123456');
        yield* flow.submitCode('654321');
        yield* flow.differentEmail;
        yield* flow.resend;
        const checking = yield* flow.state;
        yield* Deferred.fail(gate, new Down());
        yield* settle;
        yield* flow.differentEmail;
        return { checking: [checking.step, checking.running], back: yield* flow.state };
      }),
    );
    expect(seen.checking).toEqual(['code', Option.some('code')]);
    expect(seen.back).toMatchObject({ step: 'email', code: '', email: 'artist@example.com', failure: Option.none() });
  });
});

describe('Google and Apple', () => {
  const page = new EventTarget();
  const original = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  test('busy until the page leaves; back from the back/forward cache, not busy', async () => {
    (globalThis as { window?: unknown }).window = page;
    const { calls, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* flow.continueWith('google');
        yield* settle;
        const leaving = (yield* flow.state).running;
        page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
        yield* settle;
        const stillLeaving = (yield* flow.state).running;
        page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        yield* settle;
        return { leaving, stillLeaving, back: (yield* flow.state).running };
      }),
    );
    expect(seen).toEqual({ leaving: Option.some('google'), stillLeaving: Option.some('google'), back: Option.none() });
    expect(calls).toEqual([['signInWith', 'google']]);
  });

  test('closed while leaving, the page’s listener is removed', async () => {
    const listening: string[] = [];
    (globalThis as { window?: unknown }).window = {
      addEventListener: () => listening.push('add'),
      removeEventListener: () => listening.push('remove'),
    };
    const { actions } = scripted();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const flow = yield* makeSignInFlow(actions);
          yield* flow.continueWith('apple');
          yield* settle;
        }),
      ),
    );
    expect(listening).toEqual(['add', 'remove']);
  });

  test('a failure is the alert line’s, and editing the email or code keeps it', async () => {
    const { outcome, actions } = scripted();
    outcome.oauth = Effect.fail(new Down());
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* flow.continueWith('apple');
        yield* settle;
        yield* flow.setEmail('a');
        yield* flow.setCode('1');
        return yield* flow.state;
      }),
    );
    expect(seen.running).toEqual(Option.none());
    expect(Option.map(seen.failure, (f) => [f.from, f.error._tag])).toEqual(Option.some(['oauth', 'Down']));
  });

  test('without a window the page never comes back: busy until the scope closes, then not', async () => {
    (globalThis as { window?: unknown }).window = undefined;
    const { actions } = scripted();
    const states: Array<Option.Option<string>> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const flow = yield* makeSignInFlow(actions, { onChange: (state) => states.push(state.running) }).pipe(Scope.provide(scope));
        yield* flow.continueWith('google');
        yield* settle;
        yield* Scope.close(scope, Exit.void);
      }),
    );
    expect(states.at(-1)).toEqual(Option.none());
    expect(states).toContainEqual(Option.some('google'));
  });
});
