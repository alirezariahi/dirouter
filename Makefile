# دستورهای عملیاتی DiRouter. فهرست: make help
SHELL := /bin/sh
.DEFAULT_GOAL := help

DEV  := docker compose -f compose.yaml -f compose.dev.yaml
PROD := docker compose -f compose.yaml -f compose.prod.yaml
# متغیرهای .env برای دستورهای میزبان (prisma، اسکریپت‌ها)
ENV  := set -a && . ./.env && set +a &&

.PHONY: help bootstrap up down restart logs ps migrate seed dev-snapshot test e2e lint build push \
        prod-up prod-down prod-logs scale clean

help: ## نمایش همین فهرست
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

bootstrap: ## ساخت .env با رازهای تصادفی (DOMAIN=example.com make bootstrap)
	./scripts/bootstrap.sh $(if $(DOMAIN),--domain $(DOMAIN)) $(if $(PROD_ENV),--prod)

up: .env ## بالا آوردن محیط توسعه با hot-reload (Traefik روی *.localhost)
	$(DEV) up -d --wait

down: ## توقف محیط توسعه (داده‌ها حفظ می‌شوند)
	$(DEV) down

restart: ## راه‌اندازی دوبارهٔ اپ‌ها در dev
	$(DEV) restart control-api gateway worker dashboard mock-provider

logs: ## لاگ زندهٔ همهٔ سرویس‌ها (s=gateway برای یک سرویس)
	$(DEV) logs -f --tail=100 $(s)

ps: ## وضعیت سرویس‌ها
	$(DEV) ps

migrate: .env ## اجرای migrationهای دیتابیس (prisma migrate deploy)
	$(ENV) pnpm --filter @dirouter/db exec prisma migrate deploy

seed: .env ## داده‌های نمونهٔ توسعه و چاپ کلید dev (فقط dev)
	@case "$$(grep -E '^NODE_ENV=' .env | cut -d= -f2)" in production) echo "seed در production اجرا نمی‌شود / refusing to seed production" >&2; exit 1;; esac
	@# داده در DB؛ control-api snapshot را می‌سازد و گیت‌وی بی‌درنگ می‌گیرد (کارت ۳.۱۱).
	$(DEV) exec -T control-api pnpm --silent --filter @dirouter/control-api seed

dev-snapshot: .env ## snapshot آزمایشی روی دیسک گیت‌وی بدون control-api (اجرای جدای گیت‌وی)
	pnpm --filter @dirouter/shared build >/dev/null
	$(ENV) node scripts/dev-snapshot.mjs .data/gateway/snapshot.json http://mock-provider:8090/v1
	@# سازمان snapshot در DB هم لازم است (FK در usage_ledger)؛ تا seed کامل (کارت ۳.۱۱).
	-$(DEV) exec -T postgres sh -c 'psql -q -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -c "INSERT INTO organizations (id, name, slug, updated_at) VALUES ('"'"'org_dev'"'"', '"'"'Dev'"'"', '"'"'dev'"'"', now()) ON CONFLICT DO NOTHING"' >/dev/null
	-$(DEV) restart gateway >/dev/null 2>&1

test: ## تست‌های واحد و یکپارچه
	pnpm test

e2e: ## تست end-to-end (کارت ۹.۳)
	node scripts/e2e/sprint-1.mjs

lint: ## lint، typecheck و بررسی قالب‌بندی
	pnpm lint && pnpm typecheck && pnpm format:check

build: ## build ایمیج‌های production (همهٔ اپ‌ها)
	$(PROD) --profile mock build

push: ## push ایمیج‌ها به رجیستری (REGISTRY و TAG از .env)
	$(PROD) --profile mock push

prod-up: .env ## استقرار production (TLS، replicaهای gateway)
	$(PROD) up -d --wait

prod-down: ## توقف production
	$(PROD) down

prod-logs: ## لاگ production
	$(PROD) logs -f --tail=100 $(s)

scale: ## تغییر تعداد replica گیت‌وی: make scale n=3
	$(PROD) up -d --no-recreate --scale gateway=$(n)

clean: ## حذف کانتینرها و volumeهای dev (پاک شدن داده!)
	$(DEV) down -v

.env:
	@echo ".env وجود ندارد؛ اول make bootstrap را اجرا کنید / run make bootstrap first" >&2; exit 1
