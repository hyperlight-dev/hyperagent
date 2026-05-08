// Stub for node:fs — just-bash's ReadWriteFs uses this for real FS
// We don't use ReadWriteFs — we use our own IFileSystem adapter
// But the import exists in the bundle, so we stub it
export function readFileSync() { throw new Error("node:fs not available in sandbox"); }
export function writeFileSync() { throw new Error("node:fs not available in sandbox"); }
export function existsSync() { return false; }
export function statSync() { throw new Error("node:fs not available in sandbox"); }
export function readdirSync() { return []; }
export function mkdirSync() { throw new Error("node:fs not available in sandbox"); }
export function unlinkSync() { throw new Error("node:fs not available in sandbox"); }
export function rmdirSync() { throw new Error("node:fs not available in sandbox"); }
export function chmodSync() { throw new Error("node:fs not available in sandbox"); }
export function symlinkSync() { throw new Error("node:fs not available in sandbox"); }
export function linkSync() { throw new Error("node:fs not available in sandbox"); }
export function readlinkSync() { throw new Error("node:fs not available in sandbox"); }
export function realpathSync() { throw new Error("node:fs not available in sandbox"); }
export function lstatSync() { throw new Error("node:fs not available in sandbox"); }
export function utimesSync() { throw new Error("node:fs not available in sandbox"); }
export function copyFileSync() { throw new Error("node:fs not available in sandbox"); }
export function renameSync() { throw new Error("node:fs not available in sandbox"); }
export async function open() { throw new Error("node:fs/promises not available in sandbox"); }
export default {};
