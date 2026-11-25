import { Field, FieldDescription, FieldError, FieldLabel } from '@ui-sdk/react/field';
import { createOTPInputController, OTPInput, OTPInputGroup, OTPInputSlot } from '@ui-sdk/react/otp-input';
import type { ComponentProps, ReactNode } from 'react';

import { classNameOf } from './class-name.js';

import { CODE_LENGTH } from '../sign-in-flow.js';

/** A handle to focus a `CodeField` from elsewhere (`onWrongCode`); make one per field. */
export const createCodeFieldController = createOTPInputController;

export interface CodeFieldProps extends Omit<ComponentProps<typeof OTPInput>, 'children' | 'maxLength' | 'pattern' | 'inputMode' | 'autoComplete' | 'className'> {
  /** Digits (`CODE_LENGTH`, 6, by default). */
  readonly length?: number | undefined;
  /** Its name, for assistive technology ("Code" by default; hide it with the label's class). */
  readonly label?: ReactNode;
  /** What to type, read with the field (`FieldDescription`). */
  readonly description?: ReactNode;
  /** The code's problem (`useSignIn`'s `codeFailure`, in words): the field invalid, this its `FieldError`. */
  readonly error?: ReactNode;
  readonly classNames?:
    | {
        readonly root?: string | undefined;
        readonly label?: string | undefined;
        readonly description?: string | undefined;
        /** ui-sdk's `OTPInput` (the native input inside, and its slots). */
        readonly input?: string | undefined;
        readonly group?: string | undefined;
        readonly slot?: string | undefined;
        readonly error?: string | undefined;
      }
    | undefined;
}

/**
 * The emailed code (ui-sdk's `OTPInput` in a `Field`), unstyled: one native input
 * (`autocomplete="one-time-code"`, a numeric keyboard, digits only) drawn as `length` slots, so a
 * pasted or autofilled code fills them all. Controlled (`value` + `onValueChange`);
 * `onValueCommit` runs once every slot is filled (`useSignIn`'s `submitCode`).
 */
export function CodeField({ length = CODE_LENGTH, label = 'Code', description, error, classNames, ...props }: CodeFieldProps) {
  const invalid = error !== undefined && error !== null && error !== false;
  return (
    <Field invalid={invalid} {...classNameOf(classNames?.root)}>
      <FieldLabel {...classNameOf(classNames?.label)}>{label}</FieldLabel>
      {description !== undefined && <FieldDescription {...classNameOf(classNames?.description)}>{description}</FieldDescription>}
      <OTPInput maxLength={length} pattern="digits" inputMode="numeric" autoComplete="one-time-code" {...classNameOf(classNames?.input)} {...props}>
        <OTPInputGroup {...classNameOf(classNames?.group)}>
          {Array.from({ length }, (_, index) => (
            <OTPInputSlot key={index} index={index} {...classNameOf(classNames?.slot)} />
          ))}
        </OTPInputGroup>
      </OTPInput>
      {invalid && (
        <FieldError match {...classNameOf(classNames?.error)}>
          {error}
        </FieldError>
      )}
    </Field>
  );
}
