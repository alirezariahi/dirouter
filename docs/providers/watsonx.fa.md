[English](watsonx.md) · [فارسی](watsonx.fa.md)

<div dir="rtl">

# IBM watsonx.ai

> کارت ۳۱.۶.

| فیلد            | مقدار                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                                                                                                                                 |
| options.preset  | `watsonx`                                                                                                                                                                           |
| baseUrl پیش‌فرض | `https://us-south.ml.cloud.ibm.com`                                                                                                                                                 |
| Options         | `projectId` (یا `spaceId`) الزامی؛ `version` (پیش‌فرض `2024-10-08`)                                                                                                                 |
| Chat            | `POST {baseUrl}/ml/v1/text/chat?version=…`، stream روی `/ml/v1/text/chat_stream`؛ پیام و ابزار به شکل OpenAI با `model_id` و `project_id`                                           |
| Model discovery | `GET {baseUrl}/ml/v1/foundation_model_specs?filters=function_text_chat`                                                                                                             |
| کلید API        | کلید API در IBM Cloud؛ گیت‌وی آن را با توکن IAM عوض می‌کند (`https://iam.cloud.ibm.com/identity/token`، با `options.tokenUrl` قابل تغییر) و توکن را تا کمی پیش از انقضا نگه می‌دارد |

منطقه‌های دیگر: `https://eu-de.ml.cloud.ibm.com`، `https://jp-tok.ml.cloud.ibm.com`، … `projectId` را از API تنظیم کنید: `PATCH /api/v1/orgs/{org}/providers/{id}` با `{"options": {"preset": "watsonx", "projectId": "…"}}`.

تست اتصال در صفحهٔ providerها همان درخواست کشف مدل را می‌فرستد. تست قراردادی: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`، روی mock-provider). اجرای واقعی در برابر API خود IBM watsonx.ai به حساب کاربری نیاز دارد و جزو تست‌های خودکار نبود.

</div>
