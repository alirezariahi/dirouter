// اسکلت موقت؛ پیاده‌سازی NestJS در کارت ۳.۳.
import { createServer } from 'node:http';

import {
  DiRouterError,
  baseEnvSchema,
  createLogger,
  envPort,
  loadEnvOrExit,
} from '@dirouter/shared';

const env = loadEnvOrExit(baseEnvSchema.extend({ PORT: envPort(3000) }));
const logger = createLogger({ service: 'control-api', level: env.LOG_LEVEL });

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  const error = new DiRouterError('not_found');
  res
    .writeHead(error.status, { 'content-type': 'application/problem+json' })
    .end(JSON.stringify(error.toProblem()));
});

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'control-api listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
  });
}
