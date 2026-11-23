import { baseEnvSchema, createLogger, envPort, loadEnvOrExit } from '@dirouter/shared';
import { z } from 'zod';

import { buildServer } from './server.js';

const env = loadEnvOrExit(
  baseEnvSchema.extend({
    PORT: envPort(8090),
    MOCK_DEFAULT: z.string().optional(),
    /** Fake payment providers (card 19.2). */
    MOCK_PUBLIC_URL: z.string().optional(),
    MOCK_STRIPE_WEBHOOK_URL: z.string().optional(),
    MOCK_STRIPE_WEBHOOK_SECRET: z.string().optional(),
  }),
);
const logger = createLogger({ service: 'mock-provider', level: env.LOG_LEVEL });

const app = buildServer({
  ...(env.MOCK_DEFAULT ? { defaultDirectives: env.MOCK_DEFAULT } : {}),
  payments: {
    publicUrl: env.MOCK_PUBLIC_URL,
    stripeWebhookUrl: env.MOCK_STRIPE_WEBHOOK_URL,
    stripeWebhookSecret: env.MOCK_STRIPE_WEBHOOK_SECRET,
  },
});
await app.listen({ port: env.PORT, host: '0.0.0.0' });
logger.info({ port: env.PORT }, 'mock-provider listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
