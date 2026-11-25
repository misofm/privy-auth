import { describe, expect, test } from 'bun:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex, toBase58, toHex } from '@mysten/sui/utils';
import { verifyPersonalMessageSignature, verifyTransactionSignature } from '@mysten/sui/verify';
import { Effect, Option, Result } from 'effect';

import { InvalidSignature, InvalidSuiWallet, PrivySigner, type SignHash, suiWallet, walletPublicKey } from '../src/signer.js';

const keypair = Ed25519Keypair.generate();
const address = keypair.toSuiAddress();
const raw = keypair.getPublicKey().toRawBytes();

/** Privy's `signRawHash` for the wallet: Ed25519 over the 32-byte hash it is given, hex both ways. */
const hashes: string[] = [];
const signRawHash: SignHash = async (hash) => {
  hashes.push(hash);
  return `0x${toHex(await keypair.sign(fromHex(hash)))}`;
};

describe('walletPublicKey', () => {
  test('Privy’s encodings: hex of 32 bytes (with or without 0x), 33 led by the flag 00, base58', () => {
    for (const encoded of [toHex(raw), `0x${toHex(raw)}`, `0X${toHex(raw).toUpperCase()}`, `00${toHex(raw)}`, `0x00${toHex(raw)}`, toBase58(raw)]) {
      expect(Option.map(walletPublicKey(encoded), (key) => key.toSuiAddress())).toEqual(Option.some(address));
    }
  });

  test('anything else', () => {
    expect(walletPublicKey('ab'.repeat(31))).toEqual(Option.none());
    expect(walletPublicKey(`01${toHex(raw)}`)).toEqual(Option.none());
    expect(walletPublicKey(toBase58(new Uint8Array(33)))).toEqual(Option.none());
    expect(walletPublicKey('')).toEqual(Option.none());
  });
});

describe('suiWallet', () => {
  const wallet = (fields: object) => suiWallet([{ type: 'email' }, { type: 'wallet', chainType: 'ethereum', address: '0x1' }, { type: 'wallet', chainType: 'sui', ...fields }]);
  const reason = (result: ReturnType<typeof suiWallet>) => (Result.isFailure(result) ? result.failure.reason : 'succeeded');

  test('the wallet, its key checked against its address, the address normalized', () => {
    const found = wallet({ address, publicKey: toBase58(raw), walletClientType: 'privy' });
    expect(Result.isSuccess(found) && Option.isSome(found.success) && found.success.value.address).toBe(address);
    expect(Result.isSuccess(found) && Option.isSome(found.success) && found.success.value.publicKey.toSuiAddress()).toBe(address);
    const upper = wallet({ address: address.toUpperCase().replace('0X', '0x'), publicKey: toHex(raw) });
    expect(Result.getOrUndefined(upper)).toEqual(Option.some({ address, publicKey: expect.anything() }));
  });

  test('InvalidSuiWallet: a key that isn’t the address’s, an unreadable key, no key, no address', () => {
    expect(reason(wallet({ address: Ed25519Keypair.generate().toSuiAddress(), publicKey: toHex(raw) }))).toBe('NotTheAddressKey');
    expect(reason(wallet({ address, publicKey: '' }))).toBe('UnreadablePublicKey');
    expect(reason(wallet({ address }))).toBe('NoPublicKey');
    expect(reason(wallet({ publicKey: toHex(raw) }))).toBe('NoAddress');
    const failed = wallet({ address });
    expect(Result.isFailure(failed) && failed.failure).toBeInstanceOf(InvalidSuiWallet);
    expect(Result.isFailure(failed) && failed.failure.message).toBe("The account's Sui wallet can't sign: NoPublicKey");
  });

  test('None: no Privy Sui wallet', () => {
    expect(suiWallet([{ type: 'email' }])).toEqual(Result.succeed(Option.none()));
    expect(wallet({ address, publicKey: toHex(raw), walletClientType: 'slush' })).toEqual(Result.succeed(Option.none()));
  });

  test('as an Effect (Effect.fromResult): the wallet, or InvalidSuiWallet in the error channel', async () => {
    const program = (accounts: ReadonlyArray<unknown>) => Effect.gen(function* () {
      return Option.map(yield* Effect.fromResult(suiWallet(accounts)), (found) => found.address);
    });
    expect(await Effect.runPromise(program([{ type: 'wallet', chainType: 'sui', address, publicKey: toHex(raw) }]))).toEqual(Option.some(address));
    const error = await Effect.runPromise(Effect.flip(program([{ type: 'wallet', chainType: 'sui', address }])));
    expect(error).toMatchObject({ _tag: 'InvalidSuiWallet', reason: 'NoPublicKey' });
  });
});

describe('PrivySigner', () => {
  test('personal messages and transactions sign as the wallet’s address (Ed25519 over the digest)', async () => {
    const found = Result.getOrUndefined(suiWallet([{ type: 'wallet', chainType: 'sui', address, publicKey: toBase58(raw) }]));
    const signer = PrivySigner.of(Option.getOrThrow(found!), signRawHash);
    expect(signer.toSuiAddress()).toBe(address);
    expect(signer.getKeyScheme()).toBe('ED25519');

    const message = new TextEncoder().encode('Sign in to Miso');
    const { signature } = await signer.signPersonalMessage(message);
    expect((await verifyPersonalMessageSignature(message, signature, { address })).toSuiAddress()).toBe(address);
    expect(signature).toBe((await keypair.signPersonalMessage(message)).signature);
    // Serialized as Ed25519's: flag 0x00, the 64-byte signature, the 32-byte key.
    expect(Buffer.from(signature, 'base64')[0]).toBe(0);
    expect(Buffer.from(signature, 'base64').length).toBe(97);
    // The digest went to Privy as 32 bytes of 0x-hex.
    expect(hashes.at(-1)).toMatch(/^0x[0-9a-f]{64}$/);

    const bytes = crypto.getRandomValues(new Uint8Array(96));
    const signed = await new PrivySigner(keypair.getPublicKey(), signRawHash).signTransaction(bytes);
    expect((await verifyTransactionSignature(bytes, signed.signature, { address })).toSuiAddress()).toBe(address);
    expect(signed.signature).toBe((await keypair.signTransaction(bytes)).signature);
  });

  test('a signature that isn’t 64 bytes rejects with InvalidSignature', async () => {
    const signer = new PrivySigner(keypair.getPublicKey(), async () => '0xabcd');
    const error = await signer.signPersonalMessage(new Uint8Array([1])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidSignature);
    expect(error).toMatchObject({ _tag: 'InvalidSignature', length: 2, message: 'Privy answered no Ed25519 signature (2 bytes)' });
  });
});
