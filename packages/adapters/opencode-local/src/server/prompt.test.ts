import { describe, expect, it } from "vitest";
import { buildOpenCodeRunPrompt } from "./prompt.js";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "./parse.js";

const INSTRUCTIONS_PREFIX =
  "AGENT INSTRUCTIONS MARKER — permanent role rules live here.\n\n" +
  "The above agent instructions were loaded from /repo/AGENTS.md.\n\n";

function makeCtx(context: Record<string, unknown>) {
  return {
    agent: { id: "agent-1", companyId: "company-1" },
    runId: "run-1",
    context,
  } as Parameters<typeof buildOpenCodeRunPrompt>[0]["ctx"];
}

const FULL_BRIEF =
  "# Task\n\nObjective: ship the launch card.\n\nSECRET-BRIEF-DESCRIPTION-1234: Update launch-card.svg.\n";
const COMPACT_BRIEF =
  "# Task (resume delta)\n\nObjective reference retained; description omitted from this delta.\n";

const ISSUE = {
  id: "issue-1",
  identifier: "KOMAA-57",
  title: "Optimize context budget",
  description: "SECRET-BRIEF-DESCRIPTION-1234: Update launch-card.svg.",
  descriptionTruncated: false,
  status: "in_progress",
};

const COMMENT_WINDOW = { requestedCount: 0, includedCount: 0, missingCount: 0 };

const config = {
  promptTemplate: "HEARTBEAT TEMPLATE MARKER run={{ runId }}",
  bootstrapPromptTemplate: "",
};

