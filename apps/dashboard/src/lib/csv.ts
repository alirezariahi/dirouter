/** CSV files built in the browser (billing exports, cards 25.1 and 25.2). */

type Row = readonly (string | number)[];

/** Byte order mark: makes Excel read Persian names as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** Amounts arrive as numbers or as decimal strings such as "-12.5"; those stay plain numbers. */
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A spreadsheet runs a cell that starts with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Text that a spreadsheet would read as a formula (`=HYPERLINK(...)` in a customer name, say)
 * gets a leading single quote so it shows as text (CSV formula injection).
 */
function neutralize(value: string | number): string {
  const text = String(value);
  if (typeof value === 'number' || NUMBER.test(text)) return text;
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** Every cell quoted and quotes doubled, so names with commas or quotes survive a spreadsheet. */
export function toCsv(header: Row, rows: readonly Row[]): string {
  const cell = (v: string | number) => `"${neutralize(v).replaceAll('"', '""')}"`;
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}

/**
 * Saves a blob through a temporary link. Some browsers only follow a link that is in the
 * document, and revoking the URL in the same tick can cancel the download, so revoke it later.
 */
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function downloadCsv(name: string, header: Row, rows: readonly Row[]) {
  downloadBlob(name, new Blob([BOM + toCsv(header, rows)], { type: 'text/csv;charset=utf-8' }));
}
