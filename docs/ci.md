# CI Pipeline — Card 1.5

> All documentation is in English, and detailed guides live in `code/docs/`. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the [documentation policy](../CONTRIBUTING.md#documentation-policy).

Workflow file: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
The Git repository is in the `code/` folder; this document is inside the same repository so that it is versioned together with the pipeline.

## Run time and stages

The pipeline runs on every `pull_request`, on push to `main`, on push of a `v*` tag, and on manual runs (`workflow_dispatch`).
A new run for a PR cancels the previous run of the same PR; runs that publish from main and version tags are not cancelled.

| Job                               | Task                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan affected packages            | Selecting packages using the full Git history and building the image matrix                                                                  |
| Lint, types, unit tests and build | Root ESLint, formatting of the CI tooling, tests for package selection; then lint, typecheck, unit tests, and build of the selected packages |
| PostgreSQL and Valkey integration | Running a real test on an isolated PostgreSQL 17 and Valkey 8 with health checks                                                             |
| Image (app name)                  | Building the selected images with Buildx; publishing only for the push event and after the tests succeed                                     |
| CI passed                         | Checking the result of all required jobs; select this name as a required check in branch protection                                          |

Node.js is read from `.nvmrc`, and the pnpm version from `packageManager` in `package.json`.
Installation is always `pnpm install --frozen-lockfile`; a mismatch between the manifest and the lockfile causes a failure.
The pnpm store cache is keyed by the lockfile, the local Turborepo cache is keyed by OS/architecture/lockfile/commit, and the Docker layer caches are separate for each app.
Task outputs are reused based on Turborepo's own input hashes.
All external actions are pinned to a fixed commit SHA; the corresponding version is noted in a comment.

## Package and image selection

The script [`scripts/ci/plan.mjs`](../scripts/ci/plan.mjs) uses the base SHA and the GitHub test-merge commit for PRs.
For a push to main, the base is the `before` of that event; therefore a push containing several commits is checked completely as well.
The comparison base is the merge-base of two commits. The following filter selects the changed packages and their consumers:

```bash
pnpm exec turbo run lint typecheck test build --filter="...[$BASE...$HEAD]"
```

The build dependencies are built through `dependsOn: ["^build"]`; a change in `shared` also triggers the tests and builds of the dependent apps.
The Docker matrix is built from the packages selected by Turbo.

| Change                                                                                        | Result                                                                              |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| One app                                                                                       | That app and its consumers                                                          |
| One shared package                                                                            | The package and the dependent apps                                                  |
| Documentation only                                                                            | CI tooling and root checks; no package builds or Docker, and no integration service |
| `node.Dockerfile`                                                                             | The four Node images                                                                |
| `dashboard.Dockerfile` or the nginx configuration                                             | The dashboard image                                                                 |
| `.dockerignore`                                                                               | All images                                                                          |
| Root manifest/lockfile, Turbo/Node/ESLint/Prettier configuration, `.github/` or `scripts/ci/` | Full check and all images                                                           |
| First push, unavailable history, manual run, or a version tag                                 | Full check and all images                                                           |

Available images: `gateway`, `control-api`, `worker`, `mock-provider`, and `dashboard`.
The Dockerfiles in `deploy/docker/` are prerequisites for the image stage and must be available to the runner along with the repository.
Since v1.1 (card 29.1) every image is built for `linux/amd64` and `linux/arm64`. Each architecture builds natively (`ubuntu-24.04` and `ubuntu-24.04-arm` runners), is scanned by Trivy, gets its own SBOM (`sbom-<app>-<arch>`), and is pushed by digest, signed and attested on its own. The `Manifest (<app>)` job then joins both digests into one manifest list under the `sha-…` and version tags, fails unless both architectures are in it, and signs the list. `docker pull` picks the right architecture by itself.

## Integration test and local reproduction

The test [`services.integration.mjs`](../scripts/ci/services.integration.mjs) uses clients inside the containers via `docker exec`; there is no need to install SQL/Valkey clients on the runner or to publish ports.
The PostgreSQL test creates a temporary table inside a transaction, round-trips a computed cost through the `money` module, a key hash, and an encrypted credential, and then rolls back.
The Valkey test checks the `SET NX PX` lock, the TTL, and the concurrent `INCR` counter, and deletes its own keys.
These tests measure the current infrastructure and the shared package; migrations and tests for future domains are added in their respective cards.

```bash
pnpm install --frozen-lockfile
pnpm exec eslint .
pnpm exec prettier --check .github scripts/ci CI.md
node --test scripts/ci/plan.test.mjs
pnpm exec turbo run lint typecheck test build

docker run -d --name dirouter-ci-postgres \
  -e POSTGRES_USER=dirouter -e POSTGRES_PASSWORD=ci-only-password \
  -e POSTGRES_DB=dirouter_ci \
  --health-cmd='pg_isready -U dirouter -d dirouter_ci' \
  --health-interval=5s --health-timeout=3s --health-retries=12 postgres:17-alpine
docker run -d --name dirouter-ci-valkey \
  --health-cmd='valkey-cli ping' \
  --health-interval=5s --health-timeout=3s --health-retries=12 valkey/valkey:8-alpine

# After both containers are healthy:
pnpm exec turbo run build --filter=@dirouter/shared
POSTGRES_CONTAINER=dirouter-ci-postgres VALKEY_CONTAINER=dirouter-ci-valkey \
  node --test scripts/ci/services.integration.mjs

docker rm -f dirouter-ci-postgres dirouter-ci-valkey
```

In CI the services are created and removed automatically. The password values in the example are only for the disposable test database.
Integration tests run outside the Turbo cache so that a stale result does not replace a real connection to the services.

## Registry, tags, and permissions

The registry is `ghcr.io`, and the name of each image is built from the repository path (in lowercase):

```text
ghcr.io/alirezariahi/dirouter/gateway:sha-<full-commit-sha>
ghcr.io/alirezariahi/dirouter/gateway:1.2.3
ghcr.io/alirezariahi/dirouter/gateway:1.3.0-rc.1
```

On main, only the changed images are published, with the SHA tag.
A valid SemVer tag such as `v1.2.3` publishes all images with the SHA tag and the version; the `latest` tag is not produced.
Invalid `v*` tags fail. The tagged commit must be in the history of `origin/main`; this check is performed before anything enters the registry.
PRs, including PRs from forks, only build the image and do not push it to the registry; manual runs do not publish either.
No automatic deployment is performed.

| Variable/permission                                                  | Provision and use                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                                                       | Automatic from GitHub; only the image job has `packages: write` permission |
| `contents: read`                                                     | Minimum default permission for checkout                                    |
| `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_SHA` | Automatic; input for package selection                                     |
| `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`                               | Automatic; matrix output and the package selection report                  |
| `POSTGRES_CONTAINER`, `VALKEY_CONTAINER`                             | Service IDs of the same job; configurable for local runs                   |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`                  | Fixed settings of the disposable CI database; no connection to production  |
| `HUSKY=0`                                                            | Only during CI installation; the development hook is not installed         |
| `TURBO_TELEMETRY_DISABLED=1`                                         | Disables the build tool's telemetry in CI                                  |

No custom secret, dtask token, provider key, or production variable is needed for this pipeline.
If the GHCR package already exists, enable Actions access for this repository in its settings.
To prevent merging without review, enable the required check named `CI passed` for main.

## Supply chain (card 22.3)

- **`supply-chain` job** (every run): Trivy, from its image pinned by digest, scans dependencies
  and committed files for Critical vulnerabilities and secrets, and fails on any finding. It first
  scans `scripts/ci/fixtures/trivy-canary` (lodash 4.17.4, a known Critical) and requires Trivy's
  "vulnerabilities found" exit code, so a broken scanner cannot pass silently.
- **`images` job**: each image is built and loaded, scanned (fails on fixable Critical
  vulnerabilities), and gets an SPDX SBOM from Syft, kept as the `sbom-<app>` artifact for 90
  days. On trusted pushes the image is published, signed keylessly with cosign (`id-token: write`),
  the SBOM is attached as a signed attestation, and the signature is verified in the same step.
- `ci` (required) also needs `supply-chain`.

See [SECURITY.md](../SECURITY.md) for verifying a signature before deploying.

## End-to-end suite on the dev stack (card 34.1)

Workflow file: [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml), separate from `ci.yml`
and not part of the `CI passed` check. It runs on every `pull_request`, on push to `main` and on
manual runs; a new run for a PR cancels the previous one. One job, `Sprint 5 end-to-end on the
dev stack`, on `ubuntu-24.04` with a 45 minute limit:

1. Checkout and the shared setup action (the runner needs the workspace's `node_modules`: the
   scenarios load the OpenAI, Anthropic and Cohere SDKs from `apps/gateway`).
2. `api.localhost`, `admin.localhost`, `mock.localhost`, `app.localhost`, `portal.localhost` and
   `mail.localhost` are added to `/etc/hosts` as `127.0.0.1`, so name resolution does not depend
   on systemd-resolved's handling of `*.localhost`.
3. `scripts/bootstrap.sh` writes `.env` with random development secrets, as before `make up`.
4. A temporary Compose override replaces the last step of `dev-deps`: instead of `tsc --watch`
   for every package it runs `pnpm -r --filter './packages/*' run build` once (dependency order),
   then sleeps, and never restarts. Installation, `prisma migrate deploy` and `prisma generate`
   are unchanged, and the apps still wait for its health check (every `dist/index.js` present).
   A watcher or a restart of `dev-deps` can wipe `packages/*/dist` under running apps; a one-shot
   build cannot.
5. `docker compose -f compose.yaml -f compose.dev.yaml -f <override> up -d --build --wait` starts
   Traefik, PostgreSQL, Valkey, Mailpit, the mock provider, `dev-deps`, control-api, gateway and
   worker (the dashboard and portal are not needed by the scenarios).
6. It waits until `http://admin.localhost/readyz` and `http://api.localhost/healthz` answer
   through Traefik, runs `make seed`, makes `.data/seed-admin.env` (written by root in the
   container, mode 600) readable by the runner, and waits for `http://api.localhost/readyz`
   (the gateway has loaded a configuration snapshot).
7. `node scripts/e2e/sprint-5.mjs`. Its JSON summary is turned into annotations by
   [`scripts/ci/e2e-annotations.mjs`](../scripts/ci/e2e-annotations.mjs): one error per failed
   scenario with its message and stack, one warning listing skipped scenarios, and an error with
   the end of stderr when the runner fails outside a scenario. The result table goes to the step
   summary. GitHub keeps at most 10 error annotations per step; past nine failures the last
   annotation lists the remaining names.
8. On failure, a diagnostics step annotates the service states and the last 60 log lines of
   `dev-deps`, gateway, control-api and worker. Job logs need a GitHub sign-in; annotations of a
   public run do not.
9. `docker compose down -v --remove-orphans` always runs at the end.

The stack uses the default `postgres:17-alpine` image (no pgvector), so the semantic cache is off;
no sprint 5 scenario needs it. No secret is needed. Reproduce locally with `make up`, `make seed`
and `node scripts/e2e/sprint-5.mjs` (or one card: `node scripts/e2e/sprint-5.mjs 30.1`).

## Acceptance status

Local check on 2026-11-07: all 40 quality/build tasks succeeded; 62 existing unit tests, 9 package-selection tests (including real Git and Turbo), and 2 real service tests passed. ESLint for the CI tooling, Prettier, `actionlint`, and `git diff --check` also passed.
Five images were built on an ARM64 host, and the health of the control-api image was healthy. The Docker command for control-api did not terminate after the build/export stages finished and was stopped; therefore this run does not confirm complete success of the Docker command. The Linux AMD64 runner and GHCR publishing have not been verified yet.

The local check does not replace the GitHub run. The criterion "the pipeline on the main branch is green" is confirmed after the commit/push and after observing a successful run on main.
The half-finished Dockerfiles of card 2.1 must also be in the repository checkout; their presence on the local disk alone is not enough for the runner.
Code review sign-off is a separate step; running the tools does not tick it off in its place.

## References

- [CI execution and Git filter in Turborepo](https://turborepo.dev/docs/crafting-your-repository/constructing-ci)
- [PostgreSQL service in GitHub Actions](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
- [Publishing Docker images with GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [SHA and SemVer tags in docker/metadata-action](https://github.com/docker/metadata-action)
