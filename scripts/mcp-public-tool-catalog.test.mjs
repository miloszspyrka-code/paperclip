import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHATGPT_PUBLIC_TOOL_DESCRIPTIONS,
  CHATGPT_PUBLIC_TOOL_NAMES,
  filterChatGptPublicTools,
} from "./mcp-public-tool-catalog.mjs";

const removedNames = [
  "paperclipInboxLite",
  "paperclipGetComment",
  "paperclipListIssueApprovals",
  "paperclipListDocuments",
  "paperclipGetDocument",
  "paperclipListDocumentRevisions",
  "paperclipGetGoal",
  "paperclipListApprovals",
  "paperclipCreateApproval",
  "paperclipGetApproval",
  "paperclipGetApprovalIssues",
  "paperclipListApprovalComments",
  "paperclipCheckoutIssue",
  "paperclipReleaseIssue",
  "paperclipSuggestTasks",
  "paperclipAskUserQuestions",
  "paperclipRequestConfirmation",
  "paperclipRequestCheckboxConfirmation",
  "paperclipUpsertIssueDocument",
  "paperclipRestoreIssueDocumentRevision",
  "paperclipLinkIssueApproval",
  "paperclipUnlinkIssueApproval",
  "paperclipApprovalDecision",
  "paperclipAddApprovalComment",
];

const allTools = [
  ...CHATGPT_PUBLIC_TOOL_NAMES,
  ...removedNames,
].map((name) => ({
  name,
  description: `Legacy description for ${name}`,
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
}));

test("public catalog exposes exactly the allowlisted tools in stable order", () => {
  const catalog = filterChatGptPublicTools(allTools);
  assert.equal(catalog.length, 20);
  assert.deepEqual(catalog.map((tool) => tool.name), CHATGPT_PUBLIC_TOOL_NAMES);
  assert.ok(removedNames.every((name) => !catalog.some((tool) => tool.name === name)));
  for (const compat of ["paperclipListSkills", "paperclipGetSkill", "paperclipUseSkill"]) {
    assert.ok(catalog.some((tool) => tool.name === compat));
  }
});

test("public catalog rewrites compact descriptions without changing schemas", () => {
  const catalog = filterChatGptPublicTools(allTools);
  for (const tool of catalog) {
    const description = tool.description.trim();
    assert.ok(description.length > 0);
    assert.ok(description.length <= 220);
    assert.equal(description, CHATGPT_PUBLIC_TOOL_DESCRIPTIONS[tool.name]);
    assert.deepEqual(tool.inputSchema, { type: "object", properties: { value: { type: "string" } } });
    assert.doesNotMatch(description, /\{\s*"|workflow|implementation details/i);
    assert.ok(tool.name.length <= 64);
  }
});

test("public catalog filtering preserves the full upstream tool array", () => {
  const before = structuredClone(allTools);
  filterChatGptPublicTools(allTools);
  assert.deepEqual(allTools, before);
  assert.ok(removedNames.every((name) => allTools.some((tool) => tool.name === name)));
});

test("similar tool descriptions have distinct primary intent", () => {
  const descriptions = CHATGPT_PUBLIC_TOOL_DESCRIPTIONS;
  assert.match(descriptions.paperclipListAgents, /^List /);
  assert.match(descriptions.paperclipGetAgent, /^Get /);
  assert.match(descriptions.paperclipListIssues, /^List /);
  assert.match(descriptions.paperclipGetIssue, /^Get one /);
  assert.match(descriptions.paperclipGetHeartbeatContext, /context/);
  assert.match(descriptions.paperclipControlIssueWorkspaceServices, /^Start, stop, or restart/);
  assert.match(descriptions.paperclipWaitForIssueWorkspaceService, /^Wait /);
  assert.match(descriptions.paperclipCreateIssue, /^Create /);
  assert.match(descriptions.paperclipUpdateIssue, /^Update /);
  assert.match(descriptions.paperclipAddComment, /^Add /);
  assert.match(descriptions.paperclipApiRequest, /^Call an existing/);
});
