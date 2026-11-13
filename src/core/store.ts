// SQLite cache (var/cache.sqlite, git-ignored, rebuildable): items, events, poll runs, locks, retries.
// All timestamps are ISO-8601 UTC strings from Date.toISOString(), so they compare correctly as text.
import { Database } from "bun:sqlite";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import type { ActorRole, CiState, EventKind, ItemKind, ItemRef, ItemState, KnownItem, Verdict } from "./model.ts";

export interface ItemRow {
  url: string;
  id: string;
  instance: string;
  kind: ItemKind;
  repo: string;
  title: string;
  state: ItemState;
  stateDetail: string | null;
  ciState: CiState | null;
  hasConflicts: boolean;
  authoredByMe: boolean;
  maintainedByMe: boolean; // belongs to a repo I maintain: its PRs/patches are important by default
  labels: string[];
  lastSignalAt: string | null; // when we detected the latest signal (local clock)
  lastSignalSummary: string | null;
  seenAt: string | null;
  baselineAt: string; // first time we saw the item; history before it never counts as unread
  fetchedAt: string;
  snapshotJson: string | null;
  createdAt?: string | null; // the item's own dates (forge clock); null when unknown or not fetched since they were stored
  updatedAt?: string | null;
}

export interface EventRow {
  itemUrl: string;
  key: string;
  kind: EventKind;
  actor: string;
  actorRole: ActorRole;
  at: string; // when it happened (forge clock)
  detectedAt: string; // when we first stored it (local clock)
  // Only for forges with unreliable times (Radicle's author clocks, late gossip): `at` moved into
  // the window in which the event can have arrived, i.e. after the item's previous fetch (it was
  // not there then) and no later than `detectedAt`. Null when `at` is plausible. `at` is kept as
  // reported; displays and ordering use approxAt ?? at.
  approxAt?: string | null;
  excerpt: string | null;
  details: Record<string, unknown> | null;
  isSignal: boolean;
  reason: string;
  isBaseline: boolean; // history found on first sight of the item: never makes it unread
}

export interface PollRun {
  instance: string;
  startedAt: string;
  finishedAt: string;
  cursor: string | null;
  error: string | null;
  scope?: string | null; // the discovery settings the run used (see discoveryScope in poller.ts)
}

/** An item whose fetch failed; it is fetched again on the next runs even if discovery no longer reports it. */
export interface RetryRow {
  instance: string;
  itemUrl: string;
  kind: ItemKind;
  attempts: number;
  lastError: string;
  // Discovery cursor (`since`) of the run where the fetch first failed; null if that was the
  // instance's first run. A first sighting on retry is judged against it, not the current run's.
  firstSince: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  url TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, instance TEXT NOT NULL, kind TEXT NOT NULL,
  repo TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, state_detail TEXT, ci_state TEXT,
  has_conflicts INTEGER NOT NULL DEFAULT 0, authored_by_me INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '[]', last_signal_at TEXT, last_signal_summary TEXT,
  seen_at TEXT, baseline_at TEXT NOT NULL, fetched_at TEXT NOT NULL, snapshot_json TEXT
);
CREATE TABLE IF NOT EXISTS events (
  item_url TEXT NOT NULL, event_key TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  actor_role TEXT NOT NULL, at TEXT NOT NULL, detected_at TEXT NOT NULL, excerpt TEXT,
  details_json TEXT, is_signal INTEGER NOT NULL, reason TEXT NOT NULL,
  is_baseline INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_url, event_key)
);
CREATE TABLE IF NOT EXISTS poll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL, cursor TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retry (
  instance TEXT NOT NULL, item_url TEXT NOT NULL, kind TEXT NOT NULL, attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL, first_since TEXT, PRIMARY KEY (instance, item_url)
);
`;

/**
 * Where PIDs mean something: the PID namespace and boot, where Linux tells them (a container
 * may share the host's name but not its PIDs), else "" (e.g. FreeBSD, without procfs).
 */
function pidSpace(): string {
  try {
    const ns = readlinkSync("/proc/self/ns/pid");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${ns}/${boot}`;
  } catch {
    return "";
  }
}
const PID_SPACE = pidSpace();

/** Identifies a process (this one by default) as a lock holder: "pid@hostname[#pidspace]". */
export function lockHolder(pid: number = process.pid): string {
  return `${pid}@${hostname()}${PID_SPACE ? `#${PID_SPACE}` : ""}`;
}

/**
 * True when `holder` is a process of this host and PID space that has exited. Other hosts,
 * namespaces, boots and formats cannot be checked from here: false.
 */
