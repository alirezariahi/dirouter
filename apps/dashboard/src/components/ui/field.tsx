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
    <label htmlFor={id} className="flex flex-col gap-1.5 text-sm">
      <span className="text-[13px] font-medium text-fg-2">{label}</span>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        className={cn(
          'h-10 rounded-lg border border-border bg-surface px-3 outline-none placeholder:text-muted',
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
      className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      {message}
    </p>
  ) : null;
}
