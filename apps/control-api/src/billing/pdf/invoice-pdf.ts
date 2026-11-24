/**
 * The Persian invoice PDF (card 26.1): A4, right to left, Vazirmatn embedded as a subset (pdfkit
 * subsets every embedded font to the glyphs used), Jalali dates, amounts in USD and in rials at the
 * rate recorded on the invoice, seller and buyer legal details and VAT on its own row.
 *
 * Vazirmatn is © The Vazirmatn Project Authors, under the SIL Open Font License 1.1 (fonts/OFL.txt).
 */
import { readFileSync } from 'node:fs';

import { allocate, fromUnits, type InvoiceParty, rialTotals, toUnits } from '@dirouter/db';
import PDFDocument from 'pdfkit';

import { faDecimal, faDigits, faInteger, jalaliDate, jalaliPeriod } from './format.js';
import { ltr, visualChunks, wrapWords } from './rtl.js';

const fontFile = (name: string) => readFileSync(new URL(`./fonts/${name}`, import.meta.url));
let fonts: { regular: Buffer; bold: Buffer } | undefined;
function loadFonts() {
  fonts ??= {
    regular: fontFile('Vazirmatn-Regular.ttf'),
    bold: fontFile('Vazirmatn-Bold.ttf'),
  };
  return fonts;
}

export interface InvoicePdfInput {
  number: string;
  organizationId: string;
  period: string;
  basis: string;
  createdAt: Date;
  openingUsd: string;
  closingUsd: string;
  totals: Record<string, string>;
  lines: { model: string; requests: number; amountUsd: string }[];
  /** null on invoices issued before the tax fields. */
  vatPercent: string | null;
  grossUsd: string;
  netUsd: string;
  vatUsd: string;
  exchangeRateIrr: string | null;
  seller: InvoiceParty | null;
  buyer: InvoiceParty;
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const RIGHT = PAGE.width - MARGIN;
const WIDTH = PAGE.width - 2 * MARGIN;
const BOTTOM = PAGE.height - MARGIN;
const INK = '#1f1d1a';
const MUTED = '#6b665e';
const RULE = '#c9c3b8';
const BAND = '#f1eee8';

interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: string;
  /** Paragraph direction; Persian labels are rtl, identifiers and numbers may be ltr. */
  base?: 'rtl' | 'ltr';
}

/** pdfkit with right-to-left text drawn chunk by chunk (see rtl.ts) and manual page breaks. */
class Page {
  readonly doc: PDFKit.PDFDocument;
  y = MARGIN;

  constructor(title: string) {
    const { regular, bold } = loadFonts();
    this.doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      lang: 'fa-IR',
      displayTitle: true,
      info: { Title: title, Author: 'DiRouter', Subject: title },
    });
    this.doc.registerFont('fa', regular);
    this.doc.registerFont('fa-bold', bold);
  }

  #font(o: TextOptions) {
    this.doc
      .font(o.bold ? 'fa-bold' : 'fa')
      .fontSize(o.size ?? 9)
      .fillColor(o.color ?? INK);
  }

  measure(text: string, o: TextOptions = {}): number {
    this.#font(o);
    return visualChunks(text, o.base ?? 'rtl').reduce(
      (w, c) => w + this.doc.widthOfString(c.shape),
      0,
    );
  }

  /** Draws one line aligned in [left, right]; returns its width. */
  line(
    text: string,
    left: number,
    right: number,
    align: 'left' | 'right' | 'center',
    o: TextOptions = {},
    y = this.y,
  ) {
    const width = this.measure(text, o);
    let x =
      align === 'left' ? left : align === 'right' ? right - width : (left + right - width) / 2;
    this.#font(o);
    for (const chunk of visualChunks(text, o.base ?? 'rtl')) {
      const w = this.doc.widthOfString(chunk.shape);
      if (!chunk.space) this.doc.text(chunk.shape, x, y, { lineBreak: false });
      x += w;
    }
    return width;
  }

  /** Right-aligned wrapped paragraph in [left, right]; returns the height used. */
  paragraph(text: string, left: number, right: number, o: TextOptions = {}, y = this.y): number {
    const lineHeight = (o.size ?? 9) * 1.6;
    const lines = wrapWords(text, right - left, (s) => this.measure(s, o));
    lines.forEach((l, i) =>
      this.line(l, left, right, o.base === 'ltr' ? 'left' : 'right', o, y + i * lineHeight),
    );
    return Math.max(1, lines.length) * lineHeight;
  }

  rule(y: number, left = MARGIN, right = RIGHT, color = RULE, weight = 0.6) {
    this.doc.moveTo(left, y).lineTo(right, y).lineWidth(weight).strokeColor(color).stroke();
  }

  band(y: number, height: number, left = MARGIN, right = RIGHT) {
    this.doc.rect(left, y, right - left, height).fill(BAND);
  }

  box(y: number, height: number) {
    this.doc.rect(MARGIN, y, WIDTH, height).lineWidth(0.6).strokeColor(RULE).stroke();
  }

  /** Starts a new page when fewer than `needed` points are left. */
  ensure(needed: number) {
    if (this.y + needed <= BOTTOM) return false;
    this.doc.addPage({ size: 'A4', margin: 0 });
    this.y = MARGIN;
    return true;
  }

  async toBuffer(): Promise<Buffer> {
    const chunks: Buffer[] = [];
    this.doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      this.doc.on('end', resolve);
      this.doc.on('error', reject);
    });
    this.doc.end();
    await done;
    return Buffer.concat(chunks);
  }
}

