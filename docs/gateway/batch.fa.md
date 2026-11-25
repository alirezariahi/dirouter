[English](batch.md) · [فارسی](batch.fa.md)

# Files API و Batch API (کارت ۳۰.۱)

DiRouter همان Files API و Batch API در OpenAI را ارائه می‌دهد. batch روی API بومی batch خود provider و با قیمت batch همان provider اجرا می‌شود، با همان کلید مجازی، بودجه، کیف پول و حسابداری usage که هر درخواست دیگری دارد. SDKهای رسمی OpenAI فقط با تغییر `baseURL` کار می‌کنند.

| Endpoint                       | کار                                                                        |
| ------------------------------ | -------------------------------------------------------------------------- |
| `POST /v1/files`               | بارگذاری (`multipart/form-data`: `file`، `purpose`، `expires_after`)       |
| `GET /v1/files`                | فهرست (`purpose`، `limit` تا ۱۰٬۰۰۰، `after`، `order`)                     |
| `GET /v1/files/{id}`           | شیء فایل                                                                   |
| `GET /v1/files/{id}/content`   | بایت‌های فایل                                                              |
| `DELETE /v1/files/{id}`        | حذف بایت‌ها و رکورد                                                        |
| `POST /v1/batches`             | ساخت (`input_file_id`، `endpoint`، `completion_window: "24h"`، `metadata`) |
| `GET /v1/batches/{id}`         | شیء batch؛ وضعیت را هم از provider تازه می‌کند                             |
| `POST /v1/batches/{id}/cancel` | لغو نزد provider                                                           |
| `GET /v1/batches`              | فهرست (`limit` تا ۱۰۰، `after`)                                            |

## نمونه

```python
from openai import OpenAI

client = OpenAI(base_url="https://api.example.com/v1", api_key=DIROUTER_KEY)
batch_input = client.files.create(file=open("requests.jsonl", "rb"), purpose="batch")
batch = client.batches.create(
    input_file_id=batch_input.id,
    endpoint="/v1/chat/completions",
    completion_window="24h",
)
# … بعداً
batch = client.batches.retrieve(batch.id)
if batch.status == "completed":
    print(client.files.content(batch.output_file_id).text)
```

هر خط فایل ورودی به شکل `{"custom_id": "…", "method": "POST", "url": "/v1/chat/completions", "body": {…}}` است. همهٔ خط‌ها باید همان `endpoint` batch را صدا بزنند و از **یک مدل** استفاده کنند (نام مدل، alias یا combo در DiRouter که کلید اجازه‌اش را دارد)؛ `custom_id` باید یکتا باشد؛ حداکثر ۵۰٬۰۰۰ خط. stream در batch مجاز نیست.

## کدام provider batch را اجرا می‌کند

مدل مثل یک درخواست عادی با کلید فراخواننده مسیریابی می‌شود؛ اولین هدفی که provider آن برای این endpoint API batch دارد کل batch را اجرا می‌کند:

| نوع provider                                              | Endpointها                                                                   | روش                                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `openai` (و `openai-compatible` با `options.batch: true`) | `/v1/chat/completions`، `/v1/embeddings`، `/v1/responses`، `/v1/completions` | ورودی با `purpose=batch` بارگذاری می‌شود و نام مدل به مدل upstream بازنویسی می‌شود، سپس `POST /batches`. فایل خروجی و خطا دانلود می‌شوند. |
| `anthropic`                                               | `/v1/chat/completions`                                                       | هر خط به پارامترهای Messages ترجمه و به `POST /v1/messages/batches` فرستاده می‌شود؛ نتایج به chat completion برگردانده می‌شوند.           |

هدفی که provider آن batch را با خطای سرور یا محدودیت نرخ رد کند کنار گذاشته می‌شود و هدف بعدی امتحان می‌شود؛ خطای 400 به مشتری برمی‌گردد. مدلی که هیچ هدف دارای batch ندارد پاسخ 400 می‌گیرد. batch پس از شروع روی همان provider می‌ماند و جابه‌جا نمی‌شود.

