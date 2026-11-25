import { Effect, Fiber, Option } from 'effect';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { OAuthProvider } from './oauth.js';
import {
  CODE_LENGTH,
  type EmailProblem,
  initialFlowState,
  isEmailAddress,
  makeSignInFlow,
  type SignInActions,
  type SignInFlowState,
  type SignInStep,
  type TaggedFailure,
  type WrongCodeOf,
} from './sign-in-flow.js';

/**
 * Runs one of the screen's programs, started at once (synchronously up to its first wait), as
 * `Effect.runFork` and `ManagedRuntime.runFork` do: the app's runtime, providing what its
 * actions need (`R`).
 */
export type RunSignIn<R> = (effect: Effect.Effect<void, never, R>) => Fiber.Fiber<void, unknown>;

export interface UseSignInOptions<R> {
  /** How the screen's programs run (`Effect.runFork`, or the app's runtime's `runFork`). */
  readonly run: RunSignIn<R>;
  /** Privy is finishing a return from this provider: its button busy, the rest of the screen still. */
  readonly returning?: OAuthProvider | undefined;
  /** Whether a trimmed email is an address (by default, as `<input type="email">` checks). */
  readonly isEmail?: ((email: string) => boolean) | undefined;
  /** Privy refused the code: the field has been emptied (focus it here). */
  readonly onWrongCode?: (() => void) | undefined;
}

/** The sign-in screen's state and what it can do, for one render. */
export interface SignIn<E> {
  readonly step: SignInStep;
  readonly email: string;
  readonly setEmail: (email: string) => void;
  /** Why the email was refused before anything was sent (shown on its field until it changes). */
  readonly emailProblem: Option.Option<EmailProblem>;
  /** Sends a code to the trimmed email, once it is an address. */
  readonly submitEmail: () => void;
  readonly code: string;
  readonly setCode: (code: string) => void;
  /** Signs in with `code` (by default the one typed), once it has `codeLength` digits. */
  readonly submitCode: (code?: string) => void;
  readonly codeLength: number;
  /** Seconds until `resend` can send another code (`0`: now). */
  readonly resendIn: number;
  readonly resend: () => void;
  /** Back to the email step. */
  readonly differentEmail: () => void;
  /** Leaves for Google's or Apple's sign-in. */
  readonly continueWith: (provider: OAuthProvider) => void;
  /** A code is being sent. */
  readonly sending: boolean;
  /** The code is being checked. */
  readonly checking: boolean;
  /** The provider whose button is busy: leaving for it, or (`returning`) back from it. */
  readonly provider: Option.Option<OAuthProvider>;
  /** Anything is running, or Privy is finishing a return: the screen's commands wait. */
  readonly busy: boolean;
  /** Privy refused the code: shown by the code field (which has been emptied). */
  readonly codeFailure: Option.Option<WrongCodeOf<E>>;
  /** Any other failure: shown in the screen's alert line. */
  readonly alert: Option.Option<Exclude<E, { readonly _tag: 'WrongCode' }>>;
}

type Latest<E, R> = { readonly actions: SignInActions<E, R>; readonly options: UseSignInOptions<R> };

/** The flow behind one mounted screen, and React's view of its state. */
class FlowHost<E extends TaggedFailure, R> {
  state: SignInFlowState<E> = initialFlowState<E>();
  flow: Option.Option<Effect.Success<ReturnType<typeof makeSignInFlow<E, R>>>> = Option.none();
  private mounts = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  readonly snapshot = () => this.state;

