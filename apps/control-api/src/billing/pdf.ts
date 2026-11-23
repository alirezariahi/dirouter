/**
 * A minimal PDF 1.4 writer for invoices (card 19.6): A4 pages, the standard Helvetica fonts (no
 * embedding), text and horizontal rules. Enough for a tabular invoice, with no dependency and no
 * fonts in the image. Text outside Latin-1 is replaced by `?`; callers pass Latin text only.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 50;

export interface PdfText {
  x: number;
  y: number;
  text: string;
  size?: number;
  bold?: boolean;
  /** Right-aligned at x (approximate Helvetica widths). */
  alignRight?: boolean;
}

/** Average glyph widths of Helvetica per 1000 units, good enough to right-align numbers. */
function textWidth(text: string, size: number, bold: boolean): number {
  let units = 0;
  for (const ch of text) {
    if (/[0-9]/.test(ch)) units += 556;
    else if (ch === '.' || ch === ',' || ch === ' ') units += 278;
    else if (ch === '$' || ch === '-') units += ch === '$' ? 556 : 333;
    else if (/[A-Z]/.test(ch)) units += 667;
    else units += 500;
  }
  return (units * size * (bold ? 1.05 : 1)) / 1000;
}

function escape(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    const safe = code >= 32 && code <= 255 ? ch : '?';
    out += safe === '(' || safe === ')' || safe === '\\' ? `\\${safe}` : safe;
  }
  return out;
}

export class PdfDocument {
  readonly #pages: string[][] = [[]];
  #y = A4.height - MARGIN;

  get width() {
    return A4.width - 2 * MARGIN;
  }
  get left() {
    return MARGIN;
  }
  get right() {
    return A4.width - MARGIN;
  }

  /** Moves the cursor down, starting a new page when the bottom margin is reached. */
  down(points: number): number {
    this.#y -= points;
    if (this.#y < MARGIN) {
      this.#pages.push([]);
      this.#y = A4.height - MARGIN - points;
    }
    return this.#y;
  }

  get y() {
    return this.#y;
  }

  text(item: PdfText): void {
    const size = item.size ?? 10;
    const x = item.alignRight ? item.x - textWidth(item.text, size, item.bold ?? false) : item.x;
    this.#current().push(
      `BT /${item.bold ? 'F2' : 'F1'} ${String(size)} Tf ${x.toFixed(2)} ${item.y.toFixed(2)} Td (${escape(item.text)}) Tj ET`,
    );
  }

  rule(y: number, weight = 0.5): void {
    this.#current().push(
      `${String(weight)} w ${String(MARGIN)} ${y.toFixed(2)} m ${(A4.width - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`,
    );
  }

  #current(): string[] {
    const page = this.#pages.at(-1);
    if (!page) throw new Error('no page');
    return page;
  }

  /** Serializes the document with a correct cross-reference table. */
  toBuffer(): Buffer {
    const objects: string[] = [];
    /** Returns the 1-based object number. */
    const add = (body: string) => objects.push(body);
    const catalog = add('');
    const pages = add('');
    const regular = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    );
    const bold = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    );
    const kids: number[] = [];
    for (const content of this.#pages) {
      const stream = content.join('\n');
      const contents = add(
        `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}\nendstream`,
      );
      kids.push(
        add(
          `<< /Type /Page /Parent ${String(pages)} 0 R /MediaBox [0 0 ${String(A4.width)} ${String(A4.height)}] ` +
            `/Resources << /Font << /F1 ${String(regular)} 0 R /F2 ${String(bold)} 0 R >> >> /Contents ${String(contents)} 0 R >>`,
        ),
      );
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${String(pages)} 0 R >>`;
    objects[pages - 1] =
      `<< /Type /Pages /Kids [${kids.map((k) => `${String(k)} 0 R`).join(' ')}] /Count ${String(kids.length)} >>`;

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    for (const [i, body] of objects.entries()) {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
    }
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
    for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
