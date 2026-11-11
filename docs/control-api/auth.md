[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Dashboard authentication and setup wizard

Code: `apps/control-api/src/auth` · tests: `auth.unit.test.ts` and `auth.integration.test.ts` · card 3.4

## Endpoints (`/api/v1/auth`)

| route            | description                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /setup`     | `{"required": true}` as long as there are no users                                                                                                                                         |
| `POST /setup`    | `{organizationName, name, email, password}`: creates the organization, the user and the OWNER membership, and signs in. After the first user, it always returns **409 `setup_completed`**. |
| `POST /login`    | `{email, password}`: the response is an access token, and the refresh token is set in a cookie                                                                                             |
| `POST /refresh`  | with the cookie: rotates the token and returns a fresh access token                                                                                                                        |
| `POST /logout`   | revokes the session family and clears the cookie (204)                                                                                                                                     |
| `POST /password` | with Bearer: `{currentPassword, newPassword}`; all of the user's refresh tokens are revoked (204)                                                                                          |
| `GET /me`        | with Bearer: the user and their organizations with roles                                                                                                                                   |

All of these are in Swagger (`/api/docs`) with the full schema from zod. Errors are returned in `application/problem+json` format with stable codes.

## Password

- **argon2id** (`@node-rs/argon2`, a prebuilt binary for linux-musl/arm64/x64) with OWASP parameters: m=19MiB, t=2 and p=1.
- The password is at least 10 and at most 256 characters. The maximum prevents DoS against argon2.
- Email is stored and compared in lowercase.
- For a non-existent email, a verify is also run against a fixed hash, and the response is the same `invalid_credentials`. So neither the response time nor the message reveals whether an account exists.

## Tokens

|          | access token                                                                      | refresh token                                                                     |
| -------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| format   | JWT HS256 (`jose`) with `JWT_SECRET`, iss `dirouter` and aud `dirouter-dashboard` | 32 random bytes (base64url)                                                       |
| lifetime | 15 minutes                                                                        | 30 days                                                                           |
| where    | response body; the dashboard keeps it in memory, not in localStorage              | cookie `dr_refresh`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api/v1/auth` |
| in DB    | —                                                                                 | only `HMAC-SHA256(JWT_SECRET, token)` in `refresh_tokens.token_hash`              |

### Rotation and theft detection

Each login creates a **family** (`family_id`). Each `refresh`:

1. Finds the token. If it has `used_at` or `revoked_at`, the token was already used (someone has a copy of it). **The whole family is revoked**, and the response is 401 `refresh_token_reused`. So both the attacker and the real user are logged out, and the user has to sign in again.
2. `UPDATE … SET used_at = now() WHERE id = ? AND used_at IS NULL`. The condition is inside the UPDATE, so of two simultaneous refreshes with one token, only one wins and the other is treated as reuse.
3. A new token is issued in the same family.

Changing the password revokes all refresh tokens of the user. Access tokens that were already issued remain valid for at most 15 minutes.

## Login attempt limit

| level                     | limit        | window and lock                                                                              |
| ------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| each account (email hash) | 10 failures  | 15 minutes from the first failure; until the window ends, even the correct password gets 429 |
| each IP                   | 100 failures | 15 minutes; prevents password spraying across different accounts                             |

- Lock response: **429 `login_locked`** with a `Retry-After` header in seconds.
- A successful login resets the account counter.
- The counters are in Valkey (`dirouter:login:*`), so they are shared between replicas. If Valkey is unavailable, the in-memory counter of the same node is used: login does not fail, and each node's protection continues separately.
- Manually unlocking:

  ```bash
  valkey-cli --scan --pattern 'dirouter:login:acct:*' | xargs valkey-cli del
  ```

## Setup wizard

- In one transaction with `pg_advisory_xact_lock`: count the users, create the organization (slug from the name; for a Persian name, `org-xxxxxxxx`), the user and the OWNER membership, and record `setup.completed` in the audit log.
- Two simultaneous requests: exactly one gets 201 and the other gets 409 (integration test).

## Check in compose (2026-11-07, through Traefik at `https://admin.localhost`)

| step                                          | result                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /setup` on an empty DB                   | `{"required":true}`                                                                           |
| `POST /setup`                                 | 201, and a cookie with `Path=/api/v1/auth`, `Secure` and `HttpOnly`                           |
| second `POST /setup`                          | 409 `setup_completed`                                                                         |
| `GET /me`                                     | the user and the organization "DiRouter Dev" with the OWNER role                              |
| `POST /refresh`, then resending the old token | 200, then 401 `refresh_token_reused`. The user's fresh token also got 401 after that.         |
| 10 wrong passwords                            | the tenth gets 429 `login_locked` with `Retry-After: 900`; the correct password also gets 429 |
| deleting the lock key in Valkey               | login 200                                                                                     |

The dev test user's password is in `.data/dev-owner.env` (git-ignored).

---

<a id="persian"></a>

# احراز هویت داشبورد و ویزارد راه‌اندازی

کد: `apps/control-api/src/auth` · تست: `auth.unit.test.ts` و `auth.integration.test.ts` · کارت ۳.۴

## endpointها (`/api/v1/auth`)

| مسیر             | توضیح                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /setup`     | `{"required": true}` تا وقتی هیچ کاربری نیست                                                                                                                  |
| `POST /setup`    | `{organizationName, name, email, password}`: سازمان، کاربر و عضویت OWNER را می‌سازد و وارد می‌شود. بعد از اولین کاربر همیشه **409 `setup_completed`** می‌دهد. |
| `POST /login`    | `{email, password}`: پاسخ access token است و refresh token در کوکی می‌رود                                                                                     |
| `POST /refresh`  | با کوکی: توکن را می‌چرخاند و access تازه می‌دهد                                                                                                               |
| `POST /logout`   | خانوادهٔ نشست را باطل می‌کند و کوکی را پاک می‌کند (204)                                                                                                       |
| `POST /password` | با Bearer: `{currentPassword, newPassword}`؛ همهٔ refresh tokenهای کاربر باطل می‌شوند (204)                                                                   |
| `GET /me`        | با Bearer: کاربر و سازمان‌ها با نقش                                                                                                                           |

همه در Swagger (`/api/docs`) با اسکیمای کامل از zod هستند. خطاها با قالب `application/problem+json` و کد پایدار برمی‌گردند.

## رمز عبور

- **argon2id** (`@node-rs/argon2`، باینری از پیش ساخته برای linux-musl/arm64/x64) با پارامترهای OWASP: m=19MiB، t=2 و p=1.
- رمز حداقل ۱۰ و حداکثر ۲۵۶ کاراکتر است. سقف جلوی DoS روی argon2 را می‌گیرد.
- ایمیل با حروف کوچک ذخیره و مقایسه می‌شود.
- برای ایمیل ناموجود هم یک verify روی hash ثابت انجام می‌شود و پاسخ همان `invalid_credentials` است. پس نه زمان پاسخ و نه پیام وجود حساب را لو نمی‌دهند.

## توکن‌ها

|       | access token                                                                  | refresh token                                                                   |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| قالب  | JWT HS256 (`jose`) با `JWT_SECRET`، iss `dirouter` و aud `dirouter-dashboard` | ۳۲ بایت تصادفی (base64url)                                                      |
| عمر   | ۱۵ دقیقه                                                                      | ۳۰ روز                                                                          |
| کجا   | بدنهٔ پاسخ؛ داشبورد آن را در حافظه نگه می‌دارد، نه localStorage               | کوکی `dr_refresh`: `HttpOnly`، `Secure`، `SameSite=Strict`، `Path=/api/v1/auth` |
| در DB | —                                                                             | فقط `HMAC-SHA256(JWT_SECRET, token)` در `refresh_tokens.token_hash`             |

### چرخش و تشخیص سرقت

هر ورود یک **خانواده** (`family_id`) می‌سازد. هر `refresh`:

1. توکن را پیدا می‌کند. اگر `used_at` یا `revoked_at` داشته باشد، یعنی توکن قبلاً مصرف شده (کسی کپی‌اش را دارد). **کل خانواده باطل می‌شود** و پاسخ 401 `refresh_token_reused` است. پس مهاجم و کاربر واقعی هر دو بیرون می‌افتند و کاربر باید دوباره وارد شود.
2. `UPDATE … SET used_at = now() WHERE id = ? AND used_at IS NULL`. شرط در خود UPDATE است، پس از دو refresh هم‌زمان با یک توکن فقط یکی برنده می‌شود و دیگری به‌عنوان استفادهٔ دوباره رفتار می‌شود.
3. توکن تازه در همان خانواده صادر می‌شود.

تغییر رمز همهٔ refresh tokenهای کاربر را باطل می‌کند. access tokenهای صادرشده حداکثر ۱۵ دقیقه معتبر می‌مانند.

## محدودیت تلاش ورود

| سطح                  | سقف      | پنجره و قفل                                                        |
| -------------------- | -------- | ------------------------------------------------------------------ |
| هر حساب (hash ایمیل) | ۱۰ شکست  | ۱۵ دقیقه از اولین شکست؛ تا پایان پنجره حتی رمز درست هم 429 می‌گیرد |
| هر IP                | ۱۰۰ شکست | ۱۵ دقیقه؛ جلوی password spraying روی حساب‌های مختلف را می‌گیرد     |

- پاسخ قفل: **429 `login_locked`** با هدر `Retry-After` به ثانیه.
- ورود موفق شمارندهٔ حساب را صفر می‌کند.
- شمارنده‌ها روی Valkey هستند (`dirouter:login:*`)، پس بین replicaها مشترک‌اند. اگر Valkey در دسترس نباشد، شمارندهٔ حافظهٔ همان نود استفاده می‌شود: ورود از کار نمی‌افتد و محافظت هر نود جداگانه ادامه دارد.
- باز کردن دستی قفل:

  ```bash
  valkey-cli --scan --pattern 'dirouter:login:acct:*' | xargs valkey-cli del
  ```

## ویزارد setup

- در یک تراکنش با `pg_advisory_xact_lock`: شمارش کاربران، ساخت سازمان (slug از نام؛ برای نام فارسی، `org-xxxxxxxx`)، کاربر و عضویت OWNER، و ثبت `setup.completed` در audit log.
- دو درخواست هم‌زمان: دقیقاً یکی 201 و دیگری 409 می‌گیرد (تست integration).

## بررسی در compose (۲۰۲۶-۱۱-۰۷، از Traefik روی `https://admin.localhost`)

| گام                                           | نتیجه                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /setup` روی DB خالی                      | `{"required":true}`                                                          |
| `POST /setup`                                 | 201، و کوکی با `Path=/api/v1/auth`، `Secure` و `HttpOnly`                    |
| `POST /setup` دوم                             | 409 `setup_completed`                                                        |
| `GET /me`                                     | کاربر و سازمان «DiRouter Dev» با نقش OWNER                                   |
| `POST /refresh`، سپس ارسال دوبارهٔ توکن قدیمی | 200، سپس 401 `refresh_token_reused`. توکن تازهٔ کاربر هم بعد از آن 401 گرفت. |
| ۱۰ رمز اشتباه                                 | دهمی 429 `login_locked` با `Retry-After: 900`؛ رمز درست هم 429               |
| پاک کردن کلید قفل در Valkey                   | ورود 200                                                                     |

رمز کاربر تست dev در `.data/dev-owner.env` است (git-ignored).
