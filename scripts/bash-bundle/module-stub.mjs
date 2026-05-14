// Stub for node:module — used by just-bash for createRequire()
// In the Hyperlight sandbox there's no native require(); return a
// function that throws so callers fall back to ESM imports.
export function createRequire() {
  return function fakeRequire(id) {
    throw new Error("require() not available in sandbox: " + id);
  };
}
export default { createRequire };
