import { describe, it, expect } from "vitest";
import {
  resolveApproach,
  formatGuidance,
  type MaterialisedGuidance,
  type MCPServerStatus,
} from "../src/agent/approach-resolver.js";
import type { Skill } from "../src/agent/skill-loader.js";
import type { Pattern } from "../src/agent/pattern-loader.js";

function makeSkill(
  name: string,
  patterns: string[],
  antiPatterns: string[] = [],
  guidance: string = "",
): Skill {
  return {
    name,
    description: "",
    triggers: [],
    patterns,
    antiPatterns,
    requiresMcp: [],
    guidance,
    source: "system",
    filePath: `/tmp/test/${name}/SKILL.md`,
  };
}

function makePattern(name: string, opts: Partial<Pattern> = {}): Pattern {
  return {
    name,
    description: "",
    modules: [],
    plugins: [],
    profiles: [],
    config: {},
    steps: [],
    ...opts,
  };
}

describe("approach-resolver", () => {
  it("should resolve a single skill with one pattern", () => {
    const skills = new Map([
      [
        "pptx",
        makeSkill("pptx", ["file-gen"], ["Don't use monolithic handlers"]),
      ],
    ]);
    const patterns = new Map([
      [
        "file-gen",
        makePattern("file-gen", {
          modules: ["zip-format", "ziplib"],
          plugins: ["fs-write"],
          profiles: ["file-builder"],
          config: { heapMb: 128 },
          steps: ["Build entries", "Create ZIP", "Write file"],
        }),
      ],
    ]);

    const result = resolveApproach(["pptx"], skills, patterns);

    expect(result.matchedSkills).toEqual(["pptx"]);
    expect(result.modules).toEqual(["zip-format", "ziplib"]);
    expect(result.plugins).toEqual(["fs-write"]);
    expect(result.profiles).toEqual(["file-builder"]);
    expect(result.config.heapMb).toBe(128);
    expect(result.steps).toHaveLength(3);
    expect(result.antiPatterns).toContain("Don't use monolithic handlers");
  });

  it("should union modules from multiple patterns", () => {
    const skills = new Map([["multi", makeSkill("multi", ["p1", "p2"])]]);
    const patterns = new Map([
      ["p1", makePattern("p1", { modules: ["shared-state", "pptx"] })],
      ["p2", makePattern("p2", { modules: ["shared-state", "image"] })],
    ]);

    const result = resolveApproach(["multi"], skills, patterns);
    expect(result.modules.sort()).toEqual(["image", "pptx", "shared-state"]);
  });

  it("should take max of config values", () => {
    const skills = new Map([
      ["s1", makeSkill("s1", ["p1"])],
      ["s2", makeSkill("s2", ["p2"])],
    ]);
    const patterns = new Map([
      [
        "p1",
        makePattern("p1", { config: { heapMb: 128, cpuTimeoutMs: 5000 } }),
      ],
      [
        "p2",
        makePattern("p2", { config: { heapMb: 64, cpuTimeoutMs: 15000 } }),
      ],
    ]);

    const result = resolveApproach(["s1", "s2"], skills, patterns);
    expect(result.config.heapMb).toBe(128); // max
    expect(result.config.cpuTimeoutMs).toBe(15000); // max
  });

  it("should union plugins from multiple skills", () => {
    const skills = new Map([
      ["s1", makeSkill("s1", ["p1"])],
      ["s2", makeSkill("s2", ["p2"])],
    ]);
    const patterns = new Map([
      ["p1", makePattern("p1", { plugins: ["fs-write"] })],
      ["p2", makePattern("p2", { plugins: ["fetch", "fs-write"] })],
    ]);

    const result = resolveApproach(["s1", "s2"], skills, patterns);
    expect(result.plugins.sort()).toEqual(["fetch", "fs-write"]);
  });

  it("should deduplicate antiPatterns", () => {
    const skills = new Map([
      ["s1", makeSkill("s1", [], ["Don't do X", "Don't do Y"])],
      ["s2", makeSkill("s2", [], ["Don't do X", "Don't do Z"])],
    ]);
    const patterns = new Map<string, Pattern>();

    const result = resolveApproach(["s1", "s2"], skills, patterns);
    expect(result.antiPatterns).toHaveLength(3);
    expect(result.antiPatterns).toContain("Don't do X");
    expect(result.antiPatterns).toContain("Don't do Y");
    expect(result.antiPatterns).toContain("Don't do Z");
  });

  it("should handle missing skill gracefully", () => {
    const skills = new Map<string, Skill>();
    const patterns = new Map<string, Pattern>();

    const result = resolveApproach(["nonexistent"], skills, patterns);
    expect(result.matchedSkills).toEqual(["nonexistent"]);
    expect(result.modules).toEqual([]);
    expect(result.steps).toEqual([]);
  });

  it("should handle missing pattern gracefully", () => {
    const skills = new Map([["s1", makeSkill("s1", ["missing-pattern"])]]);
    const patterns = new Map<string, Pattern>();

    const result = resolveApproach(["s1"], skills, patterns);
    expect(result.modules).toEqual([]);
  });

  it("should extract rules from guidance", () => {
    const skills = new Map([
      [
        "guided",
        makeSkill(
          "guided",
          [],
          [],
          "ALWAYS call module_info first\n- Check _HINTS\n\nSome paragraph text\n",
        ),
      ],
    ]);
    const patterns = new Map<string, Pattern>();

    const result = resolveApproach(["guided"], skills, patterns);
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.rules.some((r) => r.includes("module_info"))).toBe(true);
  });

  it("should prefix steps with pattern name", () => {
    const skills = new Map([["s1", makeSkill("s1", ["p1"])]]);
    const patterns = new Map([
      ["p1", makePattern("p1", { steps: ["Do thing"] })],
    ]);

    const result = resolveApproach(["s1"], skills, patterns);
    expect(result.steps[0]).toBe("[p1] Do thing");
  });

  it("should collect requiredMcp from skills", () => {
    const skill: Skill = {
      name: "kql",
      description: "",
      triggers: [],
      patterns: [],
      antiPatterns: [],
      requiresMcp: ["fabric-rti-mcp"],
      guidance: "",
      source: "system",
      filePath: "/tmp/test/kql/SKILL.md",
    };
    const skills = new Map([["kql", skill]]);
    const patterns = new Map<string, Pattern>();

    const result = resolveApproach(["kql"], skills, patterns);
    expect(result.requiredMcp).toEqual(["fabric-rti-mcp"]);
    // mcpStatus starts empty (populated by caller)
    expect(result.mcpStatus).toEqual([]);
  });

  it("should union requiredMcp across multiple skills", () => {
    const s1: Skill = {
      name: "s1",
      description: "",
      triggers: [],
      patterns: [],
      antiPatterns: [],
      requiresMcp: ["fabric-rti-mcp"],
      guidance: "",
      source: "system",
      filePath: "/tmp/test/s1/SKILL.md",
    };
    const s2: Skill = {
      name: "s2",
      description: "",
      triggers: [],
      patterns: [],
      antiPatterns: [],
      requiresMcp: ["fabric-rti-mcp", "other-mcp"],
      guidance: "",
      source: "system",
      filePath: "/tmp/test/s2/SKILL.md",
    };
    const skills = new Map([
      ["s1", s1],
      ["s2", s2],
    ]);
    const patterns = new Map<string, Pattern>();

    const result = resolveApproach(["s1", "s2"], skills, patterns);
    expect(result.requiredMcp.sort()).toEqual(["fabric-rti-mcp", "other-mcp"]);
  });

  it("should return empty requiredMcp when skills have none", () => {
    const skills = new Map([["s1", makeSkill("s1", ["p1"])]]);
    const patterns = new Map([["p1", makePattern("p1")]]);

    const result = resolveApproach(["s1"], skills, patterns);
    expect(result.requiredMcp).toEqual([]);
  });
});

