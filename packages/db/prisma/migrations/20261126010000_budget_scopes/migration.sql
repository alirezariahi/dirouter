-- Sprint 5, card 33.1: organization, member, model and provider scopes for limits and budgets,
-- and weekly and yearly budget periods.
ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'organization';
ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'user';
ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'model';
ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'provider';

ALTER TYPE "BudgetPeriod" ADD VALUE IF NOT EXISTS 'weekly' BEFORE 'monthly';
ALTER TYPE "BudgetPeriod" ADD VALUE IF NOT EXISTS 'yearly';

-- Scope ids are only unique inside an organization from now on (a tag or an end user named the
-- same way in two organizations must never share a budget), so the organization joins the keys.
DROP INDEX IF EXISTS "budgets_scope_scope_id_period_key";
CREATE UNIQUE INDEX "budgets_organization_id_scope_scope_id_period_key"
  ON "budgets"("organization_id", "scope", "scope_id", "period");
DROP INDEX IF EXISTS "rate_limit_policies_scope_scope_id_key";
CREATE UNIQUE INDEX "rate_limit_policies_organization_id_scope_scope_id_key"
  ON "rate_limit_policies"("organization_id", "scope", "scope_id");

-- The model and provider that served each request, so the worker can reconcile model and provider
-- budgets with the ledger. Older rows keep NULL; they predate these budgets.
ALTER TABLE "usage_ledger" ADD COLUMN "model_id" TEXT, ADD COLUMN "provider_id" TEXT;
