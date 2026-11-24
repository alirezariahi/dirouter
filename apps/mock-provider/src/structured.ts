/**
 * Structured output in the mock (card 27.1): when a request asks for JSON that follows a schema
 * (Anthropic `output_config.format`, the gateway's fallback tool, or Bedrock's equivalent), the
 * mock answers with a value built from that schema, so end-to-end tests can validate it.
 */

/** Name of the gateway's structured-output fallback tool (see `@dirouter/translator`). */
export const STRUCTURED_OUTPUT_TOOL = 'dirouter_structured_output';

type Schema = Record<string, unknown>;

const asSchema = (value: unknown): Schema | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Schema) : undefined;

/** A small value that conforms to the common JSON Schema keywords. */
export function sampleFor(schema: unknown, depth = 0): unknown {
  const s = asSchema(schema);
  if (!s || depth > 8) return null;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const anyOf = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(anyOf) && anyOf.length > 0) return sampleFor(anyOf[0], depth + 1);
  const type = Array.isArray(s.type) ? (s.type[0] as unknown) : s.type;
  switch (type) {
    case 'string':
      return 'mock';
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
      const min = typeof s.minItems === 'number' ? s.minItems : 0;
      return Array.from({ length: min }, () => sampleFor(s.items, depth + 1));
    }
    default: {
      const properties = asSchema(s.properties) ?? {};
      const out: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(properties))
        out[name] = sampleFor(child, depth + 1);
      return out;
    }
  }
}

/** Schema of an Anthropic request's `output_config.format`, if any. */
export function anthropicNativeSchema(body: Record<string, unknown>): unknown {
  const config = asSchema(body.output_config);
  const format = asSchema(config?.format);
  return format?.type === 'json_schema' ? format.schema : undefined;
}

/** Input schema of the fallback tool when an Anthropic request forces (or allows) it. */
export function anthropicFallbackSchema(body: Record<string, unknown>): unknown {
  const tools = Array.isArray(body.tools) ? (body.tools as Schema[]) : [];
  const tool = tools.find((t) => t.name === STRUCTURED_OUTPUT_TOOL);
  return tool ? (tool.input_schema ?? {}) : undefined;
}
