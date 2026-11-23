-- AlterTable
ALTER TABLE "sso_connections" ADD COLUMN     "protocol" TEXT NOT NULL DEFAULT 'oidc',
ADD COLUMN     "saml_cert" TEXT,
ADD COLUMN     "saml_sso_url" TEXT;


-- CreateTable
CREATE TABLE "scim_tokens" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_users" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_name" TEXT NOT NULL,
    "external_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scim_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_groups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_group_members" (
    "group_id" TEXT NOT NULL,
    "scim_user_id" TEXT NOT NULL,

    CONSTRAINT "scim_group_members_pkey" PRIMARY KEY ("group_id","scim_user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scim_tokens_token_hash_key" ON "scim_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "scim_tokens_organization_id_idx" ON "scim_tokens"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_users_organization_id_user_id_key" ON "scim_users"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_users_organization_id_user_name_key" ON "scim_users"("organization_id", "user_name");

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_organization_id_display_name_key" ON "scim_groups"("organization_id", "display_name");

-- CreateIndex
CREATE INDEX "scim_group_members_scim_user_id_idx" ON "scim_group_members"("scim_user_id");

-- AddForeignKey
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "scim_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_scim_user_id_fkey" FOREIGN KEY ("scim_user_id") REFERENCES "scim_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

