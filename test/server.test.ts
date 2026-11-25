import { beforeAll, describe, expect, test } from 'bun:test';
import { Clock, Effect, Fiber, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';

import { type Fetch, InvalidIdentityToken, PrivyKeys, PrivyKeysUnavailable, verifyIdentityToken, withWallTime } from '../src/server.js';

const APP_ID = 'app-under-test';
const NOW = 1_800_000_000_000;
const address = `0x${'ab'.repeat(32)}`;
const wallet = { type: 'wallet', chain_type: 'sui', address, wallet_client_type: 'privy' };

let privy: CryptoKeyPair;
let other: CryptoKeyPair;
let pem: string;
let jwk: JsonWebKey;

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const generate = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

/** A token as Privy makes one, signed by `key` (Privy's by default). */
const token = async (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = privy.privateKey) => {
  const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k1', ...header }));
  const body = b64url(
    JSON.stringify({ iss: 'privy.io', aud: APP_ID, sub: 'did:privy:abc', exp: NOW / 1000 + 3600, linked_accounts: JSON.stringify([{ type: 'email', address: 'artist@example.com' }, wallet]), ...claims }),
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(signature)}`;
};

/** Keys answered from a map by `kid`. */
const keysLayer = (byKid: () => Record<string, CryptoKey>) => Layer.succeed(PrivyKeys, PrivyKeys.of({ get: (kid) => Effect.succeed(Option.flatMap(kid, (k) => Option.fromUndefinedOr(byKid()[k]))) }));

/** Runs `effect` at `NOW` on a `TestClock` with `layer`. */
const run = <A, E>(effect: Effect.Effect<A, E, PrivyKeys>, layer: Layer.Layer<PrivyKeys, unknown> = keysLayer(() => ({ k1: privy.publicKey }))) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* effect;
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())), Effect.result),
  );
const verify = async (jwt: string, layer?: Layer.Layer<PrivyKeys, unknown>) => {
  const result = await run(verifyIdentityToken(jwt, { appId: APP_ID }), layer);
  return result._tag === 'Success' ? result.success : result.failure;
};
const rejection = async (jwt: string) => {
  const outcome = await verify(jwt);
  return outcome instanceof InvalidIdentityToken ? outcome.reason : outcome;
};

beforeAll(async () => {
  privy = await generate();
  other = await generate();
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', privy.publicKey));
  pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString('base64').replace(/.{64}/g, '$&\n')}\n-----END PUBLIC KEY-----\n`;
  jwk = await crypto.subtle.exportKey('jwk', privy.publicKey);
});

