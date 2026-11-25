[English](realtime.md) · [فارسی](realtime.fa.md)

<div dir="rtl">

# Realtime API روی WebSocket (کارت ۳۰.۵)

برنامه‌های صوتی زنده‌ای که روی Realtime API اوپن‌ای‌آی ساخته شده‌اند بدون تغییر از DiRouter کار می‌کنند: `baseURL` در SDK را به گیت‌وی بدهید و کلید DiRouter را به کار ببرید. WebRTC در این کارت نیست؛ مرورگر از WebSocket با client secret استفاده می‌کند.

| endpoint                           | کار                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `GET /v1/realtime?model=…` (ارتقا) | خود نشست؛ رویدادها در هر دو جهت عبور می‌کنند                                  |
| `POST /v1/realtime/client_secrets` | GA: یک client secret کوتاه‌عمر برای مرورگر (`{ value, expires_at, session }`) |
| `POST /v1/realtime/sessions`       | beta: همان، به شکل `{ …session, client_secret: { value, expires_at } }`       |

</div>

```ts
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';

const client = new OpenAI({
  apiKey: process.env.DIROUTER_KEY,
  baseURL: 'https://api.example.com/v1',
});
const rt = new OpenAIRealtimeWS({ model: 'openai/gpt-realtime' }, client);
rt.on('session.created', () => rt.send({ type: 'response.create' }));
```

<div dir="rtl">

## احراز هویت

- **سمت سرور:** کلید مجازی در `Authorization: Bearer …` (یا `x-api-key`، یا `api-key` به سبک Azure).
- **مرورگر:** مرورگر روی WebSocket نمی‌تواند هدر بفرستد. سرور شما با کلیدش یک client secret می‌گیرد و `value` آن (با `ek_` شروع می‌شود) را به صفحه می‌دهد؛ صفحه با subprotocolهای `realtime` و `openai-insecure-api-key.<secret>` وصل می‌شود. خود کلید مجازی هم در این subprotocol کار می‌کند، ولی هرگز آن را به مرورگر نفرستید.

</div>

```bash
curl https://api.example.com/v1/realtime/client_secrets \
  -H "authorization: Bearer $DIROUTER_KEY" -H 'content-type: application/json' \
  -d '{ "expires_after": { "anchor": "created_at", "seconds": 600 },
        "session": { "type": "realtime", "model": "openai/gpt-realtime", "instructions": "Be brief." } }'
```

<div dir="rtl">

client secret را خود گیت‌وی امضا می‌کند (HMAC-SHA256 با کلیدی مشتق از `KEY_PEPPER`)، پس هر replica بدون حالت مشترک آن را می‌پذیرد. شناسهٔ کلید، مدل، انقضا (۱۰ ثانیه تا ۲ ساعت، پیش‌فرض ۱۰ دقیقه؛ endpoint بتا همیشه یک دقیقه) و پیکربندی نشست را در خود دارد؛ این پیکربندی به محض باز شدن نشست با یک `session.update` به provider فرستاده می‌شود (حداکثر ۸ کیلوبایت). هرگز خود کلید مجازی را ندارد، فقط نشست باز می‌کند (هیچ endpoint دیگری آن را نمی‌پذیرد و secret تازه هم با آن ساخته نمی‌شود)، فقط پیش از انقضا، و فقط تا وقتی کلیدش فعال است. وقتی secret مدل دارد، `model` در URL اختیاری است و مدل دیگری پذیرفته نمی‌شود. فهرست IP مجاز کلید هنگام ساخت secret اعمال می‌شود، نه هنگام استفادهٔ مرورگر از آن.

## باز کردن نشست

handshake همان بررسی‌های هر درخواست را انجام می‌دهد و مثل OpenAI با وضعیت HTTP پاسخ می‌دهد:

