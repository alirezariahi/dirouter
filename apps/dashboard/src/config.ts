/**
 * آدرس API: runtime از /config.js (nginx)، سپس VITE_API_URL، سپس همان دامنه با پیشوند admin.
 * (app.example.com → admin.example.com) و همان پروتکل صفحه.
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
