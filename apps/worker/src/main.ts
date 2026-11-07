// اسکلت موقت؛ مصرف صف BullMQ، تجمیع و نگهداری در کارت ۶.۵.
import { createServer } from 'node:http';

import { baseEnvSchema, createLogger, envPort, loadEnvOrExit } from '@dirouter/shared';

const env = loadEnvOrExit(baseEnvSchema.extend({ PORT: envPort(3100) }));
const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });

// سرور کوچک برای health check کانتینر (و بعداً /metrics).
const health = createServer((req, res) => {
  const ok = req.url === '/healthz';
  res
    .writeHead(ok ? 200 : 404, { 'content-type': 'application/json' })
    .end(ok ? '{"status":"ok"}' : '{}');
});
health.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'worker started');
});

const heartbeat = setInterval(() => {
  logger.debug('worker heartbeat');
}, 30_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    clearInterval(heartbeat);
    health.close(() => process.exit(0));
  });
}
