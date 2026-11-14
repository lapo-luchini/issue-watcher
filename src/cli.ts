#!/usr/bin/env bun
// Command-line front end: `bun src/cli.ts <command>` (or `bun run watcher <command>`).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { canonicalIntentFor, createAdapter, urlRecognizer } from "./adapters/index.ts";
import { listItems, markSeen } from "./core/api.ts";
import { loadConfig } from "./core/config.ts";
import { openContext } from "./core/context.ts";
import { loadIntent, type Intent } from "./core/intent.ts";
import { pollAll, refilter } from "./core/poller.ts";
import { DEFAULT_REGISTER, listRegisterNames, mergeIntents, registerFile, registerFromEnv, registerLabel } from "./core/registers.ts";
import { Store } from "./core/store.ts";
import { serve } from "./mcp/protocol.ts";
import { createTools } from "./mcp/tools.ts";
import { startServer } from "./server.ts";
import { runSubscriptionCommand, SUBSCRIPTION_COMMANDS, SUBSCRIPTION_USAGE } from "./subscriptions-cli.ts";

const USAGE = `usage: watcher <command> [options]

  poll [--instance ID] [--dry-run]   poll forges for changes (--dry-run saves nothing)
  list [--all] [--muted] [--register R]  show unread items (--all: every item) of a register (env: WATCHER_REGISTER, default "default")
  registers                          the registers: data/items.yaml is "default", the files of data/registers/ the others
  seen URL... | seen --all           mark the given items (or all items) seen
  refilter                           re-run the noise filter over stored events
  serve [--port N] [--host H]        web UI on http://127.0.0.1:8411/ (env: WATCHER_PORT, WATCHER_HOST)
  mcp                                MCP server on stdin/stdout, for an AI assistant (see README)
${SUBSCRIPTION_USAGE}`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      instance: { type: "string" },
      "dry-run": { type: "boolean" },
      all: { type: "boolean" },
      muted: { type: "boolean" },
      register: { type: "string" },
      subscription: { type: "string" },
      peek: { type: "boolean" },
      json: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [cmd, ...args] = positionals;
  if (!cmd) {
    console.error(USAGE);
    return 2;
  }

  const home = process.env.WATCHER_HOME ?? join(import.meta.dir, "..");
  if (cmd === "serve") {
    const port = Number(values.port ?? process.env.WATCHER_PORT ?? 8411);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`watcher: invalid port '${values.port ?? process.env.WATCHER_PORT}'`);
      return 2;
    }
    const srv = await startServer({
      home, port, hostname: values.host ?? process.env.WATCHER_HOST ?? "127.0.0.1",
      allowedHosts: (process.env.WATCHER_ALLOWED_HOSTS ?? "").split(","),
      development: process.env.WATCHER_DEV === "1",
    });
    console.log(`watcher: serving ${srv.url} (Ctrl-C to stop)`);
    // On Ctrl-C or kill, let a running poll finish and close the cache before exiting.
    await new Promise<void>((resolve) => {
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
    });
    console.log("watcher: stopping (waiting for a running poll, if any)");
    await srv.stop();
    return 0;
  }
  if (SUBSCRIPTION_COMMANDS.includes(cmd)) {
    return runSubscriptionCommand(cmd, args, { home, subscription: values.subscription, register: values.register, all: values.all, json: values.json });
  }
  const register = values.register ?? registerFromEnv(process.env); // a bad name is an error before anything is opened
  if (values.register !== undefined) registerFile(register);
  if (cmd === "mcp") {
    // stdout carries the protocol and nothing else; problems go to stderr (and exit code 1).
    const ctx = await openContext(home);
    try {
      const tools = createTools(ctx, { register });
      await serve(Bun.stdin.stream(), async (line) => void (await Bun.write(Bun.stdout, line)), tools, { name: "watcher", version: pkg.version });
      await tools.idle(); // stdin closed while a poll started by the assistant runs: let it finish
    } finally {
      ctx.store.close();
    }
    return 0;
  }
  const config = await loadConfig(join(home, "data/config.yaml"));
  // Every register, each by canonical URL; what the poll shares is their union, `list` shows one.
  const registers = listRegisterNames(home);
  if (cmd === "list" && !registers.includes(register)) {
    console.error(`watcher: no such register: ${register} (registers: ${registers.join(", ")})`);
    return 2;
  }
  const entries = new Map<string, Intent>();
  for (const name of registers) {
    const label = registerLabel(name);
    try {
      const { intent, unknown } = canonicalIntentFor(config, await loadIntent(join(home, registerFile(name)), label), label);
      for (const url of unknown) console.error(`watcher: warning: ${label}: no configured instance recognizes ${url}; ignored`);
      entries.set(name, intent);
    } catch (err) {
      // Only the file in use must be right: a broken other register is skipped, as the servers' poll does.
      if (name === DEFAULT_REGISTER || (cmd === "list" && name === register)) throw err;
      console.error(`watcher: warning: ${label} skipped: ${(err as Error).message}`);
    }
  }
  const intent = mergeIntents([...entries.values()]);
  mkdirSync(join(home, "var"), { recursive: true });
  const store = new Store(join(home, "var/cache.sqlite"));
  try {
    switch (cmd) {
      case "poll": {
        const dryRun = values["dry-run"] ?? false;
        const results = await pollAll({ store, config, intent, adapterFor: createAdapter, log: console.log }, { only: values.instance, dryRun });
        for (const r of results) {
          console.log(r.ok
            ? `${r.instance}: ok, ${r.fetched} fetched, ${r.newSignals} new signal(s)`
            : `${r.instance}: ERROR ${r.error} (${r.fetched} fetched, ${r.newSignals} new signal(s))`);
        }
        if (dryRun) console.log("(dry run: nothing was saved)");
        return results.every((r) => r.ok) ? 0 : 1;
      }
      case "list": {
        const items = listItems(store, entries.get(register) ?? new Map(), { unreadOnly: !values.all, includeMuted: values.muted, register });
        for (const i of items) {
          const flags = `${i.unread ? "●" : " "}${i.priority === "important" ? "★" : " "}`;
          console.log(`${flags} ${i.repo}  ${i.title}  [${i.state}${i.ciState ? `, CI ${i.ciState}` : ""}]`);
          console.log(`     ${i.lastSignalSummary ?? "—"}  ${i.url}`);
        }
        if (items.length === 0) console.log(values.all ? "no items" : "nothing unread");
        return 0;
      }
      case "registers": {
        for (const name of registers) console.log(name);
        return 0;
      }
      case "seen": {
        // Marking everything seen must be explicit: a bare `seen` is more likely a mistake.
        // Exactly one of URLs or --all.
        if ((args.length === 0 && !values.all) || (args.length > 0 && values.all)) {
          console.error(USAGE);
          return 2;
        }
        const now = new Date();
        if (values.all) {
          console.log(`${markSeen(store, [], now)} item(s) marked seen`);
          return 0;
        }
        const recognize = urlRecognizer(config);
        let marked = 0;
        for (const url of args) {
          // Accept browser-copied URLs too (trailing slash, PR tab, #fragment…).
          if (markSeen(store, [recognize(url)?.url ?? url], now) > 0) marked++;
          else console.error(`watcher: no item with URL ${url} (URLs must be canonical, as shown by 'watcher list --all')`);
        }
        console.log(`${marked} item(s) marked seen`);
        return marked === args.length ? 0 : 1;
      }
      case "refilter": {
        const { changed } = refilter(store, config, intent);
        console.log(`${changed} event verdict(s) changed`);
        return 0;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  } finally {
    store.close();
  }
}

try {
  process.exit(await main(Bun.argv.slice(2)));
} catch (err) {
  console.error(`watcher: ${(err as Error).message}`);
  process.exit(1);
}
