import { describe, expect, it, beforeEach } from "vitest";
import {
  canonicalProviderToolName,
  clearProviderToolNameMappings,
  MAX_PROVIDER_TOOL_NAME_LENGTH,
  registerProviderToolNameMapping,
  resolveOriginalToolName,
} from "../services/tool-gateway.js";

describe("canonicalProviderToolName", () => {
  beforeEach(() => clearProviderToolNameMappings());

  it("leaves short valid name unchanged (20 chars)", () => {
    const name = "my_valid_tool_name_123";
    expect(name.length).toBe(22);
    expect(canonicalProviderToolName(name)).toBe(name);
  });

  it("leaves exactly 64 char valid name unchanged", () => {
    const name = "a".repeat(64);
    expect(name.length).toBe(64);
    expect(canonicalProviderToolName(name)).toBe(name);
  });

  it("truncates 84 char name to <=64", () => {
    const name = "a".repeat(84);
    const result = canonicalProviderToolName(name);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result.length).toBe(64);
  });

  it("is deterministic: same long original twice gives identical provider name", () => {
    const name = "x".repeat(84);
    expect(canonicalProviderToolName(name)).toBe(canonicalProviderToolName(name));
  });

  it("two 84-char originals with identical 60-char prefix get distinct provider names", () => {
    const prefix = "a".repeat(60);
    const long1 = prefix + "111111111111111111111111";
    const long2 = prefix + "222222222222222222222222";
    expect(long1.length).toBe(84);
    expect(long2.length).toBe(84);
    expect(long1.slice(0, 60)).toBe(long2.slice(0, 60));
    const c1 = canonicalProviderToolName(long1);
    const c2 = canonicalProviderToolName(long2);
    expect(c1).not.toBe(c2);
    expect(c1.length).toBeLessThanOrEqual(64);
    expect(c2.length).toBeLessThanOrEqual(64);
  });

  it("roundtrip: long logical tool -> canonical -> resolveOriginal", () => {
    const original = `mcp.${"a".repeat(50)}-12345678:${"b".repeat(50)}`;
    expect(original.length).toBeGreaterThan(64);
    const canonical = canonicalProviderToolName(original);
    expect(canonical.length).toBeLessThanOrEqual(64);
    registerProviderToolNameMapping(original, canonical);
    expect(resolveOriginalToolName(canonical)).toBe(original);
  });

  it("all generated provider tool names in representative runtime fixture are <=64", () => {
    const fixtures = [
      `mcp.${"notion".repeat(10)}-abcd1234:${"create_database_row_with_very_long_name_exceeding_limit".repeat(2)}`,
      `mcp.${"linear".repeat(12)}-efgh5678:${"search_issues_with_complex_filter_and_pagination_support_extended"}`,
      `mcp.google-sheets-12345678:${"append_row_to_spreadsheet_with_formatting_and_validation"}`,
      "a".repeat(84),
      "b".repeat(100),
      `mcp.${"x".repeat(64)}-12345678:${"y".repeat(64)}`,
    ];
    for (const original of fixtures) {
      const canonical = canonicalProviderToolName(original);
      expect(canonical.length, `failed for ${original.slice(0, 30)}...`).toBeLessThanOrEqual(MAX_PROVIDER_TOOL_NAME_LENGTH);
    }
  });

  it("short names with provider-invalid chars are normalized without hash if possible", () => {
    const name = "mcp.conn:tool";
    const result = canonicalProviderToolName(name);
    expect(result).toBe("mcp_conn_tool");
    expect(result.length).toBeLessThanOrEqual(64);
  });
});
