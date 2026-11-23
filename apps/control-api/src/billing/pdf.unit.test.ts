import { describe, expect, it } from 'vitest';

import { money } from './invoices.service.js';
import { PdfDocument } from './pdf.js';

describe('invoice PDF', () => {
  it('writes a valid cross-reference table across several pages', () => {
    const doc = new PdfDocument();
    for (let i = 0; i < 120; i++)
      doc.text({ x: doc.left, y: doc.down(14), text: `line ${String(i)} (paren) \\ back` });
    const pdf = doc.toBuffer().toString('latin1');
    const pages = Number(/\/Count (\d+)/.exec(pdf)?.[1]);
    expect(pages).toBeGreaterThan(1);
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    // Every object offset in the table points at "<n> 0 obj".
    const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    for (const [i, offset] of offsets.entries())
      expect(pdf.slice(offset, offset + 12)).toMatch(new RegExp(`^${String(i + 1)} 0 obj`));
    expect(pdf).toContain('\\(paren\\) \\\\ back');
  });

  it('replaces text Helvetica cannot show', () => {
    const doc = new PdfDocument();
    doc.text({ x: 0, y: 0, text: 'شرکت ok' });
    expect(doc.toBuffer().toString('latin1')).toContain('(???? ok)');
  });

  it('formats exact amounts', () => {
    expect(money('17.62500000')).toBe('$17.625');
    expect(money('-2.00000000')).toBe('-$2.00');
    expect(money('0.00000150')).toBe('$0.0000015');
  });
});
