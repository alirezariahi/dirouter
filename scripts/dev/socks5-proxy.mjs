// پروکسی SOCKS5 حداقلی برای آزمودن پروکسی خروجی گیت‌وی در dev (کارت ۴.۱۰)؛ فقط CONNECT
// و بدون احراز هویت. هر اتصال را با مقصدش روی stdout چاپ می‌کند. هرگز در production نیست.
// استفاده: node scripts/dev/socks5-proxy.mjs [پورت=1080]
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
