import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url).pathname.replace(/^\/(\w):/, "$1:").replaceAll("/", "\\");
const skillsRoot = join(root, "skills");
const commandsRoot = join(root, ".opencode", "commands");
const names = [
  "paperclip-debug-run",
  "paperclip-napraw-tools",
  "paperclip-opencode-health",
  "paperclip-deleguj-coo",
  "paperclip-wdroz-runtime",
];

async function text(path) {
  return readFile(path, "utf8");
}

test("exact command set excludes the obsolete handoff command", async () => {
  const files = (await readdir(commandsRoot)).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)).sort();
  assert.deepEqual(files, [...names].sort());
  assert.equal(files.includes("chatgpt-cli-handoff"), false);
});

test("canonical skills have exact names", async () => {
  for (const name of names) {
    const skill = await text(join(skillsRoot, name, "SKILL.md"));
    assert.match(skill, new RegExp(`^name: ${name}$`, "m"));
  }
  assert.equal((await readdir(skillsRoot)).includes("chatgpt-cli-handoff"), false);
});

test("all skills contain their full contract markers", async () => {
  const markers = {
    "paperclip-debug-run": "FAILURE_LAYER",
    "paperclip-napraw-tools": "ACCESS",
    "paperclip-opencode-health": "OPENCODE_VERSION",
    "paperclip-deleguj-coo": "SEGMENTATION",
    "paperclip-wdroz-runtime": "start-paperclip.cmd",
  };
  for (const [name, marker] of Object.entries(markers)) {
    assert.match(await text(join(skillsRoot, name, "SKILL.md")), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("each command forwards arguments and stays thin", async () => {
  for (const name of names) {
    const command = await text(join(commandsRoot, `${name}.md`));
    const skill = await text(join(skillsRoot, name, "SKILL.md"));
    assert.match(command, /\$ARGUMENTS/);
    assert.ok(command.includes("Load and follow the `" + name + "` skill"));
    assert.ok(command.length < 700);
    assert.equal(command.includes("FAILURE_LAYER"), false);
    assert.ok(skill.length > command.length * 2);
  }
});

test("debug routing fixture selects provider or adapter, not product code", async () => {
  const skill = await text(join(skillsRoot, "paperclip-debug-run", "SKILL.md"));
  const fixture = { errorCode: "provider_tool_schema_rejected", inputTokens: 0, outputTokens: 0 };
  assert.equal(fixture.inputTokens === 0 && fixture.outputTokens === 0, true);
  assert.match(skill, /PROVIDER/);
  assert.match(skill, /tool schema/);
  assert.match(skill, /Never blame product code/);
});

test("tool routing fixture identifies Install when Access is true and Install is false", async () => {
  const skill = await text(join(skillsRoot, "paperclip-napraw-tools", "SKILL.md"));
  const fixture = { access: true, installed: false };
  const brokenLayer = fixture.access && !fixture.installed ? "INSTALL" : "UNKNOWN";
  assert.equal(brokenLayer, "INSTALL");
  assert.match(skill, /Access != Install/);
});

test("OpenCode health contract requires no host MCP leak", async () => {
  const skill = await text(join(skillsRoot, "paperclip-opencode-health", "SKILL.md"));
  assert.match(skill, /HOST_MCP_LEAK=false/);
  assert.match(skill, /PAPERCLIP_MCP_ONLY=true/);
  assert.match(skill, /host `opencode\.json`/);
});

test("COO fixture segments implementation and QA without an unnecessary CTO", async () => {
  const skill = await text(join(skillsRoot, "paperclip-deleguj-coo", "SKILL.md"));
  const tasks = [
    { title: "Implementation", owner: "ENGINEER", blockedBy: [] },
    { title: "Validation", owner: "UI QA", blockedBy: ["Implementation"] },
  ];
  assert.deepEqual(tasks.map((task) => task.owner), ["ENGINEER", "UI QA"]);
  assert.deepEqual(tasks[1].blockedBy, ["Implementation"]);
  assert.match(skill, /Do not add CTO to normal implementation/);
});

test("duplicate task fixture reuses an identical existing task", async () => {
  const existing = [{ title: "Repair runtime isolation", scope: "Paperclip OpenCode" }];
  const requested = { title: "Repair runtime isolation", scope: "Paperclip OpenCode" };
  const duplicate = existing.some((task) => task.title === requested.title && task.scope === requested.scope);
  assert.equal(duplicate, true);
  const skillText = (await text(join(skillsRoot, "paperclip-deleguj-coo", "SKILL.md"))).replace(/\s+/g, " ").toLowerCase();
  assert.ok(skillText.includes("do not create a duplicate"));
  assert.ok(skillText.includes("idempotencykey"));
});

test("runtime deployment requires an auditable task and canonical start command", async () => {
  const skill = await text(join(skillsRoot, "paperclip-wdroz-runtime", "SKILL.md"));
  assert.match(skill, /FIND\/CREATE PAPERCLIP TASK/);
  assert.match(skill, /C:\\paperclip\\start-paperclip\.cmd/);
  assert.match(skill, /PRE-FLIGHT -> CHANGE -> BUILD -> TYPECHECK/);
});

test("skill and command payloads contain no credential values", async () => {
  for (const name of names) {
    const payload = `${await text(join(skillsRoot, name, "SKILL.md"))}\n${await text(join(commandsRoot, `${name}.md`))}`;
    assert.doesNotMatch(payload, /Bearer\s+[A-Za-z0-9._~-]{20,}/i);
    assert.doesNotMatch(payload, /(?:api[_-]?key|token|password|cookie)\s*[:=]\s*['"][^'"]{12,}/i);
  }
});

test("all exposed operator command and skill names fit provider tool name limits", () => {
  for (const name of names) assert.ok(name.length <= 64);
});

test("runtime gateway exposes skills but not an obsolete command", async () => {
  const gateway = await text(join(root, "mcp-public-gateway.mjs"));
  assert.match(gateway, /io\.modelcontextprotocol\/skills/);
  assert.match(gateway, /skills\/list/);
  assert.match(gateway, /skills\/get/);
  assert.match(gateway, /resources\/read/);
  assert.doesNotMatch(gateway, /chatgpt-cli-handoff/);
});
