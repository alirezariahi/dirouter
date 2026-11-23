[English](helm.md) · [فارسی](helm.fa.md)

# Kubernetes با Helm

chart موجود در `deploy/helm/dirouter` (کارت ۲۲.۶) گیت‌وی، control-api، worker، داشبورد و پورتال را اجرا می‌کند. همهٔ مقدارها در `deploy/helm/dirouter/values.yaml` توضیح داده شده‌اند.

## نصب

```bash
helm install dirouter deploy/helm/dirouter --namespace dirouter --create-namespace \
  --set domain=example.com \
  --set database.url='postgresql://dirouter:<password>@db.internal:5432/dirouter' \
  --set valkeyUrl=redis://valkey.internal:6379
```

برای ارزیابی سریع، `--set postgresql.enabled=true --set valkey.enabled=true` یک PostgreSQL و یک Valkey تک‌نمونه را داخل همین release اجرا می‌کند. در production از سرویس‌های مدیریت‌شده و دارای replica استفاده کنید ([deploy-ha.fa.md](deploy-ha.fa.md)).

## chart چه می‌کند

- **گیت‌وی:** یک Deployment با HorizontalPodAutoscaler روی CPU (به‌طور پیش‌فرض ۲ تا ۱۰ replica) و PodDisruptionBudget. به‌روزرسانی تدریجی پیش از حذف هر pod یکی اضافه می‌کند و grace period زمان drain گیت‌وی را پوشش می‌دهد ([ADR-0007](../adr/0007-data-plane-stays-on-node.fa.md) بار قابل‌برنامه‌ریزی هر replica را می‌گوید). گیت‌وی اعتبارنامهٔ پایگاه داده نمی‌گیرد (ADR-0006).
- **control-api:** پیش از شروع، migrationهای پایگاه داده را در یک init container اجرا می‌کند (قفل advisory در Prisma اجرای هم‌زمان replicaها را امن می‌کند) و PodDisruptionBudget دارد.
- **Probeها:** readiness روی `/readyz` و liveness روی `/healthz` برای همهٔ سرویس‌ها.
- **رازها:** `MASTER_KEY`، `KEY_PEPPER`، `JWT_SECRET` و `INTERNAL_TOKEN` در نصب اول ساخته می‌شوند و در هر ارتقا حفظ می‌شوند. Secret حتی اگر release حذف شود باقی می‌ماند. از آن نسخهٔ پشتیبان بگیرید: بدون `MASTER_KEY` اعتبارنامه‌های ذخیره‌شدهٔ providerها خوانده نمی‌شوند. برای مدیریت دستی، `secrets.existingSecret` را تنظیم کنید.
- **Traefik:** اگر CRDهای Traefik نصب باشند، یک IngressRoute برای میزبان‌های `api.`، `admin.`، `app.` و `portal.` ساخته می‌شود (TLS از `ingressRoute.certResolver` یا `ingressRoute.tlsSecret`). در غیر این صورت سرویس‌ها را با ingress خودتان منتشر کنید.
- **امنیت:** podها بدون root، بدون capability، بدون افزایش دسترسی و با پروفایل seccomp پیش‌فرض اجرا می‌شوند.

## بررسی

CI این chart را روی یک کلاستر kind با ایمیج‌های ساخته‌شده از همان commit نصب می‌کند، منتظر می‌ماند همهٔ podها آماده شوند، `/readyz` گیت‌وی و control-api را بررسی می‌کند، سپس release را ارتقا می‌دهد و بررسی می‌کند که کلیدهای ساخته‌شده تغییر نکرده باشند. در صورت شکست، وضعیت podها، رویدادها و لاگ‌ها در خلاصهٔ اجرا نوشته می‌شوند.
