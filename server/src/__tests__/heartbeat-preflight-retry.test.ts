import { describe, expect, it } from "vitest";
import { isRetryableInteractionContinuationInfrastructureFailure } from "../services/heartbeat.ts";

describe("heartbeat workspace preflight retry policy", () => {
  it("fails fast for workspace validation without scheduling a state-unchanged retry", () => {
    expect(isRetryableInteractionContinuationInfrastructureFailure({
      errorCode: "workspace_validation_failed",
      error: "workspace path is missing",
      resultJson: null,
    })).toBe(false);
  });
});
