import type { PrivyClientConfig } from '@privy-io/react-auth';

type Appearance = NonNullable<PrivyClientConfig['appearance']>;

/** What an app sets of `privyConfig`: Privy's theme (`light`, `dark` or a hex colour) and accent. */
export type PrivyConfigOptions = {
  readonly theme?: Appearance['theme'];
  readonly accentColor?: Appearance['accentColor'];
};

/**
 * `PrivyProvider`'s `config` for a Miso app: email, Google or Apple only, on the app's own screen
 * (no wallet list, wallet login never first); no external wallets (Privy starts no WalletConnect,
 * Base or Coinbase); no automatic Ethereum or Solana wallets (the app makes the Sui wallet); no
 * wallet UIs, so nothing of Privy's shows when it signs. The theme only matters for anything of
 * Privy's that might still draw.
 */
export const privyConfig = ({ theme, accentColor }: PrivyConfigOptions = {}): PrivyClientConfig => ({
  loginMethods: ['email', 'google', 'apple'],
  appearance: {
    ...(theme === undefined ? {} : { theme }),
    ...(accentColor === undefined ? {} : { accentColor }),
    showWalletLoginFirst: false,
    walletList: [],
  },
  externalWallets: { walletConnect: { enabled: false }, disableAllExternalWallets: true },
  embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' }, showWalletUIs: false },
});
