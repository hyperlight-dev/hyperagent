// ── CLI Parser Tests ─────────────────────────────────────────────────
//
// Covers the breaking-change flag cleanup:
//   - `--reasoning-effort` (renamed from `--show-reasoning`)
//   - `--very-verbose` / `-vv` (new)
//   - `--base-dir` / `HYPERAGENT_BASE_DIR` (new)
//   - rejection of the removed `--show-reasoning` flag
//
// Also exercises the `--yolo` alias for `--auto-approve`.
// ─────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/agent/cli-parser.js";

// Env vars that parseCliArgs consults at call-time. Snapshot and restore
// around each test so the host environment can't leak into assertions.
const ENV_KEYS = [
  "HYPERAGENT_REASONING_EFFORT",
  "HYPERAGENT_VERBOSE",
  "HYPERAGENT_VERY_VERBOSE",
  "HYPERAGENT_BASE_DIR",
  "HYPERAGENT_AUTO_APPROVE",
] as const;

describe("parseCliArgs — breaking flag cleanup", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.restoreAllMocks();
  });

  // ── --reasoning-effort ───────────────────────────────────────────
  describe("--reasoning-effort", () => {
    it("defaults to empty when not given (env nor flag)", () => {
      const cfg = parseCliArgs([]);
      expect(cfg.reasoningEffort).toBe("");
    });

    it("defaults to 'high' when flag given without a level", () => {
      const cfg = parseCliArgs(["--reasoning-effort"]);
      expect(cfg.reasoningEffort).toBe("high");
    });

    it("accepts low/medium/high/xhigh (case-insensitive)", () => {
      for (const level of ["low", "medium", "high", "xhigh"]) {
        expect(
          parseCliArgs(["--reasoning-effort", level]).reasoningEffort,
        ).toBe(level);
        expect(
          parseCliArgs(["--reasoning-effort", level.toUpperCase()])
            .reasoningEffort,
        ).toBe(level);
      }
    });

    it("falls back to 'high' when the next arg is not a valid level", () => {
      // Next token is treated as belonging to a later flag; parser
      // defaults the effort to 'high' and does NOT consume the token.
      const cfg = parseCliArgs(["--reasoning-effort", "--verbose"]);
      expect(cfg.reasoningEffort).toBe("high");
      expect(cfg.verbose).toBe(true);
    });

    it("reads HYPERAGENT_REASONING_EFFORT env var", () => {
      process.env.HYPERAGENT_REASONING_EFFORT = "medium";
      expect(parseCliArgs([]).reasoningEffort).toBe("medium");
    });

    it("CLI flag overrides env var", () => {
      process.env.HYPERAGENT_REASONING_EFFORT = "low";
      expect(
        parseCliArgs(["--reasoning-effort", "xhigh"]).reasoningEffort,
      ).toBe("xhigh");
    });
  });

  // ── --show-reasoning is REMOVED (hard break) ─────────────────────
  describe("--show-reasoning (removed)", () => {
    it("rejects --show-reasoning with 'Unknown option' and exits", () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
        code?: number,
      ) => {
        throw new Error(`__exit_${code}`);
      }) as never);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(() => parseCliArgs(["--show-reasoning"])).toThrow("__exit_1");
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unknown option: --show-reasoning"),
      );
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("ignores HYPERAGENT_SHOW_REASONING (old env var is dead)", () => {
      // The old env var should not be wired anywhere. Setting it must not
      // affect reasoningEffort.
      process.env.HYPERAGENT_SHOW_REASONING = "xhigh";
      const cfg = parseCliArgs([]);
      expect(cfg.reasoningEffort).toBe("");
      delete process.env.HYPERAGENT_SHOW_REASONING;
    });
  });

  // ── --very-verbose / -vv ─────────────────────────────────────────
  describe("--very-verbose / -vv", () => {
    it("defaults to false when not given", () => {
      const cfg = parseCliArgs([]);
      expect(cfg.veryVerbose).toBe(false);
      expect(cfg.verbose).toBe(false);
    });

    it("--very-verbose sets BOTH verbose AND veryVerbose", () => {
      const cfg = parseCliArgs(["--very-verbose"]);
      expect(cfg.verbose).toBe(true);
      expect(cfg.veryVerbose).toBe(true);
    });

    it("-vv is equivalent to --very-verbose", () => {
      const cfg = parseCliArgs(["-vv"]);
      expect(cfg.verbose).toBe(true);
      expect(cfg.veryVerbose).toBe(true);
    });

    it("--verbose on its own does NOT enable veryVerbose", () => {
      const cfg = parseCliArgs(["--verbose"]);
      expect(cfg.verbose).toBe(true);
      expect(cfg.veryVerbose).toBe(false);
    });

    it("HYPERAGENT_VERY_VERBOSE=1 enables veryVerbose (env)", () => {
      process.env.HYPERAGENT_VERY_VERBOSE = "1";
      const cfg = parseCliArgs([]);
      expect(cfg.veryVerbose).toBe(true);
    });

    it("HYPERAGENT_VERY_VERBOSE=1 ALSO enables verbose (env-path symmetry)", () => {
      // Regression: without this, env-var-only very-verbose would set
      // veryVerbose=true but verbose=false, and the event-handler gate
      // (`verboseOutput && (isSandbox || veryVerbose)`) would silently
      // suppress all tool bodies — defeating the whole flag.
      process.env.HYPERAGENT_VERY_VERBOSE = "1";
      delete process.env.HYPERAGENT_VERBOSE;
      const cfg = parseCliArgs([]);
      expect(cfg.verbose).toBe(true);
      expect(cfg.veryVerbose).toBe(true);
    });

    it("HYPERAGENT_VERY_VERBOSE=0 leaves veryVerbose false", () => {
      process.env.HYPERAGENT_VERY_VERBOSE = "0";
      const cfg = parseCliArgs([]);
      expect(cfg.veryVerbose).toBe(false);
    });
  });

  // ── --base-dir ───────────────────────────────────────────────────
  describe("--base-dir", () => {
    it("defaults to empty string when not given", () => {
      expect(parseCliArgs([]).baseDir).toBe("");
    });

    it("accepts a path argument", () => {
      const cfg = parseCliArgs(["--base-dir", "/tmp/sandbox"]);
      expect(cfg.baseDir).toBe("/tmp/sandbox");
    });

    it("preserves the raw value (no resolution at parse-time)", () => {
      // Path resolution happens in index.ts after parse — keep the parser
      // pure so it can be unit-tested without filesystem context.
      const cfg = parseCliArgs(["--base-dir", "./relative/path"]);
      expect(cfg.baseDir).toBe("./relative/path");
    });

    it("exits when --base-dir has no value", () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
        code?: number,
      ) => {
        throw new Error(`__exit_${code}`);
      }) as never);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(() => parseCliArgs(["--base-dir"])).toThrow("__exit_1");
      expect(errSpy).toHaveBeenCalledWith("--base-dir requires a value");
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("reads HYPERAGENT_BASE_DIR env var", () => {
      process.env.HYPERAGENT_BASE_DIR = "/var/data";
      expect(parseCliArgs([]).baseDir).toBe("/var/data");
    });

    it("CLI flag overrides env var", () => {
      process.env.HYPERAGENT_BASE_DIR = "/from/env";
      const cfg = parseCliArgs(["--base-dir", "/from/cli"]);
      expect(cfg.baseDir).toBe("/from/cli");
    });
  });

  // ── --yolo (alias) ───────────────────────────────────────────────
  describe("--yolo / --auto-approve", () => {
    it("--yolo is equivalent to --auto-approve", () => {
      expect(parseCliArgs(["--yolo"]).autoApprove).toBe(true);
      expect(parseCliArgs(["--auto-approve"]).autoApprove).toBe(true);
    });

    it("--yolo does NOT auto-enable --base-dir", () => {
      // Sanity check: the two flags are independent.
      const cfg = parseCliArgs(["--yolo"]);
      expect(cfg.autoApprove).toBe(true);
      expect(cfg.baseDir).toBe("");
    });
  });
});
