# مستندات داشبورد DiRouter

این پوشه شامل مستندات صفحات و کامپوننت‌های داشبورد DiRouter است.

## فهرست

### راهنمای توسعه

- **[dev.md](dev.md)**: ساختار کلی، معماری و قراردادهای کد داشبورد

### صفحات

- **[keys.md](keys.md)**: صفحهٔ Virtual Keys (DR-50)
  - مدیریت کلیدهای مجازی
  - SecretDialog امن
  - چرخش و ابطال کلید
  - Coverage: 87.02%

- **[models.md](models.md)**: صفحهٔ Models، Aliases و Combo (DR-51)
  - کاتالوگ مدل‌ها
  - مدیریت Aliasها
  - ویرایشگر Combo با Drag & Drop
  - شبیه‌ساز استراتژی‌ها
  - Coverage: 62.06%

## وضعیت پیاده‌سازی

| کارت  | صفحه         | فایل               | تست      | Coverage | وضعیت   |
| ----- | ------------ | ------------------ | -------- | -------- | ------- |
| DR-50 | Virtual Keys | `pages/keys.tsx`   | 5 passed | 87.02%   | ✅ کامل |
| DR-51 | Models/Combo | `pages/models.tsx` | 6 passed | 62.06%   | ✅ کامل |

## ویژگی‌های اصلی

### DR-50: Virtual Keys

- ✅ جستجو و فیلتر (پروژه، وضعیت، متن)
- ✅ فرم کامل با validation
- ✅ SecretDialog امن (نمایش یک‌بار)
- ✅ چرخش کلید با grace period
- ✅ ابطال کلید
- ✅ RBAC و امنیت

### DR-51: Models/Combo

- ✅ کاتالوگ مدل‌ها با auto-fill
- ✅ Aliases به model/combo
- ✅ ویرایشگر Combo پیشرفته:
  - Drag & Drop برای targetها
  - 3 strategy (priority/weighted/round-robin)
  - 14 fallback condition
  - شبیه‌ساز تعاملی
  - پیش‌نمایش execution order

## تست‌ها

### اجرای تست‌ها

```bash
cd code/apps/dashboard

# تست همه
pnpm test

# تست خاص
pnpm test keys.test.tsx
pnpm test models.test.tsx

# با coverage
pnpm test --coverage
```

### نتایج (2026-11-08)

```
keys.test.tsx:    5 passed ✅ (87.02% coverage)
models.test.tsx:  6 passed ✅ (62.06% coverage)
─────────────────────────────────────────────
مجموع:           11 passed ✅
```

## تست دستی

### محیط

```bash
cd code
docker compose up -d
```

### چک‌لیست Keys

- [ ] https://app.localhost/keys بدون خطا لود می‌شود
- [ ] ساخت کلید
- [ ] SecretDialog نمایش داده می‌شود
- [ ] کپی کلید کار می‌کند
- [ ] ویرایش محدودیت‌ها
- [ ] چرخش کلید
- [ ] ابطال کلید
- [ ] فیلترها کار می‌کنند
- [ ] جستجو کار می‌کند

### چک‌لیست Models

- [ ] https://app.localhost/models بدون خطا لود می‌شود
- [ ] ساخت model از کاتالوگ
- [ ] ساخت model سفارشی
- [ ] ساخت alias
- [ ] ساخت combo
- [ ] افزودن targetها
- [ ] **Drag & drop کار می‌کند** ⭐
- [ ] Keyboard navigation کار می‌کند
- [ ] تغییر strategy
- [ ] Simulation weighted
- [ ] Simulation round-robin
- [ ] Validation نمایش داده می‌شود

## API Endpoints

مستندات کامل:

- [control-api/keys.md](../control-api/keys.md)
- [control-api/models.md](../control-api/models.md)

## معماری

```
apps/dashboard/src/
├── pages/
│   ├── keys.tsx         (756 خط)
│   ├── keys.test.tsx
│   ├── models.tsx       (1378 خط)
│   └── models.test.tsx
├── components/
│   └── ui/              (shadcn/ui)
├── lib/
│   ├── api/             (React Query)
│   └── i18n/
└── router.tsx
```

## مراجع

### مستندات فنی

- [concepts/routing.md](../concepts/routing.md) - استراتژی‌های مسیریابی
- [rbac.md](../rbac.md) - Role-based access control
- [gateway/auth.md](../gateway/auth.md) - احراز هویت

### مستندات پروژه

- [README.md](../../README.md) - نمای کلی پروژه
- [docs/](../) - مستندات کامل

## تاریخچه

| تاریخ      | رویداد                           |
| ---------- | -------------------------------- |
| 2026-11-07 | پیاده‌سازی keys.tsx و models.tsx |
| 2026-11-08 | تکمیل تست‌ها و مستندات           |

## تماس و مشارکت

برای سوالات یا پیشنهادات، به [مخزن اصلی](https://github.com/your-org/dirouter) مراجعه کنید.

---

**آخرین به‌روزرسانی:** 2026-11-08  
**وضعیت:** ✅ هر دو صفحه کامل و آماده برای استفاده
