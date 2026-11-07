# راهنمای مشارکت

## محیط توسعه

```bash
corepack enable
pnpm install   # hookهای git را هم با husky نصب می‌کند
```

## کیفیت کد

| ابزار                            | پیکربندی                 | دستور                               |
| -------------------------------- | ------------------------ | ----------------------------------- |
| TypeScript (strict)              | `packages/tsconfig`      | `pnpm typecheck`                    |
| ESLint (flat config، type-aware) | `packages/eslint-config` | `pnpm lint`                         |
| Prettier                         | `.prettierrc.json`       | `pnpm format` / `pnpm format:check` |
| EditorConfig                     | `.editorconfig`          | تنظیم خودکار ویرایشگر               |

- هر اپ و پکیج یک `eslint.config.js` دارد که پیکربندی `node` یا `react` را از `@dirouter/eslint-config` می‌گیرد.
- `console.*` ممنوع است؛ از `createLogger` در `@dirouter/shared` استفاده کنید.
- type import صریح (`import { type X }`) اجباری است (`verbatimModuleSyntax`).

### hookهای git

- **pre-commit:** `lint-staged` فایل‌های stage‌شده را با Prettier قالب‌بندی و با ESLint اصلاح می‌کند.
- **commit-msg:** `commitlint` پیام کامیت را بررسی می‌کند و پیام نامعتبر را رد می‌کند.

## پیام کامیت (Conventional Commits)

```
<type>(<scope>): <subject>

[body]

[footer]
```

**type:** `feat`، `fix`، `docs`، `style`، `refactor`، `perf`، `test`، `build`، `ci`، `chore`، `revert`

**scope** (اختیاری، اما اگر باشد باید یکی از این‌ها باشد):
`gateway`، `control-api`، `worker`، `dashboard`، `mock-provider`، `contracts`، `shared`، `db`، `model-catalog`، `ui`، `tsconfig`، `eslint-config`، `deploy`، `docs`، `ci`، `deps`، `repo`

نمونه‌ها:

```
feat(gateway): add circuit breaker per provider
fix(shared): redact x-api-key header in logs
docs(gateway): document timeout settings
```

تغییر ناسازگار با `!` بعد از type/scope یا `BREAKING CHANGE:` در footer مشخص می‌شود.

شمارهٔ کارت دی‌تسک را در footer بیاورید: `Refs: DR-12`.

## شاخه‌ها و بازبینی

- شاخهٔ اصلی `main` است؛ کار روی شاخهٔ جدا با نام `<type>/<card>-<short-name>` (مثلاً `feat/4.1-gateway-skeleton`).
- هر تغییر از طریق Pull Request و بعد از سبز شدن CI و بازبینی ادغام می‌شود.

## قراردادهای کد

- ماژول‌ها ESM هستند (`"type": "module"`) و importهای نسبی پسوند `.js` دارند.
- اسکیماها و تایپ‌های مشترک فقط در `@dirouter/contracts` تعریف می‌شوند.
- کدهای خطا پایدارند: افزودن مجاز است، حذف یا تغییر معنی ممنوع (`ERROR_CODES` در contracts).
- مبالغ پولی به میکرودلار و عدد صحیح ذخیره می‌شوند (نه float).
- مستندات فارسی و اصطلاحات فنی انگلیسی هستند.
