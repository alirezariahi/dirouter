[English](sso.md) · [فارسی](sso.fa.md)

<div dir="rtl">

# ورود یکپارچه با OIDC (کارت ۱۴.۲)

> کد: `apps/control-api/src/security/sso.{service,controller}.ts`، صفحهٔ ورود داشبورد و صفحهٔ «امنیت».

DiRouter با هر ارائه‌دهندهٔ OpenID Connect (Keycloak، Entra ID، Okta، Google Workspace و …) و با جریان authorization code کاربر را وارد می‌کند.

## جریان کار

1. کاربر در صفحهٔ ورود ایمیل سازمانی را می‌نویسد و **ورود با SSO سازمانی** را می‌زند. داشبورد `POST /auth/sso/lookup` را صدا می‌زند؛ اتصالی انتخاب می‌شود که `allowedDomains` آن دامنهٔ ایمیل را داشته باشد.
2. `POST /auth/sso/:connectionId/start` آدرس authorization ارائه‌دهنده را برمی‌گرداند. درخواست با **PKCE (S256)**، یک `state` تصادفی و یک `nonce` ساخته می‌شود؛ هر سه چند دقیقه در Valkey می‌مانند و یک‌بارمصرف‌اند. `state` با یک کوکی HttpOnly (`dr_sso_state`) به همان مرورگر هم گره می‌خورد؛ پس callback فقط در مرورگری که جریان را شروع کرده موفق می‌شود. redirect URI همیشه `<PUBLIC_DASHBOARD_URL>/login` است و `redirectUri` ارسالی کلاینت فقط با آن مقایسه می‌شود.
3. ارائه‌دهنده به `<dashboard>/login?code=…&state=…` برمی‌گردد. داشبورد کد را از نوار آدرس پاک و `GET /auth/sso/callback` را صدا می‌زند.
4. control-api کد را مبادله می‌کند، امضای ID token را با JWKS ارائه‌دهنده و مقدارهای issuer، audience و nonce را بررسی می‌کند. `email_verified` باید `true` و دامنهٔ ایمیل در `allowedDomains` باشد.
5. کاربر جدید همان لحظه ساخته و به سازمان اضافه می‌شود. حساب **موجود** فقط وقتی پذیرفته می‌شود که از قبل عضو سازمانِ همین اتصال باشد؛ وگرنه ورود رد می‌شود و کاربر باید اول دعوت شود (ارائه‌دهندهٔ هویت فقط از طرف سازمان خودش حرف می‌زند).
6. کاربر نشستی (access token و کوکی refresh) می‌گیرد که **فقط در همان سازمان** معتبر است. از نشست SSO نمی‌توان passkey یا TOTP ثبت کرد؛ برای آن نشستی لازم است که با رمز یا passkey خود کاربر باز شده باشد.

## تنظیم اتصال

داشبورد → **امنیت** → «اتصال‌های SSO»، یا API (مجوز `security:write`):

```bash
curl -X POST "$ADMIN/orgs/$ORG/sso" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "Company Keycloak",
  "issuer": "https://sso.example.com/realms/company",
  "clientId": "dirouter-dashboard",
  "clientSecret": "…",
  "defaultRole": "MEMBER",
  "allowedDomains": ["example.com"],
  "groupRoleMap": { "dirouter-admins": "ADMIN", "dirouter-members": "MEMBER" }
}'
```

| فیلد             | معنی                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`         | issuer؛ `/.well-known/openid-configuration` از روی آن کشف می‌شود                                                                                                     |
| `clientSecret`   | فقط نوشتنی؛ با `MASTER_KEY` رمز و هرگز برگردانده نمی‌شود                                                                                                             |
| `allowedDomains` | **اجباری**: دامنه‌های ایمیلی که این اتصال پوشش می‌دهد؛ دامنه‌های دیگر رد می‌شوند                                                                                     |
| `defaultRole`    | نقش کاربران **جدیدی** که گروهشان در `groupRoleMap` نیست؛ روی اعضای موجود اعمال نمی‌شود                                                                               |
| `groupRoleMap`   | مقدارهای claim به نام `groups` را به نقش‌های DiRouter نگاشت می‌کند؛ بالاترین نقش منطبق برنده است. انطباق می‌تواند نقش عضو موجود را بالا ببرد ولی هرگز پایین نمی‌آورد |

`issuer` باید `https` باشد (`http` فقط وقتی `NODE_ENV` برابر `production` نیست) و در production میزبان‌های issuer، token و JWKS باید به آدرس عمومی resolve شوند. نقش `OWNER` هرگز از راه SSO داده نمی‌شود (نه در `defaultRole` و نه در `groupRoleMap`) و هیچ‌کس نمی‌تواند نقشی بالاتر از نقش خودش را پیکربندی کند؛ مالکیت را فقط یک مالک موجود در صفحهٔ اعضا می‌دهد.

در ارائه‌دهنده، `<PUBLIC_DASHBOARD_URL>/login` را به‌عنوان redirect URI ثبت کنید، جریان authorization code با PKCE را فعال کنید و claim به نام `groups` را منتشر کنید (درخواست scopeهای `openid email profile groups` را می‌خواهد).

## سازمان‌های فقط-SSO

`PATCH /orgs/:orgId/security` با `{"passwordLoginDisabled": true}` ورود با رمز عبور را برای اعضای سازمان می‌بندد (ورود با `sso_required` پاسخ می‌گیرد). فقط وقتی دست‌کم یک اتصال فعال وجود دارد روشن می‌شود تا سازمان خودش را قفل نکند. در سازمان فقط-SSO، عامل دوم بر عهدهٔ ارائه‌دهندهٔ هویت است و تا وقتی اتصال فعالی هست سیاست MFA اجباری محلی اعمال نمی‌شود ([security.fa.md](security.fa.md)).

## تست محلی با Keycloak

`compose.sso.yaml` یک Keycloak توسعه با realm آماده اضافه می‌کند:

```bash
docker compose -f compose.yaml -f compose.dev.yaml -f compose.sso.yaml up -d --wait
```

| مورد            | مقدار                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Issuer          | `http://sso.localhost/realms/dirouter`                                                                                                |
| Client ID       | `dirouter-dashboard`                                                                                                                  |
| Client secret   | `dirouter-dev-client-secret`                                                                                                          |
| کاربران آزمایشی | `alice@example.com` / `alice-dev-password` (گروه `dirouter-admins`)، `bob@example.com` / `bob-dev-password` (گروه `dirouter-members`) |
| کنسول مدیریت    | `http://sso.localhost/admin` (`admin` / `admin`)                                                                                      |

