// ── Tune Mode Tests ──────────────────────────────────────────────────
//
// Tests for the --tune CLI flag and tuning data capture infrastructure.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseCliArgs } from "../src/agent/cli-parser.js";

describe("tune CLI flag", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Clear any tune-related env vars before each test
    delete process.env.HYPERAGENT_TUNE;
  });

  afterEach(() => {
    // Restore environment
    process.env = { ...origEnv };
  });

  it("should default to tune=false", () => {
    const config = parseCliArgs([]);
    expect(config.tune).toBe(false);
  });

  it("should enable tune via --tune flag", () => {
    const config = parseCliArgs(["--tune"]);
    expect(config.tune).toBe(true);
  });

  it("should enable tune via HYPERAGENT_TUNE=1 env var", () => {
    process.env.HYPERAGENT_TUNE = "1";
    const config = parseCliArgs([]);
    expect(config.tune).toBe(true);
  });

  it("should not enable tune when env var is not '1'", () => {
    process.env.HYPERAGENT_TUNE = "0";
    const config = parseCliArgs([]);
    expect(config.tune).toBe(false);
  });

  it("should have --tune override env var when both set", () => {
    process.env.HYPERAGENT_TUNE = "0";
    const config = parseCliArgs(["--tune"]);
    expect(config.tune).toBe(true);
  });

  it("should coexist with other flags without interference", () => {
    const config = parseCliArgs(["--tune", "--debug", "--verbose"]);
    expect(config.tune).toBe(true);
    expect(config.debug).toBe(true);
    expect(config.verbose).toBe(true);
  });
});

describe("profile CLI flag", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HYPERAGENT_PROFILE;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("should default to empty profile", () => {
    const config = parseCliArgs([]);
    expect(config.profile).toBe("");
  });

  it("should accept a single profile name", () => {
    const config = parseCliArgs(["--profile", "file-builder"]);
    expect(config.profile).toBe("file-builder");
  });

  it("should accept space-separated stacked profiles as a quoted string", () => {
    const config = parseCliArgs(["--profile", "web-research heavy-compute"]);
    expect(config.profile).toBe("web-research heavy-compute");
  });

  it("should read from HYPERAGENT_PROFILE env var", () => {
    process.env.HYPERAGENT_PROFILE = "heavy-compute";
    const config = parseCliArgs([]);
    expect(config.profile).toBe("heavy-compute");
  });

  it("should have --profile override env var", () => {
    process.env.HYPERAGENT_PROFILE = "default";
    const config = parseCliArgs(["--profile", "file-builder"]);
    expect(config.profile).toBe("file-builder");
  });

  it("should coexist with other flags", () => {
    const config = parseCliArgs([
      "--profile",
      "web-research",
      "--debug",
      "--tune",
    ]);
    expect(config.profile).toBe("web-research");
    expect(config.debug).toBe(true);
    expect(config.tune).toBe(true);
  });
});

describe("MCP setup CLI flags", () => {
  it("parses standalone no-arg MCP setup commands", () => {
    expect(parseCliArgs(["--mcp-setup-everything"]).mcpSetupCommand).toEqual({
      kind: "setup-everything",
    });
    expect(parseCliArgs(["--mcp-setup-github"]).mcpSetupCommand).toEqual({
      kind: "setup-github",
    });
    expect(parseCliArgs(["--mcp-show-config"]).mcpSetupCommand).toEqual({
      kind: "show-config",
    });
  });

  it("parses filesystem setup with default and explicit directories", () => {
    expect(parseCliArgs(["--mcp-setup-filesystem"]).mcpSetupCommand).toEqual({
      kind: "setup-filesystem",
      dir: "/tmp/mcp-fs",
    });
    expect(
      parseCliArgs(["--mcp-setup-filesystem", "/var/tmp/mcp"]).mcpSetupCommand,
    ).toEqual({
      kind: "setup-filesystem",
      dir: "/var/tmp/mcp",
    });
  });

  it("captures remaining args for setup helpers with pass-through options", () => {
    expect(
      parseCliArgs([
        "--mcp-add-http",
        "example",
        "https://mcp.example.com/sse",
        "client",
        "tenant",
        "scope.one,scope.two",
        "browser",
      ]).mcpSetupCommand,
    ).toEqual({
      kind: "add-http",
      args: [
        "example",
        "https://mcp.example.com/sse",
        "client",
        "tenant",
        "scope.one,scope.two",
        "browser",
      ],
    });

    expect(
      parseCliArgs(["--mcp-m365-create-app", "--client-id", "abc"])
        .mcpSetupCommand,
    ).toEqual({ kind: "m365-create-app", args: ["--client-id", "abc"] });
  });
});
