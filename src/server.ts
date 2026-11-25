/**
 * `@misofm/privy-auth/server`: Privy identity tokens verified on a server, as Effects, with
 * WebCrypto and `fetch` only (Cloudflare Workers, Bun, Node 20+, browsers). No `@mysten/sui`, no
 * Privy SDK, no `effect/http`.
 *
 * A token is accepted when it is a compact JWS signed ES256 by Privy (`PrivyKeys`: the app's
 * verification key, or a key from its JWKS named by `kid`), issued by `privy.io` for `appId` (its
 * `aud`), not past `exp` (30 s of clock skew allowed), with a `sub` (Privy's user ID), and its
 * `linked_accounts` naming the account's Privy embedded Sui wallet (at a Sui address).
 */
import { Array as Arr, Clock, Context, Effect, Exit, Layer, Option, Ref, Schedule, Schema, Semaphore } from 'effect';

import { normalizeSuiAddress } from './address.js';
import { jwtPart, LinkedAccountsJson } from './token.js';

/** Who a verified identity token signs in. */
export type VerifiedIdentity = {
  /** Privy's user ID (`did:privy:…`), the token's `sub`. */
  readonly userId: string;
  /** The account's Privy embedded Sui wallet, normalized (`0x`, 64 lowercase hex digits). */
  readonly address: string;
  /**
   * The email Privy verified: the email login's, else the Google or Apple login's. Not who the
   * account is: two accounts can carry one address (an emailed code's, and Google's). Key an
   * account by `userId` or `address`.
   */
  readonly email: Option.Option<string>;
  /** When the token ends (`exp`), ms since the epoch. */
  readonly expiresAt: number;
};

/** Why a token isn't a sign-in. */
export const IdentityTokenProblem = Schema.Literals([
  /** Not a compact JWS of ES256 with the claims Privy's tokens carry. */
  'Malformed',
  'WrongIssuer',
  /** Made for another Privy app (another network's). */
  'WrongAudience',
  'Expired',
  /** Its `kid` is none of Privy's keys for the app. */
  'UnknownKey',
  'BadSignature',
  /** Genuine, but naming no Privy embedded Sui wallet (made before the wallet was). */
  'NoSuiWallet',
]);
export type IdentityTokenProblem = typeof IdentityTokenProblem.Type;

/** The token is not a sign-in to the app. */
export class InvalidIdentityToken extends Schema.TaggedError<InvalidIdentityToken>()('InvalidIdentityToken', {
  reason: IdentityTokenProblem,
}) {
  override get message() {
    return `Not a Privy identity token for this app: ${this.reason}`;
  }
}

/** Privy's signing keys couldn't be read (its JWKS unreachable or unreadable, a verification key that won't import): try again. */
export class PrivyKeysUnavailable extends Schema.TaggedError<PrivyKeysUnavailable>()('PrivyKeysUnavailable', {
  cause: Schema.Defect(),
}) {
  override get message() {
    return 'Privy’s signing keys could not be read';
  }
}

const PRIVY_ISSUER = 'privy.io';
/** Clock skew allowed on the token's `exp`. */
const SKEW_SECONDS = 30;
/** The shortest wait before the JWKS is fetched again for an unknown `kid`. */
const KEYS_REFETCH_MS = 60_000;
/** How long the JWKS may take in all: every try, and the waits between. */
const JWKS_TIMEOUT = '5 seconds';
/** How long one try at the JWKS may take. */
const JWKS_TRY_TIMEOUT = '2 seconds';
/** A try another may do better than is made again, twice at most: about 100 ms later, then 200 ms (jittered). */
const JWKS_RETRY = { schedule: Schedule.jittered(Schedule.exponential('100 millis')), times: 2, while: (failed: JwksTryFailed) => failed.again };
const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** One of Privy's keys in its JWKS (others, such as RSA keys, are skipped). */
const EcJwk = Schema.Struct({ kid: Schema.String, kty: Schema.Literal('EC'), crv: Schema.Literal('P-256'), x: Schema.String, y: Schema.String });
const decodeEcJwk = Schema.decodeUnknownOption(EcJwk);
const Jwks = Schema.Struct({ keys: Schema.Array(Schema.Unknown) });
const decodeJwks = Schema.decodeUnknownEffect(Jwks);

/**
 * How the JWKS is fetched: `fetch` itself, or a stand-in with its shape (tests, a fetch with the
 * caller's own instrumentation). The request is aborted through `signal` when it times out.
 */
