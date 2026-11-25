/**
 * Fake account balance APIs (card 32.9) in the shapes of OpenRouter, DeepSeek, Moonshot and
 * SiliconFlow, under the base URLs DiRouter derives from a provider pointed at the mock
 * (`http://mock-provider:8090/v1`):
 *
 * - `GET /v1/credits` (OpenRouter), `GET /user/balance` (DeepSeek),
 *   `GET /v1/users/me/balance` (Moonshot), `GET /v1/user/info` (SiliconFlow).
 * - `PUT /__mock/balance` `{ "amount": 0.5 }` sets the balance every API reports (default 42.5);
 *   a key of the form `mock:auth` gets 401 as everywhere else.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function registerBalance(app: FastifyInstance): void {
  let amount = 42.5;

  const denied = (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization ?? '';
    if (!/^Bearer \S+/.test(auth) || /mock:[^ ]*auth/.test(auth)) {
      void reply.status(401).send({ error: { message: 'Invalid API key' } });
      return true;
    }
    return false;
  };

  app.get('/v1/credits', (req, reply) => {
    if (denied(req, reply)) return reply;
    return { data: { total_credits: amount + 10, total_usage: 10 } };
  });
  app.get('/user/balance', (req, reply) => {
    if (denied(req, reply)) return reply;
    return {
      is_available: amount > 0,
      balance_infos: [
        {
          currency: 'USD',
          total_balance: amount.toFixed(2),
          granted_balance: '0.00',
          topped_up_balance: amount.toFixed(2),
        },
      ],
    };
  });
  app.get('/v1/users/me/balance', (req, reply) => {
    if (denied(req, reply)) return reply;
    return {
      code: 0,
      status: true,
      data: { available_balance: amount, voucher_balance: 0, cash_balance: amount },
    };
  });
  app.get('/v1/user/info', (req, reply) => {
    if (denied(req, reply)) return reply;
    return {
      code: 20000,
      status: true,
      data: {
        id: 'mock',
        balance: String(amount),
        chargeBalance: '0',
        totalBalance: String(amount),
      },
    };
  });

  app.put<{ Body: { amount?: number } }>('/__mock/balance', (req) => {
    if (typeof req.body.amount === 'number') amount = req.body.amount;
    return { ok: true, amount };
  });
}