describe("buildOpenCodeRunPrompt", () => {
  it("A. fresh assignment: full brief once, instructions and heartbeat template present", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({
        paperclipTaskMarkdown: FULL_BRIEF,
        paperclipTaskMarkdownCompact: COMPACT_BRIEF,
        paperclipWake: {
          reason: "issue_assigned",
          issue: ISSUE,
          commentWindow: COMMENT_WINDOW,
          comments: [],
          fallbackFetchNeeded: false,
        },
      }),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: null,
    });

    expect(built.promptMetrics.instructionsChars).toBe(INSTRUCTIONS_PREFIX.length);
    expect(built.promptMetrics.taskContextChars).toBe(FULL_BRIEF.trim().length);
    expect(built.promptMetrics.heartbeatPromptChars).toBeGreaterThan(0);
    // Issue description appears exactly once (task-context markdown is
    // authoritative; wake copy suppressed).
    expect(built.prompt.split("SECRET-BRIEF-DESCRIPTION-1234").length - 1).toBe(1);
    expect(built.prompt).toContain("HEARTBEAT TEMPLATE MARKER");
  });

  it("B/C. normal resumed comment wake: delta-first, zero re-injected instructions/template, compact brief", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({
        paperclipTaskMarkdown: FULL_BRIEF,
        paperclipTaskMarkdownCompact: COMPACT_BRIEF,
        paperclipWake: {
          reason: "issue_commented",
          issue: ISSUE,
          commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
          comments: [{ id: "c1", authorName: "CEO", body: "NEW-COMMENT-DELTA-5678" }],
          fallbackFetchNeeded: false,
        },
      }),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: "session-1",
    });

    // The core regression: resumed wakes must NOT re-send AGENTS.md.
    expect(built.promptMetrics.instructionsChars).toBe(0);
    expect(built.prompt).not.toContain("AGENT INSTRUCTIONS MARKER");
    // Heartbeat template stays out of resume deltas.
    expect(built.promptMetrics.heartbeatPromptChars).toBe(0);
    expect(built.prompt).not.toContain("HEARTBEAT TEMPLATE MARKER");
    // Compact variant wins on normal resume.
    expect(built.promptMetrics.taskContextChars).toBe(COMPACT_BRIEF.trim().length);
    // Full description must not come back on a normal resume delta…
    expect(built.prompt).not.toContain("Update launch-card.svg");
    // …and the new comment appears exactly once.
    expect(built.prompt.split("NEW-COMMENT-DELTA-5678").length - 1).toBe(1);
  });

  it("D. assignment-shaped resume keeps the full brief", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({
        paperclipTaskMarkdown: FULL_BRIEF,
        paperclipTaskMarkdownCompact: COMPACT_BRIEF,
        paperclipWake: {
          reason: "issue_reopened_via_comment",
          issue: ISSUE,
          commentWindow: COMMENT_WINDOW,
          comments: [],
          fallbackFetchNeeded: false,
        },
      }),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: "session-1",
    });

    expect(built.promptMetrics.taskContextChars).toBe(FULL_BRIEF.trim().length);
    expect(built.prompt.split("SECRET-BRIEF-DESCRIPTION-1234").length - 1).toBe(1);
    // Still delta-first for instructions: OpenCode session holds AGENTS.md.
    expect(built.promptMetrics.instructionsChars).toBe(0);
  });

  it("D. recovery wake on a fresh session: instructions kept, heartbeat template suppressed", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({
        paperclipTaskMarkdown: FULL_BRIEF,
        paperclipTaskMarkdownCompact: COMPACT_BRIEF,
        paperclipWake: {
          reason: "source_scoped_recovery_action",
          issue: ISSUE,
          commentWindow: COMMENT_WINDOW,
          comments: [],
          fallbackFetchNeeded: false,
          recovery: {
            cause: "process_lost",
            failureSummary: "runner restart",
            originalAssignee: { id: "agent-1" },
          },
        },
      }),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: null,
    });

    // Recovery carries its own instructions; the heartbeat template would only
    // duplicate them (preserved opencode-local behaviour).
    expect(built.promptMetrics.heartbeatPromptChars).toBe(0);
    expect(built.prompt).toContain("process_lost");
    // Fresh sessions still get the agent instructions prefix.
    expect(built.promptMetrics.instructionsChars).toBe(INSTRUCTIONS_PREFIX.length);
    expect(built.promptMetrics.taskContextChars).toBe(FULL_BRIEF.trim().length);
  });

  it("recovery wake on a resumed session stays delta-first for instructions", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({
        paperclipTaskMarkdown: FULL_BRIEF,
        paperclipTaskMarkdownCompact: COMPACT_BRIEF,
        paperclipWake: {
          reason: "source_scoped_recovery_action",
          issue: ISSUE,
          commentWindow: COMMENT_WINDOW,
          comments: [],
          fallbackFetchNeeded: false,
          recovery: { cause: "successful_run_missing_state" },
        },
      }),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: "session-1",
    });

    expect(built.promptMetrics.instructionsChars).toBe(0);
    expect(built.prompt).not.toContain("AGENT INSTRUCTIONS MARKER");
    expect(built.promptMetrics.taskContextChars).toBe(FULL_BRIEF.trim().length);
  });

  it("plain resumed continuation without wake payload keeps instructions + template lane", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({}),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: "session-1",
    });

    expect(built.promptMetrics.instructionsChars).toBe(INSTRUCTIONS_PREFIX.length);
    expect(built.promptMetrics.heartbeatPromptChars).toBeGreaterThan(0);
    expect(built.promptMetrics.wakePromptChars).toBe(0);
  });

  it("prompt metrics are internally consistent with the assembled prompt", () => {    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({
        paperclipTaskMarkdown: FULL_BRIEF,
        paperclipWake: {
          reason: "issue_commented",
          issue: ISSUE,
          commentWindow: COMMENT_WINDOW,
          comments: [],
          fallbackFetchNeeded: false,
        },
      }),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: null,
    });

    const parts =
      built.promptMetrics.instructionsChars +
      built.promptMetrics.bootstrapPromptChars +
      built.promptMetrics.wakePromptChars +
      built.promptMetrics.sessionHandoffChars +
      built.promptMetrics.taskContextChars +
      built.promptMetrics.heartbeatPromptChars;
    // joinPromptSections adds separators, so total >= sum of parts.
    expect(built.promptMetrics.promptChars).toBeGreaterThanOrEqual(parts);
    expect(built.promptMetrics.promptChars).toBe(built.prompt.length);
  });
});

// Mirrors buildPaperclipTaskMarkdown (server heartbeat.ts) structure closely
// enough to exercise the deterministic section markers.
function taskMarkdownWithComment(commentBody: string, opts: { compact?: boolean } = {}) {
  return [
    "Paperclip task context:",
    "- Issue: \"KOMAA-57\"",
    ...(opts.compact
      ? []
      : ["", "Issue description:", "```text", "SECRET-BRIEF-DESCRIPTION-1234: Update launch-card.svg.", "```"]),
    "",
    "Latest wake comment:",
    "```text",
    commentBody,
    "```",
    "",
    "Use this task context as the current assignment.",
  ].join("\n");
}

const CONTINUATION_BODY = [
  "## Objective",
  "SHIP-OBJECTIVE-MARKER",
  "",
  "## Acceptance Criteria",
  "AC-MARKER",
  "",
  "## Recent Concrete Actions",
  "did concrete work",
  "",
  "## Blockers / Decisions",
  "none",
  "",
  "## Next Action",
  "NEXT-ACTION-MARKER",
].join("\n");

