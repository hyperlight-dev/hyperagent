import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    // Sandbox initialization can take a few seconds on first run
    testTimeout: 30_000,
    // Only run tests from this project, not from deps/
    include: ["tests/**/*.test.ts"],
    // Exclude compiled build artefacts and dependency clones
    exclude: ["dist/**", "node_modules/**", "deps/**"],
  },
  resolve: {
    alias: {
      // Map ha:* module imports to builtin-modules/ for standalone testing.
      // In the sandbox these are resolved by the hyperlight-js UserModuleLoader.
      "ha:doc-core": resolve(__dirname, "builtin-modules/doc-core.js"),
      "ha:ooxml-core": resolve(__dirname, "builtin-modules/ooxml-core.js"),
      "ha:pdf": resolve(__dirname, "builtin-modules/pdf.js"),
      "ha:pdf-charts": resolve(__dirname, "builtin-modules/pdf-charts.js"),
      "ha:xml-escape": resolve(__dirname, "builtin-modules/xml-escape.js"),
      "ha:str-bytes": resolve(__dirname, "builtin-modules/str-bytes.js"),
      "ha:crc32": resolve(__dirname, "builtin-modules/crc32.js"),
      "ha:base64": resolve(__dirname, "builtin-modules/base64.js"),
      // ha:ziplib is a native Rust module — use Node.js zlib shim for vitest
      "ha:ziplib": resolve(__dirname, "tests/shims/ziplib.shim.js"),
      "ha:shared-state": resolve(__dirname, "builtin-modules/shared-state.js"),
      "ha:zip-format": resolve(__dirname, "builtin-modules/zip-format.js"),
      "ha:pptx": resolve(__dirname, "builtin-modules/pptx.js"),
      "ha:pptx-charts": resolve(__dirname, "builtin-modules/pptx-charts.js"),
      "ha:pptx-tables": resolve(__dirname, "builtin-modules/pptx-tables.js"),
    },
  },
});
