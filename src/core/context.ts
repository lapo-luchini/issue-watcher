// What every long-running front end (web server, MCP server) sets up the same way: the config, the
// URL recognizer, the cache and the way the registers (items.yaml and data/registers/) are read and committed.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalIntentFor, urlRecognizer } from "../adapters/index.ts";
import type { IntentRepo } from "./api.ts";
import { loadConfig, type Config } from "./config.ts";
import { loadIntent, type Intent } from "./intent.ts";
import type { ItemRef } from "./model.ts";
import { DEFAULT_REGISTER, listRegisterNames, mergeIntents, registerFile, registerLabel, RegisterError } from "./registers.ts";
import { Store } from "./store.ts";

export interface Context {
  home: string; // the watcher's directory: data/config.yaml, data/items.yaml, data/registers/, var/cache.sqlite
  config: Config;
  recognize: (url: string) => ItemRef | null;
  canonical: (url: string) => string; // the canonical URL of an item URL, or the URL itself when no instance recognizes it
  where: IntentRepo; // where register changes are committed
  store: Store;
  /**
   * The entries of a register (`default`, which is items.yaml, when none is named), read on every
   * call, so hand edits and `git pull`s show up without a restart. A register that has no file is
   * an error (RegisterError), except `default`, which is then empty.
   */
  intent: (register?: string) => Promise<Intent>;
  /** Every register that exists, `default` first. */
  registers: () => string[];
  /** The entries of all registers as one: what the poll fetches (see mergeIntents). */
  allIntent: () => Promise<Intent>;
}

/** Throws (before opening the cache) when the config is missing or invalid. The caller closes the store. */
export async function openContext(home: string): Promise<Context> {
  const config = await loadConfig(join(home, "data/config.yaml"));
  const recognize = urlRecognizer(config);
  mkdirSync(join(home, "var"), { recursive: true });
  const registers = () => listRegisterNames(home);
  const intent = async (register = DEFAULT_REGISTER) => {
    const file = registerFile(register); // a bad name is refused before any path is built from it
    if (register !== DEFAULT_REGISTER && !existsSync(join(home, file))) throw new RegisterError(`no such register: ${register}`);
    const label = registerLabel(register);
    return canonicalIntentFor(config, await loadIntent(join(home, file), label), label).intent;
  };
  return {
    home, config, recognize,
    canonical: (url) => recognize(url)?.url ?? url,
    where: { home, branch: config.commitBranch },
    store: new Store(join(home, "var/cache.sqlite")),
    intent, registers,
    allIntent: async () => mergeIntents(await Promise.all(registers().map((r) => intent(r)))),
  };
}
