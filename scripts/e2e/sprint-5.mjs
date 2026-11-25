/* eslint-disable no-console */
/**
 * Sprint 5 end-to-end checks against the development stack (make up && make seed). Each card has
 * its own module in scripts/e2e/sprint-5/<key>.mjs that exports `register(ctx)` and declares its
 * scenarios with `ctx.scenario(name, fn)`; scenario names start with the card key.
 *
 *   node scripts/e2e/sprint-5.mjs          # everything
 *   node scripts/e2e/sprint-5.mjs 30.1     # only scenarios whose name contains one of these
 */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  adminClient,
  createRunner,
  login,
  published,
  readEnv,
  root,
  urls,
  waitFor,
} from './harness.mjs';

const ORG = 'org_dev';
const { scenario, cleanups, finish } = createRunner();

let crashed = false;
try {
  const seedAdmin = await readEnv('.data/seed-admin.env');
  const api = adminClient(await login(seedAdmin.SEED_ADMIN_EMAIL, seedAdmin.SEED_ADMIN_PASSWORD));
  const org = (method, path, body, expected) => api(method, `orgs/${ORG}/${path}`, body, expected);

  /** A virtual key in the dev project, known to the gateway when returned; revoked at the end. */
  async function createKey(name, extra = {}) {
    const { body } = await published(() =>
      org(
        'POST',
        'keys',
        { name: `s5-${name}-${randomUUID().slice(0, 6)}`, projectId: 'prj_dev', ...extra },
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

  const ctx = { scenario, cleanups, api, org, ORG, createKey };
  const dir = join(root, 'scripts/e2e/sprint-5');
  const modules = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const file of modules) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    await mod.register(ctx);
  }
} catch (error) {
  crashed = true;
  console.error(error);
} finally {
  await finish(crashed);
}
