/** آدرس API: runtime از /config.js (nginx)، سپس VITE_API_URL، سپس همان origin. */
declare global {
  interface Window {
    __DIROUTER__?: { apiUrl?: string };
  }
}

export const API_URL = (
  window.__DIROUTER__?.apiUrl ??
  (import.meta.env.VITE_API_URL as string | undefined) ??
  `${window.location.origin}/api/v1`
).replace(/\/+$/, '');
