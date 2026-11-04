// Query/command API shared by every front end (CLI, HTTP server; an MCP server later).
// Front ends never touch the Store or items.yaml directly.
import { join } from "node:path";
import type { Config } from "./config.ts";
import { addEntry, commitFile, editIntent, effectivePriority, type CommitResult, type Intent, type IntentChange } from "./intent.ts";
import type { ActorRole, CiState, EventKind, ItemKind, ItemRef, ItemState, Priority } from "./model.ts";
import { itemId, type Store } from "./store.ts";
import { summarize } from "./summary.ts";

export interface ItemView {
  id: string;
  url: string;
  instance: string | null; // null for manual items
  kind: ItemKind | "manual";
  repo: string;
  title: string;
  state: string; // for display: "closed (completed)"
  itemState: ItemState | "manual";
  stateDetail: string | null;
  ciState: CiState | null;
  hasConflicts: boolean;
  labels: string[];
  priority: Priority;
  muted: boolean;
  note: string | null;
  unread: boolean;
  lastSignalAt: string | null;
  lastSignalSummary: string | null;
}

export interface ListOptions {
  unreadOnly?: boolean;
  includeMuted?: boolean;
  importantOnly?: boolean;
  instance?: string;
}

/** Important first, then most recent signal first; items that never had a signal last. */
export function listItems(store: Store, intent: Intent, opts: ListOptions = {}): ItemView[] {
  const views: ItemView[] = store.listItems().map((i) => {
    const entry = intent.get(i.url);
    return {
      id: i.id, url: i.url, instance: i.instance, kind: i.kind, repo: i.repo, title: i.title,
      state: i.stateDetail ? `${i.state} (${i.stateDetail})` : i.state, itemState: i.state, stateDetail: i.stateDetail,
      ciState: i.ciState, hasConflicts: i.hasConflicts, labels: i.labels,
      priority: effectivePriority(entry, i.kind, i.authoredByMe, i.maintainedByMe),
      muted: entry?.muted ?? false, note: entry?.note ?? null,
      unread: i.lastSignalAt !== null && (i.seenAt === null || i.lastSignalAt > i.seenAt),
      lastSignalAt: i.lastSignalAt, lastSignalSummary: i.lastSignalSummary,
    };
  });
  for (const entry of intent.values()) {
    if (!entry.manual) continue;
    views.push({
      id: itemId(entry.url), url: entry.url, instance: null, kind: "manual", repo: new URL(entry.url).host,
      title: entry.title ?? entry.url, state: "manual", itemState: "manual", stateDetail: null, ciState: null,
      hasConflicts: false, labels: [], priority: entry.priority ?? "normal",
      muted: entry.muted, note: entry.note ?? null, unread: false, lastSignalAt: null, lastSignalSummary: null,
    });
  }
  return views
    .filter((v) => (opts.includeMuted || !v.muted) && (!opts.unreadOnly || v.unread))
    .filter((v) => (!opts.importantOnly || v.priority === "important") && (!opts.instance || v.instance === opts.instance))
    .sort((a, b) =>
      (a.priority === b.priority ? 0 : a.priority === "important" ? -1 : 1) ||
      (b.lastSignalAt ?? "").localeCompare(a.lastSignalAt ?? "") ||
      a.title.localeCompare(b.title));
}

/** One item by its short id (muted ones included), or null. */
export function getItem(store: Store, intent: Intent, id: string): ItemView | null {
  return listItems(store, intent, { includeMuted: true }).find((v) => v.id === id) ?? null;
}

export interface EventView {
  key: string;
  kind: EventKind;
  actor: string;
  actorRole: ActorRole;
  at: string;
  detectedAt: string;
  summary: string;
  excerpt: string | null;
  isSignal: boolean;
  reason: string;
  isBaseline: boolean;
}

/** An item's events, newest first: signal only, or noise too (with the filter's reason). */
export function itemEvents(store: Store, url: string, includeNoise: boolean): EventView[] {
  return store.eventsFor(url, includeNoise).map((e) => ({
    key: e.key, kind: e.kind, actor: e.actor, actorRole: e.actorRole, at: e.at, detectedAt: e.detectedAt,
    summary: summarize(e), excerpt: e.excerpt, isSignal: e.isSignal, reason: e.reason, isBaseline: e.isBaseline,
  }));
}

