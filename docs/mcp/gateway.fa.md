[English](gateway.md) · [فارسی](gateway.fa.md)

<div dir="rtl">

# MCP Gateway

کارت‌های ۲۰.۱ و ۲۸.۱ · کد: `apps/gateway/src/mcp`، `apps/control-api/src/mcp`، `apps/worker/src/mcp-calls.ts`، `packages/shared/src/oauth-client.ts`، `scripts/mcp/stdio-bridge.mjs`

## چه می‌کند

گیت‌وی روی `/mcp` یک سرور MCP با transport **Streamable HTTP** است. همهٔ سرورهای MCP ثبت‌شدهٔ سازمان را پشت همان کلید مجازی، مجوز و لاگ مدل‌ها جمع می‌کند:

```bash
claude mcp add --transport http dirouter https://api.example.com/mcp \
  --header "Authorization: Bearer dr-xxxxxxxx-…"
```

- **ابزارها** با پیشوند سرور نمایش داده می‌شوند: `<slug>__<tool>` (مثلاً `github__create_issue`). `tools/list` صفحه‌بندی upstream را دنبال می‌کند و فهرست هر سرور ۶۰ ثانیه cache می‌شود. سرور خراب فقط آیتم‌های خودش را از دست می‌دهد.
- **resourceها و promptها** (کارت ۲۸.۱) با همان namespacing عبور می‌کنند:

  | متد                        | آنچه کلاینت می‌بیند                                                                               |
  | -------------------------- | ------------------------------------------------------------------------------------------------- |
  | `resources/list`           | `name` می‌شود `<slug>__<name>` و `uri` می‌شود `<slug>+<uri>` (مثلاً `github+repo://readme`)       |
  | `resources/templates/list` | `uriTemplate` می‌شود `<slug>+<template>`؛ URI که کلاینت از آن می‌سازد هم با `<slug>+` شروع می‌شود |
  | `resources/read`           | `<slug>+<uri>` به‌صورت `<uri>` به سرور می‌رود؛ URIهای `contents` با پیشوند برمی‌گردند             |
  | `prompts/list`             | `name` می‌شود `<slug>__<name>`                                                                    |
  | `prompts/get`              | با پیشوند مسیریابی می‌شود؛ resourceهای جاسازی‌شده در پیام‌ها با URI پیشونددار برمی‌گردند          |

  `+` در scheme یک URI مجاز است و در slug نمی‌آید، پس جدا کردن آن یکتاست. resource linkها و resourceهای جاسازی‌شده در نتیجهٔ `tools/call` هم همین‌طور بازنویسی می‌شوند تا کلاینت بتواند آن‌ها را از گیت‌وی بخواند. `resources/subscribe` ارائه نمی‌شود (endpoint بدون session است). سروری که resource یا prompt ندارد (`-32601`) فقط چیزی به فهرست اضافه نمی‌کند.

- **allowlist کلید** (`mcpTools`): `server__tool`، `server__*` یا `*`؛ خالی یعنی همه. ابزار و prompt با نام سنجیده می‌شوند: آیتم خارج از allowlist نه فهرست می‌شود نه قابل فراخوانی است، و پاسخ آن دقیقاً مثل آیتم ناموجود است (`-32602 Unknown tool` یا `Unknown prompt`). resource و template نام پایداری برای سنجیدن ندارند، پس کل سرور را لازم دارند (`server__*`، `*` یا فهرست خالی)؛ وگرنه `resources/read` پاسخ `-32002 Resource not found` می‌دهد.
- **لاگ هر فراخوانی:** سازمان، پروژه، کلید، سرور، ابزار، آرگومان‌های ماسک‌شده، نتیجه (`success`، `error`، `denied`) و latency. `resources/read` با ابزار `resource:<uri>` و `prompts/get` با `prompt:<name>` ثبت می‌شود. ماسک در خود گیت‌وی انجام می‌شود: کلیدهایی مثل password، token، secret، api_key، authorization و cookie با `***` جایگزین و رشته‌های بلند (بیش از ۲۰۰ نویسه)، آرایه‌ها و عمق‌های زیاد کوتاه می‌شوند. رکورد در صف `mcp-calls` می‌رود و worker آن را در `mcp_tool_calls` می‌نویسد (idempotent). نگهداری `MCP_CALL_RETENTION_DAYS` روز است (پیش‌فرض ۹۰).
- **ارسال هویت:** با `forwardIdentity` هدرهای `X-DiRouter-Organization-Id`، `X-DiRouter-Project-Id`، `X-DiRouter-Key-Id` و در صورت وجود `X-DiRouter-User` (از درخواست کلاینت) به سرور MCP فرستاده می‌شوند. این هدرها امضا ندارند، پس سرور MCP فقط وقتی باید به آن‌ها اعتماد کند که فقط از گیت‌وی قابل دسترس باشد.
- endpoint بدون state است: session صادر نمی‌کند و `GET` و `DELETE` پاسخ 405 می‌گیرند.