export type Fetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** Options for `PrivyKeys.makeJwks` and `PrivyKeys.layerJwks`. */
export type JwksOptions = {
  /** How to fetch the JWKS; the global `fetch` by default. */
  readonly fetch?: Fetch;
};

const unavailable = (cause: unknown) => new PrivyKeysUnavailable({ cause });

/** One try at a URL failed. `again`: another may do better (no answer, a 5xx, a 429), unlike a refusal or a body that isn't JSON. */
class JwksTryFailed extends Schema.TaggedError<JwksTryFailed>()('JwksTryFailed', { cause: Schema.Defect(), again: Schema.Boolean }) {}
const tryFailed = (again: boolean) => (cause: unknown) => new JwksTryFailed({ cause, again });

/**
 * The JSON a URL answers with a 2xx, through `fetch`. A try that gets no answer in 2 s, a 5xx or a
 * 429 is made again (`JWKS_RETRY`); anything else (a refusal, not JSON), three failed tries, or
 * 5 s in all, is `PrivyKeysUnavailable`.
 */
const fetchJson = (fetch: Fetch, url: string) =>
  Effect.tryPromise({ try: (signal) => fetch(url, { signal }), catch: tryFailed(true) }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({ try: () => response.json() as Promise<unknown>, catch: tryFailed(false) })
        : Effect.fail(tryFailed(response.status >= 500 || response.status === 429)(new Error(`HTTP ${response.status}`))),
    ),
    Effect.timeoutOrElse({ duration: JWKS_TRY_TIMEOUT, orElse: () => Effect.fail(tryFailed(true)(new Error(`No answer in ${JWKS_TRY_TIMEOUT}`))) }),
    Effect.retry(JWKS_RETRY),
    Effect.mapError((failed) => unavailable(failed.cause)),
    Effect.timeoutOrElse({ duration: JWKS_TIMEOUT, orElse: () => Effect.fail(unavailable(new Error(`No answer in ${JWKS_TIMEOUT}`))) }),
  );

const importKey = (format: 'jwk' | 'spki', data: JsonWebKey | Uint8Array<ArrayBuffer>) =>
  Effect.tryPromise({
    try: () => (format === 'jwk' ? crypto.subtle.importKey('jwk', data as JsonWebKey, ECDSA_P256, false, ['verify']) : crypto.subtle.importKey('spki', data as Uint8Array<ArrayBuffer>, ECDSA_P256, false, ['verify'])),
    catch: unavailable,
  });

const decodePem = Schema.decodeUnknownEffect(Schema.Uint8ArrayFromBase64);

/** Imports Privy's verification key: PEM (SPKI, `-----BEGIN PUBLIC KEY-----`) or its bare base64. */
const importVerificationKey = Effect.fnUntraced(function* (pem: string) {
  const der = yield* decodePem(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '')).pipe(Effect.mapError(unavailable));
  return yield* importKey('spki', der as Uint8Array<ArrayBuffer>);
});

/** Privy's keys for verifying identity tokens. */
export class PrivyKeys extends Context.Service<
  PrivyKeys,
  {
    /** The key a token's `kid` names (`None` when there is no such key). Fails with: `PrivyKeysUnavailable`. */
    readonly get: (kid: Option.Option<string>) => Effect.Effect<Option.Option<CryptoKey>, PrivyKeysUnavailable>;
  }
