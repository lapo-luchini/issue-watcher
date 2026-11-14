// The page's API client: which register every call is about.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { api, setRegister, type Filters } from "../web/api.ts";

const NONE: Filters = { unread: false, important: false, muted: false, instance: "" };
let calls: { method: string; path: string }[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  setRegister("default");
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path });
    return Response.json({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRegister("default");
});

const paths = () => calls.map((c) => `${c.method} ${c.path}`);

test("on default no call carries a register", async () => {
  await api.items(NONE);
  await api.events("a1", false);
  await api.change("a1", { muted: true });
  await api.add("https://x.example/1", "");
  await api.seen("a1");
  expect(paths()).toEqual(["GET /api/items","GET /api/items/a1/events", "PATCH /api/items/a1", "POST /api/items", "POST /api/items/a1/seen"]);
});

test("on another register every item call names it, so curation lands in that register", async () => {
  setRegister("houston");
  await api.items({ ...NONE, unread: true });
  await api.events("a1", true);
  await api.change("a1", { muted: true });
  await api.add("https://x.example/1", "");
  await api.seen("a1");
  expect(paths()).toEqual([
    "GET /api/items?unread=1&register=houston",
    "GET /api/items/a1/events?noise=1&register=houston",
    "PATCH /api/items/a1?register=houston",
    "POST /api/items?register=houston",
    "POST /api/items/a1/seen?register=houston",
  ]);
});

test("registers, the subscription status, 'all seen', poll and status are not about one register", async () => {
  setRegister("houston");
  await api.registers();
  await api.subscriptionStatus();
  await api.allSeen();
  await api.poll();
  await api.status();
  expect(paths()).toEqual(["GET /api/registers", "GET /api/subscription-status", "POST /api/seen", "POST /api/poll", "GET /api/status"]);
});

test("a failed call throws the server's own words", async () => {
  globalThis.fetch = (async () => Response.json({ error: "no such register: x" }, { status: 404 })) as unknown as typeof fetch;
  await expect(api.registers()).rejects.toThrow("no such register: x");
});
