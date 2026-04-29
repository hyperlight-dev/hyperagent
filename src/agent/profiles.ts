// ── agent/profiles.ts — Resource profile definitions ─────────────────
//
// A profile bundles resource limits + plugin requirements into a named
// preset aligned with common sandbox usage patterns.
//
// ─────────────────────────────────────────────────────────────────────

/** Resource limits within a profile. All fields optional — unset = no change. */
export interface ProfileLimits {
  /** CPU timeout in milliseconds. */
  cpuTimeoutMs?: number;
  /** Wall-clock timeout in milliseconds. */
  wallTimeoutMs?: number;
  /** Guest heap size in megabytes. */
  heapMb?: number;
  /** Guest scratch size in megabytes. */
  scratchMb?: number;
  /** Input buffer size in kilobytes. */
  inputBufferKb?: number;
  /** Output buffer size in kilobytes. */
  outputBufferKb?: number;
}

/** Plugin requirement within a profile. */
export interface ProfilePlugin {
  /** Plugin name (e.g. "fs-write", "fetch"). */
  name: string;
  /** Default config to apply when enabling. Optional. */
  defaultConfig?: Record<string, unknown>;
}

/** A named resource profile. */
export interface Profile {
  /** Unique profile name (lowercase, kebab-case). */
  name: string;
  /** One-line description shown in listings. */
  description: string;
  /** Which pattern(s) this profile aligns with. */
  patterns: string[];
  /** Typical use cases — helps the LLM decide which profile to use. */
  useCases: string[];
  /** Resource limits this profile sets. */
  limits: ProfileLimits;
  /** Plugins this profile requires (enabled with audit+approval). */
  plugins: ProfilePlugin[];
}

// ── Built-in Profiles ────────────────────────────────────────────────

/**
 * The default profile — matches the out-of-the-box sandbox configuration.
 * Pure computation, no I/O, standard resource limits.
 */
const DEFAULT_PROFILE: Profile = {
  name: "default",
  description: "Pure computation — no I/O, standard limits",
  patterns: [],
  useCases: [
    "Math and algorithms",
    "Data transformation and processing",
    "String manipulation and regex",
    "JSON parsing and generation",
  ],
  limits: {
    cpuTimeoutMs: 1000,
    wallTimeoutMs: 5000,
    heapMb: 16,
    scratchMb: 16,
  },
  plugins: [],
};

/**
 * File builder profile — for generating binary and text files.
 * Enables fs-write (+ fs-read companion), bumps heap and timeouts
 * for ZIP/PPTX/CSV assembly.
 *
 * Note: CPU timeout set to 15000ms because image-heavy PPTX generation
 * (6+ embedded images) requires significant time for base64 encoding +
 * DEFLATE compression + ZIP assembly. Wall timeout at 60s allows for
 * complex multi-image presentations.
 */
const FILE_BUILDER_PROFILE: Profile = {
  name: "file-builder",
  description: "Build files (ZIP, PPTX, CSV, images) — fs-write enabled",
  patterns: ["two-handler-pipeline", "file-generation", "image-embed"],
  useCases: [
    "Generate ZIP, PPTX, PDF, or CSV files",
    "Build binary file formats from scratch",
    "Assemble multi-part outputs via intermediate files",
    "Image generation and manipulation",
  ],
  limits: {
    cpuTimeoutMs: 15000, // 15s — image embedding is CPU-intensive
    wallTimeoutMs: 60000, // 60s — allow for complex multi-image builds
    heapMb: 128, // 128MB — large presentations with many images
    scratchMb: 128, // Must match heap — shared-state serialization needs scratch space
    inputBufferKb: 16384, // 16MB — large handler code + restored state
    outputBufferKb: 16384, // 16MB — serialized pres with embedded images
  },
  plugins: [
    {
      name: "fs-write",
      defaultConfig: {
        maxWriteSizeKb: 20480, // 20 MB — generous for file building
        maxEntries: 1000,
      },
    },
  ],
};

/**
 * Web research profile — for fetching URLs, processing data, saving results.
 * Enables fetch + fs-write, bumps wall timeout for network latency.
 * Auto-retry on 429 is enabled to handle rate-limited APIs gracefully.
 */
