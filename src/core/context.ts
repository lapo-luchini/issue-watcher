// What every long-running front end (web server, MCP server) sets up the same way: the config, the
// URL recognizer, the cache and the way items.yaml is read and committed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalIntentFor, urlRecognizer } from "../adapters/index.ts";
import type { IntentRepo } from "./api.ts";
import { loadConfig, type Config } from "./config.ts";
import { loadIntent, type Intent } from "./intent.ts";
import type { ItemRef } from "./model.ts";
import { Store } from "./store.ts";

export interface Context {
  home: string; // the watcher's directory: data/config.yaml, data/items.yaml, var/cache.sqlite
  config: Config;
  recognize: (url: string) => ItemRef | null;
  canonical: (url: string) => string; // the canonical URL of an item URL, or the URL itself when no instance recognizes it
  where: IntentRepo; // where items.yaml changes are committed
  store: Store;
  /** items.yaml is read on every call, so hand edits and `git pull`s show up without a restart. */
  intent: () => Promise<Intent>;
}

/** Throws (before opening the cache) when the config is missing or invalid. The caller closes the store. */
export async function openContext(home: string): Promise<Context> {
  const config = await loadConfig(join(home, "data/config.yaml"));
  const recognize = urlRecognizer(config);
  mkdirSync(join(home, "var"), { recursive: true });
  return {
    home, config, recognize,
    canonical: (url) => recognize(url)?.url ?? url,
    where: { home, branch: config.commitBranch },
    store: new Store(join(home, "var/cache.sqlite")),
    intent: async () => canonicalIntentFor(config, await loadIntent(join(home, "data/items.yaml"))).intent,
  };
}
