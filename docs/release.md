[English](release.md) · [فارسی](release.fa.md)

# Releasing

DiRouter follows [semantic versioning](https://semver.org) and versions all of its packages
together with [Changesets](https://github.com/changesets/changesets) (`.changeset/config.json`).

1. With each user-visible change, add a changeset: `pnpm changeset` (choose the bump; every package
   moves to the same version).
2. To release, run `pnpm changeset version`. It applies the pending changesets, bumps every
   package and writes their `CHANGELOG.md`; summarize the release in the root `CHANGELOG.md`.
3. Commit, wait for a green CI on `main`, then tag the commit `v<version>` and push the tag.
4. The tag run of CI checks everything, then builds, scans, signs (cosign) and publishes every image
   as `ghcr.io/alirezariahi/dirouter/<app>:<version>` with its SBOM attestation. A tag that is not
   on `main` or is not valid semver is refused.
5. Write the upgrade notes when a release needs any operator action (see
   [upgrade-v1.md](upgrade-v1.md) and [upgrade-v1-1.md](upgrade-v1-1.md)).