const WEB_RESEARCH_PROFILE: Profile = {
  name: "web-research",
  description: "Fetch URLs, process data, save results — fetch + fs-write",
  patterns: ["fetch-and-process", "data-extraction", "image-embed"],
  useCases: [
    "Scrape web pages or APIs",
    "Download and process JSON/CSV data",
    "Research tasks requiring multiple URL fetches",
    "Build reports from web data",
  ],
  limits: {
    cpuTimeoutMs: 2000,
    wallTimeoutMs: 120000, // 2 min — allows for 429 auto-retry waits
    heapMb: 64, // 64MB — room for multiple large images in memory
    scratchMb: 64, // Must match heap — shared-state serialization needs scratch space
    inputBufferKb: 4096, // 4MB — restored state with images
    outputBufferKb: 8192, // 8MB — serialized state with images
  },
  plugins: [
    {
      name: "fetch",
      defaultConfig: {
        allowPost: false, // read-only research by default
        maxResponseSizeKb: 4096, // 4MB — large images
        maxDataReceivedKb: 8192, // 8MB data budget for research + images
        readTimeoutMs: 15000, // 15s per request for slow APIs
        maxParallelFetches: 4, // Parallel batch downloads (4x speedup for images)
        maxDomainsPerSession: 15, // Research tasks hit many domains (providers + subdomains)
        allowedContentTypes: [
          "application/json",
          "text/plain",
          "text/markdown",
          "text/html",
          "text/csv",
          "text/x-wiki", // Wikipedia raw article format
          "application/xml",
          "text/xml",
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/svg+xml",
          "image/webp",
          "application/vnd.github", // GitHub API vendor media types
        ],
        // Auto-retry on 429: wait up to 30s per retry, max 3 attempts
        autoRetryOn429: true,
        autoRetryMaxWaitSeconds: 30,
        autoRetryMaxAttempts: 3,
      },
    },
    {
      name: "fs-write",
      defaultConfig: {
        maxWriteSizeKb: 10240,
        maxEntries: 500,
      },
    },
  ],
};

/**
 * Heavy compute profile — for CPU-intensive work with generous limits.
 * No additional plugins — just more time and memory.
 */
const HEAVY_COMPUTE_PROFILE: Profile = {
  name: "heavy-compute",
  description: "CPU-intensive work — generous time and memory limits",
  patterns: ["data-transformation"],
  useCases: [
    "Large dataset processing",
    "Complex algorithms and simulations",
    "Cryptographic operations",
    "Multi-pass data analysis",
  ],
  limits: {
    cpuTimeoutMs: 10000,
    wallTimeoutMs: 15000,
    heapMb: 64,
    scratchMb: 64,
  },
  plugins: [],
};

/**
 * MCP network profile — for handlers that call external MCP services.
 * Network I/O consumes wall-clock time while CPU remains low, so this
 * bumps wall timeout without enabling file plugins or inflating CPU.
 */
const MCP_NETWORK_PROFILE: Profile = {
  name: "mcp-network",
  description: "MCP service calls — longer wall timeout, no file plugins",
  patterns: [],
  useCases: [
    "Calling MCP tools from handler code",
    "External service reads, searches, and lookups via MCP",
    "Multi-call MCP handlers that wait on network I/O",
  ],
  limits: {
    cpuTimeoutMs: 2000,
    wallTimeoutMs: 30000,
    heapMb: 32,
    scratchMb: 32,
    inputBufferKb: 4096,
    outputBufferKb: 4096,
  },
  plugins: [],
};

// ── Profile Registry ─────────────────────────────────────────────────

/** All built-in profiles, keyed by name. */
export const PROFILES: ReadonlyMap<string, Profile> = new Map([
  [DEFAULT_PROFILE.name, DEFAULT_PROFILE],
  [FILE_BUILDER_PROFILE.name, FILE_BUILDER_PROFILE],
  [WEB_RESEARCH_PROFILE.name, WEB_RESEARCH_PROFILE],
  [HEAVY_COMPUTE_PROFILE.name, HEAVY_COMPUTE_PROFILE],
  [MCP_NETWORK_PROFILE.name, MCP_NETWORK_PROFILE],
]);

/** Get a profile by name, or undefined if not found. */
export function getProfile(name: string): Profile | undefined {
  return PROFILES.get(name);
}

/** Get all profile names. */
export function getProfileNames(): string[] {
  return [...PROFILES.keys()];
}

/**
 * Merge multiple profiles into a single effective configuration.
 * Takes the MAX of each limit and the UNION of all plugins.
 *
 * @param names — Profile names to merge (order doesn't matter)
 * @returns Merged limits + deduplicated plugin list, or error
 */
