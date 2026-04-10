// ── Hyperlight Host Module Integration Tests ─────────────────────────
//
// Tests for the interaction between user modules (ha:*) and host modules
// (host:*). These tests use the hyperlight-js API directly to verify
// module resolution and import order behavior.
//
// Background: There was a suspected issue where importing from ha:pptx
// before host:fs-write caused compilation failures. These tests verify
// that both import orders work correctly.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Import hyperlight-js directly
import { SandboxBuilder } from "../deps/js-host-api/lib.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUILTIN_DIR = join(__dirname, "..", "builtin-modules");

/** Read a builtin module source file, stripping the metadata header. */
function readModule(name: string): string {
  const raw = readFileSync(join(BUILTIN_DIR, `${name}.js`), "utf-8");
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().startsWith("//")) i++;
  if (i < lines.length && lines[i].trim() === "") i++;
  return lines.slice(i).join("\n");
}

/** All builtin modules needed for pptx to work */
const PPTX_MODULES = [
  "str-bytes",
  "base64",
  "crc32",
  "xml-escape",
  "zip-format",
  "doc-core",
  "ooxml-core",
  "pptx-charts",
  "pptx-tables",
  "shared-state",
  "pptx",
];

describe("hyperlight host module + user module integration", () => {
  it("should compile handler that imports host:* FIRST, then ha:*", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(16 * 1024 * 1024)
      .setInputBufferSize(512 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // Register mock fs-write host module
    const fsWrite = proto.hostModule("fs-write");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fsWrite.register("writeFileBinary", ((path: string, data: Buffer) => ({
      ok: true,
      size: data?.length ?? 0,
    })) as any);

    const sandbox = await proto.loadRuntime();

    // Register all pptx dependencies
    for (const name of PPTX_MODULES) {
      sandbox.addModule(name, readModule(name), "ha");
    }

    // Handler imports host:fs-write FIRST, then ha:pptx
    sandbox.addHandler(
      "test",
      `
import * as fs from "host:fs-write";
import { createPresentation, titleSlide } from "ha:pptx";

export function handler(event) {
  const pres = createPresentation({ theme: 'corporate-blue' });
  titleSlide(pres, { title: 'Test Presentation' });
  const zip = pres.buildZip();
  const result = fs.writeFileBinary('test.pptx', zip);
  return { slides: pres.slideCount, size: zip.length, written: result.ok };
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    expect(result).toHaveProperty("slides", 2); // 1 user slide + 1 warning slide
    expect(result).toHaveProperty("size");
    expect(result.size).toBeGreaterThan(0);
    expect(result).toHaveProperty("written", true);
  });

  it("should compile handler that imports ha:* FIRST, then host:*", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(16 * 1024 * 1024)
      .setInputBufferSize(512 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // Register mock fs-write host module
    const fsWrite = proto.hostModule("fs-write");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fsWrite.register("writeFileBinary", ((path: string, data: Buffer) => ({
      ok: true,
      size: data?.length ?? 0,
    })) as any);

    const sandbox = await proto.loadRuntime();

    // Register all pptx dependencies
    for (const name of PPTX_MODULES) {
      sandbox.addModule(name, readModule(name), "ha");
    }

    // Handler imports ha:pptx FIRST, then host:fs-write
    sandbox.addHandler(
      "test",
      `
import { createPresentation, titleSlide } from "ha:pptx";
import * as fs from "host:fs-write";

export function handler(event) {
  const pres = createPresentation({ theme: 'corporate-blue' });
  titleSlide(pres, { title: 'Test Presentation' });
  const zip = pres.buildZip();
  const result = fs.writeFileBinary('test.pptx', zip);
  return { slides: pres.slideCount, size: zip.length, written: result.ok };
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    expect(result).toHaveProperty("slides", 2); // 1 user slide + 1 warning slide
    expect(result).toHaveProperty("size");
    expect(result.size).toBeGreaterThan(0);
    expect(result).toHaveProperty("written", true);
  });

  it("should work with exportToFile helper that depends on host:fs-write", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(16 * 1024 * 1024)
      .setInputBufferSize(512 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // Register mock fs-write host module
    const fsWrite = proto.hostModule("fs-write");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fsWrite.register("writeFileBinary", ((path: string, data: Buffer) => ({
      ok: true,
      size: data?.length ?? 0,
    })) as any);

    const sandbox = await proto.loadRuntime();

    // Register all pptx dependencies
    for (const name of PPTX_MODULES) {
      sandbox.addModule(name, readModule(name), "ha");
    }

    // Handler uses exportToFile which internally calls fsWrite.writeFileBinary
    sandbox.addHandler(
      "test",
      `
import { createPresentation, titleSlide, exportToFile } from "ha:pptx";
import * as fsWrite from "host:fs-write";

export function handler(event) {
  const pres = createPresentation({ theme: 'dark-gradient' });
  titleSlide(pres, { title: 'Export Test' });
  return exportToFile(pres, 'output.pptx', fsWrite);
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    expect(result).toHaveProperty("slides", 2); // 1 user slide + 1 warning slide
    expect(result).toHaveProperty("size");
    expect(result.size).toBeGreaterThan(0);
    expect(result).toHaveProperty("path", "output.pptx");
  });

  it("should work with named import from host:* module", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(16 * 1024 * 1024)
      .setInputBufferSize(512 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // Register mock fs-write host module
    const fsWrite = proto.hostModule("fs-write");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fsWrite.register("writeFileBinary", ((path: string, data: Buffer) => ({
      ok: true,
      size: data?.length ?? 0,
    })) as any);

    const sandbox = await proto.loadRuntime();

    // Register all pptx dependencies
    for (const name of PPTX_MODULES) {
      sandbox.addModule(name, readModule(name), "ha");
    }

    // Handler uses named import { writeFileBinary } from host:fs-write
    // This tests whether named imports work for host modules
    sandbox.addHandler(
      "test",
      `
import { createPresentation } from "ha:pptx";
import { writeFileBinary } from "host:fs-write";

export function handler(event) {
  const pres = createPresentation();
  const zip = pres.buildZip();
  const result = writeFileBinary('test.pptx', zip);
  return { size: zip.length, written: result.ok };
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    expect(result).toHaveProperty("size");
    expect(result.size).toBeGreaterThan(0);
    expect(result).toHaveProperty("written", true);
  });

  it("should handle multiple host modules with ha:* modules", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(16 * 1024 * 1024)
      .setInputBufferSize(512 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // Register multiple host modules
    const fsWrite = proto.hostModule("fs-write");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fsWrite.register("writeFileBinary", ((path: string, data: Buffer) => ({
      ok: true,
    })) as any);

    const fetch = proto.hostModule("fetch");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch.register("fetchJSON", ((url: string) => ({
      data: { mock: true, url },
    })) as any);

    const sandbox = await proto.loadRuntime();

    // Register pptx modules
    for (const name of PPTX_MODULES) {
      sandbox.addModule(name, readModule(name), "ha");
    }

    // Handler uses multiple host modules interleaved with ha:* imports
    sandbox.addHandler(
      "test",
      `
import { createPresentation } from "ha:pptx";
import * as fs from "host:fs-write";
import * as http from "host:fetch";

export function handler(event) {
  const pres = createPresentation();
  const zip = pres.buildZip();
  const writeResult = fs.writeFileBinary('test.pptx', zip);
  const fetchResult = http.fetchJSON('https://api.example.com/data');
  return {
    written: writeResult.ok,
    fetched: fetchResult.data.mock,
    size: zip.length
  };
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    expect(result).toHaveProperty("written", true);
    expect(result).toHaveProperty("fetched", true);
    expect(result).toHaveProperty("size");
    expect(result.size).toBeGreaterThan(0);
  });

  it("should fail gracefully when exportToFile is called without fsWrite module", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(16 * 1024 * 1024)
      .setInputBufferSize(512 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // Register fs-write host module (but handler won't import it)
    const fsWrite = proto.hostModule("fs-write");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fsWrite.register("writeFileBinary", ((path: string, data: Buffer) => ({
      ok: true,
    })) as any);

    const sandbox = await proto.loadRuntime();

    for (const name of PPTX_MODULES) {
      sandbox.addModule(name, readModule(name), "ha");
    }

    // Handler uses exportToFile but FORGETS to import host:fs-write
    // This should fail at runtime with a clear error, not at compile time
    sandbox.addHandler(
      "test",
      `
import { createPresentation, titleSlide, exportToFile } from "ha:pptx";

export function handler(event) {
  const pres = createPresentation({ theme: 'corporate-blue' });
  titleSlide(pres, { title: 'Test' });
  // Oops! Calling exportToFile without passing fsWrite module
  return exportToFile(pres, 'output.pptx', undefined);
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();

    // Should throw a clear error about missing fs-write module
    await expect(loaded.callHandler("test", {})).rejects.toThrow(
      /fs-write module/i,
    );
  });

  it("should fail at compile time when importing unregistered host module", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(16 * 1024 * 1024)
      .setInputBufferSize(512 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // DON'T register any host modules

    const sandbox = await proto.loadRuntime();

    for (const name of PPTX_MODULES) {
      sandbox.addModule(name, readModule(name), "ha");
    }

    // Handler tries to import host:fs-write which isn't registered
    sandbox.addHandler(
      "test",
      `
import { createPresentation } from "ha:pptx";
import * as fs from "host:fs-write";

export function handler(event) {
  const pres = createPresentation();
  return { ok: true };
}
`,
    );

    // Should fail during getLoadedSandbox (compilation) because host:fs-write
    // is not registered
    await expect(sandbox.getLoadedSandbox()).rejects.toThrow(
      /resolving module.*host:fs-write/i,
    );
  });
});
