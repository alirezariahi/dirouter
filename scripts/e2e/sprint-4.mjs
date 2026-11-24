/* eslint-disable no-console */
/**
 * Sprint 4 end-to-end checks against the development stack (make up && make seed). Every scenario
 * goes through Traefik like a client would and names the board card it verifies.
 *
 *   node scripts/e2e/sprint-4.mjs         # everything
 *   node scripts/e2e/sprint-4.mjs 23.1    # only scenarios whose name contains one of these
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import {
  adminClient,
  chat,
  createRunner,
  login,
  published,
  readEnv,
  request,
  root,
  sql,
  urls,
  waitFor,
} from './harness.mjs';

const exec = promisify(execFile);
const ORG = 'org_dev';
const { scenario, cleanups, finish } = createRunner();

const sseEvents = (text) =>
  text
    .split(/\n\n+/)
    .map((frame) => {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) return undefined;
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    })
    .filter(Boolean);

/** Text the client received in an OpenAI or Anthropic stream. */
const streamedText = (text) =>
  sseEvents(text)
    .map(
      (e) =>
        e?.choices?.[0]?.delta?.content ??
        (e?.type === 'content_block_delta' ? e.delta.text : '') ??
        '',
    )
    .join('');

/** The mock answers every request with `text`, in `chunks` SSE events (no commas allowed). */
const mockSays = (text, chunks = 10) =>
  request(
    `${urls.mock}/__mock/config`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directives: `text=${text},chunks=${chunks}` }),
    },
    200,
  );
const mockReset = () => request(`${urls.mock}/__mock/reset`, { method: 'POST' }, 200);

