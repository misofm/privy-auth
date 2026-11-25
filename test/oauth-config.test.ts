import { describe, expect, test } from 'bun:test';

import { oauthReturnPending, PRIVY_OAUTH_PARAMS, privyConfig } from '../src/index.js';

describe('oauthReturnPending', () => {
  const back = '?privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=google';

  test('every Privy OAuth parameter present, in an href, a URL or a search string', () => {
    expect(PRIVY_OAUTH_PARAMS).toEqual(['privy_oauth_state', 'privy_oauth_code', 'privy_oauth_provider']);
    expect(oauthReturnPending(`https://studio.miso.fm/login${back}&redirect=%2F`)).toBe(true);
    expect(oauthReturnPending(new URL(`https://app.miso.fm/login${back}`))).toBe(true);
    expect(oauthReturnPending(back)).toBe(true);
  });

  test('one missing, or none', () => {
    expect(oauthReturnPending('?privy_oauth_code=c&privy_oauth_state=s')).toBe(false);
    expect(oauthReturnPending('https://app.miso.fm/login?redirect=%2Fdiscover')).toBe(false);
    expect(oauthReturnPending('')).toBe(false);
    expect(oauthReturnPending('http://[')).toBe(false);
  });
});

describe('privyConfig', () => {
  test('email, Google or Apple; no wallets of Privy’s own, no wallet UIs', () => {
    expect(privyConfig()).toEqual({
      loginMethods: ['email', 'google', 'apple'],
      appearance: { showWalletLoginFirst: false, walletList: [] },
      externalWallets: { walletConnect: { enabled: false }, disableAllExternalWallets: true },
      embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' }, showWalletUIs: false },
    });
  });

  test('the app’s theme and accent', () => {
    expect(privyConfig({ theme: 'dark' }).appearance).toEqual({ theme: 'dark', showWalletLoginFirst: false, walletList: [] });
    expect(privyConfig({ theme: '#0b0b0a', accentColor: '#ff5500' }).appearance).toEqual({ theme: '#0b0b0a', accentColor: '#ff5500', showWalletLoginFirst: false, walletList: [] });
  });
});
