/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadBlob, toCsv } from './csv';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CSV export', () => {
  it('neutralizes text a spreadsheet would run as a formula', () => {
    const csv = toCsv(
      ['name', 'note'],
      [
        ['=HYPERLINK("https://evil.example","x")', '+1+1'],
        ['-2+3', '@SUM(A1:A9)'],
        ['\tcmd', '\rcmd'],
        ['-', 'plain'],
      ],
    );
    expect(csv.split('\n')).toEqual([
      '"name","note"',
      `"'=HYPERLINK(""https://evil.example"",""x"")","'+1+1"`,
      `"'-2+3","'@SUM(A1:A9)"`,
      `"'\tcmd","'\rcmd"`,
      `"'-","plain"`,
    ]);
  });

  it('keeps amounts as plain numbers, signed or not', () => {
    expect(
      toCsv(['n'], [[-12.5], ['-12.5'], ['+3'], ['-0.00012345'], ['25.50012345'], [0], ['1e-8']]),
    ).toBe(
      ['"n"', '"-12.5"', '"-12.5"', '"+3"', '"-0.00012345"', '"25.50012345"', '"0"', '"1e-8"'].join(
        '\n',
      ),
    );
  });

  it('clicks a link that is in the document and revokes its URL afterwards', () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:test',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revoke,
    });
    const clicked: { connected: boolean; name: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ connected: this.isConnected, name: this.download });
    });
    downloadBlob('report.csv', new Blob(['x']));
    expect(clicked).toEqual([{ connected: true, name: 'report.csv' }]);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });
});
