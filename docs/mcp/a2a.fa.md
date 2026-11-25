[English](a2a.md) · [فارسی](a2a.fa.md)

<div dir="rtl">

# A2A: Agent Card، JSON-RPC، streaming و push notification

کارت‌های ۲۰.۳ و ۲۸.۲ · کد: `apps/gateway/src/a2a` (`agent.ts`، `push.ts`)، ایجنت ساختگی و ضبط‌کنندهٔ وبهوک: `apps/mock-provider/src/a2a.ts`

پروتکل Agent2Agent در دو نسخه پیاده شده است: **v1.0** (نسخهٔ فعلی) و **v0.3**. شکل پیام از نام متد تعیین می‌شود. هدر `A2A-Version` (یا پارامتر query با همین نام) به‌صورت Major.Minor خوانده می‌شود و patch نادیده گرفته می‌شود: `1.0` و `0.3` پشتیبانی می‌شوند و هر چیز دیگر خطای VersionNotSupportedError (`-32009`) می‌گیرد. مقدار خالی طبق spec یعنی 0.3، ولی چون نام متد شکل را تعیین می‌کند، کلاینت‌های v1.0 که هدر را نمی‌فرستند هم کار می‌کنند. پاسخ‌ها `A2A-Version` نسخهٔ استفاده‌شده را دارند.

|             | v1.0                                               | v0.3                                               |
| ----------- | -------------------------------------------------- | -------------------------------------------------- |
| ارسال       | `SendMessage` (پاسخ `{task}`)                      | `message/send` (خود Task با `kind: "task"`)        |
| stream      | `SendStreamingMessage`                             | `message/stream`                                   |
| خواندن      | `GetTask` `{id, historyLength?}`                   | `tasks/get`                                        |
| لغو         | `CancelTask`                                       | `tasks/cancel`                                     |
| اشتراک      | `SubscribeToTask` `{id}`                           | `tasks/resubscribe`                                |
| تنظیم push  | `Create/Get/List/DeleteTaskPushNotificationConfig` | `tasks/pushNotificationConfig/set/get/list/delete` |
| part متن    | `{text}`                                           | `{kind: "text", text}`                             |
| نقش و وضعیت | `ROLE_USER`، `TASK_STATE_COMPLETED`                | `user`، `completed`                                |

## DiRouter به‌عنوان ایجنت

- **Agent Card:** `GET /.well-known/agent-card.json` (و `/.well-known/agent.json` برای کلاینت‌های قدیمی)، بدون احراز هویت. `supportedInterfaces` شامل `/a2a` با binding `JSONRPC` برای 1.0 و 0.3 است، احراز هویت Bearer (کلید مجازی) اعلام می‌شود و `capabilities` برابر `{streaming: true, pushNotifications: true}` است. آدرس از هدرهای `X-Forwarded-*` Traefik ساخته می‌شود.
- **پاسخ دادن:** متن پیام از `/v1/chat/completions` خود گیت‌وی با همان کلید فرستنده جواب داده می‌شود، پس routing، فال‌بک، rate limit، بودجه، کیف پول و ثبت مصرف دقیقاً مثل یک درخواست عادی اعمال می‌شوند. مدل از `metadata.model` (درخواست یا پیام) یا تنظیم `settings.a2a.defaultModel` گیت‌وی می‌آید. بدون مدل، Task با وضعیت `rejected` و پیام راهنما برمی‌گردد؛ خطای مدل (مثلاً کمبود اعتبار) Task را `failed` می‌کند.
- **Task و گفتگو:** Task و تاریخچهٔ هر `contextId` یک روز در Valkey (`a2a:task:*`، `a2a:ctx:*`) می‌مانند. پیام بعدی با همان `contextId` ادامهٔ گفتگوست (حداکثر ۴۰ پیام). هر Task فقط برای همان سازمان و پروژه دیده می‌شود: پروژهٔ دیگر TaskNotFound (`-32001`) می‌گیرد و `contextId` پروژهٔ دیگر گفتگوی تازه شروع می‌کند.

### چرخهٔ عمر Task (کارت ۲۸.۲)

`submitted` ← `working` ← `completed` / `failed`، یا `rejected` (بدون مدل) یا `canceled`.

- `SendMessage` به‌طور پیش‌فرض منتظر پاسخ می‌ماند. با `configuration.returnImmediately: true` (در v0.3: `blocking: false`) Task ثبت‌شده را فوراً برمی‌گرداند و کار را در پس‌زمینه تمام می‌کند؛ پیگیری با `GetTask`، `SubscribeToTask` یا push notification.
- `CancelTask` کاری را که هنوز در جریان است لغو می‌کند (فراخوانی مدل روی replica اجراکننده قطع می‌شود و نتیجه‌ای که بعداً برسد کنار گذاشته می‌شود)؛ کار تمام‌شده خطای TaskNotCancelableError (`-32002`) می‌گیرد.

