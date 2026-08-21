import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../../packages/adapters/opencode-local/src/server/execute.ts";

const runtimeRoot = path.resolve("C:/paperclip/.paperclip-runtime/opencode");
const workspace = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-adapter-workspace-"));
const fixture = path.join(workspace, "fixture.ts");
await writeFile(fixture, 'const answer = "before";\nexport { answer };\n', "utf8");
process.env.PAPERCLIP_OPENCODE_RUNTIME_ROOT = runtimeRoot;

const logs = [];
const result = await execute({
  runId: `adapter-live-${Date.now()}`,
  agent: {
    id: "live-adapter-agent",
    companyId: "live-smoke-company",
    name: "Live OpenCode Adapter",
    adapterType: "opencode_local",
    adapterConfig: {},
  },
  runtime: {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: "live-smoke",
  },
  config: {
    model: "openai/gpt-5.4-mini",
    command: "opencode",
    opencodeRuntimePlugins: ["openslimedit@1.0.1"],
    promptTemplate: [
      `Read ${fixture}.`,
      `Change only the value of answer from before to after using the edit tool.`,
      `Read the file again and inspect the diff. Do not modify any other file.`,
      "Return exactly PAPERCLIP_OPENCODE_OK when complete.",
    ].join("\n"),
    timeoutSec: 180,
    graceSec: 20,
  },
  context: {
    paperclipWorkspace: { cwd: workspace, source: "project_primary" },
  },
  onLog: async (stream, chunk) => {
    logs.push({ stream, bytes: chunk.length });
  },
});

try {
  const content = await readFile(fixture, "utf8");
  const files = await readdir(workspace);
  if (result.exitCode !== 0 || result.errorMessage) {
    throw new Error(`Adapter OpenCode smoke failed with exit ${result.exitCode}: ${result.errorMessage ?? "unknown error"}`);
  }
  if (!content.includes('const answer = "after";')) throw new Error("Adapter live edit was not applied.");
  if (files.length !== 1 || files[0] !== "fixture.ts") throw new Error("Adapter live edit changed an unexpected file.");
  console.log(JSON.stringify({
    providerAuth: "PASS",
    opencodeChildSpawn: "PASS",
    openslimedit: "PASS",
    nativeEdit: "PASS",
    sessionId: result.sessionId,
    logs: logs.length,
  }));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