const dash = '—';
const usd = (amount: string) => faDecimal(fromUnits(toUnits(amount)));

function partyRows(p: InvoiceParty | null): [string, string][] {
  const v = (s: string | null | undefined) => (s ? faDigits(s) : dash);
  return [
    [p?.partyType === 'natural' ? 'نام' : 'نام حقوقی', p?.legalName ?? dash],
    [p?.partyType === 'natural' ? 'کد ملی' : 'شناسهٔ ملی', v(p?.nationalId)],
    ['کد اقتصادی', v(p?.economicCode)],
    ['شمارهٔ ثبت', v(p?.registrationNumber)],
    ['کد پستی', v(p?.postalCode)],
    ['تلفن', v(p?.phone)],
  ];
}

const KIND_LABELS: [string, string][] = [
  ['topup', 'افزایش اعتبار'],
  ['gift', 'کد هدیه و شارژ'],
  ['adjustment', 'اصلاحیه'],
  ['refund', 'بازپرداخت'],
  ['plan', 'حق اشتراک'],
  ['usage', 'مصرف'],
];

interface Item {
  description: string;
  quantity: string;
  base: 'rtl' | 'ltr';
  netUsd: bigint;
  netRials: bigint | null;
}

/** The invoice's items with VAT spread over them, so items add up to the net exactly. */
function items(input: InvoicePdfInput): Item[] {
  const raw: { description: string; quantity: string; gross: bigint }[] = input.lines.map((l) => ({
    description: `مصرف مدل ${ltr(l.model)}`,
    quantity: faInteger(l.requests),
    gross: toUnits(l.amountUsd),
  }));
  const plan = -toUnits(input.totals.plan ?? '0');
  if (input.basis === 'prepaid' && plan > 0n)
    raw.push({ description: 'حق اشتراک پلن', quantity: dash, gross: plan });
  const positive = raw.filter((r) => r.gross > 0n);
  const vat = allocate(
    toUnits(input.vatUsd),
    positive.map((r) => r.gross),
  );
  const nets = positive.map((r, i) => r.gross - (vat[i] ?? 0n));
  const rials = input.exchangeRateIrr
    ? allocate(
        rialTotals(
          { grossUsd: input.grossUsd, netUsd: input.netUsd, vatUsd: input.vatUsd },
          input.exchangeRateIrr,
        ).netRials,
        nets,
      )
    : null;
  return positive.map((r, i) => ({
    description: r.description,
    quantity: r.quantity,
    base: 'rtl',
    netUsd: nets[i] ?? 0n,
    netRials: rials ? (rials[i] ?? 0n) : null,
  }));
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const title = `صورتحساب ${input.number}`;
  const page = new Page(title);
  const rate = input.exchangeRateIrr;
  const vatPercent = input.vatPercent ?? '0';
  const rials = rate
    ? rialTotals({ grossUsd: input.grossUsd, netUsd: input.netUsd, vatUsd: input.vatUsd }, rate)
    : null;

  // ── Header ──
  page.line('صورتحساب فروش کالا و خدمات', MARGIN, RIGHT, 'right', { size: 16, bold: true });
  page.line('DiRouter', MARGIN, RIGHT, 'left', { size: 16, bold: true, base: 'ltr' });
  page.y += 30;
  page.line(`شمارهٔ صورتحساب: ${ltr(input.number)}`, MARGIN, RIGHT, 'right', {
    size: 10,
    bold: true,
  });
  page.line(`تاریخ صدور: ${jalaliDate(input.createdAt)}`, MARGIN, RIGHT, 'left', { size: 10 });
  page.y += 17;
  const { from, to } = jalaliPeriod(input.period);
  page.line(`دورهٔ صورتحساب: از ${from} تا ${to}`, MARGIN, RIGHT, 'right', { size: 9 });
  page.line(`ماه میلادی ${ltr(input.period)}`, MARGIN, RIGHT, 'left', { size: 9, color: MUTED });
  page.y += 22;

  // ── Parties ──
  for (const [heading, party] of [
    ['مشخصات فروشنده', input.seller],
    ['مشخصات خریدار', input.buyer],
  ] as const) {
    const top = page.y;
    page.band(top, 18);
    page.line(heading, MARGIN, RIGHT - 8, 'right', { size: 10, bold: true }, top + 3);
    const rows = partyRows(party);
    const half = WIDTH / 2;
    let y = top + 24;
    for (let i = 0; i < rows.length; i += 2) {
      for (const [col, row] of [rows[i], rows[i + 1]].entries()) {
        if (!row) continue;
        const right = RIGHT - 8 - col * half;
        page.line(`${row[0]}: ${row[1]}`, right - half + 16, right, 'right', { size: 9 }, y);
      }
      y += 15;
    }
    y += page.paragraph(
      `نشانی: ${party?.address ? faDigits(party.address) : dash}`,
      MARGIN + 8,
      RIGHT - 8,
      { size: 9 },
      y,
    );
    page.box(top, y - top + 4);
    page.y = y + 14;
  }

  // ── Items ──
  const cols = rate
    ? { row: 28, qty: 55, usd: 100, irr: 120 }
    : { row: 28, qty: 70, usd: 120, irr: 0 };
  // x positions from the right edge: row | description | quantity | USD | rials.
  const xRow = RIGHT;
  const xDesc = xRow - cols.row;
  const xIrr = MARGIN + cols.irr;
  const xUsd = xIrr + cols.usd;
  const xQty = xUsd + cols.qty;
  const header = () => {
    page.band(page.y, 20);
    const y = page.y + 5;
    const o = { size: 8.5, bold: true };
    page.line('ردیف', xDesc, xRow - 4, 'center', o, y);
    page.line('شرح کالا یا خدمات', xQty + 4, xDesc - 4, 'right', o, y);
    page.line('تعداد درخواست', xUsd, xQty, 'center', o, y);
    page.line('مبلغ بدون مالیات (دلار)', xIrr, xUsd, 'center', o, y);
    if (rate) page.line('مبلغ بدون مالیات (ریال)', MARGIN, xIrr, 'center', o, y);
    page.y += 24;
  };
  page.ensure(60);
  header();
  const list = items(input);
  if (list.length === 0) {
    page.line('در این دوره قلمی برای صورتحساب نیست.', MARGIN, RIGHT, 'center', { color: MUTED });
    page.y += 18;
  }
  for (const [i, item] of list.entries()) {
    if (page.ensure(20)) header();
    page.line(faInteger(i + 1), xDesc, xRow - 4, 'center');
    page.line(item.description, xQty + 4, xDesc - 4, 'right', { base: item.base });
    page.line(item.quantity, xUsd, xQty, 'center');
    page.line(faDecimal(fromUnits(item.netUsd)), xIrr, xUsd - 6, 'left', { base: 'ltr' });
    if (item.netRials !== null)
      page.line(faInteger(item.netRials), MARGIN + 4, xIrr - 6, 'left', { base: 'ltr' });
    page.y += 15;
    page.rule(page.y - 3, MARGIN, RIGHT, BAND);
  }

  // ── Totals ──
  page.ensure(80);
  page.y += 4;
  page.rule(page.y - 2, MARGIN, RIGHT, RULE, 0.8);
  const totalRow = (label: string, amountUsd: string, amountRials: bigint | null, bold = false) => {
    const o = { bold, size: bold ? 10 : 9 };
    page.line(label, xUsd + 4, RIGHT - 4, 'right', o);
    page.line(usd(amountUsd), xIrr, xUsd - 6, 'left', { ...o, base: 'ltr' });
    if (amountRials !== null)
      page.line(faInteger(amountRials), MARGIN + 4, xIrr - 6, 'left', { ...o, base: 'ltr' });
    page.y += bold ? 19 : 16;
  };
  totalRow('جمع مبلغ بدون مالیات', input.netUsd, rials?.netRials ?? null);
  totalRow(
    `مالیات بر ارزش افزوده (${faDecimal(vatPercent, 0)}٪)`,
    input.vatUsd,
    rials?.vatRials ?? null,
  );
  page.rule(page.y - 3, xIrr - cols.irr, RIGHT, RULE, 0.8);
  totalRow('جمع کل با مالیات', input.grossUsd, rials?.grossRials ?? null, true);
  page.y += 4;
  if (rate && rials) {
    page.line(
      `نرخ تبدیل ثبت‌شده هنگام صدور: هر دلار آمریکا ${faDecimal(rate, 0)} ریال`,
      MARGIN,
      RIGHT,
      'right',
      { size: 9 },
    );
    page.y += 15;
    const toman = faDecimal(
      `${(rials.grossRials / 10n).toString()}.${(rials.grossRials % 10n).toString()}`,
      0,
    );
    page.line(`جمع کل به تومان: ${toman} تومان`, MARGIN, RIGHT, 'right', { size: 9, bold: true });
    page.y += 15;
  } else {
    page.line('نرخ تبدیل ریال ثبت نشده است؛ مبالغ به دلار آمریکاست.', MARGIN, RIGHT, 'right', {
      size: 9,
      color: MUTED,
    });
    page.y += 15;
  }

  // ── Prepaid wallet movements ──
  if (input.basis === 'prepaid') {
    const kinds = KIND_LABELS.filter(([k]) => input.totals[k] !== undefined);
    page.ensure(40 + 16 * (kinds.length + 2));
    page.y += 10;
    page.band(page.y, 18);
    page.line(
      'گردش کیف پول پیش‌پرداخت (دلار)',
      MARGIN,
      RIGHT - 8,
      'right',
      { size: 10, bold: true },
      page.y + 3,
    );
    page.y += 24;
    const row = (label: string, amount: string, bold = false) => {
      page.line(label, MARGIN, RIGHT - 8, 'right', { bold });
      page.line(usd(amount), MARGIN + 8, RIGHT, 'left', { bold, base: 'ltr' });
      page.y += 15;
    };
    row('موجودی ابتدای دوره', input.openingUsd);
    for (const [kind, label] of kinds) row(label, input.totals[kind] ?? '0');
    page.rule(page.y - 3);
    row('موجودی پایان دوره', input.closingUsd, true);
  }

  // ── Notes ──
  page.ensure(60);
  page.y += 10;
  const notes = [
    input.basis === 'prepaid'
      ? 'این صورتحساب از دفتر کل کیف پول محاسبه شده است و مبالغ آن با گردش کیف پول یکی است.'
      : 'این صورتحساب مبلغ قابل پرداخت مصرف این دوره است.',
    input.vatPercent === null
      ? 'این صورتحساب پیش از ثبت مالیات بر ارزش افزوده صادر شده است.'
      : 'مبالغ کسرشده شامل مالیات بر ارزش افزوده است و مالیات به‌صورت قلم جدا نشان داده شده است.',
  ];
  for (const note of notes)
    page.y += page.paragraph(note, MARGIN, RIGHT, { size: 8, color: MUTED });
  page.line(`شناسهٔ سازمان: ${ltr(input.organizationId)}`, MARGIN, RIGHT, 'right', {
    size: 7.5,
    color: MUTED,
  });
  return page.toBuffer();
}
