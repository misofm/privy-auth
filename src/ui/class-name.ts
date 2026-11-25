/** `{ className }` when there is one (ui-sdk's parts take no `undefined` under `exactOptionalPropertyTypes`). */
export const classNameOf = (className: string | undefined): { className?: string } => (className === undefined ? {} : { className });