  /** Starts the flow for this mount (from the state it had), and answers how to stop it. */
  mount(latest: { readonly current: Latest<E, R> }) {
    const mount = ++this.mounts;
    const actions: SignInActions<E, R> = {
      sendCode: (email) => Effect.suspend(() => latest.current.actions.sendCode(email)),
      signInWithCode: (code) => Effect.suspend(() => latest.current.actions.signInWithCode(code)),
      signInWith: (provider) => Effect.suspend(() => latest.current.actions.signInWith(provider)),
    };
    const publish = (state: SignInFlowState<E>) => {
      if (mount !== this.mounts) return;
      this.state = state;
      for (const listener of this.listeners) listener();
    };
    const host = this;
    const fiber = latest.current.options.run(
      Effect.scoped(
        Effect.gen(function* () {
          const flow = yield* makeSignInFlow(
            actions,
            { isEmail: (email) => (latest.current.options.isEmail ?? isEmailAddress)(email), onWrongCode: () => latest.current.options.onWrongCode?.(), onChange: publish },
            host.state,
          );
          host.flow = Option.some(flow);
          return yield* Effect.never;
        }),
      ),
    );
    return () => {
      this.mounts++;
      this.flow = Option.none();
      latest.current.options.run(Fiber.interrupt(fiber));
    };
  }
}

/**
 * The sign-in screen's state machine, for an app's own screen over Privy's headless sign-in: an
 * email and the code Privy sends it (`codeLength` digits; another after `RESEND_SECONDS`), or Google
 * or Apple. `actions` are the app's own Effects, run with `options.run`. Each failure shows once:
 * a `WrongCode` as the code field's (`codeFailure`), any other in the alert line (`alert`); an
 * email missing or malformed is `emailProblem`, and nothing is sent. Starting anything clears the
 * failure shown; editing the email clears a send's failure, editing the code a send's or the
 * code's. A provider's button stays busy once its action succeeds (the page is leaving), until
 * the page comes back from the back/forward cache. Programs stop when the screen unmounts.
 */
export function useSignIn<E extends TaggedFailure, R = never>(actions: SignInActions<E, R>, options: UseSignInOptions<R>): SignIn<E> {
  const latest = useRef<Latest<E, R>>({ actions, options });
  latest.current = { actions, options };
  const [host] = useState(() => new FlowHost<E, R>());
  const state = useSyncExternalStore(host.subscribe, host.snapshot, host.snapshot);
  useEffect(() => host.mount(latest), [host]);

  const returning = options.returning;
  /** Runs a command of the flow, if it is mounted (and nothing is being returned from). */
  const command =
    <A extends ReadonlyArray<unknown>>(pick: (flow: Effect.Success<ReturnType<typeof makeSignInFlow<E, R>>>) => (...args: A) => Effect.Effect<void, never, R>, whileReturning = false) =>
    (...args: A) => {
      if (!whileReturning && latest.current.options.returning !== undefined) return;
      Option.map(host.flow, (flow) => latest.current.options.run(pick(flow)(...args)));
    };

  const running = Option.getOrUndefined(state.running);
  const leaving = running === 'google' || running === 'apple' ? running : undefined;
  const failure = Option.getOrUndefined(state.failure)?.error;
  const wrongCode = failure !== undefined && failure._tag === 'WrongCode';
  return {
    step: state.step,
    email: state.email,
    setEmail: command((flow) => flow.setEmail, true),
    emailProblem: state.emailProblem,
    submitEmail: command((flow) => () => flow.submitEmail),
    code: state.code,
    setCode: command((flow) => flow.setCode, true),
    submitCode: command((flow) => (code?: string) => flow.submitCode(code)),
    codeLength: CODE_LENGTH,
    resendIn: state.resendIn,
    resend: command((flow) => () => flow.resend),
    differentEmail: command((flow) => () => flow.differentEmail),
    continueWith: command((flow) => flow.continueWith),
    sending: running === 'send',
    checking: running === 'code',
    provider: Option.fromUndefinedOr(returning ?? leaving),
    busy: running !== undefined || returning !== undefined,
    codeFailure: wrongCode ? Option.some(failure as WrongCodeOf<E>) : Option.none(),
    alert: failure !== undefined && !wrongCode ? Option.some(failure as Exclude<E, { readonly _tag: 'WrongCode' }>) : Option.none(),
  };
}