وقتی batch تمام شد، DiRouter نتایج را دانلود و به‌عنوان فایل‌های تازهٔ سازمان ذخیره می‌کند (`purpose: "batch_output"`): `output_file_id` خط‌های موفق و `error_file_id` خط‌های ناموفق را در قالب خروجی batch در OpenAI دارد (`{id, custom_id, response: {status_code, request_id, body}, error}`). `model` در بدنهٔ هر پاسخ همان نامی است که مشتری خواسته بود.

## قیمت، بودجه و کیف پول

- **هنگام ساخت** محدودیت نرخ کلید یک درخواست حساب می‌کند، بودجه‌ها باید جا داشته باشند، و کیف پول پیش‌پرداخت بدترین حالت batch را رزرو می‌کند (تخمین ورودی هر خط به‌علاوهٔ `max_tokens` آن، یا سقف خروجی مدل، یا ۴٬۰۹۶ توکن) با قیمت batch گران‌ترین هدف. این رزرو ۲۵ ساعت می‌ماند.
- **هنگام پایان** یک رویداد usage (`inboundApi: "openai.batches"`، `requestId` = شناسهٔ batch) مجموع usage همهٔ خط‌های موفق را دارد. هزینه‌اش هزینهٔ عادی توکن ضرب در `1 − batchDiscount` است (از کاتالوگ یا تنظیمات قیمت مدل، کارت ۲۷.۵)؛ قیمت فروش (ضریب‌ها، گروه مشتری) هم به همین شکل تخفیف می‌گیرد. رزرو کیف پول به همین مبلغ تبدیل می‌شود و worker آن را مثل هر درخواستی در ledger ثبت می‌کند.
- batchی که پیش از موفقیت هر خطی شکست بخورد یا لغو شود یک رویداد خطا با هزینهٔ صفر ثبت و رزرو را آزاد می‌کند. batch لغوشده یا منقضی‌شده برای خط‌هایی که اجرا شده‌اند هزینه دارد.

## ایزوله‌سازی و نگهداری

- فایل و batch متعلق به سازمان کلیدی است که آن را ساخته. همهٔ کلیدهای آن سازمان می‌توانند از آن استفاده کنند؛ کلید سازمان دیگر 404 می‌گیرد، همان پاسخی که برای شناسهٔ ناموجود داده می‌شود، و هرگز آن را در فهرست نمی‌بیند.
- بایت‌ها روی volume محلی یا باکت سازگار با S3 نگه داشته می‌شوند (`FILES_STORAGE`، [مرجع متغیرهای محیطی](../env-reference.fa.md))، زیر مسیر `<سازمان>/<شناسهٔ فایل>`. حجم بارگذاری با `FILES_MAX_BYTES` محدود است (پیش‌فرض ۱۰۰ مگابایت).
- فایل‌ها پس از `FILES_RETENTION_DAYS` (پیش‌فرض ۳۰) حذف می‌شوند، یا زودتر اگر بارگذاری `expires_after` داشته باشد (`anchor: created_at`، ۳٬۶۰۰ تا ۲٬۵۹۲٬۰۰۰ ثانیه). رکورد batch تا ۳۱ روز نگه داشته می‌شود.

## نحوهٔ اجرا

رکوردها در Valkey هستند و یک job poller در هر replica گیت‌وی batchهای در حال اجرا را هر `JOBS_POLL_INTERVAL_MS` (پیش‌فرض ۱۵ ثانیه) نزد provider دنبال می‌کند؛ دریافت batch هم آن را تازه می‌کند. هر قدم قفل می‌شود، پس چند replica هرگز یک batch را دو بار تمام نمی‌کنند. این طراحی در [ADR-0007](../adr/0007-job-state-in-valkey.fa.md) ثبت شده است.

بدون Valkey (یک گره محلی) رکوردها در حافظه‌اند و با راه‌اندازی دوباره از بین می‌روند.

## پشتیبانی‌نشده

- batch روی providerهایی غیر از نوع OpenAI و Anthropic (کارهای batch در Gemini، Bedrock و Vertex از storage ابری خودشان می‌خوانند).
- انتقال batch در حال اجرا به هدف دیگر وقتی provider آن از کار بیفتد.
- API بارگذاری چندبخشی `/v1/uploads` در OpenAI؛ فایل‌ها در یک درخواست بارگذاری می‌شوند.
