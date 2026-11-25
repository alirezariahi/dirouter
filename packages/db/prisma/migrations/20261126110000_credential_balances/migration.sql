-- Upstream account balances (card 32.9): the latest lookup per credential, written by the worker
-- from the gateway's samples and by the control-api's refresh. `amount` is in `currency`.
CREATE TABLE "credential_balances" (
    "credential_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "amount" DECIMAL(20,8),
    "currency" TEXT,
    "error" TEXT,
    "checked_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credential_balances_pkey" PRIMARY KEY ("credential_id")
);

CREATE INDEX "credential_balances_provider_id_idx" ON "credential_balances"("provider_id");

ALTER TABLE "credential_balances" ADD CONSTRAINT "credential_balances_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
