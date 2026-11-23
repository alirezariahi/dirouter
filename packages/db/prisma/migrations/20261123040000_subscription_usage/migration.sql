-- Sprint 3, card 19.4: plan allowance consumed per request.
-- CreateTable
CREATE TABLE "subscription_usage" (
    "request_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "amount_usd" DECIMAL(18,8) NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_usage_pkey" PRIMARY KEY ("request_id")
);

-- CreateIndex
CREATE INDEX "subscription_usage_subscription_id_period_start_idx" ON "subscription_usage"("subscription_id", "period_start");

-- AddForeignKey
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


