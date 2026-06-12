# ADR: Unifying the Shared Package as a Single Source of Truth (FIX-BE-6)

- **Status:** Accepted (recommendation)
- **Date:** 2025
- **Decision drivers:** Eliminate manual-copy drift of `@alsaqi/shared` between the Backend (`alsaqi-backend`) and Frontend (`alsaqi-frontend`) repositories.
- **Requirements addressed:** 6.1, 6.2, 6.3, 6.4, 6.5

## Context

The `packages/shared` package (`@alsaqi/shared`, currently version `1.0.0`) holds the cross-repo contract surface: domain models (`src/types/models.ts`), enums, per-endpoint typed contracts (`src/types/endpoints/*`), and Zod validators (`src/validators/*`). It is the agreed single contract that both repositories are supposed to consume.

In practice the package is **manually copied (duplicated)** into both the Backend and the Frontend repositories. The two copies are kept in step by hand. This is the root cause of recurring type drift between the repos, and it is exactly the manual operation that FIX-BE-1 performs when it re-synchronizes `packages/shared/src/types/models.ts` against the Frontend copy.

Manual synchronization is error-prone, invisible to code review (the drift only surfaces at runtime or in unrelated build failures), and does not scale as the contract surface grows. We need a structural fix so that one edit to the shared contract is consumed by both repositories without any hand-copying.

Three industry-standard approaches were considered:

1. **Published versioned package** — publish `@alsaqi/shared` to a registry (private npm registry or GitHub Packages) and have each repo depend on a semver version.
2. **Git submodule** — host the shared sources in their own git repository and embed it into both repos as a git submodule pinned to a commit.
3. **Monorepo** — host the Backend, the Frontend, and the shared package in a single repository as workspace packages.

## Comparison of the three approaches

The advantages and disadvantages below are stated **relative to one another**, so the trade-off between any two approaches is explicit.

### 1. Published versioned package (private registry, e.g. `@alsaqi/shared`)

**Advantages (relative to the other two)**
- **Explicit, auditable versioning.** Unlike the submodule (which pins an opaque commit SHA) and the monorepo (which has no version boundary at all), each consumer declares a human-readable semver range. Breaking changes are signalled by a major bump.
- **Clean dependency boundary.** Consumers run a normal `npm install`; there is no extra tooling step like `git submodule update`, and no requirement to co-locate the two app repos as the monorepo demands.
- **Lowest disruption to current repo layout.** The Backend and Frontend stay as separate repositories with their existing CI/CD, branch protection, and access controls untouched — the monorepo would force all of that to be merged and re-designed.
- **Independent release cadence.** Each repo upgrades on its own schedule, which the monorepo cannot offer (everything moves together) and which the submodule offers only awkwardly (via manual pointer bumps).

**Disadvantages (relative to the other two)**
- **Publish step in the loop.** A change to the contract requires building and publishing a new version before consumers can pick it up — heavier than the monorepo, where a contract edit is instantly visible to all packages in the same commit.
- **Registry infrastructure required.** Needs a private registry (or GitHub Packages) plus auth tokens in local and CI environments. The submodule needs only git; the monorepo needs only the existing repo.
- **Possible version skew.** Because each repo pins its own version, the two repos can temporarily run different contract versions — a class of drift the monorepo eliminates entirely by construction.

### 2. Git submodule

**Advantages (relative to the other two)**
- **Single source files, no registry.** The shared sources live in exactly one git repo and are embedded directly; there is no publish/registry overhead that the versioned package requires.
- **Exact pinning.** Each consumer locks to a precise commit SHA, giving reproducible builds without depending on a registry's version resolution.
- **Repos stay separate.** Like the published package and unlike the monorepo, the Backend and Frontend remain independent repositories.

