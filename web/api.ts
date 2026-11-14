// Client for the watcher's JSON API (src/server.ts). Types come from the server side.
import type { EventView, InstanceStatus, ItemView } from "../src/core/api.ts";
import type { SubscriptionStatus } from "../src/core/following.ts";
import type { InstanceResult } from "../src/core/poller.ts";
import { DEFAULT_REGISTER, withRegister } from "./view.ts";

export type { EventView, InstanceStatus, ItemView, SubscriptionStatus };

export interface Status {
  instances: InstanceStatus[];
  polling: boolean;
  lastPoll: { startedAt: string; finishedAt: string | null; results: InstanceResult[] | null; error: string | null } | null;
}

export interface Filters {
  unread: boolean;
  important: boolean;
  muted: boolean;
  instance: string; // "" for every instance
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const write = method !== "GET";
  const res = await fetch(path, {
    method,
    // The server only accepts changes sent as JSON (its guard against cross-site requests).
    headers: write ? { "content-type": "application/json" } : {},
    body: write ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** The register the item calls are about: what is listed, and where a star, mute or note is kept. */
let register = DEFAULT_REGISTER;
export const setRegister = (name: string) => {
  register = name;
};
const inRegister = (path: string) => withRegister(path, register);

export const api = {
  items(f: Filters): Promise<{ items: ItemView[] }> {
    const q = new URLSearchParams();
    if (f.unread) q.set("unread", "1");
    if (f.important) q.set("important", "1");
    if (f.muted) q.set("muted", "1");
    if (f.instance) q.set("instance", f.instance);
    return call("GET", inRegister(`/api/items${q.size ? `?${q}` : ""}`));
  },
  events: (id: string, noise: boolean): Promise<{ events: EventView[] }> => call("GET", inRegister(`/api/items/${id}/events${noise ? "?noise=1" : ""}`)),
  change: (id: string, change: { priority?: "important" | "normal" | null; muted?: boolean; note?: string | null }) =>
    call<{ item: ItemView; warning: string | null }>("PATCH", inRegister(`/api/items/${id}`), change),
  add: (url: string, title: string) => call<{ url: string; manual: boolean; warning: string | null }>("POST", inRegister("/api/items"), { url, title }),
  seen: (id: string) => call<{ marked: number }>("POST", inRegister(`/api/items/${id}/seen`)),
  allSeen: () => call<{ marked: number }>("POST", "/api/seen"),
  poll: () => call<{ started: boolean }>("POST", "/api/poll"),
  status: () => call<Status>("GET", "/api/status"),
  registers: () => call<{ registers: string[] }>("GET", "/api/registers"),
  subscriptionStatus: () => call<{ subscriptions: SubscriptionStatus[] }>("GET", "/api/subscription-status"),
};