با همین مقدارها یک اتصال بسازید و از صفحهٔ ورود داشبورد با Alice وارد شوید:

```bash
curl -X POST "$ADMIN/orgs/$ORG/sso" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "Local Keycloak",
  "issuer": "http://sso.localhost/realms/dirouter",
  "clientId": "dirouter-dashboard",
  "clientSecret": "dirouter-dev-client-secret",
  "defaultRole": "MEMBER",
  "allowedDomains": ["example.com"],
  "groupRoleMap": { "dirouter-admins": "ADMIN", "dirouter-members": "MEMBER" }
}'
```

- `allowedDomains` الزامی است و باید دامنهٔ کاربران آزمایشی (`example.com`) را داشته باشد؛ اتصال بدون آن رد می‌شود.
- issuer با `http://` فقط به این دلیل پذیرفته می‌شود که stack توسعه با `NODE_ENV` غیر از `production` اجرا می‌شود. همین URL هم از مرورگر و هم از کانتینر control-api کار می‌کند (Traefik در شبکهٔ Docker به `sso.localhost` پاسخ می‌دهد).
- Alice و Bob هنوز در DiRouter وجود ندارند؛ پس اولین ورود آن‌ها را در سازمان صاحب اتصال می‌سازد. ایمیلی که از قبل حساب DiRouter دارد باید از قبل عضو همان سازمان باشد، وگرنه ورود رد می‌شود. از همین دو کاربر آزمایشی استفاده کنید، نه از نشانی مدیر seed‌شده.

فایل realm، client scopeهایش را کامل تعریف می‌کند (`basic`، `profile`، `email` و `groups`) و هر چهار مورد را به client می‌دهد؛ چون realmی که در import حتی یک client scope فهرست کند scopeهای پیش‌ساختهٔ Keycloak را نمی‌گیرد. بنابراین ID token شامل `email`، `email_verified: true`، `preferred_username` و `groups` است. برای بررسی، ID token یک ورود را decode کنید یا در کنسول مدیریت از _Clients → dirouter-dashboard → Client scopes → Evaluate_ استفاده کنید.

این مقدارها آزمایشی و عمومی‌اند؛ این realm را هرگز بیرون از توسعهٔ محلی استفاده نکنید.

> این overlay و فایل realm با `docker compose config` و به‌عنوان JSON اعتبارسنجی شده‌اند، ولی Keycloak هنوز با آن‌ها راه‌اندازی نشده است. اگر import روی نسخهٔ Keycloak شما خطا داد، client و mapperهای `email`، `email_verified`، `preferred_username` و `groups` را با همین مقدارها دستی در کنسول مدیریت بسازید.

## عیب‌یابی

| نشانه                                              | علت محتمل                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| «اتصال SSO فعالی برای این ایمیل نیست»              | دامنهٔ ایمیل در `allowedDomains` نیست یا اتصال غیرفعال است                                                 |
| `invalid SSO state`                                | ورود طول کشیده، پیوند دو بار باز شده یا Valkey در این فاصله ری‌استارت شده                                  |
| `SSO nonce mismatch` یا خطای امضا                  | آدرس issuer از دید مرورگر و control-api فرق دارد یا ساعت سرور عقب‌وجلو است                                 |
| ورود موفق ولی نقش اشتباه                           | توکن claim به نام `groups` ندارد یا نام گروه‌ها با کلیدهای `groupRoleMap` یکی نیست                         |
| ایمیل تأیید نشده                                   | ارائه‌دهنده باید `email_verified: true` بفرستد                                                             |
| «SSO sign-in was not started in this browser»      | کوکی `dr_sso_state` نیست: جریان در مرورگر دیگری شروع شده، کوکی‌ها بسته‌اند یا داشبورد و API هم‌سایت نیستند |
| «…exists but is not a member of this organization» | این ایمیل از قبل بیرون از این سازمان حساب DiRouter دارد؛ اول دعوتش کنید                                    |
| `redirectUri does not match…`                      | `PUBLIC_DASHBOARD_URL` با آدرس واقعی داشبورد یکی نیست                                                      |
| «SSO URL must resolve to a public address»         | در production، issuer (یا endpoint توکن/JWKS آن) به آدرس خصوصی یا loopback اشاره می‌کند                    |

</div>
