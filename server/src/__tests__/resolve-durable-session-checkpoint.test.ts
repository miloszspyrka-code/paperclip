import { describe, expect, it } from "vitest";
import { resolveDurableSessionCheckpoint } from "../services/heartbeat.ts";

// Minimal identity codec: session params are stored as-is and the display id is
// the sessionId. opencode_local is not a canonical-session-id adapter, so the
// checkpoint passes through unchanged.
const identityCodec = {
  deserialize(raw: unknown) {
    return (raw as Record<string, unknown> | null) ?? null;
  },
  serialize(params: Record<string, unknown> | null) {
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return typeof params?.sessionId === "string" ? (params.sessionId as string) : null;
  },
};

describe("resolveDurableSessionCheckpoint", () => {
  it("returns null when there is no task key to anchor the session row", () => {
    expect(
      resolveDurableSessionCheckpoint({
        adapterType: "opencode_local",
        codec: identityCodec,
        taskKey: null,
        clearSession: false,
        sessionParams: { sessionId: "sess-1" },
      }),
    ).toBeNull();
  });

  it("returns null when the adapter explicitly clears the session", () => {
    expect(
      resolveDurableSessionCheckpoint({
        adapterType: "opencode_local",
        codec: identityCodec,
        taskKey: "agent:issue",
        clearSession: true,
        sessionParams: { sessionId: "sess-1" },
      }),
    ).toBeNull();
  });

  it("returns null when neither explicit session params nor an explicit id are present", () => {
    expect(
      resolveDurableSessionCheckpoint({
        adapterType: "opencode_local",
        codec: identityCodec,
        taskKey: "agent:issue",
        clearSession: false,
      }),
    ).toBeNull();
  });

  it("checkpoints a freshly discovered session (params) so a later terminal-write loss still leaves a resumable --session", () => {
    const result = resolveDurableSessionCheckpoint({
      adapterType: "opencode_local",
      codec: identityCodec,
      taskKey: "agent:issue",
      clearSession: false,
      sessionParams: { sessionId: "sess-k134", cwd: "/tmp/work" },
    });
    expect(result).not.toBeNull();
    if (result) {
      expect(result.sessionParamsJson).toEqual({ sessionId: "sess-k134", cwd: "/tmp/work" });
      expect(result.displayId).toBe("sess-k134");
    }
  });

  it("checkpoints an explicit session id even without structured params", () => {
    const result = resolveDurableSessionCheckpoint({
      adapterType: "opencode_local",
      codec: identityCodec,
      taskKey: "agent:issue",
      clearSession: false,
      sessionId: "sess-explicit",
    });
    expect(result).not.toBeNull();
    if (result) {
      expect(result.sessionParamsJson).toEqual({ sessionId: "sess-explicit" });
      expect(result.displayId).toBe("sess-explicit");
    }
  });

  it("drops an unresolvable explicit id instead of checkpointing garbage", () => {
    expect(
      resolveDurableSessionCheckpoint({
        adapterType: "opencode_local",
        codec: identityCodec,
        taskKey: "agent:issue",
        clearSession: false,
        sessionId: "",
      }),
    ).toBeNull();
  });
});
