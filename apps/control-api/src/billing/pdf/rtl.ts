/**
 * Right-to-left text for PDF pages (card 26.1).
 *
 * PDF has no notion of text direction: a page draws glyphs left to right where it is told. So a
 * line is ordered here with the Unicode Bidirectional Algorithm (bidi-js), cut into visual chunks
 * of one direction without spaces, and each chunk is drawn at its own x. Letters are joined
 * (initial, medial, final forms) by fontkit's OpenType shaper, through pdfkit, chunk by chunk.
 *
 * fontkit decides a run's direction from its script, not from bidi: it reverses any run with
 * Arabic-script characters. A chunk is therefore handed over in the order that makes fontkit's
 * output come out in visual order: right-to-left letters in logical order (fontkit reverses them),
 * Persian digits (left-to-right but Arabic script) pre-reversed, and anything else as it is seen.
 */
import bidiFactory, { type Bidi } from 'bidi-js';

// bidi-js is CommonJS whose module.exports is the factory, but its types declare an ES default
// export, which TypeScript then reads as the module object. The value is the factory.
const bidi = (bidiFactory as unknown as () => Bidi)();

/** Characters fontkit treats as right-to-left script (Hebrew, Arabic and their presentation forms). */
const RTL_SCRIPT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const SPACE = /\s/;
/** Directional formatting characters: they steer the algorithm and are never drawn. */
const CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/**
 * Marks text as a left-to-right island (an isolate) inside right-to-left text, so that, for
 * example, `2026-10` after Persian words is not read as Arabic numbers and shown as `10-2026`.
 */
export const ltr = (text: string) => `\u2066${text}\u2069`;

export interface VisualChunk {
  /** Text to hand to the shaper so that its glyphs come out in visual order. */
  shape: string;
  /** The chunk's characters in logical (reading) order, after mirroring. */
  logical: string;
  rtl: boolean;
  /** A run of whitespace: advances the pen and draws nothing. */
  space: boolean;
}

const reverse = (s: string) => Array.from(s).reverse().join('');

/** One line of text as visual chunks, left to right. `base` is the paragraph direction. */
export function visualChunks(text: string, base: 'rtl' | 'ltr' = 'rtl'): VisualChunk[] {
  if (text === '') return [];
  const levels = bidi.getEmbeddingLevels(text, base);
  const order = bidi.getReorderedIndices(text, levels);
  const mirrored = bidi.getMirroredCharactersMap(text, levels.levels);
  const chunks: VisualChunk[] = [];
  let visual = '';
  let rtl = false;
  let space = false;
  const flush = () => {
    if (visual === '') return;
    if (space) chunks.push({ shape: visual, logical: visual, rtl, space });
    else {
      const logical = rtl ? reverse(visual) : visual;
      const scriptRtl = RTL_SCRIPT.test(logical);
      chunks.push({ shape: rtl === scriptRtl ? logical : reverse(logical), logical, rtl, space });
    }
    visual = '';
  };
  for (const index of order) {
    const original = text[index] ?? '';
    if (CONTROLS.test(original)) continue;
    const ch = mirrored.get(index) ?? original;
    const isSpace = SPACE.test(original);
    const isRtl = ((levels.levels[index] ?? 0) & 1) === 1;
    if (visual !== '' && (isSpace !== space || (!isSpace && isRtl !== rtl))) flush();
    space = isSpace;
    rtl = isRtl;
    visual += ch;
  }
  flush();
  return chunks;
}

/** Splits text into lines no wider than `width`, breaking at spaces (logical order). */
export function wrapWords(text: string, width: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && measure(next) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line !== '') lines.push(line);
  return lines;
}
