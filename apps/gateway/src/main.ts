import { baseEnvSchema, createLogger, envKeyring, envPort, loadEnvOrExit } from '@dirouter/shared';
import { z } from 'zod';

import { buildGateway } from './server.js';

const env = loadEnvOrExit(
  baseEnvSchema.extend({
    PORT: envPort(8787),
    MASTER_KEY: envKeyring(),
    KEY_PEPPER: z.string().min(32),
    INTERNAL_TOKEN: z.string().min(32).optional(),
    CONTROL_API_URL: z.string().optional(),
    DATA_DIR: z.string().default('./.data'),
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(30_000),
  }),
);
const logger = createLogger({ service: 'gateway', level: env.LOG_LEVEL });

const gateway = buildGateway({
  logger,
  keyring: env.MASTER_KEY,
  pepper: env.KEY_PEPPER,
  dataDir: env.DATA_DIR,
  ...(env.CONTROL_API_URL ? { controlApiUrl: env.CONTROL_API_URL } : {}),
  ...(env.INTERNAL_TOKEN ? { internalToken: env.INTERNAL_TOKEN } : {}),
});
await gateway.start();
await gateway.app.listen({ port: env.PORT, host: '0.0.0.0' });
logger.info(
  { port: env.PORT, configVersion: gateway.store.current?.version ?? 0 },
  'gateway listening',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'draining');
    void gateway.drain(env.SHUTDOWN_DRAIN_MS).then(() => process.exit(0));
  });
}
