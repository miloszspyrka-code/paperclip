---
name: wiki-apply-change
version: "1.0.0"
description: Apply a previously prepared Wiki proposal only with the unchanged expected hash.
mode: EXECUTE
requiredTools: paperclipWikiApplyChange
capabilities: wiki-write,wiki-concurrency
writeScope: wiki-pages
requiresExpectedHash: true
---

# Wiki Apply Change

NAME: wiki-apply-change
VERSION: 1.0.0
DESCRIPTION: Commit one reviewed Wiki proposal without forcing concurrent changes.
MODE: EXECUTE
ALLOWED OPERATIONS: apply an existing proposal once with its original expectedHash.
REQUIRED INPUTS: proposalId and expectedHash returned by wiki-propose-change.
PRECONDITIONS: Proposal was reviewed; expectedHash is unchanged; an EXECUTE operation envelope is active.
WRITE SCOPE: wiki-pages only.
FORBIDDEN PATHS: raw/, AGENTS.md, templates/, ingestion sources, runtime configuration, skill files, .git/, .env files, credentials, secrets, traversal paths.
CONFLICT HANDLING: return WIKI_HASH_CONFLICT and do not write when the page changed after proposal.
IDEMPOTENCY: a duplicate successful apply returns its prior result without a second write.
FAILURE MODES: INSUFFICIENT_SCOPE, COMPANY_ACCESS_DENIED, WIKI_PATH_FORBIDDEN, WIKI_HASH_CONFLICT, proposal not found, write guard denial.
OUTPUT CONTRACT: previousHash, newHash, changed, page, and audit outcome.

READ is distinct from PROPOSE and APPLY. Do not create or edit content implicitly.
