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

/** What the flow is doing: sending a code, checking one, or leaving for a provider. */
export type SignInRunning = 'send' | 'code' | OAuthProvider;

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
  /** Signs in with the code last emailed. */
  readonly signInWithCode: (code: string) => Effect.Effect<void, E, R>;
  /** Leaves for Google's or Apple's sign-in: succeeds as the page goes (it stays busy until then). */
  readonly signInWith: (provider: OAuthProvider) => Effect.Effect<void, E, R>;
}

/** The flow's state. */
export interface SignInFlowState<E> {
  readonly step: SignInStep;
  readonly email: string;
  readonly emailProblem: Option.Option<EmailProblem>;
  readonly code: string;
  readonly running: Option.Option<SignInRunning>;
  /** The last failure, and what failed: sending, the code, or Google or Apple. */
  readonly failure: Option.Option<{ readonly from: 'send' | 'code' | 'oauth'; readonly error: E }>;
  /** Seconds until a code can be sent again (`0`: now). */
  readonly resendIn: number;
}

export const initialFlowState = <E>(): SignInFlowState<E> => ({
  step: 'email',
  email: '',
  emailProblem: Option.none(),
  code: '',
  running: Option.none(),
  failure: Option.none(),
  resendIn: 0,
});

/**
 * An email address as `<input type="email">` accepts one (the HTML standard's "valid email
 * address"), so a screen relying on the browser's own check agrees with this one.
 */
export const isEmailAddress = (email: string): boolean =>
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(email);

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
 * The sign-in screen's state machine: the email, the code, which step, what runs, which failure
 * shows where, and the resend countdown (by `Clock`). Commands are Effects that change the state
 * synchronously and fork the app's actions into the flow's scope; closing it interrupts them.
 */
export const makeSignInFlow = <E extends TaggedFailure, R>(actions: SignInActions<E, R>, options: SignInFlowOptions<E> = {}, initial: SignInFlowState<E> = initialFlowState<E>()) =>
  Effect.gen(function* () {
    const isEmail = options.isEmail ?? isEmailAddress;
    const state = yield* Ref.make(initial);
    const work = yield* FiberSet.make<void, never>();
    const countdown = yield* FiberHandle.make<void, never>();
    const update = (f: (state: SignInFlowState<E>) => SignInFlowState<E>) =>
      Ref.updateAndGet(state, f).pipe(Effect.flatMap((next) => Effect.sync(() => options.onChange?.(next))));
    /** `running` cleared if it is still `what` (a defect or an interruption ended it). */
    const done = (what: SignInRunning) => update((s) => (Option.contains(s.running, what) ? { ...s, running: Option.none() } : s));
    const failed = (from: 'send' | 'code' | 'oauth', error: E) => (s: SignInFlowState<E>) => ({ ...s, running: Option.none(), failure: Option.some({ from, error }) });

    const tick = Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const left = Clock.currentTimeMillis.pipe(
        Effect.map((now) => Math.max(0, RESEND_SECONDS - Math.floor((now - start) / 1000))),
        Effect.tap((seconds) => update((s) => ({ ...s, resendIn: seconds }))),
      );
      yield* Effect.repeat(left, { schedule: Schedule.spaced('1 second'), until: (seconds) => seconds === 0 });
    });

    const send = (to: string) =>
      update((s) => ({ ...s, running: Option.some('send'), failure: Option.none() })).pipe(
        Effect.andThen(
          FiberSet.run(
            work,
            actions.sendCode(to).pipe(
              Effect.matchEffect({
                onFailure: (error) => update(failed('send', error)),
                onSuccess: () =>
                  update((s) => ({ ...s, step: 'code', code: '', running: Option.none(), failure: Option.none(), resendIn: RESEND_SECONDS })).pipe(
                    Effect.andThen(FiberHandle.run(countdown, tick)),
                  ),
              }),
              Effect.ensuring(done('send')),
            ),
          ),
        ),
        Effect.asVoid,
      );

    const idle = Ref.get(state).pipe(Effect.map((s) => (Option.isNone(s.running) ? Option.some(s) : Option.none())));

    return {
      state: Ref.get(state),
      setEmail: (email: string) =>
        update((s) => ({ ...s, email, emailProblem: Option.none(), failure: Option.filter(s.failure, (f) => f.from !== 'send') })),
      submitEmail: idle.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (s) => {
              const to = s.email.trim();
              const problem: Option.Option<EmailProblem> = to === '' ? Option.some('Missing') : isEmail(to) ? Option.none() : Option.some('Malformed');
              return Option.isSome(problem) ? update((current) => ({ ...current, emailProblem: problem })) : send(to);
            },
          }),
        ),
      ),
      setCode: (code: string) => update((s) => ({ ...s, code, failure: Option.filter(s.failure, (f) => f.from === 'oauth') })),
      submitCode: (value?: string) =>
        idle.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (s) => {
                const code = value ?? s.code;
                if (code.length !== CODE_LENGTH) return Effect.void;
                return update((current) => ({ ...current, code, running: Option.some('code'), failure: Option.none() })).pipe(
                  Effect.andThen(
                    FiberSet.run(
                      work,
                      actions.signInWithCode(code).pipe(
                        Effect.matchEffect({
                          onFailure: (error) =>
                            error._tag === 'WrongCode'
                              ? update((current) => ({ ...failed('code', error)(current), code: '' })).pipe(Effect.andThen(Effect.sync(() => options.onWrongCode?.())))
                              : update(failed('code', error)),
                          onSuccess: () => Effect.void,
                        }),
                        Effect.ensuring(done('code')),
                      ),
                    ),
                  ),
                  Effect.asVoid,
                );
              },
            }),
          ),
        ),
      resend: idle.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (s) => (s.step === 'code' && s.resendIn === 0 ? send(s.email.trim()) : Effect.void),
          }),
        ),
      ),
      differentEmail: idle.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: () => update((s) => ({ ...s, step: 'email', code: '', failure: Option.none() })),
          }),
        ),
      ),
      continueWith: (provider: OAuthProvider) =>
        idle.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: () =>
                update((s) => ({ ...s, running: Option.some(provider), failure: Option.none() })).pipe(
                  Effect.andThen(
                    FiberSet.run(
                      work,
                      actions.signInWith(provider).pipe(
                        Effect.matchEffect({
                          onFailure: (error) => update(failed('oauth', error)),
                          // The page is leaving: busy until it has, or until it comes back from the cache.
                          onSuccess: () => pageRestored.pipe(Effect.andThen(done(provider))),
                        }),
                        Effect.ensuring(done(provider)),
                      ),
                    ),
                  ),
                  Effect.asVoid,
                ),
            }),
          ),
        ),
    };
  });