describe("formatGuidance — MCP Servers section", () => {
  function makeGuidance(
    overrides: Partial<MaterialisedGuidance> = {},
  ): MaterialisedGuidance {
    return {
      matchedSkills: [],
      modules: [],
      plugins: [],
      profiles: [],
      config: {},
      steps: [],
      rules: [],
      antiPatterns: [],
      requiredMcp: [],
      mcpStatus: [],
      ...overrides,
    };
  }

  it("should show ❌ for unconfigured MCP server", () => {
    const status: MCPServerStatus = {
      name: "fabric-rti-mcp",
      configured: false,
    };
    const output = formatGuidance(makeGuidance({ mcpStatus: [status] }));
    expect(output).toContain("MCP Servers:");
    expect(output).toContain("❌ fabric-rti-mcp — not configured");
    expect(output).toContain("hyperagent --mcp-setup-fabric-rti");
  });

  it("should show ✅ for connected MCP server", () => {
    const status: MCPServerStatus = {
      name: "fabric-rti-mcp",
      configured: true,
      state: "connected",
      toolCount: 13,
    };
    const output = formatGuidance(makeGuidance({ mcpStatus: [status] }));
    expect(output).toContain("✅ fabric-rti-mcp — connected (13 tools)");
    expect(output).toContain("host:mcp-fabric-rti-mcp");
  });

  it("should show ⚠️ for errored MCP server", () => {
    const status: MCPServerStatus = {
      name: "fabric-rti-mcp",
      configured: true,
      state: "error",
      lastError: "auth failed",
    };
    const output = formatGuidance(makeGuidance({ mcpStatus: [status] }));
    expect(output).toContain("⚠️ fabric-rti-mcp — configured but errored");
    expect(output).toContain("auth failed");
  });

  it("should show ⚡ for idle/configured MCP server", () => {
    const status: MCPServerStatus = {
      name: "fabric-rti-mcp",
      configured: true,
      state: "idle",
    };
    const output = formatGuidance(makeGuidance({ mcpStatus: [status] }));
    expect(output).toContain("⚡ fabric-rti-mcp — configured (idle)");
    expect(output).toContain('manage_mcp({action:"connect"');
  });

  it("should omit MCP section when mcpStatus is empty", () => {
    const output = formatGuidance(makeGuidance());
    expect(output).not.toContain("MCP Servers:");
  });
});
