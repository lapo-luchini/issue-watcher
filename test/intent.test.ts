import { expect, test } from "bun:test";
import { effectivePriority, loadIntent, parseIntent } from "../src/core/intent.ts";

const yaml = `
# my overrides
items:
  - url: https://github.com/foo/bar/issues/7
    priority: important
    note: waiting for 1.4
  - url: https://github.com/x/y/issues/1
    muted: true
  - url: https://lists.example.org/msg1.html
    manual: true
    title: "[PATCH] foo"
`;

test("parses entries keyed by url with defaults", () => {
  const intent = parseIntent(yaml);
  expect(intent.size).toBe(3);
  expect(intent.get("https://github.com/foo/bar/issues/7")).toEqual({
    url: "https://github.com/foo/bar/issues/7", priority: "important", muted: false,
    note: "waiting for 1.4", manual: false, title: undefined,
  });
  expect(intent.get("https://github.com/x/y/issues/1")?.muted).toBe(true);
  expect(intent.get("https://lists.example.org/msg1.html")?.manual).toBe(true);
});

test("empty or missing file means no intent", async () => {
  expect(parseIntent("").size).toBe(0);
  expect((await loadIntent("/nonexistent/items.yaml")).size).toBe(0);
});

test("validation", () => {
  expect(() => parseIntent("items:\n  - note: x")).toThrow("'url' is required");
  expect(() => parseIntent("items:\n  - url: a\n    priority: high")).toThrow("priority must be");
  expect(() => parseIntent("items:\n  - url: a\n  - url: a")).toThrow("duplicate url");
});

test("effectivePriority defaults", () => {
  expect(effectivePriority(undefined, "pr", true)).toBe("important");
  expect(effectivePriority(undefined, "pr", false)).toBe("normal");
  expect(effectivePriority(undefined, "issue", true)).toBe("normal");
  const flagged = parseIntent("items:\n  - url: a\n    priority: normal").get("a");
  expect(effectivePriority(flagged, "pr", true)).toBe("normal");
});
