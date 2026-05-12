// Stub for node:zlib — just-bash's gzip/tar commands use this
export function gzipSync(data) {
  throw new Error("gzip: not available in this environment. Use the ha:zip-format module in a JavaScript handler instead.");
}
export function gunzipSync(data) {
  throw new Error("gunzip: not available in this environment. Use the ha:zip-format module in a JavaScript handler instead.");
}
export function deflateSync(data) { return gzipSync(data); }
export function inflateSync(data) { return gunzipSync(data); }
export const constants = { Z_SYNC_FLUSH: 0, Z_FINISH: 4, Z_DEFAULT_COMPRESSION: -1, Z_NO_COMPRESSION: 0, Z_BEST_COMPRESSION: 9 };
export default { gzipSync, gunzipSync, deflateSync, inflateSync, constants };
