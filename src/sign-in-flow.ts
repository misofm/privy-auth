import { Clock, Effect, FiberHandle, FiberSet, Option, Ref, Schedule } from 'effect';

import type { OAuthProvider } from './oauth.js';

/** How many digits Privy's emailed sign-in code has. */
export const CODE_LENGTH = 6;
/** How long after each code sent before another can be asked for, in seconds. */
export const RESEND_SECONDS = 30;

/** Why an email was refused before anything was sent: none typed, or not an address. */
export type EmailProblem = 'Missing' | 'Malformed';

/** The sign-in screen's step: the email (and Google, Apple), or the code sent to it. */
export type SignInStep = 'email' | 'code';

/** Any tagged failure (`_tag`): the package's `PrivyFailure`s, or an app's own errors. */
export type TaggedFailure = { readonly _tag: string };

/** A failure the code field shows itself: Privy refused the code (the package's `WrongCode`, or an app error of that tag). */
export type WrongCodeOf<E> = Extract<E, { readonly _tag: 'WrongCode' }>;

/**
 * The app's own sign-in operations, as Effects: each app routes them its own way (the fan app
 * through its `Session` service, Studio through its account context). Their failures are what the
 * screen shows: a `WrongCode` on the code field, any other in the alert line.
 */
export interface SignInActions<E, R = never> {
  /** Emails a sign-in code to `email` (already trimmed and checked). */
  readonly sendCode: (email: string) => Effect.Effect<void, E, R>;
  /**
   * Signs in with the code last emailed: succeeds once the person is signed in. The screen shows
   * the code being checked until it answers, and its failure; what an app must finish before
   * anyone is signed in to it belongs in here.
   */
  readonly signInWithCode: (code: string) => Effect.Effect<void, E, R>;
  /** Leaves for Google's or Apple's sign-in: succeeds as the page goes (it stays busy until then). */
  readonly signInWith: (provider: OAuthProvider) => Effect.Effect<void, E, R>;
}

/** A code sent: the address it went to, and the seconds until another can be sent (`0`: now). */
export interface SentCode {
  readonly to: string;
  readonly resendIn: number;
}

/** A failure the screen shows, and what failed: sending, the code, or Google or Apple. */
export interface ShownFailure<E> {
  readonly from: 'send' | 'code' | 'oauth';
  readonly error: E;
}

/**
 * The sign-in screen's state: exactly one of these at a time. `Email` and `Code` take the
 * person's input; `Sending`, `Resending`, `Checking` and `Leaving` wait on one of the app's
 * actions, and take none. Every one keeps the email as typed.
 */
export type SignInFlowState<E> =
  /** Typing the email, or choosing Google or Apple. `sent`: a code sent earlier (to an address left with "a different email"). */
  | { readonly _tag: 'Email'; readonly email: string; readonly emailProblem: Option.Option<EmailProblem>; readonly failure: Option.Option<ShownFailure<E>>; readonly sent: Option.Option<SentCode> }
  /** The first code is being sent `to` the trimmed address. */
  | { readonly _tag: 'Sending'; readonly email: string; readonly to: string; readonly sent: Option.Option<SentCode> }
  /** Typing the code sent to `sent.to` (after one was accepted there: an empty field, and another code can be sent at once). */
  | { readonly _tag: 'Code'; readonly email: string; readonly code: string; readonly failure: Option.Option<ShownFailure<E>>; readonly sent: SentCode }
  /** Another code is being sent to `sent.to`. */
  | { readonly _tag: 'Resending'; readonly email: string; readonly code: string; readonly sent: SentCode }
  /** The code is being checked. */
  | { readonly _tag: 'Checking'; readonly email: string; readonly code: string; readonly sent: SentCode }
  /** Leaving for `provider`: its action runs, then (`left`) the page is on its way there. */
  | { readonly _tag: 'Leaving'; readonly email: string; readonly provider: OAuthProvider; readonly left: boolean; readonly sent: Option.Option<SentCode> };

