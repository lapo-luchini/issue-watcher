// discover → fetch → diff → filter → store, per instance.
import type { Config, InstanceConfig } from "./config.ts";
import { classify } from "./filter.ts";
import { GoneError, RateLimitError } from "./http.ts";
import { effectivePriority, type Intent } from "./intent.ts";
import type { Adapter, ItemRef, NormalizedEvent, Snapshot } from "./model.ts";
import { itemId, type EventRow, type ItemRow, type Store } from "./store.ts";
import { summarize } from "./summary.ts";

/** Each run re-queries this much before the cursor, to tolerate clock skew; event keys dedup the overlap. */
export const CURSOR_OVERLAP_MS = 5 * 60_000;
const FETCH_CONCURRENCY = 4;

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
  if (!ctx.store.acquireLock("poll", `pid:${process.pid}`, now())) throw new Error("a poll is already running");
  if (opts.dryRun) ctx.store.begin(); // everything below is rolled back at the end
  try {
    const results: InstanceResult[] = [];
    for (const inst of instances) results.push(await pollInstance(inst, ctx));
    return results;
  } finally {
    if (opts.dryRun) ctx.store.rollback();
    ctx.store.releaseLock("poll");
  }
}

export async function pollInstance(inst: InstanceConfig, ctx: PollContext): Promise<InstanceResult> {
  const now = ctx.now ?? (() => new Date());
  const log = ctx.log ?? (() => {});
  const startedAt = now();
  const result: InstanceResult = { instance: inst.id, ok: false, fetched: 0, newSignals: 0 };
  const cursor = ctx.store.getCursor(inst.id);
  let error: string | null = null;
  try {
    if (inst.disabledReason) throw new Error(inst.disabledReason);
    const adapter = ctx.adapterFor(inst);
    const since = cursor ? new Date(new Date(cursor).getTime() - CURSOR_OVERLAP_MS) : null;
    const refs = new Map<string, ItemRef>();
    for (const r of await adapter.discover(since)) refs.set(r.url, r);
    // Items listed in items.yaml that the cache has never seen (e.g. added by hand).
    for (const entry of ctx.intent.values()) {
      if (entry.manual || ctx.store.getItem(entry.url)) continue;
      const r = adapter.refFromUrl(entry.url);
      if (r) refs.set(r.url, r);
    }
    const failures: string[] = [];
    await forEachLimit([...refs.values()], FETCH_CONCURRENCY, async (ref) => {
      try {
        const snap = await adapter.fetch(ref);
        result.fetched++;
        result.newSignals += applySnapshot(snap, ctx, now(), since, log);
      } catch (err) {
        if (err instanceof GoneError) {
          result.newSignals += markGone(ref, ctx, now(), log);
          return;
        }
        if (err instanceof RateLimitError) throw err; // stop the whole instance
        failures.push(`${ref.url}: ${(err as Error).message}`);
      }
    });
    if (failures.length) error = `${failures.length} item(s) failed; first: ${failures[0]}`;
  } catch (err) {
    error = (err as Error).message;
  }
  result.ok = error === null;
  if (error) result.error = error;
  // The cursor only advances on full success, so failed items are re-discovered next time.
  ctx.store.recordRun({
    instance: inst.id,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    cursor: error ? cursor : startedAt.toISOString(),
    error,
  });
  return result;
}

/** Runs `fn` over `items` with at most `limit` in flight; the first thrown error stops new work and is rethrown. */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        stopped = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Synthesizes events the forge does not report as such: CI result changes and new merge conflicts. */
function derivedEvents(prev: ItemRow | null, snap: Snapshot, ci: ItemRow["ciState"], now: Date): NormalizedEvent[] {
  if (!prev) return [];
  const out: NormalizedEvent[] = [];
  const stamp = now.toISOString();
  // A first green result is not news; a first red one, or any change of a settled result, is.
  if (ci && ci !== prev.ciState && !(prev.ciState === null && ci === "success")) {
    out.push({ key: `ci:${stamp}`, kind: "ci", actor: "", actorRole: "unknown", at: now, details: { from: prev.ciState, to: ci } });
  }
  if (snap.hasConflicts && !prev.hasConflicts) {
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
  const priority = effectivePriority(intent.get(url), snap.ref.kind, snap.authoredByMe);
  // CI: remember the last settled result; "pending" does not overwrite it.
  const ci = snap.ciState === "pending" ? (prev?.ciState ?? null) : (snap.ciState ?? null);

  let latestSignal: EventRow | null = null;
  let latestOwnAt: string | null = null;
  let newSignals = 0;
  for (const ev of [...snap.events, ...derivedEvents(prev, snap, ci, now)]) {
    const verdict = classify(ev, priority, config.filter);
    const row: EventRow = {
      itemUrl: url, key: ev.key, kind: ev.kind, actor: ev.actor, actorRole: ev.actorRole,
      at: ev.at.toISOString(), detectedAt: nowIso, excerpt: ev.body ? ev.body.slice(0, 500) : null,
      details: ev.details ?? null, isSignal: verdict.isSignal, reason: verdict.reason,
      isBaseline: !prev && (since === null || ev.at < since),
    };
    if (!store.insertEvent(row) || row.isBaseline) continue; // already known, or baseline
    if (ev.actorRole === "me") {
      if (!latestOwnAt || row.at > latestOwnAt) latestOwnAt = row.at;
      continue;
    }
    if (!verdict.isSignal) continue;
    newSignals++;
    log(`  ${snap.repo}: ${snap.title} — ${summarize(row)}`);
    if (!latestSignal || row.at >= latestSignal.at) latestSignal = row;
  }

  let lastSignalAt = prev?.lastSignalAt ?? null;
  let lastSignalSummary = prev?.lastSignalSummary ?? null;
  let seenAt = prev?.seenAt ?? null;
  if (latestSignal) {
    lastSignalAt = nowIso;
    lastSignalSummary = summarize(latestSignal);
  }
  // My own activity after the latest signal means I have already looked at it.
  if (latestOwnAt && (!latestSignal || latestSignal.at <= latestOwnAt)) seenAt = nowIso;

  const { events: _events, ...meta } = snap;
  store.upsertItem({
    url, id: itemId(url), instance: snap.ref.instance, kind: snap.ref.kind, repo: snap.repo,
    title: snap.title, state: snap.state, stateDetail: snap.stateDetail ?? null, ciState: ci,
    hasConflicts: snap.hasConflicts ?? false, authoredByMe: snap.authoredByMe, labels: snap.labels,
    lastSignalAt, lastSignalSummary, seenAt, baselineAt: prev?.baselineAt ?? nowIso,
    fetchedAt: nowIso, snapshotJson: JSON.stringify(meta),
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
    const priority = effectivePriority(intent.get(item.url), item.kind, item.authoredByMe);
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
