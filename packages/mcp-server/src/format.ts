import { PaperclipApiError } from "./client.js";

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const sensitiveFieldName = /(?:accesskey|apikey|authorization|bearer|clientsecret|credential|password|privatekey|refreshtoken|secret|sessiontoken|token|value)$/i;

function isSensitiveFieldName(key: string): boolean {
  return sensitiveFieldName.test(key.replace(/[^a-z0-9]/gi, ""));
}

function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveValues);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
    key,
    isSensitiveFieldName(key) ? "[REDACTED]" : redactSensitiveValues(nested),
  ]));
}

export function formatTextResponse(value: unknown): McpTextResponse {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(redactSensitiveValues(value), null, 2),
      },
    ],
  };
}

export function formatErrorResponse(error: unknown): McpTextResponse {
  const response = error instanceof PaperclipApiError
    ? formatTextResponse({
        error: "Paperclip API request failed",
        status: error.status,
        method: error.method,
        path: error.path,
      })
    : formatTextResponse({
        error: "Tool input or execution failed",
      });
  return { ...response, isError: true };
}
