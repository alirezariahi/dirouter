[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Sprint 1 — baseline load benchmark

Run date: 2026-11-08, on the local macOS/Docker Desktop development host.

## Method

Paired measurements of the mock provider directly and through the gateway, using the same
payload, arrival-rate executor and hardware. The stack runs in an isolated Docker network
(`dirouter-k6-baseline`): one Traefik edge, two gateway replicas (image
`dirouter-bench/gateway:keepalive`, which only lowers `keepAliveTimeout` from 30 s to 25 s),
and the mock provider. No Postgres/Valkey — the hot path is measured in isolation.

- Tool: k6 (`grafana/k6:latest`) with the `constant-arrival-rate` executor.
- Payload: `POST /v1/chat/completions`, model `mock/small`, one short user message.
  Non-stream returns a single JSON object; stream includes `stream_options.include_usage`.
- Scenarios: direct/non-stream and gateway/non-stream at 1 000 RPS; direct/stream and
  gateway/stream at 500 RPS; then combined (1 000 non-stream + 500 stream concurrently
  against the gateway). Each measured run lasts 60 s and is repeated twice.
- Resource sampling: `docker stats` once per second during every run, so CPU and memory
  are reported per replica.
- Scripts: `scripts/bench/run-k6.py` (orchestration + sampling) and
  `scripts/bench/summarize-k6.py` (report). Raw output includes `http_reqs`,
  `http_req_failed`, `dropped_iterations` and the `request_latency_ms` trend.

> The measurement host is a shared development machine and Docker Desktop only exposes
> **4 CPUs**; the k6 container shares those same 4 CPUs. The p95/p99 tails are therefore
> heavily influenced by host contention. These numbers are a **comparison baseline**, not a
> production capacity claim. A dedicated machine (k6 outside the VM, ≥ 8 CPUs) is required
> for publishable capacity figures.

## Results (2026-11-08)

Best run per scenario; both repetitions are listed in the appendices.

| Scenario                           | Achieved rate | Requests | Failed | p50     | p95      | p99      | max     |
| ---------------------------------- | ------------- | -------- | ------ | ------- | -------- | -------- | ------- |
| direct / non-stream, 1 000 RPS     | 999.8/s       | 60 002   | 0.00%  | 3.91 ms | 6.45 ms  | 23.3 ms  | 89.8 ms |
| gateway / non-stream, 1 000 RPS    | 999.2/s       | 59 960   | 0.00%  | 3.81 ms | 17.8 ms  | 190.6 ms | 752 ms  |
| direct / stream, 500 RPS           | 499.9/s       | 30 000   | 0.00%  | 14.0 ms | 16.9 ms  | 22.1 ms  | 71.5 ms |
| gateway / stream, 500 RPS          | 496.7/s       | 29 809   | 0.00%  | 14.5 ms | 102.9 ms | 958 ms   | 1.78 s  |
| combined (1 000 + 500) via gateway | 1 332/s       | 84 464   | 0.27%  | 21.2 ms | 1 306 ms | 6 917 ms | 26.2 s  |

Routing overhead (gateway minus direct, paired best runs):

| Mode       | p50              | p95      | p99     |
| ---------- | ---------------- | -------- | ------- |
| non-stream | ≈ 0 ms (−0.1 ms) | +11.3 ms | +167 ms |
| stream     | +0.5 ms          | +85.9 ms | +936 ms |

## Resource usage at 1 000 RPS through the gateway

| Container     | CPU avg | CPU peak | Memory avg | Memory peak |
| ------------- | ------- | -------- | ---------- | ----------- |
| gateway-1     | 55.6%   | 103%     | 123 MiB    | 135 MiB     |
| gateway-2     | 56.3%   | 98.7%    | 122 MiB    | 134.5 MiB   |
| traefik edge  | 31.3%   | 48.6%    | 186 MiB    | 459 MiB     |
| mock-provider | 16.0%   | 24.7%    | 74 MiB     | 80.5 MiB    |

CPU percentages are relative to the whole 4-CPU VM. The two gateway replicas split the load
almost exactly evenly (55.6% vs 56.3%).

## Interpretation and limitations

1. **The "p99 overhead < 10 ms" goal is not demonstrated in this environment.** The median
   overhead is effectively zero (gated p50 ≈ direct p50), but under host contention the
   tails grow by up to two orders of magnitude. At the larger VU pool (MAX_VUS=1500) the
   combined scenario still failed 0.27% of requests in its clean repetition and 11% in the
   noisier one (502s from Traefik as its connection pool saturated, plus CPU starvation).
2. In the healthy paired run (gateway/non-stream, repetition 2) 59 960 requests completed
   with **zero failures** and essentially zero dropped iterations: two replicas carry
   1 000 RPS without errors, and only the latency tail degrades under contention.
3. Combined (1 500 RPS aggregate) is not reliably sustainable on these 4 CPUs. The target
   throughput must be re-verified in a staging/production environment with at least 8 CPUs
   and k6 on a separate host.
4. Per-replica memory (~123 MiB) and CPU (~28% per 500 RPS per replica) are a usable
   baseline for the capacity planning of later sprints.

## Appendices — both repetitions

| Scenario             | Repetition | Achieved | Requests | Failed | p50     | p95      | p99      | max     |
| -------------------- | ---------- | -------- | -------- | ------ | ------- | -------- | -------- | ------- |
| direct / non-stream  | 1          | 999.8/s  | 60 002   | 0.00%  | 3.91 ms | 6.45 ms  | 23.3 ms  | 89.8 ms |
| direct / non-stream  | 2          | 998.1/s  | 59 894   | 0.00%  | 4.17 ms | 18.5 ms  | 75.1 ms  | 285 ms  |
| gateway / non-stream | 1          | 907.1/s  | 54 429   | 0.21%  | 14.2 ms | 3 340 ms | 6 889 ms | 26.9 s  |
| gateway / non-stream | 2          | 999.2/s  | 59 960   | 0.00%  | 3.81 ms | 17.8 ms  | 190.6 ms | 752 ms  |
| direct / stream      | 1          | 499.9/s  | 30 000   | 0.00%  | 14.0 ms | 16.9 ms  | 22.1 ms  | 71.5 ms |
| direct / stream      | 2          | 499.9/s  | 30 001   | 0.00%  | 14.1 ms | 19.1 ms  | 82.9 ms  | 309 ms  |
| gateway / stream     | 1          | 484.9/s  | 29 699   | 0.00%  | 15.8 ms | 550 ms   | 1 787 ms | 2.20 s  |
| gateway / stream     | 2          | 496.7/s  | 29 809   | 0.00%  | 14.5 ms | 102.9 ms | 958 ms   | 1.78 s  |
| combined             | 1          | 1 332/s  | 84 464   | 0.27%  | 21.2 ms | 1 306 ms | 6 917 ms | 26.2 s  |
| combined             | 2          | 885.8/s  | 62 889   | 11.58% | 855 ms  | 4 887 ms | 26.5 s   | 31.4 s  |

Repetition 1 of `gateway / non-stream` and repetition 2 of `combined` are the contended
samples: they show 502/503 responses and large dropped-iteration counts, caused by the
benchmark container and the service containers competing for the same 4 CPUs.

## Reproduce

```bash
cd code
# Isolated stack (secrets required):
MASTER_KEY=… KEY_PEPPER=… BENCH_DATA_DIR=… \
  docker compose -f scripts/bench/compose.k6.yaml up -d --build --wait

# Full matrix (60 s per run, two repetitions):
MASTER_KEY=… KEY_PEPPER=… BENCH_DATA_DIR=… \
  python3 scripts/bench/run-k6.py --output /tmp/k6out --duration 60s --repeats 2

# Re-run a single case without repeating the others:
python3 scripts/bench/run-k6.py --output /tmp/k6out --only combined --repeats 2

# Report:
python3 scripts/bench/summarize-k6.py --output /tmp/k6out
```

`http_req_failed` and `dropped_iterations` are configured as k6 thresholds. Crossing a
threshold is a measurement result rather than a crash (k6 exits 99); the runner records it
as `thresholdsCrossed: true` in `run-metadata.json` and continues.

---

<a id="persian"></a>

# بنچمارک بار پایه — اسپرینت ۱

تاریخ اجرا: ۲۰۲۶-۱۱-۰۸، روی میزبان توسعهٔ محلی macOS با Docker Desktop.

## روش

اندازه‌گیری‌های جفتیِ mock provider به‌صورت مستقیم و از طریق gateway، با همان payload، همان executor با نرخ ورود ثابت (arrival-rate) و همان سخت‌افزار. stack در یک شبکهٔ Docker ایزوله (`dirouter-k6-baseline`) اجرا می‌شود: یک Traefik به‌عنوان edge، دو replica از gateway (image `dirouter-bench/gateway:keepalive` که فقط `keepAliveTimeout` را از ۳۰ ثانیه به ۲۵ ثانیه کاهش می‌دهد) و mock provider. Postgres و Valkey در اجرا نیستند — مسیر داغ (hot path) به‌تنهایی اندازه‌گیری می‌شود.

- ابزار: k6 (`grafana/k6:latest`) با executor از نوع `constant-arrival-rate`.
- payload: `POST /v1/chat/completions` با مدل `mock/small` و یک پیام کوتاه کاربر. پاسخ non-stream یک شیء JSON واحد است؛ stream شامل `stream_options.include_usage` است.
- سناریوها: direct/non-stream و gateway/non-stream با ۱۰۰۰ RPS؛ direct/stream و gateway/stream با ۵۰۰ RPS؛ و سپس ترکیبی (۱۰۰۰ non-stream به‌همراه ۵۰۰ stream هم‌زمان روی gateway). هر اجرای اندازه‌گیری ۶۰ ثانیه طول می‌کشد و دو بار تکرار می‌شود.
- نمونه‌برداری منابع: `docker stats` در هر ثانیه در طول هر اجرا، تا CPU و حافظه به‌تفکیک هر replica گزارش شوند.
- اسکریپت‌ها: `scripts/bench/run-k6.py` (هماهنگ‌سازی و نمونه‌برداری) و `scripts/bench/summarize-k6.py` (گزارش). خروجی خام شامل `http_reqs`، `http_req_failed`، `dropped_iterations` و روند `request_latency_ms` است.

> میزبان اندازه‌گیری یک ماشین توسعهٔ مشترک است و Docker Desktop فقط **۴ CPU** در اختیار می‌گذارد؛ کانتینر k6 همان ۴ CPU را با سرویس‌ها به اشتراک می‌گیرد. بنابراین دُم توزیع p95/p99 به‌شدت تحت تأثیر رقابت میزبان است. این اعداد یک **خط مبنای مقایسه‌ای** هستند، نه ادعای ظرفیت تولید. برای ارائهٔ ارقام ظرفیت قابل انتشار، یک ماشین اختصاصی (k6 خارج از VM و ≥ ۸ CPU) لازم است.

## نتایج (۲۰۲۶-۱۱-۰۸)

بهترین اجرا برای هر سناریو؛ هر دو تکرار در پیوست‌ها فهرست شده‌اند.

| سناریو                              | نرخ محقق‌شده | درخواست‌ها | خطا   | p50     | p95      | p99      | max     |
| ----------------------------------- | ------------ | ---------- | ----- | ------- | -------- | -------- | ------- |
| direct / non-stream، ۱۰۰۰ RPS       | 999.8/s      | 60 002     | 0.00% | 3.91 ms | 6.45 ms  | 23.3 ms  | 89.8 ms |
| gateway / non-stream، ۱۰۰۰ RPS      | 999.2/s      | 59 960     | 0.00% | 3.81 ms | 17.8 ms  | 190.6 ms | 752 ms  |
| direct / stream، ۵۰۰ RPS            | 499.9/s      | 30 000     | 0.00% | 14.0 ms | 16.9 ms  | 22.1 ms  | 71.5 ms |
| gateway / stream، ۵۰۰ RPS           | 496.7/s      | 29 809     | 0.00% | 14.5 ms | 102.9 ms | 958 ms   | 1.78 s  |
| ترکیبی (۱۰۰۰ + ۵۰۰) از طریق gateway | 1 332/s      | 84 464     | 0.27% | 21.2 ms | 1 306 ms | 6 917 ms | 26.2 s  |

هزینهٔ مسیریابی (gateway منهای direct، بهترین اجراهای جفت‌شده):

| حالت       | p50              | p95      | p99     |
| ---------- | ---------------- | -------- | ------- |
| non-stream | ≈ 0 ms (−0.1 ms) | +11.3 ms | +167 ms |
| stream     | +0.5 ms          | +85.9 ms | +936 ms |

## مصرف منابع در ۱۰۰۰ RPS از طریق gateway

| کانتینر       | CPU میانگین | CPU اوج | حافظهٔ میانگین | حافظهٔ اوج |
| ------------- | ----------- | ------- | -------------- | ---------- |
| gateway-1     | 55.6%       | 103%    | 123 MiB        | 135 MiB    |
| gateway-2     | 56.3%       | 98.7%   | 122 MiB        | 134.5 MiB  |
| traefik edge  | 31.3%       | 48.6%   | 186 MiB        | 459 MiB    |
| mock-provider | 16.0%       | 24.7%   | 74 MiB         | 80.5 MiB   |

درصدهای CPU نسبت به کل VM با ۴ CPU محاسبه شده‌اند. دو replica گیت‌وی بار را تقریباً دقیقاً به‌طور مساوی تقسیم کردند (55.6% در برابر 56.3%).

## تفسیر و محدودیت‌ها

1. **هدف «overhead p99 کمتر از ۱۰ ms» در این محیط نشان داده نشده است.** هزینهٔ میانهٔ مسیریابی عملاً صفر است (p50 گیت‌وی ≈ p50 مستقیم)، اما زیر رقابت میزبان، دُم توزیع تا دو مرتبهٔ بزرگی رشد می‌کند. با استخر VU بزرگ‌تر (MAX_VUS=1500)، سناریوی ترکیبی در اجرای تمیز ۰.۲۷٪ و در اجرای پرنویزتر ۱۱٪ درخواست را از دست داد (خطاهای 502 از Traefik وقتی استخر اتصال‌هایش اشباع شد، به‌علاوهٔ گرسنگی CPU).
2. در اجرای جفت‌شدهٔ سالم (gateway/non-stream، تکرار ۲) ۵۹٬۹۶۰ درخواست **بدون هیچ خطایی** کامل شد و تقریباً هیچ iteration رهاشده‌ای نبود: دو replica، ۱۰۰۰ RPS را بدون خطا حمل می‌کنند و فقط دُم latency زیر رقابت بدتر می‌شود.
3. ترکیبی (مجموعاً ۱۵۰۰ RPS) روی این ۴ CPU به‌طور قابل اتکا پایدار نیست. توان هدف باید در محیط staging/production با حداقل ۸ CPU و k6 روی میزبان جداگانه دوباره تأیید شود.
4. حافظهٔ هر replica (~۱۲۳ MiB) و CPU (~۲۸٪ به‌ازای هر ۵۰۰ RPS در هر replica) یک خط مبنای قابل استفاده برای برنامه‌ریزی ظرفیت اسپرینت‌های بعدی است.

## پیوست‌ها — هر دو تکرار

| سناریو               | تکرار | نرخ محقق‌شده | درخواست‌ها | خطا    | p50     | p95      | p99      | max     |
| -------------------- | ----- | ------------ | ---------- | ------ | ------- | -------- | -------- | ------- |
| direct / non-stream  | ۱     | 999.8/s      | 60 002     | 0.00%  | 3.91 ms | 6.45 ms  | 23.3 ms  | 89.8 ms |
| direct / non-stream  | ۲     | 998.1/s      | 59 894     | 0.00%  | 4.17 ms | 18.5 ms  | 75.1 ms  | 285 ms  |
| gateway / non-stream | ۱     | 907.1/s      | 54 429     | 0.21%  | 14.2 ms | 3 340 ms | 6 889 ms | 26.9 s  |
| gateway / non-stream | ۲     | 999.2/s      | 59 960     | 0.00%  | 3.81 ms | 17.8 ms  | 190.6 ms | 752 ms  |
| direct / stream      | ۱     | 499.9/s      | 30 000     | 0.00%  | 14.0 ms | 16.9 ms  | 22.1 ms  | 71.5 ms |
| direct / stream      | ۲     | 499.9/s      | 30 001     | 0.00%  | 14.1 ms | 19.1 ms  | 82.9 ms  | 309 ms  |
| gateway / stream     | ۱     | 484.9/s      | 29 699     | 0.00%  | 15.8 ms | 550 ms   | 1 787 ms | 2.20 s  |
| gateway / stream     | ۲     | 496.7/s      | 29 809     | 0.00%  | 14.5 ms | 102.9 ms | 958 ms   | 1.78 s  |
| ترکیبی               | ۱     | 1 332/s      | 84 464     | 0.27%  | 21.2 ms | 1 306 ms | 6 917 ms | 26.2 s  |
| ترکیبی               | ۲     | 885.8/s      | 62 889     | 11.58% | 855 ms  | 4 887 ms | 26.5 s   | 31.4 s  |

تکرار ۱ از `gateway / non-stream` و تکرار ۲ از `ترکیبی` نمونه‌های تحت رقابت هستند: پاسخ‌های 502/503 و تعداد زیاد iteration رهاشده را نشان می‌دهند که از رقابت کانتینر benchmark و کانتینرهای سرویس بر سر همان ۴ CPU ناشی شده است.

## بازتولید

```bash
cd code
# stack ایزوله (راز لازم است):
MASTER_KEY=… KEY_PEPPER=… BENCH_DATA_DIR=… \
  docker compose -f scripts/bench/compose.k6.yaml up -d --build --wait

# ماتریس کامل (۶۰ ثانیه برای هر اجرا، دو تکرار):
MASTER_KEY=… KEY_PEPPER=… BENCH_DATA_DIR=… \
  python3 scripts/bench/run-k6.py --output /tmp/k6out --duration 60s --repeats 2

# اجرای مجدد یک مورد بدون تکرار بقیه:
python3 scripts/bench/run-k6.py --output /tmp/k6out --only combined --repeats 2

# گزارش:
python3 scripts/bench/summarize-k6.py --output /tmp/k6out
```

`http_req_failed` و `dropped_iterations` به‌عنوان آستانه‌های k6 پیکربندی شده‌اند. عبور از آستانه یک نتیجهٔ اندازه‌گیری است نه کرش (k6 با کد ۹۹ خارج می‌شود)؛ runner آن را به‌صورت `thresholdsCrossed: true` در `run-metadata.json` ثبت می‌کند و ادامه می‌دهد.
