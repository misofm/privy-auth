import type { ReactNode } from 'react';

/** Miso's Terms of Use. */
export const TERMS_OF_USE_URL = 'https://miso.fm/terms-of-use/';
/** Miso's Privacy Policy. */
export const PRIVACY_POLICY_URL = 'https://miso.fm/privacy-policy/';

/** The consent line's words, around its two links. */
export type ConsentCopy = { readonly agree: ReactNode; readonly terms: ReactNode; readonly acknowledge: ReactNode; readonly privacy: ReactNode };

const COPY: ConsentCopy = { agree: 'By signing in, you agree to our', terms: 'Terms of Use', acknowledge: 'and acknowledge our', privacy: 'Privacy Policy' };

/**
 * The standard consent line under a sign-in: agree to the Terms of Use, acknowledge the Privacy
 * Policy (a notice, not a contract), each a link to miso.fm in a new tab. Unstyled: `className`
 * for the paragraph, `classNames.link` for both links.
 */
export function ConsentLine({ className, classNames, copy }: { readonly className?: string | undefined; readonly classNames?: { readonly link?: string | undefined } | undefined; readonly copy?: Partial<ConsentCopy> | undefined }) {
  const words = { ...COPY, ...copy };
  return (
    <p className={className}>
      {words.agree}{' '}
      <a href={TERMS_OF_USE_URL} target="_blank" rel="noopener noreferrer" className={classNames?.link}>
        {words.terms}
      </a>{' '}
      {words.acknowledge}{' '}
      <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className={classNames?.link}>
        {words.privacy}
      </a>
      .
    </p>
  );
}
