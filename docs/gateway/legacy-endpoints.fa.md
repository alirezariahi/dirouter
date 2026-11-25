[English](legacy-endpoints.md) · [فارسی](legacy-endpoints.fa.md)

<div dir="rtl">

# ویرایش تصویر، ترجمهٔ صوت و completions قدیمی (کارت ۳۰.۴)

endpointهای باقی‌ماندهٔ OpenAI که ابزارها هنوز صدا می‌زنند. این‌ها از همان مسیر هر درخواست دیگر می‌گذرند (کلید مجازی، مسیریابی با fallback، rate limit، بودجه، کیف پول پیش‌پرداخت، سقف همزمانی کلید) و هر فراخوانی یک رویداد مصرف است که با قیمت‌های مدل حساب می‌شود.

| endpoint                      | بدنه      | مدل‌های دارای                                  | حساب به ازای                                          | `inboundApi`          |
| ----------------------------- | --------- | ---------------------------------------------- | ----------------------------------------------------- | --------------------- |
| `POST /v1/images/edits`       | multipart | `images`، provider از نوع openai/سازگار        | هر تصویر تحویلی + توکن‌هایی که gpt-image گزارش می‌کند | `openai.images`       |
| `POST /v1/images/variations`  | multipart | `images`، provider از نوع openai/سازگار        | هر تصویر تحویلی                                       | `openai.images`       |
| `POST /v1/audio/translations` | multipart | `transcription`، provider از نوع openai/سازگار | هر ثانیه صوت (+ توکن‌های گزارش‌شده)                   | `openai.translations` |
| `POST /v1/completions`        | JSON      | هر مدل چت (با نگاشت) یا `completions` (بومی)   | توکن                                                  | `openai.completions`  |

</div>

```ts
import OpenAI, { toFile } from 'openai';
const client = new OpenAI({
  apiKey: process.env.DIROUTER_KEY,
  baseURL: 'https://api.example.com/v1',
});

await client.images.edit({
  model: 'openai/gpt-image-1',
  image: await toFile(png, 'a.png'),
  prompt: 'add a hat',
});
await client.images.createVariation({
  model: 'openai/dall-e-2',
  image: await toFile(png, 'a.png'),
  n: 2,
});
await client.audio.translations.create({
  model: 'openai/whisper-1',
  file: await toFile(wav, 'a.wav'),
});
await client.completions.create({ model: 'openai/gpt-4.1-mini', prompt: 'Say hi', max_tokens: 20 });
```

<div dir="rtl">

## ویرایش و گونه‌سازی تصویر

- `image` یک فایل می‌گیرد، یا چند فایل با نام `image[]` (تا ۱۶ تا، برای مدل‌های gpt-image)؛ `mask` اختیاری است. variation دقیقاً یک تصویر و بدون prompt می‌گیرد.
- `n` از ۱ تا ۱۰، `size` (`WxH` یا `auto`)، `quality`، `background`، `input_fidelity` و `output_format` منتقل می‌شوند.
- `response_format`: `url` یا `b64_json`. اگر نیاید، هر تصویر به همان شکلی برمی‌گردد که provider داده است، مثل OpenAI (gpt-image با base64 و dall-e با URL). درخواست شکل دیگر باعث تبدیل در گیت‌وی می‌شود (URL provider دانلود می‌شود و base64 به data URL تبدیل می‌شود).
- کیف پول پیش از فراخوانی بدترین حالت را رزرو می‌کند: prompt به‌علاوهٔ ۶٬۲۴۰ توکن ورودی برای هر تصویر بارگذاری‌شده، ۶٬۲۴۰ توکن خروجی برای هر تصویر، و قیمت هر تصویر.
- کل بدنهٔ multipart حداکثر ۲۶ مگابایت است.

## ترجمهٔ صوت

گفتار به هر زبانی به متن انگلیسی، با همان قالب‌ها و قیمت‌گذاری رونویسی (`json`، `text`، `srt`، `vtt`، و `verbose_json` با `task: "translate"`). `language` فرستاده نمی‌شود چون زبان مبدأ تشخیص داده می‌شود. از مدل‌های Whisper قالب `verbose_json` خواسته می‌شود تا مدت دقیق باشد؛ وگرنه طول از سرآیند WAV خوانده یا از حجم تخمین زده می‌شود.

## completions قدیمی

مدلی به‌صورت بومی صدا زده می‌شود که قابلیت `completions` آن روشن باشد (برای مدل‌های instruct اوپن‌ای‌آی، deploymentهای instruct در Azure، vLLM و سرورهای دیگری که هنوز این endpoint را دارند) و provider آن از نوع `openai`، `openai-compatible`، `azure-openai` یا `mock` باشد. همهٔ گزینه‌ها منتقل می‌شوند (`echo`، `logprobs`، `suffix`، `best_of`، `n`، چند prompt، prompt توکنی).

هر مدل دیگری (هر نوع provider، از جمله Anthropic و Gemini) با نگاشت درخواست به چت سرو می‌شود: prompt یک پیام کاربر می‌شود؛ `max_tokens` (اگر نیاید ۱۶، مثل خود API)، `temperature`، `top_p`، `stop`، `seed`، penaltyها، `logit_bias` و `user` منتقل می‌شوند؛ متن پاسخ و دلیل پایان به‌عنوان completion برمی‌گردد. آنچه چت نمی‌تواند بیان کند با 400 و نام همان گزینه رد می‌شود، هرگز بی‌صدا حذف نمی‌شود: `echo`، `logprobs`، `suffix`، `best_of` بزرگ‌تر از ۱، `n` بزرگ‌تر از ۱، چند prompt و prompt توکنی. در combo فقط مقصدهایی امتحان می‌شوند که می‌توانند درخواست را سرو کنند.

`stream: true` به شکل server-sent events در قالب chunk مربوط به completion پاسخ داده می‌شود: پاسخ بالادست کامل خوانده می‌شود، بعد هر choice در یک chunk فرستاده می‌شود، سپس اگر `stream_options.include_usage` تنظیم شده باشد chunk مصرف، و `data: [DONE]`. کلاینت‌ها و iterator استریم SDK بدون تغییر کار می‌کنند؛ متن یک‌جا می‌رسد، نه توکن به توکن.

## تست‌ها

- `apps/gateway/src/legacy-endpoints.test.ts`: هر چهار endpoint با SDK رسمی (`openai` نسخهٔ ۷)، با بررسی پاسخ و هزینهٔ رویداد مصرف: ویرایش با یک تصویر، چند تصویر و mask، گونه‌سازی، ترجمه در سه قالب، completions بومی (OpenAI و Azure)، completions نگاشته‌شده (سازگار با OpenAI و Anthropic)، استریم، و ردها.
- `packages/providers/src/media.test.ts`، `packages/providers/src/completions.test.ts` و `apps/mock-provider/src/legacy.test.ts`.
- `scripts/e2e/sprint-5/30.4.mjs`: همین‌ها از طریق Traefik، با بررسی در `request_log`.

</div>
