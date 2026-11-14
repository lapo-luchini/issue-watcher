// The page's API client: which register every call is about.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { api, ServerError, setRegister, type Filters } from "../web/api.ts";

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

test("an error answer without the server's own JSON (a proxy's 502) is not a ServerError", async () => {
  globalThis.fetch = (async () => new Response("<h1>Bad Gateway</h1>", { status: 502 })) as unknown as typeof fetch;
  const gateway = await api.items(NONE).catch((e) => e);
  expect(gateway).not.toBeInstanceOf(ServerError);
  expect(gateway.message).toBe("HTTP 502");
  globalThis.fetch = (async () => Response.json({ message: "no error field" }, { status: 502 })) as unknown as typeof fetch;
  expect(await api.items(NONE).catch((e) => e)).not.toBeInstanceOf(ServerError);
});

test("an answer with an error is a ServerError (the server is there), a lost connection is not", async () => {
  globalThis.fetch = (async () => Response.json({ error: "registers/torn.yaml: not valid YAML at line 1" }, { status: 500 })) as unknown as typeof fetch;
  const refused = await api.items(NONE).catch((e) => e);
  expect(refused).toBeInstanceOf(ServerError);
  expect(refused.message).toBe("registers/torn.yaml: not valid YAML at line 1");
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
  const lost = await api.items(NONE).catch((e) => e);
  expect(lost).not.toBeInstanceOf(ServerError);
});