**Disadvantages (relative to the other two)**
- **Poor developer ergonomics.** Submodules are a well-known source of friction: developers forget `git submodule update --init --recursive`, clone without `--recurse-submodules`, and end up building stale or empty contract code. Neither the published package (plain `npm install`) nor the monorepo (everything in one checkout) has this failure mode.
- **No semantic versioning.** A pinned SHA carries no compatibility signal, so consumers cannot tell a patch from a breaking change the way the published-package approach makes explicit.
- **Two-step changes.** Editing the contract means committing in the submodule repo, then bumping the pointer in each consumer — more moving parts than the monorepo's single commit and comparable friction to publishing.
- **Tooling rough edges.** TypeScript path resolution, IDE indexing, and CI caching all need extra configuration for submodules, more so than for an installed package.

### 3. Monorepo

**Advantages (relative to the other two)**
- **Zero version skew, atomic changes.** A contract change and the consuming changes in both apps land in a single commit/PR. This eliminates drift completely — stronger than the published package (which can skew) and the submodule (which can go stale).
- **Best local DX for cross-cutting work.** One checkout, one install, instant type feedback across packages via workspace linking — no publish step, no submodule sync.
- **Single CI pipeline and shared tooling.** Linting, type-checking, and tests for the contract and both apps run together.

**Disadvantages (relative to the other two)**
- **Large, disruptive migration.** Merging two established repositories means rewriting CI/CD, deployment, branch protections, and access control — far more upfront cost than adding a registry dependency or a submodule.
- **Loss of independent release/access boundaries.** The two apps can no longer be versioned, deployed, or permissioned fully independently, which both the published package and the submodule preserve.
- **Tooling and scale overhead.** Requires a workspace/monorepo toolchain (npm/pnpm workspaces, and likely Nx/Turborepo for caching) and grows checkout, CI, and tooling cost as the codebase scales — overhead the other two approaches avoid.

## Decision

**Adopt the published versioned package approach.** Publish `@alsaqi/shared` to a private registry (a private npm registry or GitHub Packages) and have both repositories depend on it via a pinned semver version.

### Rationale for choosing it over the other two

- **Versus the monorepo:** The monorepo gives the strongest drift guarantee, but at a disproportionate cost. The two apps are already established, separately-deployed repositories with their own CI/CD and access controls. Merging them is a high-risk, high-effort restructuring that we do not need to take on solely to share a contract package. The published package gives us a clean single source of truth while keeping the existing repository, deployment, and permission boundaries intact.
- **Versus the git submodule:** The submodule reaches the same "single source files" goal but is consistently the worst developer experience of the three (missed `submodule update`, stale checkouts, no version semantics, brittle TS/IDE/CI integration). The published package replaces all of that with a plain `npm install` and explicit semver, which is the workflow both repositories already use for every other dependency.
- **Why it is the right balance:** The published package is the lowest-disruption option that still removes the manual copy. It introduces explicit, auditable versioning, fits the existing npm-based workflow of both repos, and keeps the repositories independent. Its main costs — a publish step and a private registry — are modest, well-understood, and fully automatable in CI. The one residual risk (temporary version skew between repos) is mitigated by CI checks and a regular upgrade cadence, and is acceptable given the benefits.

The package is already structured for this: it is named `@alsaqi/shared`, is versioned (`1.0.0`), and declares `main`/`types`/`exports` entry points.

## Consumption mechanism under the selected approach

### Backend repository (`alsaqi-backend`)

- The Backend stops treating `packages/shared` as a hand-maintained in-repo copy and instead **consumes `@alsaqi/shared` as a published dependency**, declared in the Backend `package.json` under `dependencies` with a pinned semver range (for example `"@alsaqi/shared": "1.0.0"`).
- Installation resolves the package from the private registry, configured via an `.npmrc` that maps the `@alsaqi` scope to the registry URL and supplies an auth token (sourced from an environment variable in CI; never committed).
- The package becomes the **single authoritative origin** of the shared sources. The directory that today holds the duplicated copy is no longer edited by hand; if the package continues to be developed inside this repo, it is published from here and consumed as a version by everyone (including this repo via the workspace/registry link), so there is exactly one editable copy.
- Imports remain unchanged in form (`import { ... } from '@alsaqi/shared'`); only the resolution source changes from a local copy to the installed versioned package.

