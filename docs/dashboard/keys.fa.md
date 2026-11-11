[English](keys.fa.md) · [فارسی](keys.fa.md)

<div dir="rtl">

# صفحهٔ Virtual Keys

کد: `apps/dashboard/src/pages/keys.tsx` · تست: `keys.test.tsx` · کارت ۷.۵

## نمای کلی

صفحه‌ای برای مدیریت کلیدهای مجازی DiRouter با قابلیت‌های کامل CRUD، امنیت بالا و UX حرفه‌ای.

## قابلیت‌ها

### 🔍 جستجو و فیلترینگ

- **جستجوی متنی**: بر اساس نام، prefix یا id
- **فیلتر پروژه**: انتخاب از لیست پروژه‌های موجود
- **فیلتر وضعیت**: active، rotating، expired، revoked
- **صفحه‌بندی**: با cursor pagination

### 📊 نمایش داده

جدول کامل با ستون‌های:

- **نام**: نام قابل‌فهم کلید
- **پروژه**: پروژه‌ای که کلید به آن تعلق دارد
- **Prefix**: `dr-xxxxxxxx` (ماسک‌شده برای امنیت)
- **وضعیت**: با badge رنگی
  - `active` (سبز)
  - `rotating` (آبی)
  - `expired` (زرد)
  - `revoked` (قرمز)
- **محدودیت‌ها**: RPM، TPM، بودجه
- **مدل‌های مجاز**: لیست یا "همه"
- **مصرف**: هزینه، درخواست‌ها، توکن‌ها (در بازهٔ انتخابی)
- **آخرین استفاده**: با فرمت تاریخ شمسی/میلادی
- **اقدامات**: دکمه‌های Edit، Rotate، Revoke

### ✏️ فرم ساخت/ویرایش

**فیلدهای فرم:**

```typescript
{
  name: string;                    // نام کلید (الزامی)
  projectId: string;               // انتخاب پروژه (الزامی)
  allowedModels: string[];         // لیست slug مدل‌ها (اختیاری، خالی = همه)
  rpm: number;                     // درخواست در دقیقه (اختیاری)
  tpm: number;                     // توکن در دقیقه (اختیاری)
  maxConcurrency: number;          // حداکثر درخواست همزمان (اختیاری)
  expiresAt: string;               // تاریخ انقضا ISO-8601 (اختیاری)
  ipAllowlist: string[];           // IP یا CIDR (اختیاری)
  budgets: {
    period: 'daily' | 'monthly';
    limitUsd?: number;
    limitTokens?: number;
    alertThresholds?: number[];    // درصدهای هشدار: [50, 80, 100]
  }[];
}
```

**Validation:**

- نام: حداقل ۱ کاراکتر
- پروژه: باید انتخاب شود
- RPM، TPM، maxConcurrency: عدد صحیح مثبت
- تاریخ انقضا: باید در آینده باشد
- IP allowlist: فرمت معتبر IPv4/IPv6 یا CIDR
- بودجه: حداقل یکی از limitUsd یا limitTokens

### 🔐 امنیت کلید (SecretDialog)

**ویژگی‌های مهم:**

1. **نمایش یک‌باره**: کلید کامل فقط بعد از ساخت یک بار نشان داده می‌شود
2. **خارج از کش**: پاسخ از cache React Query و state خارج است
3. **دکمهٔ کپی**: با Clipboard API
4. **هشدار واضح**: "این کلید دیگر نشان داده نمی‌شود"
5. **Keyboard navigation**: Escape برای بستن
6. **Focus trap**: جلوگیری از خروج focus از dialog

```tsx
// کامنت صریح در کد:
// IMPORTANT: Do not put this response in React Query's cache
// or any persistent store. The secret must only be shown once.
```

### 🔄 چرخش کلید (Rotation)

**فرم rotation:**

```typescript
{
  graceSeconds: number; // مهلت برای کلید قدیم (پیش‌فرض: 86400 = 24 ساعت)
}
```

**رفتار:**

1. کلید جدید با همان تنظیمات ساخته می‌شود
2. کلید قدیم `expiresAt` می‌گیرد
3. کلید قدیم تا پایان مهلت کار می‌کند
4. کلید جدید در SecretDialog نشان داده می‌شود

### ❌ ابطال کلید (Revoke)

- تأیید قبل از ابطال
- کلید بلافاصله غیرفعال می‌شود
- وضعیت به `revoked` تغییر می‌کند
- از snapshot بعدی حذف می‌شود

## UX/UI

### حالت‌های مختلف

- **Loading**: اسکلتون یا spinner
- **Empty**: پیام "هنوز کلیدی ساخته نشده" با دکمهٔ ساخت
- **Error**: با requestId، پیام خطا و دکمهٔ retry

### دسترسی‌پذیری (Accessibility)

- ✅ Labels برای همهٔ inputها
- ✅ ARIA attributes
- ✅ Keyboard navigation کامل
- ✅ Focus management در dialogها
- ✅ Screen reader friendly

### RTL Support

- ✅ Logical properties در Tailwind
- ✅ تغییر خودکار جهت با زبان
- ✅ فرمت تاریخ و عدد بر اساس locale

## کد

### ساختار کامپوننت

