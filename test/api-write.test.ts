// Commands that change items.yaml: written, committed, serialized.
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addItem, changeIntent } from "../src/core/api.ts";
import { parseIntent } from "../src/core/intent.ts";
import type { ItemRef } from "../src/core/model.ts";
import { itemId, Store } from "../src/core/store.ts";

let home: string;
let store: Store;
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", home, ...args]).stdout.toString();
const items = () => readFileSync(join(home, "data/items.yaml"), "utf8");
/** GitHub-like URLs are tracked items; a trailing /files is a browser tab. */
const recognize = (url: string): ItemRef | null => {
  const m = url.match(/^(https:\/\/github\.com\/\w+\/\w+\/(pull|issues)\/\d+)(\/files)?$/);
  return m ? { url: m[1]!, instance: "github", kind: m[2] === "pull" ? "pr" : "issue" } : null;
};
const canonical = (url: string) => recognize(url)?.url ?? url;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "watcher-home-"));
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.org"]]) git(...args);
  mkdirSync(join(home, "data"));
  writeFileSync(join(home, "data/items.yaml"), "# mine\nitems:\n  - url: https://github.com/foo/bar/pull/42/files\n    note: old\n");
  git("add", "."), git("commit", "-qm", "init");
  store = new Store(":memory:");
});

test("changeIntent edits the entry in place and commits with a readable message", async () => {
  const r = await changeIntent(home, "https://github.com/foo/bar/pull/42", { priority: "important" }, canonical);
  expect(r).toEqual({ ok: true });
  expect(items()).toBe("# mine\nitems:\n  - url: https://github.com/foo/bar/pull/42/files\n    note: old\n    priority: important\n");
  expect(git("log", "-1", "--format=%s")).toBe("watcher: mark foo/bar#42 important\n");
  await changeIntent(home, "https://github.com/foo/bar/pull/42", { muted: true, note: null }, canonical, "foo/bar");
  expect(git("log", "-1", "--format=%s")).toBe("watcher: mute foo/bar#42; remove note on foo/bar#42\n");
});

test("uncommitted hand edits that a change commits along are mentioned in the message", async () => {
  writeFileSync(join(home, "data/items.yaml"), items() + "  # a comment I added by hand\n");
  await changeIntent(home, "https://github.com/x/y/issues/1", { muted: true }, canonical);
  expect(git("log", "-1", "--format=%B").trim()).toBe(
    "watcher: mute x/y#1\n\nAlso commits earlier changes to data/items.yaml that were not committed yet.");
  // A clean file gets the plain message.
  await changeIntent(home, "https://github.com/x/y/issues/1", { muted: false }, canonical);
  expect(git("log", "-1", "--format=%B").trim()).toBe("watcher: unmute x/y#1");
});

test("a change that changes nothing makes no commit", async () => {
  const head = git("rev-parse", "HEAD");
  expect(await changeIntent(home, "https://github.com/foo/bar/pull/42", { note: "old" }, canonical)).toEqual({ ok: true });
  expect(git("rev-parse", "HEAD")).toBe(head);
});

test("concurrent changes are applied one after the other, none lost", async () => {
  await Promise.all([
    changeIntent(home, "https://github.com/a/a/issues/1", { muted: true }, canonical),
    changeIntent(home, "https://github.com/b/b/issues/2", { priority: "important" }, canonical),
    changeIntent(home, "https://github.com/c/c/issues/3", { note: "hi" }, canonical),
  ]);
  expect([...parseIntent(items()).keys()]).toEqual([
    "https://github.com/foo/bar/pull/42/files", "https://github.com/a/a/issues/1",
    "https://github.com/b/b/issues/2", "https://github.com/c/c/issues/3",
  ]);
  expect(git("rev-list", "--count", "HEAD")).toBe("4\n");
});

test("addItem: forge URLs are tracked by canonical URL, others become manual items", async () => {
  const tracked = await addItem(home, store, new Map(), recognize, "https://github.com/x/y/issues/7");
  expect(tracked).toEqual({ url: "https://github.com/x/y/issues/7", manual: false, commit: { ok: true } });
  const manual = await addItem(home, store, new Map(), recognize, "https://lists.example.org/msg1.html", " [PATCH] foo ");
  expect(manual.manual).toBe(true);
  expect(parseIntent(items()).get("https://lists.example.org/msg1.html")).toMatchObject({ manual: true, title: "[PATCH] foo" });
  expect(git("log", "-2", "--format=%s")).toBe("watcher: add manual item https://lists.example.org/msg1.html\nwatcher: add x/y#7\n");
});

test("addItem refuses non-web URLs and items already tracked", async () => {
  const intent = parseIntent(items());
  await expect(addItem(home, store, intent, recognize, "ftp://x.org/a")).rejects.toThrow("not a web URL");
  await expect(addItem(home, store, intent, recognize, "not a url")).rejects.toThrow("not a web URL");
  await expect(addItem(home, store, parseIntent("items:\n  - url: https://github.com/foo/bar/pull/42"), recognize,
    "https://github.com/foo/bar/pull/42/files")).rejects.toThrow("already tracked: https://github.com/foo/bar/pull/42");
  const url = "https://github.com/q/q/issues/9";
  store.upsertItem({
    url, id: itemId(url), instance: "github", kind: "issue", repo: "q/q", title: "t", state: "open", stateDetail: null,
    ciState: null, hasConflicts: false, authoredByMe: false, maintainedByMe: false, labels: [], lastSignalAt: null,
    lastSignalSummary: null, seenAt: null, baselineAt: "x", fetchedAt: "x", snapshotJson: null,
  });
  await expect(addItem(home, store, intent, recognize, url)).rejects.toThrow("already tracked");
});

test("without git the file is still written, and the failed commit is a warning", async () => {
  const plain = mkdtempSync(join(tmpdir(), "watcher-plain-"));
  const r = await changeIntent(plain, "https://github.com/x/y/issues/7", { muted: true }, canonical);
  expect(r.ok).toBe(false);
  expect(r.warning).toContain("git commit failed");
  expect(readFileSync(join(plain, "data/items.yaml"), "utf8")).toBe("items:\n  - url: https://github.com/x/y/issues/7\n    muted: true\n");
});
