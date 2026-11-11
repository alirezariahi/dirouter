[English](auth.fa.md) · [فارسی](auth.fa.md)

<div dir="rtl">

# احراز هویت کلید مجازی در گیت‌وی

کد: `apps/gateway/src/auth.ts` · تست: `apps/gateway/src/gateway.test.ts` · کارت ۴.۳

## جریان

هر درخواست به `/v1/chat/completions`، `/v1/messages` و `/v1/models` قبل از هر کار دیگری این مراحل را می‌گذراند. هیچ I/O در کار نیست و همه‌چیز از snapshot حافظه خوانده می‌شود.

| مرحله                | رفتار                                                                                                                                                 | خطا (قالب همان API که کلاینت صدا زده)              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| ۱. استخراج کلید      | `Authorization: Bearer <key>` (سبک OpenAI) یا `x-api-key: <key>` (سبک Anthropic)؛ Bearer اولویت دارد                                                  | 401 `unauthenticated`، با پیام «Missing API key …» |
| ۲. HMAC              | `HMAC-SHA256(key, KEY_PEPPER)`. خود کلید هرگز ذخیره نمی‌شود.                                                                                          | —                                                  |
| ۳. lookup            | جستجو در `Map` با کلید hash، روی snapshot فعلی                                                                                                        | 401 `invalid_api_key`                              |
| ۴. مقایسهٔ زمان‌ثابت | `timingSafeEqualHex(hash, key.hash)`. Map فقط کاندیدا را پیدا می‌کند و تأیید نهایی با `crypto.timingSafeEqual` است.                                   | 401 `invalid_api_key`                              |
| ۵. وضعیت             | `enabled=false` با کلید نامعتبر یکی است (اطلاعات اضافه لو نمی‌رود)                                                                                    | 401 `invalid_api_key`                              |
| ۶. انقضا             | `expiresAt <= now`                                                                                                                                    | 401 `api_key_expired`، با پیام «API key expired»   |
| ۷. IP                | اگر `ipAllowlist` خالی نباشد، IP کلاینت باید در یکی از IPها/CIDRها باشد. IPv4، IPv6 و IPv4-mapped پشتیبانی می‌شود و `BlockList` هر کلید cache می‌شود. | 403 `forbidden`                                    |
| ۸. مدل مجاز          | بعد از resolve: اگر `allowedModels` خالی نباشد، slug درخواستی (مدل، alias یا combo) باید در آن باشد                                                   | 403 `model_not_allowed`                            |

## IP کلاینت پشت Traefik

Fastify با `trustProxy: true` اجرا می‌شود و IP را از `X-Forwarded-For` می‌خواند. این کار امن است چون:

- Traefik بدون `forwardedHeaders.trustedIPs`، هدرهای `X-Forwarded-*` رسیده از کلاینت را دور می‌ریزد و IP واقعی را می‌گذارد.
- گیت‌وی در prod هیچ پورت منتشرشده‌ای ندارد و فقط از شبکهٔ `edge` (Traefik) و `internal` قابل دسترسی است.

تست جعل در compose (۲۰۲۶-۱۱-۰۷): کلید `vk_dev_ip` فقط از `203.0.113.7` مجاز است. با هدرهای `X-Forwarded-For: 203.0.113.7` و `X-Real-IP` جعلی هر ۳۰ درخواست پاسخ 403 گرفتند.

> پیشنهاد بعدی: محدود کردن `trustProxy` به رنج شبکهٔ `edge`، تا سرویس دیگری داخل شبکه نتواند IP جعل کند.

## کلیدهای تست در dev

`make dev-snapshot` (اسکریپت `scripts/dev-snapshot.mjs`) این کلیدها را می‌سازد:

| کلید                            | رفتار                                           |
| ------------------------------- | ----------------------------------------------- |
| `dr-dev-local-0000000000000000` | همه‌چیز مجاز                                    |
| `dr-dev-limited-000000000000`   | فقط `mock/small` (بقیه 403 `model_not_allowed`) |
| `dr-dev-expired-000000000000`   | منقضی‌شده (401 `api_key_expired`)               |
| `dr-dev-ipallow-000000000000`   | فقط از IP `203.0.113.7` (عملاً همیشه 403)       |

```bash
curl -s http://api.localhost/v1/chat/completions \
  -H 'authorization: Bearer dr-dev-expired-000000000000' -H 'content-type: application/json' \
  -d '{"model":"mock/small","messages":[{"role":"user","content":"hi"}]}'
# 401 {"error":{"message":"API key expired","type":"authentication_error","code":"api_key_expired"}}
```

## نکات

- پاسخ خطا همیشه در قالب API ورودی است: `{error:{message,type,param,code}}` برای OpenAI و `{type:"error",error:{type,message}}` برای Anthropic.
- تغییر کلیدها (لغو، انقضا) با رسیدن snapshot جدید فوراً اعمال می‌شود و cache جداگانه‌ای در کار نیست.
- rate limit و بودجهٔ هر کلید بعد از auth بررسی می‌شوند (کارت‌های ۴.۵ و ۶.۳).

</div>
