import {
  CHATGPT_PUBLIC_TOOL_NAMES,
} from "../scripts/mcp-public-tool-catalog.mjs";
import {
  MAX_HANDOFF_DEPTH,
  SKILL_CONTRACT_VERSION,
  SKILL_REGISTRY,
  buildOperationEnvelope,
  resolveMode,
} from "../scripts/paperclip-skill-contract.mjs";

const ALIASES = {
  "/debug": "paperclip-debug-run",
  "/debug-run": "paperclip-debug-run",
  "/fix-tools": "paperclip-napraw-tools",
  "/tools": "paperclip-napraw-tools",
  "/health": "paperclip-opencode-health",
  "/opencode-health": "paperclip-opencode-health",
  "/coo": "paperclip-deleguj-coo",
  "/delegate-coo": "paperclip-deleguj-coo",
  "/runtime": "paperclip-wdroz-runtime",
  "/deploy-runtime": "paperclip-wdroz-runtime",
};

export function createSkillOperationRouter({ defaultApp, operatorSkills, readSkill, ensureUpSession, upstreamCall }) {
  const skillTools = () => [
    {
      name: "paperclipListSkills",
      description: "List available Paperclip skills with names, descriptions and aliases. Use to discover which skill matches the user request before loading it.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false, "$schema": "http://json-schema.org/draft-07/schema#" },
    },
    {
      name: "paperclipGetSkill",
      description: "Get the full SKILL.md content for one Paperclip skill by name. Use after listing to load detailed instructions.",
      inputSchema: { type: "object", properties: { name: { type: "string", enum: operatorSkills.map((skill) => skill.name) } }, required: ["name"], additionalProperties: false, "$schema": "http://json-schema.org/draft-07/schema#" },
    },
    {
      name: "paperclipUseSkill",
      description: "Route a request through a Paperclip skill deterministically and return its execution envelope. Aliases map /debug /fix-tools /health /coo /runtime to skills.",
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string", enum: operatorSkills.map((skill) => skill.name) },
          request: { type: "string", minLength: 1 },
          context: { type: "string" },
          mode: { type: "string", enum: ["DIAGNOSE", "PLAN", "EXECUTE"], description: "Explicit mode override; registry and server-side guards still authorize writes." },
        },
        required: ["skill", "request"],
        additionalProperties: false,
        "$schema": "http://json-schema.org/draft-07/schema#",
      },
    },
  ];

  async function handle({ app, name, args, session, payload }) {
    if (app !== defaultApp || !["paperclipListSkills", "paperclipGetSkill", "paperclipUseSkill"].includes(name)) return null;
    if (name === "paperclipListSkills") {
      return { result: { skills: operatorSkills.map((skill) => ({ name: skill.name, description: skill.frontmatter.description || "", uri: skill.uri, aliases: SKILL_REGISTRY[skill.name].aliases, useWhen: skill.frontmatter.description || "" })) } };
    }
    if (name === "paperclipGetSkill") {
      const skillName = String(args?.name || "").trim();
      const skill = operatorSkills.find((entry) => entry.name === skillName);
      if (!skill) return { error: { code: -32602, message: `Unknown skill: ${skillName}` } };
      const content = readSkill(skillName);
      return { result: { content: [{ type: "text", text: content }], structuredContent: { name: skillName, content } } };
    }

    const skillName = String(args?.skill || "").trim();
    const request = String(args?.request || "").trim();
    const context = String(args?.context || "").trim();
    const skill = operatorSkills.find((entry) => entry.name === skillName);
    if (!skill) return { error: { code: -32602, message: `Unknown skill: ${skillName}` } };
    if (!request) return { error: { code: -32602, message: "request is required" } };
    const resolved = ALIASES[request.split(/\s+/)[0]] || skillName;
    const registry = SKILL_REGISTRY[resolved];
    const mode = resolveMode(request, { explicitMode: args?.mode });
    let envelope;
    try {
      envelope = buildOperationEnvelope({ skill: resolved, request, mode, target: context || null, actor: payload?.sub ? `oauth:${payload.sub}` : "chatgpt-operator" });
    } catch (error) {
      // Do not activate an operation when its mode is denied by the registry.
      delete session.operation;
      return { error: { code: -32602, message: String(error?.message || error), data: { code: "MODE_NOT_ALLOWED", mode, skill: resolved } } };
    }
    session.operation = { envelope, writesUsed: 0 };
    let upstreamToolCount = 0;
    try {
      const rec = await ensureUpSession(session, app);
      if (!rec.tools) {
        const listed = await upstreamCall(app, rec.upId, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
        rec.tools = listed.json.result?.tools || [];
      }
      upstreamToolCount = rec.tools.length;
    } catch {}
    const skillText = readSkill(resolved);
    const guidance = `Skill ${resolved} v${registry.version} selected for request: "${request}"${context ? ` with context: ${context}` : ""}. MODE=${envelope.MODE}; WRITE_BUDGET=${envelope.WRITE_BUDGET}; writes are server-enforced (SKILL_WRITE_GUARD_DENIED on violation). Follow the skill instructions using the current Paperclip tool catalog (${CHATGPT_PUBLIC_TOOL_NAMES.length} public tools; ${upstreamToolCount} tools in the full internal catalog).`;
    return {
      result: {
        content: [{ type: "text", text: `${guidance}\n\n--- SKILL ---\n${skillText.slice(0, 8000)}` }],
        structuredContent: {
          selectedSkill: resolved,
          skillVersion: registry.version,
          contractVersion: SKILL_CONTRACT_VERSION,
          mode: envelope.MODE,
          allowedWrites: envelope.WRITE_BUDGET,
          requiredContext: context || null,
          handoffLimit: MAX_HANDOFF_DEPTH,
          toolCatalogVersion: "chatgpt-public-1.3.0",
          toolCount: CHATGPT_PUBLIC_TOOL_NAMES.length,
          upstreamToolCount,
          operationId: envelope.OPERATION_ID,
          aliases: registry.aliases,
          writeGuard: "server-enforced",
        },
      },
    };
  }

  return { skillTools, handle };
}
