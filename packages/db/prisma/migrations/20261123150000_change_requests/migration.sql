-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('pending', 'applied', 'failed', 'rejected', 'cancelled', 'expired');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "change_approval_required" BOOLEAN NOT NULL DEFAULT false;


-- CreateTable
CREATE TABLE "change_requests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target_id" TEXT,
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'pending',
    "requested_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "reason" TEXT,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "change_requests_organization_id_status_created_at_idx" ON "change_requests"("organization_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

