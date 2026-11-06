// discover → fetch → diff → filter → store, per instance.
import type { Config, InstanceConfig } from "./config.ts";
import { classify } from "./filter.ts";
import { GoneError, RateLimitError } from "./http.ts";
import { effectivePriority, type Intent } from "./intent.ts";
import type { Adapter, ItemRef, NormalizedEvent, Snapshot } from "./model.ts";
import { itemId, lockHolder, type EventRow, type ItemRow, type Store } from "./store.ts";
import { summarize } from "./summary.ts";

/** Each run re-queries this much before the cursor, to tolerate clock skew; event keys dedup the overlap. */
export const CURSOR_OVERLAP_MS = 5 * 60_000;
const FETCH_CONCURRENCY = 4;
/** Closed items stay "known" to discovery for this long after their last fetch (late comments). */
const KNOWN_RECENT_MS = 30 * 24 * 60 * 60_000;
/**
 * An item whose fetch fails this many runs in a row is dropped from the retry table.
 * Its first_since goes with it, so if a never-stored item is rediscovered later, activity
 * older than that later run's cursor is baselined (accepted trade-off for giving up).
 */
const MAX_FETCH_ATTEMPTS = 5;

export interface PollContext {
  store: Store;
  config: Config;
  intent: Intent;
  adapterFor: (inst: InstanceConfig) => Adapter;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface InstanceResult {
  instance: string;
  ok: boolean;
  fetched: number;
  newSignals: number;
  error?: string;
}

export async function pollAll(ctx: PollContext, opts: { only?: string; dryRun?: boolean } = {}): Promise<InstanceResult[]> {
  const now = ctx.now ?? (() => new Date());
  const instances = ctx.config.instances.filter((i) => !opts.only || i.id === opts.only);
  if (opts.only && instances.length === 0) throw new Error(`unknown instance '${opts.only}'`);
  if (!ctx.store.acquireLock("poll", lockHolder(), now())) throw new Error("a poll is already running");
  if (opts.dryRun) ctx.store.begin(); // everything below is rolled back at the end
  try {
    const results: InstanceResult[] = [];
    for (const inst of instances) results.push(await pollInstance(inst, ctx));
    return results;
  } finally {
    if (opts.dryRun) ctx.store.rollback();
    ctx.store.releaseLock("poll", lockHolder()); // not a lock taken over after ours went stale
  }
}

export async function pollInstance(inst: InstanceConfig, ctx: PollContext): Promise<InstanceResult> {
  const now = ctx.now ?? (() => new Date());
  const log = ctx.log ?? (() => {});
  const startedAt = now();
  const result: InstanceResult = { instance: inst.id, ok: false, fetched: 0, newSignals: 0 };
  const scope = discoveryScope(inst);
  const cursor = ctx.store.getCursor(inst.id, scope);
  if (!cursor && ctx.store.getCursor(inst.id)) {
    // E.g. the user name was wrong: the old cursor would only look at what changed since, and
    // never find the older items of the new settings.
    log(`${inst.id}: discovery settings changed since the last poll: starting over as a first run`);
  }
  let error: string | null = null;
  // Stays false if discovery fails or a rate limit stops the run: the next run then
  // re-queries from the same cursor.
  let advanceCursor = false;
  try {
    if (inst.disabledReason) throw new Error(inst.disabledReason);
    const adapter = ctx.adapterFor(inst);
    const since = cursor ? new Date(new Date(cursor).getTime() - CURSOR_OVERLAP_MS) : null;
    const refs = new Map<string, ItemRef>();
    const known = ctx.store.listKnown(inst.id, new Date(startedAt.getTime() - KNOWN_RECENT_MS).toISOString());
    for (const r of await adapter.discover(since, known)) refs.set(r.url, r);
    // Items listed in items.yaml that the cache has never seen (e.g. added by hand).
    for (const entry of ctx.intent.values()) {
      if (entry.manual || ctx.store.getItem(entry.url)) continue;
      const r = adapter.refFromUrl(entry.url);
      if (r) refs.set(r.url, r);
    }
    // Items whose fetch failed on earlier runs, even if discovery no longer reports them.
    // If one turns out to be a first sighting, its events are judged against the `since` of
    // the run where it first failed, so activity in between is not swallowed as baseline.
    const retrySince = new Map<string, Date | null>();
    for (const r of ctx.store.listRetries(inst.id)) {
      if (!refs.has(r.itemUrl)) refs.set(r.itemUrl, { url: r.itemUrl, instance: inst.id, kind: r.kind });
      retrySince.set(r.itemUrl, r.firstSince ? new Date(r.firstSince) : null);
    }
    const failures: string[] = [];
    await forEachLimit([...refs.values()], FETCH_CONCURRENCY, async (ref) => {
      const itemSince = retrySince.has(ref.url) ? (retrySince.get(ref.url) ?? null) : since;
      try {
        const snap = await adapter.fetch(ref);
        result.fetched++;
        result.newSignals += applySnapshot(snap, ctx, now(), itemSince, log);
        ctx.store.clearRetry(inst.id, ref.url);
      } catch (err) {
        if (err instanceof GoneError) {
          result.newSignals += markGone(ref, ctx, now(), log);
          ctx.store.clearRetry(inst.id, ref.url);
          return;
        }
        if (err instanceof RateLimitError) throw err; // stop the whole instance
        const message = (err as Error).message;
        failures.push(`${ref.url}: ${message}`);
        if (ctx.store.recordFailure(inst.id, ref, message, itemSince) >= MAX_FETCH_ATTEMPTS) {
          ctx.store.clearRetry(inst.id, ref.url);
          log(`  giving up on ${ref.url} after ${MAX_FETCH_ATTEMPTS} failed attempts: ${message}`);
        }
      }
    });
    // Discovery worked, so the cursor can advance: failed items are in the retry table.
    advanceCursor = true;
    if (failures.length) error = `${failures.length} item(s) failed; first: ${failures[0]}`;
  } catch (err) {
    error = (err as Error).message;
  }
  result.ok = error === null;
  if (error) result.error = error;
  ctx.store.recordRun({
    instance: inst.id,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    cursor: advanceCursor ? startedAt.toISOString() : cursor,
    error,
    scope,
  });
  return result;
}

/** The settings that decide what discovery finds (not the token): a cursor is only valid for them. */
export function discoveryScope(inst: InstanceConfig): string {
  return JSON.stringify({ type: inst.type, url: inst.url, users: inst.users ?? [inst.user], repos: inst.repos ?? null });
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. The first thrown error stops new
 * work and is rethrown, but only once the calls already in flight have finished, so none
 * of them writes after the caller has moved on (recorded the run, rolled back a dry run…).
 */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async () => {
    while (errors.length === 0 && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        errors.push(err);
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length > 0) throw errors[0];
}

/** Synthesizes events the forge does not report as such: CI result changes and new merge conflicts. */
function derivedEvents(prev: ItemRow | null, ci: ItemRow["ciState"], conflicts: boolean, now: Date): NormalizedEvent[] {
  if (!prev) return [];
  const out: NormalizedEvent[] = [];
  const stamp = now.toISOString();
  // A first green result is not news; a first red one, or any change of a settled result, is.
  if (ci && ci !== prev.ciState && !(prev.ciState === null && ci === "success")) {
    out.push({ key: `ci:${stamp}`, kind: "ci", actor: "", actorRole: "unknown", at: now, details: { from: prev.ciState, to: ci } });
  }
  if (conflicts && !prev.hasConflicts) {
    out.push({ key: `conflict:${stamp}`, kind: "conflict", actor: "", actorRole: "unknown", at: now });
  }
  return out;
}

/**
 * Stores a fetched snapshot and returns how many new signal events it brought.
 * `since` is the discovery cursor of this run (null on the instance's first run).
 * On first sight of an item, its history is recorded as baseline (never unread): all of it
 * on the first run, only events older than `since` on later runs, so an item that is new
 * since the last poll still reports what happened to it since then.
 */
export function applySnapshot(
  snap: Snapshot, ctx: PollContext, now: Date, since: Date | null, log: (line: string) => void = () => {},
): number {
  const { store, config, intent } = ctx;
  const url = snap.ref.url;
  const prev = store.getItem(url);
  const nowIso = now.toISOString();
  const maintainedByMe = snap.maintainedByMe ?? false;
  const priority = effectivePriority(intent.get(url), snap.ref.kind, snap.authoredByMe, maintainedByMe);
  // CI: remember the last settled result; "pending" and no result at all (e.g. no check
  // runs yet right after a push) do not overwrite it.
  const ci = snap.ciState === "success" || snap.ciState === "failure" ? snap.ciState : (prev?.ciState ?? null);
  // Conflicts: unknown (null/undefined) keeps the previous value.
  const conflicts = snap.hasConflicts ?? prev?.hasConflicts ?? false;

  // Unreliable times (author clocks, late gossip): a new event cannot have happened before the
  // previous fetch, which did not see it, nor after now. On first sight there is no lower bound.
  const unreliable = snap.timesUnreliable === true;
  const approximate = (at: Date): string | null => {
    if (!unreliable) return null;
    if (at > now) return nowIso;
    if (prev && at.toISOString() < prev.fetchedAt) return prev.fetchedAt;
    return null;
  };
  const timeOf = (row: EventRow) => row.approxAt ?? row.at;

  let latestSignal: EventRow | null = null;
  let latestOwnAt: string | null = null;
  let newSignals = 0;
  for (const ev of [...snap.events, ...derivedEvents(prev, ci, conflicts, now)]) {
    const verdict = classify(ev, priority, config.filter);
    const row: EventRow = {
      itemUrl: url, key: ev.key, kind: ev.kind, actor: ev.actor, actorRole: ev.actorRole,
      at: ev.at.toISOString(), detectedAt: nowIso, excerpt: ev.body ? ev.body.slice(0, 500) : null,
      details: ev.details ?? null, isSignal: verdict.isSignal, reason: verdict.reason,
      // With unreliable timestamps, an item first seen after the first run is news as a whole.
      isBaseline: !prev && (since === null || (!unreliable && ev.at < since)),
      approxAt: approximate(ev.at),
    };
    if (!store.insertEvent(row) || row.isBaseline) continue; // already known, or baseline
    if (ev.actorRole === "me") {
      if (!latestOwnAt || timeOf(row) > latestOwnAt) latestOwnAt = timeOf(row);
      continue;
    }
    if (!verdict.isSignal) continue;
    newSignals++;
    log(`  ${snap.repo}: ${snap.title} — ${summarize(row)}`);
    if (!latestSignal || timeOf(row) >= timeOf(latestSignal)) latestSignal = row;
  }

  let lastSignalAt = prev?.lastSignalAt ?? null;
  let lastSignalSummary = prev?.lastSignalSummary ?? null;
  let seenAt = prev?.seenAt ?? null;
  if (latestSignal) {
    lastSignalAt = nowIso;
    lastSignalSummary = summarize(latestSignal);
  }
  // My own activity after the latest signal means I have already looked at it.
  if (latestOwnAt && (!latestSignal || timeOf(latestSignal) <= latestOwnAt)) seenAt = nowIso;

  // With unreliable times: the creation date is kept from the first fetch that had one, capped
  // at that moment (the item may well predate the previous fetch, so no lower bound); the update
  // date is left to the events, whose approximations the list shows as such.
  const created = snap.createdAt?.toISOString() ?? null;
  const createdAt = !unreliable ? created : (prev?.createdAt ?? (created && created > nowIso ? nowIso : created));
  const updatedAt = unreliable ? null : (snap.updatedAt?.toISOString() ?? null);

  const { events: _events, ...meta } = snap;
  store.upsertItem({
    url, id: itemId(url), instance: snap.ref.instance, kind: snap.ref.kind, repo: snap.repo,
    title: snap.title, state: snap.state, stateDetail: snap.stateDetail ?? null, ciState: ci,
    hasConflicts: conflicts, authoredByMe: snap.authoredByMe, maintainedByMe, labels: snap.labels,
    lastSignalAt, lastSignalSummary, seenAt, baselineAt: prev?.baselineAt ?? nowIso,
    fetchedAt: nowIso, snapshotJson: JSON.stringify(meta),
    createdAt, updatedAt,
  });
  return newSignals;
}

function markGone(ref: ItemRef, ctx: PollContext, now: Date, log: (line: string) => void): number {
  const prev = ctx.store.getItem(ref.url);
  if (!prev || prev.state === "gone") return 0;
  const nowIso = now.toISOString();
  const row: EventRow = {
    itemUrl: ref.url, key: `gone:${nowIso}`, kind: "state", actor: "", actorRole: "unknown",
    at: nowIso, detectedAt: nowIso, excerpt: null, details: { to: "gone" },
    isSignal: true, reason: "signal:state", isBaseline: false,
  };
  ctx.store.insertEvent(row);
  ctx.store.upsertItem({ ...prev, state: "gone", lastSignalAt: nowIso, lastSignalSummary: summarize(row), fetchedAt: nowIso });
  log(`  ${prev.repo}: ${prev.title} — ${summarize(row)}`);
  return 1;
}

/** Re-runs the filter over all stored events (after tuning config) and recomputes each item's latest signal. */
export function refilter(store: Store, config: Config, intent: Intent): { changed: number } {
  let changed = 0;
  for (const item of store.listItems()) {
    const priority = effectivePriority(intent.get(item.url), item.kind, item.authoredByMe, item.maintainedByMe);
    for (const e of store.eventsFor(item.url, true)) {
      const v = classify(
        { key: e.key, kind: e.kind, actor: e.actor, actorRole: e.actorRole, at: new Date(e.at),
          body: e.excerpt ?? undefined, details: e.details ?? undefined },
        priority, config.filter);
      if (v.isSignal !== e.isSignal || v.reason !== e.reason) {
        store.setVerdict(item.url, e.key, v);
        changed++;
      }
    }
    const latest = store.eventsFor(item.url)
      .filter((e) => !e.isBaseline)
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt) || b.at.localeCompare(a.at))[0];
    store.upsertItem({
      ...item,
      lastSignalAt: latest?.detectedAt ?? null,
      lastSignalSummary: latest ? summarize(latest) : null,
    });
  }
  return { changed };
}