>()('@misofm/privy-auth/server/PrivyKeys') {
  /**
   * The app's keys from its JWKS (`https://auth.privy.io/api/v1/apps/<appId>/jwks.json`, through
   * `options.fetch`, the global `fetch` by default), as the service itself: fetched on first use,
   * kept, and fetched again (at most once a minute by `Clock`) when a token names an unknown
   * `kid`. A fetch that gets no answer, a 5xx or a 429 is tried again twice, shortly after (5 s in
   * all, each try 2 s). The first fetch failing is not kept (the next call tries again), nor is a
   * JWKS with no key that can verify; a key that won't import is skipped. A later fetch failing
   * takes no key away: tokens of known keys still verify, and the token naming the unknown one
   * fails with `PrivyKeysUnavailable` (for that minute). Make it once per isolate and keep it, so
   * the keys are fetched once.
   */
  static readonly makeJwks = (appId: string, options: JwksOptions = {}): Effect.Effect<PrivyKeys['Service']> =>
    Effect.gen(function* () {
      const fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
      /** The keys last read (kept while a later fetch fails), and the last fetch for an unknown `kid`: when, and how it failed. */
      const kept = yield* Ref.make(Option.none<ReadonlyMap<string, CryptoKey>>());
      const asked = yield* Ref.make({ at: 0, failure: Option.none<PrivyKeysUnavailable>() });
      const refetching = yield* Semaphore.make(1);
      const fetchKeys = fetchJson(fetch, `https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`).pipe(
        Effect.flatMap((json) => decodeJwks(json).pipe(Effect.mapError(unavailable))),
        // A key that won't import is skipped, so one bad key doesn't take the others with it.
        Effect.flatMap(({ keys }) =>
          Effect.forEach(Arr.getSomes(keys.map((jwk) => decodeEcJwk(jwk))), ({ kid, kty, crv, x, y }) =>
            importKey('jwk', { kty, crv, x, y }).pipe(
              Effect.map((key) => [kid, key] as const),
              Effect.option,
            ),
          ),
        ),
        Effect.map((entries): ReadonlyMap<string, CryptoKey> => new Map(Arr.getSomes(entries))),
        // No key at all would turn every sign-in away as `UnknownKey`: that is Privy's keys unread, not the tokens' fault.
        Effect.filterOrFail(
          (keys) => keys.size > 0,
          () => unavailable(new Error('The JWKS has no key that can verify')),
        ),
        Effect.tap((keys) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.andThen(Ref.set(kept, Option.some(keys)), Ref.set(asked, { at: now, failure: Option.none() }))))),
        Effect.withSpan('PrivyKeys.fetchJwks'),
      );
      /** The first fetch, shared by every call made meanwhile; a failed one is made again by the next call. */
      const [first] = yield* Effect.cachedInvalidateWithTTL(fetchKeys, (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0));
      const keys = Ref.get(kept).pipe(Effect.flatMap(Option.match({ onNone: () => first, onSome: Effect.succeed })));
      /**
       * The keys fetched again for an unknown `kid`, at most once a minute (by this call or
       * another, whether or not it worked). The keys kept stay until others are read: a fetch that
       * fails takes nothing away, and fails only the token that asked.
       */
      const refetch = refetching.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const last = yield* Ref.get(asked);
          if (now - last.at <= KEYS_REFETCH_MS) return yield* Option.match(last.failure, { onNone: () => keys, onSome: Effect.fail });
          return yield* fetchKeys.pipe(Effect.tapError((failure) => Ref.set(asked, { at: now, failure: Option.some(failure) })));
        }),
      );
      const get = Effect.fn('PrivyKeys.get')(function* (kid: Option.Option<string>) {
        if (Option.isNone(kid)) return Option.none<CryptoKey>();
        const known = (yield* keys).get(kid.value);
        if (known) return Option.some(known);
        return Option.fromUndefinedOr((yield* refetch).get(kid.value));
      });
      return PrivyKeys.of({ get });
    });

  /** `makeJwks` as a layer: build it once per isolate (e.g. in the app's layer), so its cache lasts. */
  static readonly layerJwks = (appId: string, options: JwksOptions = {}): Layer.Layer<PrivyKeys> => Layer.effect(PrivyKeys, PrivyKeys.makeJwks(appId, options));

  /** One fixed, imported key (ECDSA P-256, `verify`) for every token, whatever its `kid`: the service itself, synchronously (tests, a key the app imported). */
  static readonly fromKey = (key: CryptoKey): PrivyKeys['Service'] => PrivyKeys.of({ get: () => Effect.succeed(Option.some(key)) });

  /**
   * One fixed key for every token, whatever its `kid`, as the service: the app's verification key
   * from Privy's dashboard (PEM SPKI, or its bare base64) or that key imported. Fails with
   * `PrivyKeysUnavailable` when the PEM doesn't import.
   */
  static readonly makeVerificationKey = (verificationKey: string | CryptoKey): Effect.Effect<PrivyKeys['Service'], PrivyKeysUnavailable> =>
    Effect.map(typeof verificationKey === 'string' ? importVerificationKey(verificationKey) : Effect.succeed(verificationKey), PrivyKeys.fromKey);

  /** `makeVerificationKey` as a layer; it fails with `PrivyKeysUnavailable` when the PEM doesn't import. */
  static readonly layerVerificationKey = (verificationKey: string | CryptoKey): Layer.Layer<PrivyKeys, PrivyKeysUnavailable> =>
    Layer.effect(PrivyKeys, PrivyKeys.makeVerificationKey(verificationKey));
}

const Header = Schema.Struct({ alg: Schema.Literal('ES256'), kid: Schema.optional(Schema.String) });
const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.NonEmptyString,
  exp: Schema.Finite,
  linked_accounts: Schema.optional(LinkedAccountsJson),
});
const decodeHeader = Schema.decodeUnknownEffect(jwtPart(Header));
const decodeClaims = Schema.decodeUnknownEffect(jwtPart(Claims));
const decodeSignature = Schema.decodeUnknownEffect(Schema.Uint8ArrayFromBase64Url);

