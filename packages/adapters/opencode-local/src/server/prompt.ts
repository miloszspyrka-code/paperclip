import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  asString,
  isAssignmentShapedPaperclipWakeReason,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  selectPaperclipTaskMarkdown,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";

// The task-context markdown (server/src/services/heartbeat.ts
// buildPaperclipTaskMarkdown) embeds the latest wake comment in a deterministic
// section. When the wake payload already carries the comments inline, the wake
// delta is the authoritative copy, so this section is dropped from the task
// markdown instead of delivering the same comment twice.
const WAKE_COMMENT_SECTION_MARKER = "\n\nLatest wake comment:\n";
const TASK_CONTEXT_TAIL = "\n\nUse this task context as the current assignment.";

export function stripWakeCommentSectionFromTaskMarkdown(taskMarkdown: string): string {
  const start = taskMarkdown.indexOf(WAKE_COMMENT_SECTION_MARKER);
  if (start === -1) return taskMarkdown;
  const tailIndex = taskMarkdown.indexOf(TASK_CONTEXT_TAIL, start);
  const end = tailIndex === -1 ? taskMarkdown.length : tailIndex;
  return `${taskMarkdown.slice(0, start)}${taskMarkdown.slice(end)}`;
}

// Continuation summaries (server/src/services/issue-continuation-summary.ts)
// repeat "## Objective" and "## Acceptance Criteria" on every resume even
// though the session received both with the original brief. A normal resumed
// wake only needs the state delta: progress, evidence, blockers/decisions and
// next action. This drops exactly those two documented sections — it never
// touches free-form text outside them, and it is applied only when the session
// verifiably received the full brief earlier.
const CONTINUATION_SECTIONS_DUPLICATED_BY_BRIEF = ["Objective", "Acceptance Criteria"];

function dropContinuationSection(body: string, heading: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  const sectionStart = new RegExp(`^##\\s+${heading}\\s*$`, "i");
  let dropping = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      dropping = sectionStart.test(line.trim());
      if (dropping) continue;
    } else if (dropping) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

function buildCompactContinuationSummaryBody(body: string): string {
  let out = body;
  for (const heading of CONTINUATION_SECTIONS_DUPLICATED_BY_BRIEF) {
    out = dropContinuationSection(out, heading);
  }
  return out;
}

function wakeCarriesInlineComments(wake: unknown): boolean {
  const comments = parseObject(wake).comments;
  if (!Array.isArray(comments)) return false;
  return comments.some((entry) => asString(parseObject(entry).body, "").trim().length > 0);
}

// Builds the stdin prompt for an OpenCode run with the same fresh-vs-resume
// semantics as the ACPX engine:
//
// - Fresh sessions get the full authoritative task brief
//   (context.paperclipTaskMarkdown) plus agent instructions and the heartbeat
//   template.
// - Normal resumed wakes are delta-first: no re-injected AGENTS.md instructions,
//   no heartbeat template, compact task context (description stripped), compact
//   continuation summary (Objective/Acceptance Criteria stripped), and the wake
//   prompt carries only the new delta.
// - Assignment-shaped and recovery wakes keep the full brief and full
//   continuation summary even on a resumed session.
//
// Each class of information appears at most once per prompt:
// - issue description → authoritative source: task-context markdown
//   (suppressIssueDescription keeps the wake copy out);
// - execution contract → authoritative source: heartbeat template on fresh
//   sessions, wake payload only on template-less resume lanes;
// - latest wake comment → authoritative source: the inline wake delta whenever
//   the payload carries comments (the duplicated task-markdown section is
//   dropped).
export function buildOpenCodeRunPrompt(input: {
  ctx: Pick<AdapterExecutionContext, "agent" | "runId" | "context">;
  config: Record<string, unknown>;
  instructionsPrefix: string;
  sessionId: string | null;
}): {
  prompt: string;
  promptMetrics: {
    promptChars: number;
    instructionsChars: number;
    bootstrapPromptChars: number;
    wakePromptChars: number;
    sessionHandoffChars: number;
    taskContextChars: number;
    heartbeatPromptChars: number;
  };
} {
  const { ctx, config, instructionsPrefix, sessionId } = input;
  const resumedSession = Boolean(sessionId);
  const context = ctx.context;

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    company: { id: ctx.agent.companyId },
    agent: ctx.agent,
    run: { id: ctx.runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !resumedSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";

  const rawWake = context.paperclipWake;
  const isRecoveryWake = isPaperclipRecoveryWakePayload(rawWake);
  const isAssignmentShapedWake = isAssignmentShapedPaperclipWakeReason(
    asString(parseObject(rawWake).reason, "").trim() || null,
  );
  // The session verifiably holds the full brief only when the server produced a
  // compact variant for this lane; without it selectPaperclipTaskMarkdown falls
  // back to the full markdown and we must not assume prior knowledge.
  const sessionKnowsBrief =
    resumedSession &&
    !isRecoveryWake &&
    !isAssignmentShapedWake &&
    Boolean(rawWake) &&
    typeof rawWake === "object" &&
    asString(context.paperclipTaskMarkdownCompact, "").trim().length > 0;

  // Comment dedup: with an inline comment batch, the wake delta carries the
  // comments; drop the duplicate "Latest wake comment" section from the task
  // markdown. Applied on fresh and resumed lanes alike.
  let taskContextNote = selectPaperclipTaskMarkdown(context, { resumedSession });
  const stripCommentSection =
    taskContextNote.length > 0 && wakeCarriesInlineComments(rawWake);
  if (stripCommentSection) {
    taskContextNote = stripWakeCommentSectionFromTaskMarkdown(taskContextNote);
  }

  // Continuation-summary compaction: normal resumes get state/delta sections
  // only; fresh, assignment-shaped and recovery wakes keep the full summary.
  let rendererWake = rawWake;
  if (sessionKnowsBrief) {
    const rawContinuation = parseObject(rawWake).continuationSummary;
    const continuationBody = asString(parseObject(rawContinuation).body, "").trim();
    if (continuationBody.length > 0) {
      rendererWake = {
        ...parseObject(rawWake),
        continuationSummary: {
          ...parseObject(rawContinuation),
          body:
            buildCompactContinuationSummaryBody(continuationBody) || continuationBody,
        },
      };
    }
  }

  const wakePrompt = renderPaperclipWakePrompt(rendererWake, {
    resumedSession,
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: taskContextNote.length > 0,
  });

  const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
  // A normal resumed wake is delta-first: OpenCode already holds the agent
  // instructions in the session, so re-sending them doubles the prompt cost
  // without adding information. Fresh sessions and template-less resume deltas
  // (recovery/heartbeat lanes) still get the full prefix.
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  // Recovery wakes carry their own full instructions inside the wake payload;
  // the heartbeat template would only duplicate them, so it stays out even on a
  // fresh session (preserves the previous opencode-local behaviour).
  const renderedPrompt =
    shouldUseResumeDeltaPrompt || isRecoveryWake
      ? ""
      : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);

  return {
    prompt,
    promptMetrics: {
      promptChars: prompt.length,
      instructionsChars: promptInstructionsPrefix.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      taskContextChars: taskContextNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    },
  };
}
