/** The mark: one request in, routed to one of several targets. */
export function Mark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`${className} shrink-0 text-brand rtl:-scale-x-100`}
    >
      <rect width="24" height="24" rx="6" className="fill-current" />
      <path
        d="M6 12h4m0 0c3 0 3-5 6-5h2m-8 5c3 0 3 5 6 5h2m-8-5h8"
        fill="none"
        strokeWidth="1.75"
        strokeLinecap="round"
        className="stroke-brand-fg"
      />
    </svg>
  );
}
