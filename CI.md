# CI pipeline

Prepared workflow path: `.github/workflows/ci.yml`.
The Git repository is rooted at `code/` in the local project layout. This guide describes the prepared CI implementation; the workflow, scripts, and Dockerfiles must be published before GitHub can run it.

## Triggers and stages

The workflow runs on every `pull_request`, pushes to `main`, `v*` tag pushes, and manual dispatch (`workflow_dispatch`). A new run cancels an earlier run for the same PR. Main and release runs are not cancelled automatically.

| Job                               | Purpose                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan affected packages            | Use full Git history to select packages and construct the image matrix                                                                                                    |
| Lint, types, unit tests and build | Lint root configuration, check CI-tooling formatting, test package selection and environment-reference coverage, then lint, type-check, test, and build selected packages |
| PostgreSQL and Valkey integration | Run real integration tests against disposable, health-checked PostgreSQL 17 and Valkey 8 Testcontainers; apply all migrations                                             |
| Image (application name)          | Build selected images with Buildx; publish only on push events after successful checks                                                                                    |
| CI passed                         | Require all applicable jobs to succeed; select this name as a required check in branch protection                                                                         |

Node.js is read from `.nvmrc`; pnpm is pinned by `packageManager` in `package.json`. Installation always uses `pnpm install --frozen-lockfile`, so a manifest/lockfile mismatch fails the job.

The pnpm store is cached by lockfile. The local Turborepo cache is keyed by operating system, architecture, lockfile, and commit, with prefix restoration. Docker layer caches are scoped by application. Turborepo validates reusable task outputs against its own input hashes. External actions are pinned to commit SHAs, with corresponding versions in comments.

## Package and image selection

`scripts/ci/plan.mjs` compares the PR base SHA to GitHub's checked-out test merge commit. For main pushes, it uses the event's `before` commit so multi-commit pushes are covered. The comparison starts at the merge base of the two commits.

The following filter selects changed packages and their dependents:

```bash
pnpm exec turbo run lint typecheck test build --filter="...[$BASE...$HEAD]"
```

Required build dependencies are included through `dependsOn: ["^build"]`. A change to `shared` therefore also tests and builds dependent applications. The Docker matrix is derived from the packages selected by Turbo.

| Change                                                                                         | Result                                                                      |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| One application                                                                                | That application and its dependents                                         |
| A shared package                                                                               | That package and dependent applications                                     |
| Documentation only                                                                             | Root and CI-tooling checks; no package/image builds or integration services |
| `node.Dockerfile`                                                                              | All four Node images                                                        |
| `dashboard.Dockerfile` or nginx configuration                                                  | Dashboard image                                                             |
| `.dockerignore`                                                                                | All images                                                                  |
| Root manifest/lockfile, Turbo/Node/ESLint/Prettier configuration, `.github/`, or `scripts/ci/` | Full checks and all images                                                  |
| Initial push, unavailable history, manual dispatch, or a release tag                           | Full checks and all images                                                  |

Images: `gateway`, `control-api`, `worker`, `mock-provider`, `dashboard`, and `migrate`. Changes to `@dirouter/db` or `migrate.Dockerfile` select the migration image even though it has no separate workspace package.

The existing Dockerfiles under `deploy/docker/` are prerequisites for the image stage and must be present in the runner's checkout. The prepared image stage builds `linux/amd64` only; multi-architecture support is separate work.

The environment check scans literal Node/Vite reads, Zod application schemas, Compose interpolation, the dashboard nginx template, and GitHub Actions `env` blocks. It fails for missing or stale structured entries in `docs/env-reference.md`. Development, test, and CI-only variables belong in separate sections of that reference, not automatically in the production `.env`.

## Test coverage and Testcontainers

`pnpm test` runs Vitest with V8 coverage for every package test task. `vitest.shared.ts` supplies HTML, LCOV, JSON-summary and terminal reports under each package's `coverage/` directory. The shared default threshold is 70% for statements, branches, functions and lines. `packages/translator` requires 90% globally; `packages/routing` and `apps/gateway` require 90% for `router.ts` and `rate-limiter.ts` respectively. Entrypoints, generated clients and pure re-export modules are excluded from coverage. `pnpm test:unit` runs the same suites without collecting coverage. `node scripts/ci/coverage-summary.mjs` prints a package table for the GitHub step summary. Unit and integration coverage are uploaded as separate 14-day artifacts.

The integration runner starts disposable `postgres:17-alpine` and `valkey/valkey:8-alpine` containers on ephemeral host ports, waits for their health checks, applies all Prisma migrations, and runs the infrastructure, worker, control-api and gateway suites. It stops both containers on success or failure. Integration jobs are not cached by Turbo, so a previous successful run cannot replace a live service connection.

