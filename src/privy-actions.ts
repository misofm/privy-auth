import { getIdentityToken, type PrivyEvents, type User, useIdentityToken, useLoginWithEmail, useLoginWithOAuth, useLogout, usePrivy } from '@privy-io/react-auth';
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { Effect, Option, Schema } from 'effect';
import { useMemo, useRef, useState } from 'react';

import { type PrivyFailure, privyFailure } from './failure.js';
import type { OAuthProvider } from './oauth.js';

/** A Privy call outside the sign-in steps failed: making the Sui wallet, a fresh identity token, or signing out. */
export class PrivyCallFailed extends Schema.TaggedError<PrivyCallFailed>()('PrivyCallFailed', {
  call: Schema.Literals(['createSuiWallet', 'identityToken', 'logout']),
  /** What Privy rejected with (for `isSignedOutRefresh`, and logs; never shown). */
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Privy’s ${this.call} failed`;
  }
}

/** What a sign-in Privy finished, or refused, tells the app (`usePrivyActions`'s callbacks). */
export interface PrivyActionsCallbacks {
  /** Privy finished a sign-in: an emailed code's, a Google or Apple return, or a kept one it found on load. */
  readonly onComplete?: ((user: User) => void) | undefined;
  /** Privy's `login` event failed: a Google or Apple return, or a refusal in the email flow. */
  readonly onError?: ((failure: PrivyFailure) => void) | undefined;
}

/** Privy's headless sign-in, its Sui wallet and its tokens, as one value (one render's). */
export interface PrivyActions {
  /** Privy has loaded and knows whether someone is signed in. */
  readonly ready: boolean;
  readonly authenticated: boolean;
  readonly user: Option.Option<User>;
  /** The identity token Privy keeps (refreshed with its user), if any. */
  readonly identityToken: Option.Option<string>;
  /** Emails a sign-in code (`useLoginWithEmail`'s `sendCode`): done once Privy has sent it. */
  readonly sendCode: (email: string) => Effect.Effect<void, PrivyFailure>;
  /** Signs in with the emailed code: `WrongCode` when Privy refuses it. The user arrives through `onComplete`, before this succeeds. */
  readonly loginWithCode: (code: string) => Effect.Effect<void, PrivyFailure>;
  /** Leaves for Google's or Apple's sign-in (`initOAuth`): done as the page is sent there; Privy finishes it where the page comes back (`onComplete` or `onError`). */
  readonly initOAuth: (provider: OAuthProvider) => Effect.Effect<void, PrivyFailure>;
  /** Makes the account's Privy embedded Sui wallet (`createWallet({ chainType: 'sui' })`); answers the user with it. */
  readonly createSuiWallet: Effect.Effect<User, PrivyCallFailed>;
  /** A fresh identity token from Privy (`getIdentityToken`): `None` when no one is signed in. */
  readonly refreshIdentityToken: Effect.Effect<Option.Option<string>, PrivyCallFailed>;
  /**
   * An Ed25519 signature over a 32-byte digest by the Sui wallet at `address` (`signRawHash`), hex
   * both ways. A Promise, because `PrivySigner` (the Sui SDK) calls it as one.
   */
  readonly signRawHash: (address: string, hash: `0x${string}`) => Promise<`0x${string}`>;
  /** Ends Privy's sign-in. */
  readonly logout: Effect.Effect<void, PrivyCallFailed>;
}

/**
 * Privy's hooks as one value, its quirks handled once (call it inside `PrivyProvider`, once per
 * app, and keep it mounted where Google or Apple return). Privy's `login` event (the OAuth hook's
 * callbacks) hears every sign-in, so `onComplete` and `onError` hear the email flow's too; the
 * email hook's own `onComplete` runs before `loginWithCode` resolves and goes to `onComplete` as
 * well (one sign-in may be reported twice: make it idempotent); the email hook's `onError` also
 * fires for a code not sent, so it isn't wired (the Effects carry the failures). The callbacks
 * are subscribed once (Privy subscribes again whenever its callbacks object changes) and call
 * the latest ones given. The functions keep their identity while Privy's do.
 */
export function usePrivyActions(callbacks: PrivyActionsCallbacks = {}): PrivyActions {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  const [onEmail] = useState<PrivyEvents['login']>(() => ({ onComplete: ({ user }) => latest.current.onComplete?.(user) }));
  const [onLogin] = useState<PrivyEvents['login']>(() => ({
    onComplete: ({ user }) => latest.current.onComplete?.(user),
    onError: (error) => latest.current.onError?.(privyFailure(error, 'login')),
  }));
  const { ready, authenticated, user } = usePrivy();
  const { identityToken } = useIdentityToken();
  const { sendCode, loginWithCode } = useLoginWithEmail(onEmail);
  const { initOAuth } = useLoginWithOAuth(onLogin);
  const { logout } = useLogout();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();

  const actions = useMemo(
    () => ({
      sendCode: (email: string) => Effect.tryPromise({ try: () => sendCode({ email }), catch: (cause) => privyFailure(cause, 'sendCode') }),
      loginWithCode: (code: string) => Effect.tryPromise({ try: () => loginWithCode({ code }), catch: (cause) => privyFailure(cause, 'loginWithCode') }).pipe(Effect.asVoid),
      initOAuth: (provider: OAuthProvider) => Effect.tryPromise({ try: () => initOAuth({ provider }), catch: (cause) => privyFailure(cause, 'login') }).pipe(Effect.asVoid),
      createSuiWallet: Effect.tryPromise({
        try: () => createWallet({ chainType: 'sui' }),
        catch: (cause) => new PrivyCallFailed({ call: 'createSuiWallet', cause }),
      }).pipe(Effect.map((created) => created.user)),
      refreshIdentityToken: Effect.tryPromise({ try: () => getIdentityToken(), catch: (cause) => new PrivyCallFailed({ call: 'identityToken', cause }) }).pipe(
        Effect.map(Option.fromNullishOr),
      ),
      signRawHash: (address: string, hash: `0x${string}`) => signRawHash({ address, chainType: 'sui', hash }).then(({ signature }) => signature as `0x${string}`),
      logout: Effect.tryPromise({ try: () => logout(), catch: (cause) => new PrivyCallFailed({ call: 'logout', cause }) }),
    }),
    [sendCode, loginWithCode, initOAuth, createWallet, signRawHash, logout],
  );
  return useMemo(
    () => ({ ready, authenticated, user: Option.fromNullishOr(user), identityToken: Option.fromNullishOr(identityToken), ...actions }),
    [ready, authenticated, user, identityToken, actions],
  );
}