/**
 * What can happen to the screen: what the person does (`SetEmail` to `StartOver`), how the action
 * a state waits on ends (`Sent`, `Accepted`, `Left`, `Failed`, or `Ended` without an answer: a
 * defect, an interruption), the page coming back from the provider's unfinished (`CameBack`), and
 * the clock (`Tick`).
 */
export type SignInEvent<E> =
  | { readonly _tag: 'SetEmail'; readonly email: string }
  | { readonly _tag: 'SubmitEmail' }
  | { readonly _tag: 'SetCode'; readonly code: string }
  | { readonly _tag: 'SubmitCode'; readonly code: Option.Option<string> }
  | { readonly _tag: 'Resend' }
  | { readonly _tag: 'DifferentEmail' }
  | { readonly _tag: 'ContinueWith'; readonly provider: OAuthProvider }
  | { readonly _tag: 'StartOver' }
  | { readonly _tag: 'Sent' }
  | { readonly _tag: 'Accepted' }
  | { readonly _tag: 'Left' }
  | { readonly _tag: 'Failed'; readonly error: E }
  | { readonly _tag: 'Ended' }
  | { readonly _tag: 'CameBack' }
  | { readonly _tag: 'Tick'; readonly resendIn: number };

/**
 * What a transition asks for besides the next state. The first four are the one thing the next
 * state waits on (an action of the app's, or the page coming back); the rest are done at once.
 */
export type SignInEffect =
  | { readonly _tag: 'Send'; readonly to: string }
  | { readonly _tag: 'Check'; readonly code: string }
  | { readonly _tag: 'Leave'; readonly provider: OAuthProvider }
  | { readonly _tag: 'AwaitReturn' }
  /** Count the resend wait down from `RESEND_SECONDS`. */
  | { readonly _tag: 'Countdown' }
  /** The code sent was used: the resend wait is over. */
  | { readonly _tag: 'EndCountdown' }
  /** The code field was emptied after a wrong code: focus it. */
  | { readonly _tag: 'Refocus' }
  /** Stop waiting on what the state left was waiting on. */
  | { readonly _tag: 'Cancel' };

export const initialFlowState = <E>(): SignInFlowState<E> => ({ _tag: 'Email', email: '', emailProblem: Option.none(), failure: Option.none(), sent: Option.none() });

/**
 * An email address as `<input type="email">` accepts one (the HTML standard's "valid email
 * address"), so a screen relying on the browser's own check agrees with this one.
 */
export const isEmailAddress = (email: string): boolean =>
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(email);

type State<E, Tag extends SignInFlowState<E>['_tag']> = Extract<SignInFlowState<E>, { readonly _tag: Tag }>;
type Step<E> = readonly [state: SignInFlowState<E>, effects: ReadonlyArray<SignInEffect>];

const NOTHING: ReadonlyArray<SignInEffect> = [];
const to = <E>(state: SignInFlowState<E>, ...effects: ReadonlyArray<SignInEffect>): Step<E> => [state, effects];

const emailStep = <E>(from: { readonly email: string; readonly sent: Option.Option<SentCode> | SentCode }, failure: Option.Option<ShownFailure<E>> = Option.none()): State<E, 'Email'> => ({
  _tag: 'Email',
  email: from.email,
  emailProblem: Option.none(),
  failure,
  sent: Option.isOption(from.sent) ? from.sent : Option.some(from.sent),
});
const codeStep = <E>(from: { readonly email: string; readonly sent: SentCode }, code: string, failure: Option.Option<ShownFailure<E>> = Option.none()): State<E, 'Code'> => ({
  _tag: 'Code',
  email: from.email,
  code,
  failure,
  sent: from.sent,
});
/** The code a state knows was sent, if any. */
export const sentCode = <E>(state: SignInFlowState<E>): Option.Option<SentCode> => (Option.isOption(state.sent) ? state.sent : Option.some(state.sent));

