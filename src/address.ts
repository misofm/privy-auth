/**
 * A Sui address as the chain reads it (lowercase, `0x`, padded to 64 hex digits), written here so
 * the core never loads `@mysten/sui` (its BCS, BLAKE2 and base58 stay out of an app's entry).
 * The same result as `@mysten/sui/utils`' `normalizeSuiAddress`.
 */
export const normalizeSuiAddress = (value: string): string => {
  const address = value.toLowerCase();
  return `0x${(address.startsWith('0x') ? address.slice(2) : address).padStart(64, '0')}`;
};
