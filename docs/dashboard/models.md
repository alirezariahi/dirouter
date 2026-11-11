[English](models.md) · [فارسی](models.fa.md)

# Models, Aliases and Combo Page

Code: `apps/dashboard/src/pages/models.tsx` · test: `models.test.tsx` · card 7.6

## Overview

A page for managing the model catalog, Aliases and Combos, with an advanced interactive editor for Combos.

## Features

### 📊 Model catalog

Full table with the columns:

- **Name and Slug**: display name and unique identifier
- **Provider**: the source provider
- **Upstream model**: the real name in the provider's API
- **Context Window**: maximum input tokens
- **Max Output**: maximum output tokens
- **Prices**: 5 types
  - Input ($/1M tokens)
  - Output ($/1M tokens)
  - Cache Read ($/1M tokens)
  - Cache Write ($/1M tokens)
  - Reasoning ($/1M tokens)
- **Capabilities**: streaming, tools, vision, reasoning, jsonMode
- **Status**: enabled/disabled
- **Actions**: Edit, Delete

### ✏️ Model form (ModelEditor)

**Two modes:**

1. **Select from catalog**: dropdown with auto-fill
2. **Custom model**: enter all fields manually

**Fields:**

```typescript
{
  catalogKey?: string;           // if it comes from the catalog
  provider: string;              // provider_id
  slug: string;                  // unique identifier (pattern: ^[a-z0-9][-a-z0-9]*$)
  upstreamModel: string;         // name in the provider's API
  displayName?: string;          // display name
  contextWindow: number;         // positive integer
  maxOutputTokens?: number;      // positive integer
  priceInput?: string;           // dollars (pattern: ^\d+(\.\d{1,8})?$)
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

- `slug`: required, lowercase, alphanumeric and dash
- `contextWindow`: required, positive integer
- prices: decimals with up to 8 digits

### 🏷️ Aliases

**Display:**

- table with slug and target
- the target can be a model or a combo

**Alias form (AliasEditor):**

```typescript
{
  slug: string; // unique identifier (same pattern as model)
  target: string; // model_id or combo_id
}
```

**Target select** with two groups:

- Models: list of existing models
- Combos: list of existing combos

### 🎯 Combos

**Display:**

- table with name, strategy and number of targets
- strategies: priority, weighted, round-robin

**Combo editor (ComboEditor):**

#### 1️⃣ Basic information

```typescript
{
  slug: string;           // unique identifier
  displayName?: string;   // display name
  description?: string;   // description
}
```

#### 2️⃣ Target management

**Adding:**

- Select to choose a model
- "Add" button
- prevents duplicates

**Removing:**

- "Remove" button for each target

**Reordering (Drag & Drop):**

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

**Reordering (Keyboard):**

- "Move Up" and "Move Down" buttons
- with keyboard navigation

#### 3️⃣ Strategy and settings

**Strategy:**

```typescript
type Strategy = 'priority' | 'weighted' | 'round-robin';
```

**Weight (for weighted):**

- number field for each target
- default: 1
- shows the calculated probability percentage

**Retry:**

```typescript
{
  retryMaxAttempts: number; // default: 3, range: 1-10
}
```

**Fallback conditions:**
14 error classes with checkboxes:

- `rate_limit` (429)
- `overloaded` (529)
- `server` (5xx)
- `timeout`
- `network`
- `auth` (401/403)
- `context_length`
- `content_policy`
- `bad_request` (4xx other than the above)
- `model_not_found`
- `unsupported_feature`
- `provider_error`
- `unknown`
- `all` (everything)

**Timeouts:**

```typescript
{
  timeoutConnect?: number;      // ms
  timeoutFirstByte?: number;    // ms (TTFT)
  timeoutIdle?: number;         // ms (between chunks)
  timeoutTotal?: number;        // ms (whole request)
}
```

#### 4️⃣ Execution order preview

**For priority:**

```
1. model-a
2. model-b
3. model-c
```

**For weighted:**

```
model-a: 50% (weight 2/4)
model-b: 25% (weight 1/4)
model-c: 25% (weight 1/4)
```

With the "Simulate Next" button for random sampling.

**For round-robin:**

```
Request #1: model-a
Request #2: model-b
Request #3: model-c
Request #4: model-a (cycle)
```

With the "Simulate Next" button to see the next request.

#### 5️⃣ Validation

The `validateCombo` function:

```typescript
export function validateCombo(draft: ComboDraft): string[] {
  const errors: string[] = [];

  // slug
  if (!draft.slug) errors.push('Slug is required');
  else if (!SLUG_PATTERN.test(draft.slug)) errors.push('Invalid slug format');

  // targets
  if (draft.targets.length === 0) errors.push('At least one target required');

  // duplicate target
  const targetIds = draft.targets.map((t) => t.modelId);
  if (new Set(targetIds).size !== targetIds.length) errors.push('Duplicate targets');

  // weight for weighted
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

**Visual feedback:**

- item being dragged: opacity 0.5
- drop zone: blue border
- cursor: move

**Accessibility:**

- aria-grabbed="true"
- keyboard fallback buttons
- focus management

### Different states

**Loading:**

- Skeleton for tables
- Spinner for forms

**Empty:**

- "No model has been added yet"
- "No alias yet"
- "No combo yet"
  with a create button

**Error:**

- with requestId and message
- retry button

### Tabs

The page is split into 3 tabs:

1. **Models**: model catalog
2. **Aliases**: list of aliases
3. **Combos**: list and editor of combos

## Code

### Structure

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

### State management

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

### Exported helpers (for tests)

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

## Tests

File: `models.test.tsx`

**Coverage:**

- ✅ rendering tabs and tables
- ✅ create/edit/delete model
- ✅ selecting from catalog and auto-fill
- ✅ create/edit/delete alias
- ✅ create/edit/delete combo
- ✅ managing targets (add/remove/reorder)
- ✅ changing strategy
- ✅ weight and percentage calculation
- ✅ simulation (weighted and round-robin)
- ✅ validation
- ✅ error handling

**Run:**

```bash
cd code/apps/dashboard
pnpm test models.test.tsx

# result (2026-11-08):
# ✅ 6 passed
# ✅ Coverage: 62.06% statements
```

## API Endpoints

Full documentation: [control-api/models.md](../api/control-api.md)

```
# Models
GET    /api/v1/orgs/:orgId/models
POST   /api/v1/orgs/:orgId/models
PATCH  /api/v1/orgs/:orgId/models/:id
DELETE /api/v1/orgs/:orgId/models/:id
GET    /api/v1/catalog           # public catalog

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

| Role   | Access                      |
| ------ | --------------------------- |
| OWNER  | everything (read and write) |
| ADMIN  | everything (read and write) |
| MEMBER | read and create/edit        |
| VIEWER | read only                   |

## Usage examples

### Combo with advanced fallback

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

### Combo with weighted strategy

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

Probabilities: key1=50%, key2=33%, key3=17%

### Alias to combo

```json
{
  "slug": "best-sonnet",
  "target": "combo-sonnet-resilient"
}
```

## Implementation notes

### 1. Drag & Drop

**Best practices:**

- use the HTML5 Drag & Drop API (no library)
- clear visual feedback
- keyboard fallback is required
- touch support (optional)

### 2. Weighted simulation

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

### 3. Round-robin state

```typescript
// In UI state, not in the API
const [requestNumber, setRequestNumber] = useState(1);

function pickRoundRobin(targets: ComboTarget[], n: number): string {
  const index = (n - 1) % targets.length;
  return targets[index].modelId;
}
```

### 4. Validation pattern

```typescript
// Export for use in tests
export const SLUG_PATTERN = /^[a-z0-9][-a-z0-9]*$/;

// In the component
const errors = validateCombo(draft);
const isValid = errors.length === 0;

// Display
{errors.map(err => (
  <div key={err} className="text-danger">{err}</div>
))}
```

## Concepts

### Priority strategy

Targets are tried in order until one succeeds.

### Weighted strategy

Each target has a weighted probability. Used for load balancing.

### Round-robin strategy

Targets are selected in turn. Used for even distribution.

### Fallback conditions

Conditions under which the request moves to the next target:

- **rate_limit**: 429 from the provider
- **overloaded**: 529 or 503
- **server**: other 5xx
- **timeout**: connect, TTFT, idle or total
- **network**: DNS, connection refused, ...
- **auth**: 401/403 (invalid credential)
- **context_length**: prompt larger than the context window
- **content_policy**: rejected by the moderator
- **bad_request**: other 4xx (usually no fallback)

Documentation: [concepts/routing.md](../concepts/routing.md)

## Change history

| Date       | Change                                   |
| ---------- | ---------------------------------------- |
| 2026-11-07 | initial implementation with all features |
| 2026-11-08 | tests and final review (coverage 62%)    |

## References

- [control-api/models.md](../api/control-api.md) - API documentation
- [concepts/routing.md](../concepts/routing.md) - strategy explanation
- [rbac.md](../rbac.md) - Role-based access control
- [dev.md](dev.md) - overall dashboard structure
- [glossary.md](../glossary.md) - definitions of Model, Alias, Combo