const shown = <E>(from: ShownFailure<E>['from'], error: E): Option.Option<ShownFailure<E>> => Option.some({ from, error });
const justSent = (to: string): SentCode => ({ to, resendIn: RESEND_SECONDS });
/** The same state, its resend wait at `resendIn` (the state itself when that changes nothing). */
const ticked = <E, S extends SignInFlowState<E>>(state: S, resendIn: number): S => {
  if (Option.exists(sentCode(state), (sent) => sent.resendIn !== resendIn)) return Option.isOption(state.sent) ? { ...state, sent: Option.map(state.sent, (sent) => ({ ...sent, resendIn })) } : { ...state, sent: { ...state.sent, resendIn } };
  return state;
};

type Handlers<E> = { readonly [Tag in SignInFlowState<E>['_tag']]: (state: State<E, Tag>, event: SignInEvent<E>, isEmail: (email: string) => boolean) => Step<E> };

const HANDLERS: Handlers<TaggedFailure> = {
  Email: (state, event, isEmail) => {
    switch (event._tag) {
      case 'SetEmail':
        return to({ ...state, email: event.email, emailProblem: Option.none(), failure: Option.filter(state.failure, (failure) => failure.from !== 'send') });
      case 'SubmitEmail': {
        const address = state.email.trim();
        if (address === '') return to({ ...state, emailProblem: Option.some('Missing') });
        if (!isEmail(address)) return to({ ...state, emailProblem: Option.some('Malformed') });
        // A code went to this address less than the resend wait ago: it stands, and no other is sent.
        const standing = Option.filter(state.sent, (sent) => sent.to === address && sent.resendIn > 0);
        if (Option.isSome(standing)) return to(codeStep({ email: state.email, sent: standing.value }, ''));
        return to({ _tag: 'Sending', email: state.email, to: address, sent: state.sent }, { _tag: 'Send', to: address });
      }
      case 'ContinueWith':
        return to({ _tag: 'Leaving', email: state.email, provider: event.provider, left: false, sent: state.sent }, { _tag: 'Leave', provider: event.provider });
      case 'StartOver':
        return to(emailStep(state));
      case 'Tick':
        return to(ticked(state, event.resendIn));
      default:
        return to(state);
    }
  },
  Sending: (state, event) => {
    switch (event._tag) {
      case 'Sent':
        return to(codeStep({ email: state.email, sent: justSent(state.to) }, ''), { _tag: 'Countdown' });
      case 'Failed':
        return to(emailStep(state, shown('send', event.error)));
      case 'Ended':
        return to(emailStep(state));
      case 'Tick':
        return to(ticked(state, event.resendIn));
      default:
        return to(state);
    }
  },
  Code: (state, event) => {
    switch (event._tag) {
      case 'SetCode':
        return to({ ...state, code: event.code, failure: Option.none() });
      case 'SubmitCode': {
        const code = Option.getOrElse(event.code, () => state.code);
        return code.length === CODE_LENGTH ? to({ _tag: 'Checking', email: state.email, code, sent: state.sent }, { _tag: 'Check', code }) : to(state);
      }
      case 'Resend':
        return state.sent.resendIn === 0 ? to({ _tag: 'Resending', email: state.email, code: state.code, sent: state.sent }, { _tag: 'Send', to: state.sent.to }) : to(state);
      case 'DifferentEmail':
      case 'StartOver':
        return to(emailStep(state));
      case 'ContinueWith':
        return to({ _tag: 'Leaving', email: state.email, provider: event.provider, left: false, sent: Option.some(state.sent) }, { _tag: 'Leave', provider: event.provider });
      case 'Tick':
        return to(ticked(state, event.resendIn));
      default:
        return to(state);
    }
  },
  Resending: (state, event) => {
    switch (event._tag) {
      case 'Sent':
        return to(codeStep({ email: state.email, sent: justSent(state.sent.to) }, ''), { _tag: 'Countdown' });
      case 'Failed':
        return to(codeStep(state, state.code, shown('send', event.error)));
      case 'Ended':
        return to(codeStep(state, state.code));
      case 'Tick':
        return to(ticked(state, event.resendIn));
      default:
        return to(state);
    }
  },
  Checking: (state, event) => {
    switch (event._tag) {
      case 'Accepted':
        // The code is spent: the field is emptied, and another can be sent at once (what comes next is the app's).
        return to(codeStep({ email: state.email, sent: { to: state.sent.to, resendIn: 0 } }, ''), { _tag: 'EndCountdown' });
      case 'Failed':
        // A wrong code empties the field (and it is focused); any other failure keeps the code.
        return event.error._tag === 'WrongCode' ? to(codeStep(state, '', shown('code', event.error)), { _tag: 'Refocus' }) : to(codeStep(state, state.code, shown('code', event.error)));
      case 'Ended':
        return to(codeStep(state, state.code));
      case 'Tick':
        return to(ticked(state, event.resendIn));
      default:
        return to(state);
    }
  },
  Leaving: (state, event) => {
    switch (event._tag) {
      // The page is leaving: busy until it has, or until it comes back from the cache.
      case 'Left':
        return state.left ? to(state) : to({ ...state, left: true }, { _tag: 'AwaitReturn' });
      case 'Failed':
        return state.left ? to(state) : to(emailStep(state, shown('oauth', event.error)));
      case 'CameBack':
        return state.left ? to(emailStep(state)) : to(state);
      case 'StartOver':
        return state.left ? to(emailStep(state), { _tag: 'Cancel' }) : to(state);
      case 'Ended':
        return to(emailStep(state));
      case 'Tick':
        return to(ticked(state, event.resendIn));
      default:
        return to(state);
    }
  },
};

