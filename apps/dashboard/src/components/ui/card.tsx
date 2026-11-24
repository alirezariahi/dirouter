import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

/** A surface one step above the page: hairline border, soft shadow in light mode only. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none',
        className,
      )}
      {...props}
    />
  );
}
