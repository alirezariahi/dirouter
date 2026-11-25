-- drop_params per organization (card 31.4): drop a parameter the target model cannot take (the
-- default, as before) or answer the request with a 400 that names it.
ALTER TABLE "organizations" ADD COLUMN "drop_params" BOOLEAN NOT NULL DEFAULT true;