describe("latest wake comment deduplication", () => {
  const commentBody = "SAME-COMMENT-BODY-9999";

  it("fresh assignment with inline comments keeps the comment exactly once", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({
        paperclipTaskMarkdown: taskMarkdownWithComment(commentBody),
        paperclipTaskMarkdownCompact: taskMarkdownWithComment(commentBody, { compact: true }),
        paperclipWake: {
          reason: "issue_assigned",
          issue: ISSUE,
          commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
          comments: [{ id: "c1", authorName: "CEO", body: commentBody }],
          fallbackFetchNeeded: false,
        },
      }),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: null,
    });

    expect(built.prompt.split(commentBody).length - 1).toBe(1);
    // The description still appears exactly once (task markdown copy).
    expect(built.prompt.split("SECRET-BRIEF-DESCRIPTION-1234").length - 1).toBe(1);
  });

  it("normal resumed comment wake keeps the comment exactly once", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({
        paperclipTaskMarkdown: taskMarkdownWithComment(commentBody),
        paperclipTaskMarkdownCompact: taskMarkdownWithComment(commentBody, { compact: true }),
        paperclipWake: {
          reason: "issue_commented",
          issue: ISSUE,
          commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
          comments: [{ id: "c2", authorName: "CEO", body: commentBody }],
          fallbackFetchNeeded: false,
        },
      }),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: "session-1",
    });

    expect(built.prompt.split(commentBody).length - 1).toBe(1);
    expect(built.promptMetrics.instructionsChars).toBe(0);
  });

  it("without inline comments the task-markdown section is preserved (single copy)", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: makeCtx({
        paperclipTaskMarkdown: taskMarkdownWithComment(commentBody),
        paperclipTaskMarkdownCompact: taskMarkdownWithComment(commentBody, { compact: true }),
        paperclipWake: {
          reason: "issue_commented",
          issue: ISSUE,
          commentWindow: COMMENT_WINDOW,
          comments: [],
          fallbackFetchNeeded: false,
        },
      }),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: null,
    });

    expect(built.prompt.split(commentBody).length - 1).toBe(1);
  });
});

describe("continuation summary compaction on normal resume", () => {
  function ctxWithContinuation(reason: string) {
    return makeCtx({
      paperclipTaskMarkdown: FULL_BRIEF,
      paperclipTaskMarkdownCompact: COMPACT_BRIEF,
      paperclipWake: {
        reason,
        issue: ISSUE,
        commentWindow: COMMENT_WINDOW,
        comments: [],
        fallbackFetchNeeded: false,
        continuationSummary: {
          key: "sum-1",
          title: "Continuation",
          body: CONTINUATION_BODY,
          bodyTruncated: false,
        },
      },
    });
  }

  it("normal resumed wake drops Objective/Acceptance Criteria, keeps state sections", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: ctxWithContinuation("issue_commented"),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: "session-1",
    });

    expect(built.prompt).not.toContain("SHIP-OBJECTIVE-MARKER");
    expect(built.prompt).not.toContain("AC-MARKER");
    // State/delta sections survive.
    expect(built.prompt).toContain("NEXT-ACTION-MARKER");
    expect(built.prompt).toContain("Recent Concrete Actions");
    expect(built.prompt).toContain("Blockers / Decisions");
  });

  it("assignment-shaped resume keeps the full continuation summary", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: ctxWithContinuation("issue_reopened_via_comment"),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: "session-1",
    });

    expect(built.prompt).toContain("SHIP-OBJECTIVE-MARKER");
    expect(built.prompt).toContain("NEXT-ACTION-MARKER");
  });

  it("fresh session keeps the full continuation summary", () => {
    const built = buildOpenCodeRunPrompt({
      ctx: ctxWithContinuation("issue_commented"),
      config,
      instructionsPrefix: INSTRUCTIONS_PREFIX,
      sessionId: null,
    });

    expect(built.prompt).toContain("SHIP-OBJECTIVE-MARKER");
    expect(built.prompt).toContain("AC-MARKER");
  });
});

describe("parseOpenCodeJsonl usage measurement", () => {
  it("reports exact when step_finish token events are present", () => {
    const parsed = parseOpenCodeJsonl(
      [
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 20, cache: { read: 50 } }, cost: 0.01 } }),
      ].join("\n"),
    );
    expect(parsed.usageMeasurement).toBe("exact");
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.cachedInputTokens).toBe(50);
    expect(parsed.usage.outputTokens).toBe(20);
  });

  it("reports not_exposed when the stream has no token events (zeros are not measurements)", () => {
    const parsed = parseOpenCodeJsonl(JSON.stringify({ type: "text", part: { text: "done" } }));
    expect(parsed.usageMeasurement).toBe("not_exposed");
    expect(parsed.usage.inputTokens).toBe(0);
  });

  it("still detects unknown-session errors for the fresh-retry path", () => {
    expect(isOpenCodeUnknownSessionError("error: unknown session abc", "")).toBe(true);
  });
});
