// Stub for node:dns — just-bash uses this for network allow-list validation
// We handle networking through host:fetch plugin, so DNS lookup is not needed
export function lookup(hostname, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  // Return a dummy address — our fetch plugin does its own SSRF checks
  if (cb) cb(null, "0.0.0.0", 4);
}
export default { lookup };
