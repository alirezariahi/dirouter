/** The stdio bridge (card 20.1) against a tiny stdio MCP server. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { startBridge } from './stdio-bridge.mjs';

// A stdio MCP server in a few lines: initialize, tools/list and one tool.
const server = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let inits = 0;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') { inits++; return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tiny', version: '1' } }); }
  if (m.method === 'tools/list') return reply({ tools: [{ name: 'shout', inputSchema: { type: 'object' } }] });
  if (m.method === 'tools/call') return reply({ content: [{ type: 'text', text: String(m.params.arguments.text).toUpperCase() + ' x' + inits }] });
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } }) + '\\n');
});`;

const bridge = startBridge({
  command: process.execPath,
  args: ['-e', server],
  port: 0,
  host: '127.0.0.1',
});
after(() => bridge.close());

async function rpc(body) {
  await new Promise((resolve) =>
    bridge.server.listening ? resolve() : bridge.server.once('listening', resolve),
  );
  const { port } = bridge.server.address();
  const res = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 202 ? undefined : await res.json() };
}

test('initialize is answered once for everyone; calls keep their ids', async () => {
  const init = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {} },
  };
  const [a, b] = await Promise.all([rpc({ ...init, id: 1 }), rpc({ ...init, id: 'x' })]);
  assert.equal(a.body.id, 1);
  assert.equal(b.body.id, 'x');
  assert.equal(a.body.result.serverInfo.name, 'tiny');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const calls = await Promise.all(
    ['a', 'b', 'c'].map((text, i) =>
      rpc({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'shout', arguments: { text: `${text}${String(i)}` } },
      }),
    ),
  );
  // The child was initialized exactly once, and every answer went to its own caller.
  assert.deepEqual(
    calls.map((c) => [c.body.id, c.body.result.content[0].text]),
    [
      [7, 'A0 x1'],
      [7, 'B1 x1'],
      [7, 'C2 x1'],
    ],
  );
  assert.equal((await rpc({ jsonrpc: '2.0', id: 9, method: 'bogus' })).body.error.code, -32601);
});
