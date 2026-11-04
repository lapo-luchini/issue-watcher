// Query/command API shared by every front end (CLI now; HTTP server and MCP later).
import { effectivePriority, type Intent } from "./intent.ts";
import type { CiState, ItemKind, Priority } from "./model.ts";
import { itemId, type Store } from "./store.ts";

export interface ItemView {
  id: string;
  url: string;
  instance: string | null; // null for manual items
  kind: ItemKind | "manual";
  repo: string;
  title: string;
  state: string;
  ciState: CiState | null;
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
}

/** Important first, then most recent signal first; items that never had a signal last. */
export function listItems(store: Store, intent: Intent, opts: ListOptions = {}): ItemView[] {
  const views: ItemView[] = store.listItems().map((i) => {
    const entry = intent.get(i.url);
    return {
      id: i.id, url: i.url, instance: i.instance, kind: i.kind, repo: i.repo, title: i.title,
      state: i.stateDetail ? `${i.state} (${i.stateDetail})` : i.state, ciState: i.ciState,
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
      title: entry.title ?? entry.url, state: "manual", ciState: null, priority: entry.priority ?? "normal",
      muted: entry.muted, note: entry.note ?? null, unread: false, lastSignalAt: null, lastSignalSummary: null,
    });
  }
  return views
    .filter((v) => (opts.includeMuted || !v.muted) && (!opts.unreadOnly || v.unread))
    .sort((a, b) =>
      (a.priority === b.priority ? 0 : a.priority === "important" ? -1 : 1) ||
      (b.lastSignalAt ?? "").localeCompare(a.lastSignalAt ?? "") ||
      a.title.localeCompare(b.title));
}

/** Marks items seen by URL (or all items when `urls` is empty); returns how many were updated. */
export function markSeen(store: Store, urls: string[], now: Date): number {
  const at = now.toISOString();
  if (urls.length === 0) return store.markAllSeen(at);
  return urls.filter((u) => store.markSeen(u, at)).length;
}