## سرورهای upstream

| transport          | رفتار                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `streamable-http`  | POST برای هر پیام؛ پاسخ JSON یا SSE. `Mcp-Session-Id` نگه داشته می‌شود و با 404 یک بار دوباره initialize می‌شود |
| `sse` (2024-11-05) | یک GET دائمی endpoint را اعلام می‌کند؛ درخواست‌ها به آن POST و پاسخ‌ها روی stream تحویل می‌شوند                 |
| stdio              | گیت‌وی اجرا نمی‌کند؛ [تصمیم stdio](#تصمیم-سرورهای-stdio) را ببینید                                              |

برای هر سرور یک اتصال در هر replica گیت‌وی هست. با تغییر آدرس، transport، هدر یا credential OAuth، اتصال دوباره ساخته می‌شود.

## احراز هویت OAuth 2.1 به upstream (کارت ۲۸.۱)

جدا از هدر ثابت، هر سرور می‌تواند **credential مشترک OAuth سازمان** را داشته باشد (فیلد `oauth`). گیت‌وی طبق [spec احراز هویت MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) کلاینت OAuth است:

1. **کشف.** metadata منبع محافظت‌شده (RFC 9728): از پارامتر `resource_metadata` در `WWW-Authenticate` سرور، وگرنه `/.well-known/oauth-protected-resource/<path>`، وگرنه well-known ریشه. بعد metadata سرور احراز هویت (RFC 8414) در `/.well-known/oauth-authorization-server/<path>` با fallbackهای OpenID Connect. issuer داخل metadata باید یکی باشد. `issuer` در credential قدم اول و `tokenEndpoint` هر دو قدم را حذف می‌کند.
2. **توکن.** همیشه با `resource` طبق RFC 8707 (آدرس سرور، یا `resource` اعلام‌شده در metadata آن). احراز هویت کلاینت `client_secret_basic` است مگر سرور فقط `client_secret_post` را پشتیبانی کند (یا `tokenEndpointAuthMethod` چیز دیگری بگوید).
   - `client_credentials`: فقط با client secret توکن گرفته می‌شود. اگر سرور refresh token هم بدهد، دفعهٔ بعد اول از آن استفاده می‌شود.
   - `authorization_code`: مدیر یک بار سرور را وصل می‌کند (پایین‌تر)؛ از آن به بعد گیت‌وی با refresh token کار می‌کند.
3. **تمدید خودکار.** توکن کمی پیش از انقضا تمدید می‌شود (یک‌چهارم عمر آن، حداکثر ۶۰ ثانیه زودتر)، و فوراً وقتی سرور 401 بدهد (لغو یا انقضای زودهنگام): درخواست یک بار با توکن تازه تکرار می‌شود. refresh token چرخیده جای قبلی را می‌گیرد.
4. **چند replica.** با Valkey، replicaها توکن دسترسی جاری و تازه‌ترین refresh token را به اشتراک می‌گذارند (`mcp:oauth:at:*`، `mcp:oauth:rt:*`، رمزشده با MASTER_KEY) و تمدید را زیر یک قفل کوتاه انجام می‌دهند (`mcp:oauth:lock:*`)، تا سرور احراز هویتی که refresh token را می‌چرخاند هیچ‌وقت یک توکن را دو بار نبیند. بدون Valkey هر replica توکن خودش را دارد.
5. **SSRF.** در production (`NODE_ENV=production`) endpointهای کشف‌شدهٔ سازمان‌های مشتری باید به آدرس عمومی برسند (همان guard providerها، هنگام اتصال بررسی می‌شود)؛ redirect دنبال نمی‌شود. control-api هم endpointهایی را که صدا می‌زند با سیاست وبهوک هشدار بررسی می‌کند.

credential رمزشده نگه داشته می‌شود (AAD `mcp-oauth:<id>`، ستون `mcp_servers.oauth_enc`) و فقط‌نوشتنی است: API فقط `grantType`، `clientId`، `scope`، endpointها، `hasClientSecret` و `connected` را برمی‌گرداند. توکن‌ها جز refresh token مرحلهٔ اتصال به دیتابیس نمی‌رسند.

### وصل کردن سرور authorization code

```bash
# ۱. ذخیرهٔ credential (کلاینتی که در سرور احراز هویت ثبت شده)
curl -X PATCH …/orgs/$ORG/mcp/servers/$ID -d '{"oauth":{"grantType":"authorization_code","clientId":"…","clientSecret":"…","scope":"offline_access mcp"}}'
# ۲. گرفتن آدرس authorization (PKCE S256، state مهرشده با MASTER_KEY، معتبر ۱۰ دقیقه)
curl -X POST …/orgs/$ORG/mcp/servers/$ID/oauth/authorize -d '{"redirectUri":"https://dash.example.com/mcp/callback"}'
# ۳. باز کردن authorizationUrl، تأیید، و برگرداندن code و state از redirect
curl -X POST …/orgs/$ORG/mcp/servers/$ID/oauth/callback -d '{"code":"…","state":"…"}'
```

callback این‌ها را رد می‌کند: state ساخته‌شده برای سرور یا سازمان دیگر یا قدیمی‌تر از ۱۰ دقیقه، و سرور احراز هویتی که refresh token نمی‌دهد. جایگزین کردن credential با همان کلاینت و همان سرور احراز هویت (مثلاً client secret تازه) اتصال را نگه می‌دارد؛ `oauth: null` آن را حذف می‌کند.

OAuth برای هر کاربر (توکن خود هر کاربر در خزانهٔ توکن) در این کارت نیست.

اتصال authorization code در v1.1 **فقط از راه API** است: صفحهٔ MCP داشبورد فرم OAuth یا دکمهٔ اتصال ندارد؛ پس credential را ذخیره کنید و سه فراخوانی بالا را با توکن مدیریتی یا نشست یک مدیر اجرا کنید.

## تصمیم: سرورهای stdio

**تصمیم (کارت ۲۸.۱): گیت‌وی هیچ سرور MCP نوع stdio را اجرا نمی‌کند، برای هیچ سازمانی، حتی سازمان پلتفرم.**

- اجرای سرور stdio یعنی اجرای پروسه با دسترسی، شبکه و فایل‌سیستم گیت‌وی. در گیت‌وی چندمستأجره سرور یک مستأجر می‌تواند ترافیک مستأجر دیگر، master key در حافظه یا کلیدهای providerها را بخواند. جداسازی درست آن (sandbox برای هر پروسه، محدودیت منابع، allowlist ایمیج) خودش یک محصول جداست، نه بخشی از گیت‌وی مسیریابی.
- محدود کردن آن به سازمان پلتفرم هم بررسی شد. باز هم کد بیگانه را داخل data plane می‌برد، که باید کوچک و هر لحظه قابل ری‌استارت بماند، و توانایی‌ای نمی‌دهد که sidecar نمی‌دهد.
- **راه پشتیبانی‌شده** bridge نوع stdio به‌صورت sidecar جدا زیر کنترل اپراتور است: `node scripts/mcp/stdio-bridge.mjs --port 8765 -- npx -y <mcp-server>` و ثبت با `http://<sidecar>:8765/mcp` و transport `streamable-http`. bridge فرزند را یک بار initialize می‌کند و idها را بازنویسی می‌کند تا چند گیت‌وی هم‌زمان از آن استفاده کنند. sidecar در کانتینر خودش، با محدودیت‌ها و رازهای خودش اجرا می‌شود و فقط از شبکهٔ گیت‌وی قابل دسترس است. در production چنین آدرس خصوصی فقط برای سازمان پلتفرم مجاز است (control-api برای بقیه رد می‌کند)، پس sidecar تصمیم اپراتور می‌ماند.

## مدیریت (control-api)

مجوزها: `mcp:read` و `mcp:write`.

| متد              | مسیر                                                    | توضیح                                                                                    |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET/POST         | `/orgs/:orgId/mcp/servers`                              | `{name, slug, transport, url, headers?, oauth?, enabled?, forwardIdentity?, timeoutMs?}` |
| GET/PATCH/DELETE | `/orgs/:orgId/mcp/servers/:id`                          | `headers: null` و `oauth: null` آن‌ها را حذف می‌کنند؛ نبودنشان یعنی بدون تغییر           |
| POST             | `/orgs/:orgId/mcp/servers/:id/oauth/authorize`          | `{redirectUri}` ← `{authorizationUrl, state}`                                            |
| POST             | `/orgs/:orgId/mcp/servers/:id/oauth/callback`           | `{code, state}` ← سرور با `oauth.connected: true`                                        |
| GET              | `/orgs/:orgId/mcp/calls?limit&serverId&apiKeyId&status` | لاگ فراخوانی‌ها                                                                          |

- مقدار هدرها (مثلاً `Authorization`) با MASTER_KEY رمز می‌شود (AAD `mcp:<id>`)، هرگز برنمی‌گردد (فقط `hasHeaders`) و در audit فقط «replaced/removed» ثبت می‌شود. credential OAuth هم همین‌طور. در snapshot هر دو رمزشده می‌مانند و گیت‌وی در حافظه باز می‌کند.
- URL با سیاست وبهوک‌های هشدار بررسی می‌شود: در production فقط https و آدرس عمومی، جز برای سازمان پلتفرم که می‌تواند آدرس خصوصی مثل sidecar نوع stdio ثبت کند (کارت ۲۸.۱).
- `slug` در هر سازمان یکتاست و الگوهای ابزار کلید (`mcpTools`) اعتبارسنجی می‌شوند.

## تست

- `apps/gateway/src/mcp/gateway.test.ts` روی سرورهای MCP ساختگی mock-provider (`/mcp/:name`، `/mcp/:name-sse`، `/mcp-legacy/:name`): initialize، تجمیع با صفحه‌بندی، allowlist، سه transport، ارسال هویت فقط وقتی تنظیم شده، تمدید session، ماسک و لاگ، سرور خراب؛ resourceها (صفحه‌بندی‌شده)، templateها، `resources/read` با URI فهرست‌شده و URI ساخته‌شده از template، promptها با resource جاسازی‌شده، resource link در نتیجهٔ ابزار، و allowlist برای resource و prompt.
- `apps/gateway/src/mcp/oauth.test.ts` روی سرور OAuth ساختگی mock (`/mcp-oauth/:name`، `/oauth`): کشف از آدرس سرور، client credentials، تمدید پیش از انقضا و پس از توکن لغوشده (401)، refresh token یک سرور client credentials، اتصال authorization code در سه چرخش، سرور وصل‌نشده، اشتراک توکن بین دو گیت‌وی از طریق Valkey (با `INTEGRATION_VALKEY_URL`)، و guard نوع SSRF.
- `packages/shared/src/oauth-client.test.ts`: آدرس‌های well-known، پارامتر challenge، ترتیب کشف، بررسی issuer، احراز هویت کلاینت.
- `apps/control-api/src/mcp/mcp.integration.test.ts`: رمز شدن هدر و credential OAuth، اتصال authorization code (authorize، تأیید در mock، callback، state نامعتبر)، حفظ اتصال با تغییر secret، snapshot، allowlist، لاگ.
- `scripts/mcp/stdio-bridge.test.mjs`: bridge روی یک سرور stdio کوچک.
- e2e روی compose: `node scripts/e2e/sprint-3.mjs 20.1` (Claude Code واقعی) و `node scripts/e2e/sprint-4.mjs 28.1` (resource و prompt از گیت‌وی، سرور محافظت‌شده با OAuth ثبت‌شده از control-api، و تمدید توکن آن پس از لغو در mock).

</div>
