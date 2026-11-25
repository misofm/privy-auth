import { getIdentityToken, type PrivyEvents, type User, useIdentityToken, useLoginWithEmail, useLoginWithOAuth, useLogout, usePrivy } from '@privy-io/react-auth';
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { Effect, Option, Schema } from 'effect';
import { useEffect, useMemo, useRef, useState } from 'react';

import { suiWalletAccount } from './account.js';
import { type PrivyFailure, privyFailure, Refused } from './failure.js';
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

/**
 * Who Privy's hooks act for, as one state (`ready`, `authenticated` and `user` read together):
 * exactly one holds at a time, and only `SignedIn` has a wallet that signs.
 */
export type PrivySession =
  /** Privy hasn't loaded: it doesn't know yet whether someone is signed in. */
  | { readonly _tag: 'Loading' }
  /** Privy has loaded, and no one is signed in. */
  | { readonly _tag: 'SignedOut' }
  /** Privy has finished a sign-in that its hooks don't show whole yet (a render or two): wait. */
  | { readonly _tag: 'SigningIn' }
  /** Signed in, and Privy's hooks act for `user`: its wallet signs. */
  | { readonly _tag: 'SignedIn'; readonly user: User };

const LOADING: PrivySession = { _tag: 'Loading' };
const SIGNED_OUT: PrivySession = { _tag: 'SignedOut' };
const SIGNING_IN: PrivySession = { _tag: 'SigningIn' };

/** What a sign-in Privy finished, or refused, tells the app (`usePrivyActions`'s callbacks). */
export interface PrivyActionsCallbacks {
  /**
   * Someone is signed in, and Privy's hooks act for `user` (`session` is `SignedIn`): an emailed
   * code's sign-in, a Google or Apple return, or a kept one Privy found on load. Called once per
   * sign-in, after the render that shows it, so the wallet signs from here.
   */
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
  /** `ready`, `authenticated` and `user` as one state: who Privy's hooks act for. */
  readonly session: PrivySession;
  /** The identity token Privy keeps (refreshed with its user), if any. */
  readonly identityToken: Option.Option<string>;
  /** Emails a sign-in code (`useLoginWithEmail`'s `sendCode`): done once Privy has sent it. */
  readonly sendCode: (email: string) => Effect.Effect<void, PrivyFailure>;
  /**
   * Signs in with the emailed code: `WrongCode` when Privy refuses it. Succeeds once Privy's hooks
   * show the user it signed in and `onComplete` has been called with them; `Refused` if they never
   * do (10 s by `Clock`).
   */
  readonly loginWithCode: (code: string) => Effect.Effect<void, PrivyFailure>;
  /** Leaves for Google's or Apple's sign-in (`initOAuth`): done as the page is sent there; Privy finishes it where the page comes back (`onComplete` or `onError`). */
  readonly initOAuth: (provider: OAuthProvider) => Effect.Effect<void, PrivyFailure>;
  /**
   * Makes the signed-in account's Privy embedded Sui wallet (`createWallet({ chainType: 'sui' })`)
   * unless it has one, and answers the user with it once Privy's hooks show it (so it signs at
   * once). Never a second wallet from this hook: it reads the user the hooks show signed in
   * (waiting for them while Privy loads or finishes a sign-in), calls made together share one
   * request, and a wallet Privy has answered is not asked for again. Fails when no one is signed
   * in, and when the hooks don't show the user, or the wallet made, in 10 s (by `Clock`).
   */
  readonly createSuiWallet: Effect.Effect<User, PrivyCallFailed>;
  /** A fresh identity token from Privy (`getIdentityToken`): `None` when no one is signed in. */
  readonly refreshIdentityToken: Effect.Effect<Option.Option<string>, PrivyCallFailed>;
  /**
   * An Ed25519 signature over a 32-byte digest by the Sui wallet at `address` (`signRawHash`), hex
   * both ways. A Promise, because `PrivySigner` (the Sui SDK) calls it as one. It signs with
   * Privy's hooks as they are when it is called, whichever render it was taken from.
   */
  readonly signRawHash: (address: string, hash: `0x${string}`) => Promise<`0x${string}`>;
  /** Ends Privy's sign-in. */
  readonly logout: Effect.Effect<void, PrivyCallFailed>;
}

/** How long a call waits for Privy's hooks to show what Privy has just done (they render after it answers). */
const SHOWN_TIMEOUT = '10 seconds';

/** The user a sign-in reports, if it names one (Privy's callbacks are given what its API answered). */
const reportedUser = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));

/** The address of the Privy embedded Sui wallet among a user's accounts, if any. */
const suiAddressOf = (user: Pick<User, 'linkedAccounts'>): Option.Option<string> => Option.map(suiWalletAccount(user.linkedAccounts), (wallet) => wallet.address);

/**
 * What Privy's hooks show, for the Effects that wait on it (they hold no React state): the
 * session, whose sign-in `onComplete` has heard, and the wallets asked for.
 */
