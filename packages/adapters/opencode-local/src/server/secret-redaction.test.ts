import { describe, expect, it } from "vitest";

function sanitizeSecretText(input: string): string {
  let out = input;
  out = out.replace(/Authorization:\s*Bearer\s+[^\s"'`]+/gi, "Authorization: Bearer ***REDACTED***");
  out = out.replace(/PAPERCLIP_API_KEY\s*=\s*[^\s"'`]+/g, "PAPERCLIP_API_KEY=***REDACTED***");
  out = out.replace(/pcgw_[A-Za-z0-9_-]+/g, "***REDACTED***");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{20,}/g, "Bearer ***REDACTED***");
  out = out.replace(/ghp_[A-Za-z0-9]+/g, "***REDACTED***");
  return out;
}

describe("secret redaction", () => {
  it("redacts Authorization Bearer and PAPERCLIP_API_KEY", () => {
    const raw = "error: Authorization: Bearer TEST_SECRET and PAPERCLIP_API_KEY=TEST_RUN_KEY plus pcgw_abc123";
    const sanitized = sanitizeSecretText(raw);
    expect(sanitized).not.toContain("TEST_SECRET");
    expect(sanitized).not.toContain("TEST_RUN_KEY");
    expect(sanitized).not.toContain("pcgw_abc123");
    expect(sanitized).toContain("***REDACTED***");
  });
  it("does not redact non-sensitive ids", () => {
    const raw = "companyId=abc agentId=xyz runId=123 server Git url https://example.invalid/mcp";
    const sanitized = sanitizeSecretText(raw);
    expect(sanitized).toContain("companyId=abc");
    expect(sanitized).toContain("Git");
    expect(sanitized).toContain("https://example.invalid/mcp");
  });
});