| بررسی                                                       | رد                                 |
| ----------------------------------------------------------- | ---------------------------------- |
| کلید یا client secret                                       | 401                                |
| `model` نیست، یا مدل قابلیت realtime ندارد                  | 400                                |
| مدل ناشناخته یا غیرمجاز                                     | 404 / 403                          |
| گیت‌وی در حال drain است یا به `REALTIME_MAX_SESSIONS` رسیده | 503                                |
| rate limit (نشست یک درخواست حساب می‌شود)                    | 429                                |
| بودجه از قبل تمام شده                                       | 429 `budget_exceeded`              |
| کیف پول جای نگه داشتن هزینهٔ یک پاسخ را ندارد               | 402 `insufficient_credit`          |
| `maxConcurrency` کلید (هر نشست باز یک جا می‌گیرد)           | 429                                |
| همهٔ مقصدها شکست خوردند                                     | کلاس خطای provider (502، 503، 504) |

مدلی نشست realtime سرو می‌کند که قابلیت `realtime` آن روشن باشد و provider آن از نوع `openai`، `openai-compatible`، `azure-openai` یا `mock` باشد:

| نوع provider                    | بالادست                                                                                                                              | احراز              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| openai، openai-compatible، mock | `{baseUrl}/realtime?model={upstreamModel}`                                                                                           | Bearer             |
| azure-openai                    | `{baseUrl}/openai/v1/realtime?model={deployment}` (بتا: `/openai/realtime?api-version=…&deployment=…`، `options.realtimeApiVersion`) | `api-key` یا Entra |

combo کار می‌کند: مقصدها به ترتیب امتحان می‌شوند (با سیاست retry و کلاس‌های fallback خود combo، circuit breakerها و پراکسی خروجی credential/provider/سراسری) تا یکی ارتقا را بپذیرد. 401 از provider مثل چت credential را غیرفعال می‌کند. **fallback فقط پیش از برقراری نشست است:** سوکت کلاینت فقط بعد از اینکه providerی نشست را پذیرفت ارتقا می‌یابد، و پس از باز شدن، خطای provider نشست را می‌بندد (کد بستنش منتقل می‌شود).

پروتکل بتا را کلاینت انتخاب می‌کند (`OpenAI-Beta: realtime=v1` یا subprotocol `openai-beta.realtime-v1`) و به provider منتقل می‌شود. رویدادها در هر دو جهت بی‌تغییر عبور می‌کنند، جز اینکه رویدادهای `session.*` نام مدل DiRouter را به کلاینت و نام provider را به بالادست نشان می‌دهند.

## اندازه‌گیری و صورت‌حساب

هر `response.done` از روی `usage` آن اندازه‌گیری می‌شود و یک رویداد مصرف می‌سازد (`inboundApi` برابر `openai.realtime` و شناسهٔ درخواست `<session>_<n>`)، پس نشست طولانی همان‌طور که پیش می‌رود حساب می‌شود:

- `usage` توکن‌های متن (و تصویر) را دارد: ورودی، ورودی کش‌شده به‌عنوان cache read، و خروجی.
- `media.audioInputTokens`، `media.audioCachedTokens` و `media.audioOutputTokens` توکن‌های صوتی‌اند و با `audioInputPerMTok` و `audioOutputPerMTok` مدل قیمت می‌خورند (اگر تنظیم نشده باشند، با نرخ متن)؛ صوت کش‌شده با `cacheReadPerMTok`.
- `media.textCostUsd` و `media.audioCostUsd` سهم متن و صوت از `costUsd` رویدادند و `media.sessionId` رویدادهای یک نشست را کنار هم می‌گذارد. همهٔ این‌ها در `request_log.media` ثبت می‌شود.

قیمت‌ها و قابلیت مدل در فرم مدل داشبورد، از طریق `POST/PATCH /orgs/:orgId/models` (`pricing.audioInputPerMTok`، `pricing.audioOutputPerMTok`، `capabilities.realtime`)، یا با همگام‌سازی کاتالوگ تنظیم می‌شوند؛ همگام‌سازی قیمت توکن صوتی LiteLLM را برای مدل‌های با نام `*realtime*` می‌خواند. migration با نام `20261126130500_realtime_audio_prices` دو ستون را اضافه می‌کند.