class Shown {
  /** The session of the latest render (so a child's effect and this hook's agree). */
  session: PrivySession = LOADING;
  /** The user whose sign-in `onComplete` has been called for, until it ends. */
  arrived: Option.Option<string> = Option.none();
  /** The user of the sign-in Privy reported last. */
  lastReported: Option.Option<string> = Option.none();
  /** Since a sign-in was reported, the hooks have said `authenticated`. */
  sawAuthenticated = false;
  /** The wallet being made for a user (by id), shared by every call made meanwhile. */
  readonly creating = new Map<string, Promise<User>>();
  /** The user Privy answered with a wallet made here (by id): never asked for again. */
  readonly made = new Map<string, User>();
  private readonly waiting = new Set<() => void>();

  /** A commit happened: whatever waits looks again. */
  committed() {
    for (const look of [...this.waiting]) look();
  }

  /** Succeeds with what `pick` finds, now or after a later commit. */
  until<A>(pick: () => Option.Option<A>): Effect.Effect<A> {
    return Effect.callback<A>((resume) => {
      const look = () => {
        const found = pick();
        if (Option.isNone(found)) return;
        this.waiting.delete(look);
        resume(Effect.succeed(found.value));
      };
      this.waiting.add(look);
      look();
      return Effect.sync(() => void this.waiting.delete(look));
    });
  }
}

/**
 * Privy's hooks as one value, its quirks handled once (call it inside `PrivyProvider`, once per
 * app, and keep it mounted where Google or Apple return).
 *
 * Privy calls its own `onComplete` before its hooks show the user, and its wallet refuses to sign
 * until they do ("User must be authenticated before signing"); a wallet just made isn't found
 * until they show it either. So here each step ends only once the hooks act on it: `onComplete`
 * is held until `session` is `SignedIn` and called then, from an effect, once per sign-in (each
 * accepted code, each return from Google or Apple, a kept sign-in found on load; the email hook
 * and the `login` event may both report one); `loginWithCode` succeeds after it;
 * `createSuiWallet` succeeds once the hooks show the wallet. An app need not gate on `ready` or
 * `authenticated` itself.
 *
 * Privy's `login` event (the OAuth hook's callbacks) hears every sign-in, so `onError` hears the
 * email flow's refusals too; the email hook's `onError` also fires for a code not sent, so it
 * isn't wired (the Effects carry the failures). The callbacks are subscribed once (Privy
 * subscribes again whenever its callbacks object changes) and call the latest ones given. The
 * functions keep their identity for the life of the hook, and call Privy's latest.
 */
