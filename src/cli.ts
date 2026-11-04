#!/usr/bin/env bun
// Command-line front end: `bun src/cli.ts <command>` (or `bun run watcher <command>`).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createAdapter } from "./adapters/index.ts";
import { listItems, markSeen } from "./core/api.ts";
import { loadConfig, type Config } from "./core/config.ts";
import { canonicalizeIntent, loadIntent, type Intent } from "./core/intent.ts";
import type { Adapter, ItemRef } from "./core/model.ts";
import { pollAll, refilter } from "./core/poller.ts";
import { Store } from "./core/store.ts";

const USAGE = `usage: watcher <command> [options]

  poll [--instance ID] [--dry-run]   poll forges for changes (--dry-run saves nothing)
  list [--all] [--muted]             show unread items (--all: every item)
  seen URL... | seen --all           mark the given items (or all items) seen
  refilter                           re-run the noise filter over stored events`;

/** Keys items.yaml entries by canonical URL, warning about entries no configured instance recognizes. */
function canonicalIntent(config: Config, raw: Intent): Intent {
  const adapters: Adapter[] = [];
  for (const inst of config.instances) {
    try {
      adapters.push(createAdapter(inst));
    } catch {
      // No adapter for this instance type yet: its URLs cannot be recognized.
    }
  }
  const refFromUrl = (url: string): ItemRef | null => {
    for (const a of adapters) {
      const ref = a.refFromUrl(url);
      if (ref) return ref;
    }
    return null;
  };
  const { intent, unknown } = canonicalizeIntent(raw, refFromUrl);
  for (const url of unknown) console.error(`watcher: warning: items.yaml: no configured instance recognizes ${url}; ignored`);
  return intent;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      instance: { type: "string" },
      "dry-run": { type: "boolean" },
      all: { type: "boolean" },
      muted: { type: "boolean" },
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
  const config = await loadConfig(join(home, "data/config.yaml"));
  const intent = canonicalIntent(config, await loadIntent(join(home, "data/items.yaml")));
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
        const items = listItems(store, intent, { unreadOnly: !values.all, includeMuted: values.muted });
        for (const i of items) {
          const flags = `${i.unread ? "●" : " "}${i.priority === "important" ? "★" : " "}`;
          console.log(`${flags} ${i.repo}  ${i.title}  [${i.state}${i.ciState ? `, CI ${i.ciState}` : ""}]`);
          console.log(`     ${i.lastSignalSummary ?? "—"}  ${i.url}`);
        }
        if (items.length === 0) console.log(values.all ? "no items" : "nothing unread");
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
        let marked = 0;
        for (const url of args) {
          if (markSeen(store, [url], now) > 0) marked++;
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
