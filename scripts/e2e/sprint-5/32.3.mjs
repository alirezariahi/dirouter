/**
 * Card 32.3: canary and percentage traffic splits through Traefik. 10,000 requests land within ±1%
 * of the configured share, a canary that fails is rolled back automatically (the gateway reports
 * it and control-api writes a rolled-back version), and the report compares the two branches.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { published, sleep, urls, waitFor } from '../harness.mjs';

/** Runs `count` jobs with at most `parallel` in flight. */
async function pool(count, parallel, job) {
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < count) await job(next++);
    }),
  );
}

export async function register({ scenario, cleanups, org, createKey }) {
  const suffix = randomUUID().slice(0, 6);
  const createSplit = async (body) => {
    const created = (await published(() => org('POST', 'routing/splits', body, 201))).body;
    cleanups.push(() => org('DELETE', `routing/splits/${created.id}`, undefined, null));
    return created;
  };
  /** Traefik's own answer while its health check has the single dev gateway out of the pool. */
  const fromTraefik = (res, text) =>
    res.status === 503 && !res.headers.get('x-request-id') && text.includes('no available server');
  const ask = async (key, model, headers = {}) => {
    for (let tries = 0; ; tries++) {
      const res = await fetch(`${urls.gateway}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
        body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      // The request never reached the gateway: send it again once Traefik has it back (the same
      // session lands on the same branch, so the share is not affected).
      if (fromTraefik(res, text) && tries < 40) {
        await sleep(250);
        continue;
      }
      return res;
    }
  };

  await scenario(
    '32.3 10,000 requests split within ±1% of the configured canary share',
    async () => {
      const key = await createKey('split');
      const match = `s5-split-${suffix}`;
      const split = await createSplit({
        name: `s5 split ${suffix}`,
        match,
        stable: 'mock/small',
        canary: 'mock/claude',
        canaryPercent: 10,
        stickiness: 'session',
        autoRollback: null,
      });
      let canary = 0;
      // 16 in flight keeps the single dev gateway (tsx, not built) mostly within Traefik's 1 s
      // health-check timeout; a request Traefik refuses meanwhile is sent again by `ask`.
      await pool(10_000, 16, async (i) => {
        const res = await ask(key.key, match, {
          'x-dirouter-session': `s5-${suffix}-${String(i)}`,
        });
        assert.equal(res.status, 200, `request ${String(i)}`);
        const branch = res.headers.get('x-dirouter-split') ?? '';
        if (branch.endsWith('branch=canary')) {
          canary++;
          assert.equal(res.headers.get('x-dirouter-model'), 'mock/claude');
        } else assert.equal(res.headers.get('x-dirouter-model'), 'mock/small');
        assert.ok(branch.startsWith(`${split.id}; v=1;`), branch);
      });
      assert.ok(Math.abs(canary / 100 - 10) <= 1, `canary share ${String(canary / 100)}%`);
    },
  );

  await scenario(
    '32.3 an injected canary failure rolls the split back automatically; the report compares both branches',
    async () => {
      const key = await createKey('canary');
      const match = `s5-canary-${suffix}`;
      const split = await createSplit({
        name: `s5 canary ${suffix}`,
        match,
        stable: 'mock/small',
        canary: 'mock/down',
        canaryPercent: 50,
        stickiness: 'request',
        autoRollback: { errorRate: 0.5, minRequests: 10, windowSeconds: 60 },
      });
      for (let i = 0; i < 60; i++) await ask(key.key, match);
      // control-api turns the gateway's report into a new rolled-back version.
      const rolled = await waitFor('the automatic rollback', async () => {
        const list = (await org('GET', 'routing/splits', undefined, 200)).body;
        const s = list.find((x) => x.id === split.id);
        return s?.state === 'rolled_back' ? s : undefined;
      });
      assert.equal(rolled.version, 2);
      const versions = (await org('GET', `routing/splits/${split.id}/versions`, undefined, 200))
        .body;
      assert.equal(versions[0].reason, 'auto_rollback');
      // From now on every request is served by stable.
      await waitFor('the gateway to load version 2', async () => {
        const res = await ask(key.key, match);
        return res.headers.get('x-dirouter-split') === `${split.id}; v=2; branch=stable`;
      });
      for (let i = 0; i < 10; i++) {
        const res = await ask(key.key, match);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-dirouter-model'), 'mock/small');
      }
      const report = await waitFor('the comparison report', async () => {
        const body = (
          await org('GET', `routing/splits/${split.id}/report?version=1`, undefined, 200)
        ).body;
        return body.canary.errors >= 10 && body.stable.requests > 0 ? body : undefined;
      });
      assert.ok(report.canary.errorRate >= 0.5, JSON.stringify(report.canary));
      assert.equal(report.stable.errors, 0);
      assert.equal(report.canary.model, 'mock/down');
      // Manual instant rollback and restore are new versions too.
      const resumed = (
        await published(() =>
          org('PATCH', `routing/splits/${split.id}`, { canary: 'mock/claude' }, 200),
        )
      ).body;
      assert.equal(resumed.state, 'active');
      const back = (
        await published(() => org('POST', `routing/splits/${split.id}/rollback`, {}, 200))
      ).body;
      assert.equal(back.state, 'rolled_back');
      assert.equal(back.version, 4);
    },
  );
}
