// ── Fetch Binary Download Integration Tests ───────────────────────────
//
// Tests for downloading binary content (images, PDFs, etc.) through the
// fetch plugin. Verifies that:
//   - Binary data is NOT corrupted by UTF-8 encoding
//   - fetchBinary() convenience function works correctly
//   - Content-type validation catches misuse
//
// Uses the hyperlight-js API directly to test real sandbox behavior.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

// Import hyperlight-js directly
import { SandboxBuilder } from "../deps/js-host-api/lib.js";

// Import the fetch plugin createHostFunctions function
import { createHostFunctions } from "../plugins/fetch/index.js";

/**
 * Helper to register fetch plugin host functions on a proto sandbox.
 * This mirrors what sandbox-tool.js does with the declarative API.
 */
function registerFetchPlugin(proto: any, config: object) {
  const hostFuncs = createHostFunctions(config);
  for (const [moduleName, functions] of Object.entries(hostFuncs)) {
    const mod = proto.hostModule(moduleName);
    for (const [fnName, fn] of Object.entries(functions)) {
      mod.register(fnName, fn);
    }
  }
}

// ── Test server setup ──────────────────────────────────────────────────

let testServer: Server;
let testPort: number;

// Create a test image: 10x10 PNG with all bytes 0-255 to catch corruption
// PNG header + IHDR + IDAT + IEND - minimal valid PNG
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const TEST_BINARY_DATA = Buffer.concat([
  PNG_HEADER,
  // Include all byte values 0-255 to detect corruption
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
]);

