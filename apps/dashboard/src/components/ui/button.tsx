import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

type Variant = 'primary' | 'ghost' | 'outline';

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-50',
        variant === 'primary' && 'bg-brand text-brand-fg hover:opacity-90',
        variant === 'ghost' && 'hover:bg-border/60',
        variant === 'outline' && 'border border-border hover:bg-border/40',
        className,
      )}
      {...props}
    />
  );
}
