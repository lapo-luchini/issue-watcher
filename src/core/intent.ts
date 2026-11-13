// data/items.yaml: the user's intent (priority, mute, notes, manual items), keyed by URL.
// Reading it, editing it without losing comments or order, and committing each change to git.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMap, isSeq, parse, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import type { ItemKind, ItemRef, Priority } from "./model.ts";

export interface IntentEntry {
  url: string;
  priority?: Priority;
  muted: boolean;
  note?: string;
  manual: boolean; // listed, never polled
  title?: string; // only meaningful for manual items
}

export type Intent = Map<string, IntentEntry>;

/** `file` names the register in error messages. */
export function parseIntent(text: string, file = "items.yaml"): Intent {
  const raw: any = parse(text) ?? {};
  const list = raw.items ?? [];
  if (!Array.isArray(list)) throw new Error(`${file}: 'items' must be a list`);
  const out: Intent = new Map();
  list.forEach((r: any, i: number) => {
    const where = `${file}: items[${i}]`;
    if (typeof r?.url !== "string" || r.url === "") throw new Error(`${where}: 'url' is required`);
    if (!URL.canParse(r.url) || !/^https?:$/.test(new URL(r.url).protocol)) {
      throw new Error(`${where}: invalid url '${r.url}' (http or https only)`);
    }
    if (r.priority !== undefined && r.priority !== "important" && r.priority !== "normal") {
      throw new Error(`${where}: priority must be 'important' or 'normal'`);
    }
    if (out.has(r.url)) throw new Error(`${where}: duplicate url ${r.url}`);
    out.set(r.url, {
      url: r.url,
      priority: r.priority,
      muted: r.muted === true,
      note: r.note,
      manual: r.manual === true,
      title: r.title,
    });
  });
  return out;
}

export async function loadIntent(path: string, name = "items.yaml"): Promise<Intent> {
  const file = Bun.file(path);
  return (await file.exists()) ? parseIntent(await file.text(), name) : new Map();
}

/**
 * Re-keys the intent by canonical item URL (as stored in the cache), so URLs copied from
 * the browser (trailing slash, PR tab, #fragment, …) still match. Manual entries are kept
 * as they are; other entries that no adapter recognizes are dropped and listed in `unknown`.
 */
export function canonicalizeIntent(
  intent: Intent,
  refFromUrl: (url: string) => ItemRef | null,
  file = "items.yaml",
): { intent: Intent; unknown: string[] } {
  const out: Intent = new Map();
  const unknown: string[] = [];
  for (const entry of intent.values()) {
    const url = entry.manual ? entry.url : refFromUrl(entry.url)?.url;
    if (!url) {
      unknown.push(entry.url);
      continue;
    }
    if (out.has(url)) throw new Error(`${file}: duplicate url ${url} (${entry.url} is the same item as an earlier entry)`);
    out.set(url, { ...entry, url });
  }
  return { intent: out, unknown };
}

/** A change to one item's intent. null (or "" for a note) clears a setting; absent leaves it alone. */
export interface IntentChange {
  priority?: Priority | null;
  muted?: boolean;
  note?: string | null;
}

/** The `items` sequence of an items.yaml document, created (as a block list) if missing. */
function itemsOf(doc: Document): YAMLSeq {
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
  let items = doc.get("items");
  if (!isSeq(items)) {
    items = doc.createNode([]);
    doc.set("items", items);
  }
  const seq = items as YAMLSeq;
  seq.flow = false; // "items: []" would otherwise stay a one-line flow list
  return seq;
}

function urlOf(node: unknown): string | null {
  if (!isMap(node)) return null;
  const url = node.get("url");
  return typeof url === "string" ? url : null;
}

/**
 * Returns `text` with the entry for `url` changed. The entry is found by canonical URL (an
 * entry written as a browser URL is edited in place) or appended. Entries are never removed.
 * Comments, order and formatting elsewhere are kept.
 */
export function editIntent(text: string, url: string, change: IntentChange, canonical: (url: string) => string = (u) => u): string {
  const doc = parseDocument(text);
  const items = itemsOf(doc);
  let entry = items.items.find((n) => {
    const u = urlOf(n);
    return u !== null && (u === url || canonical(u) === url);
  }) as YAMLMap | undefined;
  if (!entry) {
    entry = doc.createNode({ url }) as YAMLMap;
    items.add(entry);
  }
  if (change.priority !== undefined) {
    if (change.priority === null) entry.delete("priority");
    else entry.set("priority", change.priority);
  }
  if (change.muted !== undefined) {
    if (change.muted) entry.set("muted", true);
    else entry.delete("muted");
  }
  if (change.note !== undefined) {
    if (change.note === null || change.note.trim() === "") entry.delete("note");
    else entry.set("note", change.note.trim());
  }
  // An entry left with only its URL stays: it still asks for the item to be tracked (one
  // added by URL may not have been fetched yet).
  return doc.toString();
}

