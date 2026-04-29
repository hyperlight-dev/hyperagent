// ── Profile Tests ────────────────────────────────────────────────────
//
// Tests for the resource profile system: profile definitions, merging,
// stacking, and display formatting.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  getProfile,
  getProfileNames,
  mergeProfiles,
  formatProfile,
  formatAllProfiles,
  PROFILES,
} from "../src/agent/profiles.js";

describe("profile registry", () => {
  it("should have exactly 5 built-in profiles", () => {
    expect(PROFILES.size).toBe(5);
  });

  it("should include all expected profile names", () => {
    const names = getProfileNames();
    expect(names).toContain("default");
    expect(names).toContain("file-builder");
    expect(names).toContain("web-research");
    expect(names).toContain("heavy-compute");
    expect(names).toContain("mcp-network");
  });

  it("should return undefined for unknown profile", () => {
    expect(getProfile("nonexistent")).toBeUndefined();
  });

  it("should return valid profile objects", () => {
    for (const [name, profile] of PROFILES) {
      expect(profile.name).toBe(name);
      expect(profile.description).toBeTruthy();
      expect(profile.patterns).toBeDefined();
      expect(Array.isArray(profile.patterns)).toBe(true);
      expect(profile.useCases.length).toBeGreaterThan(0);
      expect(profile.limits).toBeDefined();
    }
  });
});

describe("profile definitions", () => {
  it("default profile should have no plugins", () => {
    const p = getProfile("default")!;
    expect(p.plugins).toHaveLength(0);
    expect(p.limits.cpuTimeoutMs).toBe(1000);
    expect(p.limits.wallTimeoutMs).toBe(5000);
    expect(p.limits.heapMb).toBe(16);
    expect(p.limits.scratchMb).toBe(16);
  });

  it("file-builder should include fs-write with defaultConfig", () => {
    const p = getProfile("file-builder")!;
    expect(p.plugins.map((pl) => pl.name)).toContain("fs-write");
    const fsWrite = p.plugins.find((pl) => pl.name === "fs-write")!;
    expect(fsWrite.defaultConfig).toBeDefined();
    expect(fsWrite.defaultConfig!.maxWriteSizeKb).toBe(20480);
    expect(p.limits.heapMb).toBe(128);
    expect(p.limits.cpuTimeoutMs).toBe(15000); // Increased for image-heavy PPTX
    expect(p.limits.wallTimeoutMs).toBe(60000);
  });

  it("web-research should include fetch with defaultConfig", () => {
    const p = getProfile("web-research")!;
    const pluginNames = p.plugins.map((pl) => pl.name);
    expect(pluginNames).toContain("fetch");
    expect(pluginNames).toContain("fs-write");
    const fetch = p.plugins.find((pl) => pl.name === "fetch")!;
    expect(fetch.defaultConfig).toBeDefined();
    expect(fetch.defaultConfig!.allowPost).toBe(false);
    expect(fetch.defaultConfig!.maxResponseSizeKb).toBe(4096);
    expect(fetch.defaultConfig!.autoRetryOn429).toBe(true);
    expect(p.limits.wallTimeoutMs).toBe(120000); // Allows for 429 auto-retry waits
  });

  it("heavy-compute should have generous limits and no plugins", () => {
    const p = getProfile("heavy-compute")!;
    expect(p.plugins).toHaveLength(0);
    expect(p.limits.cpuTimeoutMs).toBe(10000);
    expect(p.limits.heapMb).toBe(64);
    expect(p.limits.scratchMb).toBe(64);
  });

  it("mcp-network should bump wall time without enabling plugins", () => {
    const p = getProfile("mcp-network")!;
    expect(p.plugins).toHaveLength(0);
    expect(p.limits.cpuTimeoutMs).toBe(2000);
    expect(p.limits.wallTimeoutMs).toBe(30000);
    expect(p.limits.heapMb).toBe(32);
    expect(p.limits.scratchMb).toBe(32);
  });
});

