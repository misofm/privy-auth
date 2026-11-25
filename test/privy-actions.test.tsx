
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Effect, Fiber, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { StrictMode, useEffect, useRef } from 'react';

type Callbacks = { onComplete?: (params: { user: unknown }) => void; onError?: (code: string) => void; onSuccess?: () => void };
type Account = { type: string; chainType?: string; walletClientType?: string; address?: string };
type TestUser = { id: string; linkedAccounts: Account[] };

const WALLET: Account = { type: 'wallet', chainType: 'sui', walletClientType: 'privy', address: '0xabc' };
const user = (id = 'did:privy:u', linkedAccounts: Account[] = []): TestUser => ({ id, linkedAccounts });

/** Privy's hooks as the package uses them: what each was given, and what it answers. */
const privy = {
  state: { ready: true, authenticated: false, user: null as TestUser | null },
  identityToken: null as string | null,
  email: [] as Callbacks[],
  oauth: [] as Callbacks[],
  logouts: [] as Callbacks[],
  sendCode: mock(async (_: { email: string }) => {}),
  loginWithCode: mock(async (_: { code: string }) => {}),
  initOAuth: mock(async (_: { provider: string }) => {}),
  logout: mock(async () => {}),
  createWallet: mock(async (_: { chainType: string }) => ({ user: user('did:privy:u', [WALLET]), wallet: {} })),
  signed: mock((_: { address: string; chainType: string; hash: string }) => ({ signature: '0xsig' })),
  getIdentityToken: mock(async (): Promise<string | null> => 'token'),
};
mock.module('@privy-io/react-auth', () => ({
  getIdentityToken: () => privy.getIdentityToken(),
  usePrivy: () => privy.state,
  useIdentityToken: () => ({ identityToken: privy.identityToken }),
  useLogout: (callbacks: Callbacks) => {
    privy.logouts.push(callbacks);
    return { logout: privy.logout };
  },
  useLoginWithEmail: (callbacks: Callbacks) => {
    privy.email.push(callbacks);
    return { sendCode: privy.sendCode, loginWithCode: privy.loginWithCode };
  },
  useLoginWithOAuth: (callbacks: Callbacks) => {
    privy.oauth.push(callbacks);
    return { initOAuth: privy.initOAuth };
  },
}));
mock.module('@privy-io/react-auth/extended-chains', () => ({
  useCreateWallet: () => ({ createWallet: privy.createWallet }),
  // As Privy's: it signs for the user its hooks showed at this render, with a wallet among that user's.
  useSignRawHash: () => {
    const shown = privy.state.user;
    return {
      signRawHash: async (params: { address: string; chainType: string; hash: string }) => {
        if (!shown) throw new Error('User must be authenticated before signing');
        if (!shown.linkedAccounts.some((account) => account.address === params.address)) throw new Error('Wallet not found');
        return privy.signed(params);
      },
    };
  },
}));

const { PrivyCallFailed, usePrivyActions } = await import('../src/react.js');
type Actions = ReturnType<typeof usePrivyActions>;

const outcome = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));
/** Lets promises and forked fibers settle, inside `act`. */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
/** Privy's hooks show `shown` signed in (at the next render). */
const signedIn = (shown: TestUser) => {
  privy.state = { ready: true, authenticated: true, user: shown };
};

beforeEach(() => {
  privy.state = { ready: true, authenticated: false, user: null };
  privy.identityToken = null;
  privy.email = [];
  privy.oauth = [];
  privy.logouts = [];
});
afterEach(() => cleanup());

