# Pre-event reuse disclosure

Formal product directory, synthetic samples, product prompts and UI were created after the official kickoff on 30 October 2026. Actual work began during the 21:27 Shanghai wake, not at 17:00.

Reused design inputs: PlanPatch's three roles, single writer, separate proposal/evidence versions, bounded generation policy, and 15-item acceptance plan from the October 5 design. That design was not an implemented product. Official October 30 track/schedule requirements supersede its stale dates/theme fields.

Historical dependency-lock lineage: the first event version started from the pre-event isolated `custom-inference-runner` toolchain lock, with PlanPatch root metadata and core 4.0.5. That old lock is retained in the private development history and is not the current release lock. The current core beta.8 lock was independently generated in an empty directory containing only the updated product package.json; no old examples lock was copied into that process. Initial historical offline installation failed due to an absent zod cache entry; later installation succeeded with scripts disabled. These are separate recorded operations.

Mozaik API shape was inspected in installed 4.0.5 code and generic learning references. Event runtime, mock runner and product prompts are newly written; official example source was not copied. The examples repository's applicable notice remains an unresolved historical reuse inquiry, not a resolved rights determination.

Safe diagnostics are adapted from the pre-event generic probe in `work/one-shot-probe-20261027/diagnostics.mjs` (status, allowlisted code/type, strict Retry-After, bounded body); this is disclosed pre-event utility reuse. The budget/provider integration was written and tested during the event. The exhausted pre-event 429 ledger/result and pre-event acceptance register are preserved; no old model request or generic test is claimed as a product live run.

No image, video, voice, external dataset or person identity is used in the product. Numbers and documents are fictional event-period fixtures. Dependency notices are tracked separately; no complete rights-ready assertion.


---

# Dependency and historical reuse addendum

## Current release dependency scope

The current lock is independently generated from the updated formal `product/planpatch/package.json`; it is not copied from the earlier compatibility lock. The audited root is `planpatch@0.1.0` with `141` exact installed lock entries. `@mozaik-ai/cloud-sdk` is absent from both the current lock and installed tree.

The selected `@mozaik-ai/core` dependency is `4.0.0-beta.8`, a beta/pre-release. The current lock integrity, archived package tarball SRI, tarball file set, and installed core package file bytes were checked together. This does not make the dependency a stable release or settle licensing questions outside the included files.

All discovered named notices (and qualifying README license text where no named notice exists) were read in full, copied under `docs/notices/`, and checked for exact byte/hash equality. The detailed per-package inventory is in `docs/dependencies.json`; linked notice texts are listed in `docs/third-party-notices.md`.

## Historical items remain open

- **R01 — Cloud SDK:** `OPEN_HISTORY`. No upstream response was received. Cloud SDK is not in this release's lock/install, so its files are not part of this dependency notice set. That removal does not answer or clear the historical inquiry.
- **R02 — official examples:** `OPEN_HISTORY`. No upstream response was received. The current release scope excludes historical examples copies; that exclusion does not answer or clear the historical inquiry.

These current-scope changes reduce what is distributed now; they do not establish historical provenance, rights clearance, or legal approval. The bounded term checks in the inventory are not a legal opinion.
