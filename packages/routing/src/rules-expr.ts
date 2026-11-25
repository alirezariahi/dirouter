/**
 * Routing rule expressions (card 32.2): a small, safe subset of CEL.
 *
 * - Literals: numbers, 'strings' or "strings", true, false, null, lists `[1, 2]`.
 * - Variables: `request.*`, `key.*` and `budget.*` (see RULE_VARIABLES); header and metadata maps
 *   are read with `request.headers['x-tier']` or `request.metadata.tier`.
 * - Operators: `|| && ! == != < <= > >= in + - * / %` and parentheses.
 * - Functions: `size(x)`, `has(request.metadata.tier)`, `int(x)`, `double(x)`, `string(x)`;
 *   string methods `startsWith`, `endsWith`, `contains`, `lowerAscii`.
 *
 * There are no loops, no regular expressions, no assignments and no user-defined functions, so an
 * expression always finishes in time proportional to its length. Expressions are parsed and type
 * checked once (at save time and when a snapshot loads) and compiled into closures, so evaluating
 * one costs a handful of property reads on the hot path.
 */

export type ValueType = 'string' | 'number' | 'bool' | 'null' | 'list' | 'map' | 'dyn';

/** The variables a rule can read, with their types. Maps have string values. */
export const RULE_VARIABLES = {
  request: {
    model: 'string',
    api: 'string',
    stream: 'bool',
    headers: 'map',
    metadata: 'map',
    estimated_tokens: 'number',
    max_output_tokens: 'number',
    user: 'string',
    has_tools: 'bool',
    has_images: 'bool',
  },
  key: { id: 'string', project: 'string', team: 'string', organization: 'string' },
  /** Percentage (0-100+) of the current period's budget already spent; 0 without a budget. */
  budget: { key: 'number', project: 'number', team: 'number', max: 'number' },
} as const satisfies Record<string, Record<string, ValueType>>;

/**
 * Headers that carry credentials are never visible to a rule, so a rule cannot branch on (and
 * thereby probe) a secret.
 */
const HIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
]);

