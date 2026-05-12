// Minimal node:path polyfill for just-bash
export function join(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}
export function resolve(...parts) {
  let result = "";
  for (const part of parts) {
    if (part.startsWith("/")) result = part;
    else result = result ? result + "/" + part : part;
  }
  return normalize(result || "/");
}
export function normalize(p) {
  const absolute = p.startsWith("/");
  const parts = p.split("/");
  const out = [];
  for (const part of parts) {
    if (part === "..") {
      if (out.length > 0) out.pop();
      else if (!absolute) out.push("..");
    }
    else if (part !== "." && part !== "") out.push(part);
  }
  const normalized = (absolute ? "/" : "") + out.join("/");
  return normalized || (absolute ? "/" : ".");
}
export function dirname(p) {
  const i = p.lastIndexOf("/");
  return i <= 0 ? (p.startsWith("/") ? "/" : ".") : p.slice(0, i);
}
export function basename(p, ext) {
  let b = p.split("/").pop() || "";
  if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
  return b;
}
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
}
export function isAbsolute(p) { return p.startsWith("/"); }
export function relative(from, to) {
  const f = resolve(from).split("/").filter(Boolean);
  const t = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const ups = f.length - i;
  return [...Array(ups).fill(".."), ...t.slice(i)].join("/") || ".";
}
export const sep = "/";
export const delimiter = ":";
export const posix = { join, resolve, normalize, dirname, basename, extname, isAbsolute, relative, sep, delimiter };
export default { join, resolve, normalize, dirname, basename, extname, isAbsolute, relative, sep, delimiter, posix };
