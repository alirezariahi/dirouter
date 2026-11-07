import { baseEnvSchema, createLogger, envPort, loadEnvOrExit } from '@dirouter/shared';
import { z } from 'zod';

import { buildServer } from './server.js';

const env = loadEnvOrExit(
  baseEnvSchema.extend({ PORT: envPort(8090), MOCK_DEFAULT: z.string().optional() }),
);
const logger = createLogger({ service: 'mock-provider', level: env.LOG_LEVEL });

const app = buildServer({ defaultDirectives: env.MOCK_DEFAULT });
await app.listen({ port: env.PORT, host: '0.0.0.0' });
logger.info({ port: env.PORT }, 'mock-provider listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
