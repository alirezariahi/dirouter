/**
 * Fake AWS Bedrock Converse API (`/model/{modelId}/converse` and `/converse-stream`), so the
 * gateway's Bedrock adapter can be exercised end to end. The signature is not checked. Streams use
 * the binary `vnd.amazon.eventstream` framing with real CRC32 checksums.
 */
import { crc32 } from 'node:zlib';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { STRUCTURED_OUTPUT_TOOL, sampleFor } from './structured.js';

export const BEDROCK_MOCK_TEXT = 'Hello from the DiRouter mock Bedrock.';

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;

/** One eventstream message with string headers (`:event-type`, …) and a JSON payload. */
export function eventFrame(eventType: string, payload: unknown): Buffer {
  const headers: [string, string][] = [
    [':event-type', eventType],
    [':content-type', 'application/json'],
    [':message-type', 'event'],
  ];
  const headerBytes = Buffer.concat(
    headers.map(([name, value]) => {
      const nameBytes = Buffer.from(name, 'utf8');
      const valueBytes = Buffer.from(value, 'utf8');
      const length = Buffer.alloc(2);
      length.writeUInt16BE(valueBytes.length);
      return Buffer.concat([
        Buffer.from([nameBytes.length]),
        nameBytes,
        Buffer.from([7]),
        length,
        valueBytes,
      ]);
    }),
  );
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(12 + headerBytes.length + body.length + 4, 0);
  prelude.writeUInt32BE(headerBytes.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude));
  const withoutCrc = Buffer.concat([prelude, preludeCrc, headerBytes, body]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(withoutCrc));
  return Buffer.concat([withoutCrc, messageCrc]);
}

/** What the mock answers for a Converse request body. */
export function converseAnswer(body: Json): {
  text?: string;
  toolUse?: { toolUseId: string; name: string; input: unknown };
} {
  // Structured output (card 27.1): native output_config.format or the gateway's fallback tool.
  const format = asObject(
    asObject(asObject(body.additionalModelRequestFields)?.output_config)?.format,
  );
  if (format?.type === 'json_schema') return { text: JSON.stringify(sampleFor(format.schema)) };
  const tools = asObject(body.toolConfig)?.tools;
  const fallback = Array.isArray(tools)
    ? (tools as Json[])
        .map((t) => asObject(t.toolSpec))
        .find((spec) => spec?.name === STRUCTURED_OUTPUT_TOOL)
    : undefined;
  if (fallback) {
    const schema = asObject(fallback.inputSchema)?.json;
    return {
      toolUse: {
        toolUseId: 'tooluse_mock1',
        name: STRUCTURED_OUTPUT_TOOL,
        input: sampleFor(schema),
      },
    };
  }
  return { text: BEDROCK_MOCK_TEXT };
}

export interface BedrockHooks {
  record: (req: FastifyRequest, status: number) => void;
}

export function registerBedrock(app: FastifyInstance, hooks: BedrockHooks): void {
  app.post<{ Params: { model: string; action: string } }>(
    '/model/:model/:action',
    async (req, reply) => {
      const { action } = req.params;
      if (action !== 'converse' && action !== 'converse-stream')
        return reply.status(404).send({ message: `unknown action ${action}` });
      const body = asObject(req.body) ?? {};
      const answer = converseAnswer(body);
      const inputTokens = Math.max(
        1,
        Math.ceil(JSON.stringify([body.system, body.messages]).length / 4),
      );
      const outputTokens = answer.toolUse ? 12 : Math.ceil((answer.text?.length ?? 0) / 4);
      const usage: Json = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
      const stopReason = answer.toolUse ? 'tool_use' : 'end_turn';
      hooks.record(req, 200);

      if (action === 'converse') {
        return reply.send({
          output: {
            message: {
              role: 'assistant',
              content: answer.toolUse ? [{ toolUse: answer.toolUse }] : [{ text: answer.text }],
            },
          },
          stopReason,
          usage,
          metrics: { latencyMs: 1 },
        });
      }

      const frames: Buffer[] = [eventFrame('messageStart', { role: 'assistant' })];
      if (answer.toolUse) {
        const json = JSON.stringify(answer.toolUse.input);
        const half = Math.ceil(json.length / 2);
        frames.push(
          eventFrame('contentBlockStart', {
            contentBlockIndex: 0,
            start: {
              toolUse: { toolUseId: answer.toolUse.toolUseId, name: answer.toolUse.name },
            },
          }),
          ...[json.slice(0, half), json.slice(half)].map((input) =>
            eventFrame('contentBlockDelta', {
              contentBlockIndex: 0,
              delta: { toolUse: { input } },
            }),
          ),
        );
      } else {
        const text = answer.text ?? '';
        const half = Math.ceil(text.length / 2);
        frames.push(
          ...[text.slice(0, half), text.slice(half)].map((piece) =>
            eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: piece } }),
          ),
        );
      }
      frames.push(
        eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
        eventFrame('messageStop', { stopReason }),
        eventFrame('metadata', { usage, metrics: { latencyMs: 1 } }),
      );
      return reply
        .header('content-type', 'application/vnd.amazon.eventstream')
        .send(Buffer.concat(frames));
    },
  );
}
