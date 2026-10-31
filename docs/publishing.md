# Package identity and publication

Status: **proposal, not an approved identity or a published package** (2026-10-31).
Issue [#14](https://github.com/The-Running-Dev/SubZeroDev.MemoryKit/issues/14) stays open.
The implementation plan is complete; that does not grant permission to publish.

## Recommendation and evidence

Recommend **`subzerodev-memorykit` on `https://registry.npmjs.org`**, subject to the owner's
explicit approval. This recommendation follows registry and sibling-repository inspection;
it does not treat the existing placeholder as an earlier decision.

Direct anonymous registry GETs on 2026-10-31 returned:

| Candidate                    | npmjs result                    | Ownership and consistency                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subzerodev-memorykit`       | 404, no public package returned | Matches the verified public `subzerodev-data-json@0.3.0` and `subzerodev-platform-ui-landing-page@0.5.0`, both maintained by npm user `therunningdev`. No scope prerequisite. First-publication rights still require an authenticated registry check.                              |
| `@subzerodev/memorykit`      | 404, no public package returned | Matches the newer Plugins.GitHub and ServiceContract manifests, but those packages also returned 404 on npmjs. npm's organization membership endpoint returned `{"subzerodev":"owner"}` for `subzerodev`. No evidence establishes that `therunningdev` controls that organization. |
| `@the-running-dev/memorykit` | 404, no public package returned | Matches GameEngine's GitHub Packages namespace. A GitHub login does not confer the same scope on npmjs. The npm organization endpoint returned 404; that does not rule out an npm user scope.                                                                                      |
| `memorykit`                  | 200, `0.1.0-alpha3`             | Already maintained by `wtongze`; do not publish or use bare `npx memorykit` to fetch this unrelated package.                                                                                                                                                                       |

A 404 is a point-in-time public lookup, not a reservation, an authenticated permission check
or a guarantee npm will accept the name. Search results alone are insufficient. No npm token,
logged-in npm configuration or authenticated scope membership was available in this session.
GitHub repository administration access does not supply npm publishing rights. Repository
secret values and npm account control have not been inspected.

The scoped brand is reasonable **if the owner can establish control of `@subzerodev`**.
Without that evidence, the unscoped name is consistent with packages actually published from
this ecosystem and avoids claiming an unverified namespace. Changing identity after release
changes dependency keys and imports; settle it before publishing. npm packages cannot be
renamed in place. Do not silently fall back to another name if a publish fails.

## Registry choice

Use npmjs for public distribution: consumers can install public packages without credentials.
Scoped packages need `--access public`; `publishConfig` pins both the registry and access.
The repository intentionally has no consumer `.npmrc` that redirects a whole scope.

GitHub Packages supports scoped npm packages only. For this repository the natural identity
would be `@the-running-dev/memorykit`, with an `@the-running-dev:registry=https://npm.pkg.github.com`
mapping. GitHub's npm registry requires authentication even for public package downloads
(typically a classic PAT with `read:packages`), defaults new packages to private, and uses
`GITHUB_TOKEN` with `packages: write` for publication from the linked repository. This adds
consumer setup and is a different release target, not an npmjs mirror. The prepared workflow
intentionally supports npmjs only; choosing GitHub Packages requires an explicit metadata,
workflow, visibility and documentation change.

GameEngine's release workflow supplies the useful existing conventions: a real `v*` tag is
required to publish; PR/manual runs only validate; inspect and hash the archive; run the
installed consumer; publish those exact bytes; fail closed on unknown registry status.
Plugins.GitHub supplies the npmjs/public/provenance convention. MemoryKit previously had CI
but no release workflow to invoke or extend.

## Imports and installation

Current local and proposed npmjs imports:

```ts
import { initStore, openStore } from 'subzerodev-memorykit';
import { GitHistory } from 'subzerodev-memorykit/history-git';
```

If a scoped identity is selected, update the manifest and lockfile root names, README and
consumer imports, and the installed root-resolution assertion together:

```ts
// Alternative only; not an additional package or a compatibility alias.
import { openStore } from '@subzerodev/memorykit';
import { GitHistory } from '@subzerodev/memorykit/history-git';
```

The root SDK, separate `/history-git` entry, lazy Git loading and `memorykit` executable
remain the same. Internal deep imports remain blocked. No published placeholder consumers
have been identified; no alias package is being introduced.

Before publication, use only the local packed installation from the README. After an actual
verified npmjs release under the recommended name, the commands would be:

```bash
npm install subzerodev-memorykit@0.1.0 --registry=https://registry.npmjs.org
npx --no-install memorykit --help
```

For a global CLI install or a one-off invocation, after publication:

```bash
npm install --global subzerodev-memorykit@0.1.0 --registry=https://registry.npmjs.org
memorykit --help
npm exec --registry=https://registry.npmjs.org --package=subzerodev-memorykit@0.1.0 -- memorykit --help
```

A scoped choice changes `--package` and the installation target, never the binary name.
These future examples are not evidence that version 0.1.0 exists on a registry.

## Owner-controlled prerequisites

1. Approve the exact package name and npmjs/public destination. For a scoped name, confirm
   authenticated membership and write permission in that npm scope. Recheck availability.
2. Review the proposed metadata, declared MIT license text and package contents. Keep
   `private: true` until the identity is approved. Then set it to `false` in a reviewed change;
   update all name references if the scoped alternative is selected.
3. Configure the GitHub `npm` environment with repository/environment variables
   `MEMORYKIT_NPM_PACKAGE` (exact approved name) and `MEMORYKIT_NPM_REGISTRY`
   (`https://registry.npmjs.org`). Environment protection and tag restrictions are owner
   settings, not something merely naming an environment guarantees.
4. Supply publishing authority without committing credentials. For the first release,
   use a narrowly scoped, short-lived granular npm token allowed to create the approved
   package, with bypass 2FA if needed by automation, as environment secret `NPM_TOKEN`.
   A local GitHub connector session or `GITHUB_TOKEN` cannot publish to npmjs.
   Once the package exists, prefer npm trusted publishing: GitHub owner `The-Running-Dev`,
   repository `SubZeroDev.MemoryKit`, workflow filename `release.yml`, environment `npm`,
   with direct `npm publish` allowed. A newly added trusted publisher must be validated
   within npm's documented expiry window. Do not assume package settings can be configured
   before a first package exists. Remove the bootstrap token after OIDC works.
5. Merge the reviewed preparation and approved identity change; validation alone never
   merges, creates a release tag or publishes. Create an owner-authorized `v0.1.0` tag on a
   clean commit contained in `main`. The workflow checks tag/version, private status,
   approved identity/destination and ancestry before publishing.

Trusted publishing requires a supported GitHub-hosted runner, Node >=22.14 and npm >=11.5.1.
The workflow uses Node 24 and checks the bundled npm version before publishing. Public
repository/public package publication uses provenance; no downgrade to an unsigned/manual
fallback occurs automatically. Later retries must not reuse an already published version.

## Validation and publication workflow

`release.yml` runs the supported Node/OS matrix, builds a clean distribution, inspects the
actual tar entries, rejects unexpected files and credential signatures, hashes the bytes,
and passes that exact archive to `npm run check:package -- /absolute/path/to/candidate.tgz`.
The installed consumer exercises CLI init/create/get, declaration resolution, public SDK,
blocked deep imports, memory/none isolation, Git composition and supersede retry/recovery.
Only `dist` JavaScript/declarations, README, manifest and LICENSE may ship; source, tests,
fixtures (including TLS keys), evaluation models, `.env`, `.npmrc`, `.git` and local stores
are excluded. Signature checks are a focused check, not proof that arbitrary secrets cannot
exist in program text. The file allowlist and clean build are the primary controls.

PR and `workflow_dispatch` runs cannot reach publication. A successful tag run downloads the
verified candidate, rechecks its digest, queries npmjs (404 means no public package; 200 must
show this version absent; all other errors block), and publishes the tarball with lifecycle
scripts disabled. This deliberately avoids repacking or executing missing repository-only
scripts from the archive. The final step fetches the public version metadata and tarball
without authentication and compares SHA-512 integrity with the tested archive.

A post-publication verification failure does not undo publication. Investigate registry
state before retrying; never claim the release failed to exist just because a later check
failed. No `npm publish`, staging, placeholder reservation or release tag has been performed
as part of this preparation.

## Primary references

- [npm scopes](https://docs.npmjs.com/about-scopes/)
- [Public scoped publishing](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [GitHub npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
- [Verified public Data.Json metadata](https://registry.npmjs.org/subzerodev-data-json)
- [Verified public landing-page metadata](https://registry.npmjs.org/subzerodev-platform-ui-landing-page)
- [SubZeroDev npm organization membership](https://registry.npmjs.org/-/org/subzerodev/user)
- [GameEngine release conventions](https://github.com/The-Running-Dev/SubZeroDev.GameEngine/blob/main/.github/workflows/release-engine-package.yml)
- [Plugins.GitHub npmjs release conventions](https://github.com/The-Running-Dev/SubZeroDev.Plugins.GitHub/blob/main/.github/workflows/release.yml)