describe("mergeProfiles", () => {
  it("should merge a single profile", () => {
    const result = mergeProfiles(["file-builder"]);
    expect(result.error).toBeUndefined();
    expect(result.appliedProfiles).toEqual(["file-builder"]);
    expect(result.limits.heapMb).toBe(128);
    expect(result.plugins.map((p) => p.name)).toContain("fs-write");
  });

  it("should stack two profiles taking max of each limit", () => {
    const result = mergeProfiles(["web-research", "heavy-compute"]);
    expect(result.error).toBeUndefined();
    expect(result.appliedProfiles).toEqual(["web-research", "heavy-compute"]);

    // Max of each: web-research has wall=120000, heavy-compute has cpu=10000
    expect(result.limits.cpuTimeoutMs).toBe(10000); // heavy-compute wins
    expect(result.limits.wallTimeoutMs).toBe(120000); // web-research wins
    expect(result.limits.heapMb).toBe(64); // both 64 and 32 → 64
    expect(result.limits.scratchMb).toBe(64); // heavy-compute wins
  });

  it("should union plugins when stacking", () => {
    const result = mergeProfiles(["web-research", "file-builder"]);
    const pluginNames = result.plugins.map((p) => p.name);
    expect(pluginNames).toContain("fetch");
    expect(pluginNames).toContain("fs-write");
    // fs-write should NOT be duplicated
    expect(pluginNames.filter((n) => n === "fs-write")).toHaveLength(1);
  });

  it("should merge plugin defaultConfig when stacking", () => {
    // web-research has fetch with allowPost=false
    // file-builder has fs-write with maxWriteSizeKb=10240
    // Stacking should preserve both plugin configs
    const result = mergeProfiles(["web-research", "file-builder"]);
    const fetchPlugin = result.plugins.find((p) => p.name === "fetch");
    const fsWritePlugin = result.plugins.find((p) => p.name === "fs-write");
    expect(fetchPlugin?.defaultConfig?.allowPost).toBe(false);
    expect(fsWritePlugin?.defaultConfig?.maxWriteSizeKb).toBe(20480);
  });

  it("should return error for unknown profile", () => {
    const result = mergeProfiles(["nonexistent"]);
    expect(result.error).toContain("Unknown profile(s): nonexistent");
    expect(result.appliedProfiles).toEqual([]);
  });

  it("should return error for mixed known/unknown profiles", () => {
    const result = mergeProfiles(["file-builder", "bogus"]);
    expect(result.error).toContain("Unknown profile(s): bogus");
  });

  it("should return error for empty array", () => {
    const result = mergeProfiles([]);
    expect(result.error).toContain("No profiles specified");
  });

  it("should handle stacking all profiles", () => {
    const result = mergeProfiles(getProfileNames());
    expect(result.error).toBeUndefined();
    expect(result.appliedProfiles).toHaveLength(5);

    // Max across all profiles
    expect(result.limits.cpuTimeoutMs).toBe(15000); // file-builder
    expect(result.limits.wallTimeoutMs).toBe(120000); // web-research (allows 429 auto-retry)
    expect(result.limits.heapMb).toBe(128); // file-builder
    expect(result.limits.scratchMb).toBe(128); // file-builder

    // Union of all plugins (fetch + fs-write, deduplicated)
    const pluginNames = result.plugins.map((p) => p.name);
    expect(pluginNames).toContain("fetch");
    expect(pluginNames).toContain("fs-write");
  });

  it("should stack mcp-network without adding plugins", () => {
    const result = mergeProfiles(["default", "mcp-network"]);
    expect(result.error).toBeUndefined();
    expect(result.appliedProfiles).toEqual(["default", "mcp-network"]);
    expect(result.limits.cpuTimeoutMs).toBe(2000);
    expect(result.limits.wallTimeoutMs).toBe(30000);
    expect(result.limits.heapMb).toBe(32);
    expect(result.plugins).toHaveLength(0);
  });

  it("should handle duplicate profile names gracefully", () => {
    const result = mergeProfiles(["file-builder", "file-builder"]);
    expect(result.error).toBeUndefined();
    // Plugins should still be deduplicated
    const pluginNames = result.plugins.map((p) => p.name);
    expect(pluginNames.filter((n) => n === "fs-write")).toHaveLength(1);
  });
});

describe("formatProfile", () => {
  it("should include profile name and description", () => {
    const p = getProfile("file-builder")!;
    const output = formatProfile(p);
    expect(output).toContain("file-builder");
    expect(output).toContain("Build files");
  });

  it("should include limits", () => {
    const p = getProfile("file-builder")!;
    const output = formatProfile(p);
    expect(output).toContain("cpu=15000ms"); // Increased for image-heavy PPTX
    expect(output).toContain("heap=128MB");
    expect(output).toContain("wall=60000ms");
  });

  it("should include plugin names", () => {
    const p = getProfile("web-research")!;
    const output = formatProfile(p);
    expect(output).toContain("fetch");
    expect(output).toContain("fs-write");
  });

  it("should show 'none' for profiles without plugins", () => {
    const p = getProfile("default")!;
    const output = formatProfile(p);
    expect(output).toContain("Plugins: none");
  });
});

describe("formatAllProfiles", () => {
  it("should include all profile names", () => {
    const output = formatAllProfiles();
    for (const name of getProfileNames()) {
      expect(output).toContain(name);
    }
  });

  it("should separate profiles with blank lines", () => {
    const output = formatAllProfiles();
    expect(output).toContain("\n\n");
  });
});