/** Gateway log lines (JSON) since `since`, for checks on what the gateway recorded. */
async function gatewayLog(since) {
  const { stdout, stderr } = await exec(
    'docker',
    ['logs', '--since', since, 'dirouter-gateway-1'],
    {
      cwd: root,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  return `${stdout}\n${stderr}`
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

async function gatewayMetric(name) {
  const { stdout } = await exec('docker', [
    'exec',
    'dirouter-gateway-1',
    'wget',
    '-qO-',
    '127.0.0.1:8080/metrics',
  ]);
  return stdout.split('\n').filter((line) => line.startsWith(name));
}

let crashed = false;
try {
  const seedAdmin = await readEnv('.data/seed-admin.env');
  const api = adminClient(await login(seedAdmin.SEED_ADMIN_EMAIL, seedAdmin.SEED_ADMIN_PASSWORD));
  const org = (method, path, body, expected) => api(method, `orgs/${ORG}/${path}`, body, expected);

  async function createKey(name) {
    const { body } = await published(() =>
      org(
        'POST',
        'keys',
        { name: `s4-${name}-${randomUUID().slice(0, 6)}`, projectId: 'prj_dev' },
        201,
      ),
    );
    await waitFor(`gateway to know key ${body.id}`, async () => {
      const probe = await fetch(`${urls.gateway}/v1/models`, {
        headers: { authorization: `Bearer ${body.key}` },
      });
      return probe.status === 200;
    });
    cleanups.push(() => org('POST', `keys/${body.id}/revoke`, undefined, null));
    return body;
  }

  /** Streams one request through OpenAI and Anthropic inbound APIs. */
  async function streams(key) {
    const out = [];
    for (const [path, extra] of [
      ['v1/chat/completions', {}],
      ['v1/messages', { 'anthropic-version': '2023-06-01' }],
    ]) {
      const res = await request(`${urls.gateway}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extra },
        body: JSON.stringify({
          model: 'mock/small',
          max_tokens: 100,
          stream: true,
          messages: [{ role: 'user', content: 'answer' }],
        }),
      });
      out.push({ path, status: res.response.status, raw: res.text, text: streamedText(res.text) });
    }
    return out;
  }

  // ───────────── Epic 23: guardrails ─────────────

  await scenario(
    '23.1 secret and json_schema guardrails are enforced (request, answer, stream), live test agrees, unknown types are reported',
    async () => {
      const policy = async (body) => {
        const created = (
          await published(() =>
            org('POST', 'guardrails', { name: `s4-${randomUUID().slice(0, 6)}`, ...body }, 201),
          )
        ).body;
        const remove = () =>
          published(() => org('DELETE', `guardrails/${created.id}`, undefined, 204));
        cleanups.push(() => org('DELETE', `guardrails/${created.id}`, undefined, null));
        return { ...created, remove };
      };
      const key = await createKey('guardrail');
      const scoped = { virtualKeyId: key.id };
      const secret = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx123456';
      cleanups.push(() => mockReset());

      // 1. secret + block on the request: the provider never sees it.
      const block = await policy({ ...scoped, type: 'secret', stage: 'both', action: 'block' });
      await mockReset();
      const asked = await chat(key.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: `please use my key ${secret} for this` }],
      });
      assert.equal(asked.response.status, 400, asked.text);
      assert.match(asked.body.error.message, /blocked by guardrail/);
      const upstream = (await request(`${urls.mock}/__mock/stats`, {}, 200)).body;
      assert.equal(upstream.last?.length ?? 0, 0, 'the request must not reach the provider');

      // 2. ... on the answer (JSON) and on streams split into small chunks.
      await mockSays(`Your key is ${secret} keep it safe`, 14);
      const answered = await chat(key.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: 'what is my key?' }],
      });
      assert.equal(answered.response.status, 400, answered.text);
      assert.ok(!answered.text.includes('sk-proj'), answered.text);
      for (const s of await streams(key.key)) {
        assert.ok(!s.raw.includes('sk-proj') && !s.raw.includes('AbCdEf'), `${s.path}: ${s.raw}`);
        assert.match(s.raw, /blocked by guardrail/, `${s.path}: no error event`);
      }
      await block.remove();

      // 3. secret + redact on the answer: the sentence arrives, the key does not.
      const redact = await policy({
        ...scoped,
        type: 'secret',
        stage: 'response',
        action: 'redact',
      });
      const redacted = await chat(key.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: 'what is my key?' }],
      });
      assert.equal(redacted.response.status, 200, redacted.text);
      assert.equal(redacted.body.choices[0].message.content, 'Your key is [REDACTED] keep it safe');
      for (const s of await streams(key.key)) {
        assert.equal(s.status, 200);
        assert.equal(s.text, 'Your key is [REDACTED] keep it safe', s.path);
      }
      await redact.remove();

      // 4. json_schema + block: a conforming answer passes, a wrong one is refused, also in streams.
      const schema = await policy({
        ...scoped,
        type: 'json_schema',
        stage: 'response',
        action: 'block',
        config: {
          schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        },
      });
      await mockSays('{"ok":true}', 4);
      const good = await chat(key.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: 'json' }],
      });
      assert.equal(good.response.status, 200, good.text);
      for (const s of await streams(key.key)) assert.equal(s.text, '{"ok":true}', s.path);
      await mockSays('{"ok":"yes"}', 4);
      const bad = await chat(key.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: 'json' }],
      });
      assert.equal(bad.response.status, 400, bad.text);
      assert.match(bad.body.error.message, /does not match the required schema/);
      for (const s of await streams(key.key)) {
        // The whole answer is held, so not even its first characters reach the client.
        assert.equal(s.text, '', `${s.path}: ${s.text}`);
        assert.match(s.raw, /does not match the required schema/, s.path);
      }
      await schema.remove();

      // 5. json_schema + flag: the answer passes and the hit is in the gateway log.
      await policy({
        ...scoped,
        type: 'json_schema',
        stage: 'response',
        action: 'flag',
        config: { schema: { type: 'object', required: ['ok'] } },
      });
      await mockSays('not json at all', 3);
      const since = new Date(Date.now() - 1000).toISOString();
      const flagged = await chat(key.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: 'json' }],
      });
      assert.equal(flagged.response.status, 200, flagged.text);
      const requestId = flagged.response.headers.get('x-request-id');
      const flagLine = await waitFor('flag hit in the gateway log', async () =>
        (await gatewayLog(since)).find(
          (l) =>
            l.requestId === requestId &&
            l.msg === 'guardrail hits' &&
            l.guardrails?.some((g) => g.type === 'json_schema' && g.action === 'flag'),
        ),
      );
      assert.equal(flagLine.stage, 'response');

      // 6. The live test gives the same verdicts.
      const live = (body) => org('POST', 'guardrails/test', body, 200);
      assert.equal(
        (await live({ type: 'secret', action: 'block', config: {}, text: `key ${secret}` })).body
          .blocked,
        true,
      );
      const liveSchema = (
        await live({
          type: 'json_schema',
          action: 'block',
          config: {
            schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
          },
          text: '{"ok":"yes"}',
        })
      ).body;
      assert.equal(liveSchema.blocked, true);
      assert.deepEqual(liveSchema.schemaErrors, ['$.ok: expected boolean, got string']);

      // 7. A schema the gateway would not fully enforce cannot be saved.
      const refused = await org(
        'POST',
        'guardrails',
        { name: 's4-ref', type: 'json_schema', config: { schema: { $ref: '#/x' } } },
        400,
      );
      assert.match(JSON.stringify(refused.body), /unsupported keyword/);

      // 8. A policy type this gateway does not know: requests still work, the gateway warns and counts it.
      const unknownId = `grd_s4unknown${randomUUID().slice(0, 6)}`;
      await sql(`INSERT INTO guardrail_policies (id, organization_id, name, type, action, virtual_key_id, updated_at)
                 VALUES ('${unknownId}', '${ORG}', 's4-unknown', 'moderation', 'block', '${key.id}', now())`);
      cleanups.push(() => sql(`DELETE FROM guardrail_policies WHERE id = '${unknownId}'`));
      // Any guardrail change republishes the snapshot, now including the inserted row.
      const nudge = await policy({
        ...scoped,
        type: 'keyword',
        action: 'flag',
        config: { terms: ['zzz-none'] },
      });
      await nudge.remove();
      const before = (await gatewayMetric('dirouter_gateway_guardrail_unknown_total')).find((l) =>
        l.includes('type="moderation"'),
      );
      const sinceUnknown = new Date(Date.now() - 1000).toISOString();
      await mockReset();
      const passes = await chat(key.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(passes.response.status, 200, passes.text);
      const unknownId2 = passes.response.headers.get('x-request-id');
      await waitFor('unknown-type warning in the gateway log', async () =>
        (await gatewayLog(sinceUnknown)).find(
          (l) =>
            l.requestId === unknownId2 &&
            l.level === 'warn' &&
            l.type === 'moderation' &&
            l.policyId === unknownId,
        ),
      );
      const after = (await gatewayMetric('dirouter_gateway_guardrail_unknown_total')).find((l) =>
        l.includes('type="moderation"'),
      );
      const value = (line) => Number(line?.split(' ').at(-1) ?? 0);
      assert.ok(value(after) > value(before), `${before} → ${after}`);
      console.log(`     unknown-type metric ${value(before)} → ${value(after)}`);
    },
  );
} catch (error) {
  crashed = true;
  console.error(error);
} finally {
  await finish(crashed);
}