```tsx
KeysPage
├── Search & Filters
├── Table
│   ├── Header
│   ├── Body (map keys)
│   └── Actions (Edit, Rotate, Revoke)
├── CreateDialog
│   └── KeyForm
├── EditDialog
│   └── KeyForm
├── RotateDialog
│   └── GraceField + SecretDialog
└── SecretDialog (one-time display)
```

### Queries & Mutations

```typescript
// Queries
const { data: keys } = useKeys({ projectId, status, search });
const { data: projects } = useProjects();
const { data: usage } = useKeyUsage({ keyId, from, to });

// Mutations
const createKey = useCreateKey();
const updateKey = useUpdateKey();
const rotateKey = useRotateKey();
const revokeKey = useRevokeKey();
```

### State Management

```typescript
// UI State
const [createOpen, setCreateOpen] = useState(false);
const [editKey, setEditKey] = useState<Key | null>(null);
const [rotateKey, setRotateKey] = useState<Key | null>(null);
const [secretDialog, setSecretDialog] = useState<{ key: string } | null>(null);

// Filters
const [search, setSearch] = useState('');
const [projectFilter, setProjectFilter] = useState<string | null>(null);
const [statusFilter, setStatusFilter] = useState<KeyStatus | null>(null);
```

## تست‌ها

فایل: `keys.test.tsx`

**Coverage:**

- ✅ رندر لیست کلیدها
- ✅ جستجو و فیلتر
- ✅ ساخت کلید
- ✅ ویرایش کلید
- ✅ چرخش کلید
- ✅ ابطال کلید
- ✅ نمایش SecretDialog
- ✅ validation
- ✅ error handling

**اجرا:**

```bash
cd code/apps/dashboard
pnpm test keys.test.tsx

# نتیجه (2026-11-08):
# ✅ 5 passed
# ✅ Coverage: 87.02% statements
```

## API Endpoints

مستندات کامل در: [control-api/keys.md](../control-api/keys.fa.md)

```
GET    /api/v1/orgs/:orgId/keys
POST   /api/v1/orgs/:orgId/keys
GET    /api/v1/orgs/:orgId/keys/:id
PATCH  /api/v1/orgs/:orgId/keys/:id
POST   /api/v1/orgs/:orgId/keys/:id/revoke
POST   /api/v1/orgs/:orgId/keys/:id/rotate
```

## RBAC

| نقش    | دسترسی                    |
| ------ | ------------------------- |
| OWNER  | همه (خواندن و نوشتن)      |
| ADMIN  | همه (خواندن و نوشتن)      |
| MEMBER | خواندن و ساخت/ویرایش کلید |
| VIEWER | فقط خواندن                |

مستندات: [rbac.md](../rbac.fa.md)

## مثال استفاده

### ساخت کلید با محدودیت‌های پیشرفته

```json
{
  "name": "Production API Key",
  "projectId": "proj-abc123",
  "allowedModels": ["claude-sonnet-4", "gpt-4o"],
  "rpm": 60,
  "tpm": 100000,
  "maxConcurrency": 10,
  "expiresAt": "2027-12-31T23:59:59Z",
  "ipAllowlist": ["203.0.113.0/24", "2001:db8::/32"],
  "budgets": [
    {
      "period": "daily",
      "limitUsd": 100,
      "alertThresholds": [50, 80, 100]
    },
    {
      "period": "monthly",
      "limitTokens": 10000000,
      "alertThresholds": [80, 100]
    }
  ]
}
```

### چرخش با مهلت 1 ساعت

```bash
# UI: دکمه Rotate → وارد کردن 3600 ثانیه → تأیید
# API: POST /keys/:id/rotate { "graceSeconds": 3600 }
# پاسخ: { "newKey": "dr-xxxxxxxx-yyyy...", "previous": {...} }
```

## نکات پیاده‌سازی

### ۱. امنیت

- **هرگز** کلید کامل را در state یا cache نگه ندارید
- SecretDialog باید از React Query cache خارج باشد
- از `timingSafeEqual` در backend استفاده شود
- Prefix برای نمایش، hash کامل برای احراز هویت

### ۲. عملکرد

- Debounce برای جستجو (300ms)
- Pagination برای لیست‌های بزرگ
- Lazy load برای usage stats
- Optimistic updates برای تغییرات سریع

### ۳. UX

- Confirmation قبل از عملیات خطرناک (revoke)
- پیام‌های موفقیت/خطا واضح
- Loading state برای همهٔ عملیات async
- Keyboard shortcuts (Enter برای submit، Escape برای cancel)

## تاریخچه تغییرات

| تاریخ      | تغییر                               |
| ---------- | ----------------------------------- |
| 2026-11-07 | پیاده‌سازی اولیه با تمام قابلیت‌ها  |
| 2026-11-08 | تست‌ها و بررسی نهایی (coverage 87%) |

## مراجع

- [control-api/keys.md](../control-api/keys.fa.md) - API documentation
- [rbac.md](../rbac.fa.md) - Role-based access control
- [dev.md](dev.fa.md) - ساختار کلی داشبورد
- [gateway/auth.md](../gateway/auth.fa.md) - احراز هویت در gateway

</div>