export interface InstanceStatus {
  id: string;
  type: string;
  disabledReason: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  error: string | null; // of the latest run
}

/** Every configured instance, in config order, with the outcome of its polls. */
export function instanceStatus(store: Store, config: Config): InstanceStatus[] {
  const runs = new Map(store.lastRuns().map((r) => [r.instance, r]));
  return config.instances.map((i) => {
    const r = runs.get(i.id);
    return {
      id: i.id, type: i.type, disabledReason: i.disabledReason ?? null,
      lastRunAt: r?.finishedAt ?? null, lastSuccessAt: r?.lastSuccessAt ?? null, error: r?.error ?? null,
    };
  });
}

/** Marks items seen by URL (or all items when `urls` is empty); returns how many were updated. */
export function markSeen(store: Store, urls: string[], now: Date): number {
  const at = now.toISOString();
  if (urls.length === 0) return store.markAllSeen(at);
  return urls.filter((u) => store.markSeen(u, at)).length;
}

// ---- Changing items.yaml (each change is committed to git) ----

/** items.yaml, relative to the watcher home, which is (normally) a git repository. */
export const ITEMS_FILE = "data/items.yaml";

/** A short name for commit messages: "foo/bar#42", "a/b/c#7", "heartwood#abcd1234", "bugs.freebsd.org bug 300512". */
export function itemLabel(url: string, repo?: string): string {
  const u = new URL(url);
  const bug = u.searchParams.get("id");
  if (u.pathname.endsWith("/show_bug.cgi") && bug) return `${u.host} bug ${bug}`;
  const m = u.pathname.match(/^\/(.+?)\/(?:-\/)?(?:pull|pulls|issues|merge_requests|patches)\/([0-9a-f]+)\/?$/);
  if (!m) return url;
  const id = m[2]!.length > 12 ? m[2]!.slice(0, 8) : m[2]!;
  return `${repo ?? m[1]}#${id}`;
}

function changeMessage(label: string, c: IntentChange): string {
  const parts: string[] = [];
  if (c.priority !== undefined) parts.push(c.priority === null ? `reset priority of ${label}` : `mark ${label} ${c.priority}`);
  if (c.muted !== undefined) parts.push(`${c.muted ? "mute" : "unmute"} ${label}`);
  if (c.note !== undefined) parts.push(c.note ? `note on ${label}` : `remove note on ${label}`);
  return `watcher: ${parts.join("; ")}`;
}

// Writes to items.yaml happen one at a time (the server may get two requests at once).
let writes: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn, fn);
  writes = next.catch(() => {});
  return next;
}

async function rewriteItems(home: string, edit: (text: string) => string, message: string): Promise<CommitResult> {
  const path = join(home, ITEMS_FILE);
  const file = Bun.file(path);
  const before = (await file.exists()) ? await file.text() : "";
  const after = edit(before);
  if (after === before) return { ok: true };
  await Bun.write(path, after);
  return commitFile(home, ITEMS_FILE, message);
}

/**
 * Changes one item's priority, mute or note in `<home>/data/items.yaml` and commits it.
 * `canonical` maps a URL written in the file to the canonical one (see urlRecognizer).
 */
export function changeIntent(
  home: string, url: string, change: IntentChange, canonical: (url: string) => string, repo?: string,
): Promise<CommitResult> {
  return serialized(() => rewriteItems(home, (t) => editIntent(t, url, change, canonical), changeMessage(itemLabel(url, repo), change)));
}

/**
 * Adds an item by URL: one a configured instance recognizes is tracked (fetched on the next
 * poll), any other URL becomes a manual item with `title`. Refuses items already tracked.
 */
export function addItem(
  home: string, store: Store, intent: Intent, recognize: (url: string) => ItemRef | null, url: string, title?: string,
): Promise<{ url: string; manual: boolean; commit: CommitResult }> {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return Promise.reject(new Error(`not a web URL: ${url}`));
  const ref = recognize(url);
  const canonical = ref?.url ?? url;
  if (intent.has(canonical) || store.getItem(canonical)) return Promise.reject(new Error(`already tracked: ${canonical}`));
  const manual = !ref;
  const message = `watcher: add ${manual ? "manual item " : ""}${itemLabel(canonical)}`;
  return serialized(async () => ({
    url: canonical, manual,
    commit: await rewriteItems(home, (t) => addEntry(t, canonical, { manual, title: title?.trim() || undefined }), message),
  }));
}
