// Query/command API shared by every front end (CLI, HTTP server; an MCP server later).
// Front ends never touch the Store or items.yaml directly.
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { addEntry, commitFile, committedContent, editIntent, effectivePriority, type CommitResult, type Intent, type IntentChange } from "./intent.ts";
import type { ActorRole, CiState, EventKind, ItemKind, ItemRef, ItemState, Priority } from "./model.ts";
import { holderIsGone, itemId, lockHolder, type EventRow, type Store } from "./store.ts";
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
  defaultPriority: Priority; // what `priority` is without an explicit setting in items.yaml
  muted: boolean;
  note: string | null;
  unread: boolean;
  lastSignalAt: string | null;
  lastSignalSummary: string | null;
  // The item's own dates (forge clock). updatedAt falls back to its latest event, news or not, for
  // items not fetched since these dates were stored. Shown when there is no news.
  createdAt: string | null;
  updatedAt: string | null;
  updatedApprox: boolean; // updatedAt is an approximation of an unreliable time (Radicle)
}

export interface ListOptions {
  unreadOnly?: boolean;
  includeMuted?: boolean;
  importantOnly?: boolean;
  instance?: string;
}

/** Important first, then most recent first (latest news, else last update); items without either last. */
export function listItems(store: Store, intent: Intent, opts: ListOptions = {}): ItemView[] {
  const activity = store.lastActivity();
  const views: ItemView[] = store.listItems().map((i) => {
    const entry = intent.get(i.url);
    return {
      id: i.id, url: i.url, instance: i.instance, kind: i.kind, repo: i.repo, title: i.title,
      state: i.stateDetail ? `${i.state} (${i.stateDetail})` : i.state, itemState: i.state, stateDetail: i.stateDetail,
      ciState: i.ciState, hasConflicts: i.hasConflicts, labels: i.labels,
      priority: effectivePriority(entry, i.kind, i.authoredByMe, i.maintainedByMe),
      defaultPriority: effectivePriority(undefined, i.kind, i.authoredByMe, i.maintainedByMe),
      muted: entry?.muted ?? false, note: entry?.note ?? null,
      unread: i.lastSignalAt !== null && (i.seenAt === null || i.lastSignalAt > i.seenAt),
      lastSignalAt: i.lastSignalAt, lastSignalSummary: i.lastSignalSummary,
      createdAt: i.createdAt ?? null, updatedAt: i.updatedAt ?? activity.get(i.url)?.at ?? null,
      updatedApprox: !i.updatedAt && (activity.get(i.url)?.approx ?? false),
    };
  });
  for (const entry of intent.values()) {
    if (!entry.manual) continue;
    views.push({
      id: itemId(entry.url), url: entry.url, instance: null, kind: "manual", repo: new URL(entry.url).host,
      title: entry.title ?? entry.url, state: "manual", itemState: "manual", stateDetail: null, ciState: null,
      hasConflicts: false, labels: [], priority: entry.priority ?? "normal", defaultPriority: "normal",
      muted: entry.muted, note: entry.note ?? null, unread: false, lastSignalAt: null, lastSignalSummary: null,
      createdAt: null, updatedAt: null, updatedApprox: false,
    });
  }
  return views
    .filter((v) => (opts.includeMuted || !v.muted) && (!opts.unreadOnly || v.unread))
    .filter((v) => (!opts.importantOnly || v.priority === "important") && (!opts.instance || v.instance === opts.instance))
    .sort((a, b) =>
      (a.priority === b.priority ? 0 : a.priority === "important" ? -1 : 1) ||
      (b.lastSignalAt ?? b.updatedAt ?? "").localeCompare(a.lastSignalAt ?? a.updatedAt ?? "") ||
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
  at: string; // when it happened: as reported, or its approximation (see reportedAt)
  reportedAt: string | null; // the reported time, when `at` is an approximation of it
  detectedAt: string;
  summary: string;
  details: Record<string, unknown> | null;
  excerpt: string | null;
  isSignal: boolean;
  reason: string;
  isBaseline: boolean;
}

function eventView(e: EventRow): EventView {
  return {
    key: e.key, kind: e.kind, actor: e.actor, actorRole: e.actorRole,
    at: e.approxAt ?? e.at, reportedAt: e.approxAt ? e.at : null, detectedAt: e.detectedAt,
    summary: summarize(e), details: e.details, excerpt: e.excerpt, isSignal: e.isSignal, reason: e.reason, isBaseline: e.isBaseline,
  };
}

/** An item's events, newest first: signal only, or noise too (with the filter's reason). */
export function itemEvents(store: Store, url: string, includeNoise: boolean): EventView[] {
  return store.eventsFor(url, includeNoise).map(eventView);
}

export interface ItemUpdates {
  item: ItemView;
  events: EventView[]; // newest detection first
}

/**
 * The news the watcher detected after `since`, grouped by item, the item with the latest detection
 * first; muted items are left out. By detection time rather than the event's own, so changes that
 * reach the watcher late (Radicle) are not missed.
 */
export function updates(store: Store, intent: Intent, since: Date): ItemUpdates[] {
  const items = new Map(listItems(store, intent).map((v) => [v.url, v]));
  const groups = new Map<string, ItemUpdates>();
  for (const e of store.signalEventsDetectedAfter(since.toISOString())) {
    const item = items.get(e.itemUrl);
    if (!item) continue; // muted (or no longer listed)
    let group = groups.get(item.url);
    if (!group) groups.set(item.url, (group = { item, events: [] }));
    group.events.push(eventView(e));
  }
  return [...groups.values()]; // the store's order puts the item with the latest detection first
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

/** The change a front end asks for ({priority, muted, note}), checked; throws an Error saying what is wrong. */
export function parseIntentChange(b: Record<string, unknown>): IntentChange {
  const change: IntentChange = {};
  for (const key of Object.keys(b)) {
    if (!["priority", "muted", "note"].includes(key)) throw new Error(`unknown field '${key}'`);
  }
  if ("priority" in b) {
    if (b.priority !== null && b.priority !== "important" && b.priority !== "normal") {
      throw new Error("priority must be 'important', 'normal' or null");
    }
    change.priority = b.priority as Priority | null;
  }
  if ("muted" in b) {
    if (typeof b.muted !== "boolean") throw new Error("muted must be true or false");
    change.muted = b.muted;
  }
  if ("note" in b) {
    if (b.note !== null && typeof b.note !== "string") throw new Error("note must be text or null");
    change.note = b.note as string | null;
  }
  if (Object.keys(change).length === 0) throw new Error("nothing to change");
  return change;
}

/** Where intent changes go: the watcher's home (a git working copy) and the branch to commit to. */
export interface IntentRepo {
  home: string;
  branch: string; // Config.commitBranch
}

/**
 * Runs `fn` holding `<home>/var/items.lock`, so that two processes (the web server, `watcher mcp`)
 * never edit items.yaml at once: each would read the file before the other's change and lose it.
 * The file holds its owner's token and is created complete (linked into place). While `fn` runs its
 * owner refreshes the file's mtime; a lock not refreshed for a minute, or left by a process that has
 * exited, is a crashed process's and is taken over, by one waiting process at a time. The lock is
 * released only while it still holds our token.
 */
/** How long a writer waits for the lock, how long a lock may go unrefreshed, how often its holder refreshes it (ms). Tests shorten them. */
export interface LockTiming {
  waitMs: number;
  staleMs: number;
  beatMs: number;
}
const LOCK_TIMING: LockTiming = { waitMs: 30_000, staleMs: 60_000, beatMs: 10_000 };

export async function withItemsLock<T>(home: string, fn: () => Promise<T>, timing: Partial<LockTiming> = {}): Promise<T> {
  const { waitMs, staleMs, beatMs } = { ...LOCK_TIMING, ...timing };
  const lock = join(home, "var/items.lock");
  mkdirSync(dirname(lock), { recursive: true });
  const token = `${lockHolder()} ${randomUUID()}`;
  const mine = `${lock}.${token.split(" ")[1]}`;
  writeFileSync(mine, token);
  try {
    for (const deadline = Date.now() + waitMs; ; await Bun.sleep(25)) {
      try {
        linkSync(mine, lock); // fails when the lock exists
        touch(lock); // its age counts from now, not from when we began to wait
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        breakIfStale(lock, mine, staleMs);
        if (Date.now() > deadline) throw new Error(`items.yaml is locked by another process (${lock})`);
      }
    }
  } finally {
    drop(mine);
  }
  const beat = setInterval(() => {
    if (readOrNull(lock) !== token) return; // taken over: not ours to refresh
    try {
      touch(lock);
    } catch {} // released meanwhile
  }, beatMs);
  try {
    dropLeftovers(lock, mine, staleMs);
    return await fn();
  } finally {
    clearInterval(beat);
    if (readOrNull(lock) === token) drop(lock); // else taken over as stale
  }
}

/** A process killed before it dropped its `<lock>.<token>` file leaves it behind: those of exited processes go. */
function dropLeftovers(lock: string, mine: string, staleMs: number): void {
  const start = `${basename(lock)}.`;
  for (const name of readdirSync(dirname(lock))) {
    const path = join(dirname(lock), name);
    if (!name.startsWith(start) || !/^[0-9a-f-]{36}$/.test(name.slice(start.length)) || path === mine) continue;
    try {
      if (isStale(path, staleMs)) unlinkSync(path);
    } catch {} // gone meanwhile
  }
}

function touch(path: string): void {
  const now = new Date();
  utimesSync(path, now, now);
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null; // released meanwhile
  }
}

function drop(path: string): void {
  try {
    unlinkSync(path);
  } catch {} // already gone
}

/** Not refreshed for `staleMs`, or held by a process of this host that has exited (its token starts with its pid). */
function isStale(path: string, staleMs: number): boolean {
  const fd = openSync(path, "r"); // one file for both the age and the token
  try {
    return Date.now() - fstatSync(fd).mtimeMs > staleMs || holderIsGone(readFileSync(fd, "utf8").split(" ")[0]!);
  } finally {
    closeSync(fd);
  }
}

/**
 * Removes `lock` when it is stale. Whoever links `<lock>.break` is the one to look at the lock and
 * remove it, so two waiting processes can never both remove it, the second one taking the first
 * one's new lock. A `.break` is as stale as a lock: older than a minute, or its process has exited.
 */
function breakIfStale(lock: string, mine: string, staleMs: number): void {
  const claim = `${lock}.break`;
  try {
    linkSync(mine, claim);
  } catch {
    try {
      if (isStale(claim, staleMs)) unlinkSync(claim);
    } catch {} // released meanwhile
    return;
  }
  try {
    if (isStale(lock, staleMs)) unlinkSync(lock);
  } catch {} // released meanwhile
  drop(claim);
}

async function rewriteItems(where: IntentRepo, edit: (text: string) => string, message: string): Promise<CommitResult> {
  return withItemsLock(where.home, () => rewriteLocked(where, edit, message));
}

async function rewriteLocked(where: IntentRepo, edit: (text: string) => string, message: string): Promise<CommitResult> {
  const path = join(where.home, ITEMS_FILE);
  const file = Bun.file(path);
  const before = (await file.exists()) ? await file.text() : "";
  const after = edit(before);
  if (after === before) return { ok: true };
  // Hand edits not committed yet go into this commit too: say so rather than hide them.
  // A branch that does not exist yet will start from the current commit.
  const committed = (await committedContent(where.home, where.branch, ITEMS_FILE)) ?? (await committedContent(where.home, "HEAD", ITEMS_FILE));
  const dirty = before !== "" && committed !== null && committed !== before;
  await Bun.write(path, after);
  const note = `\n\nAlso commits earlier changes to ${ITEMS_FILE} that were not committed yet.`;
  return commitFile(where.home, ITEMS_FILE, dirty ? message + note : message, where.branch);
}

/**
 * Changes one item's priority, mute or note in `<home>/data/items.yaml` and commits it.
 * `canonical` maps a URL written in the file to the canonical one (see urlRecognizer);
 * `repoName` makes the commit message read better.
 */
export function changeIntent(
  where: IntentRepo, url: string, change: IntentChange, canonical: (url: string) => string, repoName?: string,
): Promise<CommitResult> {
  return serialized(() => rewriteItems(where, (t) => editIntent(t, url, change, canonical), changeMessage(itemLabel(url, repoName), change)));
}

/**
 * Adds an item by URL: one a configured instance recognizes is tracked (fetched on the next
 * poll), any other URL becomes a manual item with `title`. Refuses items already tracked.
 */
export function addItem(
  where: IntentRepo, store: Store, intent: Intent, recognize: (url: string) => ItemRef | null, url: string, title?: string,
): Promise<{ url: string; manual: boolean; commit: CommitResult }> {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return Promise.reject(new Error(`not a web URL: ${url}`));
  const ref = recognize(url);
  const canonical = ref?.url ?? url;
  if (intent.has(canonical) || store.getItem(canonical)) return Promise.reject(new Error(`already tracked: ${canonical}`));
  const manual = !ref;
  const message = `watcher: add ${manual ? "manual item " : ""}${itemLabel(canonical)}`;
  return serialized(async () => ({
    url: canonical, manual,
    commit: await rewriteItems(where, (t) => addEntry(t, canonical, { manual, title: title?.trim() || undefined }), message),
  }));
}