/**
 * Returns `text` with a new entry appended: a manual item (listed, never polled, with an
 * optional title), or a forge item to track (just its canonical URL, fetched on the next poll).
 */
export function addEntry(text: string, url: string, opts: { manual: boolean; title?: string }, file = "items.yaml"): string {
  const doc = parseDocument(text);
  const items = itemsOf(doc);
  if (items.items.some((n) => urlOf(n) === url)) throw new Error(`${url} is already listed in ${file}`);
  const entry: Record<string, unknown> = { url };
  if (opts.manual) entry.manual = true;
  if (opts.manual && opts.title) entry.title = opts.title;
  items.add(doc.createNode(entry));
  return doc.toString();
}

/** Outcome of committing a file: a failure is a warning, the file stays written either way. */
export interface CommitResult {
  ok: boolean;
  warning?: string;
}

/** Runs git in `repoDir`; `env` adds variables (e.g. GIT_INDEX_FILE). Never throws. */
async function git(repoDir: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["git", "-C", repoDir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}

/** `file` as committed at `rev` (a branch name or HEAD), or null (no such revision or file, not a repository). */
export async function committedContent(repoDir: string, rev: string, file: string): Promise<string | null> {
  const r = await git(repoDir, ["show", `${rev === "HEAD" ? rev : `refs/heads/${rev}`}:${file}`]);
  return r.code === 0 ? r.out : null;
}

const failed = (r: { code: number; out: string; err: string }): CommitResult =>
  ({ ok: false, warning: `git commit failed: ${(r.err || r.out).trim().split("\n")[0] || `exit ${r.code}`}` });

/**
 * Commits one file of the repository at `repoDir` (path relative to it) to `branch`, with
 * `message` and the repository's configured identity. The branch keeps the user's personal data
 * (it can stay local while the code is published), so this works whatever is checked out:
 * - on `branch` itself, an ordinary commit of that file (other staged changes stay staged);
 * - elsewhere, the commit is built with a temporary index and the branch moved to it, leaving
 *   HEAD, the index and the working tree alone. A missing branch starts from the current commit.
 * Even a git-ignored file is committed (the public branch may ignore the personal files).
 */
export async function commitFile(repoDir: string, file: string, message: string, branch: string): Promise<CommitResult> {
  const head = await git(repoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code === 0 && head.out.trim() === branch) {
    // `add` first: `commit -- file` only accepts files git already knows.
    for (const args of [["add", "--force", "--", file], ["commit", "-q", "-m", message, "--", file]]) {
      const r = await git(repoDir, args);
      if (r.code !== 0) return failed(r);
    }
    return { ok: true };
  }
  const ref = `refs/heads/${branch}`;
  const tip = await git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const current = await git(repoDir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const parent = tip.code === 0 ? tip.out.trim() : current.code === 0 ? current.out.trim() : null;
  const blob = await git(repoDir, ["hash-object", "-w", "--", file]);
  if (blob.code !== 0) return failed(blob);

  const dir = mkdtempSync(join(tmpdir(), "watcher-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    for (const args of [
      ...(parent ? [["read-tree", parent]] : []),
      ["update-index", "--add", "--cacheinfo", `100644,${blob.out.trim()},${file}`],
    ]) {
      const r = await git(repoDir, args, env);
      if (r.code !== 0) return failed(r);
    }
    const tree = await git(repoDir, ["write-tree"], env);
    if (tree.code !== 0) return failed(tree);
    if (parent) {
      const parentTree = await git(repoDir, ["rev-parse", `${parent}^{tree}`]);
      if (parentTree.out.trim() === tree.out.trim()) return { ok: false, warning: `git commit failed: nothing to commit on ${branch}` };
    }
    const commit = await git(repoDir, ["commit-tree", tree.out.trim(), ...(parent ? ["-p", parent] : []), "-m", message]);
    if (commit.code !== 0) return failed(commit);
    // Moves the branch only if nobody else moved it meanwhile (empty old value: it must not exist yet).
    const update = await git(repoDir, ["update-ref", "-m", "watcher: commit", ref, commit.out.trim(), tip.code === 0 ? tip.out.trim() : ""]);
    return update.code === 0 ? { ok: true } : failed(update);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Explicit priority wins; otherwise PRs/MRs/patches I authored, or that were sent to a repo I
 * maintain, are important, and everything else is normal.
 */
export function effectivePriority(
  entry: IntentEntry | undefined, kind: ItemKind, authoredByMe: boolean, maintainedByMe = false,
): Priority {
  return entry?.priority ?? (kind === "pr" && (authoredByMe || maintainedByMe) ? "important" : "normal");
}
