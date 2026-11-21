/**
 * Guardrail engine (card 15.1). Policies come from the config snapshot; evaluation is pure and
 * lives on the hot path, so it must be cheap: no I/O, no regex compilation per request (patterns
 * are compiled lazily and cached by policy ID).
 */
import type {
  CanonicalRequest,
  CanonicalResponse,
  GuardrailHit,
  GuardrailPolicy,
  GuardrailStage,
} from '@dirouter/contracts';

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const CREDIT_CARD = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const NATIONAL_ID = /\b\d{10}\b/g;
const PHONE = /(?:\+?\d[\d\s-]{8,14}\d)/g;

/** Instruction-override heuristics; a score above 1 is treated as an injection attempt. */
const INJECTION_PATTERNS: { regex: RegExp; weight: number }[] = [
  { regex: /ignore (all )?(previous|above|prior) (instructions|rules|prompts)/i, weight: 2 },
  { regex: /(disregard|forget) (your|all|the) (instructions|rules|system prompt)/i, weight: 2 },
  { regex: /you are now|act as (a|an) (unrestricted|jailbroken|developer mode)/i, weight: 1 },
  { regex: /reveal (the )?(system prompt|hidden instructions)/i, weight: 2 },
  { regex: /<\/?(system|assistant)>/i, weight: 1 },
  { regex: /\bDAN\b|developer mode enabled/i, weight: 1 },
];

const PII_PATTERNS: Record<string, RegExp> = {
  email: EMAIL,
  credit_card: CREDIT_CARD,
  iban: IBAN,
  national_id: NATIONAL_ID,
  phone: PHONE,
};

/** Luhn checksum: separates real card numbers from any other run of 13 to 19 digits. */
export function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Iranian national code (کد ملی): 10 digits with a mod-11 check digit; repdigits are invalid. */
export function iranNationalIdValid(value: string): boolean {
  if (!/^\d{10}$/.test(value) || /^(\d)\1{9}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (value.charCodeAt(i) - 48) * (10 - i);
  const remainder = sum % 11;
  const check = value.charCodeAt(9) - 48;
  return remainder < 2 ? check === remainder : check === 11 - remainder;
}

/** Extra validation after the regex matched, so a random number is not treated as PII. */
const PII_VALIDATORS: Record<string, (match: string) => boolean> = {
  credit_card: luhnValid,
  national_id: iranNationalIdValid,
};

/** Policy config is free-form JSON: only real strings are used, anything else gets the default. */
const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

const REGEX_CACHE = new Map<string, RegExp>();

/**
 * Conservative check against catastrophic backtracking: bounded length, and no quantified group
 * whose body is itself quantified or alternated with a quantifier (`(a+)+`, `(a|aa)*`, `(.*)*`).
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > 512) return false;
  // A group containing a quantifier, followed by a quantifier.
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern))
    return false;
  // A group containing an alternation, followed by an unbounded quantifier.
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\})/.test(pattern)) return false;
  return true;
}

function compile(pattern: string, flags = 'g'): RegExp | undefined {
  const key = `${flags}/${pattern}`;
  const cached = REGEX_CACHE.get(key);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }
  // Patterns run on the request path. The control plane rejects unsafe ones when a policy is
  // saved; this is the second line of defence for snapshots that predate that check.
  if (!isSafePattern(pattern)) return undefined;
  try {
    const re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
    if (REGEX_CACHE.size > 500) REGEX_CACHE.clear();
    REGEX_CACHE.set(key, re);
    return re;
  } catch {
    return undefined;
  }
}

export interface GuardrailResult {
  blocked?: { policy: GuardrailPolicy; message: string };
  hits: GuardrailHit[];
  /** Number of redacted/replaced matches. */
  redactions: number;
}

export interface GuardrailInput {
  stage: Exclude<GuardrailStage, 'both'>;
  request?: CanonicalRequest;
  response?: CanonicalResponse;
  estimatedInputTokens?: number;
}

function stringsOf(
  request: CanonicalRequest,
): { get: () => string; set: (value: string) => void }[] {
  const out: { get: () => string; set: (value: string) => void }[] = [];
  request.system.forEach((part, i) => {
    out.push({
      get: () => part.text,
      set: (value) => {
        const next = request.system[i];
        if (next) next.text = value;
      },
    });
  });
  request.messages.forEach((message) => {
    message.content.forEach((part, i) => {
      if (part.type === 'text')
        out.push({
          get: () => part.text,
          set: (value) => {
            const next = message.content[i];
            if (next?.type === 'text') next.text = value;
          },
        });
      // Tool output is prompt text too (file contents, command output): it is checked and
      // redacted like a user message.
      else if (part.type === 'tool_result')
        part.content.forEach((inner) => {
          if (inner.type === 'text')
            out.push({
              get: () => inner.text,
              set: (value) => {
                inner.text = value;
              },
            });
        });
    });
  });
  return out;
}

