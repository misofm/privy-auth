import type { ButtonHTMLAttributes, ReactNode } from 'react';

import type { OAuthProvider } from '../oauth.js';
import { AppleMark, GoogleMark } from './marks.js';

const PROVIDERS = {
  google: { name: 'Google', Mark: GoogleMark },
  apple: { name: 'Apple', Mark: AppleMark },
} as const satisfies Record<OAuthProvider, unknown>;

/** What an `OAuthButton`'s function `className` is given: `disabled` includes `busy`. */
export type OAuthButtonState = { readonly busy: boolean; readonly disabled: boolean };

export interface OAuthButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children' | 'type'> {
  readonly provider: OAuthProvider;
  /** Leaving for the provider (or back from it): `spinner` shows, and the button takes no presses. */
  readonly busy?: boolean | undefined;
  /** "Continue with Google" / "Continue with Apple" by default (their branding's wording). */
  readonly label?: ReactNode;
  /** Shown while busy: in place of the mark, or (`busyLabel={false}`) of the mark and the label. */
  readonly spinner?: ReactNode;
  /** Whether the label stays while busy (`true` by default). */
  readonly busyLabel?: boolean | undefined;
  readonly className?: string | ((state: OAuthButtonState) => string) | undefined;
  readonly classNames?: { readonly mark?: string | undefined } | undefined;
}

/**
 * Continue with Google or Apple: a native button with the provider's mark (`GoogleMark`,
 * `AppleMark`) and name, unstyled. `aria-busy` and `data-busy` while busy, `disabled` while busy
 * or disabled (`data-provider` names it).
 */
export function OAuthButton({ provider, busy = false, disabled = false, label, spinner, busyLabel = true, className, classNames, ...props }: OAuthButtonProps) {
  const { name, Mark } = PROVIDERS[provider];
  const inactive = disabled || busy;
  const text = label ?? `Continue with ${name}`;
  return (
    <button
      type="button"
      aria-busy={busy || undefined}
      data-busy={busy || undefined}
      data-provider={provider}
      disabled={inactive}
      className={typeof className === 'function' ? className({ busy, disabled: inactive }) : className}
      {...props}
    >
      {busy ? (
        <>
          {spinner}
          {busyLabel && text}
        </>
      ) : (
        <>
          <Mark className={classNames?.mark} />
          {text}
        </>
      )}
    </button>
  );
}
