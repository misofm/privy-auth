
import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { type Context, Deferred, Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Activity, StrictMode } from 'react';

import { CodeNotSent, WrongCode } from '../src/failure.js';
import { type SignIn, type SignInActions, useSignIn, type UseSignInOptions } from '../src/react.js';

type Failure = WrongCode | CodeNotSent;

/** A runtime with a `TestClock`, its `run` for the hook, and how to move its time. */
const testRuntime = async () => {
  const context = (await Effect.runPromise(Layer.build(TestClock.layer()).pipe(Effect.scoped))) as Context.Context<never>;
  const runFork = Effect.runForkWith(context);
  return {
    run: (effect: Effect.Effect<void>) => runFork(effect),
    adjust: (duration: string) => act(() => Effect.runPromise(TestClock.adjust(duration as '1 second').pipe(Effect.provideContext(context)))),
  };
};

const actionsOf = (outcome: { send?: Effect.Effect<void, Failure>; code?: Effect.Effect<void, Failure>; oauth?: Effect.Effect<void, Failure> } = {}) => {
  const calls: string[] = [];
  const actions: SignInActions<Failure> = {
    sendCode: (email) => Effect.suspend(() => (calls.push(`send ${email}`), outcome.send ?? Effect.void)),
    signInWithCode: (code) => Effect.suspend(() => (calls.push(`code ${code}`), outcome.code ?? Effect.void)),
    signInWith: (provider) => Effect.suspend(() => (calls.push(`oauth ${provider}`), outcome.oauth ?? Effect.void)),
  };
  return { calls, actions };
};

/** Lets the flow's forked fibers run, inside `act`. */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

afterEach(() => cleanup());

