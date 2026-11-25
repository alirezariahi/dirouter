/** BodySink job ids: BullMQ refuses custom ids with ':' and purely numeric ones. */
import type { RequestBodyRecord } from '@dirouter/contracts';
import { createLogger } from '@dirouter/shared';
import { describe, expect, it, vi } from 'vitest';

const added = vi.hoisted(() => [] as { jobId?: string }[]);

vi.mock('ioredis', () => ({
  Redis: class {
    status = 'ready';
    on() {
      return this;
    }
    disconnect() {
      return undefined;
    }
  },
}));
vi.mock('bullmq', () => ({
  Queue: class {
    on() {
      return this;
    }
    add(_name: string, _data: unknown, opts: { jobId?: string }) {
      // BullMQ's own rule for custom job ids.
      if (opts.jobId?.includes(':') || /^\d+$/.test(opts.jobId ?? ''))
        return Promise.reject(new Error('Custom Id cannot contain : or be an integer'));
      added.push(opts);
      return Promise.resolve({});
    }
    close() {
      return Promise.resolve();
    }
  },
}));

const { BodySink } = await import('./body-capture.js');

describe('BodySink', () => {
  it('queues bodies whose client request id holds a colon or is purely numeric', async () => {
    const sink = new BodySink(
      'redis://127.0.0.1:6379',
      createLogger({ service: 't', level: 'silent' }),
    );
    for (const requestId of ['trace:123:abc', '424242', 'req_plain'])
      sink.record({ requestId } as RequestBodyRecord);
    await vi.waitFor(() => {
      expect(sink.stats.queued + sink.stats.dropped).toBe(3);
    });
    expect(sink.stats).toEqual({ queued: 3, dropped: 0 });
    expect(added.map((o) => o.jobId)).toEqual(['trace%3A123%3Aabc', 'id-424242', 'req_plain']);
    await sink.close();
  });
});
