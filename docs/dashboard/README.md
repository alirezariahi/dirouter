[English](README.md) · [فارسی](README.fa.md)

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
- [control-api/models.md](../api/control-api.md)

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