بعد از هر پاسخ، گیت‌وی هزینه و توکن‌هایش را به بودجه‌ها اضافه می‌کند، توکن‌ها را در rate limit می‌شمارد و از کیف پول کم می‌کند: نشست همیشه رزروی به اندازهٔ یک پاسخ دیگر نگه می‌دارد (۸٬۱۹۲ توکن صوتی ورودی و ۴٬۰۹۶ خروجی با قیمت فروش گران‌ترین مقصد)؛ این رزرو جای خود را به هزینهٔ واقعی پاسخ می‌دهد و باید دوباره جا شود. وقتی بودجه، کیف پول یا limit تمام شود، کلاینت رویداد `error` می‌گیرد که علت را می‌گوید (`budget_exceeded`، `insufficient_credit`، `rate_limit_exceeded`) و نشست با کد 1008 بسته می‌شود.

اندازه‌گیری نمی‌شود: مصرف جداگانهٔ رونویسی ورودی که بعضی providerها روی `conversation.item.input_audio_transcription.completed` گزارش می‌کنند (با مدل دیگری قیمت می‌خورد).

## بستن

نشست هرگز وسط پاسخ قطع نمی‌شود:

| علت                                       | آنچه کلاینت می‌بیند                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| کلاینت می‌بندد                            | پاسخ در جریان در بالادست لغو و حساب می‌شود، بعد سوکت بالادست بسته می‌شود                          |
| رسیدن به `REALTIME_MAX_SESSION_SECONDS`   | پاسخ تمام می‌شود، `error` با `session_expired`، بستن با 1000                                      |
| تمام شدن بودجه، کیف پول یا limit          | پاسخ در جریان لغو و حساب می‌شود، `error` با علت، بستن با 1008                                     |
| رسیدن به مهلت drain (`SHUTDOWN_DRAIN_MS`) | پاسخ تمام می‌شود (یا بعد از ۲ ثانیه لغو می‌شود)، `error` با `gateway_shutting_down`، بستن با 1001 |
| provider می‌بندد                          | همان کد بستن (اگر غیرعادی بود 1011)                                                               |

در drain، `/readyz` برابر 503 می‌شود و نشست تازه با 503 رد می‌شود، ولی نشست‌های باز تا مهلت drain ادامه می‌دهند. هر نشست هر ۳۰ ثانیه در هر دو جهت ping می‌شود تا واسطه‌ها آن را بیکار حساب نکنند. gauge با نام `dirouter_realtime_sessions` نشست‌های باز هر replica را می‌شمارد.

## Traefik

روتر `/v1/realtime` ارتقا را بدون فشرده‌سازی و retry عبور می‌دهد؛ [traefik.fa.md](../traefik.fa.md) را ببینید.

## تست‌ها

- `apps/gateway/src/realtime.test.ts`: SDK رسمی (`openai/realtime/ws`) از پشت یک TLS terminator جلوی گیت‌وی؛ تفکیک اندازه‌گیری؛ client secret (GA و بتا، subprotocolهای مرورگر، جعل، ساخت دوباره، مدل نادرست)؛ ردهای handshake؛ fallback پیش از نشست؛ سقف همزمانی کلید؛ قطع کلاینت وسط پاسخ؛ انقضای نشست؛ سقف replica؛ drain؛ و با `INTEGRATION_VALKEY_URL`، تمام شدن بودجه و کیف پول.
- `apps/mock-provider/src/realtime.test.ts` و `packages/providers/src/realtime.test.ts`.
- `scripts/e2e/sprint-5/30.5.mjs`: نشستی به سبک مرورگر از طریق Traefik با client secret، صورت‌حساب در `request_log`، ردهای handshake و تمام شدن بودجه.

</div>
