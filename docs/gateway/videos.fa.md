[English](videos.md) · [فارسی](videos.fa.md)

# تولید ویدیو و تسک‌های async (کارت ۳۰.۶)

تولید ویدیو چند دقیقه طول می‌کشد، پس یک تسک async است: مشتری آن را شروع می‌کند، وضعیتش را دنبال می‌کند و وقتی تمام شد نتیجه را دانلود می‌کند. DiRouter همان Videos API در OpenAI را ارائه می‌دهد، پس SDKهای رسمی OpenAI فقط با تغییر `baseURL` کار می‌کنند، و تسک را روی هر providerی که آداپتر ویدیو دارد اجرا می‌کند. همان کلید، محدودیت نرخ، بودجه، کیف پول و حسابداری usage درخواست‌های دیگر اعمال می‌شود و فقط تسکی که کامل شود هزینه دارد.

| Endpoint                      | کار                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `POST /v1/videos`             | شروع تسک: `model` (پیش‌فرض `sora-2`)، `prompt`، `seconds`، `size`، `webhook_url`        |
| `GET /v1/videos/{id}`         | وضعیت و پیشرفت؛ وضعیت را از provider هم تازه می‌کند                                     |
| `GET /v1/videos/{id}/content` | ویدیوی تمام‌شده (`variant`: `video`، `thumbnail`، `spritesheet`)                        |
| `POST /v1/videos/{id}/cancel` | توقف تسک در حال اجرا (افزونهٔ DiRouter)؛ با وضعیت `failed` و کد `cancelled` تمام می‌شود |
| `DELETE /v1/videos/{id}`      | لغو در صورت اجرا، حذف نزد provider و فراموش کردن تسک                                    |
| `GET /v1/videos`              | فهرست (`limit` تا ۱۰۰، `after`)                                                         |
| `GET /v1/webhooks/secret`     | راز امضای webhook سازمان (افزونهٔ DiRouter)                                             |

```python
from openai import OpenAI

client = OpenAI(base_url="https://api.example.com/v1", api_key=DIROUTER_KEY)
video = client.videos.create_and_poll(model="sora-2", prompt="A red fox in the snow", seconds="8")
if video.status == "completed":
    client.videos.download_content(video.id).write_to_file("fox.mp4")
```

شیء ویدیو `status` (`queued`، `in_progress`، `completed`، `failed`)، `progress` (۰ تا ۱۰۰)، `seconds`، `size` و برای تسک ناموفق `error: {code, message}` دارد.

## Providerها

مدلی برای ویدیو عرضه می‌شود که قابلیت **تولید ویدیو** (`capabilities.video`) آن روشن باشد و نوع provider آن آداپتر ویدیو داشته باشد. مسیریابی و fallback هنگام شروع مثل درخواست‌های دیگر است: هدفی که provider آن با خطای سرور یا محدودیت نرخ شکست بخورد کنار گذاشته می‌شود؛ تسک در حال اجرا روی provider خودش می‌ماند.

| نوع provider                          | API بالادست                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai`، `openai-compatible`، `mock` | قالب Videos در OpenAI (`/videos`): وضعیت، محتوا با همهٔ variantها، لغو به‌صورت حذف. OpenAI در 2026-09-24 خود Sora API را خاموش کرد؛ این آداپتر برای providerها و گیت‌وی‌هایی است که هنوز همین قالب را ارائه می‌دهند.                                         |
| `gemini`                              | Google Veo روی Gemini API: `models/<model>:predictLongRunning` و سپس دنبال کردن operation تا `done`؛ ویدیو از file URI برگشتی دانلود می‌شود (کلید فقط به origin خود provider فرستاده می‌شود). لغو، `:cancel` همان operation را صدا می‌زند. thumbnail ندارد.  |
| `fal`                                 | صف fal: درخواست به `https://queue.fal.run/<model>` (یا `options.queueBaseUrl` در provider) می‌رود؛ وضعیت، نتیجه و لغو از URLهایی که fal برمی‌گرداند و فقط روی origin همان صف استفاده می‌شوند. ویدیو بدون کلید از CDN خود fal دانلود می‌شود. thumbnail ندارد. |

`seconds` در قالب OpenAI پیش‌فرض ۴، در Veo پیش‌فرض ۸ و در fal پیش‌فرض ۵ است؛ `size` (`1280x720`، `720x1280` و …) در Veo به `aspectRatio` و در fal به `aspect_ratio` تبدیل می‌شود.

