import { Option, Schema } from 'effect';

/** The sign-in step that failed: it decides what a failure without a telling code is. */
export type PrivyStep =
  /** `useLoginWithEmail`'s `sendCode`. */
  | 'sendCode'
  /** `useLoginWithEmail`'s `loginWithCode`. */
  | 'loginWithCode'
  /** Any other sign-in: `initOAuth`, an OAuth return, or Privy's `login` event's `onError`. */
  | 'login';

/**
 * What every sign-in failure carries: Privy's error code, when it gave one, and what the step
 * rejected with (for logs; never shown).
 */
const fields = { code: Schema.optional(Schema.String), cause: Schema.Defect() };
const describe = (failure: { readonly _tag: string; readonly code?: string | undefined }) =>
  `Privy sign-in failed: ${failure._tag}${failure.code === undefined ? '' : ` (${failure.code})`}`;

/** `loginWithCode` refused the code (`invalid_credentials`: mistyped, expired, or its tries used). */
export class WrongCode extends Schema.TaggedError<WrongCode>()('WrongCode', fields) {
  override get message() {
    return describe(this);
  }
}

/** `sendCode` failed without a more telling reason. */
export class CodeNotSent extends Schema.TaggedError<CodeNotSent>()('CodeNotSent', fields) {
  override get message() {
    return describe(this);
  }
}

/** Privy asks to wait (`too_many_requests`, or HTTP 429). */
export class TooManyTries extends Schema.TaggedError<TooManyTries>()('TooManyTries', fields) {
  override get message() {
    return describe(this);
  }
}

/** The person declined at Google or Apple (`oauth_user_denied`). */
export class Cancelled extends Schema.TaggedError<Cancelled>()('Cancelled', fields) {
  override get message() {
    return describe(this);
  }
}

/** The Privy app doesn't allow this login method (`disallowed_login_method`). */
export class MethodDisabled extends Schema.TaggedError<MethodDisabled>()('MethodDisabled', fields) {
  override get message() {
    return describe(this);
  }
}

/** The Privy app's allowlist refused the account (`allowlist_rejected`). */
export class NotAllowed extends Schema.TaggedError<NotAllowed>()('NotAllowed', fields) {
  override get message() {
    return describe(this);
  }
}

/** Privy's request timed out (`client_request_timeout`). */
export class Unreachable extends Schema.TaggedError<Unreachable>()('Unreachable', fields) {
  override get message() {
    return describe(this);
  }
}

/** Privy refused for any other reason. */
export class Refused extends Schema.TaggedError<Refused>()('Refused', fields) {
  override get message() {
    return describe(this);
  }
}

/** Why a Privy sign-in step failed: one of the errors above. */
export const PrivyFailure = Schema.Union([WrongCode, CodeNotSent, TooManyTries, Cancelled, MethodDisabled, NotAllowed, Unreachable, Refused]);
export type PrivyFailure = typeof PrivyFailure.Type;

/** Privy's error code: its errors carry it as `privyErrorCode`; its `login` event's `onError` gets the code alone. */
const decodeCode = Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Struct({ privyErrorCode: Schema.String })]));
const privyCode = (cause: unknown): string | undefined =>
  Option.getOrUndefined(Option.map(decodeCode(cause), (code) => (typeof code === 'string' ? code : code.privyErrorCode)));

const isTooManyRequests = Schema.is(Schema.Struct({ status: Schema.Literal(429) }));

const BY_CODE: Readonly<Record<string, typeof Cancelled | typeof TooManyTries | typeof MethodDisabled | typeof NotAllowed | typeof Unreachable>> = {
  oauth_user_denied: Cancelled,
  too_many_requests: TooManyTries,
  disallowed_login_method: MethodDisabled,
  allowlist_rejected: NotAllowed,
  client_request_timeout: Unreachable,
};

/**
 * What a failed Privy sign-in step means, as one of the `PrivyFailure` errors (a pure function:
 * nothing is thrown or logged). `cause` is what the step's promise rejected with (a Privy error
 * with `privyErrorCode`, maybe `status`) or the code `onError` was given. Privy's code decides
 * first (`invalid_credentials` only for `loginWithCode`), then HTTP 429, then the step: `sendCode`
 * is `CodeNotSent`, the others `Refused`.
 */
export const privyFailure = (cause: unknown, step: PrivyStep): PrivyFailure => {
  const code = privyCode(cause);
  const props = { code, cause };
  if (code === 'invalid_credentials' && step === 'loginWithCode') return new WrongCode(props);
  const byCode = code === undefined ? undefined : BY_CODE[code];
  if (byCode) return new byCode(props);
  if (isTooManyRequests(cause)) return new TooManyTries(props);
  return step === 'sendCode' ? new CodeNotSent(props) : new Refused(props);
};

const isSignedOut = Schema.is(
  Schema.Union([
    Schema.Struct({ status: Schema.Literals([401, 403]) }),
    Schema.Struct({ privyErrorCode: Schema.Literals(['missing_or_invalid_token', 'must_be_authenticated']) }),
  ]),
);

/**
 * Whether a failed identity-token refresh (`getIdentityToken`) means the sign-in is over: Privy's
 * API answering 401 or 403, or naming the token invalid (`missing_or_invalid_token`,
 * `must_be_authenticated`). Anything else (no answer, a timeout, a 5xx) is Privy unreachable, and
 * the sign-in may well still hold.
 */
export const isSignedOutRefresh = (cause: unknown): boolean => isSignedOut(cause);
