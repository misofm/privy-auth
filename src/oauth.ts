/**
 * The search parameters Privy's OAuth return carries (Google's or Apple's sign-in sends the page
 * back with them): Privy finishes the sign-in from them once it has loaded (its
 * `useLoginWithOAuth` hook mounted), then removes them. A router that drops unknown search
 * parameters must keep these.
 */
export const PRIVY_OAUTH_PARAMS = ['privy_oauth_state', 'privy_oauth_code', 'privy_oauth_provider'] as const;

/**
 * Whether `url` (a URL, an href, or a search string) is an OAuth return Privy has yet to finish:
 * every one of `PRIVY_OAUTH_PARAMS` present. Loads nothing, so a first screen can show it is busy
 * before Privy's SDK arrives.
 */
export const oauthReturnPending = (url: string | URL): boolean => {
  try {
    const params = new URL(url, 'https://privy-auth.invalid').searchParams;
    return PRIVY_OAUTH_PARAMS.every((name) => params.has(name));
  } catch {
    // Not a URL: nothing to finish.
    return false;
  }
};

/** The OAuth providers Miso's apps sign in with: Google and Apple. */
export type OAuthProvider = 'google' | 'apple';
