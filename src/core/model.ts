// Shared types. Adapters produce these; the core consumes them.

export type ItemKind = "pr" | "issue" | "bug";
export type ItemState = "open" | "merged" | "closed" | "gone";
export type Priority = "important" | "normal";
export type CiState = "success" | "failure" | "pending";
export type ActorRole = "me" | "maintainer" | "contributor" | "bot" | "unknown";
export type EventKind =
  | "comment" | "review" | "state" | "label" | "milestone" | "push" | "ci"
  | "conflict" | "flag" | "attachment" | "assign" | "mention" | "review_request";

/** Identifies one tracked item. `url` is the canonical web URL and the primary key everywhere. */
export interface ItemRef {
  url: string;
  instance: string;
  kind: ItemKind;
}

/** One thing that happened on an item, in forge-independent form. */
export interface NormalizedEvent {
  key: string; // stable forge-native id, unique within the item
  kind: EventKind;
  actor: string;
  actorRole: ActorRole;
  at: Date;
  body?: string;
  details?: Record<string, unknown>;
}

/** Full current view of one item, as returned by an adapter. */
export interface Snapshot {
  ref: ItemRef;
  repo: string;
  title: string;
  state: ItemState;
  stateDetail?: string;
  ciState?: CiState | null;
  hasConflicts?: boolean | null; // null: unknown (e.g. the forge is still computing it)
  authoredByMe: boolean;
  labels: string[];
  events: NormalizedEvent[];
}

/** One forge type. Adapters only talk to the forge and normalize; no filtering, no storage. */
export interface Adapter {
  /** Parse a web URL belonging to this instance, or return null if it is not ours. */
  refFromUrl(url: string): ItemRef | null;
  /** Items involving me that changed since `since` (null: first run, open items only). */
  discover(since: Date | null): Promise<ItemRef[]>;
  /** Full current view of one item. Throws GoneError if it no longer exists. */
  fetch(ref: ItemRef): Promise<Snapshot>;
}

export interface Verdict {
  isSignal: boolean;
  reason: string;
}
