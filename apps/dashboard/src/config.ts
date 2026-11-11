/**
 * API address: runtime value from /config.js (nginx), then VITE_API_URL, then the same domain with the admin prefix.
 * (app.example.com → admin.example.com) and the same page protocol.
 */
declare global {
  interface Window {
    __DIROUTER__?: { apiUrl?: string };
  }
}

function derived(): string {
  const { protocol, host } = window.location;
  return host.startsWith('app.')
    ? `${protocol}//admin.${host.slice(4)}/api/v1`
    : `${window.location.origin}/api/v1`;
}

export const API_URL = (
  window.__DIROUTER__?.apiUrl ??
  (import.meta.env.VITE_API_URL as string | undefined) ??
  derived()
).replace(/\/+$/, '');