/** A linked account in a token that is a Privy embedded Sui wallet (`wallet_client_type` absent, null or Privy's), its address one (hex, 32 bytes at most). */
const TokenSuiWallet = Schema.Struct({
  type: Schema.Literal('wallet'),
  chain_type: Schema.Literal('sui'),
  address: Schema.String.check(Schema.isPattern(/^(0x)?[0-9a-fA-F]{1,64}$/)),
  wallet_client_type: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isStartingWith('privy')))),
});
const VerifiedEmail = Schema.String.check(Schema.isIncluding('@'));
const EmailLogin = Schema.Struct({ type: Schema.Literal('email'), address: VerifiedEmail });
const OAuthLogin = Schema.Struct({ type: Schema.Literals(['google_oauth', 'apple_oauth']), email: VerifiedEmail });

const firstDecoded = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (accounts: ReadonlyArray<unknown>): Option.Option<S['Type']> => Arr.findFirst(accounts, (account) => decode(account));
};
const suiWalletOf = firstDecoded(TokenSuiWallet);
const emailLoginOf = firstDecoded(EmailLogin);
const oauthLoginOf = firstDecoded(OAuthLogin);

const invalid = (reason: IdentityTokenProblem) => new InvalidIdentityToken({ reason });
const malformed = () => invalid('Malformed');

/**
 * Verifies a Privy identity token for `appId` and answers who it signs in, the clock read from
 * `Clock`. Fails with: `InvalidIdentityToken` (its `reason`) when the token isn't a sign-in;
 * `PrivyKeysUnavailable` when Privy's keys couldn't be read (try again; not the token's fault).
 */
export const verifyIdentityToken = Effect.fn('verifyIdentityToken')(function* (
  token: string,
  options: { readonly appId: string },
): Effect.fn.Return<VerifiedIdentity, InvalidIdentityToken | PrivyKeysUnavailable, PrivyKeys> {
  const [headerPart, payloadPart, signaturePart, ...rest] = token.split('.');
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined || rest.length > 0) return yield* malformed();
  const header = yield* decodeHeader(headerPart).pipe(Effect.mapError(malformed));
  const claims = yield* decodeClaims(payloadPart).pipe(Effect.mapError(malformed));
  if (claims.iss !== PRIVY_ISSUER) return yield* invalid('WrongIssuer');
  if (claims.aud !== options.appId) return yield* invalid('WrongAudience');
  const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  if (claims.exp + SKEW_SECONDS <= nowSeconds) return yield* invalid('Expired');

  const key = yield* (yield* PrivyKeys).get(Option.fromUndefinedOr(header.kid));
  if (Option.isNone(key)) return yield* invalid('UnknownKey');
  const signature = yield* decodeSignature(signaturePart).pipe(Effect.mapError(malformed));
  const genuine = yield* Effect.tryPromise({
    try: () => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.value, signature as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`${headerPart}.${payloadPart}`)),
    catch: () => invalid('BadSignature'),
  });
  if (!genuine) return yield* invalid('BadSignature');

  const accounts = claims.linked_accounts ?? [];
  const wallet = suiWalletOf(accounts);
  if (Option.isNone(wallet)) return yield* invalid('NoSuiWallet');
  const email = Option.orElse(
    Option.map(emailLoginOf(accounts), (login) => login.address),
    () => Option.map(oauthLoginOf(accounts), (login) => login.email),
  );
  return { userId: claims.sub, address: normalizeSuiAddress(wallet.value.address), email, expiresAt: claims.exp * 1000 };
});

/**
 * Runs `effect` with `Clock`'s wall time read from `now` (ms since the epoch), for an app that
 * keeps its own clock function (`Date.now`, or a test's): `currentTimeMillis` and
 * `currentTimeNanos` come from `now`; `monotonicTimeNanos` and `sleep` stay the ambient
 * `Clock`'s. Effect builds a `Clock` from a plain object (it has no constructor); this is that.
 */
export const withWallTime =
  (now: () => number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Clock.clockWith((clock) => {
      const nanos = () => BigInt(now()) * 1_000_000n;
      return Effect.provideService(effect, Clock.Clock, {
        currentTimeMillisUnsafe: now,
        currentTimeMillis: Effect.sync(now),
        currentTimeNanosUnsafe: nanos,
        currentTimeNanos: Effect.sync(nanos),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
      });
    });