## قیمت

قیمت **صوت یا ویدیو / ثانیه** (`perSecondUsd`) مدل را تنظیم کنید و اگر provider برای هر ویدیو هزینهٔ ثابت می‌گیرد **هر درخواست** (`perRequestUsd`) را هم. تسک کامل‌شده یک رویداد usage ثبت می‌کند (`inboundApi: "openai.videos"`، `requestId` = شناسهٔ ویدیو) با `media: {seconds, requests: 1}`؛ ثانیه‌ها طولی است که provider گزارش می‌کند یا طول درخواستی. قیمت فروش (ضریب و گروه مشتری) مثل هر درخواستی اعمال می‌شود.

تسکی که شکست بخورد یا لغو شود یک رویداد خطا با هزینهٔ صفر ثبت می‌کند. هنگام شروع، کیف پول بدترین حالت تسک (ثانیه‌های درخواستی × قیمت + قیمت هر درخواست روی گران‌ترین هدف) را تا شش ساعت رزرو می‌کند؛ با پایان تسک رزرو به هزینهٔ واقعی تبدیل یا آزاد می‌شود.

## Webhook

هنگام شروع تسک (یا batch، ببینید [Batch API](batch.fa.md)) `webhook_url` بدهید تا DiRouter در پایان آن رویدادی در قالب رویدادهای webhook در OpenAI بفرستد:

```json
{
  "id": "evt_…",
  "object": "event",
  "created_at": 1764072000,
  "type": "video.completed",
  "data": { "id": "video_…" }
}
```

نوع‌ها: `video.completed`، `video.failed`، `batch.completed`، `batch.failed`، `batch.cancelled`، `batch.expired`.

- **امضا**: [Standard Webhooks](https://www.standardwebhooks.com/)، همان روشی که OpenAI به کار می‌برد. هدرهای `webhook-id`، `webhook-timestamp` و `webhook-signature: v1,<base64 HMAC-SHA256 روی "<id>.<timestamp>.<body>">`. راز (`whsec_…`) متعلق به سازمان است: با هر کلید آن از `GET /v1/webhooks/secret` خوانده می‌شود. از `MASTER_KEY` مشتق می‌شود، پس چرخش `MASTER_KEY` آن را هم عوض می‌کند. SDK در OpenAI آن را بررسی می‌کند: `client.webhooks.unwrap(body, headers, secret)`.
- **تلاش دوباره**: دست‌کم یک بار. خطای شبکه، timeout (۱۰ ثانیه) یا هر پاسخ غیر 2xx پس از ۵ ثانیه، ۳۰ ثانیه، ۲ دقیقه، ۱۰ دقیقه، ۳۰ دقیقه و ۱ ساعت دوباره فرستاده می‌شود؛ سپس رویداد کنار گذاشته و در لاگ ثبت می‌شود. redirect دنبال نمی‌شود. برای نادیده گرفتن تکراری‌ها از `webhook-id` استفاده کنید.
- **SSRF**: URL باید `http` یا `https` و بدون اطلاعات ورود باشد؛ در production webhook سازمان‌های مشتری باید `https` باشد و به نشانی عمومی برسد، که هنگام اتصال دوباره بررسی می‌شود.

## نحوهٔ اجرا

تسک‌ها رکوردهایی در Valkey هستند که job poller گیت‌وی هر `JOBS_POLL_INTERVAL_MS` دنبالشان می‌کند، مثل batchها ([ADR-0007](../adr/0007-job-state-in-valkey.fa.md))؛ ارسال‌های webhook هم رکوردهایی در همان store هستند، پس تلاش دوباره پس از راه‌اندازی مجدد هم ادامه پیدا می‌کند. رکورد تسک هفت روز نگه داشته می‌شود؛ ممکن است provider خود ویدیو را زودتر حذف کند (OpenAI محتوا را مدت محدودی نگه می‌دارد).

## پشتیبانی‌نشده

- `input_reference` (ورودی تصویر یا ویدیو)، remix، edit و extend.
- providerهای ویدیوی دیگر (Runway، Luma، Veo روی Vertex AI) فعلاً؛ با افزونهٔ provider یا آداپتر تازه در `packages/providers/src/video.ts` اضافه می‌شوند.
