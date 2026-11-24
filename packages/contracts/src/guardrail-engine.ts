/**
 * Guardrail engine (cards 15.1 and 23.1), shared by the gateway (enforcement) and the control
 * plane's live test, so a policy behaves the same in the panel and in real traffic.
 *
 * Evaluation is pure and runs on the hot path: no I/O, and regexes are compiled once and cached.
 */
import type { CanonicalRequest, CanonicalResponse } from './canonical.js';
import type { GuardrailHit, GuardrailPolicy, GuardrailStage } from './guardrails.js';

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const CREDIT_CARD = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const NATIONAL_ID = /\b\d{10}\b/g;
const PHONE = /(?:\+?\d[\d\s-]{8,14}\d)/g;

/** Instruction-override heuristics; a score of 2 or more is treated as an injection attempt. */
const INJECTION_PATTERNS: { regex: RegExp; weight: number }[] = [
  { regex: /ignore (all )?(previous|above|prior) (instructions|rules|prompts)/i, weight: 2 },
  { regex: /(disregard|forget) (your|all|the) (instructions|rules|system prompt)/i, weight: 2 },
  { regex: /you are now|act as (a|an) (unrestricted|jailbroken|developer mode)/i, weight: 1 },
  { regex: /reveal (the |your )?(system prompt|hidden instructions)/i, weight: 2 },
  { regex: /<\/?(system|assistant)>/i, weight: 1 },
  { regex: /\bDAN\b|developer mode enabled/i, weight: 1 },
  { regex: /دستورات?\s*(قبلی|بالا)\s*را\s*نادیده/, weight: 2 },
];

const PII_PATTERNS: Record<string, RegExp> = {
  email: EMAIL,
  credit_card: CREDIT_CARD,
  iban: IBAN,
  national_id: NATIONAL_ID,
  phone: PHONE,
};

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * Credentials the `secret` type looks for. Each needs a fixed prefix and enough entropy-sized
 * body, so ordinary prose does not match. A PEM private key is matched as a whole block.
 */
export const SECRET_PATTERNS: readonly { name: string; regex: RegExp }[] = [
  {
    name: 'private_key',
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  // A key with no END line (an answer cut off by max_tokens, or the end of a stream): everything
  // from the BEGIN line on is treated as key material.
  {
    name: 'private_key_unterminated',
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?![\s\S]*-----END [A-Z0-9 ]*PRIVATE KEY)[\s\S]*/g,
  },
  // OpenAI (sk-, sk-proj-) and Anthropic (sk-ant-) keys.
  { name: 'sk_key', regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'dirouter_key', regex: /\bdr-[a-z2-9]{8}-[a-z2-9]{40}\b/g },
  { name: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    name: 'github_token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  { name: 'slack_token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g },
];

/**
 * Start of a PEM private key whose END line has not arrived yet, or -1. The stream buffer holds
 * text from here on so a key split over many chunks is still caught as one block.
 */
export function pendingPrivateKeyStart(text: string): number {
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = PRIVATE_KEY_BEGIN.exec(text)) !== null) last = match.index;
  if (last < 0) return -1;
  return /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(text.slice(last)) ? -1 : last;
}

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
const str = (value: unknown, fallback: string): string =>
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

// ---------------------------------------------------------------------------------------------
// JSON Schema subset
// ---------------------------------------------------------------------------------------------

/** Keywords the validator enforces. Annotations (title, description, …) are accepted and ignored. */
const SCHEMA_KEYWORDS = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'anyOf',
  'oneOf',
  'allOf',
]);
const SCHEMA_ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'format',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks the schema itself, so a policy cannot be saved with a schema the gateway would not
 * understand. Returns the first problem, or undefined when the schema is usable.
 */
