import { describe, expect, it } from "vitest";
import {
  applyOpenCodeMcpToolSurface,
  resolveOpenCodeMcpToolSurfaceFilter,
} from "./runtime-config.js";

describe("resolveOpenCodeMcpToolSurfaceFilter", () => {
  it("returns inactive with no filter configured", () => {
    const filter = resolveOpenCodeMcpToolSurfaceFilter({ config: {}, env: {} });
    expect(filter.active).toBe(false);
    expect(filter.allowlist).toBeNull();
    expect(filter.denylist.size).toBe(0);
  });

  it("reads allowlist/denylist from agent config toolSurface", () => {
    const filter = resolveOpenCodeMcpToolSurfaceFilter({
      config: { toolSurface: { mcpAllowlist: "github,git", mcpDenylist: "cloudflare" } },
      env: {},
    });
    expect(filter.active).toBe(true);
    expect([...filter.allowlist!].sort()).toEqual(["git", "github"]);
    expect([...filter.denylist]).toEqual(["cloudflare"]);
  });

  it("falls back to env allowlist/denylist", () => {
    const filter = resolveOpenCodeMcpToolSurfaceFilter({
      config: {},
      env: { PAPERCLIP_OPENCODE_MCP_ALLOWLIST: "github", PAPERCLIP_OPENCODE_MCP_DENYLIST: "playwright" },
    });
    expect(filter.active).toBe(true);
    expect([...filter.allowlist!]).toEqual(["github"]);
    expect([...filter.denylist]).toEqual(["playwright"]);
  });
});

describe("applyOpenCodeMcpToolSurface", () => {
  const mcp = {
    github: { command: "npx", args: ["-y", "@gh/mcp"] },
    git: { command: "npx", args: ["-y", "@gh/mcp"] },
    cloudflare: { url: "https://mcp.cloudflare.com" },
    playwright: { command: "npx", args: ["-y", "@pw/mcp"] },
  };

  it("returns no change when filter is inactive", () => {
    const result = applyOpenCodeMcpToolSurface(mcp, {
      allowlist: null,
      denylist: new Set(),
      active: false,
    });
    expect(result.next).toBeNull();
    expect(result.beforeCount).toBe(4);
    expect(result.afterCount).toBe(4);
  });

  it("applies allowlist, removing unrelated servers", () => {
    const result = applyOpenCodeMcpToolSurface(mcp, {
      allowlist: new Set(["github", "git"]),
      denylist: new Set(),
      active: true,
    });
    expect(result.removedByAllowlist.sort()).toEqual(["cloudflare", "playwright"]);
    expect(result.afterServerNames).toEqual(["git"]);
    expect(result.next).toEqual({ git: mcp.git });
  });

  it("applies denylist even with no allowlist", () => {
    const result = applyOpenCodeMcpToolSurface(mcp, {
      allowlist: null,
      denylist: new Set(["cloudflare"]),
      active: true,
    });
    expect(result.removedByDenylist).toEqual(["cloudflare"]);
    // git/github are byte-identical; the lexicographically-first key (git) is kept.
    expect(result.afterServerNames.sort()).toEqual(["git", "playwright"]);
  });

  it("collapses duplicate aliases to one canonical entry", () => {
    const result = applyOpenCodeMcpToolSurface(mcp, {
      allowlist: null,
      denylist: new Set(),
      active: true,
    });
    // github and git are byte-identical -> alias collapse keeps the lexicographically first (git).
    expect(result.removedAsAliases).toEqual(["github (= git)"]);
    expect(result.afterServerNames.sort()).toEqual(["cloudflare", "git", "playwright"]);
  });

  it("does not collapse aliases when filter is inactive", () => {
    const result = applyOpenCodeMcpToolSurface(mcp, {
      allowlist: null,
      denylist: new Set(),
      active: false,
    });
    expect(result.removedAsAliases).toEqual([]);
    expect(result.next).toBeNull();
  });

  it("returns empty result for a non-object mcp map", () => {
    const result = applyOpenCodeMcpToolSurface(null, {
      allowlist: null,
      denylist: new Set(),
      active: false,
    });
    expect(result.beforeCount).toBe(0);
    expect(result.next).toBeNull();
  });
});
