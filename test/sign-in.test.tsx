
import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import { type Context, Deferred, Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { StrictMode } from 'react';

import { CodeNotSent, WrongCode } from '../src/failure.js';
import { type SignInActions, useSignIn, type UseSignInOptions } from '../src/react.js';

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
    expect(result.current).toMatchObject({ step: 'email', email: '', busy: false, codeLength: 6, resendIn: 0 });
    act(() => result.current.setEmail('artist@example.com'));
    expect(result.current.email).toBe('artist@example.com');
    act(() => result.current.submitEmail());
    await flush();
    expect(result.current).toMatchObject({ step: 'code', resendIn: 30, sending: false });
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
