/**
 * `@misofm/privy-auth/ui`: unstyled parts of a sign-in screen, on ui-sdk (`@ui-sdk/react`
 * 0.1.0-beta.17, a peer). Each takes `className` (and `classNames` for its inner parts) and its
 * words as props, with defaults; each app lays them out in its own screen. `OAuthButton`, the
 * marks and `ConsentLine` import no ui-sdk.
 */
export { CodeField, type CodeFieldProps, createCodeFieldController } from './ui/code-field.js';
export { type ConsentCopy, ConsentLine, PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from './ui/consent-line.js';
export { EmailField, type EmailFieldProps, type EmailMessages } from './ui/email-field.js';
export { AppleMark, GoogleMark } from './ui/marks.js';
export { OAuthButton, type OAuthButtonProps, type OAuthButtonState } from './ui/oauth-button.js';
export { OrSeparator } from './ui/or-separator.js';
