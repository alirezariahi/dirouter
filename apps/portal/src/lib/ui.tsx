/** The few building blocks every page uses. */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Card({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5">
      {(title !== undefined || action !== undefined) && (
        <div className="mb-4 flex items-center justify-between gap-4">
          {title !== undefined && (
            <h2 className="text-base font-semibold text-stone-900">{title}</h2>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'danger' }) {
  const look = {
    primary: 'bg-teal-700 text-white hover:bg-teal-800 disabled:bg-stone-300',
    quiet: 'border border-stone-300 text-stone-800 hover:bg-stone-100',
    danger: 'border border-red-200 text-red-700 hover:bg-red-50',
  }[variant];
  return (
    <button
      type="button"
      className={`rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${look} ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-stone-600">{label}</span>
      <input
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-stone-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
        {...props}
      />
    </label>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'error' | 'success';
  children: ReactNode;
}) {
  const look = {
    info: 'border-stone-200 bg-stone-50 text-stone-700',
    error: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-teal-200 bg-teal-50 text-teal-900',
  }[tone];
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-md border px-3 py-2 text-sm ${look}`}
    >
      {children}
    </p>
  );
}

/** Left-to-right island for codes, keys and amounts inside right-to-left text. */
export const Mono = ({ children }: { children: ReactNode }) => (
  <bdi dir="ltr" className="font-mono text-[0.85em]">
    {children}
  </bdi>
);
