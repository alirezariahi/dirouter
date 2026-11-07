# DiRouter

A resilient LLM gateway with OpenAI- and Anthropic-compatible endpoints, provider fallback, circuit breakers, rate limits, budgets, and usage accounting.

> Status: under development (MVP). The architecture documents describe the target system; the current applications are scaffolds and the remaining MVP features are not yet implemented.

## Prerequisites

- Node.js 22 LTS (see `.nvmrc`).
- pnpm 10. The exact version is pinned in the `packageManager` field of `package.json`; `corepack enable` enables the corresponding package manager.

## Quick start

```bash
pnpm install
pnpm build
pnpm dev
```

`pnpm dev` starts all applications concurrently:

| Application   | Address                       |
| ------------- | ----------------------------- |
| gateway       | http://localhost:8080/healthz |
| control-api   | http://localhost:3000/healthz |
| mock-provider | http://localhost:8090/healthz |
| dashboard     | http://localhost:5173         |
| worker        | No HTTP port; writes logs     |

## Commands

| Command             | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `pnpm build`        | Build all applications and packages with Turborepo caching |
| `pnpm dev`          | Run all applications in watch mode                         |
| `pnpm test`         | Run unit tests with Vitest                                 |
| `pnpm lint`         | Run ESLint across workspace packages                       |
| `pnpm typecheck`    | Check TypeScript types across workspace packages           |
| `pnpm format`       | Format files with Prettier                                 |
| `pnpm format:check` | Check formatting without changing files                    |

To target one application, use `pnpm --filter @dirouter/gateway dev`.

## CI

The prepared GitHub Actions pipeline is designed to lint, type-check, test, and build changed packages and their dependents. Integration tests use PostgreSQL and Valkey, followed by image publication on main or version-tag pushes. The workflow implementation has not yet been published. See [the CI guide](CI.md) for stages, tags, permissions, and local reproduction.

## Repository layout

```text
dirouter/
├─ apps/
│  ├─ gateway/        Data plane: LLM request hot path (target: NestJS + Fastify)
│  ├─ control-api/    Control plane: administration, authentication, config publishing
│  ├─ worker/         Usage-event processing, aggregation, and retention (target: BullMQ)
│  ├─ dashboard/      Persian, RTL administration UI (React + Vite)
│  └─ mock-provider/  Mock upstream provider for fault-injection tests
├─ packages/
│  ├─ contracts/      Shared Zod schemas and types, with JSON Schema export
│  ├─ shared/         Logging, errors, environment validation, crypto, IDs, and money
│  ├─ db/             Prisma schema and database client
│  ├─ model-catalog/  Versioned model prices and capabilities
│  ├─ ui/             Shared React components
│  ├─ tsconfig/       Base TypeScript configurations
│  └─ eslint-config/  Shared ESLint flat configuration
└─ adr/              Public architecture decision records
```

Applications may depend on packages; packages must not depend on applications. `contracts` has no internal package dependencies. The gateway must not depend on `@dirouter/db`.

## Documentation and contributing

Start with the [documentation index](DOCUMENTATION.md). Code, commit, and review conventions are described in [CONTRIBUTING.md](CONTRIBUTING.md).

English is the canonical language for versioned documentation. Public technical guides are stored in this repository root and `adr/`. Local Persian counterparts, private research, and development plans are kept in the sibling `../docs/` directory outside this Git repository; they are not included in a clone or Docker build context.
