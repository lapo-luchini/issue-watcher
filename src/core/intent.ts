// data/items.yaml: the user's intent (priority, mute, notes, manual items), keyed by URL.
// Reading it, editing it without losing comments or order, and committing each change to git.
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

export function parseIntent(text: string): Intent {
  const raw: any = parse(text) ?? {};
  const list = raw.items ?? [];
  if (!Array.isArray(list)) throw new Error("items.yaml: 'items' must be a list");
  const out: Intent = new Map();
  list.forEach((r: any, i: number) => {
    const where = `items.yaml: items[${i}]`;
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

export async function loadIntent(path: string): Promise<Intent> {
  const file = Bun.file(path);
  return (await file.exists()) ? parseIntent(await file.text()) : new Map();
}

/**
 * Re-keys the intent by canonical item URL (as stored in the cache), so URLs copied from
 * the browser (trailing slash, PR tab, #fragment, …) still match. Manual entries are kept
 * as they are; other entries that no adapter recognizes are dropped and listed in `unknown`.
 */
export function canonicalizeIntent(
  intent: Intent,
  refFromUrl: (url: string) => ItemRef | null,
): { intent: Intent; unknown: string[] } {
  const out: Intent = new Map();
  const unknown: string[] = [];
  for (const entry of intent.values()) {
    const url = entry.manual ? entry.url : refFromUrl(entry.url)?.url;
    if (!url) {
      unknown.push(entry.url);
      continue;
    }
    if (out.has(url)) throw new Error(`items.yaml: duplicate url ${url} (${entry.url} is the same item as an earlier entry)`);
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
export function addEntry(text: string, url: string, opts: { manual: boolean; title?: string }): string {
  const doc = parseDocument(text);
  const items = itemsOf(doc);
  if (items.items.some((n) => urlOf(n) === url)) throw new Error(`${url} is already listed in items.yaml`);
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

/**
 * Commits one file of the repository at `repoDir` (its path relative to it) with `message`,
 * using the repository's configured identity, leaving anything else staged or changed alone.
 */
export async function commitFile(repoDir: string, file: string, message: string): Promise<CommitResult> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(["git", "-C", repoDir, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, text: (err || out).trim() };
  };
  // `add` first: `commit -- file` only accepts files git already knows.
  for (const args of [["add", "--", file], ["commit", "-q", "-m", message, "--", file]]) {
    const r = await run(args);
    if (r.code !== 0) return { ok: false, warning: `git commit failed: ${r.text.split("\n")[0] || `exit ${r.code}`}` };
  }
  return { ok: true };
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
