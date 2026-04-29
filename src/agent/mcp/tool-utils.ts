import type { MCPToolSchema } from "./types.js";

export interface MCPToolInfo {
  name: string;
  originalName: string;
  description: string;
  parameters: Record<string, unknown>;
  annotations?: MCPToolSchema["annotations"];
  inferredReadOnly: boolean;
  safety: "read" | "write" | "destructive" | "unknown";
}

export interface MCPToolSelection {
  tools: MCPToolInfo[];
  missing: string[];
  totalMatches: number;
}

const READ_ONLY_TOOL_PREFIXES = [
  "get",
  "list",
  "read",
  "search",
  "find",
  "query",
  "lookup",
  "fetch",
  "describe",
  "inspect",
  "count",
  "check",
];

const WRITE_TOOL_PREFIXES = [
  "create",
  "update",
  "delete",
  "remove",
  "send",
  "post",
  "put",
  "patch",
  "set",
  "write",
  "add",
  "invite",
  "assign",
  "cancel",
  "approve",
  "reject",
  "archive",
  "move",
  "copy",
  "upload",
];

export function formatMCPToolInfo(tool: MCPToolSchema): MCPToolInfo {
  const inferredReadOnly = isReadOnlyMCPTool(tool);
  return {
    name: tool.name,
    originalName: tool.originalName,
    description: tool.description,
    parameters: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    inferredReadOnly,
    safety: getMCPToolSafety(tool),
  };
}

export function findMCPTool(
  tools: MCPToolSchema[],
  name: string,
): MCPToolSchema | undefined {
  const normalised = normaliseToolName(name);
  return tools.find(
    (tool) =>
      normaliseToolName(tool.name) === normalised ||
      normaliseToolName(tool.originalName) === normalised,
  );
}

export function selectMCPTools(
  allTools: MCPToolSchema[],
  params: { tools?: string[]; query?: string; limit?: number },
): MCPToolSelection {
  const limit = clampLimit(params.limit);
  const missing: string[] = [];

  if (params.tools && params.tools.length > 0) {
    const selected: MCPToolSchema[] = [];
    for (const requested of params.tools) {
      const found = findMCPTool(allTools, requested);
      if (found) {
        selected.push(found);
      } else {
        missing.push(requested);
      }
    }
    return {
      tools: selected.slice(0, limit).map(formatMCPToolInfo),
      missing,
      totalMatches: selected.length,
    };
  }

  const query = params.query?.trim();
  if (!query) {
    return {
      tools: allTools.slice(0, limit).map(formatMCPToolInfo),
      missing,
      totalMatches: allTools.length,
    };
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = allTools
    .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
    );

  return {
    tools: scored.slice(0, limit).map((entry) => formatMCPToolInfo(entry.tool)),
    missing,
    totalMatches: scored.length,
  };
}

export function isReadOnlyMCPTool(tool: MCPToolSchema): boolean {
  if (tool.annotations?.readOnlyHint === true) return true;
  if (tool.annotations?.destructiveHint === true) return false;

  const name = normaliseToolName(tool.name);
  if (WRITE_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return false;
  }
  return READ_ONLY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function getMCPToolSafety(tool: MCPToolSchema): MCPToolInfo["safety"] {
  if (tool.annotations?.destructiveHint === true) return "destructive";
  if (tool.annotations?.readOnlyHint === true) return "read";

  const name = normaliseToolName(tool.name);
  if (WRITE_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "write";
  }
  if (READ_ONLY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "read";
  }
  return "unknown";
}

function scoreTool(tool: MCPToolSchema, terms: string[]): number {
  const searchable = [
    tool.name,
    tool.originalName,
    tool.description,
    ...Object.keys(
      (tool.inputSchema.properties as Record<string, unknown> | undefined) ??
        {},
    ),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (normaliseToolName(tool.name).includes(normaliseToolName(term))) {
      score += 5;
    } else if (searchable.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function normaliseToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 8;
  return Math.min(Math.max(Math.trunc(limit), 1), 50);
}
