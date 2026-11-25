# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report privately through GitHub's
[security advisories](https://github.com/alirezariahi/dirouter/security/advisories/new) for this
repository, with:

- the affected component (gateway, control-api, worker, dashboard, portal, deployment files),
- the version or commit,
- steps to reproduce, and the impact you expect.

We acknowledge reports within three working days and aim to ship a fix for Critical and High
issues within fourteen days. We credit reporters in the release notes unless asked not to.

## Supported versions

Security fixes go to the latest release and to `main`. Older releases are not patched.

## What we do to keep releases trustworthy

- Every CI run scans dependencies and committed files for Critical vulnerabilities and secrets
  (Trivy). It fails on any finding, and it first proves the gate works against a canary lockfile
  with a known Critical vulnerability.
- Every image is scanned before it is published, and CI fails on Critical vulnerabilities that
  have a fix.
- Every image gets an SPDX SBOM (Syft), kept as a CI artifact and attached to the image as a signed
  attestation.
- Published images are signed keylessly with cosign (Sigstore), bound to this repository's CI
  workflow. Verify an image before deploying it:

  ```bash
  cosign verify ghcr.io/alirezariahi/dirouter/gateway@sha256:<digest> \
    --certificate-identity-regexp '^https://github.com/alirezariahi/dirouter/\.github/workflows/ci\.yml@' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

- Third-party GitHub Actions are pinned to commit SHAs, and the scanners run from images pinned by
  digest.

The threat model is in [docs/security/threat-model.md](docs/security/threat-model.md), and the
penetration test checklist with its latest results in
[docs/security/pentest-checklist.md](docs/security/pentest-checklist.md).
