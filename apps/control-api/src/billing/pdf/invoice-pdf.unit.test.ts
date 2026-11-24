/**
 * The Persian invoice PDF (card 26.1), checked as a viewer would show it: every glyph drawn is read
 * back from the page with its position and its Unicode text (the font's ToUnicode map), and the
 * outlines of the embedded subset font are compared with what OpenType shaping of the same words
 * produces. So the test fails if Persian turns into "?", letters are not joined, words or numbers
 * come out in the wrong order, or the font is not embedded.
 */
import { readFileSync } from 'node:fs';

import { splitVat } from '@dirouter/db';
import * as fontkit from 'fontkit';
import { describe, expect, it } from 'vitest';

import { faDecimal, faDigits, faInteger, jalaliDate, jalaliPeriod, money } from './format.js';
import { type InvoicePdfInput, renderInvoicePdf } from './invoice-pdf.js';
import { type DrawnRun, readPdf, rtlReading, visualText } from './pdf-reader.js';
import { ltr, visualChunks } from './rtl.js';

const original = fontkit.create(
  readFileSync(new URL('./fonts/Vazirmatn-Regular.ttf', import.meta.url)),
) as fontkit.Font;

const BUYER = 'شرکت نمونهٔ پارسیان';
const split = splitVat('6.375', '10');

const input: InvoicePdfInput = {
  number: 'INV-2026-000042',
  organizationId: 'org_test',
  period: '2026-10',
  basis: 'prepaid',
  createdAt: new Date('2026-11-24T10:00:00Z'),
  openingUsd: '0.00000000',
  closingUsd: '17.62500000',
  totals: {
    topup: '20.00000000',
    gift: '5.00000000',
    plan: '-2.00000000',
    adjustment: '-1.00000000',
    usage: '-4.37500000',
  },
  lines: [
    { model: 'shop/smart', requests: 1, amountUsd: '3.12500000' },
    { model: 'shop/fast', requests: 2, amountUsd: '1.25000000' },
  ],
  vatPercent: '10',
  ...split,
  exchangeRateIrr: '1050000',
  seller: {
    partyType: 'legal',
    legalName: 'دی‌روتر',
    nationalId: '14000000001',
    economicCode: '411111111111',
    registrationNumber: '12345',
    address: 'تهران، خیابان آزادی، پلاک ۱۰',
    postalCode: '1234567890',
    phone: '02100000000',
  },
  buyer: {
    partyType: 'legal',
    legalName: BUYER,
    nationalId: '10101010101',
    economicCode: '422222222222',
    registrationNumber: null,
    address: 'اصفهان، میدان نقش جهان',
    postalCode: '8100000000',
    phone: null,
  },
};

const noSpace = (s: string) => s.replace(/\s/g, '');
const lineHaving = (lines: DrawnRun[][], read: (l: DrawnRun[]) => string, text: string) =>
  lines.find((l) => read(l).includes(noSpace(text)));

