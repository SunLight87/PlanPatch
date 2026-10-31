# PlanPatch

A small review workbench for community-event plans that have fallen out of sync with their source material.

PlanPatch puts the original plan, proposed changes, registration attachment, source references and unresolved questions in one page. Three Mozaik agents cooperate; a deterministic coordinator is the only component allowed to commit a revision.

## Run the demo

Use Node.js 24 or newer:

```sh
npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0
npm test
npm start
```

Open **http://127.0.0.1:4317**. Choose a sample, run the check, follow its source links and freeze the result as a JSON bundle. The interface is in Chinese. Both sample events and all their materials are fictional.

The web demo is explicitly **MOCK**: real Mozaik Agent instances and runtime events execute with deterministic local inference. It sends no model requests. There are no credentials or production spending records in this repository.

## Concurrent collaboration

1. **A — facts** and **B — review** start on separate Mozaik Agent instances at the same time.
2. A publishes source-backed evidence. **C — plan owner** consumes the new evidence snapshot without waiting for B's first review.
3. The coordinator validates the proposal and evidence versions, reserves the necessary review capacity, and applies only supported changes.
4. B reviews every affected requirement in one batch. Stale checks are rejected. Unknowns remain visible; they are not converted into a pass.

The main scenario changes a venue capacity from 40 to 24, keeps 36 registrations, puts 12 people on a waiting list, updates the time to 14:00–16:00 and keeps the unconfirmed weather backup unresolved. The attachment is updated consistently. A second sample demonstrates that an already-consistent plan remains unchanged.

## Verification and current status

The current source passed **205 offline tests**, a fresh installation in a separate local directory, and independent checks of the budget/recovery logic. These checks do not establish real model quality. See [current verification](evidence/current-verification.json) and the [complete source manifest](evidence/product-revision.json).

The real-provider entry is separate from the web demo. A previous attempt timed out. The current version's one-time recovery is awaiting explicit confirmation under the original fixed budget; **current-version LIVE acceptance is not yet complete**. No speedup, live effectiveness or competition acceptance is claimed.

The protocol is deliberately limited to the included short-plan domain. Free-text constraints require human review. Local cancellation does not prove remote cancellation. This is a prototype, not a general-purpose document editor.

## Dependencies and provenance

The project pins `@mozaik-ai/core` **4.0.0-beta.8**, a prerelease whose used APIs have been tested here. This version does not depend on Cloud SDK. The lock was generated independently from the product manifest; 141 installed dependency entries have 144 corresponding notice files. See [notices](docs/third-party-notices.md) and the [dependency inventory](docs/dependencies.json).

The event implementation, prompts, UI and fictional samples were created during the hackathon. AI coding assistants helped author code, tests and documentation. Pre-event design and general utility reuse, plus the earlier lock's historical lineage, are disclosed in [reuse.md](docs/reuse.md). Historical Cloud SDK/examples inquiries remain unanswered; the related materials are excluded from this release.

## 中文说明

PlanPatch 把活动原方案、修订方案、报名附表、来源和未决事项放在同一页。A 核对事实、B 审阅方案并发启动；A 发布新证据后触发 C 提出修订，协调器校验版本并统一写入，再由 B 完整复查受影响内容。

网页默认演示明确标为 MOCK，不调用模型、不读取密钥。主样本展示场地缩容后的时间、人数和候补调整；无变化样本验证不会为了改写而改写。冻结导出保留来源与检查记录。真实模型验收、人工语义复核和比赛提交结果按实际证据分别记录，不由离线测试推断。
