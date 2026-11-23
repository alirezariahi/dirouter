#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * stdio MCP server → Streamable HTTP (card 20.1). The DiRouter gateway reaches MCP servers over
 * HTTP; a server that only speaks stdio (most `npx …` servers) runs behind this sidecar:
 *
 *   node scripts/mcp/stdio-bridge.mjs --port 8765 -- npx -y @modelcontextprotocol/server-filesystem /data
 *
 * and is registered in DiRouter as `streamable-http` with URL `http://<sidecar>:8765/mcp`.
 *
 * The child is started once and initialized once; every client `initialize` gets that answer, so
 * many gateway replicas can share one child. Request ids are rewritten so concurrent callers never
 * collide. No dependencies; Node 22.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

export function startBridge({ command, args, port = 8765, host = '0.0.0.0', timeoutMs = 60_000 }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1;
  let initialized;

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not a protocol line (some servers log to stdout)
    }
    if (
      message.id === undefined ||
      message.id === null ||
      !('result' in message || 'error' in message)
    )
      return; // server-to-client requests and notifications are not supported over this bridge
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `b${String(nextId++)}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const ensureInitialized = (params) => {
    initialized ??= call('initialize', params).then((answer) => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      return answer;
    });
    return initialized;
  };

  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.url === '/healthz')
      return send(200, { status: child.exitCode === null ? 'ok' : 'down' });
    if (req.url !== '/mcp') return send(404, { error: 'not found' });
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return send(400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
      if (message.id === undefined || message.id === null) return send(202);
      try {
        const answer =
          message.method === 'initialize'
            ? await ensureInitialized(message.params)
            : (await ensureInitialized({
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'dirouter-stdio-bridge', version: '1.0.0' },
              }),
              await call(message.method, message.params));
        send(200, { ...answer, id: message.id });
      } catch (error) {
        send(200, {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: String(error.message) },
        });
      }
    });
  });
  server.listen(port, host);
  const close = () =>
    new Promise((resolve) => {
      child.kill();
      server.close(() => resolve());
    });
  return { server, child, close };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const split = argv.indexOf('--');
  const options = split >= 0 ? argv.slice(0, split) : [];
  const [command, ...args] = split >= 0 ? argv.slice(split + 1) : argv;
  if (!command) {
    console.error('usage: stdio-bridge.mjs [--port 8765] -- <command> [args...]');
    process.exit(2);
  }
  const portFlag = options.indexOf('--port');
  const port = Number(portFlag >= 0 ? options[portFlag + 1] : (process.env.PORT ?? 8765));
  const bridge = startBridge({ command, args, port });
  bridge.child.on('exit', (code) => {
    console.error(`MCP server exited (${String(code)})`);
    process.exit(1);
  });
  console.error(`stdio MCP bridge on :${String(port)}/mcp → ${command}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => void bridge.close().then(() => process.exit(0)));
}
