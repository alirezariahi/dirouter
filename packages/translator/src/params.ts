/**
 * Parameter policy per model and alias, and `drop_params` (card 31.4).
 *
 * A model's policy names parameters. Portable names act on the canonical request, so they work
 * whatever format the client speaks and whatever provider answers. Any other name is a field of the
 * provider's own request body (dotted for nested fields) and is applied by the outbound translator
 * last, through `upstreamFields`.
 *
 * `drop_params` decides what happens to a parameter the target cannot take: dropped (on, the
 * default) or a 400 naming it (off).
 */
import type { CanonicalRequest, RequestPolicy } from '@dirouter/contracts';

import { type DropReporter, UnsupportedContentError } from './common.js';

type Canonical = CanonicalRequest;
type Effort = NonNullable<NonNullable<Canonical['reasoning']>['effort']>;

interface Portable {
  get: (req: Canonical) => unknown;
  /** Returns the request with the value set, or throws when the value has the wrong type. */
  set: (req: Canonical, value: unknown) => Canonical;
  clear: (req: Canonical) => Canonical;
}

const invalid = (name: string, expected: string) =>
  new UnsupportedContentError(name, `Parameter policy: '${name}' must be ${expected}`);

const number =
  (name: string, field: 'temperature' | 'topP'): Portable['set'] =>
  (req, value) => {
    if (typeof value !== 'number') throw invalid(name, 'a number');
    return { ...req, [field]: value };
  };

const integer =
  (name: string, field: 'topK' | 'seed' | 'maxOutputTokens'): Portable['set'] =>
  (req, value) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(name, 'an integer');
    if (field === 'maxOutputTokens' && value < 0) throw invalid(name, 'a non-negative integer');
    return { ...req, [field]: value };
  };

const without = (req: Canonical, field: keyof Canonical): Canonical => {
  const { [field]: _removed, ...rest } = req;
  return rest as Canonical;
};

const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high'];
const maxTokens: Portable = {
  get: (r) => r.maxOutputTokens,
  set: integer('max_tokens', 'maxOutputTokens'),
  clear: (r) => without(r, 'maxOutputTokens'),
};

/** Portable parameter names (OpenAI's) and where they live in the canonical request. */
export const PORTABLE_PARAMS: Readonly<Record<string, Portable>> = {
  temperature: {
    get: (r) => r.temperature,
    set: number('temperature', 'temperature'),
    clear: (r) => without(r, 'temperature'),
  },
  top_p: {
    get: (r) => r.topP,
    set: number('top_p', 'topP'),
    clear: (r) => without(r, 'topP'),
  },
  top_k: { get: (r) => r.topK, set: integer('top_k', 'topK'), clear: (r) => without(r, 'topK') },
  seed: { get: (r) => r.seed, set: integer('seed', 'seed'), clear: (r) => without(r, 'seed') },
  max_tokens: maxTokens,
  max_completion_tokens: maxTokens,
  max_output_tokens: maxTokens,
  stop: {
    get: (r) => r.stop,
    set: (r, value) => {
      const stop = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(stop) || !stop.every((s) => typeof s === 'string'))
        throw invalid('stop', 'a string or a list of strings');
      return { ...r, stop };
    },
    clear: (r) => without(r, 'stop'),
  },
  reasoning_effort: {
    get: (r) => r.reasoning?.effort ?? r.reasoning?.budgetTokens,
    set: (r, value) => {
      if (!EFFORTS.includes(value as Effort)) throw invalid('reasoning_effort', EFFORTS.join(', '));
      return { ...r, reasoning: { effort: value as Effort } };
    },
    clear: (r) => without(r, 'reasoning'),
  },
  parallel_tool_calls: {
    get: (r) => r.parallelToolCalls,
    set: (r, value) => {
      if (typeof value !== 'boolean') throw invalid('parallel_tool_calls', 'true or false');
      return { ...r, parallelToolCalls: value };
    },
    clear: (r) => without(r, 'parallelToolCalls'),
  },
};

/** A parameter the model cannot take while `drop_params` is off. Answered with a 400. */
export class UnsupportedParameterError extends UnsupportedContentError {
  constructor(
    readonly parameters: string[],
    target: string,
  ) {
    super(
      parameters.join(','),
      `Unsupported parameter${parameters.length > 1 ? 's' : ''} for ${target}: ${parameters
        .map((p) => `'${p}'`)
        .join(
          ', ',
        )}. Remove ${parameters.length > 1 ? 'them' : 'it'}, or set drop_params to true to have unsupported parameters dropped.`,
    );
    this.name = 'UnsupportedParameterError';
  }
}

/** What a policy did to a request, for logs. */
export interface ParamsApplied {
  overrides: string[];
  defaults: string[];
  dropped: string[];
}

/** The client sent it: in the canonical request, or among its own API's extra parameters. */
const present = (req: Canonical, name: string): boolean =>
  PORTABLE_PARAMS[name]?.get(req) !== undefined ||
  (req.passthrough !== undefined && name in req.passthrough);

function remove(req: Canonical, name: string): Canonical {
  const portable = PORTABLE_PARAMS[name];
  let next = portable ? portable.clear(req) : req;
  if (portable && !(next.passthrough && name in next.passthrough)) return next;
  if (req.passthrough && name in req.passthrough) {
    const { [name]: _removed, ...rest } = req.passthrough;
    next = { ...next, passthrough: rest };
  }
  const fields = next.upstreamFields ?? {};
  return { ...next, upstreamFields: { ...fields, drop: [...(fields.drop ?? []), name] } };
}

