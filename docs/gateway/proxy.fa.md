[English](proxy.fa.md) · [فارسی](proxy.fa.md)

<div dir="rtl">

# پروکسی خروجی

کد: `apps/gateway/src/upstream.ts` · تست: `apps/gateway/src/outbound-proxy.test.ts` · کارت ۴.۱۰

برای دسترسی به providerهایی که از سرور مستقیم در دسترس نیستند، یا برای جدا کردن IP خروجی هر کلید.

## سطوح و اولویت

```
credential.proxy  >  provider.proxy  >  settings.proxy (سراسری)  >  مستقیم
```

- هر credential می‌تواند پروکسی جدا داشته باشد. مثلاً دو کلید یک provider از دو IP خروجی متفاوت بروند.
- مقدار در snapshot است و با رسیدن snapshot جدید فوراً اعمال می‌شود.
- برای هر ترکیب (provider، پروکسی، connect timeout) یک dispatcher جدا با keep-alive ساخته می‌شود.

## انواع

| scheme                         | پیاده‌سازی                                                           | DNS                                               |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------- |
| `http://` و `https://`         | `ProxyAgent` در undici (CONNECT برای مقصد https)                     | سمت پروکسی                                        |
| `socks5://user:pass@host:1080` | connector سفارشی undici با کتابخانهٔ `socks`؛ TLS مقصد روی همان سوکت | **محلی**؛ نام میزبان در گیت‌وی resolve می‌شود     |
| `socks5h://…`                  | همان                                                                 | **سمت پروکسی**؛ وقتی DNS محلی فیلتر یا نادرست است |

نام کاربری و رمز در URL با `encodeURIComponent` قرار می‌گیرند. احراز هویت SOCKS5 به روش user/pass طبق RFC 1929 است.

## خطا و فال‌بک

- پروکسی در دسترس نباشد، اتصال را رد کند یا احراز هویت شکست بخورد: خطا کلاس `connection` می‌گیرد (retryable و fallbackAllowed). پس retry انجام می‌شود و بعد کاندیدای بعدی امتحان می‌شود. نمونه: combo `dev-proxy` در dev.
- handshake بی‌پاسخ: `connectMs` (پیش‌فرض ۵ ثانیه) و کلاس `timeout`.
- **رمز پروکسی هرگز در لاگ یا پاسخ نیست.** `maskProxyUrl` آن را به `***` تبدیل می‌کند. پیام خطای شبکه به کلاینت هم فقط متن عمومی است («Could not connect to the upstream provider»)، چون ممکن است آدرس داخلی داشته باشد. جزئیات فقط در لاگ سرور (`request failed upstream`) می‌آید.

## بررسی در compose (۲۰۲۶-۱۱-۰۷)

```bash
make dev-snapshot
docker compose -f compose.yaml -f compose.dev.yaml exec -d gateway \
  sh -c 'node /repo/scripts/dev/socks5-proxy.mjs 1080 > /tmp/socks.log 2>&1'
```

| مدل              | پیکربندی                                  | نتیجه                                                                                               |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `mock/socks`     | credential با `socks5h://127.0.0.1:1080`  | 200. لاگ پروکسی `socks5 connect mock-provider:8090` را نشان داد، یعنی DNS سمت پروکسی بود.           |
| `dev-proxy`      | provider با پروکسی مرده، سپس `mock/socks` | 200 با `x-dirouter-attempts: 3`: دو تلاش روی پروکسی مرده، بعد فال‌بک                                |
| `mock/deadproxy` | فقط پروکسی مرده                           | 502 با پیام عمومی. لاگ سرور: `socks5://user:***@127.0.0.1:1`. تعداد خط‌های لاگ که رمز را داشتند: ۰. |

تست‌های خودکار:

- SOCKS5 بدون احراز هویت و با user/pass.
- `socks5h` و `socks5` (DNS سمت پروکسی و محلی).
- رمز اشتباه.
- HTTP proxy.
- پروکسی مرده و ماسک رمز.
- اولویت credential بر provider در گیت‌وی.
- فال‌بک combo از provider با پروکسی خراب.

</div>
