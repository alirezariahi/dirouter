import { Writable } from 'node:stream';

import { createLogger, createQueueMetrics } from '@dirouter/shared';
import { describe, expect, it } from 'vitest';

import { createMetrics } from './metrics.js';

describe('worker and queue metrics', () => {
  it('exports queue depth and usage/maintenance job durations', async () => {
    const metrics = createMetrics([
      { name: 'usage', counts: () => Promise.resolve({ waiting: 3, active: 1 }) },
    ]);
    metrics.usageWritten.inc();
    metrics.usageFailed.inc();
    metrics.usageDead.inc();
    metrics.jobDuration.observe({ job: 'usage', outcome: 'success' }, 0.025);
    metrics.jobDuration.observe({ job: 'rollup', outcome: 'error' }, 2);
    const text = await metrics.registry.metrics();
    expect(text).toContain('dirouter_queue_jobs{queue="usage",state="waiting"} 3');
    expect(text).toContain('dirouter_queue_jobs{queue="usage",state="active"} 1');
    expect(text).toContain('dirouter_usage_events_written_total 1');
    expect(text).toContain(
      'dirouter_worker_job_duration_seconds_count{job="usage",outcome="success"} 1',
    );
    expect(text).toContain(
      'dirouter_worker_job_duration_seconds_count{job="rollup",outcome="error"} 1',
    );
  });

  it('times out an unavailable queue without failing the scrape', async () => {
    const { Registry } = await import('prom-client');
    const registry = new Registry();
    createQueueMetrics(registry, [{ name: 'usage', counts: () => new Promise(() => undefined) }], {
      timeoutMs: 5,
    });
    const text = await registry.metrics();
    expect(text).toContain('dirouter_queue_metrics_up 0');
  });

  it('writes structured logs with correlation metadata and no event payload', () => {
    const lines: Record<string, unknown>[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        done();
      },
    });
    const logger = createLogger({ service: 'worker', level: 'info', destination });
    const event = {
      requestId: 'req_correlated',
      virtualKeyId: 'key_private',
      endUser: 'user_private',
    };
    logger.info(
      { requestId: event.requestId, jobId: event.requestId, status: 'written' },
      'usage event written',
    );
    expect(lines[0]).toMatchObject({ requestId: 'req_correlated', status: 'written' });
    expect(JSON.stringify(lines)).not.toContain('private');
  });
});
