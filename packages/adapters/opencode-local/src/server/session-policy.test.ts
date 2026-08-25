import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";
import {
  DEFAULT_OPENCODE_SESSION_MAX_RESUMES,
  OPENCODE_SESSION_ROTATION_MAX_RESUMES_ENV_VAR,
  applyOpenCodeSessionRotation,
  resolveOpenCodeSessionRotation,
  savedResumeCount,
} from "./session-policy.js";

describe("resolveOpenCodeSessionRotation", () => {
  it("defaults to a tight bounded rotation", () => {
    expect(DEFAULT_OPENCODE_SESSION_MAX_RESUMES).toBe(4);
    expect(resolveOpenCodeSessionRotation({ config: {}, env: {} })).toEqual({
      maxResumes: 4,
      source: "default",
    });
  });

  it("prefers the config override over env over default", () => {
    const env = { [OPENCODE_SESSION_ROTATION_MAX_RESUMES_ENV_VAR]: "6" };
    expect(resolveOpenCodeSessionRotation({ config: { sessionRotation: { maxResumes: 2 } }, env })).toEqual({
      maxResumes: 2,
      source: "config",
    });
    expect(resolveOpenCodeSessionRotation({ config: {}, env })).toEqual({
      maxResumes: 6,
      source: "env",
    });
    expect(
      resolveOpenCodeSessionRotation({
        config: { sessionRotation: { maxResumes: "not-a-number" } },
        env,
      }),
    ).toEqual({ maxResumes: 6, source: "env" });
  });

  it("treats an explicit non-positive value as a disabled policy", () => {
    expect(resolveOpenCodeSessionRotation({ config: { sessionRotation: { maxResumes: 0 } }, env: {} })).toEqual({
      maxResumes: null,
      source: "disabled",
    });
    expect(resolveOpenCodeSessionRotation({ config: {}, env: { [OPENCODE_SESSION_ROTATION_MAX_RESUMES_ENV_VAR]: "-1" } })).toEqual({
      maxResumes: null,
      source: "disabled",
    });
  });

  it("ignores malformed values and falls through to the default", () => {
    expect(
      resolveOpenCodeSessionRotation({
        config: { sessionRotation: { maxResumes: Number.NaN } },
        env: { [OPENCODE_SESSION_ROTATION_MAX_RESUMES_ENV_VAR]: "soon" },
      }),
    ).toEqual({ maxResumes: 4, source: "default" });
  });
});

describe("savedResumeCount", () => {
  it("sanitizes invalid persisted counters to zero", () => {
    expect(savedResumeCount(3)).toBe(3);
    expect(savedResumeCount(5.9)).toBe(5);
    expect(savedResumeCount(0)).toBe(0);
    expect(savedResumeCount(-2)).toBe(0);
    expect(savedResumeCount(undefined)).toBe(0);
    expect(savedResumeCount("4")).toBe(0);
    expect(savedResumeCount(Number.NaN)).toBe(0);
  });
});

describe("sessionCodec resumeCount persistence", () => {
  it("round-trips the resume counter so rotation state survives across runs", () => {
    const serialized = sessionCodec.serialize({
      sessionId: "ses_1",
      cwd: "/work",
      resumeCount: 3,
    });
    expect(serialized).toEqual({ sessionId: "ses_1", cwd: "/work", resumeCount: 3 });
    expect(sessionCodec.deserialize(serialized)).toEqual({
      sessionId: "ses_1",
      cwd: "/work",
      resumeCount: 3,
    });
  });

  it("drops invalid counters and keeps legacy params intact", () => {
    const serialized = sessionCodec.serialize({ sessionId: "ses_2", cwd: "/work", resumeCount: -1 });
    expect(serialized).toEqual({ sessionId: "ses_2", cwd: "/work" });
    expect(sessionCodec.deserialize({ sessionId: "ses_3" })).toEqual({ sessionId: "ses_3" });
  });

  it("returns null without a session id", () => {
    expect(sessionCodec.serialize({ cwd: "/work", resumeCount: 2 })).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
  });
});

describe("applyOpenCodeSessionRotation", () => {
  it("resumes and increments below the limit", () => {
    expect(
      applyOpenCodeSessionRotation({
        canResumeSession: true,
        savedSessionId: "ses_1",
        savedResumeCount: 2,
        maxResumes: 4,
      }),
    ).toEqual({
      resumeSessionId: "ses_1",
      nextResumeCount: 3,
      rotated: false,
      rotationReason: null,
    });
  });

  it("rotates at the limit into a compact fresh session with a reset counter", () => {
    const decision = applyOpenCodeSessionRotation({
      canResumeSession: true,
      savedSessionId: "ses_1",
      savedResumeCount: 4,
      maxResumes: 4,
    });
    expect(decision.resumeSessionId).toBeNull();
    expect(decision.nextResumeCount).toBe(0);
    expect(decision.rotated).toBe(true);
    expect(decision.rotationReason).toContain("reached 4 consecutive resumes (rotation limit 4)");
    expect(decision.rotationReason).toContain("structured wake context");
  });

  it("keeps resuming unboundedly when the policy is disabled", () => {
    expect(
      applyOpenCodeSessionRotation({
        canResumeSession: true,
        savedSessionId: "ses_1",
        savedResumeCount: 400,
        maxResumes: null,
      }),
    ).toEqual({
      resumeSessionId: "ses_1",
      nextResumeCount: 401,
      rotated: false,
      rotationReason: null,
    });
  });

  it("never resumes when the session cannot resume, regardless of counters", () => {
    expect(
      applyOpenCodeSessionRotation({
        canResumeSession: false,
        savedSessionId: "ses_1",
        savedResumeCount: 0,
        maxResumes: null,
      }),
    ).toEqual({ resumeSessionId: null, nextResumeCount: 0, rotated: false, rotationReason: null });
  });

  it("rotates repeatedly at the boundary so every subsequent run starts compact", () => {
    // After rotation the persisted counter is 0, but if stale state ever
    // re-appears the guard still holds the line.
    const first = applyOpenCodeSessionRotation({
      canResumeSession: true,
      savedSessionId: "ses_1",
      savedResumeCount: 9,
      maxResumes: 4,
    });
    expect(first.rotated).toBe(true);
    const second = applyOpenCodeSessionRotation({
      canResumeSession: true,
      savedSessionId: "ses_2",
      savedResumeCount: 7,
      maxResumes: 4,
    });
    expect(second.resumeSessionId).toBeNull();
    expect(second.nextResumeCount).toBe(0);
  });
});
