import { Array as Arr, Option, Schema } from 'effect';

import { normalizeSuiAddress } from './address.js';

/** An identity token's `linked_accounts`: a JSON string of an array in Privy's tokens. */
export const LinkedAccountsJson = Schema.fromJsonString(Schema.Array(Schema.Unknown));

/** A JWT part (base64url of JSON) decoded with `schema`. */
export const jwtPart = <S extends Schema.Top>(schema: S) => Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(schema)));

/** The claims of a JWT (its middle part) decoded with `schema`, unverified. */
const claims = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
  const decode = Schema.decodeUnknownOption(jwtPart(schema));
  return (jwt: string): Option.Option<S['Type']> => decode(jwt.split('.')[1]);
};

const endOf = claims(Schema.Struct({ exp: Schema.Finite }));

/** When a JWT ends (`exp`, as ms since the epoch); `None` when it doesn't say or isn't a JWT. Unverified. */
export const jwtEnd = (jwt: string): Option.Option<number> => Option.map(endOf(jwt), ({ exp }) => exp * 1000);

const linkedOf = claims(Schema.Struct({ linked_accounts: LinkedAccountsJson }));
const TokenSuiWallet = Schema.Struct({ chain_type: Schema.Literal('sui'), address: Schema.String });
const decodeTokenSuiWallet = Schema.decodeUnknownOption(TokenSuiWallet);

/**
 * Whether Privy's identity token names the Sui wallet at `address` among its `linked_accounts`
 * (the API reads the account's address there, so a token made before the wallet is of no use).
 * Unverified.
 */
export const namesWallet = (identityToken: string, address: string): boolean => {
  const wanted = normalizeSuiAddress(address);
  return Option.match(linkedOf(identityToken), {
    onNone: () => false,
    onSome: ({ linked_accounts }) =>
      Arr.some(linked_accounts, (account) => Option.exists(decodeTokenSuiWallet(account), (wallet) => normalizeSuiAddress(wallet.address) === wanted)),
  });
};
