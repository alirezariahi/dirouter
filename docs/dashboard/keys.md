[English](keys.md) · [فارسی](keys.fa.md)

# Virtual Keys Page

Code: `apps/dashboard/src/pages/keys.tsx` · test: `keys.test.tsx` · card 7.5

## Overview

A page for managing DiRouter virtual keys, with full CRUD, strong security and a professional UX.

## Features

### 🔍 Search and filtering

- **Text search**: by name, prefix or id
- **Project filter**: choose from the existing projects
- **Status filter**: active, rotating, expired, revoked
- **Pagination**: with cursor pagination

### 📊 Data display

Full table with the columns:

- **Name**: the human-readable name of the key
- **Project**: the project the key belongs to
- **Prefix**: `dr-xxxxxxxx` (masked for security)
- **Status**: with a colored badge
  - `active` (green)
  - `rotating` (blue)
  - `expired` (yellow)
  - `revoked` (red)
- **Limits**: RPM, TPM, budget
- **Allowed models**: list, or "all"
- **Usage**: cost, requests, tokens (in the selected range)
- **Last used**: formatted as a Persian (solar) or Gregorian date
- **Actions**: Edit, Rotate and Revoke buttons

### ✏️ Create/edit form

**Form fields:**

```typescript
{
  name: string;                    // key name (required)
  projectId: string;               // project selection (required)
  allowedModels: string[];         // list of model slugs (optional, empty = all)
  rpm: number;                     // requests per minute (optional)
  tpm: number;                     // tokens per minute (optional)
  maxConcurrency: number;          // maximum simultaneous requests (optional)
  expiresAt: string;               // expiry date ISO-8601 (optional)
  ipAllowlist: string[];           // IP or CIDR (optional)
  budgets: {
    period: 'daily' | 'monthly';
    limitUsd?: number;
    limitTokens?: number;
    alertThresholds?: number[];    // alert percentages: [50, 80, 100]
  }[];
}
```

**Validation:**

- name: at least 1 character
- project: must be selected
- RPM, TPM, maxConcurrency: positive integers
- expiry date: must be in the future
- IP allowlist: valid IPv4/IPv6 format or CIDR
- budget: at least one of limitUsd or limitTokens

### 🔐 Key security (SecretDialog)

**Important features:**

1. **One-time display**: the full key is shown only once, right after creation
2. **Outside the cache**: the response is kept out of the React Query cache and out of state
3. **Copy button**: uses the Clipboard API
4. **Clear warning**: "This key will not be shown again"
5. **Keyboard navigation**: Escape to close
6. **Focus trap**: prevents focus from leaving the dialog

```tsx
// explicit comment in the code:
// IMPORTANT: Do not put this response in React Query's cache
// or any persistent store. The secret must only be shown once.
```

### 🔄 Key rotation

**Rotation form:**

```typescript
{
  graceSeconds: number; // grace period for the old key (default: 86400 = 24 hours)
}
```

**Behavior:**

1. A new key is created with the same settings
2. The old key receives `expiresAt`
3. The old key keeps working until the end of the grace period
4. The new key is shown in SecretDialog

### ❌ Key revocation (Revoke)

- confirmation before revoking
- the key is disabled immediately
- the status changes to `revoked`
- it is removed from the next snapshot

## UX/UI

### Different states

- **Loading**: skeleton or spinner
- **Empty**: message "No key has been created yet" with a create button
- **Error**: with requestId, error message and a retry button

### Accessibility

- ✅ Labels for all inputs
- ✅ ARIA attributes
- ✅ Full keyboard navigation
- ✅ Focus management in dialogs
- ✅ Screen reader friendly

### RTL support

- ✅ Logical properties in Tailwind
- ✅ Automatic direction change with the language
- ✅ Date and number formatting based on locale

## Code

### Component structure

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

### State management

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

## Tests

File: `keys.test.tsx`

**Coverage:**

- ✅ rendering the key list
- ✅ search and filter
- ✅ create key
- ✅ edit key
- ✅ rotate key
- ✅ revoke key
- ✅ SecretDialog display
- ✅ validation
- ✅ error handling

**Run:**

```bash
cd code/apps/dashboard
pnpm test keys.test.tsx

# result (2026-11-08):
# ✅ 5 passed
# ✅ Coverage: 87.02% statements
```

## API Endpoints

Full documentation: [control-api/keys.md](../control-api/keys.md)

```
GET    /api/v1/orgs/:orgId/keys
POST   /api/v1/orgs/:orgId/keys
GET    /api/v1/orgs/:orgId/keys/:id
PATCH  /api/v1/orgs/:orgId/keys/:id
POST   /api/v1/orgs/:orgId/keys/:id/revoke
POST   /api/v1/orgs/:orgId/keys/:id/rotate
```

## RBAC

| Role   | Access                      |
| ------ | --------------------------- |
| OWNER  | everything (read and write) |
| ADMIN  | everything (read and write) |
| MEMBER | read, and create/edit keys  |
| VIEWER | read only                   |

Documentation: [rbac.md](../rbac.md)

## Usage examples

### Creating a key with advanced limits

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

### Rotation with a 1-hour grace period

```bash
# UI: Rotate button → enter 3600 seconds → confirm
# API: POST /keys/:id/rotate { "graceSeconds": 3600 }
# response: { "newKey": "dr-xxxxxxxx-yyyy...", "previous": {...} }
```

## Implementation notes

### 1. Security

- **Never** keep the full key in state or in a cache
- SecretDialog must be outside the React Query cache
- use `timingSafeEqual` in the backend
- the prefix is for display, the full hash is for authentication

### 2. Performance

- debounce for search (300ms)
- pagination for large lists
- lazy load for usage stats
- optimistic updates for quick changes

### 3. UX

- confirmation before dangerous operations (revoke)
- clear success/error messages
- loading state for all async operations
- keyboard shortcuts (Enter to submit, Escape to cancel)

## Change history

| Date       | Change                                   |
| ---------- | ---------------------------------------- |
| 2026-11-07 | initial implementation with all features |
| 2026-11-08 | tests and final review (coverage 87%)    |

## References

- [control-api/keys.md](../control-api/keys.md) - API documentation
- [rbac.md](../rbac.md) - Role-based access control
- [dev.md](dev.md) - overall dashboard structure
- [gateway/auth.md](../gateway/auth.md) - authentication in the gateway
