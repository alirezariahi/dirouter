[English](sagemaker.md) · [فارسی](sagemaker.fa.md)

<div dir="rtl">

# Amazon SageMaker

> کارت ۳۱.۶.

| فیلد            | مقدار                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                                                                                                        |
| options.preset  | `sagemaker`                                                                                                                                                |
| baseUrl پیش‌فرض | `https://runtime.sagemaker.<region>.amazonaws.com`                                                                                                         |
| Options         | `region` (وگرنه از `baseUrl`)، `containerModel` (مقدار `model` که کانتینر می‌خواهد، مثلاً `tgi`)، `controlUrl` (تغییر نشانی ListEndpoints)، `sessionToken` |
| Chat            | `POST {baseUrl}/endpoints/{endpoint}/invocations`؛ مدل نام endpoint است و کانتینر Messages API به شکل OpenAI دارد (TGI، LMI، vLLM)                         |
| Model discovery | `SageMaker.ListEndpoints` (endpointهای InService)، POST امضاشده به `https://api.sagemaker.{region}.amazonaws.com/`                                         |
| کلید API        | `ACCESS_KEY_ID:SECRET_ACCESS_KEY` (و اختیاری `:SESSION_TOKEN`) با امضای SigV4 برای سرویس `sagemaker`، مثل Bedrock                                          |

stream (`invocations-response-stream`) هنوز پشتیبانی نمی‌شود: درخواست stream با 400 روشن رد می‌شود.

تست اتصال در صفحهٔ providerها همان درخواست کشف مدل را می‌فرستد. تست قراردادی: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`، روی mock-provider). اجرای واقعی در برابر API خود Amazon SageMaker به حساب کاربری نیاز دارد و جزو تست‌های خودکار نبود.

</div>
