import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareOpenCodeRuntimeConfig } from "../../packages/adapters/opencode-local/dist/server/runtime-config.js";

const runtimeRoot = path.resolve("C:/paperclip/.paperclip-runtime/opencode");
const workspace = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-live-workspace-"));
const fixture = path.join(workspace, "fixture.ts");
await writeFile(fixture, 'const answer = "before";\nexport { answer };\n', "utf8");

const prepared = await prepareOpenCodeRuntimeConfig({
  env: {
    PAPERCLIP_OPENCODE_RUNTIME_ROOT: runtimeRoot,
    PAPERCLIP_AGENT_ID: "live-smoke-agent",
    PAPERCLIP_RUN_ID: `live-smoke-${Date.now()}`,
  },
  config: {
    model: "openai/gpt-5.4-mini",
    opencodeRuntimePlugins: ["openslimedit@1.0.1"],
  },
});

const prompt = [
  `Read ${fixture}.`,
  `Change only the value of answer from before to after using the edit tool.`,
  `Read the file again and inspect the diff. Do not modify any other file.`,
  "Return exactly PAPERCLIP_OPENCODE_OK when complete.",
].join("\n");

const result = await new Promise((resolve, reject) => {
  const child = spawn("cmd.exe", ["/d", "/s", "/c", "opencode.cmd run --format json --model openai/gpt-5.4-mini"], {
    cwd: workspace,
    env: { ...process.env, ...prepared.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("OpenCode live smoke timed out after 180 seconds."));
  }, 180_000);
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", (error) => { clearTimeout(timer); reject(error); });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, stdout, stderr });
  });
  child.stdin.end(prompt);
});

try {
  const content = await readFile(fixture, "utf8");
  const files = await readdir(workspace);
  if (result.code !== 0) throw new Error(`OpenCode exited with ${result.code ?? result.signal}.`);
  if (!content.includes('const answer = "after";')) throw new Error("The live edit was not applied.");
  if (files.length !== 1 || files[0] !== "fixture.ts") throw new Error("The live edit changed an unexpected file.");
  console.log(JSON.stringify({
    providerAuth: "PASS",
    openslimedit: "PASS",
    nativeEdit: "PASS",
    isolatedConfig: prepared.paths.configHome,
    isolatedData: prepared.paths.dataHome,
    isolatedCache: prepared.paths.cacheHome,
    stderrBytes: result.stderr.length,
    stdoutBytes: result.stdout.length,
  }));
} finally {
  await prepared.cleanup();
  await rm(workspace, { recursive: true, force: true });
}