### Streaming

- `SendStreamingMessage` با `text/event-stream` پاسخ می‌دهد. هر خط `data:` یک پاسخ JSON-RPC با id درخواست است که `result` آن یک `StreamResponse` نسخهٔ 1.0 با دقیقاً یکی از `task`، `statusUpdate` یا `artifactUpdate` است:
  1. `{task}` با وضعیت `TASK_STATE_SUBMITTED`؛
  2. `{statusUpdate}` با `TASK_STATE_WORKING`؛
  3. پاسخ همان‌طور که از مدل stream می‌شود: `{artifactUpdate: {artifact: {artifactId: "<task>-answer", parts: [{text}]}, append, lastChunk}}`، تکهٔ اول با `append: false` و تکهٔ آخر با `lastChunk: true`؛
  4. `{statusUpdate}` با وضعیت پایانی، و بعد stream بسته می‌شود.

  نسخهٔ v0.3 (`message/stream`) همین‌ها را به‌صورت Task (`kind: "task"`)، `{kind: "status-update", final}` و `{kind: "artifact-update", append, lastChunk}` می‌فرستد. ردهایی که از قبل معلوم‌اند (پیام نامعتبر، Task ناموجود) به‌جای stream یک خطای عادی JSON-RPC برمی‌گردانند. هر ۱۵ ثانیه یک خط comment می‌رود تا پروکسی‌ها stream بی‌کار را نبندند. قطع شدن کلاینت فقط stream خودش را تمام می‌کند، نه Task را.

- `SubscribeToTask` کاری را که هنوز در جریان است با همان شکل stream می‌کند و با Task در وضعیت فعلی‌اش شروع می‌شود. برای کار تمام‌شده طبق spec خطای UnsupportedOperationError (`-32004`) می‌دهد. رویدادها بین replicaها از طریق pub/sub در Valkey (`a2a:events:<task>`) جابه‌جا می‌شوند، پس اشتراک روی هر replica کار می‌کند.
- proxy ایجنت‌های خارجی پاسخ‌های SSE را بدون تغییر عبور می‌دهد.

### Push notification

وبهوک برای یک Task با `CreateTaskPushNotificationConfig` ثبت می‌شود (`{taskId, id?, url, token?, authentication?: {scheme, credentials?}}`؛ در v0.3 داخل `pushNotificationConfig` با `authentication.schemes`)، یا مستقیم هنگام ارسال با `configuration.taskPushNotificationConfig` (در v0.3 `pushNotificationConfig`). حداکثر ۱۰ تا برای هر Task. `Get` و `List` (`{configs, nextPageToken}`) هیچ‌وقت credentials را برنمی‌گردانند؛ `Delete` idempotent است. تنظیمات همراه Task و رمزشده با MASTER_KEY نگه داشته می‌شوند.

با هر تغییر وضعیت، هر وبهوک یک `POST` می‌گیرد:

|                             |                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| بدنه                        | v1.0: `{statusUpdate}` برای `working` و `{task}` (با پاسخ) برای وضعیت پایانی؛ v0.3: خود Task |
| `Content-Type`              | `application/a2a+json` (v1.0) یا `application/json` (v0.3)                                   |
| `Authorization`             | `<scheme> <credentials>` از تنظیم، طبق spec                                                  |
| `X-A2A-Notification-Token`  | `token` تنظیم، برای اطمینان از اینکه اعلان مال همان تنظیم است                                |
| `X-DiRouter-Push-Signature` | JWS فشرده با ES256 (پایین)                                                                   |
| `A2A-Version`               | نسخهٔ تنظیم                                                                                  |

اعلان‌های هر Task به ترتیب و دست‌کم یک بار فرستاده می‌شوند: خطای شبکه، 429 و 5xx پس از ۰.۵، ۱ و ۲ ثانیه دوباره امتحان می‌شوند، هر تلاش ۱۰ ثانیه فرصت دارد و redirect دنبال نمی‌شود.

