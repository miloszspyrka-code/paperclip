export const CHATGPT_PUBLIC_TOOL_NAMES = [
  "paperclipMe",
  "paperclipListAgents",
  "paperclipGetAgent",
  "paperclipListIssues",
  "paperclipGetIssue",
  "paperclipGetHeartbeatContext",
  "paperclipListComments",
  "paperclipListProjects",
  "paperclipGetProject",
  "paperclipListGoals",
  "paperclipGetIssueWorkspaceRuntime",
  "paperclipControlIssueWorkspaceServices",
  "paperclipWaitForIssueWorkspaceService",
  "paperclipCreateIssue",
  "paperclipUpdateIssue",
  "paperclipAddComment",
  "paperclipListDocuments",
  "paperclipGetDocument",
  "paperclipGetDocumentHistory",
  "paperclipGetDocumentRevision",
  "paperclipUpdateDocument",
  "paperclipWikiList",
  "paperclipWikiSearch",
  "paperclipWikiGetPage",
  "paperclipWikiGetMetadata",
  "paperclipWikiProposeChange",
  "paperclipWikiApplyChange",
  "paperclipListSkills",
  "paperclipGetSkill",
  "paperclipUseSkill",
];

export const CHATGPT_PUBLIC_TOOL_NAME_SET = new Set(CHATGPT_PUBLIC_TOOL_NAMES);

export const CHATGPT_PUBLIC_TOOL_DESCRIPTIONS = {
  paperclipMe: "Get the authenticated Paperclip actor and company context.",
  paperclipListAgents: "List Paperclip agents with compact role, status, and reporting information.",
  paperclipGetAgent: "Get detailed role, runtime, and configuration information for one Paperclip agent.",
  paperclipListIssues: "List Paperclip tasks/issues using filters such as status, project, assignee, or search text.",
  paperclipGetIssue: "Get one Paperclip task/issue with description, assignment, dependencies, status, and execution details.",
  paperclipGetHeartbeatContext: "Get compact execution, continuation, blocker, and wake context for one Paperclip task/issue.",
  paperclipListComments: "List comments for one Paperclip task/issue, with optional incremental pagination.",
  paperclipListProjects: "List Paperclip projects available for task planning, assignment, and workspace selection.",
  paperclipGetProject: "Get details and workspace information for one Paperclip project.",
  paperclipListGoals: "List company goals available for planning and linking Paperclip tasks.",
  paperclipGetIssueWorkspaceRuntime: "Get the current workspace and runtime services for one Paperclip task/issue.",
  paperclipControlIssueWorkspaceServices: "Start, stop, or restart runtime services for one Paperclip task workspace.",
  paperclipWaitForIssueWorkspaceService: "Wait for one Paperclip workspace service to become running and expose a URL when available.",
  paperclipCreateIssue: "Create a Paperclip task/issue with optional assignment, priority, project, goal, dependencies, and execution settings.",
  paperclipUpdateIssue: "Update a Paperclip task/issue including status, owner, priority, dependencies, execution settings, or comment.",
  paperclipAddComment: "Add a comment or instruction to one Paperclip task/issue, optionally resuming or interrupting execution.",
  paperclipListDocuments: "List documents attached to one accessible Paperclip issue, including current revision metadata. This is read-only.",
  paperclipGetDocument: "Get the current contents and metadata for one accessible Paperclip issue document. This is read-only.",
  paperclipGetDocumentHistory: "List version history for one accessible Paperclip issue document. This is read-only.",
  paperclipGetDocumentRevision: "Get one specific revision of an accessible Paperclip issue document. This is read-only.",
  paperclipUpdateDocument: "Create a new document revision only when baseRevisionId matches the current revision. Returns DOCUMENT_REVISION_CONFLICT instead of overwriting a concurrent change.",
  paperclipWikiList: "List safe, editable Wiki pages with descriptions, current hashes, and recommended skills. It never returns raw sources or runtime files.",
  paperclipWikiSearch: "Search safe Wiki page metadata and return compact matches without returning every page body. This is read-only.",
  paperclipWikiGetPage: "Read one safe Wiki markdown page and its current hash. It rejects raw, template, runtime, and traversal paths.",
  paperclipWikiGetMetadata: "Get safe Wiki page metadata, including description, type, hash, editability, and recommended skills. This is read-only.",
  paperclipWikiProposeChange: "Prepare a non-mutating Wiki page replacement and diff after verifying expectedHash. It creates a proposal but never writes the Wiki.",
  paperclipWikiApplyChange: "Apply a previously prepared Wiki proposal only when expectedHash still matches the page. Returns WIKI_HASH_CONFLICT instead of overwriting concurrent edits.",
  paperclipListSkills: "List available Paperclip skills with names, descriptions and aliases. Use to discover which skill matches the user request before loading it.",
  paperclipGetSkill: "Get the full SKILL.md content for one Paperclip skill by name. Use after listing to load detailed instructions.",
  paperclipUseSkill: "Route a request through a Paperclip skill deterministically and return its execution envelope. Aliases map /debug /fix-tools /health /coo /runtime to skills.",
};

export function filterChatGptPublicTools(tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return CHATGPT_PUBLIC_TOOL_NAMES.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [{ ...tool, description: CHATGPT_PUBLIC_TOOL_DESCRIPTIONS[name] }] : [];
  });
}

const companyId = { type: "string", format: "uuid", description: "Optional selection from the authenticated principal's granted companies." };

export const PUBLIC_GATEWAY_TOOLS = [
  ["paperclipGetDocumentHistory", { issueId: { type: "string" }, key: { type: "string" } }, ["issueId", "key"]],
  ["paperclipGetDocumentRevision", { issueId: { type: "string" }, key: { type: "string" }, revisionId: { type: "string" } }, ["issueId", "key", "revisionId"]],
  ["paperclipUpdateDocument", { issueId: { type: "string" }, key: { type: "string" }, baseRevisionId: { type: "string" }, content: { type: "string" }, title: { type: "string" }, changeSummary: { type: "string" } }, ["issueId", "key", "baseRevisionId", "content"]],
  ["paperclipWikiList", { companyId, spaceSlug: { type: "string" } }, []],
  ["paperclipWikiSearch", { companyId, spaceSlug: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["query"]],
  ["paperclipWikiGetPage", { companyId, spaceSlug: { type: "string" }, page: { type: "string" } }, ["page"]],
  ["paperclipWikiGetMetadata", { companyId, spaceSlug: { type: "string" }, page: { type: "string" } }, ["page"]],
  ["paperclipWikiProposeChange", { companyId, spaceSlug: { type: "string" }, page: { type: "string" }, expectedHash: { type: "string" }, content: { type: "string" }, summary: { type: "string" } }, ["page", "expectedHash", "content"]],
  ["paperclipWikiApplyChange", { proposalId: { type: "string" }, expectedHash: { type: "string" } }, ["proposalId", "expectedHash"]],
].map(([name, properties, required]) => ({
  name,
  description: CHATGPT_PUBLIC_TOOL_DESCRIPTIONS[name],
  inputSchema: { type: "object", properties, required, additionalProperties: false, "$schema": "http://json-schema.org/draft-07/schema#" },
}));
