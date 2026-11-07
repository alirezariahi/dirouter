import type { InputHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

export function Field({
  label,
  error,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined }) {
  const id = props.id ?? props.name;
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        className={cn(
          'h-10 rounded-md border border-border bg-surface px-3 outline-none focus:border-brand',
          error && 'border-danger',
          className,
        )}
        {...props}
      />
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </label>
  );
}

export function FormError({ message }: { message: string | undefined }) {
  return message ? (
    <p
      role="alert"
      className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      {message}
    </p>
  ) : null;
}