describe('usePrivyActions: Privy’s state', () => {
  test('absence as Option; one value while nothing changes; the functions kept for the hook’s life', () => {
    const { result, rerender } = renderHook(() => usePrivyActions());
    expect(result.current).toMatchObject({ ready: true, authenticated: false, user: Option.none(), identityToken: Option.none() });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    signedIn(user());
    privy.identityToken = 'token';
    rerender();
    expect(result.current).toMatchObject({ authenticated: true, user: Option.some(user()), identityToken: Option.some('token') });
    for (const name of ['sendCode', 'loginWithCode', 'initOAuth', 'createSuiWallet', 'refreshIdentityToken', 'signRawHash', 'logout'] as const) expect(result.current[name]).toBe(first[name]);
  });

  test('the session: Loading, SignedOut, SigningIn (a sign-in its hooks don’t show whole), SignedIn', () => {
    privy.state = { ready: false, authenticated: true, user: user() };
    const { result, rerender } = renderHook(() => usePrivyActions());
    expect(result.current.session).toEqual({ _tag: 'Loading' });
    privy.state = { ready: true, authenticated: false, user: null };
    rerender();
    expect(result.current.session).toEqual({ _tag: 'SignedOut' });
    // Privy says authenticated before it names the user.
    privy.state = { ready: true, authenticated: true, user: null };
    rerender();
    expect(result.current.session).toEqual({ _tag: 'SigningIn' });
    signedIn(user());
    rerender();
    expect(result.current.session).toMatchObject({ _tag: 'SignedIn', user: user() });
    const shown = result.current.session;
    rerender();
    expect(result.current.session).toBe(shown);
  });
});

