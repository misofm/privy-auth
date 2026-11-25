import { Separator } from '@ui-sdk/react/separator';
import type { ReactNode } from 'react';

import { classNameOf } from './class-name.js';

/**
 * "or" between two hairlines (ui-sdk's `Separator`, decorative: the word already divides).
 * Unstyled: `className` for the row, `classNames.line` for each line.
 */
export function OrSeparator({ label = 'or', className, classNames }: { readonly label?: ReactNode; readonly className?: string | undefined; readonly classNames?: { readonly line?: string | undefined } | undefined }) {
  return (
    <div className={className}>
      <Separator decorative {...classNameOf(classNames?.line)} />
      {label}
      <Separator decorative {...classNameOf(classNames?.line)} />
    </div>
  );
}
