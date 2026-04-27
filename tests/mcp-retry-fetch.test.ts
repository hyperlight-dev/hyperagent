import { describe, it, expect, vi } from "vitest";

import { createRetryFetch } from "../src/agent/mcp/retry-fetch.js";

function makeResponse(status: number, headers: Record<string, string> = {}) {
  return new Response(`status-${status}`, { status, headers });
}

describe("createRetryFetch", () => {
  it("returns a successful response without retrying", async () => {
    const base = vi.fn().mockResolvedValue(makeResponse(200));
    const f = createRetryFetch(base);
    const res = await f("https://example.test/", {});
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("does not retry 4xx other than 429", async () => {
    const base = vi.fn().mockResolvedValue(makeResponse(404));
    const f = createRetryFetch(base);
    const res = await f("https://example.test/", {});
    expect(res.status).toBe(404);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("retries 503 and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    const base = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200));
    const f = createRetryFetch(base);
    const promise = f("https://example.test/", {});
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("retries 429/502/504 and gives up after MAX_ATTEMPTS", async () => {
    vi.useFakeTimers();
    const base = vi.fn().mockResolvedValue(makeResponse(502));
    const f = createRetryFetch(base);
    const promise = f("https://example.test/", {});
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(502);
    expect(base).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("respects Retry-After (delta-seconds) when reasonable", async () => {
    vi.useFakeTimers();
    const base = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, { "retry-after": "2" }))
      .mockResolvedValueOnce(makeResponse(200));
    const f = createRetryFetch(base);
    const promise = f("https://example.test/", {});
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("gives up immediately if Retry-After exceeds the cap", async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, { "retry-after": "999" }));
    const f = createRetryFetch(base);
    const res = await f("https://example.test/", {});
    expect(res.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("retries network errors and surfaces the final one", async () => {
    vi.useFakeTimers();
    const err = new TypeError("fetch failed");
    const base = vi.fn().mockImplementation(() => Promise.reject(err));
    const f = createRetryFetch(base);
    const promise = f("https://example.test/", {});
    // Swallow the unhandled rejection until we await the result below.
    promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(err);
    expect(base).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("does not retry AbortError", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const base = vi.fn().mockImplementation(() => Promise.reject(err));
    const f = createRetryFetch(base);
    await expect(f("https://example.test/", {})).rejects.toBe(err);
    expect(base).toHaveBeenCalledTimes(1);
  });
});
