// Editing items.yaml (comments and order preserved) and committing it.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addManual, commitFile, editIntent, parseIntent } from "../src/core/intent.ts";

const text = `# My overrides: keep this comment.
items:
  # the FreeBSD build fix
  - url: https://github.com/foo/bar/pull/42/files # copied from the browser
    priority: important
    note: waiting for 1.4
  - url: https://lists.example.org/msg1.html
    manual: true
    title: "[PATCH] foo"
`;
/** Canonicalizes like an adapter would: drops a trailing PR tab. */
const canon = (url: string) => url.replace(/\/files$/, "");

test("editIntent changes an existing entry in place, keeping comments and order", () => {
  const out = editIntent(text, "https://github.com/foo/bar/pull/42", { note: "merged upstream?", muted: true }, canon);
  expect(out).toBe(`# My overrides: keep this comment.
items:
  # the FreeBSD build fix
  - url: https://github.com/foo/bar/pull/42/files # copied from the browser
    priority: important
    note: merged upstream?
    muted: true
  - url: https://lists.example.org/msg1.html
    manual: true
    title: "[PATCH] foo"
`);
});

test("editIntent appends a new entry for an item not listed yet", () => {
  const out = editIntent(text, "https://github.com/x/y/issues/7", { priority: "important" }, canon);
  expect(out.endsWith(`    title: "[PATCH] foo"
  - url: https://github.com/x/y/issues/7
    priority: important
`)).toBe(true);
  expect(parseIntent(out).get("https://github.com/x/y/issues/7")?.priority).toBe("important");
});

test("clearing every setting removes the entry; manual entries stay", () => {
  const out = editIntent(text, "https://github.com/foo/bar/pull/42", { priority: null, note: null }, canon);
  expect(out).not.toContain("foo/bar/pull/42");
  expect(out).toContain("# My overrides: keep this comment.");
  expect([...parseIntent(out).keys()]).toEqual(["https://lists.example.org/msg1.html"]);
  const manual = editIntent(text, "https://lists.example.org/msg1.html", { muted: false, note: null }, canon);
  expect(parseIntent(manual).get("https://lists.example.org/msg1.html")?.manual).toBe(true);
  // An empty note clears it too.
  expect(editIntent(text, "https://github.com/foo/bar/pull/42", { note: "" }, canon)).not.toContain("note:");
});

test("editIntent works on an empty or missing file", () => {
  for (const empty of ["", "items: []\n", "# nothing yet\n"]) {
    const out = editIntent(empty, "https://github.com/x/y/issues/7", { muted: true });
    expect(parseIntent(out).get("https://github.com/x/y/issues/7")?.muted).toBe(true);
    expect(out).toContain("  - url: https://github.com/x/y/issues/7\n    muted: true\n");
  }
});

test("addManual adds a manual item with its title, and refuses duplicates", () => {
  const out = addManual(text, "https://lists.example.org/msg2.html", "[PATCH v2] foo");
  expect(parseIntent(out).get("https://lists.example.org/msg2.html")).toMatchObject({ manual: true, title: "[PATCH v2] foo" });
  expect(() => addManual(out, "https://lists.example.org/msg2.html", "again")).toThrow("already listed");
  const untitled = addManual("", "https://lists.example.org/msg3.html");
  expect(parseIntent(untitled).get("https://lists.example.org/msg3.html")).toMatchObject({ manual: true, title: undefined });
});

/** A throwaway git repository with an identity, holding data/items.yaml. */
async function tempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "watcher-git-"));
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.org"]]) {
    expect(Bun.spawnSync(["git", "-C", dir, ...args]).exitCode).toBe(0);
  }
  return dir;
}

test("commitFile commits only that file, even when it was untracked", async () => {
  const dir = await tempRepo();
  Bun.spawnSync(["mkdir", "-p", join(dir, "data")]);
  writeFileSync(join(dir, "data/items.yaml"), "items: []\n");
  writeFileSync(join(dir, "unrelated.txt"), "not mine to commit\n");
  expect(await commitFile(dir, "data/items.yaml", "watcher: add x")).toEqual({ ok: true });
  const log = Bun.spawnSync(["git", "-C", dir, "log", "--format=%s", "--name-only"]).stdout.toString();
  expect(log).toBe("watcher: add x\n\ndata/items.yaml\n");
  // Nothing changed since: reported, not thrown.
  const again = await commitFile(dir, "data/items.yaml", "watcher: noop");
  expect(again.ok).toBe(false);
});

test("commitFile outside a git repository is a warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watcher-nogit-"));
  writeFileSync(join(dir, "items.yaml"), "items: []\n");
  const r = await commitFile(dir, "items.yaml", "watcher: x");
  expect(r.ok).toBe(false);
  expect(r.warning).toContain("git commit failed");
});
