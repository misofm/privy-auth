import { afterEach, describe, expect, test } from 'bun:test';
import { Deferred, Effect, Exit, Option, Scope } from 'effect';
import { TestClock } from 'effect/testing';

import { WrongCode } from '../src/failure.js';
import type { OAuthProvider } from '../src/oauth.js';
import {
  initialFlowState,
  isEmailAddress,
  makeSignInFlow,
  RESEND_SECONDS,
  sentCode,
  type SignInActions,
  type SignInEffect,
  type SignInEvent,
  type SignInFlowOptions,
  type SignInFlowState,
  transition,
} from '../src/sign-in-flow.js';

/** An app failure besides the package's `WrongCode`. */
class Down extends Error {
  readonly _tag = 'Down';
}
type Failure = WrongCode | Down;
type State = SignInFlowState<Failure>;
type Event = SignInEvent<Failure>;

const wrongCode = () => new WrongCode({ cause: 'invalid_credentials', code: 'invalid_credentials' });

describe('the state machine (transition)', () => {
  const email = ' artist@example.com ';
  const address = 'artist@example.com';
  const sent = { to: address, resendIn: 12 };
  /** One of each state (`Leaving` before and after its action succeeds). */
  const states = {
    Email: { _tag: 'Email', email, emailProblem: Option.none(), failure: Option.none(), sent: Option.none() },
    Sending: { _tag: 'Sending', email, to: address, sent: Option.some({ to: 'other@example.com', resendIn: 12 }) },
    Code: { _tag: 'Code', email, code: '123456', failure: Option.none(), sent: { to: address, resendIn: 0 } },
    Resending: { _tag: 'Resending', email, code: '12', sent },
    Checking: { _tag: 'Checking', email, code: '123456', sent },
    Leaving: { _tag: 'Leaving', email, provider: 'google', left: false, sent: Option.some(sent) },
    Left: { _tag: 'Leaving', email, provider: 'google', left: true, sent: Option.none() },
  } satisfies Record<string, State>;
  /** One of each event. */
  const events = {
    SetEmail: { _tag: 'SetEmail', email: 'a' },
    SubmitEmail: { _tag: 'SubmitEmail' },
    SetCode: { _tag: 'SetCode', code: '1' },
    SubmitCode: { _tag: 'SubmitCode', code: Option.none() },
    Resend: { _tag: 'Resend' },
    DifferentEmail: { _tag: 'DifferentEmail' },
    ContinueWith: { _tag: 'ContinueWith', provider: 'apple' },
    StartOver: { _tag: 'StartOver' },
    Sent: { _tag: 'Sent' },
    Accepted: { _tag: 'Accepted' },
    Left: { _tag: 'Left' },
    Failed: { _tag: 'Failed', error: new Down() },
    Ended: { _tag: 'Ended' },
    CameBack: { _tag: 'CameBack' },
    Tick: { _tag: 'Tick', resendIn: 5 },
  } satisfies Record<Event['_tag'], Event>;

  /** Every pair that does something: where it leads, and what it asks for. Any other pair is ignored. */
  const table: { readonly [S in keyof typeof states]: { readonly [K in Event['_tag']]?: readonly [State['_tag'], ...Array<SignInEffect['_tag']>] } } = {
    Email: { SetEmail: ['Email'], SubmitEmail: ['Sending', 'Send'], ContinueWith: ['Leaving', 'Leave'], StartOver: ['Email'] },
    Sending: { Sent: ['Code', 'Countdown'], Failed: ['Email'], Ended: ['Email'], Tick: ['Sending'] },
    Code: { SetCode: ['Code'], SubmitCode: ['Checking', 'Check'], Resend: ['Resending', 'Send'], DifferentEmail: ['Email'], StartOver: ['Email'], ContinueWith: ['Leaving', 'Leave'], Tick: ['Code'] },
    Resending: { Sent: ['Code', 'Countdown'], Failed: ['Code'], Ended: ['Code'], Tick: ['Resending'] },
    Checking: { Accepted: ['Code', 'EndCountdown'], Failed: ['Code'], Ended: ['Code'], Tick: ['Checking'] },
    Leaving: { Left: ['Leaving', 'AwaitReturn'], Failed: ['Email'], Ended: ['Email'], Tick: ['Leaving'] },
    Left: { CameBack: ['Email'], StartOver: ['Email', 'Cancel'], Ended: ['Email'] },
  };

  test('every state takes every event: it leads somewhere, or changes nothing', () => {
    let pairs = 0;
    for (const [name, state] of Object.entries(states) as Array<[keyof typeof states, State]>) {
      for (const event of Object.values(events) as Event[]) {
        pairs++;
        const [next, effects] = transition(state, event);
        const expected = table[name][event._tag];
        const what = `${name} + ${event._tag}`;
        if (expected === undefined) {
          expect([what, next === state, effects]).toEqual([what, true, []]);
        } else {
          expect([what, next === state, next._tag, ...effects.map((effect) => effect._tag)]).toEqual([what, false, ...expected]);
        }
      }
    }
    expect(pairs).toBe(7 * 15);
  });

  test('the email: its problems, the trimmed address sent; typing clears the problem and a send’s failure, not Google’s', () => {
    const typing = (typed: string) => transition<Failure>({ ...states.Email, email: typed }, events.SubmitEmail);
    expect(typing('  ')[0]).toMatchObject({ _tag: 'Email', emailProblem: Option.some('Missing') });
    expect(typing(' artist ')[0]).toMatchObject({ _tag: 'Email', emailProblem: Option.some('Malformed') });
    expect(typing(email)).toEqual([{ _tag: 'Sending', email, to: address, sent: Option.none() }, [{ _tag: 'Send', to: address }]]);
    expect(transition<Failure>({ ...states.Email, email: 'a@b' }, events.SubmitEmail, (typed) => /\.\w+$/.test(typed))[0]).toMatchObject({ emailProblem: Option.some('Malformed') });
    const failed = (from: 'send' | 'oauth'): State => ({ ...states.Email, emailProblem: Option.some('Malformed'), failure: Option.some({ from, error: new Down() }) });
    expect(transition(failed('send'), events.SetEmail)[0]).toMatchObject({ email: 'a', emailProblem: Option.none(), failure: Option.none() });
    expect(Option.isSome((transition(failed('oauth'), events.SetEmail)[0] as typeof states.Email).failure)).toBe(true);
    expect(transition(failed('oauth'), events.StartOver)[0]).toMatchObject({ emailProblem: Option.none(), failure: Option.none() });
  });

  test('a code that went to the address less than the wait ago stands: the code step, and none sent', () => {
    const standing: State = { ...states.Email, sent: Option.some(sent) };
    expect(transition(standing, events.SubmitEmail)).toEqual([{ _tag: 'Code', email, code: '', failure: Option.none(), sent }, []]);
    // The wait over, or another address: a code is sent.
    expect(transition<Failure>({ ...standing, sent: Option.some({ ...sent, resendIn: 0 }) }, events.SubmitEmail)[1]).toEqual([{ _tag: 'Send', to: address }]);
    expect(transition<Failure>({ ...standing, email: 'other@example.com' }, events.SubmitEmail)[1]).toEqual([{ _tag: 'Send', to: 'other@example.com' }]);
  });

  test('sending: sent is the code step, emptied, the wait begun; a failure is back with the alert', () => {
    expect(transition<Failure>(states.Sending, events.Sent)[0]).toEqual({ _tag: 'Code', email, code: '', failure: Option.none(), sent: { to: address, resendIn: RESEND_SECONDS } });
    expect(transition<Failure>(states.Sending, events.Failed)[0]).toMatchObject({ _tag: 'Email', failure: Option.some({ from: 'send' }), sent: states.Sending.sent });
    expect(transition<Failure>(states.Resending, events.Sent)[0]).toEqual({ _tag: 'Code', email, code: '', failure: Option.none(), sent: { to: address, resendIn: RESEND_SECONDS } });
    expect(transition<Failure>(states.Resending, events.Failed)[0]).toMatchObject({ _tag: 'Code', code: '12', failure: Option.some({ from: 'send' }) });
    expect(transition<Failure>(states.Resending, events.Ended)[0]).toMatchObject({ _tag: 'Code', code: '12', failure: Option.none() });
  });

  test('the code: checked at six digits, given or typed; another only once the wait is over; typing clears its failure', () => {
    expect(transition<Failure>({ ...states.Code, code: '12345' }, events.SubmitCode)[0]._tag).toBe('Code');
    expect(transition<Failure>({ ...states.Code, code: '1' }, { _tag: 'SubmitCode', code: Option.some('654321') })).toEqual([
      { _tag: 'Checking', email, code: '654321', sent: states.Code.sent },
      [{ _tag: 'Check', code: '654321' }],
    ]);
    expect(transition<Failure>({ ...states.Code, sent }, events.Resend)[0]._tag).toBe('Code');
    expect(transition<Failure>(states.Code, events.Resend)[1]).toEqual([{ _tag: 'Send', to: address }]);
    expect(transition<Failure>({ ...states.Code, failure: Option.some({ from: 'code', error: wrongCode() }) }, events.SetCode)[0]).toMatchObject({ code: '1', failure: Option.none() });
    expect(transition<Failure>(states.Code, events.DifferentEmail)[0]).toEqual({ _tag: 'Email', email, emailProblem: Option.none(), failure: Option.none(), sent: Option.some(states.Code.sent) });
    expect(transition<Failure>(states.Code, events.ContinueWith)[0]).toMatchObject({ _tag: 'Leaving', provider: 'apple', left: false, sent: Option.some(states.Code.sent) });
  });

  test('checking: an accepted code is spent (the field emptied, the resend wait over); a wrong code empties the field and focuses it; another failure keeps the code', () => {
    expect(transition<Failure>(states.Checking, events.Accepted)).toEqual([{ _tag: 'Code', email, code: '', failure: Option.none(), sent: { to: address, resendIn: 0 } }, [{ _tag: 'EndCountdown' }]]);
    expect(transition<Failure>(states.Checking, { _tag: 'Failed', error: wrongCode() })).toMatchObject([{ _tag: 'Code', code: '', failure: Option.some({ from: 'code' }) }, [{ _tag: 'Refocus' }]]);
    expect(transition<Failure>(states.Checking, events.Failed)).toMatchObject([{ _tag: 'Code', code: '123456', failure: Option.some({ from: 'code' }) }, []]);
    expect(transition<Failure>(states.Checking, events.Ended)[0]).toMatchObject({ _tag: 'Code', code: '123456', failure: Option.none() });
  });

  test('leaving: a failure is the alert line’s; the wait counts down in every state that knows a code', () => {
    expect(transition<Failure>(states.Leaving, events.Failed)[0]).toMatchObject({ _tag: 'Email', failure: Option.some({ from: 'oauth' }), sent: Option.some(sent) });
    expect(transition<Failure>(states.Leaving, events.Left)[0]).toMatchObject({ _tag: 'Leaving', left: true });
    for (const state of [states.Sending, states.Resending, states.Checking, states.Leaving, { ...states.Email, sent: Option.some(sent) }] as State[]) {
      const [next] = transition(state, events.Tick);
      expect(Option.map(sentCode(next), (code) => code.resendIn)).toEqual(Option.some(5));
      expect(transition(next, events.Tick)[0]).toBe(next);
    }
    expect(sentCode(states.Email)).toEqual(Option.none());
  });

  test('isEmailAddress: as <input type="email"> checks', () => {
    expect([isEmailAddress('a@b'), isEmailAddress('name@example.com'), isEmailAddress('a b@c.d'), isEmailAddress('ä@b.c')]).toEqual([true, true, false, false]);
  });
});

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

