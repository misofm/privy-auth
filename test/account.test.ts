import { describe, expect, test } from 'bun:test';
import { Option } from 'effect';

import { emailOf, suiWalletAccount } from '../src/index.js';

const address = `0x${'ab'.repeat(32)}`;

describe('suiWalletAccount', () => {
  test('the Privy embedded Sui wallet, its key left encoded', () => {
    const accounts = [
      { type: 'email', address: 'a@example.com' },
      { type: 'wallet', chainType: 'ethereum', address: '0x1', walletClientType: 'privy' },
      { type: 'wallet', chainType: 'sui', address, publicKey: 'key', walletClientType: 'privy' },
    ];
    expect(suiWalletAccount(accounts)).toEqual(Option.some({ address, publicKey: Option.some('key') }));
    expect(suiWalletAccount([{ type: 'wallet', chainType: 'sui', address }])).toEqual(Option.some({ address, publicKey: Option.none() }));
  });

  test('none: no Sui wallet, one that isn’t Privy’s, or one without an address', () => {
    expect(suiWalletAccount([{ type: 'email' }, null, 'wallet'])).toEqual(Option.none());
    expect(suiWalletAccount([{ type: 'wallet', chainType: 'sui', address, walletClientType: 'phantom' }])).toEqual(Option.none());
    expect(suiWalletAccount([{ type: 'wallet', chainType: 'sui' }])).toEqual(Option.none());
  });

  test('a Privy wallet is taken over an external one listed before it', () => {
    const accounts = [
      { type: 'wallet', chainType: 'sui', address: '0x1', walletClientType: 'slush' },
      { type: 'wallet', chainType: 'sui', address, walletClientType: 'privy-v2' },
    ];
    expect(Option.map(suiWalletAccount(accounts), (wallet) => wallet.address)).toEqual(Option.some(address));
  });
});

describe('emailOf', () => {
  test('the email login’s, else Google’s, else Apple’s', () => {
    expect(emailOf({ email: { address: 'e@example.com' }, google: { email: 'g@example.com' } } as never)).toEqual(Option.some('e@example.com'));
    expect(emailOf({ google: { email: 'g@example.com' }, apple: { email: 'a@example.com' } } as never)).toEqual(Option.some('g@example.com'));
    expect(emailOf({ apple: { email: 'a@example.com' } } as never)).toEqual(Option.some('a@example.com'));
    expect(emailOf({ google: { email: null } } as never)).toEqual(Option.none());
    expect(emailOf({} as never)).toEqual(Option.none());
  });
});
