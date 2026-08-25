/**
 * Bounded OpenCode session rotation - "compaction at the boundary".
 *
 * Without a bound, one issue keeps appending heartbeat after heartbeat to the
 * same OpenCode session (`--session <id>`), so every wake replays an ever
 * growing conversation history at full token price. This policy caps the number
 * of consecutive resumes of a single session; when the cap is reached, the next
 * run starts a COMPACT fresh session instead. Continuity is preserved by the
 * structured context the server already injects (wake payload with objective /
 * decisions / changed files / tests / blockers / next action, plus the session
 * handoff note), so rotation never replays stale conversation garbage.
 *
 * The resume count is durable: it travels inside the adapter session params
 * (`resumeCount`), which the codec persists across runs. Rotation is
 * config-driven (`config.sessionRotation.maxResumes`) with an env override
 * (PAPERCLIP_OPENCODE_SESSION_ROTATION_MAX_RESUMES); an explicit non-positive
 * value disables the policy and restores unbounded resumes. Default is a tight
 * but safe 4 consecutive resumes per session.
 */

export const DEFAULT_OPENCODE_SESSION_MAX_RESUMES = 4;

export const OPENCODE_SESSION_ROTATION_MAX_RESUMES_ENV_VAR =
  "PAPERCLIP_OPENCODE_SESSION_ROTATION_MAX_RESUMES";

export interface ResolvedOpenCodeSessionRotation {
  /** Max consecutive resumes of one OpenCode session; null disables rotation. */
  maxResumes: number | null;
  source: "config" | "env" | "default" | "disabled";
}

function parseMaxResumes(value: unknown): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    return Number.parseInt(trimmed, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the rotation limit: `config.sessionRotation.maxResumes` wins over the
 * env override, then the default applies. A value <= 0 explicitly disables the
 * policy (null = unbounded resumes).
 */
export function resolveOpenCodeSessionRotation(input: {
  config: Record<string, unknown>;
  env: Record<string, string | undefined>;
}): ResolvedOpenCodeSessionRotation {
  const rawConfig = isRecord(input.config.sessionRotation)
    ? input.config.sessionRotation.maxResumes
    : undefined;
  const fromConfig = parseMaxResumes(rawConfig);
  if (fromConfig !== null) {
    return fromConfig > 0
      ? { maxResumes: fromConfig, source: "config" }
      : { maxResumes: null, source: "disabled" };
  }
  const fromEnv = parseMaxResumes(input.env[OPENCODE_SESSION_ROTATION_MAX_RESUMES_ENV_VAR]);
  if (fromEnv !== null) {
    return fromEnv > 0
      ? { maxResumes: fromEnv, source: "env" }
      : { maxResumes: null, source: "disabled" };
  }
  return { maxResumes: DEFAULT_OPENCODE_SESSION_MAX_RESUMES, source: "default" };
}

/** Sanitize a persisted resume counter; anything invalid counts as zero. */
export function savedResumeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export interface OpenCodeSessionRotationDecision {
  /** Session id to resume this run; null starts a fresh (compact) session. */
  resumeSessionId: string | null;
  /** Resume counter to persist for the resulting session. */
  nextResumeCount: number;
  rotated: boolean;
  rotationReason: string | null;
}

/**
 * Apply the resolved policy to the saved session state. A rotated run resets
 * the counter to zero; a resumed run increments it. Runs that cannot resume
 * (fresh sessions) always start from zero regardless of policy.
 */
export function applyOpenCodeSessionRotation(input: {
  canResumeSession: boolean;
  savedSessionId: string;
  savedResumeCount: number;
  maxResumes: number | null;
}): OpenCodeSessionRotationDecision {
  if (!input.canResumeSession || input.savedSessionId.length === 0) {
    return { resumeSessionId: null, nextResumeCount: 0, rotated: false, rotationReason: null };
  }
  if (input.maxResumes === null) {
    return {
      resumeSessionId: input.savedSessionId,
      nextResumeCount: input.savedResumeCount + 1,
      rotated: false,
      rotationReason: null,
    };
  }
  if (input.savedResumeCount >= input.maxResumes) {
    return {
      resumeSessionId: null,
      nextResumeCount: 0,
      rotated: true,
      rotationReason:
        `OpenCode session "${input.savedSessionId}" reached ${input.savedResumeCount} consecutive ` +
        `resumes (rotation limit ${input.maxResumes}); starting a compact fresh session - objective, ` +
        "decisions, changed files, tests, blockers, and next action arrive via the structured wake " +
        "context instead of replaying stale conversation history.",
    };
  }
  return {
    resumeSessionId: input.savedSessionId,
    nextResumeCount: input.savedResumeCount + 1,
    rotated: false,
    rotationReason: null,
  };
}
