/* eslint-disable no-console */
/** Control-plane scenarios of the sprint 2 end-to-end run (see sprint-2.mjs). */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compose = ['compose', '-f', 'compose.yaml', '-f', 'compose.dev.yaml'];
const env = { ...process.env, GRAFANA_ADMIN_PASSWORD: 'e2e-not-used' };
const gateway = process.env.E2E_GATEWAY_URL ?? 'http://api.localhost';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ───────────── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ─────────────
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text) {
  let bits = '';
  for (const char of text.replace(/=+$/, '').toUpperCase())
    bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** Hands out each time step once, like a real authenticator used by one person. */
function authenticator(secret) {
  let last = 0;
  return {
    async next() {
      for (;;) {
        const now = Math.floor(Date.now() / 30_000);
        const step = Math.max(now, last + 1);
        // The server accepts one step of clock drift either way.
        if (step <= now + 1) {
          last = step;
          return totp(secret, step);
        }
        await sleep(1_000);
      }
    },
    last: () => totp(secret, last),
  };
}

export default async function controlScenarios(scenario, t) {
  const { main, modelId, org, api, createKey, published, chat, request, sql } = t;
  const { logRow, waitFor, mockStats, mockReset, cleanups, owner } = t;

  /** Invites a user and accepts the invitation; returns the session and credentials. */
  async function newMember(role) {
    const email = `s2-${role.toLowerCase()}-${randomUUID().slice(0, 8)}@e2e.test`;
    const password = `Pw-${randomUUID()}`;
    const invite = (await org('POST', 'invitations', { email, role }, 201)).body;
    const session = (
      await api(
        'POST',
        'auth/invitations/accept',
        { token: invite.token, name: `E2E ${role}`, password },
        null,
        '',
      )
    ).body;
    assert.ok(session.accessToken, JSON.stringify(session));
    cleanups.push(() => org('DELETE', `members/${session.user.id}`, undefined, null));
    return { email, password, id: session.user.id, token: session.accessToken };
  }
  const login = (user, mfaCode) =>
    api(
      'POST',
      'auth/login',
      { email: user.email, password: user.password, ...(mfaCode ? { mfaCode } : {}) },
      null,
      '',
    );

  await scenario(
    '12.5 routing simulator: same decision as the gateway, no upstream call',
    async () => {
      // A clean health state: the failing provider of the `dev` combo is not skipped for an open
      // breaker left behind by earlier scenarios.
      await org('POST', 'health/reset', { scope: 'provider', id: 'prv_mock-down' }, null);
      await org('POST', 'health/reset', { scope: 'model', id: 'mdl_dev_mock_down' }, null);
      await new Promise((done) => setTimeout(done, 1_000));
      await mockReset();
      const result = (
        await org('POST', 'routes/simulate', {
          model: 'dev',
          virtualKeyId: main.id,
          estimatedInputTokens: 100,
        })
      ).body;
      assert.equal(result.kind, 'combo');
      assert.ok(result.candidates.length >= 2);
      assert.equal((await mockStats()).requests, 0, 'dry run');
      // The real request tries the same targets in the same order.
      const real = await chat(main.key, {
        model: 'dev',
        messages: [{ role: 'user', content: 'x' }],
      });
      assert.ok(
        result.candidates
          .map((c) => c.provider)
          .includes(real.response.headers.get('x-dirouter-provider')),
      );
      const tooBig = (
        await org(
          'POST',
          'routes/simulate',
          { model: 'mock/small', virtualKeyId: main.id, estimatedInputTokens: 50_000_000 },
          null,
        )
      ).body;
      assert.ok(JSON.stringify(tooBig).includes('context'), JSON.stringify(tooBig).slice(0, 300));
      const unknown = await org(
        'POST',
        'routes/simulate',
        { model: 'no-such-model', virtualKeyId: main.id },
        null,
      );
      assert.ok(
        JSON.stringify(unknown.body).includes('model_not_found'),
        unknown.text.slice(0, 300),
      );
    },
  );

  let member;
  let viewer;
  await scenario(
    '14.1 MFA: TOTP enrolment, login, replay and brute-force protection, organization policy',
    async () => {
      member = await newMember('MEMBER');
      const setup = (await api('POST', 'auth/mfa/setup', {}, 200, member.token)).body;
      assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\//);
      const device = authenticator(setup.secret);
      // A wrong code does not enable anything.
      assert.notEqual(
        (await api('POST', 'auth/mfa/verify', { code: '000000' }, null, member.token)).response
          .status,
        200,
      );
      const verified = await api(
        'POST',
        'auth/mfa/verify',
        { code: await device.next() },
        200,
        member.token,
      );
      assert.equal(verified.body.backupCodes.length, 10);
      assert.equal((await api('GET', 'auth/mfa', undefined, 200, member.token)).body.enabled, true);

      const noCode = await login(member);
      assert.notEqual(noCode.response.status, 200);
      assert.match(JSON.stringify(noCode.body), /mfa_required/);
      assert.notEqual((await login(member, '123456')).response.status, 200);
      const good = await login(member, await device.next());
      assert.equal(good.response.status, 200, good.text);
      // The same code a second time is a replay.
      assert.notEqual(
        (await login(member, device.last())).response.status,
        200,
        'replayed code accepted',
      );
      // A recovery code works once.
      const recovery = verified.body.backupCodes[0];
      assert.equal((await login(member, recovery)).response.status, 200);
      assert.notEqual((await login(member, recovery)).response.status, 200);
      member.token = good.body.accessToken;
      // The authenticator cannot be replaced without proving possession of the current one.
      assert.notEqual(
        (await api('POST', 'auth/mfa/setup', {}, null, member.token)).response.status,
        200,
      );
      assert.equal((await api('GET', 'auth/mfa', undefined, 200, member.token)).body.enabled, true);

      // Organization policy: members without a second factor are locked out of the organization.
      viewer = await newMember('VIEWER');
      assert.equal(
        (await org('GET', 'models', undefined, null, viewer.token)).response.status,
        200,
      );
      await org('PATCH', 'security', { mfaRequiredRoles: ['VIEWER', 'MEMBER'] });
      cleanups.push(() => org('PATCH', 'security', { mfaRequiredRoles: [] }, null));
      const locked = await org('GET', 'models', undefined, null, viewer.token);
      assert.equal(locked.response.status, 403, locked.text);
      assert.match(locked.text, /mfa/i);
      assert.equal(
        (await org('GET', 'models', undefined, null, member.token)).response.status,
        200,
      );
      await org('PATCH', 'security', { mfaRequiredRoles: [] });

      // Brute force: repeated wrong codes lock the account like wrong passwords do.
      const victim = await newMember('VIEWER');
      const secret = (await api('POST', 'auth/mfa/setup', {}, 200, victim.token)).body.secret;
      const victimDevice = authenticator(secret);
      await api('POST', 'auth/mfa/verify', { code: await victimDevice.next() }, 200, victim.token);
      let lockedOut = false;
      for (let i = 0; i < 12 && !lockedOut; i++) {
        const attempt = await login(victim, String(100_000 + i));
        lockedOut = attempt.response.status === 429 || /locked|too many/i.test(attempt.text);
      }
      assert.ok(lockedOut, 'wrong second-factor codes are rate limited');
    },
  );

  await scenario(
    '14.3 custom roles: extra permissions apply, escalation paths are closed',
    async () => {
      viewer ??= await newMember('VIEWER');
      const role = (
        await org(
          'POST',
          'custom-roles',
          {
            name: `s2-keys-${randomUUID().slice(0, 6)}`,
            permissions: ['keys:read', 'keys:write', 'members:write'],
          },
          201,
        )
      ).body;
      cleanups.push(() => org('DELETE', `custom-roles/${role.id}`, undefined, null));
      const body = { name: `s2-role-key-${randomUUID().slice(0, 6)}`, projectId: 'prj_dev' };
      assert.equal((await org('POST', 'keys', body, null, viewer.token)).response.status, 403);
      await org('PATCH', `members/${viewer.id}`, { role: 'VIEWER', customRoleId: role.id });
      const created = await org('POST', 'keys', body, null, viewer.token);
      assert.equal(created.response.status, 201, created.text);
      cleanups.push(() => org('POST', `keys/${created.body.id}/revoke`, undefined, null));
      const me = (await api('GET', 'auth/me', undefined, 200, viewer.token)).body;
      assert.ok(me.organizations[0].permissions.includes('keys:write'));
      // Still nothing beyond the role.
      assert.equal(
        (
          await org(
            'POST',
            'providers',
            { name: 'x', slug: `x-${randomUUID().slice(0, 6)}`, type: 'openai' },
            null,
            viewer.token,
          )
        ).response.status,
        403,
      );
      // Escalation attempts by a member who holds members:write through a custom role.
      const strong = (
        await org(
          'POST',
          'custom-roles',
          {
            name: `s2-strong-${randomUUID().slice(0, 6)}`,
            permissions: ['providers:write', 'config:write', 'security:write'],
          },
          201,
        )
      ).body;
      cleanups.push(() => org('DELETE', `custom-roles/${strong.id}`, undefined, null));
      const attempts = {
        'assign a stronger role to oneself': await org(
          'PATCH',
          `members/${viewer.id}`,
          { role: 'VIEWER', customRoleId: strong.id },
          null,
          viewer.token,
        ),
        'promote oneself': await org(
          'PATCH',
          `members/${viewer.id}`,
          { role: 'ADMIN' },
          null,
          viewer.token,
        ),
        'demote the owner': await org(
          'PATCH',
          `members/${owner.id}`,
          { role: 'VIEWER' },
          null,
          viewer.token,
        ),
        'remove the owner': await org(
          'DELETE',
          `members/${owner.id}`,
          undefined,
          null,
          viewer.token,
        ),
        'create a role without security:write': await org(
          'POST',
          'custom-roles',
          { name: 'x', permissions: ['org:read'] },
          null,
          viewer.token,
        ),
      };
      for (const [what, res] of Object.entries(attempts))
        assert.ok(
          res.response.status === 403 || res.response.status === 400,
          `${what}: HTTP ${res.response.status} ${res.text.slice(0, 200)}`,
        );
      // An admin cannot put permissions into a role that the admin does not hold... the owner can.
      const admin = await newMember('ADMIN');
      const adminRole = await org(
        'POST',
        'custom-roles',
        { name: `s2-admin-${randomUUID().slice(0, 6)}`, permissions: ['keys:read'] },
        null,
        admin.token,
      );
      assert.equal(adminRole.response.status, 201, adminRole.text);
      cleanups.push(() => org('DELETE', `custom-roles/${adminRole.body.id}`, undefined, null));
      assert.equal(
        (await org('PATCH', `members/${owner.id}`, { role: 'ADMIN' }, null, admin.token)).response
          .status,
        403,
      );
      // SSO connections are owner-only.
      const sso = await org(
        'POST',
        'sso',
        {
          name: 'x',
          issuer: 'https://idp.example.com',
          clientId: 'x',
          clientSecret: 'x',
          allowedDomains: ['example.com'],
        },
        null,
        admin.token,
      );
      assert.equal(sso.response.status, 403, sso.text);
      t.admin = admin;
    },
  );

  await scenario(
    '14.4 audit log: security-relevant actions are recorded, filterable, exportable and append-only',
    async () => {
      const all = (await org('GET', 'audit?limit=500')).body;
      const items = all.items ?? all;
      const actions = new Set(items.map((row) => row.action));
      for (const expected of [
        'custom_role.created',
        'member.role_changed',
        'key.created',
        // Present when the MFA scenario ran in this session.
        ...(member ? ['mfa.enabled'] : []),
      ])
        assert.ok(
          [...actions].some(
            (a) => a === expected || a.replace(/[._]/g, '') === expected.replace(/[._]/g, ''),
          ),
          `missing audit action ${expected}; have ${[...actions].sort().join(', ')}`,
        );
      assert.ok(
        !JSON.stringify(items).match(
          /dr-[a-z]+-[A-Za-z0-9]{20,}|otpauth:|"secret":"(?!\*\*\*)[^"]{8,}/,
        ),
        'no secrets in audit rows',
      );
      const one = [...actions][0];
      const filtered = (await org('GET', `audit?action=${encodeURIComponent(one)}&limit=50`)).body;
      assert.ok((filtered.items ?? filtered).every((row) => row.action === one));
      const csv = await org('GET', 'audit/export', undefined, 200);
      assert.ok(csv.text.split('\n').length > 5 && /action/i.test(csv.text.split('\n')[0]));
      // Even with direct database access the trail cannot be rewritten.
      await assert.rejects(
        sql(
          "UPDATE audit_logs SET action = 'tampered' WHERE id = (SELECT id FROM audit_logs LIMIT 1)",
        ),
        /append-only/,
      );
      await assert.rejects(
        sql('DELETE FROM audit_logs WHERE id = (SELECT id FROM audit_logs LIMIT 1)'),
        /append-only/,
      );
      // A viewer may read it only with audit:read (VIEWER has it by the read rule); no token, no data.
      assert.equal((await org('GET', 'audit', undefined, null, '')).response.status, 401);
    },
  );

  await scenario('15.2 guardrail policies: CRUD, preview, validation and permissions', async () => {
    const created = (
      await org(
        'POST',
        'guardrails',
        {
          name: `s2-crud-${randomUUID().slice(0, 6)}`,
          type: 'regex',
          action: 'redact',
          stage: 'both',
          config: { pattern: 'ticket-\\d+' },
          enabled: false,
          virtualKeyId: main.id,
        },
        201,
      )
    ).body;
    cleanups.push(() => org('DELETE', `guardrails/${created.id}`, undefined, null));
    assert.ok((await org('GET', 'guardrails')).body.some((p) => p.id === created.id));
    const patched = (
      await org('PATCH', `guardrails/${created.id}`, { enabled: true, action: 'block' })
    ).body;
    assert.equal(patched.action, 'block');
    const preview = (
      await org(
        'POST',
        'guardrails/test',
        {
          type: 'regex',
          action: 'redact',
          config: { pattern: 'ticket-\\d+' },
          text: 'see ticket-4821 please',
        },
        null,
      )
    ).body;
    assert.equal(preview.redactedText, 'see [REDACTED] please', JSON.stringify(preview));
    assert.deepEqual(preview.matches, ['ticket-4821']);
    const pii = (
      await org(
        'POST',
        'guardrails/test',
        {
          type: 'pii',
          action: 'redact',
          config: { type: 'credit_card' },
          text: 'card 4111 1111 1111 1111 and 1234 5678 9012 3456',
        },
        null,
      )
    ).body;
    assert.ok(
      pii.redactedText.includes('1234 5678 9012 3456'),
      'a random 16-digit number is not a card',
    );
    assert.ok(!pii.redactedText.includes('4111 1111 1111 1111'), JSON.stringify(pii));
    assert.equal(
      (
        await org(
          'POST',
          'guardrails/test',
          { type: 'regex', config: { pattern: '(a+)+$' }, text: 'aaaa' },
          null,
        )
      ).response.status,
      400,
    );
    assert.equal(
      (await org('PATCH', `guardrails/${created.id}`, { config: { pattern: '(.*)*x' } }, null))
        .response.status,
      400,
    );
    viewer ??= await newMember('VIEWER');
    const fresh = await newMember('VIEWER');
    assert.equal(
      (await org('GET', 'guardrails', undefined, null, fresh.token)).response.status,
      200,
    );
    assert.equal(
      (
        await org(
          'POST',
          'guardrails/test',
          { type: 'regex', config: { pattern: 'a' }, text: 'a' },
          null,
          fresh.token,
        )
      ).response.status,
      403,
    );
    assert.equal(
      (await org('DELETE', `guardrails/${created.id}`, undefined, null, fresh.token)).response
        .status,
      403,
    );
    await org('DELETE', `guardrails/${created.id}`, undefined, 204);
  });

  await scenario('16.1 cost page: totals equal the usage ledger', async () => {
    // Fresh, billable traffic on a dedicated key, then both views of the same closed window.
    const key = await createKey('cost');
    const from = new Date(Date.now() - 1_000).toISOString();
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const id = `e2e_cost_${randomUUID()}`;
      ids.push(id);
      await chat(
        key.key,
        {
          model: i % 2 ? 'mock/small' : 'mock/claude',
          messages: [{ role: 'user', content: `cost ${i} ${'x'.repeat(i * 40)}` }],
        },
        { 'x-request-id': id },
      );
    }
    for (const id of ids) await logRow(id);
    const to = new Date(Date.now() + 1_000).toISOString();
    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&apiKeyId=${key.id}`;
    const ledgerSql = await sql(
      `SELECT coalesce(sum(cost_usd),0), count(*) FROM usage_ledger WHERE api_key_id = '${key.id}'`,
    );
    const [ledgerTotal, ledgerCount] = ledgerSql.split('|');
    assert.equal(ledgerCount, '12');
    assert.ok(Number(ledgerTotal) > 0);
    const ledgerRows = (await org('GET', `stats/ledger?${query}`)).body.rows;
    assert.equal(ledgerRows.length, 12);
    const sum = (rows) => rows.reduce((total, row) => total + Number(row.costUsd), 0);
    assert.ok(
      Math.abs(sum(ledgerRows) - Number(ledgerTotal)) < 1e-9,
      'ledger API rows equal the table',
    );
    // The cost page shows the aggregated total (rollups, refreshed periodically) next to the
    // ledger total; once the rollup has run they must be the same number.
    const cost = await waitFor(
      'cost total to equal the ledger',
      async () => {
        const body = (await org('GET', `stats/cost?${query}`)).body;
        return Math.abs(Number(body.overview.costUsd) - Number(ledgerTotal)) < 1e-9
          ? body
          : undefined;
      },
      120_000,
    );
    assert.equal(cost.overview.requests, 12);
    assert.equal(cost.ledgerTotal.entries, 12);
    assert.ok(Math.abs(Number(cost.ledgerTotal.costUsd) - Number(ledgerTotal)) < 1e-9);
    assert.ok(
      Math.abs(sum(cost.series.points) - Number(ledgerTotal)) < 1e-9,
      'series adds up to the total',
    );
    t.costEvidence = { ledgerTotal, requests: 12 };
  });

  await scenario(
    '16.2 alerts: rule fires once, webhook is signed, secrets are masked',
    async () => {
      const file = '.verify/alerts-e2e.jsonl';
      await rm(resolve(root, file), { force: true });
      const sink = spawn(
        'docker',
        [
          ...compose,
          'exec',
          '-T',
          'dev-deps',
          'node',
          '-e',
          `require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{require('fs').appendFileSync('/repo/${file}',JSON.stringify({sig:q.headers['x-dirouter-signature'],body:b})+'\\n');s.writeHead(200);s.end('ok')})}).listen(4319,'0.0.0.0')`,
        ],
        { cwd: root, env, stdio: 'ignore' },
      );
      cleanups.push(async () => {
        sink.kill('SIGTERM');
        await exec(
          'docker',
          [...compose, 'exec', '-T', 'dev-deps', 'sh', '-c', "pkill -f 'listen(4319' || true"],
          { cwd: root, env },
        ).catch(() => undefined);
      });
      await sleep(1_500);
      const secret = `whsec-${randomUUID()}`;
      const channel = (
        await org(
          'POST',
          'alerts/channels',
          {
            name: `s2-hook-${randomUUID().slice(0, 6)}`,
            type: 'webhook',
            config: { url: 'http://dev-deps:4319/hook', secret },
          },
          201,
        )
      ).body;
      cleanups.push(() => org('DELETE', `alerts/channels/${channel.id}`, undefined, null));
      assert.ok(!JSON.stringify(channel).includes(secret), 'secret is not echoed on create');
      const listed = (await org('GET', 'alerts/channels')).body.find((c) => c.id === channel.id);
      assert.ok(
        !JSON.stringify(listed).includes(secret) && listed.hasSecret === true,
        JSON.stringify(listed),
      );
      // Renaming keeps the stored secret.
      await org('PATCH', `alerts/channels/${channel.id}`, {
        name: `${listed.name}-renamed`,
        config: { url: 'http://dev-deps:4319/hook', secret: '***' },
      });
      const test = (await org('POST', `alerts/channels/${channel.id}/test`, undefined, null)).body;
      assert.equal(test.ok, true, JSON.stringify(test));
      const lines = async () =>
        (await readFile(resolve(root, file), 'utf8').catch(() => ''))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      const first = (
        await waitFor('test delivery', async () =>
          (await lines()).length >= 1 ? lines() : undefined,
        )
      )[0];
      assert.equal(
        first.sig,
        `sha256=${createHmac('sha256', secret).update(first.body).digest('hex')}`,
        'signature made with the stored secret',
      );

      for (const invalid of [
        { name: 'x', type: 'error_rate' },
        { name: 'x', type: 'breaker_open', threshold: 1 },
      ]) {
        const refused = await org('POST', 'alerts/rules', invalid, null);
        assert.ok(
          [400, 422].includes(refused.response.status),
          `${invalid.type}: ${refused.text.slice(0, 200)}`,
        );
      }
      const rule = (
        await org(
          'POST',
          'alerts/rules',
          {
            name: `s2-latency-${randomUUID().slice(0, 6)}`,
            type: 'latency',
            threshold: 0,
            windowMinutes: 5,
            silenceMinutes: 60,
            channelId: channel.id,
          },
          201,
        )
      ).body;
      cleanups.push(() => org('DELETE', `alerts/rules/${rule.id}`, undefined, null));
      for (let i = 0; i < 5; i++)
        await chat(main.key, {
          model: 'mock/small',
          messages: [{ role: 'user', content: 'alert traffic' }],
        });
      const fired = await waitFor(
        'alert event',
        async () => {
          const events = (await org('GET', 'alerts/events?limit=50')).body;
          return (events.items ?? events).find((e) => e.ruleId === rule.id);
        },
        150_000,
      );
      const delivered = await waitFor(
        'alert webhook',
        async () => {
          const got = (await lines()).filter((l) => JSON.parse(l.body).type === 'alert');
          return got.length >= 1 ? got : undefined;
        },
        30_000,
      );
      assert.equal(
        delivered[0].sig,
        `sha256=${createHmac('sha256', secret).update(delivered[0].body).digest('hex')}`,
      );
      // Two more evaluation rounds inside the silence window: still exactly one event.
      await sleep(75_000);
      const events = (await org('GET', 'alerts/events?limit=50')).body;
      assert.equal(
        (events.items ?? events).filter((e) => e.ruleId === rule.id).length,
        1,
        'deduplicated inside the silence window',
      );
      assert.equal((await lines()).filter((l) => JSON.parse(l.body).type === 'alert').length, 1);
      await org('POST', `alerts/events/${fired.id}/ack`, undefined, null);
    },
  );

  await scenario('16.3 live view: a request appears in under 2 seconds', async () => {
    const delays = [];
    for (let i = 0; i < 5; i++) {
      const id = `e2e_live_${randomUUID()}`;
      const res = await chat(
        main.key,
        { model: 'mock/small', messages: [{ role: 'user', content: 'live' }] },
        { 'x-request-id': id },
      );
      assert.equal(res.response.status, 200);
      const done = Date.now();
      await waitFor(
        `request ${id} in the live view`,
        async () => {
          const body = (await org('GET', 'stats/live')).body;
          return JSON.stringify(body).includes(id);
        },
        10_000,
      );
      delays.push(Date.now() - done);
      await sleep(300);
    }
    console.log(`     live view delays (ms): ${delays.join(', ')}`);
    assert.ok(Math.max(...delays) < 2_000, `slowest ${Math.max(...delays)} ms`);
    t.liveDelays = delays;
  });

  await scenario('16.4 analytics: series, breakdowns and filters', async () => {
    const from = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const to = new Date().toISOString();
    const body = (
      await org(
        'GET',
        `stats/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      )
    ).body;
    const text = JSON.stringify(body);
    assert.ok(text.length > 200, text.slice(0, 300));
    assert.ok(/mock\/small|mdl_/.test(text), 'per-model breakdown present');
    const filtered = (
      await org(
        'GET',
        `stats/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&model=${encodeURIComponent('mock/claude')}`,
      )
    ).body;
    assert.ok(JSON.stringify(filtered).length <= text.length);
    assert.equal((await org('GET', 'stats/analytics', undefined, null, '')).response.status, 401);
  });

  await scenario('16.5 playground: the same prompt against several models', async () => {
    const result = (
      await org(
        'POST',
        'playground/compare',
        {
          apiKey: main.key,
          models: ['mock/small', 'mock/claude', 'no-such-model'],
          prompt: 'Say hello',
          maxTokens: 32,
        },
        null,
      )
    ).body;
    assert.equal(result.results.length, 3, JSON.stringify(result).slice(0, 400));
    const [small, claude, missing] = result.results;
    for (const ok of [small, claude]) {
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.ok(ok.text.length > 0 && ok.latencyMs >= 0 && ok.outputTokens > 0 && ok.provider);
    }
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    // The key is used, never stored or echoed.
    assert.ok(!JSON.stringify(result).includes(main.key));
    assert.notEqual(
      (
        await org(
          'POST',
          'playground/compare',
          { apiKey: 'dr-not-a-key', models: ['mock/small'], prompt: 'x' },
          null,
        )
      ).body.results?.[0]?.ok,
      true,
    );
  });

  await scenario(
    '17.1 versioned config: diff, YAML export/import, rollback applied in under 2 seconds',
    async () => {
      const versionsBefore = (await org('GET', 'config/versions')).body;
      const list = versionsBefore.items ?? versionsBefore;
      assert.ok(list.length >= 2);
      const base = Math.max(...list.map((v) => v.version));
      // A visible change: a new alias.
      const alias = (
        await published(() =>
          org(
            'POST',
            'aliases',
            { slug: `s2-alias-${randomUUID().slice(0, 6)}`, modelId: modelId('mock/small') },
            201,
          ),
        )
      ).body;
      cleanups.push(() => org('DELETE', `aliases/${alias.id}`, undefined, null));
      const withAlias = Math.max(
        ...(
          (await org('GET', 'config/versions')).body.items ??
          (await org('GET', 'config/versions')).body
        ).map((v) => v.version),
      );
      assert.ok(withAlias > base);
      assert.equal(
        (await chat(main.key, { model: alias.slug, messages: [{ role: 'user', content: 'x' }] }))
          .response.status,
        200,
      );
      const diff = (
        await org('GET', `config/versions/${withAlias}/diff?against=${base}`, undefined, null)
      ).body;
      assert.ok(JSON.stringify(diff).includes(alias.slug), JSON.stringify(diff).slice(0, 400));

      const exported = (await org('GET', 'config/export.yaml')).body;
      assert.ok(exported.yaml.includes(alias.slug));
      assert.ok(!/v1\.[A-Za-z0-9+/=_-]{20,}/.test(exported.yaml), 'no ciphertexts in the export');
      assert.ok(exported.yaml.includes('***'));
      const version = (await org('GET', `config/versions/${withAlias}`)).body;
      assert.ok(
        !JSON.stringify(version).match(/"secret":"v1\./),
        'no ciphertexts in a version read',
      );

      // Rollback to the version without the alias; the gateway must apply it within 2 seconds.
      const started = Date.now();
      const rolled = (
        await org('POST', `config/versions/${base}/rollback`, { reason: 'e2e rollback' })
      ).body;
      await waitFor(
        'gateway to apply the rollback',
        async () => (await request(`${gateway}/readyz`)).body.configVersion >= rolled.version,
        10_000,
      );
      const applied = Date.now() - started;
      console.log(`     rollback applied on the gateway after ${applied} ms`);
      assert.ok(applied < 2_000, `rollback took ${applied} ms`);
      assert.equal(
        (await chat(main.key, { model: alias.slug, messages: [{ role: 'user', content: 'x' }] }))
          .response.status,
        404,
      );
      t.rollbackMs = applied;

      // Re-importing the export (with placeholders) restores the alias and keeps every secret.
      const imported = (
        await published(() =>
          org('POST', 'config/import.yaml', { yaml: exported.yaml, reason: 'e2e import' }, null),
        )
      ).body;
      assert.ok(imported.version > rolled.version, JSON.stringify(imported));
      assert.equal(
        (await chat(main.key, { model: alias.slug, messages: [{ role: 'user', content: 'x' }] }))
          .response.status,
        200,
      );
      assert.equal(
        (await chat(main.key, { model: 'mock/small', messages: [{ role: 'user', content: 'x' }] }))
          .response.status,
        200,
        'credentials still decrypt',
      );
      // A document that touches another organization or smuggles a secret is refused.
      const foreign = exported.yaml.replace(
        /"organizationId": "org_dev"/,
        '"organizationId": "org_other"',
      );
      assert.notEqual(foreign, exported.yaml);
      assert.equal(
        (await org('POST', 'config/import.yaml', { yaml: foreign }, null)).response.status >= 400,
        true,
      );
      // Viewers read (their slice, masked) but cannot roll back.
      const reader = await newMember('VIEWER');
      assert.equal(
        (await org('GET', 'config/versions', undefined, null, reader.token)).response.status,
        200,
      );
      assert.equal(
        (await org('POST', `config/versions/${base}/rollback`, {}, null, reader.token)).response
          .status,
        403,
      );
    },
  );

  await scenario('14.2 SSO with OIDC against Keycloak (compose.sso.yaml)', async () => {
    const issuer = 'http://sso.localhost/realms/dirouter';
    const discovery = await fetch(`${issuer}/.well-known/openid-configuration`).catch(
      () => undefined,
    );
    assert.equal(
      discovery?.status,
      200,
      'start Keycloak first: docker compose -f compose.yaml -f compose.dev.yaml -f compose.sso.yaml up -d --wait',
    );
    const dashboard = (await sql('SELECT 1')) && 'https://app.localhost';
    const connectionBody = {
      name: `s2-keycloak-${randomUUID().slice(0, 6)}`,
      issuer,
      clientId: 'dirouter-dashboard',
      clientSecret: 'dirouter-dev-client-secret',
      defaultRole: 'VIEWER',
      allowedDomains: ['example.com'],
      groupRoleMap: { 'dirouter-admins': 'ADMIN', 'dirouter-members': 'MEMBER' },
    };
    // A connection must name its domains, and can never hand out ownership.
    assert.ok(
      (await org('POST', 'sso', { ...connectionBody, allowedDomains: [] }, null)).response.status >=
        400,
    );
    assert.ok(
      (await org('POST', 'sso', { ...connectionBody, groupRoleMap: { x: 'OWNER' } }, null)).response
        .status >= 400,
    );
    const connection = (await org('POST', 'sso', connectionBody, 201)).body;
    cleanups.push(() => org('DELETE', `sso/${connection.id}`, undefined, null));
    assert.ok(
      !JSON.stringify(connection).includes('dirouter-dev-client-secret'),
      'client secret is write-only',
    );

    // Minimal browser: follows the authorization-code flow and keeps cookies per host.
    const jar = new Map();
    const cookieHeader = (url) =>
      [...(jar.get(new URL(url).host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join('; ');
    const remember = (url, response) => {
      const host = new URL(url).host;
      const store = jar.get(host) ?? new Map();
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        store.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
      }
      jar.set(host, store);
    };
    const browse = async (url, options = {}) => {
      const response = await fetch(url, {
        redirect: 'manual',
        ...options,
        headers: { ...(options.headers ?? {}), cookie: cookieHeader(url) },
      });
      remember(url, response);
      return response;
    };
    const adminBase = (process.env.E2E_ADMIN_URL ?? 'http://admin.localhost') + '/api/v1';
    async function signIn(email, password) {
      jar.clear();
      const lookup = await browse(`${adminBase}/auth/sso/lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      assert.equal(lookup.status, 200);
      assert.equal((await lookup.json()).connectionId, connection.id);
      const start = await browse(`${adminBase}/auth/sso/${connection.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(start.status, 200);
      const { authorizationUrl, state } = await start.json();
      const authorize = new URL(authorizationUrl);
      assert.equal(authorize.searchParams.get('redirect_uri'), `${dashboard}/login`);
      assert.ok(authorize.searchParams.get('code_challenge'), 'PKCE');
      const page = await browse(authorizationUrl);
      const html = await page.text();
      const action = /<form[^>]+action="([^"]+)"/.exec(html)?.[1].replaceAll('&amp;', '&');
      assert.ok(action, `Keycloak login form (HTTP ${page.status})`);
      const submitted = await browse(action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: email, password, credentialId: '' }).toString(),
      });
      assert.equal(
        submitted.status,
        302,
        `Keycloak rejected the login: ${(await submitted.text()).slice(0, 200)}`,
      );
      const back = new URL(submitted.headers.get('location'));
      assert.equal(`${back.origin}${back.pathname}`, `${dashboard}/login`);
      assert.equal(back.searchParams.get('state'), state);
      return { code: back.searchParams.get('code'), state };
    }
    const callback = (params, withCookie = true) =>
      (withCookie ? browse : fetch)(
        `${adminBase}/auth/sso/callback?code=${encodeURIComponent(params.code)}&state=${encodeURIComponent(params.state)}`,
      );

    // A rerun finds the two test accounts from the previous run without a membership (cleanup
    // removes it, accounts are never hard-deleted). Such an account is refused by design, so it
    // is put back as a VIEWER first; the group mapping then raises the role.
    await sql(
      `INSERT INTO memberships (id, user_id, organization_id, role, created_at)
       SELECT 'mem_e2e_' || substr(md5(random()::text), 1, 12), u.id, 'org_dev', 'VIEWER', now()
       FROM users u
       WHERE u.email IN ('alice@example.com', 'bob@example.com')
         AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.organization_id = 'org_dev')`,
    );

    // Alice is in dirouter-admins: she becomes ADMIN in this organization.
    const alice = await signIn('alice@example.com', 'alice-dev-password');
    // The state is bound to the browser that started the flow: the same link opened elsewhere fails.
    assert.notEqual(
      (await callback(alice, false)).status,
      200,
      'callback without the state cookie',
    );
    const aliceLogin = await signIn('alice@example.com', 'alice-dev-password');
    const done = await callback(aliceLogin);
    const session = await done.json();
    assert.equal(done.status, 200, JSON.stringify(session));
    assert.ok(session.accessToken);
    const aliceMe = (await api('GET', 'auth/me', undefined, 200, session.accessToken)).body;
    assert.equal(aliceMe.email, 'alice@example.com');
    assert.deepEqual(
      aliceMe.organizations.map((o) => [o.id, o.role]),
      [['org_dev', 'ADMIN']],
    );
    cleanups.push(() => org('DELETE', `members/${aliceMe.id}`, undefined, null));
    // A code is single-use.
    assert.notEqual((await callback(aliceLogin)).status, 200);
    // The SSO session works in its organization.
    assert.equal(
      (await org('GET', 'models', undefined, null, session.accessToken)).response.status,
      200,
    );

    // Bob is in dirouter-members.
    const bobDone = await callback(await signIn('bob@example.com', 'bob-dev-password'));
    const bob = await bobDone.json();
    assert.equal(bobDone.status, 200, JSON.stringify(bob));
    const bobMe = (await api('GET', 'auth/me', undefined, 200, bob.accessToken)).body;
    assert.equal(bobMe.organizations[0].role, 'MEMBER');
    cleanups.push(() => org('DELETE', `members/${bobMe.id}`, undefined, null));

    // A domain the connection does not serve finds no connection.
    const stranger = await fetch(`${adminBase}/auth/sso/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mallory@other.test' }),
    });
    assert.equal(await stranger.json(), null, 'no connection is offered for another domain');
    const audit = (await org('GET', 'audit?limit=100&action=auth.sso_login', undefined, null)).body;
    assert.ok((audit.items ?? audit).length >= 2, 'SSO logins are audited');
    // Disabling the connection stops sign-in at once.
    await org('PATCH', `sso/${connection.id}`, { enabled: false });
    const disabled = await fetch(`${adminBase}/auth/sso/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });
    assert.equal(await disabled.json(), null, 'a disabled connection is not offered');
  });

  await scenario('14.5 MASTER_KEY rotation under load', async () => {
    const versions = (
      await sql("SELECT string_agg(DISTINCT 'v' || key_version, ',') FROM credentials")
    ).split(',');
    const result = { ok: 0, failed: 0, statuses: {} };
    let running = true;
    const load = (async () => {
      while (running) {
        const batch = await Promise.all(
          ['mock/small', 'mock/claude', 'dev'].map((model) =>
            chat(main.key, { model, messages: [{ role: 'user', content: 'rotation load' }] }).catch(
              () => ({ response: { status: 0 } }),
            ),
          ),
        );
        for (const res of batch) {
          if (res.response.status === 200) result.ok += 1;
          else {
            result.failed += 1;
            result.statuses[res.response.status] = (result.statuses[res.response.status] ?? 0) + 1;
          }
        }
      }
    })();
    await sleep(1_500);
    const before = await (async () => (await request(`${gateway}/readyz`)).body.configVersion)();
    const rotated = (await org('POST', 'security/rotate-key', undefined, null)).body;
    assert.ok(typeof rotated.keyVersion === 'number', JSON.stringify(rotated));
    if (rotated.rotated > 0)
      await waitFor(
        'gateway to load re-encrypted credentials',
        async () => (await request(`${gateway}/readyz`)).body.configVersion > before,
        15_000,
      );
    await sleep(3_000);
    running = false;
    await load;
    const after = (
      await sql("SELECT string_agg(DISTINCT 'v' || key_version, ',') FROM credentials")
    ).split(',');
    console.log(
      `     rotation: ${JSON.stringify(rotated)}; key versions in use ${versions.join('/')} -> ${after.join('/')}; load ok=${result.ok} failed=${result.failed} ${JSON.stringify(result.statuses)}`,
    );
    assert.ok(result.ok > 30, 'enough load during the rotation');
    assert.equal(
      result.failed,
      0,
      `requests failed during rotation: ${JSON.stringify(result.statuses)}`,
    );
    assert.deepEqual(after, [`v${rotated.keyVersion}`], 'every credential is on the current key');
    assert.equal(
      (await org('POST', 'security/rotate-key', undefined, null)).body.rotated,
      0,
      'second run has nothing left',
    );
    t.rotation = { ...rotated, ...result, from: versions, to: after };
  });
}
