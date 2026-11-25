import { afterEach, describe, expect, it, vi } from 'vitest';

import { download } from './api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('file download', () => {
  it('clicks a link that is in the document and revokes its URL afterwards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('%PDF-', { status: 200 }))),
    );
    const revoke = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:invoice');
    URL.revokeObjectURL = revoke;
    const clicked: { connected: boolean; name: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ connected: this.isConnected, name: this.download });
    });

    await download('/orgs/org1/invoices/inv1/pdf', 'INV-1.pdf');
    expect(clicked).toEqual([{ connected: true, name: 'INV-1.pdf' }]);
    expect(document.querySelector('a[download]')).toBeNull();
    // Revoking in the same tick can cancel the download, so it waits for a timer.
    expect(revoke).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revoke).toHaveBeenCalledWith('blob:invoice');
  });
});