describe('Persian invoice PDF', () => {
  it('embeds a subset of Vazirmatn and keeps Persian text readable through ToUnicode', async () => {
    const pdf = await renderInvoicePdf(input);
    const { fonts, lines, runs } = readPdf(pdf);
    const names = [...fonts.values()].map((f) => f.baseFont);
    expect(names.some((n) => /^[A-Z]{6}\+Vazirmatn-Regular$/.test(n))).toBe(true);
    expect(names.some((n) => /^[A-Z]{6}\+Vazirmatn-Bold$/.test(n))).toBe(true);
    expect(pdf.toString('latin1')).not.toMatch(/Helvetica/);
    // Subset: far smaller than the 123 KB font, and every font has a ToUnicode map.
    for (const f of fonts.values()) expect(f.program?.length ?? 0).toBeLessThan(60_000);
    expect(runs.flatMap((r) => r.glyphs).some((g) => g === '�' || g === '?')).toBe(false);

    // Right-to-left lines read back in order: the buyer's name, labels and the title.
    for (const text of [
      `نام حقوقی: ${BUYER}`,
      'صورتحساب فروش کالا و خدمات',
      'مشخصات فروشنده',
      'مشخصات خریدار',
      'مالیات بر ارزش افزوده',
      'جمع کل با مالیات',
      'مصرف مدل',
    ])
      expect(lineHaving(lines, rtlReading, text), text).toBeDefined();
    // Left-to-right pieces inside right-to-left lines stay left to right.
    for (const text of ['INV-2026-000042', 'shop/smart', 'shop/fast', 'DiRouter', '2026-10'])
      expect(lineHaving(lines, visualText, text), text).toBeDefined();
  });

  it('draws joined letter forms in visual order, as OpenType shaping gives them', async () => {
    const { fonts, lines } = readPdf(await renderInvoicePdf(input));
    const line = lineHaving(lines, rtlReading, BUYER);
    expect(line).toBeDefined();
    const run = (line ?? []).find(
      (r) => r.glyphs.join('') === Array.from('پارسیان').reverse().join(''),
    );
    expect(run, 'the word پارسیان is drawn as one run').toBeDefined();
    const program = fonts.get(run?.font ?? '')?.program;
    expect(program).toBeTruthy();
    const subset = fontkit.create(program as Buffer) as fontkit.Font;
    const drawn = (run?.codes ?? []).map((c) => subset.getGlyph(c).path.toSVG());
    const shaped = original.layout('پارسیان').glyphs.map((g) => g.path.toSVG());
    const isolated = Array.from('پارسیان')
      .reverse()
      .map((ch) => original.glyphForCodePoint(ch.codePointAt(0) ?? 0).path.toSVG());
    expect(drawn).toEqual(shaped);
    expect(drawn).not.toEqual(isolated);
    // پ starts the word: its initial form differs from the isolated letter.
    expect(drawn.at(-1)).not.toBe(isolated.at(-1));
  });

  it('shows Jalali dates, rials at the recorded rate and VAT on its own row', async () => {
    const { lines } = readPdf(await renderInvoicePdf(input));
    // Persian digits are left to right inside right-to-left text.
    expect(lineHaving(lines, visualText, '۱۴۰۵/۰۹/۰۳'), 'issue date').toBeDefined();
    const { from, to } = jalaliPeriod('2026-10');
    expect(from).toBe('۱۴۰۵/۰۷/۰۹');
    expect(to).toBe('۱۴۰۵/۰۸/۰۹');
    // VAT: 6.375 × 10/110 = 0.57954545; gross 6.375 USD × 1,050,000 = 6,693,750 rials.
    const vatLine = lineHaving(lines, rtlReading, 'مالیات بر ارزش افزوده');
    expect(visualText(vatLine ?? [])).toContain('۰٫۵۷۹۵۴۵۴۵');
    expect(visualText(vatLine ?? [])).toContain('۶۰۸٬۵۲۳');
    const total = lineHaving(lines, rtlReading, 'جمع کل با مالیات');
    expect(visualText(total ?? [])).toContain('۶٫۳۷۵');
    expect(visualText(total ?? [])).toContain('۶٬۶۹۳٬۷۵۰');
    expect(lineHaving(lines, visualText, '۱٬۰۵۰٬۰۰۰'), 'rate').toBeDefined();
    expect(lineHaving(lines, visualText, '۶۶۹٬۳۷۵'), 'toman').toBeDefined();
  });

  it('breaks long item lists across pages and repeats the table header', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      model: `vendor/model-${String(i)}`,
      requests: i + 1,
      amountUsd: '0.10000000',
    }));
    const pdf = await renderInvoicePdf({
      ...input,
      basis: 'postpaid',
      lines: many,
      totals: { usage: '8.00000000' },
      ...splitVat('8', '10'),
      exchangeRateIrr: null,
    });
    const text = pdf.toString('latin1');
    expect(Number(/\/Count (\d+)/.exec(text)?.[1])).toBeGreaterThan(1);
    const { lines } = readPdf(pdf);
    expect(lines.filter((l) => rtlReading(l).includes(noSpace('شرح کالا یا خدمات'))).length).toBe(
      Number(/\/Count (\d+)/.exec(text)?.[1]),
    );
    expect(lineHaving(lines, visualText, 'vendor/model-79')).toBeDefined();
  });
});

describe('bidi chunks', () => {
  it('orders mixed Persian, Latin and digits visually', () => {
    const chunks = visualChunks('فاکتور INV-1 مبلغ ۱۲٬۵۰۰ ریال');
    const words = chunks.filter((c) => !c.space).map((c) => c.logical);
    // Visual order left to right is the reverse of the reading order for an RTL paragraph.
    expect(words).toEqual(['ریال', '۱۲٬۵۰۰', 'مبلغ', 'INV-1', 'فاکتور']);
    // Persian digits are handed to the shaper reversed (it reverses Arabic script itself).
    expect(chunks.find((c) => c.logical === '۱۲٬۵۰۰')?.shape).toBe('۰۰۵٬۲۱');
    expect(chunks.find((c) => c.logical === 'INV-1')?.shape).toBe('INV-1');
  });

  it('keeps an isolated left-to-right value whole after Persian words', () => {
    // Without the isolate, the algorithm reads 2026 and 10 as Arabic numbers: 10-2026.
    const plain = visualChunks('ماه میلادی 2026-10').filter((c) => !c.space);
    expect(plain.map((c) => c.logical).slice(0, 3)).toEqual(['10', '-', '2026']);
    const isolated = visualChunks(`ماه میلادی ${ltr('2026-10')}`).filter((c) => !c.space);
    expect(isolated.map((c) => c.logical)).toEqual(['2026-10', 'میلادی', 'ماه']);
  });

  it('mirrors brackets in right-to-left text', () => {
    const [chunk] = visualChunks('(ریال)');
    expect(chunk?.logical).toBe(')ریال(');
  });
});

describe('Persian formatting', () => {
  it('formats digits, amounts and Jalali dates', () => {
    expect(faDigits('2026')).toBe('۲۰۲۶');
    expect(faInteger(6693750n)).toBe('۶٬۶۹۳٬۷۵۰');
    expect(faInteger(-1200)).toBe('-۱٬۲۰۰');
    expect(faDecimal('17.62500000')).toBe('۱۷٫۶۲۵');
    expect(faDecimal('1050000', 0)).toBe('۱٬۰۵۰٬۰۰۰');
    expect(faDecimal('2.00000000')).toBe('۲٫۰۰');
    expect(jalaliDate(new Date('2026-03-21T12:00:00Z'))).toBe('۱۴۰۵/۰۱/۰۱');
    // Tehran is ahead of UTC: 22:00 UTC on 23 Nov is already 24 Nov (3 Azar) there.
    expect(jalaliDate(new Date('2026-11-23T22:00:00Z'))).toBe('۱۴۰۵/۰۹/۰۳');
    expect(money('17.62500000')).toBe('$17.625');
    expect(money('-2.00000000')).toBe('-$2.00');
  });
});
