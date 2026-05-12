// Stub for node:url
export function fileURLToPath(url) {
  if (typeof url === "string" && url.startsWith("file://")) return url.slice(7);
  return String(url);
}
export function pathToFileURL(p) { return new URL("file://" + p); }
export default { fileURLToPath, pathToFileURL };