```bash
pnpm install --frozen-lockfile
npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/integration
pnpm test:integration
```

The isolated npm lockfile under `scripts/integration/` pins the Testcontainers runtime without changing the application's pnpm dependency graph. Docker must be running. Individual integration suites still accept `INTEGRATION_DATABASE_URL` and `INTEGRATION_VALKEY_URL` for debugging against an existing disposable environment, but no pre-running local services are needed for the standard command above.

`pnpm exec turbo run lint typecheck test build --filter="$TURBO_FILTER"` enforces coverage in affected package jobs. Application suites that rely on real services collect reports in both unit and integration stages; their enforced 70% gate is evaluated in the integration stage rather than against skipped tests. New feature pages and modules must retain the package-level threshold.

## Integration tests and local reproduction

`scripts/ci/services.integration.mjs` uses clients inside the containers through `docker exec`; no SQL/Valkey clients or published service ports are needed on the runner.

The PostgreSQL test creates a temporary table inside a transaction, round-trips a cost calculated by the `money` module, a key hash, and an encrypted credential, then rolls back. The Valkey test checks `SET NX PX` locks, TTLs, and concurrent atomic `INCR` counters, then removes its keys.

These infrastructure tests check the shared package, real locks and counters, and transaction semantics. Domain integration suites then exercise migrations, the usage pipeline, dashboard APIs and distributed gateway behavior.

```bash
pnpm install --frozen-lockfile
pnpm exec eslint .
pnpm exec prettier --check .github scripts/ci CI.md
node --test scripts/ci/plan.test.mjs
node --test scripts/ci/env-docs.test.mjs
node scripts/ci/check-env-docs.mjs
pnpm exec turbo run lint typecheck test build

docker run -d --name dirouter-ci-postgres \
  -e POSTGRES_USER=dirouter -e POSTGRES_PASSWORD=ci-only-password \
  -e POSTGRES_DB=dirouter_ci \
  --health-cmd='pg_isready -U dirouter -d dirouter_ci' \
  --health-interval=5s --health-timeout=3s --health-retries=12 postgres:17-alpine
docker run -d --name dirouter-ci-valkey \
  --health-cmd='valkey-cli ping' \
  --health-interval=5s --health-timeout=3s --health-retries=12 valkey/valkey:8-alpine

# Once both containers are healthy:
pnpm exec turbo run build --filter=@dirouter/shared
POSTGRES_CONTAINER=dirouter-ci-postgres VALKEY_CONTAINER=dirouter-ci-valkey \
  node --test scripts/ci/services.integration.mjs

docker rm -f dirouter-ci-postgres dirouter-ci-valkey
```

CI creates and removes the Testcontainers automatically. The example password is for a disposable test database only. Integration tests run outside the Turbo cache so a cached result cannot replace a real service connection.

## Registry, tags, and permissions

Images are published to `ghcr.io`, using the lowercase repository path:

```text
ghcr.io/alirezariahi/dirouter/gateway:sha-<full-commit-sha>
ghcr.io/alirezariahi/dirouter/gateway:1.2.3
ghcr.io/alirezariahi/dirouter/gateway:1.3.0-rc.1
```

Main pushes publish only affected images with SHA tags. A valid SemVer tag such as `v1.2.3` publishes every image with both SHA and version tags. No `latest` tag is generated.

Invalid `v*` tags fail. A release tag's commit must be in the history of `origin/main`; this is checked before registry login. PRs, including fork PRs, build without logging into the registry or publishing. Manual dispatch also does not publish. The workflow does not deploy the application.

| Variable or permission                                               | Source and purpose                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GITHUB_TOKEN`                                                       | Provided by GitHub; only the image job requests `packages: write`   |
| `contents: read`                                                     | Default minimum permission for checkout                             |
| `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_SHA` | GitHub-provided inputs for package selection                        |
| `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`                               | GitHub-provided paths for matrix outputs and selection summaries    |
| `POSTGRES_CONTAINER`, `VALKEY_CONTAINER`                             | Container IDs from the current job; configurable locally            |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`                  | Disposable CI database configuration; never a production connection |
| `HUSKY=0`                                                            | Set during CI installation to disable development hooks             |
| `TURBO_TELEMETRY_DISABLED=1`                                         | Disable build-tool telemetry in CI                                  |

No custom secret, DiTask token, provider key, or production configuration is required. If the GHCR package already exists, grant this repository's Actions access in its package settings. To prevent unchecked merges, require the `CI passed` check on main.

## References

- [CI construction and Git filtering in Turborepo](https://turborepo.dev/docs/crafting-your-repository/constructing-ci)
- [PostgreSQL services in GitHub Actions](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
- [Publishing Docker images with GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [SHA and SemVer tags in docker/metadata-action](https://github.com/docker/metadata-action)
