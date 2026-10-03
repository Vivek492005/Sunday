# Third-Party Notices — SUNDAY

This repository contains code under licenses other than the SUNDAY
Apache-2.0 license (see `LICENSE` at the repo root). This file records
the significant third-party components bundled in this repository.

## Vendored Visual Studio Code (Code-OSS)

- **Location:** `vscode/`
- **Upstream:** https://github.com/microsoft/vscode (tag v1.140.0)
- **License:** MIT License — Copyright (c) Microsoft Corporation.
  All rights reserved.
- The full license text is in `vscode/LICENSE.txt`.
- SUNDAY's own patches on top of the vendored tree are documented in
  `vscode/SUNDAY_UPSTREAM.md`. Patches do not change the upstream license.

## Runtime dependencies

All npm dependencies are listed in `pnpm-lock.yaml` with their own
licenses. A generated CycloneDX SBOM is published at `docs/sbom.json`.
