
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Effect, Option } from 'effect';

type Callbacks = { onComplete?: (params: { user: unknown }) => void; onError?: (code: string) => void };

/** Privy's hooks as the package uses them: what each was given, and what it answers. */
const privy = {
  state: { ready: true, authenticated: false, user: null as unknown },
  identityToken: null as string | null,
  email: [] as Callbacks[],
  oauth: [] as Callbacks[],
  sendCode: mock(async (_: { email: string }) => {}),
  loginWithCode: mock(async (_: { code: string }) => ({ id: 'did:privy:u' })),
  initOAuth: mock(async (_: { provider: string }) => {}),
  logout: mock(async () => {}),
  createWallet: mock(async (_: { chainType: string }) => ({ user: { id: 'did:privy:u', linkedAccounts: [] }, wallet: {} })),
  signRawHash: mock(async (_: { address: string; chainType: string; hash: string }) => ({ signature: '0xsig' })),
  getIdentityToken: mock(async (): Promise<string | null> => 'token'),
};
mock.module('@privy-io/react-auth', () => ({
  getIdentityToken: () => privy.getIdentityToken(),
  usePrivy: () => privy.state,
  useIdentityToken: () => ({ identityToken: privy.identityToken }),
  useLogout: () => ({ logout: privy.logout }),
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
  useSignRawHash: () => ({ signRawHash: privy.signRawHash }),
}));

const { PrivyCallFailed, usePrivyActions } = await import('../src/react.js');

const outcome = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

afterEach(() => cleanup());

describe('usePrivyActions', () => {
  test('Privy’s state, absence as Option; one value while nothing changes', () => {
    const { result, rerender } = renderHook(() => usePrivyActions());
    expect(result.current).toMatchObject({ ready: true, authenticated: false, user: Option.none(), identityToken: Option.none() });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    privy.state = { ready: true, authenticated: true, user: { id: 'did:privy:u' } };
    privy.identityToken = 'token';
    rerender();
    expect(result.current).toMatchObject({ authenticated: true, user: Option.some({ id: 'did:privy:u' }), identityToken: Option.some('token') });
    expect(result.current.sendCode).toBe(first.sendCode);
  });

  test('callbacks subscribed once, calling the latest given; failures read by privyFailure', () => {
    privy.email = [];
    privy.oauth = [];
    const seen: string[] = [];
    const { rerender } = renderHook((props: { readonly label: string }) =>
      usePrivyActions({ onComplete: (user) => seen.push(`${props.label} ${(user as { id: string }).id}`), onError: (failure) => seen.push(`${props.label} ${failure._tag}`) }),
      { initialProps: { label: 'first' } },
    );
    rerender({ label: 'latest' });
    expect(new Set(privy.email).size).toBe(1);
    expect(new Set(privy.oauth).size).toBe(1);
    expect(privy.email[0]?.onError).toBeUndefined();
    act(() => privy.email[0]?.onComplete?.({ user: { id: 'a' } }));
    act(() => privy.oauth[0]?.onComplete?.({ user: { id: 'b' } }));
    act(() => privy.oauth[0]?.onError?.('oauth_user_denied'));
    expect(seen).toEqual(['latest a', 'latest b', 'latest Cancelled']);
    // Without callbacks, nothing is called.
    renderHook(() => usePrivyActions());
    act(() => privy.email.at(-1)?.onComplete?.({ user: {} }));
    act(() => privy.oauth.at(-1)?.onComplete?.({ user: {} }));
    act(() => privy.oauth.at(-1)?.onError?.('x'));
    expect(seen.length).toBe(3);
  });

  test('the sign-in steps as Effects, their failures the package’s', async () => {
    const { result } = renderHook(() => usePrivyActions());
    const actions = result.current;
    expect(await outcome(actions.sendCode('artist@example.com'))).toMatchObject({ _tag: 'Success' });
    expect(privy.sendCode).toHaveBeenLastCalledWith({ email: 'artist@example.com' });
    privy.sendCode.mockImplementationOnce(() => Promise.reject({ privyErrorCode: 'too_many_requests' }));
    expect(await outcome(actions.sendCode('a@b.c'))).toMatchObject({ failure: { _tag: 'TooManyTries' } });
    privy.sendCode.mockImplementationOnce(() => Promise.reject(new Error('down')));
    expect(await outcome(actions.sendCode('a@b.c'))).toMatchObject({ failure: { _tag: 'CodeNotSent' } });

    expect(await outcome(actions.loginWithCode('123456'))).toMatchObject({ _tag: 'Success', success: undefined });
    expect(privy.loginWithCode).toHaveBeenLastCalledWith({ code: '123456' });
    privy.loginWithCode.mockImplementationOnce(() => Promise.reject({ privyErrorCode: 'invalid_credentials' }));
    expect(await outcome(actions.loginWithCode('000000'))).toMatchObject({ failure: { _tag: 'WrongCode' } });

    expect(await outcome(actions.initOAuth('apple'))).toMatchObject({ _tag: 'Success' });
    expect(privy.initOAuth).toHaveBeenLastCalledWith({ provider: 'apple' });
    privy.initOAuth.mockImplementationOnce(() => Promise.reject(new Error('popup')));
    expect(await outcome(actions.initOAuth('google'))).toMatchObject({ failure: { _tag: 'Refused' } });
  });

  test('the wallet, the token, a signature, signing out', async () => {
    const { result } = renderHook(() => usePrivyActions());
    const actions = result.current;
    expect(await outcome(actions.createSuiWallet)).toMatchObject({ success: { id: 'did:privy:u' } });
    expect(privy.createWallet).toHaveBeenLastCalledWith({ chainType: 'sui' });
    privy.createWallet.mockImplementationOnce(() => Promise.reject(new Error('no')));
    const failed = await outcome(actions.createSuiWallet);
    expect(failed).toMatchObject({ failure: { _tag: 'PrivyCallFailed', call: 'createSuiWallet' } });
    expect(failed._tag === 'Failure' && failed.failure instanceof PrivyCallFailed && failed.failure.message).toBe('Privy’s createSuiWallet failed');

    expect(await outcome(actions.refreshIdentityToken)).toMatchObject({ success: Option.some('token') });
    privy.getIdentityToken.mockImplementationOnce(async () => null);
    expect(await outcome(actions.refreshIdentityToken)).toMatchObject({ success: Option.none() });
    const refusal = { status: 401 };
    privy.getIdentityToken.mockImplementationOnce(() => Promise.reject(refusal));
    expect(await outcome(actions.refreshIdentityToken)).toMatchObject({ failure: { call: 'identityToken', cause: refusal } });

    expect(await actions.signRawHash('0xabc', '0x01')).toBe('0xsig');
    expect(privy.signRawHash).toHaveBeenLastCalledWith({ address: '0xabc', chainType: 'sui', hash: '0x01' });

    expect(await outcome(actions.logout)).toMatchObject({ _tag: 'Success' });
    privy.logout.mockImplementationOnce(() => Promise.reject(new Error('no')));
    expect(await outcome(actions.logout)).toMatchObject({ failure: { call: 'logout' } });
  });
});
