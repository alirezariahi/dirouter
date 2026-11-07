// اسکلت موقت؛ provider ساختگی با تزریق خطا در کارت ۹.۱.
import { createServer } from 'node:http';

import {
  DiRouterError,
  baseEnvSchema,
  createLogger,
  envPort,
  loadEnvOrExit,
} from '@dirouter/shared';

const env = loadEnvOrExit(baseEnvSchema.extend({ PORT: envPort(8090) }));
const logger = createLogger({ service: 'mock-provider', level: env.LOG_LEVEL });

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  const error = new DiRouterError('not_found');
  res
    .writeHead(error.status, { 'content-type': 'application/json' })
    .end(JSON.stringify(error.toOpenAI()));
});

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'mock-provider listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
  });
}
