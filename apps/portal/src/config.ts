/**
 * API address: runtime value from /config.js (nginx), then VITE_API_URL, then derived from the page
 * address (portal.example.com → admin.example.com), keeping the page protocol.
 */
declare global {
  interface Window {
    __DIROUTER__?: { apiUrl?: string; gatewayUrl?: string };
  }
}

function sibling(prefix: string, path: string): string {
  const { protocol, host } = window.location;
  return host.startsWith('portal.')
    ? `${protocol}//${prefix}.${host.slice(7)}${path}`
    : `${window.location.origin}${path}`;
}

export const API_URL = (
  window.__DIROUTER__?.apiUrl ??
  (import.meta.env.VITE_API_URL as string | undefined) ??
  sibling('admin', '/api/v1')
).replace(/\/+$/, '');

/** Where clients send model requests (shown in the quick start). */
export const GATEWAY_URL = (
  window.__DIROUTER__?.gatewayUrl ??
  (import.meta.env.VITE_GATEWAY_URL as string | undefined) ??
  sibling('api', '')
).replace(/\/+$/, '');