/**
 * The sign-in screen's state machine, as a pure function: the state `event` leads to from
 * `state`, and what to do on the way. Total: an event a state has no use for (a command while it
 * waits, a late answer) leaves it as it is (the same object), with nothing to do.
 */
export const transition = <E extends TaggedFailure>(state: SignInFlowState<E>, event: SignInEvent<E>, isEmail: (email: string) => boolean = isEmailAddress): Step<E> => {
  // One handler per state (`Handlers` has every tag); none of them depends on what `E` is.
  const handle = HANDLERS[state._tag] as unknown as (state: SignInFlowState<E>, event: SignInEvent<E>, isEmail: (email: string) => boolean) => Step<E>;
  const [next, effects] = handle(state, event, isEmail);
  return next === state ? [state, NOTHING] : [next, effects];
};

export interface SignInFlowOptions<E> {
  /** Whether the trimmed email is an address (`isEmailAddress` by default). */
  readonly isEmail?: (email: string) => boolean;
  /** Privy refused the code: the field has been emptied (focus it). */
  readonly onWrongCode?: () => void;
  /** Every new state, as it happens (synchronously in the command that made it). */
  readonly onChange?: (state: SignInFlowState<E>) => void;
}

/** The page came back from the back/forward cache: back from the provider's page unfinished. */
const pageRestored = Effect.callback<void>((resume) => {
  const target = globalThis.window as Window | undefined;
  if (!target) return;
  const onShow = (event: PageTransitionEvent) => event.persisted && resume(Effect.void);
  target.addEventListener('pageshow', onShow);
  return Effect.sync(() => target.removeEventListener('pageshow', onShow));
});

/**
 * The sign-in screen's state machine, running: `transition` over a `Ref` (each event applied in
 * one step), the app's actions forked into the flow's scope (closing it interrupts them), the
 * resend countdown by `Clock`. Commands are Effects that change the state synchronously. A state
 * that waits leaves only by the answer of the one thing it waits on, which answers once. A flow
 * started from a state that waited (`initial`: a screen mounted again) starts from where that
 * state would have gone had its action ended without an answer.
 */
