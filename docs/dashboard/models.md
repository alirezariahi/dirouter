# صفحهٔ مدل‌ها، Aliasها و Combo

کد: `apps/dashboard/src/pages/models.tsx` · تست: `models.test.tsx` · کارت ۷.۶

## نمای کلی

صفحه‌ای برای مدیریت کاتالوگ مدل‌ها، Aliasها و Comboها با ویرایشگر تعاملی پیشرفته برای Combo.

## قابلیت‌ها

### 📊 کاتالوگ مدل‌ها

جدول کامل با ستون‌های:

- **نام و Slug**: نام نمایشی و شناسه یکتا
- **Provider**: provider مبدأ
- **مدل Upstream**: نام واقعی در API provider
- **Context Window**: حداکثر توکن ورودی
- **Max Output**: حداکثر توکن خروجی
- **قیمت‌ها**: 5 نوع
  - Input ($/1M tokens)
  - Output ($/1M tokens)
  - Cache Read ($/1M tokens)
  - Cache Write ($/1M tokens)
  - Reasoning ($/1M tokens)
- **قابلیت‌ها**: streaming، tools، vision، reasoning، jsonMode
- **وضعیت**: enabled/disabled
- **اقدامات**: Edit، Delete

### ✏️ فرم مدل (ModelEditor)

**دو حالت:**

1. **انتخاب از کاتالوگ**: dropdown با auto-fill
2. **مدل سفارشی**: ورود دستی همه فیلدها

**فیلدها:**

```typescript
{
  catalogKey?: string;           // اگر از کاتالوگ باشد
  provider: string;              // provider_id
  slug: string;                  // شناسه یکتا (pattern: ^[a-z0-9][-a-z0-9]*$)
  upstreamModel: string;         // نام در API provider
  displayName?: string;          // نام نمایشی
  contextWindow: number;         // عدد صحیح مثبت
  maxOutputTokens?: number;      // عدد صحیح مثبت
  priceInput?: string;           // دلار (pattern: ^\d+(\.\d{1,8})?$)
  priceOutput?: string;
  priceCacheRead?: string;
  priceCacheWrite?: string;
  priceReasoning?: string;
  capabilities: {
    streaming?: boolean;
    tools?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    jsonMode?: boolean;
  };
  enabled: boolean;
}
```

**Validation:**

- `slug`: الزامی، lowercase، alphanumeric و dash
- `contextWindow`: الزامی، عدد صحیح مثبت
- قیمت‌ها: اعشاری تا 8 رقم

### 🏷️ Aliasها

**نمایش:**

- جدول با slug و target
- Target می‌تواند model یا combo باشد

**فرم Alias (AliasEditor):**

```typescript
{
  slug: string; // شناسه یکتا (pattern مانند model)
  target: string; // model_id یا combo_id
}
```

**Select target** با دو گروه:

- Models: لیست مدل‌های موجود
- Combos: لیست comboهای موجود

### 🎯 Comboها

**نمایش:**

- جدول با نام، استراتژی و تعداد targetها
- استراتژی: priority، weighted، round-robin

**ویرایشگر Combo (ComboEditor):**

#### 1️⃣ اطلاعات پایه

```typescript
{
  slug: string;           // شناسه یکتا
  displayName?: string;   // نام نمایشی
  description?: string;   // توضیح
}
```

#### 2️⃣ مدیریت Targetها

**افزودن:**

- Select برای انتخاب مدل
- دکمه "Add"
- جلوگیری از تکرار

**حذف:**

- دکمه "Remove" برای هر target

**مرتب‌سازی (Drag & Drop):**

```typescript
// HTML5 Drag & Drop API
const handleDragStart = (e: DragEvent, index: number) => {
  e.dataTransfer.effectAllowed = 'move';
  draggedIndex.current = index;
};

const handleDrop = (e: DragEvent, dropIndex: number) => {
  // Reorder array
};
```

**مرتب‌سازی (Keyboard):**

- دکمه‌های "Move Up" و "Move Down"
- با keyboard navigation

#### 3️⃣ استراتژی و تنظیمات