function holderIsGone(holder: string): boolean {
  const m = holder.match(/^(\d+)@([^#]+)(?:#(.*))?$/);
  if (!m || m[2] !== hostname() || (m[3] ?? "") !== PID_SPACE) return false;
  try {
    process.kill(Number(m[1]), 0); // signal 0: only checks that the process exists
    return false;
  } catch (err) {
    // EPERM: it exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Short stable id for URLs in the HTTP API. */
export function itemId(url: string): string {
  return new Bun.CryptoHasher("sha1").update(url).digest("hex").slice(0, 10);
}

function toItem(r: any): ItemRow {
  return {
    url: r.url, id: r.id, instance: r.instance, kind: r.kind, repo: r.repo, title: r.title,
    state: r.state, stateDetail: r.state_detail, ciState: r.ci_state,
    hasConflicts: r.has_conflicts === 1, authoredByMe: r.authored_by_me === 1, maintainedByMe: r.maintained_by_me === 1,
    labels: JSON.parse(r.labels_json), lastSignalAt: r.last_signal_at,
    lastSignalSummary: r.last_signal_summary, seenAt: r.seen_at, baselineAt: r.baseline_at,
    fetchedAt: r.fetched_at, snapshotJson: r.snapshot_json, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function toEvent(r: any): EventRow {
  return {
    itemUrl: r.item_url, key: r.event_key, kind: r.kind, actor: r.actor, actorRole: r.actor_role,
    at: r.at, detectedAt: r.detected_at, excerpt: r.excerpt,
    details: r.details_json ? JSON.parse(r.details_json) : null,
    isSignal: r.is_signal === 1, reason: r.reason, isBaseline: r.is_baseline === 1, approxAt: r.approx_at,
  };
}

export class Store {
  readonly db: Database;

  /** `source` is a file path, or the bytes of a serialized database (an in-memory copy). */
  constructor(source: string | Uint8Array) {
    // strict: named parameters are bound without the "$" prefix and missing ones throw.
    this.db = typeof source === "string" ? new Database(source, { create: true, strict: true }) : Database.deserialize(source, { strict: true });
    if (typeof source === "string") this.db.exec("PRAGMA journal_mode = WAL;");
    // A poll and a CLI/web command may write at the same time: wait for the lock instead of failing.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Caches created before these columns existed.
    if (this.addColumnIfMissing("events", "is_baseline", "INTEGER NOT NULL DEFAULT 0")) {
      // Before the flag, baseline events were those stored when the item was first seen.
      this.db.exec(`UPDATE events SET is_baseline = 1
        WHERE detected_at <= (SELECT baseline_at FROM items WHERE items.url = events.item_url)`);
    }
    this.addColumnIfMissing("retry", "first_since", "TEXT");
    this.addColumnIfMissing("items", "maintained_by_me", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("poll_runs", "scope", "TEXT");
    this.addColumnIfMissing("items", "created_at", "TEXT");
    this.addColumnIfMissing("items", "updated_at", "TEXT");
    this.addColumnIfMissing("events", "approx_at", "TEXT");
  }

  /** Returns true if the column was missing and has been added. */
  private addColumnIfMissing(table: string, column: string, definition: string): boolean {
    const cols = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  getItem(url: string): ItemRow | null {
    const r = this.db.query("SELECT * FROM items WHERE url = $url").get({ url });
    return r ? toItem(r) : null;
  }

  listItems(): ItemRow[] {
    return this.db.query("SELECT * FROM items").all().map(toItem);
  }

  /**
   * Per item URL, when its latest event happened (forge clock, or its approximation), news or
   * not, and whether that time is an approximation; items without events are absent.
   */
  lastActivity(): Map<string, { at: string; approx: boolean }> {
    // SQLite takes the bare approx_at column from the row holding the MAX.
    const rows = this.db.query(`SELECT item_url, MAX(COALESCE(approx_at, at)) AS at, approx_at IS NOT NULL AS approx
      FROM events GROUP BY item_url`).all() as { item_url: string; at: string; approx: number }[];
    return new Map(rows.map((r) => [r.item_url, { at: r.at, approx: r.approx === 1 }]));
  }

  /** An instance's items that may still change: open ones, and any fetched since `fetchedSince`. */
  listKnown(instance: string, fetchedSince: string): KnownItem[] {
    return this.db.query(`SELECT url, instance, kind, state FROM items
      WHERE instance = $instance AND state != 'gone' AND (state = 'open' OR fetched_at >= $fetchedSince)
      ORDER BY url`).all({ instance, fetchedSince }) as KnownItem[];
  }

  upsertItem(i: ItemRow): void {
    this.db.query(`
      INSERT INTO items (url, id, instance, kind, repo, title, state, state_detail, ci_state,
        has_conflicts, authored_by_me, maintained_by_me, labels_json, last_signal_at, last_signal_summary, seen_at,
        baseline_at, fetched_at, snapshot_json, created_at, updated_at)
      VALUES ($url, $id, $instance, $kind, $repo, $title, $state, $stateDetail, $ciState,
        $hasConflicts, $authoredByMe, $maintainedByMe, $labels, $lastSignalAt, $lastSignalSummary, $seenAt,
        $baselineAt, $fetchedAt, $snapshotJson, $createdAt, $updatedAt)
      ON CONFLICT(url) DO UPDATE SET instance = excluded.instance, kind = excluded.kind,
        repo = excluded.repo, title = excluded.title, state = excluded.state,
        state_detail = excluded.state_detail, ci_state = excluded.ci_state,
        has_conflicts = excluded.has_conflicts, authored_by_me = excluded.authored_by_me,
        maintained_by_me = excluded.maintained_by_me,
        labels_json = excluded.labels_json, last_signal_at = excluded.last_signal_at,
        last_signal_summary = excluded.last_signal_summary, seen_at = excluded.seen_at,
        baseline_at = excluded.baseline_at, fetched_at = excluded.fetched_at,
        snapshot_json = excluded.snapshot_json, created_at = excluded.created_at, updated_at = excluded.updated_at`)
      .run({
        ...i,
        hasConflicts: i.hasConflicts ? 1 : 0,
        authoredByMe: i.authoredByMe ? 1 : 0,
        maintainedByMe: i.maintainedByMe ? 1 : 0,
        labels: JSON.stringify(i.labels),
        createdAt: i.createdAt ?? null,
        updatedAt: i.updatedAt ?? null,
      });
  }

  /** Returns false if the event was already stored (dedup by item + key). */
  insertEvent(e: EventRow): boolean {
    const res = this.db.query(`
      INSERT OR IGNORE INTO events (item_url, event_key, kind, actor, actor_role, at, detected_at,
        excerpt, details_json, is_signal, reason, is_baseline, approx_at)
      VALUES ($itemUrl, $key, $kind, $actor, $actorRole, $at, $detectedAt, $excerpt, $details,
        $isSignal, $reason, $isBaseline, $approxAt)`)
      .run({
        ...e,
        details: e.details ? JSON.stringify(e.details) : null,
        isSignal: e.isSignal ? 1 : 0,
        isBaseline: e.isBaseline ? 1 : 0,
        approxAt: e.approxAt ?? null,
      });
    return res.changes > 0;
  }

  /** Newest first. */
  eventsFor(itemUrl: string, includeNoise = false): EventRow[] {
    const where = includeNoise ? "" : "AND is_signal = 1";
    return this.db.query(`SELECT * FROM events WHERE item_url = $itemUrl ${where} ORDER BY COALESCE(approx_at, at) DESC`)
      .all({ itemUrl }).map(toEvent);
  }

  setVerdict(itemUrl: string, key: string, v: Verdict): void {
    this.db.query("UPDATE events SET is_signal = $isSignal, reason = $reason WHERE item_url = $itemUrl AND event_key = $key")
      .run({ itemUrl, key, isSignal: v.isSignal ? 1 : 0, reason: v.reason });
  }

  markSeen(url: string, at: string): boolean {
    return this.db.query("UPDATE items SET seen_at = $at WHERE url = $url").run({ url, at }).changes > 0;
  }

  markAllSeen(at: string): number {
    return this.db.query("UPDATE items SET seen_at = $at").run({ at }).changes;
  }

  /**
   * The cursor of the latest run (failed runs carry the previous cursor forward). With `scope`,
   * null when that run used other discovery settings: its cursor says nothing about these.
   * Runs recorded before scopes existed match any scope.
   */
  getCursor(instance: string, scope?: string): string | null {
    const r = this.db.query("SELECT cursor, scope FROM poll_runs WHERE instance = $instance ORDER BY id DESC LIMIT 1")
      .get({ instance }) as { cursor: string | null; scope: string | null } | null;
    if (scope !== undefined && r?.scope != null && r.scope !== scope) return null;
    return r?.cursor ?? null;
  }

  /** Per instance that ever ran: when its latest run finished, its error, and when it last succeeded. */
  lastRuns(): { instance: string; finishedAt: string; error: string | null; lastSuccessAt: string | null }[] {
    return this.db.query(`
      SELECT r.instance, r.finished_at AS finishedAt, r.error,
        (SELECT MAX(s.finished_at) FROM poll_runs s WHERE s.instance = r.instance AND s.error IS NULL) AS lastSuccessAt
      FROM poll_runs r WHERE r.id IN (SELECT MAX(id) FROM poll_runs GROUP BY instance)`).all() as {
      instance: string; finishedAt: string; error: string | null; lastSuccessAt: string | null;
    }[];
  }

  recordRun(r: PollRun): void {
    this.db.query(`INSERT INTO poll_runs (instance, started_at, finished_at, cursor, error, scope)
      VALUES ($instance, $startedAt, $finishedAt, $cursor, $error, $scope)`).run({ ...r, scope: r.scope ?? null });
  }

  listRetries(instance: string): RetryRow[] {
    // `any`: raw SQLite rows, mapped field by field below.
    const rows = this.db.query("SELECT * FROM retry WHERE instance = $instance ORDER BY item_url").all({ instance }) as any[];
    return rows.map((r) => ({
      instance: r.instance, itemUrl: r.item_url, kind: r.kind, attempts: r.attempts, lastError: r.last_error,
      firstSince: r.first_since,
    }));
  }

  /**
   * Records one more failed fetch of an item and returns its number of failed attempts so far.
   * `since` is the failing run's discovery cursor; only the first failure's is kept.
   */
  recordFailure(instance: string, ref: ItemRef, error: string, since: Date | null): number {
    const r = this.db.query(`
      INSERT INTO retry (instance, item_url, kind, attempts, last_error, first_since)
      VALUES ($instance, $url, $kind, 1, $error, $since)
      ON CONFLICT(instance, item_url) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error
      RETURNING attempts`)
      .get({ instance, url: ref.url, kind: ref.kind, error, since: since?.toISOString() ?? null }) as { attempts: number };
    return r.attempts;
  }

  clearRetry(instance: string, itemUrl: string): void {
    this.db.query("DELETE FROM retry WHERE instance = $instance AND item_url = $itemUrl").run({ instance, itemUrl });
  }

  /**
   * Takes the named lock for `holder` (see lockHolder()). A lock whose holder process no longer
   * exists on this host is taken over at once; one held from another host only once it is older
   * than staleMs (its process cannot be checked from here).
   */
  acquireLock(name: string, holder: string, now: Date, staleMs = 30 * 60_000): boolean {
    const current = this.db.query("SELECT holder FROM locks WHERE name = $name").get({ name }) as { holder: string } | null;
    // Only that holder's row: another poller may have taken the lock over a moment ago.
    if (current && holderIsGone(current.holder)) this.releaseLock(name, current.holder);
    const staleBefore = new Date(now.getTime() - staleMs).toISOString();
    this.db.query("DELETE FROM locks WHERE name = $name AND acquired_at < $staleBefore").run({ name, staleBefore });
    return this.db.query("INSERT OR IGNORE INTO locks (name, holder, acquired_at) VALUES ($name, $holder, $at)")
      .run({ name, holder, at: now.toISOString() }).changes > 0;
  }

  /** True when the named lock is held by a live (or unverifiable, not yet stale) holder. */
  lockHeld(name: string, now: Date, staleMs = 30 * 60_000): boolean {
    const r = this.db.query("SELECT holder, acquired_at FROM locks WHERE name = $name").get({ name }) as
      { holder: string; acquired_at: string } | null;
    if (!r || holderIsGone(r.holder)) return false;
    return r.acquired_at >= new Date(now.getTime() - staleMs).toISOString();
  }

  /** Releases the lock; with `holder`, only if that holder still has it. */
  releaseLock(name: string, holder?: string): void {
    if (holder !== undefined) {
      this.db.query("DELETE FROM locks WHERE name = $name AND holder = $holder").run({ name, holder });
      return;
    }
    this.db.query("DELETE FROM locks WHERE name = $name").run({ name });
  }

  /** A consistent in-memory copy of the whole cache: writes to it never touch the file, and there is nothing to clean up. */
  memoryCopy(): Store {
    const bytes = this.db.serialize();
    // The header of a WAL file says so (format versions, bytes 18-19), which an in-memory database cannot open for writing.
    bytes[18] = 1;
    bytes[19] = 1;
    return new Store(bytes);
  }

  close(): void {
    this.db.close();
  }
}