export function mergeProfiles(names: string[]): {
  limits: ProfileLimits;
  plugins: ProfilePlugin[];
  appliedProfiles: string[];
  error?: string;
} {
  const resolved: Profile[] = [];
  const unknown: string[] = [];

  for (const name of names) {
    const profile = PROFILES.get(name);
    if (profile) {
      resolved.push(profile);
    } else {
      unknown.push(name);
    }
  }

  if (unknown.length > 0) {
    return {
      limits: {},
      plugins: [],
      appliedProfiles: [],
      error: `Unknown profile(s): ${unknown.join(", ")}. Available: ${getProfileNames().join(", ")}`,
    };
  }

  if (resolved.length === 0) {
    return {
      limits: {},
      plugins: [],
      appliedProfiles: [],
      error: `No profiles specified. Available: ${getProfileNames().join(", ")}`,
    };
  }

  // Merge limits — take max of each field across all profiles
  const merged: ProfileLimits = {};
  for (const p of resolved) {
    if (p.limits.cpuTimeoutMs !== undefined) {
      merged.cpuTimeoutMs = Math.max(
        merged.cpuTimeoutMs ?? 0,
        p.limits.cpuTimeoutMs,
      );
    }
    if (p.limits.wallTimeoutMs !== undefined) {
      merged.wallTimeoutMs = Math.max(
        merged.wallTimeoutMs ?? 0,
        p.limits.wallTimeoutMs,
      );
    }
    if (p.limits.heapMb !== undefined) {
      merged.heapMb = Math.max(merged.heapMb ?? 0, p.limits.heapMb);
    }
    if (p.limits.scratchMb !== undefined) {
      merged.scratchMb = Math.max(merged.scratchMb ?? 0, p.limits.scratchMb);
    }
    if (p.limits.inputBufferKb !== undefined) {
      merged.inputBufferKb = Math.max(
        merged.inputBufferKb ?? 0,
        p.limits.inputBufferKb,
      );
    }
    if (p.limits.outputBufferKb !== undefined) {
      merged.outputBufferKb = Math.max(
        merged.outputBufferKb ?? 0,
        p.limits.outputBufferKb,
      );
    }
  }

  // Merge plugins — union, deduplicated by name.
  // When stacking, merge defaultConfig from all profiles for the same plugin.
  const pluginMap = new Map<string, ProfilePlugin>();
  for (const p of resolved) {
    for (const plugin of p.plugins) {
      const existing = pluginMap.get(plugin.name);
      if (existing) {
        // Merge configs — later profile's config wins on conflicts
        existing.defaultConfig = {
          ...(existing.defaultConfig ?? {}),
          ...(plugin.defaultConfig ?? {}),
        };
      } else {
        // Clone to avoid mutating the original profile definition
        pluginMap.set(plugin.name, {
          ...plugin,
          defaultConfig: plugin.defaultConfig
            ? { ...plugin.defaultConfig }
            : undefined,
        });
      }
    }
  }

  return {
    limits: merged,
    plugins: [...pluginMap.values()],
    appliedProfiles: resolved.map((p) => p.name),
  };
}

/**
 * Format a profile for display (terminal or LLM response).
 * Returns a compact multi-line string.
 */
export function formatProfile(profile: Profile): string {
  const lines: string[] = [
    `${profile.name}: ${profile.description}`,
    `  Use cases: ${profile.useCases.join(", ")}`,
    `  Limits: cpu=${profile.limits.cpuTimeoutMs ?? "-"}ms, wall=${profile.limits.wallTimeoutMs ?? "-"}ms, heap=${profile.limits.heapMb ?? "-"}MB, scratch=${profile.limits.scratchMb ?? "-"}MB`,
  ];
  if (profile.plugins.length > 0) {
    const pluginStrs = profile.plugins.map((p) => {
      if (p.defaultConfig && Object.keys(p.defaultConfig).length > 0) {
        const cfgStr = Object.entries(p.defaultConfig)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        return `${p.name} (${cfgStr})`;
      }
      return p.name;
    });
    lines.push(`  Plugins: ${pluginStrs.join(", ")}`);
  } else {
    lines.push(`  Plugins: none`);
  }
  lines.push(`  Patterns: ${profile.patterns.join(", ")}`);
  return lines.join("\n");
}

/**
 * Format all profiles for display.
 */
export function formatAllProfiles(): string {
  return [...PROFILES.values()].map(formatProfile).join("\n\n");
}