export function usePrivyActions(callbacks: PrivyActionsCallbacks = {}): PrivyActions {
  const { ready, authenticated, user } = usePrivy();
  const { identityToken } = useIdentityToken();
  /** The user of a sign-in Privy has reported and `onComplete` has yet to hear. */
  const [reported, setReported] = useState<Option.Option<string>>(Option.none);
  const [shown] = useState(() => new Shown());

  /** A sign-in Privy reports: held (a report naming no user is none) until its hooks show it. */
  const [report] = useState(() => ({ user }: { readonly user: unknown }) => {
    const id = Option.map(reportedUser(user), (named) => named.id);
    if (Option.isNone(id)) return;
    shown.lastReported = id;
    setReported(id);
  });
  const [onEmail] = useState<PrivyEvents['login']>(() => ({ onComplete: report }));
  const [onLogin] = useState<PrivyEvents['login']>(() => ({
    onComplete: report,
    onError: (error) => latest.current.callbacks.onError?.(privyFailure(error, 'login')),
  }));
  // A sign-out ends the sign-in heard (the next is another, whoever it is), and drops one reported and never shown.
  const [onLogout] = useState<PrivyEvents['logout']>(() => ({
    onSuccess: () => {
      shown.arrived = Option.none();
      setReported(Option.none());
    },
  }));
  const { sendCode, loginWithCode } = useLoginWithEmail(onEmail);
  const { initOAuth } = useLoginWithOAuth(onLogin);
  const { logout } = useLogout(onLogout);
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const latest = useRef({ callbacks, sendCode, loginWithCode, initOAuth, logout, createWallet, signRawHash });
  latest.current = { callbacks, sendCode, loginWithCode, initOAuth, logout, createWallet, signRawHash };

  const signedIn = useMemo<PrivySession | undefined>(() => (ready && authenticated && user ? { _tag: 'SignedIn', user } : undefined), [ready, authenticated, user]);
  const session = signedIn ?? (!ready ? LOADING : authenticated || Option.isSome(reported) ? SIGNING_IN : SIGNED_OUT);
  shown.session = session;

  useEffect(() => {
    shown.session = session;
    if (session._tag === 'SignedOut') shown.arrived = Option.none();
    // A sign-in reported, then Privy's hooks signed in and out again without ever showing its user: it is over.
    if (Option.isNone(reported)) shown.sawAuthenticated = false;
    else if (authenticated) shown.sawAuthenticated = true;
    else if (shown.sawAuthenticated) setReported(Option.none());
    if (session._tag === 'SignedIn' && Option.contains(reported, session.user.id)) {
      setReported(Option.none());
      if (!Option.contains(shown.arrived, session.user.id)) {
        shown.arrived = Option.some(session.user.id);
        latest.current.callbacks.onComplete?.(session.user);
      }
    }
    shown.committed();
  }, [shown, session, reported, authenticated]);

  const [actions] = useState(() => {
    const notShown = (what: string) => new Error(`Privy’s hooks didn’t show ${what} in ${SHOWN_TIMEOUT}`);
    const notCreated = (cause: unknown) => new PrivyCallFailed({ call: 'createSuiWallet', cause });
    /** The user Privy's hooks show signed in. */
    const signedInUser = () => (shown.session._tag === 'SignedIn' ? Option.some(shown.session.user) : Option.none<User>());
    /** That user, once they are `id` with the Sui wallet at `address`. */
    const withWallet = (id: string, address: string) => () => Option.filter(signedInUser(), (user) => user.id === id && Option.contains(suiAddressOf(user), address));
    /** One request for the wallet of the user `id`, whoever asks meanwhile; what Privy answers is kept. */
    const create = (id: string): Promise<User> => {
      const running = shown.creating.get(id);
      if (running) return running;
      const asked = latest.current.createWallet({ chainType: 'sui' }).then(
        (created) => {
          shown.creating.delete(id);
          if (Option.isSome(suiAddressOf(created.user))) shown.made.set(id, created.user);
          return created.user;
        },
        (cause: unknown) => {
          shown.creating.delete(id);
          throw cause;
        },
      );
      shown.creating.set(id, asked);
      return asked;
    };
    return {
      sendCode: (email: string) => Effect.tryPromise({ try: () => latest.current.sendCode({ email }), catch: (cause) => privyFailure(cause, 'sendCode') }),
      loginWithCode: (code: string) =>
        Effect.tryPromise({
          try: () => {
            // A code checked is another sign-in: Privy reports it even for the user already signed in, and `onComplete` hears it.
            shown.arrived = Option.none();
            return latest.current.loginWithCode({ code });
          },
          catch: (cause) => privyFailure(cause, 'loginWithCode'),
        }).pipe(
          // Privy's hook reported the user it signed in before it answered: that user's `onComplete` is the one awaited.
          Effect.andThen(
            Effect.suspend(() => {
              const user = shown.lastReported;
              return shown.until(() => Option.filter(shown.arrived, (arrived) => Option.isNone(user) || Option.contains(user, arrived)));
            }).pipe(Effect.timeoutOrElse({ duration: SHOWN_TIMEOUT, orElse: () => Effect.fail<PrivyFailure>(new Refused({ cause: notShown('the sign-in') })) })),
          ),
          Effect.asVoid,
        ),
      initOAuth: (provider: OAuthProvider) => Effect.tryPromise({ try: () => latest.current.initOAuth({ provider }), catch: (cause) => privyFailure(cause, 'login') }).pipe(Effect.asVoid),
      createSuiWallet: Effect.suspend(() =>
        shown.session._tag === 'SignedOut'
          ? Effect.fail(notCreated(new Error('No one is signed in')))
          : shown.until(signedInUser).pipe(Effect.timeoutOrElse({ duration: SHOWN_TIMEOUT, orElse: () => Effect.fail(notCreated(notShown('the sign-in'))) })),
      ).pipe(
        Effect.flatMap((user) => {
          if (Option.isSome(suiAddressOf(user))) return Effect.succeed(user);
          const made = shown.made.get(user.id);
          return (made ? Effect.succeed(made) : Effect.tryPromise({ try: () => create(user.id), catch: notCreated })).pipe(
            Effect.flatMap((created) =>
              Option.match(suiAddressOf(created), {
                // No wallet among its accounts: nothing to wait for (the app reads it and says so).
                onNone: () => Effect.succeed(created),
                onSome: (address) =>
                  shown.until(withWallet(user.id, address)).pipe(Effect.timeoutOrElse({ duration: SHOWN_TIMEOUT, orElse: () => Effect.fail(notCreated(notShown('the wallet'))) })),
              }),
            ),
          );
        }),
      ),
      refreshIdentityToken: Effect.tryPromise({ try: () => getIdentityToken(), catch: (cause) => new PrivyCallFailed({ call: 'identityToken', cause }) }).pipe(
        Effect.map(Option.fromNullishOr),
      ),
      signRawHash: (address: string, hash: `0x${string}`) => latest.current.signRawHash({ address, chainType: 'sui', hash }).then(({ signature }) => signature as `0x${string}`),
      logout: Effect.tryPromise({ try: () => latest.current.logout(), catch: (cause) => new PrivyCallFailed({ call: 'logout', cause }) }),
    };
  });
  return useMemo(
    () => ({ ready, authenticated, user: Option.fromNullishOr(user), session, identityToken: Option.fromNullishOr(identityToken), ...actions }),
    [ready, authenticated, user, session, identityToken, actions],
  );
}