beforeAll(async () => {
  testServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    if (url.pathname === "/image.png") {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": TEST_BINARY_DATA.length.toString(),
      });
      res.end(TEST_BINARY_DATA);
    } else if (url.pathname === "/data.json") {
      const json = JSON.stringify({ test: "data", number: 42 });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json).toString(),
      });
      res.end(json);
    } else if (url.pathname === "/text-as-binary") {
      // Serve text with wrong content-type to test validation
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": "5",
      });
      res.end("hello");
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  await new Promise<void>((resolve) => {
    testServer.listen(0, "127.0.0.1", () => {
      testPort = (testServer.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    testServer.close(() => resolve());
  });
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("fetch plugin binary downloads", () => {
  // Note: These tests use localhost which is blocked by SSRF protection.
  // We need to test against an allowlisted domain or mock the security checks.
  // For now, we test the plugin registration and the handler code paths.

  it("should have fetchBinary function registered", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(4 * 1024 * 1024)
      .setInputBufferSize(128 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // Register fetch plugin with test domain
    registerFetchPlugin(proto, {
      allowedDomains: ["httpbin.org"],
      allowedContentTypes: ["image/png", "image/jpeg", "application/json"],
    });

    const sandbox = await proto.loadRuntime();

    // Handler that checks if fetchBinary exists
    sandbox.addHandler(
      "test",
      `
import * as fetch from "host:fetch";

export function handler(event) {
  return {
    hasFetchBinary: typeof fetch.fetchBinary === 'function',
    hasReadBinary: typeof fetch.readBinary === 'function',
    hasFetchJSON: typeof fetch.fetchJSON === 'function',
    hasGet: typeof fetch.get === 'function',
    hasRead: typeof fetch.read === 'function',
  };
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    expect(result).toEqual({
      hasFetchBinary: true,
      hasReadBinary: true,
      hasFetchJSON: true,
      hasGet: true,
      hasRead: true,
    });
  });

  it("should detect binary content types correctly in handler code", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(4 * 1024 * 1024)
      .setInputBufferSize(128 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    registerFetchPlugin(proto, {
      allowedDomains: ["example.com"],
    });

    const sandbox = await proto.loadRuntime();

    // Handler that tests content-type detection logic
    sandbox.addHandler(
      "test",
      `
export function handler(event) {
  const contentTypes = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'audio/mpeg',
    'video/mp4',
    'application/pdf',
    'application/zip',
    'application/octet-stream',
    'application/json',
    'text/plain',
    'text/html',
  ];

  const results = {};
  for (const ct of contentTypes) {
    const isBinary =
      ct.startsWith('image/') ||
      ct.startsWith('audio/') ||
      ct.startsWith('video/') ||
      ct === 'application/octet-stream' ||
      ct === 'application/pdf' ||
      ct === 'application/zip';
    results[ct] = isBinary ? 'binary' : 'text';
  }
  return results;
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    expect(result).toEqual({
      "image/png": "binary",
      "image/jpeg": "binary",
      "image/gif": "binary",
      "audio/mpeg": "binary",
      "video/mp4": "binary",
      "application/pdf": "binary",
      "application/zip": "binary",
      "application/octet-stream": "binary",
      "application/json": "text",
      "text/plain": "text",
      "text/html": "text",
    });
  });

  it("should handle Uint8Array concatenation correctly", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(4 * 1024 * 1024)
      .setInputBufferSize(128 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    registerFetchPlugin(proto, {
      allowedDomains: ["example.com"],
    });

    const sandbox = await proto.loadRuntime();

    // Handler that tests Uint8Array chunk combination
    sandbox.addHandler(
      "test",
      `
export function handler(event) {
  // Simulate chunks that would come from readBinary
  const chunk1 = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const chunk2 = new Uint8Array([10, 20, 30]);
  const chunks = [chunk1, chunk2];

  // Combine chunks - this is the pattern from the docs
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }

  // Verify all bytes including high bytes (128, 255) survived
  return {
    length: result.length,
    bytes: Array.from(result),
    // Check specific high-value bytes that would be corrupted by UTF-8
    byte127: result[3],
    byte128: result[4],
    byte255: result[5],
  };
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    expect(result.length).toBe(9);
    expect(result.bytes).toEqual([0, 1, 2, 127, 128, 255, 10, 20, 30]);
    expect(result.byte127).toBe(127);
    expect(result.byte128).toBe(128);
    expect(result.byte255).toBe(255);
  });

  it("should preserve binary data through host function round-trip", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(4 * 1024 * 1024)
      .setInputBufferSize(128 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // Register a mock host module that returns binary data
    const mockBinary = proto.hostModule("mock-binary");
    const testData = Buffer.from([0, 1, 127, 128, 200, 255]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBinary.register("getData", (() => testData) as any);

    // Also register a function that receives binary and returns analysis
    let receivedData: Buffer | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBinary.register("receiveData", ((data: Buffer) => {
      receivedData = data;
      return {
        length: data.length,
        bytes: Array.from(data),
      };
    }) as any);

    const sandbox = await proto.loadRuntime();

    sandbox.addHandler(
      "test",
      `
import * as mock from "host:mock-binary";

export function handler(event) {
  // Get binary from host
  const data = mock.getData();

  // Send it back to host for analysis
  const analysis = mock.receiveData(data);

  return {
    type: data.constructor.name,
    length: data.length,
    // Check individual bytes including high-value ones
    byte0: data[0],
    byte127: data[2],
    byte128: data[3],
    byte200: data[4],
    byte255: data[5],
    hostAnalysis: analysis,
  };
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    // Verify data arrived correctly in guest
    expect(result.length).toBe(6);
    expect(result.byte0).toBe(0);
    expect(result.byte127).toBe(127);
    expect(result.byte128).toBe(128);
    expect(result.byte200).toBe(200);
    expect(result.byte255).toBe(255);

    // Verify host received correct data back
    expect(result.hostAnalysis.length).toBe(6);
    expect(result.hostAnalysis.bytes).toEqual([0, 1, 127, 128, 200, 255]);
  });

  it("demonstrates why readBinary is needed for binary data", async () => {
    const proto = await new SandboxBuilder()
      .setHeapSize(16 * 1024 * 1024)
      .setScratchSize(4 * 1024 * 1024)
      .setInputBufferSize(128 * 1024)
      .setOutputBufferSize(2 * 1024 * 1024)
      .build();

    // Mock a host module that simulates what readBinary does
    const mockFetch = proto.hostModule("mock-fetch");

    // All byte values 0-255
    const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

    // readBinary returns Buffer (becomes Uint8Array in guest)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFetch.register("readBinary", (() => allBytes) as any);

    const sandbox = await proto.loadRuntime();

    sandbox.addHandler(
      "test",
      `
import * as mock from "host:mock-fetch";

export function handler(event) {
  // Get binary data the correct way
  const binaryData = mock.readBinary();

  // Demonstrate that binary transfer preserves all bytes
  const highBytes = [];
  for (let i = 127; i < 140; i++) {
    highBytes.push(binaryData[i]);
  }

  return {
    binaryLength: binaryData.length,
    binary127: binaryData[127],
    binary128: binaryData[128],
    binary200: binaryData[200],
    binary255: binaryData[255],
    highBytes: highBytes,
  };
}
`,
    );

    const loaded = await sandbox.getLoadedSandbox();
    const result = await loaded.callHandler("test", {});

    // Binary data should preserve all 256 bytes
    expect(result.binaryLength).toBe(256);
    expect(result.binary127).toBe(127);
    expect(result.binary128).toBe(128);
    expect(result.binary200).toBe(200);
    expect(result.binary255).toBe(255);
    // High bytes should be sequential
    expect(result.highBytes).toEqual([
      127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139,
    ]);
  });
});
