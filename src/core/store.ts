// SQLite cache (var/cache.sqlite, git-ignored, rebuildable): items, events, poll runs, locks, retries.
// All timestamps are ISO-8601 UTC strings from Date.toISOString(), so they compare correctly as text.
import { Database } from "bun:sqlite";
import type { ActorRole, CiState, EventKind, ItemKind, ItemRef, ItemState, Verdict } from "./model.ts";

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
  labels: string[];
  lastSignalAt: string | null; // when we detected the latest signal (local clock)
  lastSignalSummary: string | null;
  seenAt: string | null;
  baselineAt: string; // first time we saw the item; history before it never counts as unread
  fetchedAt: string;
  snapshotJson: string | null;
}

export interface EventRow {
  itemUrl: string;
  key: string;
  kind: EventKind;
  actor: string;
  actorRole: ActorRole;
  at: string; // when it happened (forge clock)
  detectedAt: string; // when we first stored it (local clock)
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
}

/** An item whose fetch failed; it is fetched again on the next runs even if discovery no longer reports it. */
export interface RetryRow {
  instance: string;
  itemUrl: string;
  kind: ItemKind;
  attempts: number;
  lastError: string;
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
  last_error TEXT NOT NULL, PRIMARY KEY (instance, item_url)
);
`;

/** Short stable id for URLs in the HTTP API. */
export function itemId(url: string): string {
  return new Bun.CryptoHasher("sha1").update(url).digest("hex").slice(0, 10);
}

function toItem(r: any): ItemRow {
  return {
    url: r.url, id: r.id, instance: r.instance, kind: r.kind, repo: r.repo, title: r.title,
    state: r.state, stateDetail: r.state_detail, ciState: r.ci_state,
    hasConflicts: r.has_conflicts === 1, authoredByMe: r.authored_by_me === 1,
    labels: JSON.parse(r.labels_json), lastSignalAt: r.last_signal_at,
    lastSignalSummary: r.last_signal_summary, seenAt: r.seen_at, baselineAt: r.baseline_at,
    fetchedAt: r.fetched_at, snapshotJson: r.snapshot_json,
  };
}

function toEvent(r: any): EventRow {
  return {
    itemUrl: r.item_url, key: r.event_key, kind: r.kind, actor: r.actor, actorRole: r.actor_role,
    at: r.at, detectedAt: r.detected_at, excerpt: r.excerpt,
    details: r.details_json ? JSON.parse(r.details_json) : null,
    isSignal: r.is_signal === 1, reason: r.reason, isBaseline: r.is_baseline === 1,
  };
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    // strict: named parameters are bound without the "$" prefix and missing ones throw.
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // Caches created before events.is_baseline existed.
    const cols = this.db.query("PRAGMA table_info(events)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "is_baseline")) {
      this.db.exec("ALTER TABLE events ADD COLUMN is_baseline INTEGER NOT NULL DEFAULT 0");
    }
  }

  getItem(url: string): ItemRow | null {
    const r = this.db.query("SELECT * FROM items WHERE url = $url").get({ url });
    return r ? toItem(r) : null;
  }

  listItems(): ItemRow[] {
    return this.db.query("SELECT * FROM items").all().map(toItem);
  }

  upsertItem(i: ItemRow): void {
    this.db.query(`
      INSERT INTO items (url, id, instance, kind, repo, title, state, state_detail, ci_state,
        has_conflicts, authored_by_me, labels_json, last_signal_at, last_signal_summary, seen_at,
        baseline_at, fetched_at, snapshot_json)
      VALUES ($url, $id, $instance, $kind, $repo, $title, $state, $stateDetail, $ciState,
        $hasConflicts, $authoredByMe, $labels, $lastSignalAt, $lastSignalSummary, $seenAt,
        $baselineAt, $fetchedAt, $snapshotJson)
      ON CONFLICT(url) DO UPDATE SET instance = excluded.instance, kind = excluded.kind,
        repo = excluded.repo, title = excluded.title, state = excluded.state,
        state_detail = excluded.state_detail, ci_state = excluded.ci_state,
        has_conflicts = excluded.has_conflicts, authored_by_me = excluded.authored_by_me,
        labels_json = excluded.labels_json, last_signal_at = excluded.last_signal_at,
        last_signal_summary = excluded.last_signal_summary, seen_at = excluded.seen_at,
        baseline_at = excluded.baseline_at, fetched_at = excluded.fetched_at,
        snapshot_json = excluded.snapshot_json`)
      .run({
        ...i,
        hasConflicts: i.hasConflicts ? 1 : 0,
        authoredByMe: i.authoredByMe ? 1 : 0,
        labels: JSON.stringify(i.labels),
      });
  }

  /** Returns false if the event was already stored (dedup by item + key). */
  insertEvent(e: EventRow): boolean {
    const res = this.db.query(`
      INSERT OR IGNORE INTO events (item_url, event_key, kind, actor, actor_role, at, detected_at,
        excerpt, details_json, is_signal, reason, is_baseline)
      VALUES ($itemUrl, $key, $kind, $actor, $actorRole, $at, $detectedAt, $excerpt, $details,
        $isSignal, $reason, $isBaseline)`)
      .run({
        ...e,
        details: e.details ? JSON.stringify(e.details) : null,
        isSignal: e.isSignal ? 1 : 0,
        isBaseline: e.isBaseline ? 1 : 0,
      });
    return res.changes > 0;
  }

  /** Newest first. */
  eventsFor(itemUrl: string, includeNoise = false): EventRow[] {
    const where = includeNoise ? "" : "AND is_signal = 1";
    return this.db.query(`SELECT * FROM events WHERE item_url = $itemUrl ${where} ORDER BY at DESC`)
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

  /** The cursor of the latest run (failed runs carry the previous cursor forward). */
  getCursor(instance: string): string | null {
    const r = this.db.query("SELECT cursor FROM poll_runs WHERE instance = $instance ORDER BY id DESC LIMIT 1")
      .get({ instance }) as { cursor: string | null } | null;
    return r?.cursor ?? null;
  }

  recordRun(r: PollRun): void {
    this.db.query(`INSERT INTO poll_runs (instance, started_at, finished_at, cursor, error)
      VALUES ($instance, $startedAt, $finishedAt, $cursor, $error)`).run({ ...r });
  }

  listRetries(instance: string): RetryRow[] {
    // `any`: raw SQLite rows, mapped field by field below.
    const rows = this.db.query("SELECT * FROM retry WHERE instance = $instance ORDER BY item_url").all({ instance }) as any[];
    return rows.map((r) => ({ instance: r.instance, itemUrl: r.item_url, kind: r.kind, attempts: r.attempts, lastError: r.last_error }));
  }

  /** Records one more failed fetch of an item and returns its number of failed attempts so far. */
  recordFailure(instance: string, ref: ItemRef, error: string): number {
    const r = this.db.query(`
      INSERT INTO retry (instance, item_url, kind, attempts, last_error) VALUES ($instance, $url, $kind, 1, $error)
      ON CONFLICT(instance, item_url) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error
      RETURNING attempts`).get({ instance, url: ref.url, kind: ref.kind, error }) as { attempts: number };
    return r.attempts;
  }

  clearRetry(instance: string, itemUrl: string): void {
    this.db.query("DELETE FROM retry WHERE instance = $instance AND item_url = $itemUrl").run({ instance, itemUrl });
  }

  /** Locks older than staleMs are assumed to belong to a crashed process and are taken over. */
  acquireLock(name: string, holder: string, now: Date, staleMs = 30 * 60_000): boolean {
    const staleBefore = new Date(now.getTime() - staleMs).toISOString();
    this.db.query("DELETE FROM locks WHERE name = $name AND acquired_at < $staleBefore").run({ name, staleBefore });
    return this.db.query("INSERT OR IGNORE INTO locks (name, holder, acquired_at) VALUES ($name, $holder, $at)")
      .run({ name, holder, at: now.toISOString() }).changes > 0;
  }

  releaseLock(name: string): void {
    this.db.query("DELETE FROM locks WHERE name = $name").run({ name });
  }

  begin(): void {
    this.db.exec("BEGIN");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  close(): void {
    this.db.close();
  }
}
