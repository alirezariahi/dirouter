// Minimal SOCKS5 proxy for testing the gateway's outbound proxy in dev (card 4.10); CONNECT only
// and no authentication. Prints each connection's destination on stdout. Never used in production.
// Usage: node scripts/dev/socks5-proxy.mjs [port=1080]
import { connect, createServer } from 'node:net';

const port = Number(process.argv[2] ?? 1080);
createServer((client) => {
  client.on('error', () => undefined);
  client.once('data', () => {
    client.write(Buffer.from([5, 0]));
    client.once('data', (req) => {
      let host;
      let i;
      if (req[3] === 1) [host, i] = [[...req.subarray(4, 8)].join('.'), 8];
      else if (req[3] === 3) [host, i] = [req.subarray(5, 5 + req[4]).toString(), 5 + req[4]];
      else return client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
      const dport = req.readUInt16BE(i);
      process.stdout.write(`socks5 connect ${host}:${dport}\n`);
      const upstream = connect(dport, host, () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
    });
  });
}).listen(port, '127.0.0.1', () => process.stdout.write(`socks5 listening on 127.0.0.1:${port}\n`));