describe('verifyIdentityToken', () => {
  test('a genuine token: the user, the Sui wallet (normalized), the verified email, the end', async () => {
    expect(await verify(await token())).toEqual({ userId: 'did:privy:abc', address, email: Option.some('artist@example.com'), expiresAt: NOW + 3_600_000 });
    const short = { ...wallet, address: '0xAB', wallet_client_type: null };
    expect(await verify(await token({ linked_accounts: JSON.stringify([short]) }))).toMatchObject({ address: `0x${'0'.repeat(62)}ab`, email: Option.none() });
  });

  test('the email: the email login’s, else Google’s or Apple’s; none without one', async () => {
    const accounts = (...list: object[]) => ({ linked_accounts: JSON.stringify([...list, wallet]) });
    expect(await verify(await token(accounts({ type: 'google_oauth', email: 'g@example.com' })))).toMatchObject({ email: Option.some('g@example.com') });
    expect(await verify(await token(accounts({ type: 'apple_oauth', email: 'a@example.com' })))).toMatchObject({ email: Option.some('a@example.com') });
    expect(await verify(await token(accounts({ type: 'email', address: 'not an email' })))).toMatchObject({ email: Option.none() });
  });

  test('a token for another app', async () => {
    expect(await rejection(await token({ aud: 'another-app' }))).toBe('WrongAudience');
  });

  test('an expired token, 30 s of skew allowed (the Clock’s time)', async () => {
    expect(await rejection(await token({ exp: NOW / 1000 - 30 }))).toBe('Expired');
    expect(await verify(await token({ exp: NOW / 1000 - 29 }))).toMatchObject({ address });
  });

  test('a token naming no Privy Sui wallet', async () => {
    expect(await rejection(await token({ linked_accounts: JSON.stringify([{ type: 'email', address: 'a@example.com' }]) }))).toBe('NoSuiWallet');
    expect(await rejection(await token({ linked_accounts: JSON.stringify([{ ...wallet, wallet_client_type: 'phantom' }]) }))).toBe('NoSuiWallet');
    expect(await rejection(await token({ linked_accounts: undefined }))).toBe('NoSuiWallet');
  });

  test('a bad signature: another key’s, tampered claims, a key WebCrypto won’t verify with', async () => {
    expect(await rejection(await token({}, {}, other.privateKey))).toBe('BadSignature');
    const [head, , signature] = (await token()).split('.');
    const forged = b64url(JSON.stringify({ iss: 'privy.io', aud: APP_ID, sub: 'did:privy:evil', exp: NOW / 1000 + 3600, linked_accounts: JSON.stringify([wallet]) }));
    expect(await rejection(`${head}.${forged}.${signature}`)).toBe('BadSignature');
    expect(await rejection(`${head}.${forged}.${b64url('short')}`)).toBe('BadSignature');
    expect(await rejection(`${head}.${forged}.@@@`)).toBe('Malformed');
    const outcome = await verify(await token(), keysLayer(() => ({ k1: privy.privateKey })));
    expect(outcome).toMatchObject({ _tag: 'InvalidIdentityToken', reason: 'BadSignature', message: 'Not a Privy identity token for this app: BadSignature' });
  });

  test('an unknown key, or none named', async () => {
    expect(await rejection(await token({}, { kid: 'k2' }))).toBe('UnknownKey');
    expect(await rejection(await token({}, { kid: undefined }))).toBe('UnknownKey');
  });

  test('another issuer', async () => {
    expect(await rejection(await token({ iss: 'evil.example' }))).toBe('WrongIssuer');
  });

  test('malformed tokens', async () => {
    const good = await token();
    const [head, body, signature] = good.split('.');
    expect(await rejection('')).toBe('Malformed');
    expect(await rejection(`${head}.${body}`)).toBe('Malformed');
    expect(await rejection(`${good}.extra`)).toBe('Malformed');
    expect(await rejection(`${b64url(JSON.stringify({ alg: 'HS256', kid: 'k1' }))}.${body}.${signature}`)).toBe('Malformed');
    expect(await rejection(`${b64url(JSON.stringify({ alg: 'ES256', kid: 7 }))}.${body}.${signature}`)).toBe('Malformed');
    expect(await rejection(`${b64url('not json')}.${body}.${signature}`)).toBe('Malformed');
    expect(await rejection(`${head}.${b64url('[]')}.${signature}`)).toBe('Malformed');
    expect(await rejection(await token({ sub: undefined }))).toBe('Malformed');
    expect(await rejection(await token({ exp: 'soon' }))).toBe('Malformed');
    expect(await rejection(await token({ linked_accounts: '[' }))).toBe('Malformed');
  });

  test('keys that can’t be read', async () => {
    const down = Layer.succeed(PrivyKeys, PrivyKeys.of({ get: () => Effect.fail(new PrivyKeysUnavailable({ cause: 'down' })) }));
    const outcome = await verify(await token(), down);
    expect(outcome).toBeInstanceOf(PrivyKeysUnavailable);
    expect((outcome as PrivyKeysUnavailable).message).toBe('Privy’s signing keys could not be read');
  });
});

