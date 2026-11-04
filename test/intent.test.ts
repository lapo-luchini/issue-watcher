import { expect, test } from "bun:test";
import { canonicalizeIntent, effectivePriority, loadIntent, parseIntent } from "../src/core/intent.ts";
import type { ItemRef } from "../src/core/model.ts";

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
  expect(() => parseIntent("items:\n  - url: https://x.org/a\n    priority: high")).toThrow("priority must be");
  expect(() => parseIntent("items:\n  - url: https://x.org/a\n  - url: https://x.org/a")).toThrow("duplicate url");
  expect(() => parseIntent("items:\n  - url: lists.example.org/msg1\n    manual: true")).toThrow("items[0]: invalid url 'lists.example.org/msg1'");
});

test("effectivePriority defaults", () => {
  expect(effectivePriority(undefined, "pr", true)).toBe("important");
  expect(effectivePriority(undefined, "pr", false)).toBe("normal");
  expect(effectivePriority(undefined, "issue", true)).toBe("normal");
  const flagged = parseIntent("items:\n  - url: https://x.org/a\n    priority: normal").get("https://x.org/a");
  expect(effectivePriority(flagged, "pr", true)).toBe("normal");
});

/** Recognizes https://forge.example/o/r/N, with an optional trailing slash. */
const fakeRefFromUrl = (url: string): ItemRef | null => {
  const m = url.match(/^(https:\/\/forge\.example\/\w+\/\w+\/\d+)\/?$/);
  return m ? { url: m[1] as string, instance: "forge", kind: "issue" } : null;
};

test("canonicalizeIntent re-keys entries by canonical URL and drops unknown ones", () => {
  const intent = parseIntent(`
items:
  - url: https://forge.example/o/r/1/
    priority: important
  - url: https://forge.example/o/r/2
    muted: true
  - url: https://elsewhere.example/o/r/3
  - url: https://lists.example.org/msg1.html
    manual: true
`);
  const { intent: canon, unknown } = canonicalizeIntent(intent, fakeRefFromUrl);
  expect([...canon.keys()]).toEqual(["https://forge.example/o/r/1", "https://forge.example/o/r/2", "https://lists.example.org/msg1.html"]);
  expect(canon.get("https://forge.example/o/r/1")).toMatchObject({ url: "https://forge.example/o/r/1", priority: "important" });
  expect(canon.get("https://forge.example/o/r/2")?.muted).toBe(true);
  expect(unknown).toEqual(["https://elsewhere.example/o/r/3"]);
});

test("canonicalizeIntent rejects two entries for the same item", () => {
  const intent = parseIntent("items:\n  - url: https://forge.example/o/r/1/\n  - url: https://forge.example/o/r/1");
  expect(() => canonicalizeIntent(intent, fakeRefFromUrl)).toThrow("duplicate url https://forge.example/o/r/1");
});