export const makeSignInFlow = <E extends TaggedFailure, R>(actions: SignInActions<E, R>, options: SignInFlowOptions<E> = {}, initial: SignInFlowState<E> = initialFlowState<E>()) =>
  Effect.gen(function* () {
    const isEmail = options.isEmail ?? isEmailAddress;
    const start = transition(initial, { _tag: 'Ended' }, isEmail)[0];
    if (start !== initial) yield* Effect.sync(() => options.onChange?.(start));
    const state = yield* Ref.make(start);
    const work = yield* FiberSet.make<void, never>();
    const countdown = yield* FiberHandle.make<void, never>();

    /** Applies `event`: the new state told, and what the transition asks for done (even if the telling throws). */
    const dispatch = (event: SignInEvent<E>): Effect.Effect<void, never, R> =>
      Ref.modify(state, (current) => {
        const [next, effects] = transition(current, event, isEmail);
        return [{ effects, changed: next === current ? Option.none<SignInFlowState<E>>() : Option.some(next) }, next] as const;
      }).pipe(
        Effect.flatMap(({ effects, changed }) =>
          Effect.sync(() => Option.map(changed, (next) => options.onChange?.(next))).pipe(Effect.ensuring(Effect.forEach(effects, perform, { discard: true }))),
        ),
      );

    /** Forks what a state waits on (`action`, made in the fork): it answers once, as `done`, its failure, or `Ended`. */
    const wait = (action: () => Effect.Effect<void, E, R>, done: SignInEvent<E>) =>
      FiberSet.run(
        work,
        Effect.suspend(() => {
          let answered = false;
          const answer = (event: SignInEvent<E>) => Effect.suspend(() => (answered ? Effect.void : ((answered = true), dispatch(event))));
          return Effect.suspend(action).pipe(
            Effect.matchEffect({ onFailure: (error) => answer({ _tag: 'Failed', error }), onSuccess: () => answer(done) }),
            Effect.ensuring(answer({ _tag: 'Ended' })),
          );
        }),
      ).pipe(Effect.asVoid);

    /** The resend wait counted down from `seconds`, a `Tick` each second. */
    const tick = (seconds: number) =>
      Effect.gen(function* () {
        const began = yield* Clock.currentTimeMillis;
        const left = Clock.currentTimeMillis.pipe(
          Effect.map((now) => Math.max(0, seconds - Math.floor((now - began) / 1000))),
          Effect.tap((resendIn) => dispatch({ _tag: 'Tick', resendIn })),
        );
        yield* Effect.repeat(left, { schedule: Schedule.spaced('1 second'), until: (resendIn) => resendIn === 0 });
      });
    const countDown = (seconds: number) => FiberHandle.run(countdown, tick(seconds)).pipe(Effect.asVoid);

    const perform = (effect: SignInEffect): Effect.Effect<void, never, R> => {
      switch (effect._tag) {
        case 'Send':
          return wait(() => actions.sendCode(effect.to), { _tag: 'Sent' });
        case 'Check':
          return wait(() => actions.signInWithCode(effect.code), { _tag: 'Accepted' });
        case 'Leave':
          return wait(() => actions.signInWith(effect.provider), { _tag: 'Left' });
        case 'AwaitReturn':
          return wait(() => pageRestored, { _tag: 'CameBack' });
        case 'Countdown':
          return countDown(RESEND_SECONDS);
        case 'EndCountdown':
          return FiberHandle.clear(countdown);
        case 'Refocus':
          return Effect.sync(() => options.onWrongCode?.());
        case 'Cancel':
          return FiberSet.clear(work);
      }
    };

    // A wait that was running when the screen last unmounted goes on from where it stood.
    const waited = Option.match(sentCode(start), { onNone: () => 0, onSome: (sent) => sent.resendIn });
    if (waited > 0) yield* countDown(waited);

    return {
      state: Ref.get(state),
      setEmail: (email: string) => dispatch({ _tag: 'SetEmail', email }),
      submitEmail: dispatch({ _tag: 'SubmitEmail' }),
      setCode: (code: string) => dispatch({ _tag: 'SetCode', code }),
      submitCode: (code?: string) => dispatch({ _tag: 'SubmitCode', code: Option.fromUndefinedOr(code) }),
      resend: dispatch({ _tag: 'Resend' }),
      differentEmail: dispatch({ _tag: 'DifferentEmail' }),
      continueWith: (provider: OAuthProvider) => dispatch({ _tag: 'ContinueWith', provider }),
      startOver: dispatch({ _tag: 'StartOver' }),
    };
  });
