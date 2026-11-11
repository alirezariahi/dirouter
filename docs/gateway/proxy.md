[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Outbound proxy

Code: `apps/gateway/src/upstream.ts` · test: `apps/gateway/src/outbound-proxy.test.ts` · card 4.10

For reaching providers that are not directly reachable from the server, or for separating the outgoing IP of each key.

## Levels and priority

```
credential.proxy  >  provider.proxy  >  settings.proxy (global)  >  direct
```

- Each credential can have its own proxy. For example, two keys of one provider can go out from two different IPs.
- The value is in the snapshot and takes effect as soon as a new snapshot arrives.
- For each combination of (provider, proxy, connect timeout), a separate dispatcher with keep-alive is created.

## Types

| scheme                         | implementation                                                                                  | DNS                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `http://` and `https://`       | `ProxyAgent` in undici (CONNECT for an https destination)                                       | on the proxy side                                          |
| `socks5://user:pass@host:1080` | custom undici connector with the `socks` library; the destination TLS runs over the same socket | **local**; the hostname is resolved in the gateway         |
| `socks5h://…`                  | same                                                                                            | **on the proxy side**; when local DNS is filtered or wrong |

The username and password in the URL are set with `encodeURIComponent`. SOCKS5 authentication is user/pass, per RFC 1929.

## Errors and fallback

- If the proxy is unavailable, refuses the connection, or authentication fails: the error gets class `connection` (retryable and fallbackAllowed). So a retry happens, and then the next candidate is tried. Example: the combo `dev-proxy` in dev.
- An unresponsive handshake: `connectMs` (default 5 seconds) and class `timeout`.
- **The proxy password is never in logs or responses.** `maskProxyUrl` replaces it with `***`. The network error message sent to the client is only generic text ("Could not connect to the upstream provider"), because it may contain an internal address. Details appear only in the server log (`request failed upstream`).

## Check in compose (2026-11-07)

```bash
make dev-snapshot
docker compose -f compose.yaml -f compose.dev.yaml exec -d gateway \
  sh -c 'node /repo/scripts/dev/socks5-proxy.mjs 1080 > /tmp/socks.log 2>&1'
```

| model            | configuration                                 | result                                                                                                                       |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `mock/socks`     | credential with `socks5h://127.0.0.1:1080`    | 200. The proxy log showed `socks5 connect mock-provider:8090`, meaning DNS was on the proxy side.                            |
| `dev-proxy`      | provider with a dead proxy, then `mock/socks` | 200 with `x-dirouter-attempts: 3`: two attempts on the dead proxy, then fallback                                             |
| `mock/deadproxy` | only the dead proxy                           | 502 with a generic message. Server log: `socks5://user:***@127.0.0.1:1`. Number of log lines that contained the password: 0. |

Automated tests:

- SOCKS5 without authentication, and with user/pass.
- `socks5h` and `socks5` (DNS on the proxy side, and local).
- A wrong password.
- HTTP proxy.
- A dead proxy and password masking.
- Credential priority over provider in the gateway.
- Combo fallback from a provider with a broken proxy.

---

<a id="persian"></a>

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