describe('usePrivyActions: onComplete', () => {
  test('held while Privy’s hooks don’t show the sign-in; called once after the render that does, not before (issue #1)', () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(() => usePrivyActions({ onComplete: (arrived) => seen.push(arrived.id) }));
    // Privy's email hook calls onComplete before `authenticated` is true.
    act(() => privy.email[0]?.onComplete?.({ user: user() }));
    expect(seen).toEqual([]);
    expect(result.current.session).toEqual({ _tag: 'SigningIn' });
    rerender();
    expect(seen).toEqual([]);
    signedIn(user());
    rerender();
    expect(seen).toEqual(['did:privy:u']);
    expect(result.current.session._tag).toBe('SignedIn');
    rerender();
    expect(seen).toEqual(['did:privy:u']);
  });

  test('a Google or Apple return, and a kept sign-in found on load (reported before Privy is ready)', () => {
    const seen: string[] = [];
    privy.state = { ready: false, authenticated: false, user: null };
    const { rerender } = renderHook(() => usePrivyActions({ onComplete: (arrived) => seen.push(arrived.id) }));
    // On load Privy reports the kept sign-in, then names the user, then says it is ready.
    act(() => privy.oauth[0]?.onComplete?.({ user: user('kept') }));
    privy.state = { ready: false, authenticated: true, user: user('kept') };
    rerender();
    expect(seen).toEqual([]);
    signedIn(user('kept'));
    rerender();
    expect(seen).toEqual(['kept']);
  });

  test('the wallet signs from onComplete, Privy refusing until its hooks show the user (issue #1)', async () => {
    const signatures: Array<Promise<string>> = [];
    const { result, rerender } = renderHook(() => {
      const actions = usePrivyActions({ onComplete: () => signatures.push(actions.signRawHash('0xabc', '0x01')) });
      return actions;
    });
    const before = result.current;
    expect(before.signRawHash('0xabc', '0x01')).rejects.toThrow('User must be authenticated before signing');
    act(() => privy.oauth[0]?.onComplete?.({ user: user('did:privy:u', [WALLET]) }));
    signedIn(user('did:privy:u', [WALLET]));
    rerender();
    expect(signatures.length).toBe(1);
    expect(await signatures[0]).toBe('0xsig');
    expect(privy.signed).toHaveBeenLastCalledWith({ address: '0xabc', chainType: 'sui', hash: '0x01' });
    // A function taken from an earlier render signs with Privy's hooks as they are now.
    expect(await before.signRawHash('0xabc', '0x02')).toBe('0xsig');
  });

  test('once per sign-in: a sign-in reported twice, or again once heard, is one; the next sign-in is heard again', () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(() => usePrivyActions({ onComplete: (arrived) => seen.push(arrived.id) }), { wrapper: StrictMode });
    // The email hook and the `login` event both report it.
    act(() => privy.email[0]?.onComplete?.({ user: user('a') }));
    act(() => privy.oauth[0]?.onComplete?.({ user: user('a') }));
    signedIn(user('a'));
    rerender();
    expect(seen).toEqual(['a']);
    act(() => privy.oauth[0]?.onComplete?.({ user: user('a') }));
    expect(seen).toEqual(['a']);
    // Signed out (the report just dropped doesn't linger), then in again as the same user.
    privy.state = { ready: true, authenticated: false, user: null };
    rerender();
    expect(result.current.session).toEqual({ _tag: 'SignedOut' });
    act(() => privy.email[0]?.onComplete?.({ user: user('a') }));
    signedIn(user('a'));
    rerender();
    expect(seen).toEqual(['a', 'a']);
    // Another user without a sign-out between.
    act(() => privy.email[0]?.onComplete?.({ user: user('b') }));
    expect(seen).toEqual(['a', 'a']);
    signedIn(user('b'));
    rerender();
    expect(seen).toEqual(['a', 'a', 'b']);
    // Signed out and in again as the same user before a render shows anyone signed out: another sign-in.
    act(() => privy.logouts[0]?.onSuccess?.());
    act(() => privy.email[0]?.onComplete?.({ user: user('b') }));
    expect(seen).toEqual(['a', 'a', 'b', 'b']);
  });

  test('a report naming no user is none; a sign-out drops a sign-in reported and never shown', () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(() => usePrivyActions({ onComplete: (arrived) => seen.push(arrived.id) }));
    act(() => privy.email[0]?.onComplete?.({ user: null }));
    expect(result.current.session).toEqual({ _tag: 'SignedOut' });
    act(() => privy.email[0]?.onComplete?.({ user: user('a') }));
    act(() => privy.email[0]?.onComplete?.({ user: undefined }));
    expect(result.current.session).toEqual({ _tag: 'SigningIn' });
    act(() => privy.logouts[0]?.onSuccess?.());
    expect(result.current.session).toEqual({ _tag: 'SignedOut' });
    signedIn(user('a'));
    rerender();
    expect(seen).toEqual([]);
    // Reported while another is signed in, and never shown: gone once Privy drops the session by itself (no logout event).
    act(() => privy.email[0]?.onComplete?.({ user: user('b') }));
    rerender();
    privy.state = { ready: true, authenticated: false, user: null };
    rerender();
    expect(result.current.session).toEqual({ _tag: 'SignedOut' });
    expect(seen).toEqual([]);
  });

  test('callbacks subscribed once, calling the latest given; failures read by privyFailure, at once', () => {
    const seen: string[] = [];
    const { rerender } = renderHook((props: { readonly label: string }) =>
      usePrivyActions({ onComplete: (arrived) => seen.push(`${props.label} ${arrived.id}`), onError: (failure) => seen.push(`${props.label} ${failure._tag}`) }),
      { initialProps: { label: 'first' } },
    );
    act(() => privy.email[0]?.onComplete?.({ user: user('a') }));
    signedIn(user('a'));
    rerender({ label: 'latest' });
    expect(new Set(privy.email).size).toBe(1);
    expect(new Set(privy.oauth).size).toBe(1);
    expect(new Set(privy.logouts).size).toBe(1);
    expect(privy.email[0]?.onError).toBeUndefined();
    act(() => privy.oauth[0]?.onError?.('oauth_user_denied'));
    expect(seen).toEqual(['latest a', 'latest Cancelled']);
    // Without callbacks, nothing is called.
    cleanup();
    const bare = renderHook(() => usePrivyActions());
    act(() => privy.email.at(-1)?.onComplete?.({ user: user('a') }));
    bare.rerender();
    act(() => privy.oauth.at(-1)?.onError?.('x'));
    expect(seen.length).toBe(2);
  });
});

