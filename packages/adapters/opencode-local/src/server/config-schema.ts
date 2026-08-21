import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "text",
        required: true,
        hint: "OpenCode model id in provider/model format (e.g. opencode-go/hy3, anthropic/claude-sonnet-4-5).",
      },
      {
        key: "variant",
        label: "Variant",
        type: "text",
        hint: "Provider-specific reasoning/profile variant passed as --variant.",
      },
      {
        key: "mode",
        label: "Mode",
        type: "text",
        hint: "Optional execution mode hint for the adapter.",
      },
      {
        key: "effort",
        label: "Effort",
        type: "select",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        hint: "Optional effort hint for model routing.",
      },
      {
        key: "env",
        label: "Environment variables",
        type: "textarea",
        hint: "KEY=VALUE environment bindings (supports secret refs).",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file path",
        type: "text",
        hint: "Absolute path to a markdown instructions file prepended to the run prompt.",
      },
      {
        key: "instructions",
        label: "Instructions",
        type: "textarea",
        hint: "Inline agent instructions (alternative to instructionsFilePath).",
      },
      {
        key: "paperclipSkillSync",
        label: "Skill sync",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "Auto" },
          { value: "off", label: "Off" },
        ],
        hint: "Whether Paperclip materializes desiredSkills into the runtime.",
      },
      {
        key: "opencodeRuntimePlugins",
        label: "Paperclip OpenCode plugins",
        type: "textarea",
        hint: "Comma-separated, pinned npm plugin specs. Only these plugins load in the Paperclip runtime; blank means none.",
      },
    ],
  };
}