### Frontend repository (`alsaqi-frontend`)

- The Frontend likewise **declares `@alsaqi/shared` in its `package.json` `dependencies`** with a pinned semver range and consumes it via `npm install`.
- The same scoped `.npmrc` registry + auth configuration is added to the Frontend so it can resolve the `@alsaqi` scope.
- The Frontend deletes its manually-copied duplicate of the shared sources and imports exclusively from the installed `@alsaqi/shared` package (`import { ... } from '@alsaqi/shared'`).
- The Frontend upgrades the contract by bumping the pinned version when it is ready to adopt a new contract release, giving it an independent, explicit upgrade point.

In both repositories the consumption mechanism is identical in spirit: a scoped, versioned npm dependency resolved from the private registry, replacing the hand-copied files.

## Migration sequence (ordered, covering both repositories)

The steps are ordered so the contract is publishable and consumable before either app removes its local copy, keeping every intermediate state buildable.

1. **Designate the canonical source.** Treat the Backend `packages/shared` as the authoritative source of the package for the initial publish (it is already named `@alsaqi/shared` and versioned). Decide the home for ongoing development of the package (kept in this repo for now, published from here).
2. **Provision the registry.** Stand up / configure the private registry (private npm registry or GitHub Packages) and create the scope `@alsaqi`, plus a publish credential for CI and read credentials for consumers.
3. **Prepare the package for publishing.** Confirm `name`, `version`, `main`/`types`/`exports`, and `files`/build outputs are correct for distribution; ensure `tsc --build` produces the published artifacts; finalize the current contract (including the FIX-BE-1 models and the FIX-BE-5 contracts/validators) as the baseline version.
4. **Publish the baseline version.** Publish `@alsaqi/shared@1.0.0` (or the next appropriate version) to the registry. Automate subsequent publishes via CI on the package's release flow.
5. **Migrate the Backend (`alsaqi-backend`).** Add the scoped `.npmrc` (registry URL + auth env var), add `@alsaqi/shared` to `dependencies` at the published version, install, and verify `import ... from '@alsaqi/shared'` resolves to the installed package. Run `npm run build` (zero errors) and the full test suite (zero failures). Stop hand-editing the in-repo copy.
6. **Migrate the Frontend (`alsaqi-frontend`).** Add the same scoped `.npmrc`, add `@alsaqi/shared` to `dependencies` at the published version, install, delete the manually-copied duplicate of the shared sources, repoint all imports to `@alsaqi/shared`, and verify the Frontend build and test suite pass.
7. **Wire CI for both repos.** Inject the registry auth token into the Backend and Frontend CI pipelines so installs succeed in CI as they do locally.
8. **Establish the change workflow.** Document that contract changes are made once in the package, published as a new version, and adopted in each repo by bumping the pinned version — replacing the manual copy workflow entirely.
9. **Retire the manual sync.** Remove any manual-copy/sync scripts or instructions and update contributor docs to reference the published-package workflow.

## Consequence: this supersedes the FIX-BE-1 manual synchronization

Once the published-package approach is adopted, both repositories consume `@alsaqi/shared` from a single published source, so there is no second copy of `packages/shared/src/types/models.ts` (or any other shared file) to keep in step by hand.

**Adopting this approach eliminates the manual synchronization of the Shared_Package performed in Requirement 1 (FIX-BE-1).** The byte-for-byte re-copying of `models.ts` between the Backend and Frontend becomes unnecessary going forward: a single edit to the package, published as a new version and pulled in by each repo, replaces the manual copy step entirely. FIX-BE-1 should therefore be understood as a one-time stop-gap that this strategy makes obsolete.
