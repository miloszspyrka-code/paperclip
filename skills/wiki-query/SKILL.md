---
name: wiki-query
version: "1.0.0"
description: Discover and read safe Paperclip Wiki pages without modifying them.
mode: PLAN
requiredTools: paperclipWikiList,paperclipWikiSearch,paperclipWikiGetPage,paperclipWikiGetMetadata
capabilities: wiki-read,wiki-search
---

# Wiki Query

NAME: wiki-query
VERSION: 1.0.0
DESCRIPTION: Discover, search, inspect metadata, and read permitted Wiki pages.
MODE: PLAN
ALLOWED OPERATIONS: list, search, metadata, read.
REQUIRED INPUTS: authenticated company context and a page or search query when applicable.
PRECONDITIONS: Use resource discovery or search before reading a page.
WRITE SCOPE: none.
FORBIDDEN PATHS: raw/, AGENTS.md, templates/, ingestion sources, runtime configuration, skill files, .git/, .env files, credentials, secrets, traversal paths.
CONFLICT HANDLING: not applicable; this skill never writes.
IDEMPOTENCY: all operations are read-only.
FAILURE MODES: INSUFFICIENT_SCOPE, COMPANY_ACCESS_DENIED, WIKI_PATH_FORBIDDEN, page not found.
OUTPUT CONTRACT: return page URI, title, description, type, hash, and requested content or compact matches.

READ is distinct from PROPOSE and APPLY. Do not call a mutation tool.
