[English](moderations.md) · [فارسی](moderations.fa.md)

# endpoint نظارت محتوا: Moderations (کارت ۳۰.۳)

`POST /v1/moderations` همان API نظارت محتوای OpenAI است، پس SDKهای رسمی OpenAI بدون تغییر کار می‌کنند (`client.moderations.create(...)`). روی همان کدی اجرا می‌شود که guardrail نوع `moderation` (کارت ۲۳.۲) دارد: مدل با کلید فراخواننده به provider پیکربندی‌شده مسیریابی می‌شود، با fallback، محدودیت نرخ، بودجه، کیف پول و رویداد usage (`inboundApi: "openai.moderations"`).

```python
from openai import OpenAI

client = OpenAI(base_url="https://api.example.com/v1", api_key=DIROUTER_KEY)
result = client.moderations.create(input="I want to hurt someone")
print(result.results[0].flagged, result.results[0].categories)
```

## درخواست

| فیلد    | مقدار                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model` | نام مدل، alias یا combo در DiRouter. اگر نباشد `omni-moderation-latest`، پیش‌فرض OpenAI، که باید به‌عنوان مدل (یا alias) در سازمان وجود داشته باشد.                                                                                |
| `input` | یک رشته؛ آرایه‌ای از رشته‌ها (برای هر کدام یک نتیجه)؛ یا آرایه‌ای از بخش‌های `{"type": "text", "text": …}` و `{"type": "image_url", "image_url": {"url": …}}` که با هم به‌عنوان یک ورودی سنجیده می‌شوند (مدل‌های omni moderation). |

provider مدل باید `/moderations` سازگار با OpenAI داشته باشد (نوع‌های OpenAI و OpenAI-compatible؛ Azure OpenAI ندارد). بخش‌های تصویر همان‌طور که هستند به provider داده می‌شوند؛ providerی که نتواند آن‌ها را بخواند خطا می‌دهد و هدف بعدی امتحان می‌شود.

## پاسخ

```json
{
  "id": "modr-…",
  "model": "omni-moderation-latest",
  "results": [
    {
      "flagged": true,
      "categories": { "violence": true, "hate": false },
      "category_scores": { "violence": 0.91, "hate": 0.01 },
      "category_applied_input_types": { "violence": ["text"], "hate": ["text"] }
    }
  ]
}
```

`category_applied_input_types` وقتی برمی‌گردد که provider آن را گزارش کند. هدرهای `x-dirouter-model` و `x-dirouter-provider` نشان می‌دهند درخواست به کجا رفته است.

## قیمت

endpointهای moderation مصرف گزارش نمی‌کنند: ورودی تخمین زده می‌شود (یک‌چهارم کاراکترها به توکن، ۸۵ توکن برای هر تصویر) و با قیمت ورودی مدل حساب می‌شود، که برای مدل‌های رایگان moderation در OpenAI معمولاً صفر است.
