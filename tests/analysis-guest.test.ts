// ── tests/analysis-guest.test.ts — Tests for Hyperlight Analysis Guest ──
//
// These tests verify the TypeScript wrapper and integration with the
// Hyperlight analysis guest. Note: Tests that call the native addon
// require the addon to be built first (`cd deps/hyperlight-analysis-guest && just build`).

import { describe, it, expect, beforeAll } from "vitest";
import {
  checkAvailability,
  ping,
  extractModuleMetadata,
  extractDtsMetadata,
  scanPlugin,
  validateJavaScript,
  enableAnalysisGuest,
  disableAnalysisGuest,
  isAnalysisGuestEnabled,
} from "../src/agent/analysis-guest.js";

describe("analysis-guest", () => {
  describe("feature flag", () => {
    it("should be disabled by default", () => {
      expect(isAnalysisGuestEnabled()).toBe(false);
    });

    it("should enable and disable", () => {
      enableAnalysisGuest();
      expect(isAnalysisGuestEnabled()).toBe(true);
      disableAnalysisGuest();
      expect(isAnalysisGuestEnabled()).toBe(false);
    });
  });

  describe("checkAvailability", () => {
    it("should report availability status", async () => {
      const result = await checkAvailability();
      expect(result).toHaveProperty("available");
      if (result.available) {
        expect(result.hash).toBeDefined();
        expect(result.size).toBeGreaterThan(0);
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  // The following tests require the native addon to be built.
  // They are skipped if the addon is not available.
  describe.skipIf(process.env.SKIP_NATIVE_TESTS === "1")(
    "native addon integration",
    () => {
      let isAvailable = false;

      beforeAll(async () => {
        const result = await checkAvailability();
        isAvailable = result.available;
      });

      it("ping should echo input", async () => {
        if (!isAvailable) {
          console.log("Skipping: native addon not available");
          return;
        }

        const result = await ping("hello world");
        expect(result).toEqual({ message: "pong: hello world" });
      });

      it("ping should handle special characters", async () => {
        if (!isAvailable) return;

        const result = await ping("test \"quotes\" and 'apostrophes'");
        expect(result.message).toBe("pong: test \"quotes\" and 'apostrophes'");
      });

      it("ping should handle unicode", async () => {
        if (!isAvailable) return;

        const result = await ping("こんにちは 🎉");
        expect(result.message).toBe("pong: こんにちは 🎉");
      });

      it("extractModuleMetadata should parse exports", async () => {
        if (!isAvailable) return;

        const source = `
        /**
         * Calculate CRC32 checksum.
         * @param {Uint8Array} data - Input data
         * @returns {number} Checksum value
         */
        export function crc32(data) {
          return 0;
        }

        export const VERSION = "1.0.0";
      `;

        const result = await extractModuleMetadata(source);
        expect(result.exports).toBeInstanceOf(Array);
        expect(result.exports.length).toBeGreaterThan(0);

        const crc32Export = result.exports.find((e) => e.name === "crc32");
        expect(crc32Export).toBeDefined();
        expect(crc32Export?.kind).toBe("function");
      });

      it("extractModuleMetadata should extract _HINTS", async () => {
        if (!isAvailable) return;

        const source = `
        export const _HINTS = \`
          This module provides CRC utilities.
          Use crc32() for checksums.
        \`;

        export function crc32(data) {
          return 0;
        }
      `;

        const result = await extractModuleMetadata(source);
        expect(result.hints).toBeDefined();
        expect(result.hints).toContain("CRC utilities");
      });

      it("scanPlugin should detect dangerous patterns", async () => {
        if (!isAvailable) return;

        const source = `
        const { exec } = require('child_process');
        exec('rm -rf /');
      `;

        const result = await scanPlugin(source);
        expect(result.findings).toBeInstanceOf(Array);
        expect(result.findings.length).toBeGreaterThan(0);
        expect(result.findings.some((f) => f.severity === "danger")).toBe(true);
      });

      it("scanPlugin should pass clean code", async () => {
        if (!isAvailable) return;

        const source = `
        export function add(a, b) {
          return a + b;
        }
      `;

        const result = await scanPlugin(source);
        expect(
          result.findings.filter((f) => f.severity === "danger"),
        ).toHaveLength(0);
      });

      it("validateJavaScript should accept valid code", async () => {
        if (!isAvailable) return;

        const source = `
        export function handler(event) {
          return { result: event.data };
        }
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(true);
        expect(result.isModule).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("validateJavaScript should treat plain handler declarations as module mode", async () => {
        if (!isAvailable) return;

        const source = `
        function handler(event) {
          return { result: event.data };
        }
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(true);
        expect(result.isModule).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("validateJavaScript should accept async handler declarations", async () => {
        if (!isAvailable) return;

        const source = `
        async function handler(event) {
          const value = await Promise.resolve(event.data);
          return { result: value };
        }
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("validateJavaScript should reject arrow handlers with repair guidance", async () => {
        if (!isAvailable) return;

        const source = `
        const handler = (event) => {
          return { result: event.data };
        };
        export { handler };
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(false);
        expect(result.errors[0]?.type).toBe("structure");
        expect(result.errors[0]?.message).toContain("not an arrow function");
        expect(result.errors[0]?.message).toContain("function handler(event)");
      });

      it("validateJavaScript should accept custom handler parameter names", async () => {
        if (!isAvailable) return;

        const source = `
        function handler(input) {
          return { result: input.data };
        }
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("validateJavaScript should accept handlers without parameters", async () => {
        if (!isAvailable) return;

        const source = `
        function handler() {
          return { result: "ok" };
        }
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("validateJavaScript should reject nested returns without handler return", async () => {
        if (!isAvailable) return;

        const source = `
        function handler(event) {
          function buildResult() {
            return { result: event.data };
          }
        }
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(false);
        expect(result.errors[0]?.type).toBe("structure");
        expect(result.errors[0]?.message).toContain("MUST return a value");
      });

      it("validateJavaScript should reject renamed handler functions", async () => {
        if (!isAvailable) return;

        const source = `
        function handle(event) {
          return { result: event.data };
        }
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(false);
        expect(result.errors[0]?.type).toBe("structure");
        expect(result.errors[0]?.message).toContain(
          "must be named exactly 'handler'",
        );
        expect(result.errors[0]?.message).toContain("Found function 'handle'");
      });

      it("validateJavaScript should reject syntax errors", async () => {
        if (!isAvailable) return;

        const source = `
        export function handler(event) {
          return { result: event.data
        }  // Missing closing brace
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].type).toBe("syntax");
      });

      it("validateJavaScript should detect handler name conflicts", async () => {
        if (!isAvailable) return;

        const source = `
        export function handler(event) {
          return event;
        }
      `;

        const result = await validateJavaScript(source, {
          handlerName: "existing-handler",
          registeredHandlers: ["existing-handler", "another-handler"],
          availableModules: [],
          expectHandler: true,
        });

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === "conflict")).toBe(true);
      });

      it("validateJavaScript should check import availability", async () => {
        if (!isAvailable) return;

        const source = `
        import { createPresentation } from 'ha:pptx';
        import { nonExistent } from 'ha:fake-module';

        export function handler(event) {
          return createPresentation();
        }
      `;

        const result = await validateJavaScript(source, {
          handlerName: "test-handler",
          registeredHandlers: [],
          availableModules: ["ha:pptx"], // ha:fake-module is not available
          expectHandler: true,
        });

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === "import")).toBe(true);
      });

      it("validateJavaScript should handle deep validation with module sources", async () => {
        if (!isAvailable) return;

        const handlerSource = `
          import { helper } from 'ha:utils';
          export function handler(event) {
            return helper(event.data);
          }
        `;

        const utilsSource = `
          export function helper(data) {
            return { processed: data };
          }
        `;

        const result = await validateJavaScript(handlerSource, {
          handlerName: "deep-test",
          registeredHandlers: [],
          availableModules: ["ha:utils"],
          expectHandler: true,
          moduleSources: {
            "ha:utils": utilsSource,
          },
        });

        expect(result.valid).toBe(true);
        expect(result.deepValidationDone).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("validateJavaScript should handle host:* imports", async () => {
        if (!isAvailable) return;

        // Host plugins use namespace imports: import * as name from 'host:name'
        const source = `
          import * as fetch from 'host:fetch';
          export function handler(event) {
            return fetch.fetchJSON(event.url);
          }
        `;

        const hostModulesDts = `
          declare module "host:fetch" {
            export declare function fetchJSON(url: string): Promise<unknown>;
          }
        `;

        const result = await validateJavaScript(source, {
          handlerName: "fetch-test",
          registeredHandlers: [],
          availableModules: ["host:fetch"],
          expectHandler: true,
          // Host plugins are marked as resolved with empty source (they run in Node.js, not sandbox)
          moduleSources: { "host:fetch": "" },
          dtsSources: { "host:fetch": hostModulesDts },
        });

        expect(result.valid).toBe(true);
        expect(result.imports).toContain("host:fetch");
        // host:* imports should not appear in missingSources
        expect(result.missingSources).not.toContain("host:fetch");
      });

      it("validateJavaScript should handle namespace imports (import * as)", async () => {
        if (!isAvailable) return;

        // This is the exact pattern that was causing SIGSEGV
        const source = `
          import * as fetch from "host:fetch";

          function handler(event) {
            if (event.action === "wiki") {
              const url = "https://example.com/api";
              const data = fetch.fetchJSON(url);
              return data;
            }
            return { error: "unknown action" };
          }
        `;

        const result = await validateJavaScript(source, {
          handlerName: "namespace-import-test",
          registeredHandlers: [],
          availableModules: ["host:fetch"],
          expectHandler: true,
          // Host plugins are marked as resolved with empty source (they run in Node.js, not sandbox)
          moduleSources: { "host:fetch": "" },
        });

        expect(result.valid).toBe(true);
        expect(result.imports).toContain("host:fetch");
      });

      it("validateJavaScript should handle complex handler code", async () => {
        if (!isAvailable) return;

        // Complex handler with regex patterns, loops, etc.
        const source = `
          import * as fetch from "host:fetch";

          function handler(event) {
            const res = fetch.get("https://example.com");
            if (res.error) return { error: res.error };

            const chunks = [];
            let chunk;
            do {
              chunk = fetch.read("https://example.com");
              chunks.push(chunk.data);
            } while (!chunk.done);

            const body = chunks.join('');

            // Regex patterns
            const specPatterns = [
              /(\\d+[\\+]?\\s*mi)\\s*(range|Range)/g,
              /(\\d+\\.?\\d*)\\s*sec/g,
            ];

            const specs = {};
            for (const p of specPatterns) {
              const matches = body.match(p);
              if (matches) specs[p.source] = matches;
            }

            return { specs };
          }
        `;

        const result = await validateJavaScript(source, {
          handlerName: "complex-handler-test",
          registeredHandlers: [],
          availableModules: ["host:fetch"],
          expectHandler: true,
          // Host plugins are marked as resolved with empty source
          moduleSources: { "host:fetch": "" },
        });

        expect(result.valid).toBe(true);
      });

      it("validateJavaScript should handle multiple imports", async () => {
        if (!isAvailable) return;

        const handlerSource = `
          import { createPresentation } from 'ha:pptx';
          import { zip } from 'ha:zip-format';
          import * as fetch from 'host:fetch';

          export function handler(event) {
            const pres = createPresentation();
            const data = fetch.fetchJSON(event.url);
            return { pres, zip, data };
          }
        `;

        const pptxSource = `
          export function createPresentation() {
            return { slideCount: 0 };
          }
        `;

        const zipSource = `
          export function zip(data) {
            return data;
          }
        `;

        const hostFetchDts = `
          declare module "host:fetch" {
            export declare function fetchJSON(url: string): Promise<unknown>;
          }
        `;

        const result = await validateJavaScript(handlerSource, {
          handlerName: "multi-import",
          registeredHandlers: [],
          availableModules: ["ha:pptx", "ha:zip-format", "host:fetch"],
          expectHandler: true,
          moduleSources: {
            "ha:pptx": pptxSource,
            "ha:zip-format": zipSource,
            // Host plugins are marked as resolved with empty source
            "host:fetch": "",
          },
          dtsSources: {
            "host:fetch": hostFetchDts,
          },
        });

        expect(result.valid).toBe(true);
        expect(result.deepValidationDone).toBe(true);
      });

      it("validateJavaScript should report missing sources for transitive imports", async () => {
        if (!isAvailable) return;

        const handlerSource = `
          import { a } from 'ha:module-a';
          export function handler(event) {
            return a();
          }
        `;

        // module-a imports module-b, which we haven't provided
        const moduleASource = `
          import { b } from 'ha:module-b';
          export function a() {
            return b();
          }
        `;

        const result = await validateJavaScript(handlerSource, {
          handlerName: "transitive-test",
          registeredHandlers: [],
          availableModules: ["ha:module-a", "ha:module-b"],
          expectHandler: true,
          moduleSources: {
            "ha:module-a": moduleASource,
            // ha:module-b not provided
          },
        });

        // Should indicate that module-b is missing
        expect(result.deepValidationDone).toBe(false);
        expect(result.missingSources).toContain("ha:module-b");
      });

      describe("host:* plugin validation with dtsSources", () => {
        it("should validate namespace imports with correct method calls", async () => {
          if (!isAvailable) return;

          // Correct pattern: namespace import + method call
          const source = `
            import * as fetch from "host:fetch";

            export function handler(event) {
              const data = fetch.fetchJSON(event.url);
              return data;
            }
          `;

          const hostModulesDts = `
            declare module "host:fetch" {
              export declare function fetchJSON(url: string): Promise<unknown>;
              export declare function get(url: string): Promise<any>;
            }
          `;

          const result = await validateJavaScript(source, {
            handlerName: "namespace-test",
            registeredHandlers: [],
            availableModules: ["host:fetch"],
            expectHandler: true,
            // Host plugins are marked as resolved with empty source
            moduleSources: { "host:fetch": "" },
            dtsSources: {
              "host:fetch": hostModulesDts,
            },
          });

          expect(result.valid).toBe(true);
          expect(result.imports).toContain("host:fetch");
        });

        it("should validate multiple host:* modules with dtsSources", async () => {
          if (!isAvailable) return;

          const source = `
            import * as fetch from "host:fetch";
            import * as fsRead from "host:fs-read";

            export function handler(event) {
              const contents = fsRead.readFile(event.path);
              const data = fetch.fetchJSON("https://api.example.com");
              return { contents, data };
            }
          `;

          const fetchDts = `
            declare module "host:fetch" {
              export declare function fetchJSON(url: string): Promise<unknown>;
            }
          `;

          const fsReadDts = `
            declare module "host:fs-read" {
              export declare function readFile(path: string, encoding?: string): any;
            }
          `;

          const result = await validateJavaScript(source, {
            handlerName: "multi-host-test",
            registeredHandlers: [],
            availableModules: ["host:fetch", "host:fs-read"],
            expectHandler: true,
            // Host plugins are marked as resolved with empty source
            moduleSources: { "host:fetch": "", "host:fs-read": "" },
            dtsSources: {
              "host:fetch": fetchDts,
              "host:fs-read": fsReadDts,
            },
          });

          expect(result.valid).toBe(true);
          expect(result.imports).toContain("host:fetch");
          expect(result.imports).toContain("host:fs-read");
        });

        it("should validate fs-write plugin calls", async () => {
          if (!isAvailable) return;

          const source = `
            import * as fsWrite from "host:fs-write";

            export function handler(event) {
              fsWrite.writeFile(event.path, event.content);
              return { success: true };
            }
          `;

          const fsWriteDts = `
            declare module "host:fs-write" {
              export declare function writeFile(path: string, content: string, encoding?: string): any;
              export declare function mkdir(path: string): any;
            }
          `;

          const result = await validateJavaScript(source, {
            handlerName: "fs-write-test",
            registeredHandlers: [],
            availableModules: ["host:fs-write"],
            expectHandler: true,
            // Host plugins are marked as resolved with empty source
            moduleSources: { "host:fs-write": "" },
            dtsSources: {
              "host:fs-write": fsWriteDts,
            },
          });

          expect(result.valid).toBe(true);
        });

        it("should validate complex plugin usage patterns", async () => {
          if (!isAvailable) return;

          // Complex handler that uses multiple fetch methods
          const source = `
            import * as fetch from "host:fetch";

            export function handler(event) {
              // Start a streaming request
              const res = fetch.get(event.url);
              if (res.error) return { error: res.error };

              // Read chunks
              const chunks = [];
              let chunk;
              do {
                chunk = fetch.read(event.url);
                if (chunk.data) chunks.push(chunk.data);
              } while (!chunk.done);

              // Also support binary
              const binary = fetch.fetchBinary(event.binaryUrl);

              return { text: chunks.join(''), binary };
            }
          `;

          const fetchDts = `
            declare module "host:fetch" {
              export declare function get(url: string): Promise<any>;
              export declare function read(url: string): Promise<any>;
              export declare function fetchBinary(url: string): Promise<Uint8Array>;
            }
          `;

          const result = await validateJavaScript(source, {
            handlerName: "complex-fetch-test",
            registeredHandlers: [],
            availableModules: ["host:fetch"],
            expectHandler: true,
            // Host plugins are marked as resolved with empty source
            moduleSources: { "host:fetch": "" },
            dtsSources: {
              "host:fetch": fetchDts,
            },
          });

          expect(result.valid).toBe(true);
        });
      });

      it("extractDtsMetadata should parse .d.ts files", async () => {
        if (!isAvailable) return;

        const dtsSource = `
/**
 * Convert a string to bytes.
 * @param s - Input string
 * @returns Byte array
 */
export declare function strToBytes(s: string): Uint8Array;

/**
 * A configuration interface.
 */
export interface Config {
  name: string;
  count?: number;
  getValue(): string;
}

export declare const VERSION: string;
        `;

        const result = await extractDtsMetadata(dtsSource);

        expect(result.exports).toBeDefined();
        expect(result.exports.length).toBeGreaterThanOrEqual(2);

        // Check function export
        const strToBytes = result.exports.find(
          (e: { name: string }) => e.name === "strToBytes",
        );
        expect(strToBytes).toBeDefined();
        expect(strToBytes?.kind).toBe("function");
        expect(strToBytes?.signature).toContain("strToBytes");
        expect(strToBytes?.signature).toContain("string");
        expect(strToBytes?.signature).toContain("Uint8Array");
        expect(strToBytes?.description).toContain("Convert a string to bytes");

        // Check const export
        const version = result.exports.find(
          (e: { name: string }) => e.name === "VERSION",
        );
        expect(version).toBeDefined();
        expect(version?.kind).toBe("const");

        // Check interface was parsed as a class
        expect(result.classes).toBeDefined();
        const config = result.classes.find(
          (c: { name: string }) => c.name === "Config",
        );
        expect(config).toBeDefined();
        expect(config?.methods).toContain("getValue");
        expect(config?.properties).toContain("name");
      });
    },
  );
});
