/**
 * Sends MCP tool-call records to the `mcp-calls` queue (card 20.1). Unlike usage events these are
 * an audit trail, not money: sending is best effort, and a record that cannot be queued (Valkey
 * down) is counted and dropped rather than blocking the call.
 */
import { MCP_CALLS_QUEUE, type McpCallRecord } from '@dirouter/contracts';
import { connectValkey, type Logger } from '@dirouter/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export class McpCallSink {
  readonly #queue: Queue;
  readonly stats = { queued: 0, dropped: 0 };

  constructor(
    valkeyUrl: string,
    private readonly logger: Logger,
  ) {
    const connection = connectValkey(Redis, valkeyUrl, { maxRetriesPerRequest: null });
    connection.on('error', () => undefined);
    this.#queue = new Queue(MCP_CALLS_QUEUE, { connection });
  }

  record(call: McpCallRecord): void {
    void this.#queue
      .add('call', call, {
        jobId: call.id,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
      })
      .then(() => {
        this.stats.queued++;
      })
      .catch((error: unknown) => {
        this.stats.dropped++;
        this.logger.warn({ err: error, tool: call.tool }, 'MCP call record dropped');
      });
  }

  close(): Promise<void> {
    return this.#queue.close();
  }
}
