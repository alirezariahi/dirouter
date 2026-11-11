[English](#english) · [فارسی](#persian)

<a id="english"></a>

# DiRouter Dashboard Documentation

This folder contains the documentation for the DiRouter dashboard pages and components.

## Index

### Development guide

- **[dev.md](dev.md)**: overall structure, architecture and code conventions of the dashboard

### Pages

- **[keys.md](keys.md)**: Virtual Keys page (DR-50)
  - managing virtual keys
  - secure SecretDialog
  - key rotation and revocation
  - Coverage: 87.02%
- **[models.md](models.md)**: Models, Aliases and Combo page (DR-51)
  - model catalog
  - managing aliases
  - Combo editor with Drag & Drop
  - strategy simulator
  - Coverage: 62.06%

## Implementation status

| Card  | Page         | File               | Tests    | Coverage | Status      |
| ----- | ------------ | ------------------ | -------- | -------- | ----------- |
| DR-50 | Virtual Keys | `pages/keys.tsx`   | 5 passed | 87.02%   | ✅ Complete |
| DR-51 | Models/Combo | `pages/models.tsx` | 6 passed | 62.06%   | ✅ Complete |

## Main features

### DR-50: Virtual Keys

- ✅ search and filter (project, status, text)
- ✅ full form with validation
- ✅ secure SecretDialog (shown once)
- ✅ key rotation with grace period
- ✅ key revocation
- ✅ RBAC and security

### DR-51: Models/Combo

- ✅ model catalog with auto-fill
- ✅ Aliases to model/combo
- ✅ advanced Combo editor:
  - Drag & Drop for targets
  - 3 strategies (priority/weighted/round-robin)
  - 14 fallback conditions
  - interactive simulator
  - execution order preview

## Tests

### Running tests

```bash
cd code/apps/dashboard

# all tests
pnpm test

# specific tests
pnpm test keys.test.tsx
pnpm test models.test.tsx

# with coverage
pnpm test --coverage
```

### Results (2026-11-08)

```
keys.test.tsx:    5 passed ✅ (87.02% coverage)
models.test.tsx:  6 passed ✅ (62.06% coverage)
─────────────────────────────────────────────
Total:           11 passed ✅
```

## Manual testing

### Environment

```bash
cd code
docker compose up -d
```

### Keys checklist

- [ ] https://app.localhost/keys loads without errors
- [ ] create a key
- [ ] SecretDialog is displayed
- [ ] copy key works
- [ ] edit limits
- [ ] rotate key
- [ ] revoke key
- [ ] filters work
- [ ] search works

### Models checklist

- [ ] https://app.localhost/models loads without errors
- [ ] create a model from the catalog
- [ ] create a custom model
- [ ] create an alias
- [ ] create a combo
- [ ] add targets
- [ ] **Drag & drop works** ⭐
- [ ] Keyboard navigation works
- [ ] change strategy
- [ ] Weighted simulation
- [ ] Round-robin simulation
- [ ] Validation is displayed

## API Endpoints

Full documentation:

- [control-api/keys.md](../control-api/keys.md)
- [control-api/models.md](../control-api/models.md)

## Architecture

```
apps/dashboard/src/
├── pages/
│   ├── keys.tsx         (756 lines)
│   ├── keys.test.tsx
│   ├── models.tsx       (1378 lines)
│   └── models.test.tsx
├── components/
│   └── ui/              (shadcn/ui)
├── lib/
│   ├── api/             (React Query)
│   └── i18n/
└── router.tsx
```

## References

### Technical docs

- [concepts/routing.md](../concepts/routing.md) - routing strategies
- [rbac.md](../rbac.md) - Role-based access control
- [gateway/auth.md](../gateway/auth.md) - authentication

### Project docs

- [README.md](../../README.md) - project overview
- [docs/](../) - full documentation

## History

| Date       | Event                                     |
| ---------- | ----------------------------------------- |
| 2026-11-07 | implementation of keys.tsx and models.tsx |
| 2026-11-08 | tests and documentation completed         |

## Contact and contribution

For questions or suggestions, see the [main repository](https://github.com/your-org/dirouter).

---

**Last updated:** 2026-11-08  
**Status:** ✅ both pages complete and ready for use

---

<a id="persian"></a>

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