export interface RuleInput {
  request: {
    model: string;
    api: string;
    stream: boolean;
    headers: Record<string, string | string[] | undefined>;
    metadata: Record<string, string>;
    estimated_tokens: number;
    max_output_tokens: number;
    user: string;
    has_tools: boolean;
    has_images: boolean;
  };
  key: { id: string; project: string; team: string; organization: string };
  budget: { key: number; project: number; team: number; max: number };
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} (at ${String(position)})`);
    this.name = 'ExpressionError';
  }
}

export const MAX_EXPRESSION_LENGTH = 2_000;
const MAX_DEPTH = 32;

// ───────────── Lexer ─────────────

type Token =
  | { t: 'num'; v: number; p: number }
  | { t: 'str'; v: string; p: number }
  | { t: 'id'; v: string; p: number }
  | { t: 'op'; v: string; p: number }
  | { t: 'end'; p: number };

const OPERATORS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '!', '+', '-', '*', '/', '%'];
const PUNCT = new Set(['(', ')', '[', ']', ',', '.']);

function lex(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(source.slice(i));
      const text = m?.[0] ?? c;
      out.push({ t: 'num', v: Number(text), p: i });
      i += text.length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let value = '';
      for (; j < source.length && source.charAt(j) !== c; j++) {
        if (source.charAt(j) === '\\' && j + 1 < source.length) {
          const next = source.charAt(++j);
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        } else value += source.charAt(j);
      }
      if (j >= source.length) throw new ExpressionError('unterminated string', i);
      out.push({ t: 'str', v: value, p: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      const text = m?.[0] ?? c;
      out.push({ t: 'id', v: text, p: i });
      i += text.length;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op, p: i });
      i += op.length;
      continue;
    }
    if (PUNCT.has(c)) {
      out.push({ t: 'op', v: c, p: i });
      i++;
      continue;
    }
    throw new ExpressionError(`unexpected character '${c}'`, i);
  }
  out.push({ t: 'end', p: source.length });
  return out;
}

// ───────────── Parser and type checker ─────────────

type Fn = (input: RuleInput) => unknown;
interface Node {
  type: ValueType;
  run: Fn;
  /** A literal value, folded at compile time. */
  constant?: { value: unknown };
  /** Variable path, for `has()` and diagnostics. */
  path?: string[];
}

const truthy = (v: unknown) => v === true;

function eq(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  return a === b;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number')
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  if (typeof a === 'string' && typeof b === 'string')
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  return false;
}

function headerValue(headers: RuleInput['request']['headers'], name: string): string | null {
  const lower = name.toLowerCase();
  if (HIDDEN_HEADERS.has(lower)) return null;
  const v = headers[lower];
  if (Array.isArray(v)) return v.join(', ');
  return typeof v === 'string' ? v : null;
}

class Parser {
  #i = 0;
  #depth = 0;
  constructor(private readonly tokens: Token[]) {}

  #peek(): Token {
    return this.tokens[this.#i] ?? { t: 'end', p: 0 };
  }
  #next(): Token {
    const tok = this.#peek();
    this.#i++;
    return tok;
  }
  #isOp(v: string): boolean {
    const t = this.#peek();
    return t.t === 'op' && t.v === v;
  }
  #expect(v: string): void {
    const t = this.#next();
    if (t.t !== 'op' || t.v !== v) throw new ExpressionError(`expected '${v}'`, t.p);
  }

  parse(): Node {
    const node = this.#or();
    const t = this.#peek();
    if (t.t !== 'end') throw new ExpressionError('unexpected input', t.p);
    return node;
  }

  #enter(p: number) {
    if (++this.#depth > MAX_DEPTH) throw new ExpressionError('expression is nested too deeply', p);
  }

  #or(): Node {
    let left = this.#and();
    while (this.#isOp('||')) {
      const p = this.#next().p;
      const right = this.#and();
      expectType(left, 'bool', p);
      expectType(right, 'bool', p);
      const l = left.run;
      const r = right.run;
      left = { type: 'bool', run: (x) => truthy(l(x)) || truthy(r(x)) };
    }
    return left;
  }

  #and(): Node {
    let left = this.#rel();
    while (this.#isOp('&&')) {
      const p = this.#next().p;
      const right = this.#rel();
      expectType(left, 'bool', p);
      expectType(right, 'bool', p);
      const l = left.run;
      const r = right.run;
      left = { type: 'bool', run: (x) => truthy(l(x)) && truthy(r(x)) };
    }
    return left;
  }

  #rel(): Node {
    const left = this.#add();
    const t = this.#peek();
    const op =
      t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)
        ? t.v
        : t.t === 'id' && t.v === 'in'
          ? 'in'
          : undefined;
    if (!op) return left;
    this.#next();
    const right = this.#add();
    const l = left.run;
    const r = right.run;
    if (op === 'in') {
      if (right.type !== 'list' && right.type !== 'map' && right.type !== 'dyn')
        throw new ExpressionError("'in' needs a list or a map on the right", t.p);
      if (right.type === 'map')
        return {
          type: 'bool',
          run: (x) => {
            const key = l(x);
            const map = r(x) as ((name: string) => string | null) | null;
            return typeof key === 'string' && typeof map === 'function' && map(key) !== null;
          },
        };
      const constant = right.constant?.value;
      if (Array.isArray(constant)) {
        const set = new Set(constant);
        return { type: 'bool', run: (x) => set.has(l(x)) };
      }
      return {
        type: 'bool',
        run: (x) => {
          const list = r(x);
          const v = l(x);
          return Array.isArray(list) && list.some((item) => eq(item, v));
        },
      };
    }
    comparable(left, right, op, t.p);
    if (op === '==') return { type: 'bool', run: (x) => eq(l(x), r(x)) };
    if (op === '!=') return { type: 'bool', run: (x) => !eq(l(x), r(x)) };
    return { type: 'bool', run: (x) => compare(op, l(x), r(x)) };
  }

  #add(): Node {
    let left = this.#mul();
    while (this.#isOp('+') || this.#isOp('-')) {
      const tok = this.#next();
      const op = tok.t === 'op' ? tok.v : '+';
      const right = this.#mul();
      const l = left.run;
      const r = right.run;
      if (op === '+' && (left.type === 'string' || right.type === 'string')) {
        expectType(left, 'string', tok.p);
        expectType(right, 'string', tok.p);
        left = {
          type: 'string',
          run: (x) => {
            const a = l(x);
            const b = r(x);
            return typeof a === 'string' && typeof b === 'string' ? a + b : null;
          },
        };
        continue;
      }
      expectType(left, 'number', tok.p);
      expectType(right, 'number', tok.p);
      left = {
        type: 'number',
        run: (x) => {
          const a = l(x);
          const b = r(x);
          if (typeof a !== 'number' || typeof b !== 'number') return null;
          return op === '+' ? a + b : a - b;
        },
      };
    }
    return left;
  }

  #mul(): Node {
    let left = this.#unary();
    while (this.#isOp('*') || this.#isOp('/') || this.#isOp('%')) {
      const tok = this.#next();
      const op = tok.t === 'op' ? tok.v : '*';
      const right = this.#unary();
      expectType(left, 'number', tok.p);
      expectType(right, 'number', tok.p);
      const l = left.run;
      const r = right.run;
      left = {
        type: 'number',
        run: (x) => {
          const a = l(x);
          const b = r(x);
          if (typeof a !== 'number' || typeof b !== 'number') return null;
          if (op === '*') return a * b;
          if (b === 0) return null;
          return op === '/' ? a / b : a % b;
        },
      };
    }
    return left;
  }

  #unary(): Node {
    const t = this.#peek();
    if (t.t === 'op' && (t.v === '!' || t.v === '-')) {
      this.#next();
      this.#enter(t.p);
      const inner = this.#unary();
      this.#depth--;
      const run = inner.run;
      if (t.v === '!') {
        expectType(inner, 'bool', t.p);
        return { type: 'bool', run: (x) => !truthy(run(x)) };
      }
      expectType(inner, 'number', t.p);
      return {
        type: 'number',
        run: (x) => {
          const v = run(x);
          return typeof v === 'number' ? -v : null;
        },
      };
    }
    return this.#member();
  }

  #member(): Node {
    let node = this.#primary();
    for (;;) {
      if (this.#isOp('.')) {
        const dot = this.#next();
        const name = this.#next();
        if (name.t !== 'id') throw new ExpressionError('expected a field or method name', dot.p);
        if (this.#isOp('(')) {
          node = this.#method(node, name.v, name.p);
          continue;
        }
        node = this.#field(node, name.v, name.p);
        continue;
      }
      if (this.#isOp('[')) {
        const open = this.#next();
        this.#enter(open.p);
        const index = this.#or();
        this.#depth--;
        this.#expect(']');
        node = this.#index(node, index, open.p);
        continue;
      }
      if (node.path?.length === 1)
        throw new ExpressionError(
          `'${node.path[0] ?? ''}' is a group of variables; read a field, e.g. ${node.path[0] ?? ''}.${Object.keys(RULE_VARIABLES[node.path[0] as keyof typeof RULE_VARIABLES])[0] ?? ''}`,
          this.#peek().p,
        );
      return node;
    }
  }

  #field(node: Node, name: string, p: number): Node {
    const path = node.path ? [...node.path, name] : undefined;
    if (node.type === 'map') {
      const run = node.run;
      return {
        type: 'string',
        run: (x) => {
          const map = run(x) as ((name: string) => string | null) | null;
          return typeof map === 'function' ? map(name) : null;
        },
        ...(path ? { path } : {}),
      };
    }
    if (node.path?.length === 1) {
      const root = node.path[0] as keyof typeof RULE_VARIABLES;
      const fields = RULE_VARIABLES[root] as Record<string, ValueType>;
      const type = fields[name];
      if (!type)
        throw new ExpressionError(
          `unknown field '${root}.${name}' (known: ${Object.keys(fields).join(', ')})`,
          p,
        );
      return { type, run: variable(root, name), path: [root, name] };
    }
    throw new ExpressionError(`'${name}' cannot be read here`, p);
  }

  #index(node: Node, index: Node, p: number): Node {
    if (node.type === 'map') {
      expectType(index, 'string', p);
      const run = node.run;
      const key = index.run;
      return {
        type: 'string',
        run: (x) => {
          const map = run(x) as ((name: string) => string | null) | null;
          const k = key(x);
          return typeof map === 'function' && typeof k === 'string' ? map(k) : null;
        },
        path: [...(node.path ?? []), '[]'],
      };
    }
    if (node.type === 'list' || node.type === 'dyn') {
      expectType(index, 'number', p);
      const run = node.run;
      const key = index.run;
      return {
        type: 'dyn',
        run: (x) => {
          const list = run(x);
          const k = key(x);
          return Array.isArray(list) && typeof k === 'number'
            ? ((list as unknown[])[k] ?? null)
            : null;
        },
      };
    }
    throw new ExpressionError('only maps and lists can be indexed', p);
  }

  #args(): Node[] {
    this.#expect('(');
    const args: Node[] = [];
    if (!this.#isOp(')')) {
      for (;;) {
        args.push(this.#or());
        if (!this.#isOp(',')) break;
        this.#next();
      }
    }
    this.#expect(')');
    return args;
  }

  #method(target: Node, name: string, p: number): Node {
    const args = this.#args();
    const run = target.run;
    if (name === 'lowerAscii') {
      expectType(target, 'string', p);
      if (args.length !== 0) throw new ExpressionError('lowerAscii() takes no arguments', p);
      return {
        type: 'string',
        run: (x) => {
          const v = run(x);
          return typeof v === 'string' ? v.toLowerCase() : null;
        },
      };
    }
    if (name === 'startsWith' || name === 'endsWith' || name === 'contains') {
      expectType(target, 'string', p);
      const [arg] = args;
      if (args.length !== 1 || !arg) throw new ExpressionError(`${name}() takes one argument`, p);
      expectType(arg, 'string', p);
      const a = arg.run;
      return {
        type: 'bool',
        run: (x) => {
          const v = run(x);
          const s = a(x);
          if (typeof v !== 'string' || typeof s !== 'string') return false;
          return name === 'startsWith'
            ? v.startsWith(s)
            : name === 'endsWith'
              ? v.endsWith(s)
              : v.includes(s);
        },
      };
    }
    throw new ExpressionError(`unknown method '${name}'`, p);
  }

  #primary(): Node {
    const t = this.#next();
    if (t.t === 'num') return literal(t.v, 'number');
    if (t.t === 'str') return literal(t.v, 'string');
    if (t.t === 'op' && t.v === '(') {
      this.#enter(t.p);
      const inner = this.#or();
      this.#depth--;
      this.#expect(')');
      return inner;
    }
    if (t.t === 'op' && t.v === '[') {
      this.#enter(t.p);
      const items: Node[] = [];
      if (!this.#isOp(']')) {
        for (;;) {
          items.push(this.#or());
          if (!this.#isOp(',')) break;
          this.#next();
        }
      }
      this.#depth--;
      this.#expect(']');
      if (items.length > 256) throw new ExpressionError('list is too long', t.p);
      if (items.every((n) => n.constant))
        return literal(
          items.map((n) => n.constant?.value),
          'list',
        );
      const runs = items.map((n) => n.run);
      return { type: 'list', run: (x) => runs.map((r) => r(x)) };
    }
    if (t.t === 'id') {
      if (t.v === 'true') return literal(true, 'bool');
      if (t.v === 'false') return literal(false, 'bool');
      if (t.v === 'null') return literal(null, 'null');
      if (this.#isOp('(')) return this.#call(t.v, t.p);
      if (t.v in RULE_VARIABLES) return { type: 'dyn', run: () => null, path: [t.v] };
      throw new ExpressionError(
        `unknown variable '${t.v}' (known: ${Object.keys(RULE_VARIABLES).join(', ')})`,
        t.p,
      );
    }
    throw new ExpressionError('expected a value', t.p);
  }

  #call(name: string, p: number): Node {
    if (name === 'has') {
      // A macro, like CEL's: true when a header or metadata entry is present.
      const args = this.#args();
      const [arg] = args;
      if (args.length !== 1 || !arg?.path || arg.path.length < 2)
        throw new ExpressionError('has() takes a field, e.g. has(request.metadata.tier)', p);
      const run = arg.run;
      return { type: 'bool', run: (x) => run(x) !== null && run(x) !== undefined };
    }
    const args = this.#args();
    const [arg] = args;
    if (args.length !== 1 || !arg) throw new ExpressionError(`${name}() takes one argument`, p);
    const run = arg.run;
    switch (name) {
      case 'size':
        if (!['string', 'list', 'dyn'].includes(arg.type))
          throw new ExpressionError('size() needs a string or a list', p);
        return {
          type: 'number',
          run: (x) => {
            const v = run(x);
            return typeof v === 'string' || Array.isArray(v) ? v.length : null;
          },
        };
      case 'int':
      case 'double':
        return {
          type: 'number',
          run: (x) => {
            const v = run(x);
            const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
            if (Number.isNaN(n)) return null;
            return name === 'int' ? Math.trunc(n) : n;
          },
        };
      case 'string':
        return {
          type: 'string',
          run: (x) => {
            const v = run(x);
            if (typeof v === 'string') return v;
            return typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
          },
        };
      default:
        throw new ExpressionError(`unknown function '${name}'`, p);
    }
  }
}

function literal(value: unknown, type: ValueType): Node {
  return { type, run: () => value, constant: { value } };
}

function variable(root: keyof typeof RULE_VARIABLES, name: string): Fn {
  if (root === 'request') {
    if (name === 'headers')
      return (x) => (header: string) => headerValue(x.request.headers, header);
    if (name === 'metadata')
      return (x) => (entry: string) =>
        Object.prototype.hasOwnProperty.call(x.request.metadata, entry)
          ? (x.request.metadata[entry] ?? null)
          : null;
    return (x) => x.request[name as keyof RuleInput['request']];
  }
  if (root === 'key') return (x) => x.key[name as keyof RuleInput['key']];
  return (x) => x.budget[name as keyof RuleInput['budget']];
}

function expectType(node: Node, type: ValueType, p: number): void {
  if (node.type === type || node.type === 'dyn') return;
  throw new ExpressionError(`expected ${type}, got ${node.type}`, p);
}

function comparable(a: Node, b: Node, op: string, p: number): void {
  if (a.type === 'dyn' || b.type === 'dyn' || a.type === 'null' || b.type === 'null') {
    if ((op === '==' || op === '!=') && (a.type === 'map' || b.type === 'map'))
      throw new ExpressionError('maps cannot be compared', p);
    return;
  }
  if (a.type !== b.type)
    throw new ExpressionError(`cannot compare ${a.type} with ${b.type} using '${op}'`, p);
  if (op !== '==' && op !== '!=' && a.type !== 'number' && a.type !== 'string')
    throw new ExpressionError(`'${op}' needs numbers or strings`, p);
}

export interface CompiledExpression {
  source: string;
  /** Whether the expression reads `budget.*` (the gateway then looks the spend up first). */
  usesBudget: boolean;
  evaluate(input: RuleInput): boolean;
}

/**
 * Parses, type checks and compiles a condition; throws ExpressionError with a position when the
 * expression is invalid. A condition must be boolean.
 */
export function compileExpression(source: string): CompiledExpression {
  if (source.length > MAX_EXPRESSION_LENGTH)
    throw new ExpressionError(
      `expression is longer than ${String(MAX_EXPRESSION_LENGTH)} characters`,
      0,
    );
  const tokens = lex(source);
  const node = new Parser(tokens).parse();
  if (node.type !== 'bool' && node.type !== 'dyn')
    throw new ExpressionError(`a condition must be true or false, got ${node.type}`, 0);
  const usesBudget = tokens.some(
    (t, i) => t.t === 'id' && t.v === 'budget' && tokens[i + 1]?.t === 'op',
  );
  const run = node.run;
  return {
    source,
    usesBudget,
    evaluate: (input) => {
      try {
        return run(input) === true;
      } catch {
        return false;
      }
    },
  };
}

/** Validation helper for the control plane: undefined when valid, otherwise the problem. */
export function expressionProblem(source: string): string | undefined {
  try {
    compileExpression(source);
    return undefined;
  } catch (error) {
    return error instanceof ExpressionError ? error.message : String(error);
  }
}
