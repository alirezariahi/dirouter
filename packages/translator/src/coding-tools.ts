/**
 * Coding tools across models (card 31.2).
 *
 * Codex and other Responses clients edit files with tools that are not functions: a `custom` tool
 * with free-form input (Codex's `apply_patch`, whose input is a patch in the V4A format, described
 * by a Lark grammar) or OpenAI's built-in `apply_patch` tool, whose calls carry one file operation.
 * Only OpenAI's own models know these. Every other model gets an ordinary function tool:
 *
 * - `custom` → a function taking `{"input": string}`, the grammar added to its description;
 * - `apply_patch` → a function taking `{"type", "path", "diff"}` (the operation itself).
 *
 * The model's function call is turned back into the item the client expects
 * (`custom_tool_call` with `input`, `apply_patch_call` with `operation`), and the client's replayed
 * calls and outputs become ordinary tool calls and results again.
 */
import type { CanonicalPart, CanonicalTool } from '@dirouter/contracts';

/** Name of the function an `apply_patch` built-in tool becomes. */
export const APPLY_PATCH_TOOL = 'apply_patch';

const APPLY_PATCH_DESCRIPTION = [
  'Create, update or delete one file in the workspace. Call it once per file.',
  '- create_file: `diff` is the whole new file, every line prefixed with "+".',
  '- update_file: `diff` is a V4A diff of the change: one or more hunks, each starting with',
  '  "@@" followed by a line of context (a function or class header, may be empty), then lines',
  '  prefixed with " " (unchanged context, 3 lines before and after), "-" (removed) or "+" (added).',
  '- delete_file: no `diff`.',
  '`path` is relative to the workspace root.',
].join('\n');

const APPLY_PATCH_PARAMETERS = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['create_file', 'update_file', 'delete_file'] },
    path: { type: 'string', description: 'File path relative to the workspace root.' },
    diff: { type: 'string', description: 'V4A diff (create_file and update_file only).' },
  },
  required: ['type', 'path'],
  additionalProperties: false,
};

type Json = Record<string, unknown>;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** A Responses `custom` or `apply_patch` tool as a canonical function tool, or undefined. */
export function codingToolIn(tool: Json): CanonicalTool | undefined {
  if (tool.type === 'apply_patch')
    return {
      name: APPLY_PATCH_TOOL,
      description: APPLY_PATCH_DESCRIPTION,
      parameters: APPLY_PATCH_PARAMETERS,
      kind: 'apply_patch',
    };
  const name = str(tool.name);
  if (tool.type !== 'custom' || !name) return undefined;
  const format = (tool.format ?? undefined) as Json | undefined;
  const grammar =
    format?.type === 'grammar' && typeof format.definition === 'string'
      ? `\n\nThe input must match this ${str(format.syntax) ?? 'lark'} grammar exactly:\n${format.definition}`
      : '';
  const description = `${str(tool.description) ?? ''}${grammar}`.trim();
  return {
    name,
    ...(description ? { description } : {}),
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'The complete free-form input of the tool, exactly as the tool expects it.',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    kind: 'custom',
  };
}

/** A replayed `custom_tool_call` or `apply_patch_call` item as a canonical tool call. */
export function codingCallIn(item: Json): CanonicalPart | undefined {
  const id = str(item.call_id) ?? str(item.id);
  if (!id) return undefined;
  if (item.type === 'custom_tool_call') {
    const name = str(item.name);
    if (!name) return undefined;
    return {
      type: 'tool_call',
      id,
      name,
      arguments: JSON.stringify({ input: typeof item.input === 'string' ? item.input : '' }),
    };
  }
  if (item.type === 'apply_patch_call') {
    const operation = item.operation && typeof item.operation === 'object' ? item.operation : {};
    return {
      type: 'tool_call',
      id,
      name: APPLY_PATCH_TOOL,
      arguments: JSON.stringify(operation),
    };
  }
  return undefined;
}

/**
 * A replayed `apply_patch_call_output` as tool-result text: its `output`, or its status, with
 * `failed` marking the result as an error.
 */
export function applyPatchOutputIn(item: Json): { text: string; isError: boolean } {
  const failed = item.status === 'failed';
  const text = str(item.output) ?? (failed ? 'The patch failed.' : 'The patch was applied.');
  return { text, isError: failed };
}

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/** The kind of the tool a call goes to, when it is a translated coding tool. */
export function codingKindOf(
  name: string,
  tools: readonly Pick<CanonicalTool, 'name' | 'kind'>[] | undefined,
): CanonicalTool['kind'] {
  return tools?.find((t) => t.name === name)?.kind;
}

/** The free-form input of a `custom` tool call (the raw arguments when they are not `{input}`). */
export function customInputOf(args: string): string {
  const parsed = parse(args) as { input?: unknown } | undefined;
  return typeof parsed?.input === 'string' ? parsed.input : args;
}

/** The file operation of an `apply_patch` call, or undefined when the arguments are not one. */
export function applyPatchOperationOf(args: string): Json | undefined {
  const parsed = parse(args) as Json | undefined;
  const type = parsed?.type;
  const path = str(parsed?.path);
  if (!path || (type !== 'create_file' && type !== 'update_file' && type !== 'delete_file'))
    return undefined;
  if (type === 'delete_file') return { type, path };
  return { type, path, diff: typeof parsed?.diff === 'string' ? parsed.diff : '' };
}

/**
 * The Responses output item for a call to a translated coding tool, or undefined for an ordinary
 * function call.
 */
export function codingOutputItem(
  call: { id: string; name: string; arguments: string },
  kind: CanonicalTool['kind'],
  status: string,
): Json | undefined {
  if (kind === 'custom')
    return {
      type: 'custom_tool_call',
      id: `ctc_${call.id}`,
      call_id: call.id,
      name: call.name,
      input: customInputOf(call.arguments),
      status,
    };
  if (kind === 'apply_patch') {
    const operation = applyPatchOperationOf(call.arguments);
    if (!operation) return undefined;
    return { type: 'apply_patch_call', id: `apc_${call.id}`, call_id: call.id, status, operation };
  }
  return undefined;
}