describe('usePrivyActions: the sign-in steps', () => {
  test('as Effects, their failures the package’s', async () => {
    const { result } = renderHook(() => usePrivyActions());
    const actions = result.current;
    expect(await outcome(actions.sendCode('artist@example.com'))).toMatchObject({ _tag: 'Success' });
    expect(privy.sendCode).toHaveBeenLastCalledWith({ email: 'artist@example.com' });
    privy.sendCode.mockImplementationOnce(() => Promise.reject({ privyErrorCode: 'too_many_requests' }));
    expect(await outcome(actions.sendCode('a@b.c'))).toMatchObject({ failure: { _tag: 'TooManyTries' } });
    privy.sendCode.mockImplementationOnce(() => Promise.reject(new Error('down')));
    expect(await outcome(actions.sendCode('a@b.c'))).toMatchObject({ failure: { _tag: 'CodeNotSent' } });

    privy.loginWithCode.mockImplementationOnce(() => Promise.reject({ privyErrorCode: 'invalid_credentials' }));
    expect(await outcome(actions.loginWithCode('000000'))).toMatchObject({ failure: { _tag: 'WrongCode' } });

    expect(await outcome(actions.initOAuth('apple'))).toMatchObject({ _tag: 'Success' });
    expect(privy.initOAuth).toHaveBeenLastCalledWith({ provider: 'apple' });
    privy.initOAuth.mockImplementationOnce(() => Promise.reject(new Error('popup')));
    expect(await outcome(actions.initOAuth('google'))).toMatchObject({ failure: { _tag: 'Refused' } });
  });

  test('loginWithCode succeeds once the hooks show the sign-in, after onComplete', async () => {
    const order: string[] = [];
    const { result, rerender } = renderHook(() => usePrivyActions({ onComplete: (arrived) => order.push(`onComplete ${arrived.id}`) }));
    // As Privy's: its hook's onComplete, then the promise, both before its hooks show the user.
    privy.loginWithCode.mockImplementationOnce(async () => privy.email[0]?.onComplete?.({ user: user() }));
    let login: ReturnType<typeof outcome<void, unknown>> | undefined;
    await act(async () => {
      login = outcome(result.current.loginWithCode('123456')).then((ended) => (order.push('loginWithCode'), ended));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(privy.loginWithCode).toHaveBeenLastCalledWith({ code: '123456' });
    expect(order).toEqual([]);
    signedIn(user());
    rerender();
    expect(await login).toMatchObject({ _tag: 'Success', success: undefined });
    expect(order).toEqual(['onComplete did:privy:u', 'loginWithCode']);
    // Another code accepted for the user already signed in (as Privy does, reporting them again): another sign-in, heard once.
    privy.loginWithCode.mockImplementationOnce(async () => {
      privy.email[0]?.onComplete?.({ user: user() });
      privy.oauth[0]?.onComplete?.({ user: user() });
    });
    await act(async () => {
      login = outcome(result.current.loginWithCode('654321')).then((ended) => (order.push('loginWithCode again'), ended));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(await login).toMatchObject({ _tag: 'Success' });
    expect(order).toEqual(['onComplete did:privy:u', 'loginWithCode', 'onComplete did:privy:u', 'loginWithCode again']);
    // A code refused meanwhile changes nothing for who is signed in.
    privy.loginWithCode.mockImplementationOnce(() => Promise.reject({ privyErrorCode: 'invalid_credentials' }));
    await act(async () => expect(await outcome(result.current.loginWithCode('000000'))).toMatchObject({ failure: { _tag: 'WrongCode' } }));
    rerender();
    expect(order.length).toBe(4);
    expect(result.current.session).toMatchObject({ _tag: 'SignedIn' });
  });

  test('loginWithCode waits for the user it signed in, not one signed in before', async () => {
    const order: string[] = [];
    const { result, rerender } = renderHook(() => usePrivyActions({ onComplete: (arrived) => order.push(`onComplete ${arrived.id}`) }));
    act(() => privy.email[0]?.onComplete?.({ user: user('a') }));
    signedIn(user('a'));
    rerender();
    privy.loginWithCode.mockImplementationOnce(async () => privy.email[0]?.onComplete?.({ user: user('b') }));
    let login: Promise<unknown> | undefined;
    await act(async () => {
      login = outcome(result.current.loginWithCode('123456')).then(() => order.push('loginWithCode'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(order).toEqual(['onComplete a']);
    signedIn(user('b'));
    rerender();
    await login;
    expect(order).toEqual(['onComplete a', 'onComplete b', 'loginWithCode']);
  });

  test('loginWithCode is Refused when the hooks never show the sign-in (10 s by Clock)', async () => {
    const { result } = renderHook(() => usePrivyActions());
    const ended = await act(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.result(result.current.loginWithCode('123456')));
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
          yield* TestClock.adjust('9 seconds');
          const waiting = fiber.pollUnsafe() === undefined;
          yield* TestClock.adjust('1 second');
          return { waiting, result: yield* Fiber.join(fiber) };
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );
    expect(ended.waiting).toBe(true);
    expect(ended.result).toMatchObject({ failure: { _tag: 'Refused' } });
    expect(ended.result._tag === 'Failure' && String(ended.result.failure.cause)).toContain('didn’t show the sign-in');
  });
});

describe('usePrivyActions: the wallet, the token, a signature, signing out', () => {
  /** `effect` forked on a `TestClock`, Privy left to answer, then `during` and 10 s gone by: how it ended. */
  const afterTenSeconds = <A, E>(effect: Effect.Effect<A, E>, during: () => void = () => {}) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.result(effect));
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        // Not inside `act`: each render `during` makes commits, effects and all, before the next.
        during();
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        yield* TestClock.adjust('10 seconds');
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

  test('createSuiWallet answers once the hooks show the wallet, which signs at once', async () => {
    signedIn(user());
    const { result, rerender } = renderHook(() => usePrivyActions());
    const actions = result.current;
    let made: unknown;
    const making = outcome(actions.createSuiWallet).then((ended) => (made = ended));
    await flush();
    expect(privy.createWallet).toHaveBeenLastCalledWith({ chainType: 'sui' });
    expect(made).toBeUndefined();
    expect(actions.signRawHash('0xabc', '0x01')).rejects.toThrow('Wallet not found');
    signedIn(user('did:privy:u', [WALLET]));
    rerender();
    await making;
    expect(made).toMatchObject({ _tag: 'Success', success: { id: 'did:privy:u', linkedAccounts: [WALLET] } });
    expect(await actions.signRawHash('0xabc', '0x01')).toBe('0xsig');
  });

  test('never a second wallet: calls made together, after Privy answered, or after the wait ran out, share the one made', async () => {
    signedIn(user());
    const { result, rerender } = renderHook(() => usePrivyActions());
    const calls = privy.createWallet.mock.calls.length;
    const both = Promise.all([outcome(result.current.createSuiWallet), outcome(result.current.createSuiWallet)]);
    await flush();
    // Privy has answered, and its hooks don't show the wallet yet: asked again, it waits for them.
    const third = outcome(result.current.createSuiWallet);
    // The hooks showing another user, or another wallet, is not it: the wait runs out, and trying again asks for nothing.
    const other = () => {
      signedIn(user('did:privy:other', [WALLET]));
      rerender();
      signedIn(user('did:privy:u', [{ ...WALLET, address: '0xdef' }]));
      rerender();
    };
    signedIn(user());
    rerender();
    const late = await afterTenSeconds(result.current.createSuiWallet, other);
    expect(late).toMatchObject({ failure: { _tag: 'PrivyCallFailed', call: 'createSuiWallet' } });
    expect(late._tag === 'Failure' && String(late.failure.cause)).toContain('didn’t show the wallet');
    signedIn(user());
    rerender();
    const again = outcome(result.current.createSuiWallet);
    await flush();
    expect(privy.createWallet.mock.calls.length).toBe(calls + 1);
    signedIn(user('did:privy:u', [WALLET]));
    rerender();
    expect(await Promise.all([both, third, again])).toMatchObject([[{ _tag: 'Success' }, { _tag: 'Success' }], { _tag: 'Success' }, { success: { linkedAccounts: [WALLET] } }]);
    // The hooks show a wallet: none is made.
    expect(await outcome(result.current.createSuiWallet)).toMatchObject({ success: { linkedAccounts: [WALLET] } });
    expect(privy.createWallet.mock.calls.length).toBe(calls + 1);
  });

  test('createSuiWallet reads the user the hooks show signed in: at the render a child’s effect runs in, waiting while Privy loads, failing with no one', async () => {
    signedIn(user());
    const calls = privy.createWallet.mock.calls.length;
    const asked: Array<Promise<{ readonly _tag: string }>> = [];
    // An effect that runs before the hook's own, as a child's does.
    const { result, rerender } = renderHook((props: { readonly ask: boolean }) => {
      const actions = useRef<Actions | undefined>(undefined);
      useEffect(() => {
        if (props.ask && actions.current) asked.push(outcome(actions.current.createSuiWallet));
      }, [props.ask]);
      actions.current = usePrivyActions();
      return actions.current;
    }, { initialProps: { ask: false } });
    signedIn(user('did:privy:u', [WALLET]));
    rerender({ ask: true });
    expect(await asked[0]).toMatchObject({ _tag: 'Success' });
    expect(privy.createWallet.mock.calls.length).toBe(calls);

    privy.state = { ready: true, authenticated: false, user: null };
    rerender({ ask: true });
    const none = await outcome(result.current.createSuiWallet);
    expect(none._tag === 'Failure' && String(none.failure.cause)).toContain('No one is signed in');

    privy.state = { ready: false, authenticated: false, user: null };
    rerender({ ask: true });
    const loading = outcome(result.current.createSuiWallet);
    await flush();
    signedIn(user('did:privy:u', [WALLET]));
    rerender({ ask: true });
    expect(await loading).toMatchObject({ _tag: 'Success' });
    privy.state = { ready: false, authenticated: false, user: null };
    rerender({ ask: true });
    const never = await afterTenSeconds(result.current.createSuiWallet);
    expect(never._tag === 'Failure' && String(never.failure.cause)).toContain('didn’t show the sign-in');
    expect(privy.createWallet.mock.calls.length).toBe(calls);
  });

  test('createSuiWallet: Privy’s refusal, or a user made without a wallet, and the next call asks again', async () => {
    signedIn(user('did:privy:refused'));
    const { result } = renderHook(() => usePrivyActions());
    const actions = result.current;
    const calls = privy.createWallet.mock.calls.length;
    privy.createWallet.mockImplementationOnce(() => Promise.reject(new Error('no')));
    const failed = await outcome(actions.createSuiWallet);
    expect(failed).toMatchObject({ failure: { _tag: 'PrivyCallFailed', call: 'createSuiWallet' } });
    expect(failed._tag === 'Failure' && failed.failure instanceof PrivyCallFailed && failed.failure.message).toBe('Privy’s createSuiWallet failed');

    privy.createWallet.mockImplementationOnce(async () => ({ user: user('did:privy:refused', [{ type: 'email' }]), wallet: {} }));
    expect(await outcome(actions.createSuiWallet)).toMatchObject({ success: { linkedAccounts: [{ type: 'email' }] } });
    privy.createWallet.mockImplementationOnce(() => Promise.reject(new Error('no')));
    expect(await outcome(actions.createSuiWallet)).toMatchObject({ _tag: 'Failure' });
    expect(privy.createWallet.mock.calls.length).toBe(calls + 3);
  });

  test('the token, signing out', async () => {
    const { result } = renderHook(() => usePrivyActions());
    const actions = result.current;
    expect(await outcome(actions.refreshIdentityToken)).toMatchObject({ success: Option.some('token') });
    privy.getIdentityToken.mockImplementationOnce(async () => null);
    expect(await outcome(actions.refreshIdentityToken)).toMatchObject({ success: Option.none() });
    const refusal = { status: 401 };
    privy.getIdentityToken.mockImplementationOnce(() => Promise.reject(refusal));
    expect(await outcome(actions.refreshIdentityToken)).toMatchObject({ failure: { call: 'identityToken', cause: refusal } });

    expect(await outcome(actions.logout)).toMatchObject({ _tag: 'Success' });
    privy.logout.mockImplementationOnce(() => Promise.reject(new Error('no')));
    expect(await outcome(actions.logout)).toMatchObject({ failure: { call: 'logout' } });
  });
});