**Strategy:**

```typescript
type Strategy = 'priority' | 'weighted' | 'round-robin';
```

**وزن (برای weighted):**

- فیلد number برای هر target
- پیش‌فرض: 1
- نمایش درصد احتمال محاسبه‌شده

**Retry:**

```typescript
{
  retryMaxAttempts: number; // پیش‌فرض: 3، محدوده: 1-10
}
```

**Fallback Conditions:**
14 کلاس خطا با checkbox:

- `rate_limit` (429)
- `overloaded` (529)
- `server` (5xx)
- `timeout`
- `network`
- `auth` (401/403)
- `context_length`
- `content_policy`
- `bad_request` (4xx غیر از بالا)
- `model_not_found`
- `unsupported_feature`
- `provider_error`
- `unknown`
- `all` (همه)

**Timeouts:**

```typescript
{
  timeoutConnect?: number;      // ms
  timeoutFirstByte?: number;    // ms (TTFT)
  timeoutIdle?: number;         // ms (بین chunks)
  timeoutTotal?: number;        // ms (کل درخواست)
}
```

#### 4️⃣ پیش‌نمایش ترتیب اجرا

**برای priority:**

```
1. model-a
2. model-b
3. model-c
```

**برای weighted:**

```
model-a: 50% (weight 2/4)
model-b: 25% (weight 1/4)
model-c: 25% (weight 1/4)
```

با دکمه "Simulate Next" برای نمونه‌برداری تصادفی.

**برای round-robin:**

```
Request #1: model-a
Request #2: model-b
Request #3: model-c
Request #4: model-a (cycle)
```

با دکمه "Simulate Next" برای دیدن درخواست بعدی.

#### 5️⃣ Validation

تابع `validateCombo`:

```typescript
export function validateCombo(draft: ComboDraft): string[] {
  const errors: string[] = [];

  // slug
  if (!draft.slug) errors.push('Slug is required');
  else if (!SLUG_PATTERN.test(draft.slug)) errors.push('Invalid slug format');

  // targets
  if (draft.targets.length === 0) errors.push('At least one target required');

  // target تکراری
  const targetIds = draft.targets.map((t) => t.modelId);
  if (new Set(targetIds).size !== targetIds.length) errors.push('Duplicate targets');

  // weight برای weighted
  if (draft.strategy === 'weighted') {
    for (const t of draft.targets) {
      if (!t.weight || t.weight <= 0) errors.push('Weight must be positive');
    }
  }

  // retry
  if (draft.retryMaxAttempts < 1 || draft.retryMaxAttempts > 10)
    errors.push('Retry attempts: 1-10');

  // timeouts
  for (const [key, val] of Object.entries(draft.timeouts)) {
    if (val !== undefined && val <= 0) errors.push(`${key} must be positive`);
  }

  return errors;
}
```

## UX/UI

### Drag & Drop

**Visual Feedback:**

- درگ می‌شود: opacity 0.5
- drop zone: border آبی
- cursor: move

**Accessibility:**

- aria-grabbed="true"
- دکمه‌های keyboard fallback
- focus management

### حالت‌های مختلف

**Loading:**

- Skeleton برای جدول‌ها
- Spinner برای فرم‌ها

**Empty:**

- "هنوز مدلی اضافه نشده"
- "هنوز aliasای نیست"
- "هنوز comboای نیست"
  با دکمه ساخت

**Error:**

- با requestId و پیام
- دکمه retry

### Tabs

صفحه به 3 تب تقسیم می‌شود:

1. **Models**: کاتالوگ مدل‌ها
2. **Aliases**: لیست aliasها
3. **Combos**: لیست و ویرایشگر comboها

## کد

### ساختار

```tsx
ModelsPage
├── Tabs (Models, Aliases, Combos)
├── ModelsTab
│   ├── Table
│   └── ModelEditor (Dialog)
├── AliasesTab
│   ├── Table
│   └── AliasEditor (Dialog)
└── CombosTab
    ├── Table
    └── ComboEditor (Dialog)
        ├── Basic Info
        ├── Target Manager (Drag & Drop)
        ├── Strategy Selector
        ├── Weight Editor (conditional)
        ├── Fallback Checkboxes
        ├── Timeout Fields
        └── Execution Preview
```

