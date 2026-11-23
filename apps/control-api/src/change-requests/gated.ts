import type { FastifyReply } from 'fastify';

import type { Gate } from './change-requests.service.js';

/**
 * Sends a gated endpoint's response: 202 with the pending change request when the change waits
 * for approval, otherwise the result of running it now (sent explicitly, since Nest would
 * otherwise replace a 202 with the route's default status).
 */
export async function sendGated(
  reply: FastifyReply,
  gate: Gate,
  run: () => Promise<unknown>,
  status = 200,
): Promise<FastifyReply> {
  if (gate.changeRequest) return reply.status(202).send({ changeRequest: gate.changeRequest });
  const result = await run();
  return status === 204 ? reply.status(204).send() : reply.status(status).send(result);
}
