/**
 * Card 31.2: a Codex-shaped Responses request (its free-form apply_patch tool) to a Claude and a
 * Gemini model through Traefik. The mock models answer with an apply_patch call; the returned
 * patch is applied to a file the way Codex does it, and the next turn replays call and output.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { published, request, urls, waitFor } from '../harness.mjs';

const PATCH = [
  '*** Begin Patch',
  '*** Update File: app.ts',
  '@@',
  "-const greeting = 'hi';",
  "+const greeting = 'hello';",
  '*** End Patch',
].join('\n');
const DIRECTIVES = `mock:tool=apply_patch,tool_input_b64=${Buffer.from(JSON.stringify({ input: PATCH })).toString('base64url')}`;

export async function register({ scenario, cleanups, org, createKey }) {
  const tag = randomUUID().slice(0, 6);
  const models = [];
  let key;
  const setup = async () => {
    if (key) return;
    for (const [type, upstream] of [
      ['anthropic', 'claude-sonnet-4-5'],
      ['gemini', 'gemini-2.5-pro'],
    ]) {
      const provider = (
        await published(() =>
          org(
            'POST',
            'providers',
            {
              name: `s5-312-${type}-${tag}`,
              slug: `s5-312-${type}-${tag}`,
              type,
              baseUrl: 'http://mock-provider:8090',
              credentials: [{ name: 'k', secret: DIRECTIVES }],
            },
            201,
          ),
        )
      ).body;
      cleanups.push(() => org('DELETE', `providers/${provider.id}`, undefined, null));
      const model = (
        await published(() =>
          org(
            'POST',
            'models',
            {
              providerId: provider.id,
              upstreamModel: upstream,
              slug: `s5-312/${type}-${tag}`,
              pricing: { inputPerMTok: '1', outputPerMTok: '1' },
              capabilities: { tools: true },
            },
            201,
          ),
        )
      ).body;
      models.push(model.slug);
    }
    key = (await createKey('312')).key;
    await waitFor('gateway to know the 31.2 models', async () => {
      const res = await fetch(`${urls.gateway}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
      });
      const ids = ((await res.json()).data ?? []).map((m) => m.id);
      return models.every((slug) => ids.includes(slug));
    });
  };

  const responses = (body) =>
    request(
      `${urls.gateway}/v1/responses`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      },
      200,
    );
  const codex = (model, input) => ({
    model,
    instructions: 'You are Codex.',
    input,
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Use the `apply_patch` tool to edit files.',
        format: {
          type: 'grammar',
          syntax: 'lark',
          definition: 'start: begin_patch hunk+ end_patch',
        },
      },
    ],
  });
  const ask = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello' }] },
  ];

  await scenario(
    '31.2 Codex apply_patch through DiRouter with a Claude and a Gemini model edits a file',
    async () => {
      await setup();
      for (const model of models) {
        const { body } = await responses(codex(model, ask));
        const call = body.output.find((item) => item.type === 'custom_tool_call');
        assert.ok(call, `${model} answered with a custom_tool_call`);
        assert.equal(call.name, 'apply_patch');
        assert.equal(call.input, PATCH);

        // Apply the update hunk as Codex would.
        const dir = await mkdtemp(join(tmpdir(), 's5-312-'));
        const file = join(dir, 'app.ts');
        await writeFile(file, "const greeting = 'hi';\n");
        const lines = call.input.split('\n');
        const removed = lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
        const added = lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
        await writeFile(
          file,
          (await readFile(file, 'utf8')).replace(removed.join('\n'), added.join('\n')),
        );
        assert.equal(await readFile(file, 'utf8'), "const greeting = 'hello';\n");

        // The next turn replays the call and its output; the provider accepts the history.
        await responses(
          codex(model, [
            ...ask,
            call,
            { type: 'custom_tool_call_output', call_id: call.call_id, output: 'Success. M app.ts' },
          ]),
        );
      }
    },
  );
}