### State Management

```typescript
// Models
const { data: models } = useModels();
const { data: catalog } = useCatalog();
const createModel = useCreateModel();
const updateModel = useUpdateModel();
const deleteModel = useDeleteModel();

// Aliases
const { data: aliases } = useAliases();
const createAlias = useCreateAlias();
const updateAlias = useUpdateAlias();
const deleteAlias = useDeleteAlias();

// Combos
const { data: combos } = useCombos();
const createCombo = useCreateCombo();
const updateCombo = useUpdateCombo();
const deleteCombo = useDeleteCombo();

// Editor State
const [editingCombo, setEditingCombo] = useState<Combo | null>(null);
const [draft, setDraft] = useState<ComboDraft>({
  slug: '',
  strategy: 'priority',
  targets: [],
  retryMaxAttempts: 3,
  fallbackOn: ['rate_limit', 'overloaded', 'server', 'timeout', 'network'],
  timeouts: {},
});
const [requestNumber, setRequestNumber] = useState(1); // for round-robin simulation
```

### Exported Helpers (برای تست)

```typescript
// Pattern validation
export const SLUG_PATTERN = /^[a-z0-9][-a-z0-9]*$/;
export const PRICE_PATTERN = /^\d+(\.\d{1,8})?$/;

// Validation
export function validateCombo(draft: ComboDraft): string[];
export function validateAlias(draft: AliasDraft): string[];

// Execution order calculation
export function executionOrder(
  strategy: Strategy,
  targets: ComboTarget[],
  requestNumber?: number,
): string | string[];
```

## تست‌ها

فایل: `models.test.tsx`

**Coverage:**

- ✅ رندر tabs و جدول‌ها
- ✅ ساخت/ویرایش/حذف model
- ✅ انتخاب از کاتالوگ و auto-fill
- ✅ ساخت/ویرایش/حذف alias
- ✅ ساخت/ویرایش/حذف combo
- ✅ مدیریت targetها (افزودن/حذف/reorder)
- ✅ تغییر strategy
- ✅ محاسبه وزن و درصد
- ✅ simulation (weighted و round-robin)
- ✅ validation
- ✅ error handling

**اجرا:**

```bash
cd code/apps/dashboard
pnpm test models.test.tsx

# نتیجه (2026-11-08):
# ✅ 6 passed
# ✅ Coverage: 62.06% statements
```

## API Endpoints

مستندات کامل در: [control-api/models.md](../control-api/models.md)

```
# Models
GET    /api/v1/orgs/:orgId/models
POST   /api/v1/orgs/:orgId/models
PATCH  /api/v1/orgs/:orgId/models/:id
DELETE /api/v1/orgs/:orgId/models/:id
GET    /api/v1/catalog           # کاتالوگ عمومی

# Aliases
GET    /api/v1/orgs/:orgId/aliases
POST   /api/v1/orgs/:orgId/aliases
PATCH  /api/v1/orgs/:orgId/aliases/:id
DELETE /api/v1/orgs/:orgId/aliases/:id

# Combos
GET    /api/v1/orgs/:orgId/combos
POST   /api/v1/orgs/:orgId/combos
PATCH  /api/v1/orgs/:orgId/combos/:id
DELETE /api/v1/orgs/:orgId/combos/:id
```

## RBAC

| نقش    | دسترسی               |
| ------ | -------------------- |
| OWNER  | همه (خواندن و نوشتن) |
| ADMIN  | همه (خواندن و نوشتن) |
| MEMBER | خواندن و ساخت/ویرایش |
| VIEWER | فقط خواندن           |

## مثال‌های استفاده

### ساخت Combo با Fallback پیشرفته