**امضا.** هدر JWS شامل `alg: ES256`، `kid` و `jku` (`<agent>/.well-known/jwks.json`) است؛ claimها: `iss` (آدرس ایجنت)، `aud` (آدرس وبهوک)، `taskId`، `iat`، `exp` (پنج دقیقه)، `jti` و `request_body_sha256` (SHA-256 هگز بدنهٔ دقیق). گیرنده یک بار `GET /.well-known/jwks.json` را می‌گیرد (همین آدرس را pin کند، نه اینکه کورکورانه به `jku` اعتماد کند)، امضا، تطابق hash بدنه، برابری `aud` با آدرس خودش و نگذشتن `exp` را بررسی می‌کند و `jti` تکراری را دور می‌اندازد. کلید از MASTER_KEY مشتق می‌شود (HKDF)، پس همهٔ replicaها بدون راز تازه با یک کلید امضا می‌کنند؛ چرخش MASTER_KEY کلید را هم می‌چرخاند و `kid` عوض می‌شود.

**SSRF.** آدرس باید http(s) و بدون credentials داخل URL باشد. در production (`NODE_ENV=production`) برای همهٔ سازمان‌ها جز سازمان پلتفرم باید https باشد و به آدرس عمومی برسد (همان guard providerها در کارت ۲۲.۳)؛ این هنگام ساختن تنظیم و دوباره هنگام اتصال (DNS rebinding) بررسی می‌شود و IP مستقیم هم مستقیماً سنجیده می‌شود.

## ایجنت‌های خارجی

ایجنت خارجی مثل سرور MCP با transport برابر `a2a` ثبت می‌شود (`POST /orgs/:orgId/mcp/servers`، `url` همان endpoint JSON-RPC ایجنت، `headers` رمزشده برای کلید خود ایجنت):

- `POST /a2a/agents/<slug>`: درخواست JSON-RPC (هر نسخه) با هدرهای ایجنت، `A2A-Version` کلاینت و در صورت `forwardIdentity` شناسه‌های سازمان، پروژه و کلید فرستاده می‌شود. پاسخ‌های stream عبور داده می‌شوند.
- `GET /a2a/agents/<slug>/.well-known/agent-card.json`: کارت ایجنت (اول زیر مسیر آن، بعد ریشهٔ origin) با `supportedInterfaces` بازنویسی‌شده به DiRouter و طرح Bearer دی‌روتر. آدرس و احراز هویت خود ایجنت پنهان می‌ماند.
- حاکمیت کلید: allowlist `mcpTools` کلید با الگوی `<slug>__*` (یا `*`) ایجنت را مجاز می‌کند. ایجنت غیرمجاز 404 می‌گیرد و `denied` ثبت می‌شود.
- لاگ: هر فراخوانی در `mcp_tool_calls` با `tool = a2a:<method>` و متن ماسک‌شدهٔ پیام ثبت می‌شود.

## تست

- `apps/gateway/src/a2a/agent.test.ts`: کارت، `SendMessage`/`GetTask`/`CancelTask` نسخهٔ 1.0، شکل v0.3، گفتگو در context و جداسازی پروژه، Task رد شده بدون مدل، نسخهٔ پشتیبانی‌نشده، و proxy ایجنت خارجی (کلید، هویت، allowlist، لاگ).
- `apps/gateway/src/a2a/streaming.test.ts`: SDKهای رسمی A2A در محیط تست بدون اینترنت نصب نمی‌شوند، پس تست یک کلاینت نوشته‌شده از روی spec نسخهٔ 1.0 دارد (کشف Agent Card، `A2A-Version`، خواندن SSE، یک عضو `StreamResponse` در هر رویداد، Task اول، `append`/`lastChunk`، پایان در وضعیت پایانی). با آن: `SendStreamingMessage` تکه‌به‌تکه، `message/stream` نسخهٔ v0.3، `SubscribeToTask` روی کار در جریان و تمام‌شده، `CancelTask` کار در جریان، رسیدن push notification به وبهوک محلی با `Authorization`، token و امضای تأییدشده با JWKS (و رد شدن آن برای بدنهٔ تغییرکرده)، تلاش دوباره برای وبهوک خراب، CRUD تنظیم در هر دو نسخه و برای هر پروژه، مذاکرهٔ نسخه، stream ایجنت خارجی، اشتراک بین دو گیت‌وی از طریق Valkey (با `INTEGRATION_VALKEY_URL`)، و رد آدرس خصوصی وبهوک زیر guard نوع SSRF.
- e2e روی compose: `node scripts/e2e/sprint-3.mjs 20.3` و `node scripts/e2e/sprint-4.mjs 28.2` (stream از Traefik، و اعلان‌های امضاشده در ضبط‌کنندهٔ وبهوک mock در `/__hooks/<name>` که با کلید منتشرشده تأیید می‌شوند).

</div>
