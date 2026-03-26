// ── Cross-Handler Shared State ───────────────────────────────────────
//
// ESM modules are singletons — all handlers that import this module
// see the SAME state. This means handler A can set() a value and
// handler B can get() it, even though they have separate module scopes.
//
// WHAT CAN BE STORED (survives recompiles):
//   ✅ Plain data: strings, numbers, booleans, null
//   ✅ Arrays of plain data: ['a', 'b', 'c'] or [1, 2, 3]
//   ✅ Plain objects: { name: 'foo', count: 42 }
//   ✅ Binary data: Uint8Array (preserved via host sidecar mechanism)
//
// WHAT CANNOT BE STORED (lost on recompile):
//   ❌ Objects with METHODS: createPresentation() returns { addSlide(), build() }
//      Methods don't survive serialization — they'll become undefined!
//
// EXAMPLE — CORRECT PATTERN FOR PPTX:
//   // Handler 1 (research): store PLAIN DATA
//   set('slideData', [{ title: 'Intro', bullets: [...] }, ...]);
//
//   // Handler 2 (build): create pres FRESH, use stored data
//   const pres = createPresentation({ theme: 'dark-gradient' });
//   get('slideData').forEach(s => contentSlide(pres, s));
//   writeFileBinary('out.pptx', pres.buildZip());
//
// EXAMPLE — BINARY DATA NOW WORKS:
//   // Handler 1: download and store binary
//   import { readBinary } from "host:fetch";
//   const img = readBinary("https://example.com/photo.jpg");
//   set('logo', img);  // ✅ Uint8Array survives recompiles!
//
//   // Handler 2: use stored binary
//   const logo = get('logo');  // ✅ Still a Uint8Array
//   embedImageFromUrl(pres, { data: logo, ... });
//
// The sandbox auto-saves shared-state after every successful execution
// and auto-restores it after any recompile. Binary data survives via
// the host:_state-sidecar mechanism.
//
// ─────────────────────────────────────────────────────────────────────

// Hints are now in shared-state.json (structured metadata).

/** Type for storable values */
export type StorableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Uint8Array
  | StorableValue[]
  | { [key: string]: StorableValue };

/** Internal store — module-level mutable state shared across all handlers. */
const store = new Map<string, StorableValue>();

/**
 * Store a value by key. Overwrites any existing value.
 * Values can be any JSON-serialisable type OR Uint8Array for binary data.
 * Binary data survives sandbox recompiles via the host sidecar mechanism.
 * @param key - Storage key
 * @param value - Value to store (supports Uint8Array for binary)
 */
export function set(key: string, value: StorableValue): void {
  store.set(key, value);
}

/**
 * Retrieve a value by key. Returns undefined if not found.
 * @param key - Storage key
 * @returns The stored value, or undefined
 */
export function get(key: string): StorableValue | undefined {
  return store.get(key);
}

/**
 * Check if a key exists in the store.
 * @param key - Storage key
 * @returns True if the key exists
 */
export function has(key: string): boolean {
  return store.has(key);
}

/**
 * Delete a key from the store.
 * @param key - Storage key
 * @returns True if the key existed and was deleted
 */
export function del(key: string): boolean {
  return store.delete(key);
}

/**
 * Get all stored key-value pairs as a plain object.
 * Used internally by the save/restore system.
 * @returns All stored data as { key: value, ... }
 */
export function getAll(): Record<string, StorableValue> {
  const result: Record<string, StorableValue> = {};
  for (const [k, v] of store) {
    result[k] = v;
  }
  return result;
}

/**
 * Get all stored keys.
 * @returns Array of all keys
 */
export function keys(): string[] {
  return [...store.keys()];
}

/**
 * Clear all stored data.
 */
export function clear(): void {
  store.clear();
}

/**
 * Get the number of stored entries.
 * @returns Number of stored key-value pairs
 */
export function size(): number {
  return store.size;
}

/**
 * Estimate the byte size of a stored value.
 * For Uint8Array, returns exact byte count.
 * For other types, estimates JSON serialization size.
 * @param key - Storage key
 * @returns Estimated size in bytes, or 0 if key doesn't exist
 */
export function getSize(key: string): number {
  const value = store.get(key);
  if (value === undefined) return 0;
  return estimateSize(value);
}

/**
 * Get storage statistics for all keys.
 * Useful for debugging memory usage and finding large values.
 * @returns Object with { totalBytes, entries: [{key, bytes}...] } sorted by size descending
 */
export function stats(): {
  totalBytes: number;
  entries: Array<{ key: string; bytes: number }>;
} {
  const entries: Array<{ key: string; bytes: number }> = [];
  let totalBytes = 0;

  for (const [key, value] of store) {
    const bytes = estimateSize(value);
    entries.push({ key, bytes });
    totalBytes += bytes;
  }

  // Sort by size descending
  entries.sort((a, b) => b.bytes - a.bytes);

  return { totalBytes, entries };
}

/**
 * Internal helper to estimate byte size of a value.
 */
function estimateSize(value: StorableValue): number {
  if (value === null || value === undefined) return 4; // "null"
  if (typeof value === "boolean") return 5; // "true" or "false"
  if (typeof value === "number") return String(value).length;
  if (typeof value === "string") return value.length * 2; // UTF-16
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) {
    let size = 2; // []
    for (const item of value) {
      size += estimateSize(item);
    }
    return size;
  }
  if (typeof value === "object") {
    let size = 2; // {}
    for (const [k, v] of Object.entries(value)) {
      size += k.length * 2 + estimateSize(v as StorableValue) + 4; // "key":
    }
    return size;
  }
  return 0;
}
