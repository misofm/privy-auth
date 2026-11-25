import { describe, expect, test } from 'bun:test';
import { Option } from 'effect';

import { jwtEnd, namesWallet } from '../src/index.js';
import { unsignedJwt } from './support.js';

const address = `0x${'cd'.repeat(32)}`;

describe('identity token, unverified', () => {
  test('its end', () => {
    expect(jwtEnd(unsignedJwt({ exp: 1_800_000_000 }))).toEqual(Option.some(1_800_000_000_000));
    expect(jwtEnd(unsignedJwt({ exp: '1800000000' }))).toEqual(Option.none());
    expect(jwtEnd(unsignedJwt({}))).toEqual(Option.none());
    expect(jwtEnd(unsignedJwt([1]))).toEqual(Option.none());
    expect(jwtEnd('nope')).toEqual(Option.none());
    expect(jwtEnd('a.!!!.c')).toEqual(Option.none());
  });

  test('whether it names the Sui wallet, the address compared normalized', () => {
    const token = unsignedJwt({ exp: 1, linked_accounts: JSON.stringify([{ type: 'email' }, { type: 'wallet', chain_type: 'sui', address }]) });
    expect(namesWallet(token, address)).toBe(true);
    expect(namesWallet(token, address.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(namesWallet(unsignedJwt({ linked_accounts: JSON.stringify([{ chain_type: 'sui', address: '0x1' }]) }), `0x${'0'.repeat(63)}1`)).toBe(true);
    expect(namesWallet(token, `0x${'ef'.repeat(32)}`)).toBe(false);
  });

  test('a token naming no wallet, or whose linked accounts are unreadable', () => {
    expect(namesWallet(unsignedJwt({ exp: 1 }), address)).toBe(false);
    expect(namesWallet(unsignedJwt({ linked_accounts: JSON.stringify([{ chain_type: 'ethereum', address }]) }), address)).toBe(false);
    expect(namesWallet(unsignedJwt({ linked_accounts: JSON.stringify([{ chain_type: 'sui', address: 7 }]) }), address)).toBe(false);
    expect(namesWallet(unsignedJwt({ linked_accounts: JSON.stringify({ chain_type: 'sui', address }) }), address)).toBe(false);
    expect(namesWallet(unsignedJwt({ linked_accounts: '[' }), address)).toBe(false);
    expect(namesWallet('nope', address)).toBe(false);
  });
});