function responseStrings(response: CanonicalResponse) {
  return response.content.flatMap((part, i) =>
    part.type === 'text'
      ? [
          {
            get: () => part.text,
            set: (value: string) => {
              const next = response.content[i];
              if (next?.type === 'text') next.text = value;
            },
          },
        ]
      : [],
  );
}

function matchAll(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let count = 0;
  while (re.exec(text) !== null) {
    count += 1;
    if (re.lastIndex === 0) break;
    if (count > 10_000) break;
  }
  return count;
}

/** Like `matchAll`, counting only matches that pass the validator (Luhn, national code). */
function matchValid(re: RegExp, text: string, valid: (match: string) => boolean): number {
  re.lastIndex = 0;
  let count = 0;
  let seen = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (valid(match[0])) count += 1;
    if (re.lastIndex === 0 || ++seen > 10_000) break;
  }
  return count;
}

/**
 * Applies every enabled policy for the stage in order. A blocking policy stops evaluation and
 * returns the client-facing message; redaction rewrites the canonical text in place.
 */
export function evaluateGuardrails(
  policies: readonly GuardrailPolicy[],
  input: GuardrailInput,
): GuardrailResult {
  const hits: GuardrailHit[] = [];
  let redactions = 0;
  const targets =
    input.stage === 'request' && input.request
      ? stringsOf(input.request)
      : input.stage === 'response' && input.response
        ? responseStrings(input.response)
        : [];

  for (const policy of policies) {
    if (!policy.enabled) continue;
    if (policy.stage !== 'both' && policy.stage !== input.stage) continue;
    if (policy.type === 'max_input_tokens') {
      const max = Number(policy.config.maxTokens ?? 0);
      const used = input.estimatedInputTokens ?? 0;
      if (max > 0 && used > max) {
        hits.push({
          policyId: policy.id,
          name: policy.name,
          type: policy.type,
          action: policy.action,
          matches: used,
        });
        if (policy.action === 'block')
          return {
            blocked: {
              policy,
              message:
                policy.message ??
                `Request exceeds the guardrail limit of ${String(max)} input tokens`,
            },
            hits,
            redactions,
          };
      }
      continue;
    }

    if (policy.type === 'prompt_injection') {
      let score = 0;
      for (const target of targets) {
        const text = target.get();
        for (const rule of INJECTION_PATTERNS) {
          rule.regex.lastIndex = 0;
          if (rule.regex.test(text)) score += rule.weight;
        }
      }
      if (score >= 2) {
        hits.push({
          policyId: policy.id,
          name: policy.name,
          type: policy.type,
          action: policy.action,
          matches: score,
        });
        if (policy.action === 'block')
          return {
            blocked: {
              policy,
              message: policy.message ?? 'Request blocked: possible prompt injection',
            },
            hits,
            redactions,
          };
      }
      continue;
    }

    const pattern =
      policy.type === 'regex'
        ? compile(text(policy.config.pattern, ''), text(policy.config.flags, 'g'))
        : policy.type === 'pii'
          ? PII_PATTERNS[text(policy.config.type, 'email')]
          : undefined;

    if (policy.type === 'keyword') {
      const terms = Array.isArray(policy.config.terms)
        ? policy.config.terms.map(String)
        : text(policy.config.terms, '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
      const caseSensitive = policy.config.caseSensitive === true;
      let total = 0;
      for (const target of targets) {
        let text = target.get();
        for (const term of terms) {
          if (!term) continue;
          const re = compile(
            term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            caseSensitive ? 'g' : 'gi',
          );
          if (!re) continue;
          const count = matchAll(re, text);
          if (count === 0) continue;
          total += count;
          if (policy.action === 'redact') {
            text = text.replace(re, '[REDACTED]');
            target.set(text);
          }
        }
      }
      if (total > 0) {
        hits.push({
          policyId: policy.id,
          name: policy.name,
          type: policy.type,
          action: policy.action,
          matches: total,
        });
        if (policy.action === 'redact') redactions += total;
        if (policy.action === 'block')
          return {
            blocked: {
              policy,
              message: policy.message ?? `Request blocked by guardrail '${policy.name}'`,
            },
            hits,
            redactions,
          };
      }
      continue;
    }

    if (!pattern) continue;
    const valid =
      policy.type === 'pii' ? PII_VALIDATORS[text(policy.config.type, 'email')] : undefined;
    let total = 0;
    for (const target of targets) {
      let text = target.get();
      const count = valid ? matchValid(pattern, text, valid) : matchAll(pattern, text);
      if (count === 0) continue;
      total += count;
      if (policy.action === 'redact') {
        pattern.lastIndex = 0;
        text = text.replace(pattern, (match) => (!valid || valid(match) ? '[REDACTED]' : match));
        target.set(text);
      }
    }
    if (total > 0) {
      hits.push({
        policyId: policy.id,
        name: policy.name,
        type: policy.type,
        action: policy.action,
        matches: total,
      });
      if (policy.action === 'redact') redactions += total;
      if (policy.action === 'block')
        return {
          blocked: {
            policy,
            message: policy.message ?? `Request blocked by guardrail '${policy.name}'`,
          },
          hits,
          redactions,
        };
    }
  }
  return { hits, redactions };
}

/**
 * Policies that apply to a request: those of the key's organization, minus the ones narrowed to
 * another project or another virtual key.
 */
export function policiesFor(
  policies: readonly GuardrailPolicy[],
  key: { id: string; organizationId: string; projectId: string },
): GuardrailPolicy[] {
  return policies.filter(
    (policy) =>
      policy.organizationId === key.organizationId &&
      (policy.projectId === undefined || policy.projectId === key.projectId) &&
      (policy.virtualKeyId === undefined || policy.virtualKeyId === key.id),
  );
}

/**
 * Cross-chunk response redaction for streaming (card 15.1).
 *
 * Matches can straddle SSE deltas, so text is held in a small tail buffer (default 256 chars) before
 * being released: the buffer is redacted on every push and only the part that can no longer contain a
 * match is emitted. A blocking policy aborts the stream with an error event.
 */
export class StreamGuardrailBuffer {
  #buffer = '';
  #policies: readonly GuardrailPolicy[];
  #window: number;

  constructor(policies: readonly GuardrailPolicy[], window = 256) {
    this.#policies = policies.filter(
      (policy) => policy.enabled && (policy.stage === 'response' || policy.stage === 'both'),
    );
    this.#window = Math.max(64, window);
  }

  get active(): boolean {
    return this.#policies.length > 0;
  }

  #evaluate(text: string): { text: string; blocked?: { message: string } } {
    const fake = {
      id: 'stream',
      model: 'stream',
      content: [{ type: 'text' as const, text }],
      finishReason: 'stop' as const,
      created: 0,
    } as CanonicalResponse;
    const result = evaluateGuardrails(this.#policies, { stage: 'response', response: fake });
    if (result.blocked) return { text: '', blocked: { message: result.blocked.message } };
    const part = fake.content[0];
    return { text: part?.type === 'text' ? part.text : text };
  }

  /** Index just after the last whitespace character, or 0 when the text has none. */
  static #lastBoundary(text: string, before = text.length): number {
    for (let i = before - 1; i >= 0; i--) {
      const code = text.charCodeAt(i);
      if (code === 32 || code === 10 || code === 9 || code === 13) return i + 1;
    }
    return 0;
  }

  push(delta: string): { text: string; blocked?: string } {
    if (!this.active) return { text: delta };
    this.#buffer += delta;
    // Only complete words are evaluated. The word still being received is kept raw: matching it
    // early would redact "user@example.co" and then leak the "m" that arrives in the next chunk.
    // A run with no whitespace at all (longer than four windows) is evaluated anyway to bound
    // memory and delay.
    let stableEnd = StreamGuardrailBuffer.#lastBoundary(this.#buffer);
    if (this.#buffer.length - stableEnd > this.#window * 4) stableEnd = this.#buffer.length;
    if (stableEnd === 0) return { text: '' };
    const evaluated = this.#evaluate(this.#buffer.slice(0, stableEnd));
    if (evaluated.blocked) {
      this.#buffer = '';
      return { text: '', blocked: evaluated.blocked.message };
    }
    const tail = this.#buffer.slice(stableEnd);
    this.#buffer = evaluated.text + tail;
    const stable = evaluated.text.length;
    // Keep the last `window` characters of evaluated text so multi-word patterns that continue in
    // later chunks can still match, and release the rest up to a word boundary.
    if (stable <= this.#window) return { text: '' };
    const cut = StreamGuardrailBuffer.#lastBoundary(this.#buffer, stable - this.#window);
    if (cut === 0) return { text: '' };
    const out = this.#buffer.slice(0, cut);
    this.#buffer = this.#buffer.slice(cut);
    return { text: out };
  }

  /** End of stream: the held-back text is final now, so the last word is evaluated too. */
  finish(): { text: string; blocked?: string } {
    const rest = this.#buffer;
    this.#buffer = '';
    if (!this.active || rest === '') return { text: rest };
    const evaluated = this.#evaluate(rest);
    if (evaluated.blocked) return { text: '', blocked: evaluated.blocked.message };
    return { text: evaluated.text };
  }

  /** Like `finish`, for callers that only need the text; blocked content is dropped. */
  flush(): string {
    return this.finish().text;
  }
}
