// hyperlight-analysis - Secure code analysis via Hyperlight micro-VM isolation
//
// Copyright 2026  The Hyperlight Authors. Licensed under Apache-2.0.

const { existsSync } = require("node:fs");
const { join } = require("node:path");

let nativeBinding = null;
let loadError = null;

// Platform detection - napi-rs uses specific triple naming
const platform = process.platform;
const arch = process.arch;

// Map to napi-rs triple names
const tripleMap = {
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "win32-x64-msvc",
};

const platformArch = `${platform}-${arch}`;
const triple = tripleMap[platformArch] || platformArch;

const possiblePaths = [
  // napi-rs naming with full triple
  join(__dirname, `hyperlight-analysis.${triple}.node`),
  // Simple platform-arch naming
  join(__dirname, `hyperlight-analysis.${platformArch}.node`),
  // Underscore variant
  join(__dirname, `hyperlight_analysis.${triple}.node`),
  join(__dirname, `hyperlight_analysis.${platformArch}.node`),
  // Generic fallback
  join(__dirname, "hyperlight-analysis.node"),
  join(__dirname, "hyperlight_analysis.node"),
];

for (const bindingPath of possiblePaths) {
  if (existsSync(bindingPath)) {
    try {
      nativeBinding = require(bindingPath);
      break;
    } catch (e) {
      loadError = e;
    }
  }
}

if (!nativeBinding) {
  const msg = loadError
    ? `Failed to load native binding: ${loadError.message}`
    : `No native binding found for ${triple} (${platformArch}). Run 'npm run build' first.`;
  throw new Error(msg);
}

// Re-export all functions from the native binding
module.exports = {
  /**
   * Get the SHA256 hash of the embedded analysis runtime.
   * @returns {string} Hex-encoded SHA256 hash
   */
  getRuntimeHash: nativeBinding.getRuntimeHash,

  /**
   * Get the size of the embedded analysis runtime in bytes.
   * @returns {number} Size in bytes
   */
  getRuntimeSize: nativeBinding.getRuntimeSize,

  /**
   * Ping the analysis guest to verify it's working.
   * @param {string} input - Input string to echo
   * @returns {Promise<string>} JSON response with echoed input
   */
  ping: nativeBinding.ping,

  /**
   * Extract module metadata from JavaScript source code.
   * @param {string} source - JavaScript ES module source code
   * @param {string} [configJson] - Optional JSON configuration
   * @returns {Promise<string>} JSON string with extracted metadata
   */
  extractModuleMetadata: nativeBinding.extractModuleMetadata,

  /**
   * Extract module metadata from a TypeScript declaration (.d.ts) file.
   * @param {string} source - TypeScript declaration file content
   * @param {string} [configJson] - Optional JSON configuration
   * @returns {Promise<string>} JSON string with extracted metadata
   */
  extractDtsMetadata: nativeBinding.extractDtsMetadata,

  /**
   * Scan plugin source code for security issues.
   * @param {string} source - Plugin JavaScript source code
   * @param {string} [configJson] - Optional JSON configuration
   * @returns {Promise<string>} JSON string with scan findings
   */
  scanPlugin: nativeBinding.scanPlugin,

  /**
   * Validate JavaScript source code for syntax errors and common issues.
   * @param {string} source - JavaScript source code to validate
   * @param {string} contextJson - JSON context with validation parameters
   * @returns {Promise<string>} JSON string with validation result
   */
  validateJavascript: nativeBinding.validateJavascript,

  /**
   * Analyze a library tarball for security issues.
   * @param {Buffer} tgzBytes - Raw tarball bytes
   * @param {string} [configJson] - Optional JSON configuration
   * @returns {Promise<string>} JSON string with analysis report
   */
  analyzeLibrary: nativeBinding.analyzeLibrary,
};