type Flow = Effect.Success<ReturnType<typeof makeSignInFlow<Failure, never>>>;

/** Runs `body` with a flow over `actions` on a `TestClock`, in a scope closed after it. */
const withFlow = <A>(actions: SignInActions<Failure>, body: (flow: Flow) => Effect.Effect<A>, options?: SignInFlowOptions<Failure>, initial?: State) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeSignInFlow(actions, options, initial), body)).pipe(Effect.provide(TestClock.layer())));

/** Lets forked fibers run. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 5 }));
const tagOf = (flow: Flow) => Effect.map(flow.state, (state) => state._tag);
const resendIn = (flow: Flow) => Effect.map(flow.state, (state) => Option.match(sentCode(state), { onNone: () => 0, onSome: (code) => code.resendIn }));

const toCode = (flow: Flow) =>
  Effect.gen(function* () {
    yield* flow.setEmail('artist@example.com');
    yield* flow.submitEmail;
    yield* settle;
  });

describe('the flow: the email step', () => {
  test('an email missing or malformed is its field’s problem, and nothing is sent; the app’s own check', async () => {
    const { calls, actions } = scripted();
    const seen = await withFlow(
      actions,
      (flow) =>
        Effect.gen(function* () {
          yield* flow.submitEmail;
          const missing = yield* flow.state;
          yield* flow.setEmail('a@b');
          yield* flow.submitEmail;
          return { missing, malformed: yield* flow.state };
        }),
      { isEmail: (email) => /\.\w+$/.test(email) },
    );
    expect(seen.missing).toMatchObject({ _tag: 'Email', emailProblem: Option.some('Missing') });
    expect(seen.malformed).toMatchObject({ _tag: 'Email', emailProblem: Option.some('Malformed') });
    expect(calls).toEqual([]);
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
          const later = yield* resendIn(flow);
          yield* TestClock.adjust('20 seconds');
          const ready = yield* resendIn(flow);
          yield* flow.resend;
          yield* settle;
          return { sent, later, ready, again: yield* resendIn(flow) };
        }),
      { onChange: (state) => changes.push(Option.match(sentCode(state), { onNone: () => -1, onSome: (code) => code.resendIn })) },
    );
    expect(seen).toMatchObject({ sent: { _tag: 'Code', sent: { to: 'artist@example.com', resendIn: RESEND_SECONDS } }, later: 20, ready: 0, again: 30 });
    expect(calls).toEqual([
      ['sendCode', 'artist@example.com'],
      ['sendCode', 'artist@example.com'],
    ]);
    expect(changes).toContain(1);
  });

  test('a code not sent is the alert line’s; while it is being sent, nothing else starts and nothing typed is taken', async () => {
    const { calls, outcome, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void, Failure>();
        outcome.send = Deferred.await(gate);
        yield* flow.setEmail('artist@example.com');
        yield* flow.submitEmail;
        yield* flow.submitEmail;
        yield* flow.continueWith('google');
        yield* flow.differentEmail;
        yield* flow.startOver;
        yield* flow.setEmail('other@example.com');
        yield* flow.submitCode('123456');
        const waiting = yield* flow.state;
        yield* Deferred.fail(gate, new Down());
        yield* settle;
        const failed = yield* flow.state;
        yield* flow.setEmail('artist@example.co');
        return { waiting, failed, edited: yield* flow.state };
      }),
    );
    expect(seen.waiting).toMatchObject({ _tag: 'Sending', email: 'artist@example.com', to: 'artist@example.com' });
    expect(seen.failed).toMatchObject({ _tag: 'Email', failure: Option.some({ from: 'send', error: { _tag: 'Down' } }) });
    expect(seen.edited).toMatchObject({ _tag: 'Email', failure: Option.none() });
    expect(calls).toEqual([['sendCode', 'artist@example.com']]);
  });

  test('back to the same email within the wait: the code sent stands; after it, another is sent', async () => {
    const { calls, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* toCode(flow);
        yield* TestClock.adjust('10 seconds');
        yield* flow.differentEmail;
        yield* flow.submitEmail;
        const standing = yield* flow.state;
        yield* TestClock.adjust('20 seconds');
        yield* flow.differentEmail;
        yield* flow.submitEmail;
        yield* settle;
        return { standing, sentAgain: yield* flow.state };
      }),
    );
    expect(seen.standing).toMatchObject({ _tag: 'Code', code: '', sent: { to: 'artist@example.com', resendIn: 20 } });
    expect(seen.sentAgain).toMatchObject({ _tag: 'Code', sent: { resendIn: RESEND_SECONDS } });
    expect(calls.length).toBe(2);
  });
});

describe('the flow: the code step', () => {
  test('a wrong code is the field’s: emptied, `onWrongCode`; typing clears it', async () => {
    const { calls, outcome, actions } = scripted();
    outcome.code = Effect.fail(wrongCode());
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
          return { wrong, cleared: yield* flow.state };
        }),
      { onWrongCode: () => refocused++ },
    );
    expect(seen.wrong).toMatchObject({ _tag: 'Code', code: '', failure: Option.some({ from: 'code', error: { _tag: 'WrongCode' } }) });
    expect(seen.cleared).toMatchObject({ _tag: 'Code', code: '1', failure: Option.none() });
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
    expect(seen).toMatchObject({ _tag: 'Code', code: '654321', failure: Option.some({ from: 'code' }) });
    expect(calls.at(-1)).toEqual(['signInWithCode', '654321']);
  });

  test('an accepted code is spent: the field emptied, the resend wait over (no tick brings it back), and the same address is sent another at once', async () => {
    const { calls, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* toCode(flow);
        yield* TestClock.adjust('5 seconds');
        const before = yield* resendIn(flow);
        yield* flow.submitCode('123456');
        yield* settle;
        const accepted = yield* flow.state;
        // Nothing is typed: nothing to check again.
        yield* flow.submitCode();
        yield* TestClock.adjust('5 seconds');
        const later = yield* flow.state;
        yield* flow.differentEmail;
        yield* flow.submitEmail;
        yield* settle;
        return { before, accepted, later, again: yield* flow.state };
      }),
    );
    expect(seen.before).toBe(25);
    expect(seen.accepted).toEqual({ _tag: 'Code', email: 'artist@example.com', code: '', failure: Option.none(), sent: { to: 'artist@example.com', resendIn: 0 } });
    expect(seen.later).toEqual(seen.accepted);
    expect(seen.again).toMatchObject({ _tag: 'Code', sent: { to: 'artist@example.com', resendIn: 30 } });
    expect(calls).toEqual([
      ['sendCode', 'artist@example.com'],
      ['signInWithCode', '123456'],
      ['sendCode', 'artist@example.com'],
    ]);
  });

  test('a defect only ends the wait; Use a Different Email keeps the email, and not while checking', async () => {
    const { outcome, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* toCode(flow);
        outcome.code = Effect.die('boom');
        yield* flow.submitCode('123456');
        yield* settle;
        const died = yield* flow.state;
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
        return { died, checking, back: yield* flow.state };
      }),
    );
    expect(seen.died).toMatchObject({ _tag: 'Code', code: '123456', failure: Option.none() });
    expect(seen.checking).toMatchObject({ _tag: 'Checking', code: '123456' });
    expect(seen.back).toMatchObject({ _tag: 'Email', email: 'artist@example.com', failure: Option.none() });
  });
});

describe('the flow: Google and Apple', () => {
  const page = new EventTarget();
  const original = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });
  const pageShown = (persisted: boolean) => page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));

  test('busy until the page leaves; back from the back/forward cache, the email step', async () => {
    (globalThis as { window?: unknown }).window = page;
    const { calls, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* flow.continueWith('google');
        yield* settle;
        const leaving = yield* flow.state;
        pageShown(false);
        yield* settle;
        const stillLeaving = yield* tagOf(flow);
        pageShown(true);
        yield* settle;
        return { leaving, stillLeaving, back: yield* tagOf(flow) };
      }),
    );
    expect(seen).toMatchObject({ leaving: { _tag: 'Leaving', provider: 'google', left: true }, stillLeaving: 'Leaving', back: 'Email' });
    expect(calls).toEqual([['signInWith', 'google']]);
  });

  test('Start Over, once the page should have left and hasn’t, stops waiting for it; not while its action runs', async () => {
    const listening: string[] = [];
    (globalThis as { window?: unknown }).window = {
      addEventListener: () => listening.push('add'),
      removeEventListener: () => listening.push('remove'),
    };
    const { calls, outcome, actions } = scripted();
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        const going = yield* Deferred.make<void, Failure>();
        outcome.oauth = Deferred.await(going);
        yield* flow.continueWith('google');
        yield* flow.startOver;
        const notYet = yield* tagOf(flow);
        yield* Deferred.succeed(going, undefined);
        yield* settle;
        const waiting = [...listening];
        yield* flow.startOver;
        const over = { tag: yield* tagOf(flow), listening: [...listening] };
        outcome.oauth = Effect.void;
        yield* flow.continueWith('apple');
        yield* settle;
        return { notYet, waiting, over, again: yield* flow.state };
      }),
    );
    expect(seen).toMatchObject({ notYet: 'Leaving', waiting: ['add'], over: { tag: 'Email', listening: ['add', 'remove'] }, again: { _tag: 'Leaving', provider: 'apple', left: true } });
    expect(calls).toEqual([
      ['signInWith', 'google'],
      ['signInWith', 'apple'],
    ]);
  });

  test('an action answers once: the page still leaving after its action has succeeded and ended', async () => {
    (globalThis as { window?: unknown }).window = page;
    const { actions } = scripted();
    const tags = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* flow.continueWith('google');
        yield* settle;
        yield* settle;
        return yield* flow.state;
      }),
    );
    expect(tags).toMatchObject({ _tag: 'Leaving', left: true });
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

  test('a failure is the alert line’s, and editing the email keeps it', async () => {
    const { outcome, actions } = scripted();
    outcome.oauth = Effect.fail(new Down());
    const seen = await withFlow(actions, (flow) =>
      Effect.gen(function* () {
        yield* flow.continueWith('apple');
        yield* settle;
        yield* flow.setEmail('a');
        return yield* flow.state;
      }),
    );
    expect(seen).toMatchObject({ _tag: 'Email', email: 'a', failure: Option.some({ from: 'oauth', error: { _tag: 'Down' } }) });
  });

  test('without a window the page never comes back: leaving until the scope closes, then not', async () => {
    (globalThis as { window?: unknown }).window = undefined;
    const { actions } = scripted();
    const states: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const flow = yield* makeSignInFlow(actions, { onChange: (state) => states.push(state._tag) }).pipe(Scope.provide(scope));
        yield* flow.continueWith('google');
        yield* settle;
        yield* Scope.close(scope, Exit.void);
      }),
    );
    expect(states).toEqual(['Leaving', 'Leaving', 'Email']);
  });
});

describe('the flow: what the app gives it', () => {
  test('an action that throws as it is made only ends the wait; a listener that throws doesn’t stop what the state waits on', async () => {
    const { calls, actions } = scripted();
    const thrown: SignInActions<Failure> = {
      ...actions,
      sendCode: () => {
        throw new Error('made wrong');
      },
    };
    expect(
      await withFlow(thrown, (flow) =>
        Effect.gen(function* () {
          yield* flow.setEmail('artist@example.com');
          yield* flow.submitEmail;
          yield* settle;
          return yield* tagOf(flow);
        }),
      ),
    ).toBe('Email');
    const seen = await withFlow(
      actions,
      (flow) =>
        Effect.gen(function* () {
          yield* flow.setEmail('artist@example.com');
          const exit = yield* Effect.exit(flow.submitEmail);
          yield* settle;
          return { died: Exit.isFailure(exit), tag: yield* tagOf(flow) };
        }),
      {
        onChange: (state) => {
          if (state._tag === 'Sending') throw new Error('listener');
        },
      },
    );
    expect(seen).toEqual({ died: true, tag: 'Code' });
    expect(calls).toEqual([['sendCode', 'artist@example.com']]);
  });
});

describe('the flow: mounted again', () => {
  test('a state that was waiting starts where its action ending would have left it; the resend wait goes on', async () => {
    const { calls, actions } = scripted();
    const sent = { to: 'artist@example.com', resendIn: 12 };
    const told: string[] = [];
    const from = (initial: State) =>
      withFlow(
        actions,
        (flow) =>
          Effect.gen(function* () {
            const start = yield* flow.state;
            yield* TestClock.adjust('12 seconds');
            return { start: start._tag, wait: Option.map(sentCode(start), (code) => code.resendIn), later: yield* resendIn(flow) };
          }),
        { onChange: (state) => told.push(`${initial._tag} ${state._tag}`) },
        initial,
      );
    expect(await from({ _tag: 'Sending', email: 'a@b.c', to: 'a@b.c', sent: Option.none() })).toEqual({ start: 'Email', wait: Option.none(), later: 0 });
    expect(await from({ _tag: 'Checking', email: 'a@b.c', code: '123456', sent })).toEqual({ start: 'Code', wait: Option.some(12), later: 0 });
    expect(await from({ _tag: 'Leaving', email: 'a@b.c', provider: 'apple', left: true, sent: Option.some(sent) })).toEqual({ start: 'Email', wait: Option.some(12), later: 0 });
    expect(await from(initialFlowState())).toEqual({ start: 'Email', wait: Option.none(), later: 0 });
    expect(calls).toEqual([]);
    // Where it starts is told when it isn't where it was (then the countdown's ticks).
    expect(told.filter((change, index) => told.indexOf(change) === index)).toEqual(['Sending Email', 'Checking Code', 'Leaving Email']);
  });
});