```json
{
  "slug": "sonnet-resilient",
  "displayName": "Claude Sonnet Resilient",
  "description": "Claude Sonnet with OpenAI fallback",
  "strategy": "priority",
  "targets": [
    {
      "modelId": "model-claude-sonnet",
      "order": 0
    },
    {
      "modelId": "model-gpt4o",
      "order": 1
    }
  ],
  "retryMaxAttempts": 2,
  "fallbackOn": ["rate_limit", "overloaded", "server", "timeout"],
  "timeouts": {
    "timeoutConnect": 5000,
    "timeoutFirstByte": 10000,
    "timeoutIdle": 30000,
    "timeoutTotal": 120000
  }
}
```

### Combo با Weighted Strategy

```json
{
  "slug": "gpt-load-balanced",
  "strategy": "weighted",
  "targets": [
    {
      "modelId": "model-gpt4o-key1",
      "weight": 3,
      "order": 0
    },
    {
      "modelId": "model-gpt4o-key2",
      "weight": 2,
      "order": 1
    },
    {
      "modelId": "model-gpt4o-key3",
      "weight": 1,
      "order": 2
    }
  ]
}
```

احتمال‌ها: key1=50%، key2=33%، key3=17%

### Alias به Combo

```json
{
  "slug": "best-sonnet",
  "target": "combo-sonnet-resilient"
}
```

## نکات پیاده‌سازی

### 1. Drag & Drop

**بهترین شیوه‌ها:**

- استفاده از HTML5 Drag & Drop API (بدون کتابخانه)
- Visual feedback واضح
- Keyboard fallback الزامی
- Touch support (optional)

### 2. Weighted Simulation

```typescript
function pickWeighted(targets: ComboTarget[]): string {
  const totalWeight = targets.reduce((sum, t) => sum + (t.weight || 1), 0);
  let random = Math.random() * totalWeight;

  for (const target of targets) {
    random -= target.weight || 1;
    if (random <= 0) return target.modelId;
  }

  return targets[0].modelId; // fallback
}
```

### 3. Round-Robin State

```typescript
// در UI state، نه در API
const [requestNumber, setRequestNumber] = useState(1);

function pickRoundRobin(targets: ComboTarget[], n: number): string {
  const index = (n - 1) % targets.length;
  return targets[index].modelId;
}
```

### 4. Validation Pattern

```typescript
// Export برای استفاده در تست
export const SLUG_PATTERN = /^[a-z0-9][-a-z0-9]*$/;

// در component
const errors = validateCombo(draft);
const isValid = errors.length === 0;

// نمایش
{errors.map(err => (
  <div key={err} className="text-danger">{err}</div>
))}
```

## مفاهیم

### Priority Strategy

targetها به ترتیب امتحان می‌شوند تا یکی موفق شود.

### Weighted Strategy

هر target احتمال وزنی دارد. برای load balancing.

### Round-Robin Strategy

targetها به نوبت انتخاب می‌شوند. برای توزیع یکنواخت.

### Fallback Conditions

شرایطی که باید به target بعدی رفت:

- **rate_limit**: 429 از provider
- **overloaded**: 529 یا 503
- **server**: 5xx دیگر
- **timeout**: connect، TTFT، idle یا total
- **network**: DNS، connection refused، ...
- **auth**: 401/403 (credential نامعتبر)
- **context_length**: prompt بزرگ‌تر از context window
- **content_policy**: رد شده توسط moderator
- **bad_request**: 4xx دیگر (معمولاً فال‌بک نمی‌شود)

مستندات: [concepts/routing.md](../concepts/routing.md)

## تاریخچه تغییرات

| تاریخ      | تغییر                               |
| ---------- | ----------------------------------- |
| 2026-11-07 | پیاده‌سازی اولیه با تمام قابلیت‌ها  |
| 2026-11-08 | تست‌ها و بررسی نهایی (coverage 62%) |

## مراجع

- [control-api/models.md](../control-api/models.md) - API documentation
- [concepts/routing.md](../concepts/routing.md) - توضیح استراتژی‌ها
- [rbac.md](../rbac.md) - Role-based access control
- [dev.md](dev.md) - ساختار کلی داشبورد
- [glossary.md](../glossary.md) - تعاریف Model، Alias، Combo
