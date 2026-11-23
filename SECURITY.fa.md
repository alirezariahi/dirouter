# سیاست امنیتی

[English](SECURITY.md)

## گزارش آسیب‌پذیری

لطفاً issue عمومی باز نکنید. گزارش را به‌صورت خصوصی از طریق
[security advisories گیت‌هاب](https://github.com/alirezariahi/dirouter/security/advisories/new)
همین مخزن بفرستید و در آن بنویسید:

- مؤلفهٔ آسیب‌دیده (gateway، control-api، worker، داشبورد، پورتال یا فایل‌های استقرار)؛
- نسخه یا commit؛
- مراحل بازتولید و اثری که انتظار دارید.

دریافت گزارش را ظرف سه روز کاری تأیید می‌کنیم و هدفمان رفع موارد Critical و High ظرف چهارده روز است. اگر گزارش‌دهنده نخواهد، نامش را در یادداشت انتشار نمی‌آوریم؛ در غیر این صورت از او قدردانی می‌کنیم.

## نسخه‌های پشتیبانی‌شده

اصلاحات امنیتی فقط روی آخرین نسخهٔ منتشرشده و `main` اعمال می‌شود. نسخه‌های قدیمی‌تر وصله نمی‌شوند.

## برای قابل‌اعتماد بودن انتشارها چه می‌کنیم

- هر اجرای CI وابستگی‌ها و فایل‌های مخزن را برای آسیب‌پذیری‌های Critical و رازهای لورفته اسکن می‌کند (Trivy) و با هر یافته شکست می‌خورد. پیش از آن، CI ثابت می‌کند این دروازه واقعاً کار می‌کند: یک lockfile نمونه با آسیب‌پذیری Critical شناخته‌شده باید گزارش شود.
- هر ایمیج پیش از انتشار اسکن می‌شود و اگر آسیب‌پذیری Critical قابل‌رفع داشته باشد، CI شکست می‌خورد.
- برای هر ایمیج یک SBOM با قالب SPDX ساخته می‌شود (Syft). SBOM به‌عنوان artifact در CI نگه داشته می‌شود و به‌صورت attestation امضاشده به ایمیج پیوست می‌شود.
- ایمیج‌های منتشرشده با cosign و به روش keyless (Sigstore) امضا می‌شوند و امضا به workflow همین مخزن گره خورده است. پیش از استقرار، ایمیج را بررسی کنید:

  ```bash
  cosign verify ghcr.io/alirezariahi/dirouter/gateway@sha256:<digest> \
    --certificate-identity-regexp '^https://github.com/alirezariahi/dirouter/\.github/workflows/ci\.yml@' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

- Actionهای شخص ثالث با SHA کامیت pin شده‌اند و ابزارهای اسکن از ایمیج‌هایی اجرا می‌شوند که با digest pin شده‌اند.

مدل تهدید در [docs/security/threat-model.fa.md](docs/security/threat-model.fa.md) و چک‌لیست تست نفوذ همراه آخرین نتایج آن در [docs/security/pentest-checklist.fa.md](docs/security/pentest-checklist.fa.md) است.
