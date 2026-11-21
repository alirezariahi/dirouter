/**
 * Conservative static check for user-supplied guardrail regexes (cards 15.1 and 15.2); free of
 * framework imports.
 *
 * JavaScript regexes backtrack, so a pattern such as `(a+)+$` takes exponential time on a short
 * non-matching input. These patterns run in the preview endpoint and on the gateway hot path, so
 * the shapes that are known to blow up are refused when a policy is saved or previewed:
 * - a repeated group whose body already contains a repetition (`(a+)+`, `(\d*)*`, `(.+){2,}`);
 * - a repeated group with alternatives that can match the same text (`(a|a)+`, `(\w|\d)+`, `(a|)+`);
 * - backreferences.
 *
 * The check errs on the side of refusing. It does not prove a pattern is linear (several adjacent
 * `.*` are still polynomial), which is why lengths are capped and the preview also runs under a
 * time limit.
 */

export const MAX_PATTERN_LENGTH = 1_000;
const ALLOWED_FLAGS = /^[dgimsuy]{0,7}$/;

interface Frame {
  /** Index of the first body character (after `(` and any `?:`-style prefix). */
  start: number;
  hasRepeat: boolean;
  /** Indexes of top-level `|` inside this group. */
  bars: number[];
}

/**
 * Length of a repeating quantifier at `i`, else 0. `*`, `+` and every counted form that allows
 * more than one repetition count (`{n}` included: a fixed count still multiplies what is inside).
 * `?` does not repeat, so it is not one.
 */
function repeatAt(pattern: string, i: number): number {
  const ch = pattern[i];
  if (ch === '*' || ch === '+') return 1;
  if (ch !== '{') return 0;
  const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
  if (!match) return 0;
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
  return max > 1 ? match[0].length : 0;
}

/** First atom of an alternative, or '' for an empty one. Literals are returned as themselves. */
function firstAtom(alternative: string): string {
  if (alternative === '') return '';
  const ch = alternative[0] ?? '';
  if (ch === '\\') return alternative.slice(0, 2);
  return ch;
}

/** True when two alternatives of a repeated group may start on the same character. */
function ambiguous(alternatives: string[]): boolean {
  const seen = new Set<string>();
  for (const alternative of alternatives) {
    const atom = firstAtom(alternative);
    // Empty alternatives, wildcards, classes, class escapes and nested groups can overlap anything.
    if (atom === '' || atom === '.' || atom === '[' || atom === '(' || atom === '^' || atom === '$')
      return true;
    if (atom.length === 2 && /[A-Za-z0-9]/.test(atom[1] ?? '')) return true;
    const key = atom.length === 2 ? (atom[1] ?? '') : atom;
    if (seen.has(key.toLowerCase())) return true;
    seen.add(key.toLowerCase());
  }
  return false;
}

/** Returns a human-readable reason when the pattern must be refused, otherwise undefined. */
export function unsafeRegexReason(pattern: string, flags = 'gu'): string | undefined {
  if (pattern.length === 0) return 'pattern is empty';
  if (pattern.length > MAX_PATTERN_LENGTH)
    return `pattern is longer than ${String(MAX_PATTERN_LENGTH)} characters`;
  if (!ALLOWED_FLAGS.test(flags)) return 'invalid regex flags';
  try {
    new RegExp(pattern, flags);
  } catch {
    return 'invalid regex pattern';
  }

  const stack: Frame[] = [{ start: 0, hasRepeat: false, bars: [] }];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? '';
    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') return 'backreferences are not allowed';
      i += 2;
    } else if (ch === '[') {
      // Skip the whole character class; it is a single atom.
      i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === '(') {
      const prefix = /^\((\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>))?/.exec(pattern.slice(i));
      i += prefix?.[0].length ?? 1;
      stack.push({ start: i, hasRepeat: false, bars: [] });
      continue;
    } else if (ch === ')') {
      const frame = stack.pop();
      if (!frame || stack.length === 0) return 'invalid regex pattern';
      const repeat = repeatAt(pattern, i + 1);
      if (repeat > 0) {
        if (frame.hasRepeat) return 'nested quantifiers are not allowed';
        if (frame.bars.length > 0) {
          const bounds = [frame.start - 1, ...frame.bars, i];
          const alternatives = bounds
            .slice(0, -1)
            .map((from, index) => pattern.slice(from + 1, bounds[index + 1]));
          if (ambiguous(alternatives))
            return 'a repeated group has alternatives that can match the same text';
        }
      }
      if (repeat > 0 || frame.hasRepeat) top().hasRepeat = true;
      i += 1 + repeat;
      continue;
    } else if (ch === '|') {
      top().bars.push(i);
      i += 1;
    } else i += 1;

    // An atom has just been consumed: a repetition right after it marks the enclosing group.
    const repeat = repeatAt(pattern, i);
    if (repeat > 0) {
      top().hasRepeat = true;
      i += repeat;
    }
  }
  return undefined;
}
