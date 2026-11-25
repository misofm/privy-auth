import type { User } from '@privy-io/react-auth';
import { Array as Arr, Option, Schema } from 'effect';

/**
 * A linked account that is a Privy embedded Sui wallet: `type` `wallet`, `chainType` `sui`, a
 * `walletClientType` that is Privy's (`privy…`) or absent.
 */
const PrivySuiWallet = Schema.Struct({
  type: Schema.Literal('wallet'),
  chainType: Schema.Literal('sui'),
  walletClientType: Schema.optional(Schema.String.check(Schema.isStartingWith('privy'))),
});

/** What is read of the wallet: its address and its encoded public key. */
const WalletFields = Schema.Struct({ address: Schema.String, publicKey: Schema.optional(Schema.String) });

/** The account's Privy embedded Sui wallet, as Privy lists it (its public key still encoded). */
export type SuiWalletAccount = {
  /** The wallet's Sui address, as Privy gives it. */
  readonly address: string;
  /** The wallet's Ed25519 public key as Privy encodes it (hex or base58); see `walletPublicKey`. */
  readonly publicKey: Option.Option<string>;
};

/** The first Privy embedded Sui wallet among `linkedAccounts`, undecoded (the signer's `suiWallet` reads it too). */
const isPrivySuiWallet = Schema.is(PrivySuiWallet);
export const findSuiWallet = (linkedAccounts: ReadonlyArray<unknown>): Option.Option<unknown> => Arr.findFirst(linkedAccounts, (account) => isPrivySuiWallet(account));

/** The wallet's address and encoded key, if it has an address. */
const decodeWalletFields = Schema.decodeUnknownOption(WalletFields);
export const walletFields = (wallet: unknown): Option.Option<SuiWalletAccount> =>
  Option.map(decodeWalletFields(wallet), ({ address, publicKey }) => ({ address, publicKey: Option.fromUndefinedOr(publicKey) }));

/**
 * The account's Privy embedded Sui wallet among `linkedAccounts` (Privy's `user.linkedAccounts`),
 * its public key not decoded: what an app needs at boot (the address) without loading
 * `@mysten/sui`. `None` when it has none (or it names no address). To sign, or to check the key
 * against the address, use `suiWallet` from `@misofm/privy-auth/signer`.
 */
export const suiWalletAccount = (linkedAccounts: ReadonlyArray<unknown>): Option.Option<SuiWalletAccount> =>
  Option.flatMap(findSuiWallet(linkedAccounts), walletFields);

/** What `emailOf` reads of a Privy user. */
export type UserEmails = Pick<User, 'email' | 'google' | 'apple'>;

/** The email Privy verified for `user`: its email login's, else its Google or Apple login's. */
export const emailOf = (user: UserEmails): Option.Option<string> =>
  Option.fromNullishOr(user.email?.address ?? user.google?.email ?? user.apple?.email);
