/**
 * A small reader for the PDFs this app writes, used by tests to check what a viewer will show
 * (card 26.1): which glyphs are drawn where, what Unicode text each maps to through the font's
 * ToUnicode CMap, and the embedded font programs. It understands pdfkit's output only: flate
 * streams, Type0 fonts with Identity-H encoding and `TJ` arrays of hex glyph codes.
 */
import { inflateSync } from 'node:zlib';

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

export interface DrawnRun {
  /** 0-based page number. */
  page: number;
  font: string;
  x: number;
  y: number;
  /** Glyph codes (Identity-H: the subset glyph ids) in drawing order, left to right. */
  codes: number[];
  /** The Unicode text of each glyph, from ToUnicode (a ligature maps to several characters). */
  glyphs: string[];
}

export interface ReadPdf {
  objects: Map<number, PdfObject>;
  runs: DrawnRun[];
  /** Base font name (with the subset tag) per resource name, e.g. `F1 → ABCDEF+Vazirmatn-Regular`. */
  fonts: Map<string, { baseFont: string; program: Buffer | null }>;
  /** Visual lines top to bottom: runs left to right. */
  lines: DrawnRun[][];
}

function parseObjects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  for (const m of text.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const body = m[2] ?? '';
    const at = body.indexOf('stream');
    let stream: Buffer | null = null;
    let dict = body;
    if (at >= 0) {
      dict = body.slice(0, at);
      const start = body[at + 6] === '\r' ? at + 8 : at + 7;
      const end = body.lastIndexOf('endstream');
      const raw = Buffer.from(body.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
      stream = /\/FlateDecode/.test(dict) ? inflateSync(raw) : raw;
    }
    objects.set(Number(m[1]), { dict, stream });
  }
  return objects;
}

const ref = (dict: string, key: string) => {
  const m = new RegExp(`/${key} (\\d+) 0 R`).exec(dict);
  return m ? Number(m[1]) : null;
};

function parseCmap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const hex = (h: string) => {
    let s = '';
    for (let i = 0; i < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of (block[1] ?? '').matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*\[([^\]]*)\]/gi)) {
      const start = parseInt(m[1] ?? '0', 16);
      // A ligature maps to several UTF-16 units, written `<0644 0627>`.
      [...(m[3] ?? '').matchAll(/<([0-9a-f\s]*)>/gi)].forEach((v, i) =>
        map.set(start + i, hex((v[1] ?? '').replace(/\s/g, ''))),
      );
    }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of (block[1] ?? '').matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi))
      map.set(parseInt(m[1] ?? '0', 16), hex(m[2] ?? ''));
  return map;
}

export function readPdf(pdf: Buffer): ReadPdf {
  const objects = parseObjects(pdf);
  const fonts = new Map<string, { baseFont: string; program: Buffer | null }>();
  const cmaps = new Map<string, Map<number, string>>();
  const runs: DrawnRun[] = [];
  let pageNumber = -1;
  for (const page of objects.values()) {
    if (!/\/Type \/Page\b/.test(page.dict)) continue;
    pageNumber++;
    const resourceRef = ref(page.dict, 'Resources');
    const resourceDict = resourceRef === null ? page.dict : (objects.get(resourceRef)?.dict ?? '');
    const resources = /\/Font <<([^>]*)>>/.exec(resourceDict)?.[1] ?? '';
    for (const m of resources.matchAll(/\/(\w+) (\d+) 0 R/g)) {
      const name = m[1] ?? '';
      const font = objects.get(Number(m[2]));
      if (!font || fonts.has(name)) continue;
      const toUnicode = objects.get(ref(font.dict, 'ToUnicode') ?? -1)?.stream;
      cmaps.set(name, parseCmap(toUnicode?.toString('latin1') ?? ''));
      const descendant = /\/DescendantFonts \[(\d+) 0 R\]/.exec(font.dict);
      const cid = objects.get(Number(descendant?.[1]));
      const descriptor = objects.get(ref(cid?.dict ?? '', 'FontDescriptor') ?? -1);
      const program = objects.get(ref(descriptor?.dict ?? '', 'FontFile2') ?? -1)?.stream ?? null;
      fonts.set(name, {
        baseFont: /\/BaseFont \/([^\s/]+)/.exec(font.dict)?.[1] ?? '',
        program,
      });
    }
    const content = objects.get(ref(page.dict, 'Contents') ?? -1)?.stream?.toString('latin1') ?? '';
    let font = '';
    let x = 0;
    let y = 0;
    for (const m of content.matchAll(
      /\/(\w+) [\d.]+ Tf|[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ ([-\d.]+) ([-\d.]+) Tm|\[([^\]]*)\] TJ/g,
    )) {
      if (m[1]) font = m[1];
      else if (m[2]) {
        x = Number(m[2]);
        y = Number(m[3]);
      } else {
        const codes = [...(m[4] ?? '').matchAll(/<([0-9a-f]+)>/gi)].flatMap(
          (h) => (h[1] ?? '').match(/.{4}/g)?.map((c) => parseInt(c, 16)) ?? [],
        );
        const cmap = cmaps.get(font);
        runs.push({
          page: pageNumber,
          font,
          x,
          y,
          codes,
          glyphs: codes.map((c) => cmap?.get(c) ?? '�'),
        });
      }
    }
  }
  // Top to bottom: by page, then by height on the page (PDF y grows upwards).
  const byLine = new Map<number, DrawnRun[]>();
  for (const run of runs) {
    const key = run.page * 10_000 + (10_000 - Math.round(run.y));
    byLine.set(key, [...(byLine.get(key) ?? []), run]);
  }
  const lines = [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => r.sort((a, b) => a.x - b.x));
  return { objects, runs, fonts, lines };
}

/** A line as a viewer shows it, left to right, without spaces (glyphs only). */
export const visualText = (line: DrawnRun[]) => line.flatMap((r) => r.glyphs).join('');

/**
 * A right-to-left line read in its reading order: glyphs right to left, each glyph's own text kept
 * as it is (a ligature's characters are already in logical order). Spaces are not drawn, so none.
 */
export const rtlReading = (line: DrawnRun[]) =>
  line
    .flatMap((r) => r.glyphs)
    .reverse()
    .join('');
