// Editing items.yaml (comments and order preserved) and committing it.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEntry, commitFile, committedContent, editIntent, parseIntent } from "../src/core/intent.ts";

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

test("clearing every setting keeps the entry (a URL alone still means: track this item)", () => {
  // An item added by URL and not fetched yet would otherwise vanish on mute + unmute.
  const out = editIntent(text, "https://github.com/foo/bar/pull/42", { priority: null, note: null }, canon);
  expect(out).toContain("  - url: https://github.com/foo/bar/pull/42/files # copied from the browser\n  - url: https://lists");
  expect(out).toContain("# My overrides: keep this comment.");
  expect([...parseIntent(out).keys()]).toEqual(["https://github.com/foo/bar/pull/42/files", "https://lists.example.org/msg1.html"]);
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

test("addEntry adds a manual item with its title, or a forge item to track, and refuses duplicates", () => {
  const out = addEntry(text, "https://lists.example.org/msg2.html", { manual: true, title: "[PATCH v2] foo" });
  expect(parseIntent(out).get("https://lists.example.org/msg2.html")).toMatchObject({ manual: true, title: "[PATCH v2] foo" });
  expect(() => addEntry(out, "https://lists.example.org/msg2.html", { manual: true })).toThrow("already listed");
  const untitled = addEntry("", "https://lists.example.org/msg3.html", { manual: true });
  expect(parseIntent(untitled).get("https://lists.example.org/msg3.html")).toMatchObject({ manual: true, title: undefined });
  const tracked = addEntry("", "https://github.com/x/y/issues/7", { manual: false, title: "ignored" });
  expect(tracked).toBe("items:\n  - url: https://github.com/x/y/issues/7\n");
});

/** A throwaway git repository with an identity, holding data/items.yaml. */
async function tempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "watcher-git-"));
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.org"]]) {
    expect(Bun.spawnSync(["git", "-C", dir, ...args]).exitCode).toBe(0);
  }
  return dir;
}

const gitOut = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]).stdout.toString();

/** A repo with one public commit on its main branch, and the personal data files git-ignored there. */
async function publicRepo(): Promise<string> {
  const dir = await tempRepo();
  writeFileSync(join(dir, "README.md"), "public\n");
  writeFileSync(join(dir, ".gitignore"), "data/items.yaml\n");
  gitOut(dir, "add", ".");
  gitOut(dir, "commit", "-qm", "public code");
  Bun.spawnSync(["mkdir", "-p", join(dir, "data")]);
  return dir;
}

test("commitFile commits to the config branch, leaving the checked-out branch, index and other files alone", async () => {
  const dir = await publicRepo();
  const main = gitOut(dir, "symbolic-ref", "--short", "HEAD");
  const mainTip = gitOut(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "data/items.yaml"), "items: []\n");
  writeFileSync(join(dir, "unrelated.txt"), "not mine to commit\n");
  gitOut(dir, "add", "unrelated.txt"); // staged by the user: must stay staged, uncommitted
  expect(await commitFile(dir, "data/items.yaml", "watcher: add x", "config")).toEqual({ ok: true });
  // The branch is created from the current commit: the code plus the personal data.
  expect(gitOut(dir, "log", "config", "--format=%s")).toBe("watcher: add x\npublic code\n");
  expect(gitOut(dir, "show", "config:data/items.yaml")).toBe("items: []\n");
  expect(gitOut(dir, "diff", "--name-only", "config~1", "config")).toBe("data/items.yaml\n");
  expect(gitOut(dir, "symbolic-ref", "--short", "HEAD")).toBe(main);
  expect(gitOut(dir, "rev-parse", "HEAD")).toBe(mainTip);
  expect(gitOut(dir, "diff", "--cached", "--name-only")).toBe("unrelated.txt\n");
  // Later changes stack on the branch.
  writeFileSync(join(dir, "data/items.yaml"), "items:\n  - url: https://x.org/a\n");
  expect(await commitFile(dir, "data/items.yaml", "watcher: add a\n\nMore text.", "config")).toEqual({ ok: true });
  expect(gitOut(dir, "log", "config", "--format=%s")).toBe("watcher: add a\nwatcher: add x\npublic code\n");
  expect(gitOut(dir, "log", "-1", "config", "--format=%b").trim()).toBe("More text.");
  // Nothing changed since: reported, not thrown.
  expect((await commitFile(dir, "data/items.yaml", "watcher: noop", "config")).ok).toBe(false);
});

test("commitFile on the config branch itself is an ordinary commit, leaving a clean tree", async () => {
  const dir = await publicRepo();
  gitOut(dir, "switch", "-q", "-c", "mine");
  writeFileSync(join(dir, "data/items.yaml"), "items: []\n"); // ignored by .gitignore: committed all the same
  expect(await commitFile(dir, "data/items.yaml", "watcher: add x", "mine")).toEqual({ ok: true });
  expect(gitOut(dir, "log", "--format=%s")).toBe("watcher: add x\npublic code\n");
  expect(gitOut(dir, "status", "--porcelain")).toBe("");
});

test("commitFile in a repository with no commit yet starts the branch from scratch", async () => {
  const dir = await tempRepo();
  Bun.spawnSync(["mkdir", "-p", join(dir, "data")]);
  writeFileSync(join(dir, "data/items.yaml"), "items: []\n");
  expect(await commitFile(dir, "data/items.yaml", "watcher: first", "config")).toEqual({ ok: true });
  expect(gitOut(dir, "log", "config", "--format=%s", "--name-only")).toBe("watcher: first\n\ndata/items.yaml\n");
});

test("commitFile outside a git repository is a warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watcher-nogit-"));
  writeFileSync(join(dir, "items.yaml"), "items: []\n");
  const r = await commitFile(dir, "items.yaml", "watcher: x", "config");
  expect(r.ok).toBe(false);
  expect(r.warning).toContain("git commit failed");
});

test("committedContent reads a file as committed on a branch, or null", async () => {
  const dir = await publicRepo();
  writeFileSync(join(dir, "data/items.yaml"), "items: []\n");
  expect(await committedContent(dir, "config", "data/items.yaml")).toBeNull(); // no branch yet
  await commitFile(dir, "data/items.yaml", "watcher: add x", "config");
  expect(await committedContent(dir, "config", "data/items.yaml")).toBe("items: []\n");
});
