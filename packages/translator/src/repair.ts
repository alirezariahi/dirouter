/**
 * Response and conversation repair (card 31.1).
 *
 * Weaker models break JSON (code fences, prose around it, trailing commas, single quotes, Python
 * literals, a truncated tail) and agent clients replay histories that providers reject (a tool call
 * without its result, a result without its call, the same call twice). Everything here is
 * conservative: valid input is returned untouched, and a repair is only kept when the result parses.
 */
import type {
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalToolCallPart,
  CanonicalToolResultPart,
  RepairKind,
} from '@dirouter/contracts';

/** What can be repaired; a key or the `x-dirouter-repair` header enables a subset. */
export const REPAIR_KINDS: readonly RepairKind[] = ['json', 'tools'];

/** One applied repair, for logs and the `dirouter_repairs_total` metric. */
export type RepairAction =
  | 'json'
  | 'tool_arguments'
  | 'tool_duplicate_call'
  | 'tool_duplicate_result'
  | 'tool_orphan_result'
  | 'tool_moved_result'
  | 'tool_missing_result';

const isValidJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

const LITERALS: Readonly<Record<string, string>> = {
  true: 'true',
  false: 'false',
  null: 'null',
  True: 'true',
  False: 'false',
  None: 'null',
  undefined: 'null',
};

/** Body of the first fenced code block, when the text has one. */
function unfence(text: string): string {
  const fenced = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)(?:```|$)/.exec(text);
  return fenced?.[1] !== undefined && fenced[1].trim() !== '' ? fenced[1] : text;
}

/**
 * Rewrites almost-JSON into JSON in one pass: strips comments, quotes bare keys, turns single
 * quotes into double quotes, maps Python/JS literals, inserts a missing comma between values,
 * drops trailing commas, and closes a truncated string, array or object. Text after the root value
 * is ignored. Returns undefined when the input has something it does not understand.
 */
function rewrite(source: string): string | undefined {
  let out = '';
  const stack: ('}' | ']')[] = [];
  let i = 0;
  let done = false;
  const lastSignificant = () => out.trimEnd().at(-1);
  const endsValue = () => {
    const last = lastSignificant();
    return last !== undefined && /["}\]0-9a-z]/.test(last);
  };
  /** A value starts here: separate it from a previous value that lacks its comma. */
  const beginValue = () => {
    if (stack.length > 0 && endsValue()) out = `${out.trimEnd()},`;
  };
  const dropTrailingComma = () => {
    const trimmed = out.trimEnd();
    if (trimmed.endsWith(',')) out = trimmed.slice(0, -1);
  };

  while (i < source.length && !done) {
    const ch = source[i] ?? '';
    if (ch === '"' || ch === "'") {
      beginValue();
      const quote = ch;
      out += '"';
      i++;
      let closed = false;
      while (i < source.length) {
        const c = source[i] ?? '';
        if (c === '\\') {
          const next = source[i + 1] ?? '';
          // `\'` is only an escape inside single quotes; JSON has no such escape.
          out += next === "'" ? "'" : `\\${next}`;
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        if (c === '"') out += '\\"';
        else if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else out += c;
        i++;
      }
      out += '"';
      if (!closed) break;
      continue;
    }
    if (ch === '{' || ch === '[') {
      beginValue();
      stack.push(ch === '{' ? '}' : ']');
      out += ch;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      dropTrailingComma();
      const expected = stack.pop();
      if (expected === undefined) return undefined;
      out += expected;
      i++;
      if (stack.length === 0) done = true;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === ',' || ch === ':') {
      out += ch;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    if (/[-+0-9.]/.test(ch)) {
      const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(source.slice(i));
      if (!match) return undefined;
      beginValue();
      let number = match[0].replace(/^\+/, '');
      if (/^-?\./.test(number)) number = number.replace('.', '0.');
      if (number.endsWith('.')) number += '0';
      out += number;
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const word = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(source.slice(i))?.[0] ?? ch;
      const rest = source.slice(i + word.length);
      beginValue();
      if (/^\s*:/.test(rest)) out += JSON.stringify(word);
      else if (LITERALS[word] !== undefined) out += LITERALS[word];
      else return undefined;
      i += word.length;
      continue;
    }
    return undefined;
  }

  if (!done) {
    // Truncated: finish the dangling key/value, then close what is still open.
    let tail = out.trimEnd();
    if (tail.endsWith(':')) tail += ' null';
    if (tail.endsWith(',')) tail = tail.slice(0, -1);
    out = tail + stack.reverse().join('');
  }
  return out;
}

