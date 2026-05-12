// Stub for node:crypto
export function randomBytes(n) {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}
export function randomUUID() {
  const h = "0123456789abcdef";
  let u = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) u += "-";
    else u += h[Math.floor(Math.random() * 16)];
  }
  return u;
}
export function createHash() {
  throw new Error("createHash: not available in sandbox");
}
export default { randomBytes, randomUUID, createHash };
