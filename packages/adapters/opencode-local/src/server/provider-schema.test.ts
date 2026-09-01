import { describe, expect, it } from "vitest";
import {
  ProviderSchemaContractError,
  validateProviderSchemaContract,
} from "./provider-schema.js";

describe("validateProviderSchemaContract", () => {
  it("passes for a clean surface under the default 64-char limit", () => {
    expect(() =>
      validateProviderSchemaContract({
        providers: { openai: { models: { "gpt-4o": {} } } },
        mcp: { github: { command: "npx", args: ["-y", "@foo/mcp"] } },
      }),
    ).not.toThrow();
  });

  it("throws PROVIDER_SCHEMA_CONTRACT for an over-length provider connection id", () => {
    const longName = "x".repeat(65);
    let caught: unknown;
    try {
      validateProviderSchemaContract({ providers: { [longName]: {} } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderSchemaContractError);
    expect((caught as ProviderSchemaContractError).code).toBe("PROVIDER_SCHEMA_CONTRACT");
    expect((caught as ProviderSchemaContractError).length).toBe(65);
    expect((caught as ProviderSchemaContractError).maxLength).toBe(64);
  });

  it("names the offending connection for an over-length model id", () => {
    let caught: ProviderSchemaContractError | undefined;
    try {
      validateProviderSchemaContract({
        providers: { openai: { models: { ["y".repeat(65)]: {} } } },
      });
    } catch (err) {
      caught = err as ProviderSchemaContractError;
    }
    expect(caught?.connection).toBe("openai");
    expect(caught?.code).toBe("PROVIDER_SCHEMA_CONTRACT");
  });

  it("flags over-length MCP server ids", () => {
    let caught: ProviderSchemaContractError | undefined;
    try {
      validateProviderSchemaContract({ mcp: { ["z".repeat(65)]: {} } });
    } catch (err) {
      caught = err as ProviderSchemaContractError;
    }
    expect(caught?.code).toBe("PROVIDER_SCHEMA_CONTRACT");
    expect(caught?.message).toContain('MCP server name "zzzz');
  });

  it("flags over-length tool/function names recursively", () => {
    let caught: ProviderSchemaContractError | undefined;
    try {
      validateProviderSchemaContract({
        mcp: {
          github: {
            tools: [{ name: "a".repeat(65) }, { function: { name: "b".repeat(10) } }],
          },
        },
      });
    } catch (err) {
      caught = err as ProviderSchemaContractError;
    }
    expect(caught?.tool).toBe("a".repeat(65));
    expect(caught?.connection).toBe("github");
  });

  it("respects a custom maxNameLength", () => {
    expect(() =>
      validateProviderSchemaContract({ providers: { ["x".repeat(10)]: {} }, maxNameLength: 5 }),
    ).toThrow(ProviderSchemaContractError);
  });

  it("treats null/undefined maps as empty", () => {
    expect(() => validateProviderSchemaContract({ providers: null, mcp: undefined })).not.toThrow();
  });
});