/**
 * The request shaped by a parameter policy: unsupported parameters dropped (or refused when
 * `dropParams` is false), listed parameters dropped, defaults filled in and overrides forced.
 * Returns the same request object when the policy changes nothing.
 */
export function applyParamPolicy(
  request: Canonical,
  policy: Pick<RequestPolicy, 'defaults' | 'overrides' | 'drop' | 'unsupported'>,
  options: { dropParams: boolean; target: string },
): { request: Canonical; applied: ParamsApplied } {
  const applied: ParamsApplied = { overrides: [], defaults: [], dropped: [] };
  let req = request;

  const unsupported = (policy.unsupported ?? []).filter((name) => present(req, name));
  if (unsupported.length > 0 && !options.dropParams)
    throw new UnsupportedParameterError(unsupported, options.target);
  const removed = [...unsupported, ...(policy.drop ?? [])];
  for (const name of removed) {
    if (!PORTABLE_PARAMS[name] || present(req, name)) {
      req = remove(req, name);
      if (present(request, name) && !applied.dropped.includes(name)) applied.dropped.push(name);
    }
  }

  const upstreamSet: Record<string, unknown> = {};
  const upstreamDefaults: Record<string, unknown> = {};
  // A removed parameter stays removed: no default or override brings it back.
  for (const [name, value] of Object.entries(policy.defaults ?? {})) {
    if (removed.includes(name)) continue;
    const portable = PORTABLE_PARAMS[name];
    if (portable) {
      if (portable.get(req) !== undefined) continue;
      req = portable.set(req, value);
    } else {
      if (req.passthrough && name in req.passthrough) continue;
      upstreamDefaults[name] = value;
    }
    applied.defaults.push(name);
  }
  for (const [name, value] of Object.entries(policy.overrides ?? {})) {
    if (removed.includes(name)) continue;
    const portable = PORTABLE_PARAMS[name];
    if (portable) req = portable.set(req, value);
    else upstreamSet[name] = value;
    applied.overrides.push(name);
  }
  if (Object.keys(upstreamSet).length || Object.keys(upstreamDefaults).length) {
    const fields = req.upstreamFields ?? {};
    req = {
      ...req,
      upstreamFields: {
        ...fields,
        ...(Object.keys(upstreamSet).length ? { set: { ...fields.set, ...upstreamSet } } : {}),
        ...(Object.keys(upstreamDefaults).length
          ? { defaults: { ...fields.defaults, ...upstreamDefaults } }
          : {}),
      },
    };
  }
  return { request: req, applied };
}

// ───────────── provider body fields ─────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function walk(
  body: Record<string, unknown>,
  path: string,
  create: boolean,
): { parent: Record<string, unknown>; key: string } | undefined {
  const parts = path.split('.');
  const key = parts.pop() ?? path;
  let node = body;
  for (const part of parts) {
    const next = node[part];
    if (isObject(next)) node = next;
    else if (create && next === undefined) {
      const created: Record<string, unknown> = {};
      node[part] = created;
      node = created;
    } else return undefined;
  }
  return { parent: node, key };
}

/**
 * Applies a request's `upstreamFields` to the provider body an outbound translator built:
 * removals first, then defaults where the body has no value, then forced values. Mutates and
 * returns the body.
 */
export function applyUpstreamFields<T extends Record<string, unknown>>(
  body: T,
  request: Pick<Canonical, 'upstreamFields'>,
): T {
  const fields = request.upstreamFields;
  if (!fields) return body;
  for (const path of fields.drop ?? []) {
    const at = walk(body, path, false);
    // Reflect.deleteProperty: the key is a configured field name, not a fixed property.
    if (at) Reflect.deleteProperty(at.parent, at.key);
  }
  for (const [path, value] of Object.entries(fields.defaults ?? {})) {
    const at = walk(body, path, true);
    if (at && at.parent[at.key] === undefined) at.parent[at.key] = value;
  }
  for (const [path, value] of Object.entries(fields.set ?? {})) {
    const at = walk(body, path, true);
    if (at) at.parent[at.key] = value;
  }
  return body;
}

// ───────────── parameters the destination cannot take ─────────────

/**
 * Wraps a drop reporter so a dropped parameter (reported with kind `parameter`) is refused when
 * `drop_params` is off. Content and other drops are only reported.
 */
export function guardParameterDrops(
  onDrop: DropReporter,
  options: { dropParams: boolean; target: string },
): DropReporter {
  return (field, reason, kind) => {
    if (kind === 'parameter' && !options.dropParams)
      throw new UnsupportedParameterError([field], options.target);
    onDrop(field, reason, kind);
  };
}

/**
 * Reports the client's own parameters (`passthrough`) a translator for another API cannot carry:
 * they only travel when the client and the provider speak the same API.
 */
export function reportForeignPassthrough(
  request: Pick<Canonical, 'inboundApi' | 'passthrough'>,
  carried: boolean,
  provider: string,
  onDrop: DropReporter,
  ignore: readonly string[] = [],
): void {
  if (carried || !request.passthrough) return;
  for (const key of Object.keys(request.passthrough))
    if (!key.startsWith('__') && !ignore.includes(key))
      onDrop(
        key,
        `${provider} has no equivalent of this ${request.inboundApi} parameter`,
        'parameter',
      );
}
