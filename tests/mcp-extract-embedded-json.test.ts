import { describe, it, expect } from "vitest";

import { extractEmbeddedJson } from "../src/agent/mcp/client-manager.js";

describe("extractEmbeddedJson — Agent 365 response shapes", () => {
  it("parses clean JSON objects", () => {
    expect(extractEmbeddedJson('{"foo":1,"bar":[2,3]}')).toEqual({
      foo: 1,
      bar: [2, 3],
    });
  });

  it("parses clean JSON arrays", () => {
    expect(extractEmbeddedJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("strips a status prefix and parses the embedded JSON (Calendar pattern)", () => {
    const text = 'Success.\n{"value":[{"id":"abc"}]}';
    expect(extractEmbeddedJson(text)).toEqual({
      value: [{ id: "abc" }],
    });
  });

  it("unwraps {rawResponse} wrapper objects (Mail pattern)", () => {
    const inner = '{"value":[{"subject":"hi"}]}';
    const text = JSON.stringify({
      rawResponse: inner,
      message: "Mail fetched.",
    });
    expect(extractEmbeddedJson(text)).toEqual({
      value: [{ subject: "hi" }],
    });
  });

  it("unwraps a wrapper whose rawResponse itself has a status prefix", () => {
    const inner = 'Success.\n{"value":["ok"]}';
    const text = JSON.stringify({
      rawResponse: inner,
      message: "ok",
    });
    expect(extractEmbeddedJson(text)).toEqual({ value: ["ok"] });
  });

  it("returns the original string for prose with no JSON", () => {
    expect(extractEmbeddedJson("Operation completed.")).toBe(
      "Operation completed.",
    );
  });

  it("returns the original string when prefix-suffix isn't valid JSON", () => {
    // A '{' inside prose with no real JSON object — must NOT match.
    const text = "Failed: invalid request {bad}";
    expect(extractEmbeddedJson(text)).toBe(text);
  });

  it("preserves empty input", () => {
    expect(extractEmbeddedJson("")).toBe("");
  });
});
