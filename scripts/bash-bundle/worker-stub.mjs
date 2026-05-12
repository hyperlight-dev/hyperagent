// Stub for node:worker_threads and node:async_hooks
export class Worker {
  constructor() { throw new Error("Workers not available in this environment"); }
}
export const parentPort = null;
export const workerData = null;
export const isMainThread = true;
export class AsyncLocalStorage {
  getStore() { return undefined; }
  run(store, fn) { return fn(); }
}
