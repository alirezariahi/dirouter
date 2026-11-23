/**
 * A limited sandbox for provider plugins (card 21.2).
 *
 * Plugin code runs in its own V8 context with only the ECMAScript built-ins: no `require`,
 * `process`, network, timers or file system, and no `eval`/`Function` from strings. No object from
 * the gateway is ever passed in; arguments and results cross the boundary as JSON strings, so the
 * plugin cannot reach the gateway's prototypes. Every call has a CPU time limit.
 *
 * `node:vm` is not a boundary against deliberately hostile code; plugins are installed by the
 * operator. The sandbox keeps a buggy plugin from crashing, hanging or reaching into the gateway.
 */
import vm from 'node:vm';

const BOOTSTRAP = `'use strict';
var module = { exports: {} };
var exports = module.exports;
var __logs = [];
function log() {
  if (__logs.length < 100)
    __logs.push(Array.prototype.map.call(arguments, String).join(' ').slice(0, 500));
}
function __call(name, input) {
  var fn = module.exports[name];
  if (typeof fn !== 'function') throw new Error('plugin does not export ' + name);
  var out = fn(JSON.parse(input));
  if (out && typeof out.then === 'function') throw new Error(name + ' must not be async');
  return JSON.stringify(out === undefined ? null : out);
}
function __has(name) { return typeof module.exports[name] === 'function'; }
function __drainLogs() { var l = __logs; __logs = []; return JSON.stringify(l); }
`;

/** Results larger than this are refused (a runaway plugin must not fill memory). */
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;

export class PluginError extends Error {}

export class PluginSandbox {
  readonly #context: vm.Context;
  readonly #timeoutMs: number;

  constructor(source: string, filename: string, timeoutMs = 50) {
    this.#timeoutMs = timeoutMs;
    this.#context = vm.createContext(Object.create(null) as object, {
      name: filename,
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    });
    new vm.Script(BOOTSTRAP, { filename: 'dirouter-plugin-bootstrap.js' }).runInContext(
      this.#context,
    );
    try {
      new vm.Script(source, { filename }).runInContext(this.#context, {
        timeout: Math.max(timeoutMs, 1_000),
      });
    } catch (error) {
      throw new PluginError(`plugin failed to load: ${messageOf(error)}`);
    }
  }

  #run(code: string): unknown {
    return new vm.Script(code).runInContext(this.#context, { timeout: this.#timeoutMs });
  }

  has(name: string): boolean {
    return this.#run(`__has(${JSON.stringify(name)})`) === true;
  }

  /** Calls an exported function with a JSON-serializable argument; returns its JSON result. */
  call(name: string, input: unknown): unknown {
    let out: unknown;
    try {
      out = this.#run(`__call(${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(input))})`);
    } catch (error) {
      throw new PluginError(`plugin ${name} failed: ${messageOf(error)}`);
    }
    if (typeof out !== 'string' || out.length > MAX_OUTPUT_CHARS)
      throw new PluginError(`plugin ${name} returned an invalid or oversized result`);
    return JSON.parse(out) as unknown;
  }

  /** Lines the plugin wrote with `log(...)` since the last call. */
  drainLogs(): string[] {
    const out = this.#run('__drainLogs()');
    return typeof out === 'string' ? (JSON.parse(out) as string[]) : [];
  }
}

function messageOf(error: unknown): string {
  // Errors thrown inside the context are not instances of this realm's Error.
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message.slice(0, 300) : String(error).slice(0, 300);
}
