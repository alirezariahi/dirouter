# DiRouter

گیت‌وی هوشمند و تاب‌آور LLM: یک endpoint سازگار با OpenAI و Anthropic که درخواست‌ها را با فال‌بک، circuit breaker، rate limit، بودجه و حسابداری به چند provider می‌رساند.

> وضعیت: در حال ساخت (اسپرینت ۱).

## پیش‌نیازها

- Node.js 22 LTS (نسخه در `.nvmrc`)
- pnpm 10 (`corepack enable` نسخهٔ درست را از `packageManager` برمی‌دارد)

## شروع سریع

```bash
pnpm install
pnpm build
pnpm dev
```

`pnpm dev` همهٔ اپ‌ها را هم‌زمان بالا می‌آورد:

| اپ            | آدرس                          |
| ------------- | ----------------------------- |
| gateway       | http://localhost:8080/healthz |
| control-api   | http://localhost:3000/healthz |
| mock-provider | http://localhost:8090/healthz |
| dashboard     | http://localhost:5173         |
| worker        | (بدون پورت؛ فقط لاگ)          |

## دستورها

| دستور            | کار                                          |
| ---------------- | -------------------------------------------- |
| `pnpm build`     | build همهٔ اپ‌ها و پکیج‌ها (با کش Turborepo) |
| `pnpm dev`       | اجرای هم‌زمان همهٔ اپ‌ها در حالت watch       |
| `pnpm test`      | تست‌های واحد (Vitest)                        |
| `pnpm lint`      | ESLint روی کل مخزن                           |
| `pnpm typecheck` | بررسی نوع TypeScript روی کل مخزن             |
| `pnpm format`    | قالب‌بندی با Prettier                        |

برای اجرای دستور فقط روی یک بخش: `pnpm --filter @dirouter/gateway dev`

## ساختار پوشه‌ها

```
dirouter/
├─ apps/
│  ├─ gateway/        data plane: مسیر داغ درخواست‌های LLM (NestJS + Fastify)
│  ├─ control-api/    control plane: API مدیریتی، احراز هویت، انتشار config (NestJS)
│  ├─ worker/         مصرف صف رویداد مصرف، تجمیع و نگهداری (BullMQ)
│  ├─ dashboard/      داشبورد مدیریتی فارسی و RTL (React + Vite)
│  └─ mock-provider/  provider ساختگی با تزریق خطا برای تست
└─ packages/
   ├─ contracts/      اسکیماها و تایپ‌های مشترک (zod) + خروجی JSON Schema
   ├─ shared/         لاگر، کلاس‌های خطا، اعتبارسنجی env، رمزنگاری، ULID، HMAC
   ├─ db/             شِمای Prisma و کلاینت دیتابیس
   ├─ model-catalog/  کاتالوگ نسخه‌دار قیمت و قابلیت مدل‌ها
   ├─ ui/             کامپوننت‌های مشترک React
   ├─ tsconfig/       tsconfigهای پایه (base، node-library، node-app، react-app)
   └─ eslint-config/  پیکربندی مشترک ESLint (flat config)
```

قرارداد وابستگی: اپ‌ها می‌توانند به پکیج‌ها وابسته باشند، اما هیچ پکیجی به اپ وابسته نیست. `contracts` به هیچ پکیج داخلی دیگری وابسته نیست.

## مشارکت

قراردادهای کد، کامیت و بازبینی در [CONTRIBUTING.md](CONTRIBUTING.md) آمده است.
