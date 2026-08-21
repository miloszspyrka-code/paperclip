import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Paperclip OpenCode startup contract", () => {
  it("sets only Paperclip runtime configuration and does not switch user-wide OpenCode roots", async () => {
    const cmd = await fs.readFile(path.resolve(process.cwd(), "start-paperclip.cmd"), "utf8");
    const ps1 = await fs.readFile(path.resolve(process.cwd(), "start-paperclip.ps1"), "utf8");
    const source = `${cmd}\n${ps1}`;

    expect(source).toContain("PAPERCLIP_OPENCODE_RUNTIME_ROOT");
    expect(source).not.toMatch(/setx\b/i);
    expect(source).not.toMatch(/XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|OPENCODE_CONFIG_DIR|OPENCODE_CONFIG\b/);
    expect(source).not.toMatch(/\$env:HOME\s*=|set\s+HOME=/i);
  });

  it("keeps the runtime root ignored by Git", async () => {
    const gitignore = await fs.readFile(path.resolve(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore).toContain(".paperclip-runtime/");
  });
});
