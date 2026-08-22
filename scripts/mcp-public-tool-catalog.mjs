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
  "paperclipApiRequest",
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
  paperclipApiRequest: "Call an existing Paperclip /api endpoint not covered by a dedicated tool; normal authentication and permissions still apply.",
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
