---
name: wiki-propose-change
version: "1.0.0"
description: Prepare a reviewed, hash-guarded Wiki edit without changing the Wiki.
mode: PLAN
requiredTools: paperclipWikiGetPage,paperclipWikiProposeChange
capabilities: wiki-read,wiki-diff
---

# Wiki Propose Change

NAME: wiki-propose-change
VERSION: 1.0.0
DESCRIPTION: Produce a non-mutating Wiki change proposal and diff.
MODE: PLAN
ALLOWED OPERATIONS: read, validate current hash, prepare replacement content, propose diff.
REQUIRED INPUTS: page, expectedHash from a fresh read, and complete replacement content.
PRECONDITIONS: Read the target page immediately before proposing; retain its hash.
WRITE SCOPE: none.
FORBIDDEN PATHS: raw/, AGENTS.md, templates/, ingestion sources, runtime configuration, skill files, .git/, .env files, credentials, secrets, traversal paths.
CONFLICT HANDLING: return WIKI_HASH_CONFLICT if expectedHash is stale; never retry with a forced write.
IDEMPOTENCY: identical proposals are safe; proposals do not mutate state.
FAILURE MODES: INSUFFICIENT_SCOPE, COMPANY_ACCESS_DENIED, WIKI_PATH_FORBIDDEN, WIKI_HASH_CONFLICT.
OUTPUT CONTRACT: proposalId, page, baseHash, resultingHash, diff, changed, and warnings.

READ is distinct from PROPOSE and APPLY. This skill must not call apply.