/**
 * The JSON the text was meant to be, or undefined when it is already valid JSON or cannot be
 * repaired with confidence.
 */
export function repairJson(text: string): string | undefined {
  if (isValidJson(text)) return undefined;
  const body = unfence(text.trim()).trim();
  if (body !== text && isValidJson(body)) return body;
  const start = body.search(/[{[]/);
  if (start === -1) return undefined;
  const rewritten = rewrite(body.slice(start));
  return rewritten !== undefined && isValidJson(rewritten) ? rewritten : undefined;
}

/** Tool-call arguments as valid JSON (`{}` for empty), or undefined when they are fine already. */
function repairArguments(raw: string): string | undefined {
  if (raw.trim() === '') return undefined;
  return repairJson(raw);
}

// ───────────── responses ─────────────

/**
 * Repairs a non-streamed answer: the text when the request asked for JSON (`response_format`) and
 * the arguments of every tool call. Returns the original object when nothing changed.
 */
export function repairResponse(
  response: CanonicalResponse,
  request: Pick<CanonicalRequest, 'responseFormat'>,
  kinds: readonly RepairKind[],
): { response: CanonicalResponse; actions: RepairAction[] } {
  const actions: RepairAction[] = [];
  let content = response.content;
  const format = request.responseFormat?.type;
  if (kinds.includes('json') && (format === 'json_object' || format === 'json_schema')) {
    const texts = content.filter((p) => p.type === 'text');
    const text = texts.map((p) => p.text).join('');
    const fixed = text.trim() === '' ? undefined : repairJson(text);
    if (fixed !== undefined) {
      actions.push('json');
      let placed = false;
      content = content.flatMap((part): CanonicalPart[] => {
        if (part.type !== 'text') return [part];
        if (placed) return [];
        placed = true;
        return [{ type: 'text', text: fixed }];
      });
    }
  }
  if (kinds.includes('tools')) {
    content = content.map((part) => {
      if (part.type !== 'tool_call') return part;
      const fixed = repairArguments(part.arguments);
      if (fixed === undefined) return part;
      actions.push('tool_arguments');
      return { ...part, arguments: fixed };
    });
  }
  return actions.length ? { response: { ...response, content }, actions } : { response, actions };
}

// ───────────── conversation history ─────────────

const MISSING_RESULT_TEXT =
  'No result was recorded for this tool call (added by DiRouter to keep the conversation valid).';

function orphanText(result: CanonicalToolResultPart): string {
  const body = result.content
    .map((p) => (p.type === 'text' ? p.text : '[image]'))
    .join('\n')
    .trim();
  return `Result of tool call ${result.toolCallId}${result.isError ? ' (error)' : ''}:\n${body}`;
}

/**
 * Makes a replayed conversation acceptable to every provider before it is sent:
 *
 * - a tool call repeated with the same id is kept once;
 * - every tool call gets its result in the tool turn right after it: a result sent later (or
 *   twice) is moved there, and a call without any result gets an error result saying so;
 * - a result whose call is nowhere in the history becomes plain user text, so nothing is lost;
 * - broken JSON in replayed tool arguments is repaired.
 *
 * A trailing assistant turn whose calls have no results yet is left alone. Returns the original
 * request when nothing changed.
 */
export function repairToolHistory(request: CanonicalRequest): {
  request: CanonicalRequest;
  actions: RepairAction[];
} {
  const actions: RepairAction[] = [];
  const callIds = new Set<string>();
  const results = new Map<string, CanonicalToolResultPart>();
  /** Position of each result in the original history, to keep the client's order. */
  const order = new Map<string, number>();
  for (const message of request.messages)
    for (const part of message.content) {
      if (part.type === 'tool_call') callIds.add(part.id);
      else if (part.type === 'tool_result') {
        if (results.has(part.toolCallId)) actions.push('tool_duplicate_result');
        else {
          results.set(part.toolCallId, part);
          order.set(part.toolCallId, order.size);
        }
      }
    }

  const emittedCalls = new Set<string>();
  const placedResults = new Set<string>();
  const messages: CanonicalMessage[] = [];
  const last = request.messages.length - 1;
  for (const [index, message] of request.messages.entries()) {
    if (message.role === 'tool') {
      const rest: CanonicalPart[] = [];
      const orphans: CanonicalPart[] = [];
      for (const part of message.content) {
        if (part.type !== 'tool_result') rest.push(part);
        else if (!callIds.has(part.toolCallId)) {
          actions.push('tool_orphan_result');
          orphans.push({ type: 'text', text: orphanText(part) });
        }
        // Results of known calls were placed right after their call (or are duplicates).
      }
      if (rest.length) messages.push({ ...message, content: rest });
      if (orphans.length) {
        const previous = messages.at(-1);
        if (previous?.role === 'user') previous.content = [...previous.content, ...orphans];
        else messages.push({ role: 'user', content: orphans });
      }
      continue;
    }
    if (message.role !== 'assistant') {
      messages.push(message);
      continue;
    }
    const calls: CanonicalToolCallPart[] = [];
    const content: CanonicalPart[] = [];
    let changed = false;
    for (const part of message.content) {
      if (part.type !== 'tool_call') {
        content.push(part);
        continue;
      }
      if (emittedCalls.has(part.id)) {
        actions.push('tool_duplicate_call');
        changed = true;
        continue;
      }
      emittedCalls.add(part.id);
      const fixed = repairArguments(part.arguments);
      const call = fixed === undefined ? part : { ...part, arguments: fixed };
      if (fixed !== undefined) {
        actions.push('tool_arguments');
        changed = true;
      }
      calls.push(call);
      content.push(call);
    }
    if (content.length) messages.push(changed ? { ...message, content } : message);
    if (calls.length === 0) continue;
    const answered = calls.filter((c) => results.has(c.id));
    // The last turn of the conversation may legitimately wait for its results.
    if (index === last && answered.length === 0) continue;
    const byOrder = [...calls].sort(
      (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
    );
    const resultParts = byOrder.map((call): CanonicalToolResultPart => {
      const result = results.get(call.id);
      if (result && !placedResults.has(call.id)) {
        placedResults.add(call.id);
        return result;
      }
      actions.push('tool_missing_result');
      return {
        type: 'tool_result',
        toolCallId: call.id,
        content: [{ type: 'text', text: MISSING_RESULT_TEXT }],
        isError: true,
      };
    });
    messages.push({ role: 'tool', content: resultParts });
  }

  // Without another repair, a structural difference means a result was moved next to its call.
  if (actions.length === 0) {
    if (sameMessages(messages, request.messages)) return { request, actions };
    actions.push('tool_moved_result');
  }
  return { request: { ...request, messages }, actions };
}

function sameMessages(a: readonly CanonicalMessage[], b: readonly CanonicalMessage[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Parses `x-dirouter-repair` (`json`, `tools`, `all`, `none`/`off`) into kinds, or undefined. */
export function parseRepairHeader(value: string | undefined): RepairKind[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (items.length === 0) return undefined;
  if (items.some((v) => v === 'none' || v === 'off' || v === 'false')) return [];
  if (items.some((v) => v === 'all' || v === 'on' || v === 'true')) return [...REPAIR_KINDS];
  return REPAIR_KINDS.filter((kind) => items.includes(kind));
}
