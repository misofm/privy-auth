/**
 * `@misofm/privy-auth/signer`: the account's Privy embedded Sui wallet as a `@mysten/sui`
 * `Signer`. Its own entry because it loads `@mysten/sui` (Ed25519, BLAKE2b, base58): an app
 * imports it lazily, when the wallet first signs or its key is first checked.
 *
 * Privy supports Sui as a "tier 2" chain: it makes the Ed25519 key and signs a raw 32-byte hash
 * with it (`useSignRawHash`), nothing more. `PrivySigner.sign` hands that hash to Privy; the SDK
 * builds the intent digest and the serialized signature exactly as for a local keypair.
 */
import { type SignatureScheme, Signer } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { fromBase58, fromHex, normalizeSuiAddress, toHex } from '@mysten/sui/utils';
import { Option, Result, Schema } from 'effect';

import { findSuiWallet, walletFields } from './account.js';

/** The account's Sui wallet, its public key checked against its address. */
export type SuiWallet = {
  /** The wallet's address, normalized (`0x`, 64 lowercase hex digits). */
  readonly address: string;
  readonly publicKey: Ed25519PublicKey;
};

/**
 * The account has a Privy Sui wallet it can't sign with. `reason`: `NoAddress`, `NoPublicKey`,
 * `UnreadablePublicKey` (not one of Privy's encodings), `NotTheAddressKey` (a key, but not the
 * address's).
 */
export class InvalidSuiWallet extends Schema.TaggedError<InvalidSuiWallet>()('InvalidSuiWallet', {
  reason: Schema.Literals(['NoAddress', 'NoPublicKey', 'UnreadablePublicKey', 'NotTheAddressKey']),
}) {
  override get message() {
    return `The account's Sui wallet can't sign: ${this.reason}`;
  }
}

/** Privy's wallet answered something other than a 64-byte Ed25519 signature (thrown by `PrivySigner.sign`). */
export class InvalidSignature extends Schema.TaggedError<InvalidSignature>()('InvalidSignature', {
  length: Schema.Number,
}) {
  override get message() {
    return `Privy answered no Ed25519 signature (${this.length} bytes)`;
  }
}

/** Signs a 32-byte digest, hex in and out (`0x…`): Privy's `signRawHash` for the wallet. */
export type SignHash = (hash: `0x${string}`) => Promise<`0x${string}`>;

const ED25519_FLAG = '00';

/**
 * A tier-2 wallet's Ed25519 public key as Privy encodes it: hex (with or without `0x`, the
 * 32-byte key, or 33 bytes led by Sui's Ed25519 flag `00`), or base58 of the 32-byte key. The two
 * can't be confused: hex keys are 64 or 66 characters, base58 ones 43 or 44 and never contain
 * `0`. Anything else is `None`.
 */
export const walletPublicKey = (encoded: string): Option.Option<Ed25519PublicKey> => {
  const hex = encoded.replace(/^0x/i, '');
  if (/^[0-9a-f]{64}$/i.test(hex)) return Option.some(new Ed25519PublicKey(fromHex(hex)));
  if (/^[0-9a-f]{66}$/i.test(hex) && hex.startsWith(ED25519_FLAG)) return Option.some(new Ed25519PublicKey(fromHex(hex.slice(2))));
  return Option.flatMap(
    Option.liftThrowable(fromBase58)(encoded),
    Option.liftPredicate((bytes) => bytes.length === 32),
  ).pipe(Option.map((bytes) => new Ed25519PublicKey(bytes)));
};

/**
 * The account's Privy embedded Sui wallet among `linkedAccounts` (Privy's `user.linkedAccounts`;
 * the same wallet `suiWalletAccount` finds), its public key decoded and checked against its
 * address. Succeeds with `None` when the account has no Privy Sui wallet, `Some` when it has one
 * that can sign; fails with `InvalidSuiWallet` when it has one that can't. A `Result`, so it reads
 * synchronously in render; in an Effect, `yield* Effect.fromResult(suiWallet(accounts))`.
 */
export const suiWallet = (linkedAccounts: ReadonlyArray<unknown>): Result.Result<Option.Option<SuiWallet>, InvalidSuiWallet> => {
  const found = findSuiWallet(linkedAccounts);
  if (Option.isNone(found)) return Result.succeed(Option.none());
  const fields = walletFields(found.value);
  if (Option.isNone(fields)) return Result.fail(new InvalidSuiWallet({ reason: 'NoAddress' }));
  const { address, publicKey: encoded } = fields.value;
  if (Option.isNone(encoded)) return Result.fail(new InvalidSuiWallet({ reason: 'NoPublicKey' }));
  const publicKey = walletPublicKey(encoded.value);
  if (Option.isNone(publicKey)) return Result.fail(new InvalidSuiWallet({ reason: 'UnreadablePublicKey' }));
  const keyAddress = publicKey.value.toSuiAddress();
  if (keyAddress !== normalizeSuiAddress(address)) return Result.fail(new InvalidSuiWallet({ reason: 'NotTheAddressKey' }));
  return Result.succeed(Option.some({ address: keyAddress, publicKey: publicKey.value }));
};

/**
 * The wallet as a Sui `Signer` (the SDK calls it with Promises): `signTransaction` and
 * `signPersonalMessage` work unchanged. `PrivySigner.of(wallet, signHash)` makes one from
 * `suiWallet`'s answer.
 */
export class PrivySigner extends Signer {
  readonly #publicKey: Ed25519PublicKey;
  readonly #signHash: SignHash;

  constructor(publicKey: Ed25519PublicKey, signHash: SignHash) {
    super();
    this.#publicKey = publicKey;
    this.#signHash = signHash;
  }

  /** The signer of a wallet `suiWallet` found. */
  static of(wallet: SuiWallet, signHash: SignHash): PrivySigner {
    return new PrivySigner(wallet.publicKey, signHash);
  }

  /** Ed25519 over `digest` by Privy's wallet; anything but 64 bytes back rejects with `InvalidSignature`. */
  async sign(digest: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const signature = fromHex((await this.#signHash(`0x${toHex(digest)}`)).replace(/^0x/i, ''));
    if (signature.length !== 64) throw new InvalidSignature({ length: signature.length });
    return new Uint8Array(signature);
  }

  getKeyScheme(): SignatureScheme {
    return 'ED25519';
  }

  getPublicKey(): Ed25519PublicKey {
    return this.#publicKey;
  }
}
