---
name: paperclip-deleguj-coo
description: Route a larger goal from the current operational entry point to the narrowest downstream owner with deduplication and real dependencies. When the execution actor is COO, never delegate to COO itself. Explicit aliases: /coo, /delegate-coo.
---

# Paperclip Deleguj COO

## Shared execution contract

Explicit `MODE` per shared contract v2.0.0: `DIAGNOSE` (default) or `PLAN`.
This skill is coordination-only: it never mutates directly and never starts
work itself. Issue creation/assignment/status changes happen through dedicated
tools in a separate, explicitly requested EXECUTE operation. Handoff depth
limit 2; loops terminate with `HANDOFF_LOOP_BLOCKED`.

## Standard flow

USER GOAL -> READ CURRENT PAPERCLIP STATE -> FIND EXISTING RELEVANT TASKS ->
DETERMINE MISSING WORK -> ROUTE FROM CURRENT COO ENTRY TO THE NARROWEST OWNER ->
ASSIGN OWNERS -> SET DEPENDENCIES -> START READY WORK

When the MCP execution actor is COO, `paperclip-deleguj-coo` means downstream
routing, never `COO -> COO`. Route engineering risk to CTO, implementation to
Engineer, design to Designer, UI acceptance to UI QA, and marketing/onboarding
to CMO. Escalate to CEO only for governance, control-plane, organization, or
strategic decisions that exceed COO authority.

## COO entry routing

| Request class | Route |
| --- | --- |
| Engineering diagnosis, architecture, security, migration, or technical preflight | `COO -> CTO -> Engineer` when implementation is needed |
| Scoped implementation after an established technical plan | `COO -> Engineer` |
| Design or UX | `COO -> Designer` |
| UI acceptance or browser regression | `COO -> UI QA` |
| Marketing, onboarding, or email | `COO -> CMO` |
| Governance, control plane, organization, or exceptional strategy | `COO -> CEO` only when COO authority is insufficient |

Never create a CEO parent issue for a standard delivery request. Reuse the
source issue and assign or hand off to the routed owner.

Before creating anything, read the live Paperclip state. Inspect `backlog`,
`todo`, `in_progress`, `in_review`, `blocked`, and recently `done` issues.
Search by goal, project, title, and scope. If identical work already exists in
ANY of those statuses - including `in_review` - update or use it; do not create
a duplicate and do not assume `in_review` means no existing work.

Do not create a meta-task whose only purpose is to describe other tasks. Prefer
existing projects, workspaces, and goals. Create a new structure only when the
live state has no suitable one.

## SEGMENTATION

Use the narrowest capable owner:

- `ENGINEER`: implementation, code, tests, Git, and scoped deployment work.
- `UI QA`: browser validation, regression, visual/function smoke, Playwright.
- `DESIGNER`: UX/UI specification, visual decisions, design exploration.
- `CMO`: campaigns, onboarding messaging, growth operations, Sender config.
- `CTO`: architecture, security, migrations, difficult infrastructure, risky
  technical decisions only.
- `COO`: coordination, decomposition, dependency ordering, status, and
  cross-agent ownership.

Do not add CTO to normal implementation plus QA without a concrete architecture,
security, migration, infrastructure, or risk reason.

## Task contract

Every created or materially updated task must contain:

`CEL`, `OWNER`, `SCOPE`, `OUT_OF_SCOPE`, `ACCEPTANCE`, `EVIDENCE`,
`DEPENDENCIES`, and `FINAL_STATE`.

Use `blockedByIssueIds` for real execution dependencies. Do not use `parentId`
as a dependency substitute. A parent describes hierarchy; `blockedByIssueIds`
controls readiness and wake-up behavior.

Typical chain:

implementation -> QA validation -> release/deploy

Only add an edge when the later task genuinely cannot start before the earlier
one.

## Idempotent creation (EXECUTE operations)

When an explicitly authorized EXECUTE operation creates issues, derive a stable
`idempotencyKey` from: company + normalized goal + normalized scope + project +
owner role. Reuse the issue returned for the same key; run the operation twice
and you must get the same issue id, zero duplicate work. Never use
`allowDuplicate=true` unless there is explicit evidence the duplicate is
intentional.

## WIP guard

`START READY WORK` never means starting an arbitrary number of tasks. Respect
existing WIP limits and real dependencies: start only ready tasks that fit in
available WIP slots and have empty `blockedBy`. In `PLAN` mode start nothing.
In `EXECUTE` mode start only tasks explicitly inside the operation scope.

## Deduplication

Compare normalized goal, scope, repository, acceptance, owner, and current
status. A close title match is not enough; a clearly identical scope is enough
to reuse. Report the reused issue and why no duplicate was created.

## Required output

Common result envelope first:

`SKILL:` / `SKILL_VERSION:` / `MODE:` / `RESULT: PASS | FAIL | BLOCKED | HANDOFF` /
`ROOT_CAUSE_LAYER:` / `OBSERVED_FAILURE_LAYER:` / `CONTRIBUTING_LAYERS:` /
`CONFIDENCE:` / `EVIDENCE_REFERENCES:` / `WRITES_PERFORMED:` / `HANDOFF_TO:` /
`RETRY_SAFE:` / `ROLLBACK_REQUIRED:` / `NEXT_SINGLE_ACTION:`

Domain output:

GOAL:
EXISTING_RELEVANT_TASKS:
NEW_TASKS_CREATED:
TASKS_UPDATED:
IDEMPOTENCY_KEYS:
WIP_ACTIVE:
WIP_LIMIT:
TASKS_STARTED_THIS_OPERATION:

SEGMENTATION:
- TASK -> AGENT

DEPENDENCIES:
- A blockedBy B

WORK_STARTED:
BLOCKERS:
COO_ACTION:
NEXT_MILESTONE:
