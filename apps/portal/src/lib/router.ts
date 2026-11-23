/** A small history router: the portal has a handful of flat routes. */
import { useSyncExternalStore } from 'react';

const subscribers = new Set<() => void>();
const notify = () => {
  for (const s of subscribers) s();
};
window.addEventListener('popstate', notify);

export function navigate(to: string, replace = false) {
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  notify();
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => window.location.pathname,
  );
}

export const query = (name: string) => new URLSearchParams(window.location.search).get(name);