export function jsonSchemaProblem(schema: unknown, path = '#', depth = 0): string | undefined {
  if (depth > 32) return `${path}: schema is nested too deeply`;
  if (typeof schema === 'boolean') return undefined;
  if (!isObject(schema)) return `${path}: a schema must be an object or a boolean`;
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_ANNOTATIONS.has(key)) continue;
    if (!SCHEMA_KEYWORDS.has(key)) return `${path}: unsupported keyword "${key}"`;
    const at = `${path}/${key}`;
    switch (key) {
      case 'type': {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0 || types.some((t) => typeof t !== 'string' || !SCHEMA_TYPES.has(t)))
          return `${at}: unknown type`;
        break;
      }
      case 'enum':
        if (!Array.isArray(value) || value.length === 0) return `${at}: must be a non-empty array`;
        break;
      case 'properties':
        if (!isObject(value)) return `${at}: must be an object`;
        for (const [name, sub] of Object.entries(value)) {
          const problem = jsonSchemaProblem(sub, `${at}/${name}`, depth + 1);
          if (problem) return problem;
        }
        break;
      case 'required':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
          return `${at}: must be an array of strings`;
        break;
      case 'additionalProperties':
      case 'items': {
        const problem = jsonSchemaProblem(value, at, depth + 1);
        if (problem) return problem;
        break;
      }
      case 'anyOf':
      case 'oneOf':
      case 'allOf':
        if (!Array.isArray(value) || value.length === 0) return `${at}: must be a non-empty array`;
        for (const [i, sub] of value.entries()) {
          const problem = jsonSchemaProblem(sub, `${at}/${String(i)}`, depth + 1);
          if (problem) return problem;
        }
        break;
      case 'pattern':
        if (typeof value !== 'string') return `${at}: must be a string`;
        if (!isSafePattern(value)) return `${at}: pattern may backtrack catastrophically`;
        try {
          new RegExp(value, 'u');
        } catch {
          return `${at}: invalid regular expression`;
        }
        break;
      case 'const':
        break;
      default:
        // Numeric limits.
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${at}: must be a number`;
        if (
          ['minItems', 'maxItems', 'minLength', 'maxLength'].includes(key) &&
          (!Number.isInteger(value) || value < 0)
        )
          return `${at}: must be a non-negative integer`;
    }
  }
  return undefined;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}

/**
 * Validates a value against the supported JSON Schema subset. Returns the problems found (at most
 * `limit`); an empty list means the value conforms.
 */
export function validateJsonSchema(
  value: unknown,
  schema: unknown,
  path = '$',
  errors: string[] = [],
  limit = 10,
): string[] {
  if (errors.length >= limit) return errors;
  if (schema === true) return errors;
  if (schema === false) {
    errors.push(`${path}: no value is allowed here`);
    return errors;
  }
  if (!isObject(schema)) return errors;
  const s = schema;
  const actual = typeOf(value);

  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${actual}`);
      return errors;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(v, value)))
    errors.push(`${path}: not one of the allowed values`);
  if (Object.hasOwn(s, 'const') && !deepEqual(s.const, value))
    errors.push(`${path}: must equal the constant value`);

  if (typeof value === 'string') {
    // JSON Schema counts code points: a surrogate pair is one character.
    const length = value.length - (value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);
    if (typeof s.minLength === 'number' && length < s.minLength)
      errors.push(`${path}: shorter than ${String(s.minLength)} characters`);
    if (typeof s.maxLength === 'number' && length > s.maxLength)
      errors.push(`${path}: longer than ${String(s.maxLength)} characters`);
    if (typeof s.pattern === 'string') {
      const re = compile(s.pattern, 'u');
      if (re && !re.test(value)) errors.push(`${path}: does not match the pattern`);
    }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum)
      errors.push(`${path}: below the minimum ${String(s.minimum)}`);
    if (typeof s.maximum === 'number' && value > s.maximum)
      errors.push(`${path}: above the maximum ${String(s.maximum)}`);
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum)
      errors.push(`${path}: must be greater than ${String(s.exclusiveMinimum)}`);
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum)
      errors.push(`${path}: must be less than ${String(s.exclusiveMaximum)}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems)
      errors.push(`${path}: fewer than ${String(s.minItems)} items`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems)
      errors.push(`${path}: more than ${String(s.maxItems)} items`);
    if (s.items !== undefined)
      value.forEach((item, i) => {
        validateJsonSchema(item, s.items, `${path}[${String(i)}]`, errors, limit);
      });
  }
  if (isObject(value)) {
    const properties = isObject(s.properties) ? s.properties : {};
    if (Array.isArray(s.required))
      for (const name of s.required as string[])
        if (!Object.hasOwn(value, name))
          errors.push(`${path}: missing required property "${name}"`);
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name))
        validateJsonSchema(child, properties[name], `${path}.${name}`, errors, limit);
      else if (s.additionalProperties !== undefined)
        validateJsonSchema(child, s.additionalProperties, `${path}.${name}`, errors, limit);
    }
  }
  const passes = (sub: unknown) => validateJsonSchema(value, sub, path, [], 1).length === 0;
  if (Array.isArray(s.allOf))
    for (const sub of s.allOf) validateJsonSchema(value, sub, path, errors, limit);
  if (Array.isArray(s.anyOf) && !s.anyOf.some(passes))
    errors.push(`${path}: matches none of anyOf`);
  if (Array.isArray(s.oneOf) && s.oneOf.filter(passes).length !== 1)
    errors.push(`${path}: must match exactly one of oneOf`);
  return errors.slice(0, limit);
}

/**
 * Parses the answer as JSON. A single surrounding Markdown code fence (```json … ```) is allowed,
 * because chat models often add one even when asked for bare JSON.
 */
export function parseJsonAnswer(text: string): { ok: true; value: unknown } | { ok: false } {
  let body = text.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(body);
  if (fenced) body = (fenced[1] ?? '').trim();
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/** Types this engine enforces; any other type in a snapshot is reported as unknown. */
export const ENFORCED_GUARDRAIL_TYPES: ReadonlySet<string> = new Set([
  'regex',
  'keyword',
  'pii',
  'secret',
  'json_schema',
  'max_input_tokens',
  'prompt_injection',
]);

export interface GuardrailResult {
  blocked?: { policy: GuardrailPolicy; message: string };
  hits: GuardrailHit[];
  /** Number of redacted/replaced matches. */
  redactions: number;
  /** Enabled policies of a type this engine does not know (newer control plane, typo in the DB). */
  unknown: GuardrailPolicy[];
  /** Matched text, only when `collectMatches` is set (live test); secrets are shortened. */
  matches?: string[];
  /** JSON Schema problems of the answer, for `json_schema` policies that failed. */
  schemaErrors?: string[];
}

export interface GuardrailInput {
  stage: Exclude<GuardrailStage, 'both'>;
  request?: CanonicalRequest;
  response?: CanonicalResponse;
  estimatedInputTokens?: number;
  /** Collect the matched text into `result.matches` (the panel's live test). */
  collectMatches?: boolean;
}

interface Target {
  get: () => string;
  set: (value: string) => void;
}

function requestTargets(request: CanonicalRequest): Target[] {
  const out: Target[] = [];
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

function responseTargets(response: CanonicalResponse): Target[] {
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

/** Runs `re` over `text`; counts the matches that pass `valid`, and redacts them when asked. */
function scan(
  re: RegExp,
  text: string,
  opts: { valid?: (match: string) => boolean; redact: boolean; found?: string[]; mask?: boolean },
): { count: number; text: string } {
  re.lastIndex = 0;
  let count = 0;
  let seen = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[0] === '') {
      re.lastIndex += 1;
    } else if (!opts.valid || opts.valid(match[0])) {
      count += 1;
      if (opts.found && opts.found.length < 50)
        opts.found.push(opts.mask ? `${match[0].slice(0, 8)}…` : match[0]);
    }
    if (re.lastIndex === 0 || ++seen > 10_000) break;
  }
  if (count === 0 || !opts.redact) return { count, text };
  re.lastIndex = 0;
  const redacted = text.replace(re, (m) =>
    m !== '' && (!opts.valid || opts.valid(m)) ? '[REDACTED]' : m,
  );
  return { count, text: redacted };
}

function keywordTerms(config: Record<string, unknown>): string[] {
  const raw = Array.isArray(config.terms)
    ? config.terms.map(String)
    : str(config.terms, '').split(',');
  return raw.map((t) => t.trim()).filter(Boolean);
}

/** The regexes a text-matching policy runs, with their validator; empty for other types. */
function matchersFor(
  policy: GuardrailPolicy,
): { re: RegExp; valid?: (m: string) => boolean; mask?: boolean }[] {
  switch (policy.type) {
    case 'regex': {
      const re = compile(str(policy.config.pattern, ''), str(policy.config.flags, 'g'));
      return re ? [{ re }] : [];
    }
    case 'pii': {
      const kind = str(policy.config.type, 'email');
      const re = PII_PATTERNS[kind];
      const valid = PII_VALIDATORS[kind];
      return re ? [{ re, ...(valid ? { valid } : {}) }] : [];
    }
    case 'secret':
      return SECRET_PATTERNS.map(({ regex }) => ({ re: regex, mask: true }));
    case 'keyword': {
      const flags = policy.config.caseSensitive === true ? 'g' : 'gi';
      return keywordTerms(policy.config).flatMap((term) => {
        const re = compile(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        return re ? [{ re }] : [];
      });
    }
    default:
      return [];
  }
}

/**
 * Applies every enabled policy for the stage in order. A blocking policy stops evaluation and
 * returns the client-facing message; redaction rewrites the canonical text in place.
 */
export function evaluateGuardrails(
  policies: readonly GuardrailPolicy[],
  input: GuardrailInput,
): GuardrailResult {
  const result: GuardrailResult = { hits: [], redactions: 0, unknown: [] };
  if (input.collectMatches) result.matches = [];
  const targets =
    input.stage === 'request' && input.request
      ? requestTargets(input.request)
      : input.stage === 'response' && input.response
        ? responseTargets(input.response)
        : [];

  const hit = (policy: GuardrailPolicy, matches: number, defaultMessage: string): boolean => {
    result.hits.push({
      policyId: policy.id,
      name: policy.name,
      type: policy.type,
      action: policy.action,
      matches,
    });
    if (policy.action !== 'block') return false;
    result.blocked = { policy, message: policy.message ?? defaultMessage };
    return true;
  };
  const byName = (policy: GuardrailPolicy) => `Request blocked by guardrail '${policy.name}'`;

  for (const policy of policies) {
    if (!policy.enabled) continue;
    if (policy.stage !== 'both' && policy.stage !== input.stage) continue;
    if (!ENFORCED_GUARDRAIL_TYPES.has(policy.type)) {
      result.unknown.push(policy);
      continue;
    }

    if (policy.type === 'max_input_tokens') {
      if (input.stage !== 'request') continue;
      const max = Number(policy.config.maxTokens ?? 0);
      const used = input.estimatedInputTokens ?? 0;
      if (
        max > 0 &&
        used > max &&
        hit(policy, used, `Request exceeds the guardrail limit of ${String(max)} input tokens`)
      )
        return result;
      continue;
    }

    if (policy.type === 'json_schema') {
      // Only an answer has a shape to check; on the request side the policy does nothing.
      if (input.stage !== 'response') continue;
      const answer = targets.map((t) => t.get()).join('');
      const parsed = parseJsonAnswer(answer);
      const errors = parsed.ok
        ? validateJsonSchema(parsed.value, policy.config.schema ?? true)
        : ['$: the answer is not valid JSON'];
      if (errors.length === 0) continue;
      result.schemaErrors = [...(result.schemaErrors ?? []), ...errors];
      // Redacting a malformed document has no meaning: `redact` records the hit like `flag`.
      if (
        hit(
          policy,
          errors.length,
          'Response blocked: the answer does not match the required schema',
        )
      )
        return result;
      continue;
    }

    if (policy.type === 'prompt_injection') {
      let score = 0;
      for (const target of targets) {
        const text = target.get();
        for (const rule of INJECTION_PATTERNS) {
          const found = rule.regex.exec(text);
          if (!found) continue;
          score += rule.weight;
          if (result.matches && result.matches.length < 50) result.matches.push(found[0]);
        }
      }
      if (score >= 2 && hit(policy, score, 'Request blocked: possible prompt injection'))
        return result;
      continue;
    }

    // Text matchers: regex, pii, secret, keyword.
    const matchers = matchersFor(policy);
    if (matchers.length === 0) continue;
    const redact = policy.action === 'redact';
    let total = 0;
    for (const target of targets) {
      let text = target.get();
      let changed = false;
      for (const m of matchers) {
        const scanned = scan(m.re, text, {
          redact,
          ...(m.valid ? { valid: m.valid } : {}),
          ...(m.mask ? { mask: true } : {}),
          ...(result.matches ? { found: result.matches } : {}),
        });
        if (scanned.count === 0) continue;
        total += scanned.count;
        if (scanned.text !== text) {
          text = scanned.text;
          changed = true;
        }
      }
      if (changed) target.set(text);
    }
    if (total === 0) continue;
    if (redact) result.redactions += total;
    if (hit(policy, total, byName(policy))) return result;
  }
  return result;
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

/** Result of evaluating one policy on a sample text (the panel's live test). */
export interface GuardrailPreview {
  blocked: boolean;
  /** True when the policy hit (any action). */
  hit: boolean;
  matches: string[];
  redacted: boolean;
  redactedText: string;
  estimatedTokens?: number;
  /** `json_schema`: whether the sample parses and conforms. */
  valid?: boolean;
  schemaErrors?: string[];
}

/**
 * Evaluates a single policy on `text` exactly as the gateway would: the text is the user message
 * of a request, or the answer for `json_schema` (which only applies to responses).
 */
export function previewGuardrailText(
  policy: Pick<GuardrailPolicy, 'type' | 'config' | 'action'> & { message?: string },
  text: string,
  countTokens: (req: CanonicalRequest) => number,
): GuardrailPreview {
  const full: GuardrailPolicy = {
    id: 'preview',
    organizationId: 'preview',
    name: 'preview',
    enabled: true,
    stage: 'both',
    type: policy.type,
    config: policy.config,
    action: policy.action,
    ...(policy.message ? { message: policy.message } : {}),
  };
  if (policy.type === 'json_schema') {
    const response: CanonicalResponse = {
      id: 'preview',
      model: 'preview',
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      created: 0,
    };
    const result = evaluateGuardrails([full], {
      stage: 'response',
      response,
      collectMatches: true,
    });
    return {
      blocked: result.blocked !== undefined,
      hit: result.hits.length > 0,
      matches: [],
      redacted: false,
      redactedText: text,
      valid: result.hits.length === 0,
      ...(result.schemaErrors ? { schemaErrors: result.schemaErrors } : {}),
    };
  }
  const request: CanonicalRequest = {
    inboundApi: 'openai.chat',
    model: 'preview',
    system: [],
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    stream: false,
  };
  const estimatedInputTokens = countTokens(request);
  const result = evaluateGuardrails([full], {
    stage: 'request',
    request,
    estimatedInputTokens,
    collectMatches: true,
  });
  const part = request.messages[0]?.content[0];
  const after = part?.type === 'text' ? part.text : text;
  return {
    blocked: result.blocked !== undefined,
    hit: result.hits.length > 0,
    matches: result.matches ?? [],
    redacted: result.redactions > 0,
    redactedText: after,
    ...(policy.type === 'max_input_tokens' ? { estimatedTokens: estimatedInputTokens } : {}),
  };
}
