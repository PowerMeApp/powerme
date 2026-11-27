/**
 * One labelled form field with its validation message right beneath the input, in red
 * (`.form-error`, D43). The input gets `id`, `aria-invalid` and `aria-describedby` from `children`'s
 * argument, so screen readers announce the message with the field.
 */
import { useId, type ReactNode } from 'react';

export interface FieldA11y {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: (a11y: FieldA11y) => ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        'aria-invalid': !!error,
        'aria-describedby': error ? errorId : undefined,
      })}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

/** Red message under a field, or a form-level message; nothing when there is no message. */
export function FieldError({ id, message }: { id?: string; message?: string | undefined }) {
  if (!message) return null;
  return (
    <p className="form-error" id={id} role="alert">
      {message}
    </p>
  );
}
