/** CSV files built in the browser (billing exports, cards 25.1 and 25.2). */

type Row = readonly (string | number)[];

/** Byte order mark: makes Excel read Persian names as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** Every cell quoted and quotes doubled, so names with commas or quotes survive a spreadsheet. */
export function toCsv(header: Row, rows: readonly Row[]): string {
  const cell = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadCsv(name: string, header: Row, rows: readonly Row[]) {
  downloadBlob(name, new Blob([BOM + toCsv(header, rows)], { type: 'text/csv;charset=utf-8' }));
}
