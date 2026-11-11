[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Virtual key authentication in the gateway

Code: `apps/gateway/src/auth.ts` · test: `apps/gateway/src/gateway.test.ts` · card 4.3

## Flow

Each request to `/v1/chat/completions`, `/v1/messages` and `/v1/models` goes through these steps before anything else. There is no I/O; everything is read from the in-memory snapshot.

| step                        | behavior                                                                                                                                                      | error (in the format of the API the client called)          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1. key extraction           | `Authorization: Bearer <key>` (OpenAI style) or `x-api-key: <key>` (Anthropic style); Bearer takes priority                                                   | 401 `unauthenticated`, with the message "Missing API key …" |
| 2. HMAC                     | `HMAC-SHA256(key, KEY_PEPPER)`. The key itself is never stored.                                                                                               | —                                                           |
| 3. lookup                   | search in a `Map` by hash, in the current snapshot                                                                                                            | 401 `invalid_api_key`                                       |
| 4. constant-time comparison | `timingSafeEqualHex(hash, key.hash)`. The Map only finds the candidate; the final check is `crypto.timingSafeEqual`.                                          | 401 `invalid_api_key`                                       |
| 5. status                   | `enabled=false` is the same as an invalid key (no extra information leaks)                                                                                    | 401 `invalid_api_key`                                       |
| 6. expiry                   | `expiresAt <= now`                                                                                                                                            | 401 `api_key_expired`, with the message "API key expired"   |
| 7. IP                       | if `ipAllowlist` is not empty, the client IP must be in one of the IPs/CIDRs. IPv4, IPv6 and IPv4-mapped are supported, and each key's `BlockList` is cached. | 403 `forbidden`                                             |
| 8. allowed model            | after resolution: if `allowedModels` is not empty, the requested slug (model, alias or combo) must be in it                                                   | 403 `model_not_allowed`                                     |

## Client IP behind Traefik

Fastify runs with `trustProxy: true` and reads the IP from `X-Forwarded-For`. This is safe because:

- Without `forwardedHeaders.trustedIPs`, Traefik discards the `X-Forwarded-*` headers sent by the client and sets the real IP.
- In production the gateway has no published port, and it is reachable only from the `edge` (Traefik) and `internal` networks.

Spoofing test in compose (2026-11-07): the key `vk_dev_ip` is allowed only from `203.0.113.7`. With spoofed `X-Forwarded-For: 203.0.113.7` and `X-Real-IP` headers, all 30 requests got 403.

> Next suggestion: limit `trustProxy` to the `edge` network range, so that another service inside the network cannot spoof an IP.

## Test keys in dev

`make dev-snapshot` (script `scripts/dev-snapshot.mjs`) creates these keys:

| key                             | behavior                                                   |
| ------------------------------- | ---------------------------------------------------------- |
| `dr-dev-local-0000000000000000` | everything allowed                                         |
| `dr-dev-limited-000000000000`   | only `mock/small` (the others get 403 `model_not_allowed`) |
| `dr-dev-expired-000000000000`   | expired (401 `api_key_expired`)                            |
| `dr-dev-ipallow-000000000000`   | only from IP `203.0.113.7` (in practice always 403)        |

```bash
curl -s http://api.localhost/v1/chat/completions \
  -H 'authorization: Bearer dr-dev-expired-000000000000' -H 'content-type: application/json' \
  -d '{"model":"mock/small","messages":[{"role":"user","content":"hi"}]}'
# 401 {"error":{"message":"API key expired","type":"authentication_error","code":"api_key_expired"}}
```

## Notes

- The error response is always in the format of the input API: `{error:{message,type,param,code}}` for OpenAI, and `{type:"error",error:{type,message}}` for Anthropic.
- Key changes (revocation, expiry) take effect as soon as the new snapshot arrives; there is no separate cache.
- The rate limit and budget of each key are checked after auth (cards 4.5 and 6.3).

---

<a id="persian"></a>

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