describe('useSignIn', () => {
  test('typing shows at once; a sent code moves to the code step and counts Resend down (TestClock)', async () => {
    const runtime = await testRuntime();
    const { calls, actions } = actionsOf();
    const { result } = renderHook(() => useSignIn(actions, { run: runtime.run }));
    expect(result.current).toMatchObject({ state: { _tag: 'Email' }, step: 'email', email: '', busy: false, codeLength: 6, resendIn: 0, sentTo: Option.none(), code: '' });
    act(() => result.current.setEmail(' artist@example.com'));
    expect(result.current.email).toBe(' artist@example.com');
    act(() => result.current.submitEmail());
    await flush();
    expect(result.current).toMatchObject({ state: { _tag: 'Code' }, step: 'code', resendIn: 30, sending: false, sentTo: Option.some('artist@example.com') });
    await runtime.adjust('12 seconds');
    expect(result.current.resendIn).toBe(18);
    await runtime.adjust('18 seconds');
    expect(result.current.resendIn).toBe(0);
    act(() => result.current.resend());
    await flush();
    expect(calls).toEqual(['send artist@example.com', 'send artist@example.com']);
    expect(result.current.resendIn).toBe(30);
  });

  test('the email’s problem; a code not sent in the alert line', async () => {
    const runtime = await testRuntime();
    const { actions } = actionsOf({ send: Effect.fail(new CodeNotSent({ cause: 'down' })) });
    const { result } = renderHook(() => useSignIn(actions, { run: runtime.run }));
    act(() => result.current.submitEmail());
    expect(result.current.emailProblem).toEqual(Option.some('Missing'));
    act(() => result.current.setEmail('artist@example.com'));
    act(() => result.current.submitEmail());
    await flush();
    expect(Option.map(result.current.alert, (e) => e._tag)).toEqual(Option.some('CodeNotSent'));
    expect(result.current.codeFailure).toEqual(Option.none());
  });

  test('a wrong code on the field, emptied, the latest onWrongCode called; checking while it runs', async () => {
    const runtime = await testRuntime();
    const gate = Effect.runSync(Deferred.make<void, Failure>());
    const { actions } = actionsOf({ code: Deferred.await(gate) });
    const focused: string[] = [];
    const { result, rerender } = renderHook((props: { readonly label: string }) => useSignIn(actions, { run: runtime.run, onWrongCode: () => focused.push(props.label) }), {
      initialProps: { label: 'first' },
    });
    act(() => result.current.setEmail('artist@example.com'));
    act(() => result.current.submitEmail());
    await flush();
    act(() => result.current.setCode('123456'));
    act(() => result.current.submitCode());
    expect(result.current).toMatchObject({ checking: true, busy: true });
    rerender({ label: 'latest' });
    await act(() => Effect.runPromise(Deferred.fail(gate, new WrongCode({ cause: 'invalid_credentials' }))));
    await flush();
    expect(Option.map(result.current.codeFailure, (e) => e._tag)).toEqual(Option.some('WrongCode'));
    expect(result.current.alert).toEqual(Option.none());
    expect(result.current.code).toBe('');
    expect(focused).toEqual(['latest']);
    act(() => result.current.differentEmail());
    expect(result.current.step).toBe('email');
  });

  test('an accepted code is spent: the field emptied, the screen takes input, Resend at once; Start Over is the email step', async () => {
    const runtime = await testRuntime();
    const { calls, actions } = actionsOf();
    const { result } = renderHook(() => useSignIn(actions, { run: runtime.run }));
    act(() => result.current.setEmail('artist@example.com'));
    act(() => result.current.submitEmail());
    await flush();
    act(() => result.current.submitCode('123456'));
    await flush();
    expect(result.current).toMatchObject({ state: { _tag: 'Code' }, busy: false, checking: false, step: 'code', code: '', resendIn: 0, codeFailure: Option.none(), alert: Option.none() });
    // The spent code isn't checked again; another is sent at once.
    act(() => result.current.submitCode());
    act(() => result.current.resend());
    await flush();
    expect(calls).toEqual(['send artist@example.com', 'code 123456', 'send artist@example.com']);
    expect(result.current.resendIn).toBe(30);
    act(() => result.current.startOver());
    expect(result.current).toMatchObject({ state: { _tag: 'Email' }, busy: false, step: 'email', email: 'artist@example.com', sentTo: Option.some('artist@example.com') });
  });

  test('Google: its button busy, and the screen; returning from Apple: Apple’s, nothing starts', async () => {
    const runtime = await testRuntime();
    const { calls, actions } = actionsOf();
    const { result, rerender } = renderHook((options: Partial<UseSignInOptions<never>>) => useSignIn(actions, { run: runtime.run, ...options }), { initialProps: {} });
    act(() => result.current.continueWith('google'));
    await flush();
    expect(result.current).toMatchObject({ provider: Option.some('google'), busy: true });
    act(() => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
    await flush();
    expect(result.current).toMatchObject({ provider: Option.none(), busy: false });
    rerender({ returning: 'apple' });
    expect(result.current).toMatchObject({ provider: Option.some('apple'), busy: true });
    act(() => result.current.setEmail('artist@example.com'));
    act(() => result.current.submitEmail());
    act(() => result.current.continueWith('google'));
    await flush();
    expect(result.current.email).toBe('artist@example.com');
    expect(calls).toEqual(['oauth google']);
  });

  test('hidden while a code is being sent (its effects unmounted): the send is interrupted; shown again, the screen takes input, whatever the old send still does', async () => {
    const runtime = await testRuntime();
    const gate = Effect.runSync(Deferred.make<void, Failure>());
    // A send whose own clean-up takes a while: it ends after the screen is back.
    const ended: string[] = [];
    let release = () => {};
    const cleanedUp = new Promise<void>((resolve) => (release = resolve));
    const send = Deferred.await(gate).pipe(Effect.ensuring(Effect.promise(() => (ended.push('interrupted'), cleanedUp.then(() => void ended.push('cleaned up'))))));
    const { calls, actions } = actionsOf({ send });
    const result = { current: undefined as unknown as SignIn<Failure> };
    function Screen() {
      result.current = useSignIn(actions, { run: runtime.run });
      return null;
    }
    const screen = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <Screen />
      </Activity>
    );
    const { rerender } = render(screen('visible'));
    act(() => result.current.setEmail('artist@example.com'));
    act(() => result.current.submitEmail());
    expect(result.current).toMatchObject({ sending: true, busy: true });
    rerender(screen('hidden'));
    await flush();
    expect(ended).toEqual(['interrupted']);
    rerender(screen('visible'));
    await flush();
    expect(result.current).toMatchObject({ state: { _tag: 'Email' }, sending: false, busy: false, email: 'artist@example.com' });
    act(() => result.current.setEmail('changed@example.com'));
    // The old send ends now: what its flow says is no longer the screen's.
    release();
    await flush();
    expect(ended).toEqual(['interrupted', 'cleaned up']);
    expect(result.current.email).toBe('changed@example.com');
    act(() => result.current.submitEmail());
    expect(calls).toEqual(['send artist@example.com', 'send changed@example.com']);
  });

  test('the latest actions run; unmounted (StrictMode’s too), nothing runs or changes', async () => {
    const runtime = await testRuntime();
    const first = actionsOf();
    const second = actionsOf();
    const { result, rerender, unmount } = renderHook((props: { readonly actions: SignInActions<Failure> }) => useSignIn(props.actions, { run: runtime.run }), {
      initialProps: { actions: first.actions },
      wrapper: StrictMode,
    });
    rerender({ actions: second.actions });
    act(() => result.current.setEmail('artist@example.com'));
    act(() => result.current.submitEmail());
    await flush();
    expect([first.calls, second.calls]).toEqual([[], ['send artist@example.com']]);
    const shown = result.current;
    unmount();
    shown.setEmail('changed@example.com');
    shown.continueWith('google');
    await runtime.adjust('30 seconds');
    expect(second.calls).toEqual(['send artist@example.com']);
  });
});
