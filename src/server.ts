// HTTP front end: the JSON API of spec section 6 plus the web UI (web/index.html, bundled by Bun
// on the fly). A thin layer over core/api.ts; the server never touches the store directly.
import index from "../web/index.html";
import { createAdapter } from "./adapters/index.ts";
import {
  addItem, changeIntent, getItem, instanceStatus, itemEvents, listItems, markSeen, parseIntentChange, type ListOptions,
} from "./core/api.ts";
import type { InstanceConfig } from "./core/config.ts";
import { openContext } from "./core/context.ts";
import type { IntentChange } from "./core/intent.ts";
import type { Adapter, Priority } from "./core/model.ts";
import { pollAll, type InstanceResult } from "./core/poller.ts";

export interface ServerOptions {
  home: string; // the watcher's directory: data/config.yaml, data/items.yaml, var/cache.sqlite
  port?: number; // 0: any free port
  hostname?: string; // default 127.0.0.1
  allowedHosts?: string[]; // extra Host names accepted (a port is ignored), e.g. the name a reverse proxy forwards
  development?: boolean; // Bun's development mode, for working on the UI
  adapterFor?: (inst: InstanceConfig) => Adapter; // tests replace the real forges
  now?: () => Date;
}

/** The latest "Poll now" started from the web UI. */
interface PollReport {
  startedAt: string;
  finishedAt: string | null;
  results: InstanceResult[] | null;
  error: string | null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** "Example.org:8411" → "example.org"; "[::1]:8411" → "[::1]". */
function withoutPort(host: string): string {
  return host.replace(/:\d+$/, "").toLowerCase();
}

export async function startServer(opts: ServerOptions) {
  const now = opts.now ?? (() => new Date());
  const { config, recognize, canonical, where, store, intent } = await openContext(opts.home);
  const hostname = opts.hostname ?? "127.0.0.1";
  const allowedHosts = new Set((opts.allowedHosts ?? []).map((h) => withoutPort(h.trim())).filter((h) => h));
  let polling: Promise<void> | null = null;
  let lastPoll: PollReport | null = null;

  /**
   * Guards every request. The Host header must be a loopback name or an allowed one: a page on
   * another site could otherwise point its own DNS name at this server and read the API (DNS
   * rebinding), whatever address the server is bound to. Changes must be JSON and, when the
   * browser says where they come from, from this page's origin: a plain cross-site form post
   * cannot do either (CSRF).
   */
  function guard(req: Request): void {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.host;
    const name = withoutPort(host);
    if (!LOOPBACK.has(name) && !allowedHosts.has(name)) {
      throw new HttpError(403, `unexpected Host '${host}' (reached by another name? add it to WATCHER_ALLOWED_HOSTS)`);
    }
    if (req.method === "GET" || req.method === "HEAD") return;
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
      throw new HttpError(415, "send JSON (Content-Type: application/json)");
    }
    // Compare hosts only: behind a TLS-terminating proxy the page is https while we see http.
    const origin = req.headers.get("origin");
    if (origin && (!URL.canParse(origin) || new URL(origin).host !== host)) {
      throw new HttpError(403, `cross-origin request from ${origin}`);
    }
  }

  /** Wraps a handler: guard, JSON errors. */
  function route(handler: (req: Request & { params: Record<string, string> }) => Promise<Response> | Response) {
    return async (req: Request & { params: Record<string, string> }) => {
      try {
        guard(req);
        return await handler(req);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        return json({ error: (err as Error).message }, 500);
      }
    };
  }

  async function body(req: Request): Promise<Record<string, unknown>> {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
    return b as Record<string, unknown>;
  }

  async function itemOr404(id: string) {
    const item = getItem(store, await intent(), id);
    if (!item) throw new HttpError(404, `no item ${id}`);
    return item;
  }

  function parseChange(b: Record<string, unknown>): IntentChange {
    try {
      return parseIntentChange(b);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  function startPoll(): void {
    lastPoll = { startedAt: now().toISOString(), finishedAt: null, results: null, error: null };
    const report = lastPoll;
    polling = (async () => {
      try {
        report.results = await pollAll({ store, config, intent: await intent(), adapterFor: opts.adapterFor ?? createAdapter, now });
      } catch (err) {
        report.error = (err as Error).message;
      } finally {
        report.finishedAt = now().toISOString();
        polling = null;
      }
    })();
  }

  const server = Bun.serve({
    port: opts.port ?? 8411,
    hostname,
    // Bun's development mode (hot reload, detailed error pages) only when asked for.
    development: opts.development ?? false,
    routes: {
      "/": index,
      "/api/items": {
        GET: route(async (req) => {
          const q = new URL(req.url).searchParams;
          const on = (k: string) => q.get(k) === "1" || q.get(k) === "true";
          const o: ListOptions = { unreadOnly: on("unread"), importantOnly: on("important"), includeMuted: on("muted") };
          if (q.get("instance")) o.instance = q.get("instance")!;
          return json({ items: listItems(store, await intent(), o) });
        }),
        POST: route(async (req) => {
          const b = await body(req);
          if (typeof b.url !== "string") throw new HttpError(400, "url is required");
          if (b.title !== undefined && typeof b.title !== "string") throw new HttpError(400, "title must be text");
          try {
            const r = await addItem(where, store, await intent(), recognize, b.url.trim(), b.title as string | undefined);
            return json({ url: r.url, manual: r.manual, warning: r.commit.warning ?? null }, 201);
          } catch (err) {
            throw new HttpError(400, (err as Error).message);
          }
        }),
      },
      "/api/items/:id": {
        GET: route(async (req) => json({ item: await itemOr404(req.params.id!) })),
        PATCH: route(async (req) => {
          const item = await itemOr404(req.params.id!);
          const r = await changeIntent(where, item.url, parseChange(await body(req)), canonical, item.instance ? item.repo : undefined);
          return json({ item: await itemOr404(item.id), warning: r.warning ?? null });
        }),
      },
      "/api/items/:id/events": {
        GET: route(async (req) => {
          const item = await itemOr404(req.params.id!);
          const noise = new URL(req.url).searchParams.get("noise") === "1";
          return json({ events: itemEvents(store, item.url, noise) });
        }),
      },
      "/api/items/:id/seen": {
        POST: route(async (req) => {
          const item = await itemOr404(req.params.id!);
          return json({ marked: markSeen(store, [item.url], now()) });
        }),
      },
      "/api/seen": { POST: route(() => json({ marked: markSeen(store, [], now()) })) },
      "/api/poll": {
        POST: route(() => {
          // Also refused while cron's poll holds the lock.
          if (polling || store.lockHeld("poll", now())) throw new HttpError(409, "a poll is already running");
          startPoll();
          return json({ started: true }, 202);
        }),
      },
      "/api/status": {
        GET: route(() => json({ instances: instanceStatus(store, config), polling: polling !== null, lastPoll })),
      },
      "/api/*": route(() => {
        throw new HttpError(404, "no such API endpoint");
      }),
    },
    fetch: () => new Response("not found", { status: 404 }),
  });

  return {
    server,
    url: server.url.href,
    /** Waits for a running poll (tests); resolves at once when none runs. */
    idle: () => polling ?? Promise.resolve(),
    stop: async () => {
      await (polling ?? Promise.resolve());
      server.stop(true);
      store.close();
    },
  };
}
