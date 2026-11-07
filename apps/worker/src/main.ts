// اسکلت موقت؛ مصرف صف BullMQ، تجمیع و نگهداری در کارت ۶.۵.
import { baseEnvSchema, createLogger, loadEnvOrExit } from '@dirouter/shared';

const env = loadEnvOrExit(baseEnvSchema);
const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });

logger.info('worker started');
const heartbeat = setInterval(() => {
  logger.debug('worker heartbeat');
}, 30_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    clearInterval(heartbeat);
    process.exit(0);
  });
}
