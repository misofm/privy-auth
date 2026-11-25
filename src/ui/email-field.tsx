import { Field, FieldError, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Option } from 'effect';
import type { ComponentProps, ReactNode } from 'react';

import { classNameOf } from './class-name.js';

import type { EmailProblem } from '../sign-in-flow.js';

/** What an `EmailField` says for each problem. */
export type EmailMessages = { readonly missing: ReactNode; readonly malformed: ReactNode };

const MESSAGES: EmailMessages = { missing: 'Enter your email address.', malformed: 'Enter an email address like name@example.com.' };

export interface EmailFieldProps extends Omit<ComponentProps<typeof Input>, 'type' | 'value' | 'onValueChange' | 'className' | 'children'> {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** "Email" by default. */
  readonly label?: ReactNode;
  /** Above the box, or inside it (a placeholder while empty and unfocused, then small above the text: style it with `peer`). */
  readonly labelPlacement?: 'above' | 'inside' | undefined;
  /**
   * Who checks the email. `flow` (default): `useSignIn` does, and `problem` is its `emailProblem`
   * (the form `noValidate`). `native`: the browser does (`required`, `type="email"`; the form
   * validates), and ui-sdk shows its own problems with these messages.
   */
  readonly validation?: 'flow' | 'native' | undefined;
  readonly problem?: Option.Option<EmailProblem> | undefined;
  readonly messages?: Partial<EmailMessages> | undefined;
  readonly classNames?:
    | {
        readonly root?: string | undefined;
        /** The box around the input and the label inside it (`labelPlacement="inside"`). */
        readonly box?: string | undefined;
        readonly label?: string | undefined;
        readonly input?: string | undefined;
        readonly error?: string | undefined;
      }
    | undefined;
}

/**
 * The email field of a sign-in (ui-sdk's `Field`, `FieldLabel`, `Input`, `FieldError`), unstyled:
 * an email input (`autocomplete="email"`, the email keyboard, no capitals or spell check) named
 * by its label, and its problem as its `FieldError` (announced by ui-sdk; no `role="alert"`).
 */
export function EmailField({ value, onValueChange, label = 'Email', labelPlacement = 'above', validation = 'flow', problem = Option.none(), messages, classNames, ...input }: EmailFieldProps) {
  const words = { ...MESSAGES, ...messages };
  const shown = validation === 'flow' ? Option.getOrUndefined(problem) : undefined;
  const control = (
    <Input
      type="email"
      name="email"
      autoComplete="email"
      inputMode="email"
      autoCapitalize="none"
      spellCheck={false}
      required={validation === 'native'}
      placeholder={labelPlacement === 'inside' ? ' ' : undefined}
      {...input}
      value={value}
      onValueChange={(next: string) => onValueChange(next)}
      {...classNameOf(classNames?.input)}
    />
  );
  const name = <FieldLabel {...classNameOf(classNames?.label)}>{label}</FieldLabel>;
  return (
    // Natively checked, the field stays the browser's: an `invalid` of ours would override it.
    <Field {...(validation === 'flow' ? { invalid: shown !== undefined } : {})} {...classNameOf(classNames?.root)}>
      {labelPlacement === 'inside' ? (
        <div {...classNameOf(classNames?.box)}>
          {control}
          {name}
        </div>
      ) : (
        <>
          {name}
          {control}
        </>
      )}
      {validation === 'native' ? (
        <>
          <FieldError match="valueMissing" {...classNameOf(classNames?.error)}>
            {words.missing}
          </FieldError>
          <FieldError match="typeMismatch" {...classNameOf(classNames?.error)}>
            {words.malformed}
          </FieldError>
        </>
      ) : (
        shown !== undefined && (
          <FieldError match {...classNameOf(classNames?.error)}>
            {shown === 'Missing' ? words.missing : words.malformed}
          </FieldError>
        )
      )}
    </Field>
  );
}
