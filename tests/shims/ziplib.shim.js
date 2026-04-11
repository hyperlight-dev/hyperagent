// Node.js shim for ha:ziplib — used by vitest for testing outside the sandbox.
// In the sandbox, ha:ziplib resolves to the native Rust module via NativeModuleLoader.
// This shim provides equivalent behaviour using Node.js zlib for test compatibility.
//
// The native Rust module produces RAW DEFLATE (RFC 1951), not zlib-wrapped.
// ha:pdf adds the zlib wrapper (RFC 1950) itself when building FlateDecode streams.
// ha:zip-format uses raw DEFLATE directly (correct for ZIP archives).
import { deflateRawSync, inflateRawSync } from "node:zlib";

export function deflate(data) {
  if (!data || data.length === 0) return new Uint8Array(0);
  return new Uint8Array(deflateRawSync(Buffer.from(data)));
}

export function inflate(data) {
  if (!data || data.length === 0) return new Uint8Array(0);
  return new Uint8Array(inflateRawSync(Buffer.from(data)));
}
