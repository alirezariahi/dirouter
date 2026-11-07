import { createLogger, loadEnvOrExit } from '@dirouter/shared';

import { createApp } from './bootstrap.js';
import { envSchema } from './env.js';

const env = loadEnvOrExit(envSchema);
const logger = createLogger({ service: 'control-api', level: env.LOG_LEVEL });

const app = await createApp(env, logger);
await app.listen({ port: env.PORT, host: '0.0.0.0' });
logger.info({ port: env.PORT }, 'control-api listening');