describe('PrivyKeys.layerVerificationKey', () => {
  test('PEM, its bare base64, or an imported key, whatever the kid', async () => {
    const bare = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
    for (const key of [pem, bare, privy.publicKey]) {
      expect(await verify(await token({}, { kid: 'any' }), PrivyKeys.layerVerificationKey(key))).toMatchObject({ address });
      expect(await verify(await token({}, { kid: undefined }), PrivyKeys.layerVerificationKey(key))).toMatchObject({ address });
    }
    expect(await verify(await token({}, {}, other.privateKey), PrivyKeys.layerVerificationKey(pem))).toMatchObject({ reason: 'BadSignature' });
  });

  test('a key that won’t import fails the layer', async () => {
    expect(await verify(await token(), PrivyKeys.layerVerificationKey('not base64!'))).toBeInstanceOf(PrivyKeysUnavailable);
    expect(await verify(await token(), PrivyKeys.layerVerificationKey('AAAA'))).toBeInstanceOf(PrivyKeysUnavailable);
  });
});

describe('PrivyKeys.layerJwks', () => {
  /** A `fetch` answering `answer()` and recording each URL. */
  const fetchOf = (answer: () => Response | Promise<Response>) => {
    const asked: string[] = [];
    const fetch: Fetch = async (url) => {
      asked.push(url);
      return answer();
    };
    return { asked, fetch };
  };
  const keysOf = (answer: () => Response | Promise<Response>) => {
    const { asked, fetch } = fetchOf(answer);
    return { asked, layer: PrivyKeys.layerJwks('app/1', { fetch }) };
  };
  const has = (kid: string) =>
    Effect.gen(function* () {
      return Option.isSome(yield* (yield* PrivyKeys).get(Option.some(kid)));
    });

  test('verifies a token against the app’s JWKS', async () => {
    const { asked, layer } = keysOf(() => Response.json({ keys: [{ ...jwk, kid: 'k1' }] }));
    expect(await verify(await token(), layer)).toMatchObject({ address });
    expect(asked).toEqual(['https://auth.privy.io/api/v1/apps/app%2F1/jwks.json']);
  });

  test('fetched once; again for an unknown kid at most once a minute (TestClock); only P-256 EC keys', async () => {
    let served: object[] = [{ ...jwk, kid: 'k1' }, { kty: 'RSA', kid: 'rsa' }, { ...jwk }];
    const { asked, layer } = keysOf(() => Response.json({ keys: served }));
    const seen = await run(
      Effect.gen(function* () {
        const keys = yield* PrivyKeys;
        const results = [yield* has('k1'), yield* has('k1'), yield* has('rsa'), Option.isSome(yield* keys.get(Option.none()))];
        const fetchesBefore = asked.length;
        served = [{ ...jwk, kid: 'k2' }];
        yield* TestClock.adjust('30 seconds');
        const tooSoon = yield* has('k2');
        const fetchesSoon = asked.length;
        yield* TestClock.adjust('31 seconds');
        const later = yield* has('k2');
        return { results, fetchesBefore, tooSoon, fetchesSoon, later, fetchesLater: asked.length };
      }),
      layer,
    );
    expect(seen).toMatchObject({ success: { results: [true, true, false, false], fetchesBefore: 1, tooSoon: false, fetchesSoon: 1, later: true, fetchesLater: 2 } });
  });

  test('a failed fetch is PrivyKeysUnavailable, and tried again next time', async () => {
    let fail = true;
    const { asked, layer } = keysOf(() => (fail ? new Response('down', { status: 503 }) : Response.json({ keys: [{ ...jwk, kid: 'k1' }] })));
    const outcome = await run(
      Effect.gen(function* () {
        const first = yield* Effect.flip(has('k1'));
        fail = false;
        return { first: first._tag, then: yield* has('k1') };
      }),
      layer,
    );
    expect(outcome).toMatchObject({ success: { first: 'PrivyKeysUnavailable', then: true } });
    expect(asked.length).toBe(2);
  });

  test('a JWKS that isn’t one, a body that isn’t JSON, no answer, or a key that won’t import, is PrivyKeysUnavailable', async () => {
    const answers = [
      () => Response.json({}),
      () => Response.json({ keys: [{ ...jwk, kid: 'k1', x: 'AAAA' }] }),
      () => new Response('not json'),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ];
    for (const answer of answers) {
      const { layer } = keysOf(answer);
      expect(await run(Effect.flip(has('k1')), layer)).toMatchObject({ success: { _tag: 'PrivyKeysUnavailable' } });
    }
  });

  test('a JWKS that doesn’t answer in 5 s (TestClock) is PrivyKeysUnavailable, its request aborted', async () => {
    let aborted = false;
    const fetch: Fetch = (_, { signal }) =>
      new Promise(() => {
        signal.addEventListener('abort', () => (aborted = true));
      });
    const outcome = await run(
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(Effect.flip(has('k1')));
        yield* TestClock.adjust('5 seconds');
        return yield* Fiber.join(pending);
      }),
      PrivyKeys.layerJwks('app', { fetch }),
    );
    expect(outcome).toMatchObject({ success: { _tag: 'PrivyKeysUnavailable' } });
    expect(aborted).toBe(true);
  });

  test('the global fetch by default', async () => {
    const original = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return Response.json({ keys: [{ ...jwk, kid: 'k1' }] });
    }) as typeof fetch;
    try {
      expect(await verify(await token(), PrivyKeys.layerJwks('app'))).toMatchObject({ address });
      expect(asked).toEqual(['https://auth.privy.io/api/v1/apps/app/jwks.json']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('PrivyKeys as values', () => {
  test('makeJwks: the service itself, built with Effect (no Layer.build)', async () => {
    const fetch: Fetch = async () => Response.json({ keys: [{ ...jwk, kid: 'k1' }] });
    const keys = await Effect.runPromise(PrivyKeys.makeJwks('app', { fetch }));
    expect(await verify(await token(), Layer.succeed(PrivyKeys, keys))).toMatchObject({ address });
  });

  test('fromKey: a fixed key, synchronously, whatever the kid', async () => {
    const keys = PrivyKeys.fromKey(privy.publicKey);
    expect(await verify(await token({}, { kid: 'any' }), Layer.succeed(PrivyKeys, keys))).toMatchObject({ address });
  });

  test('makeVerificationKey: a PEM imported, or PrivyKeysUnavailable', async () => {
    const keys = await Effect.runPromise(PrivyKeys.makeVerificationKey(pem));
    expect(await verify(await token(), Layer.succeed(PrivyKeys, keys))).toMatchObject({ address });
    expect(await Effect.runPromise(Effect.flip(PrivyKeys.makeVerificationKey('AAAA')))).toBeInstanceOf(PrivyKeysUnavailable);
  });
});

describe('withWallTime', () => {
  test('Clock’s wall time from a function; monotonic time and sleep stay the ambient Clock’s', async () => {
    let now = NOW;
    const read = Effect.gen(function* () {
      const before = yield* Clock.currentTimeMillis;
      now += 1000;
      const clock = yield* Clock.Clock;
      const wall = [before, yield* Clock.currentTimeMillis, clock.currentTimeMillisUnsafe(), yield* Clock.currentTimeNanos, clock.currentTimeNanosUnsafe()];
      const monotonic = [typeof (yield* clock.monotonicTimeNanos), typeof clock.monotonicTimeNanosUnsafe()];
      return { wall, monotonic };
    }).pipe(withWallTime(() => now));
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* read;
        // A sleep under it waits on the ambient (test) clock.
        const slept = yield* Effect.forkChild(Effect.sleep('1 second').pipe(withWallTime(() => now)));
        yield* TestClock.adjust('1 second');
        yield* Fiber.join(slept);
        return result;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(seen).toEqual({ wall: [NOW, NOW + 1000, NOW + 1000, BigInt(NOW + 1000) * 1_000_000n, BigInt(NOW + 1000) * 1_000_000n], monotonic: ['bigint', 'bigint'] });
    // verifyIdentityToken reads it: a token past its end by the app's clock.
    const late = await Effect.runPromise(
      verifyIdentityToken(await token(), { appId: APP_ID }).pipe(Effect.provideService(PrivyKeys, PrivyKeys.fromKey(privy.publicKey)), withWallTime(() => NOW + 7_200_000), Effect.flip),
    );
    expect(late).toMatchObject({ reason: 'Expired' });
  });
});
