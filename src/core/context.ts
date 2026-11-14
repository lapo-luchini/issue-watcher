// What every long-running front end (web server, MCP server) sets up the same way: the config, the
// URL recognizer, the cache and the way the registers (items.yaml and data/registers/) are read and committed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalIntentFor, urlRecognizer } from "../adapters/index.ts";
import type { IntentRepo } from "./api.ts";
import { loadConfig, type Config } from "./config.ts";
import { loadIntent, type Intent } from "./intent.ts";
import type { ItemRef } from "./model.ts";
import { DEFAULT_REGISTER, listRegisterNames, mergeIntents, registerFile, registerLabel, RegisterError } from "./registers.ts";
import { Store } from "./store.ts";
import { loadSubscriptions, SUBSCRIPTIONS_FILE, type Subscription } from "./subscriptions.ts";

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
  /** The entries of all registers as one: what the poll fetches (see mergeIntents). A broken register other than `default` is skipped, with a warning on stderr. */
  allIntent: () => Promise<Intent>;
  /** The subscriptions (data/subscriptions.yaml; none when there is no file), their URLs canonical, read on every call. A file that cannot be read is an error. */
  subscriptions: () => Promise<Map<string, Subscription>>;
  /** What is wrong with the data files, one line each, naming files by their label, never by path: a register other than `default` that the poll skips, a subscriptions file that cannot be read. */
  problems: () => Promise<string[]>;
}

/** Throws (before opening the cache) when the config is missing or invalid. The caller closes the store. */
export async function openContext(home: string): Promise<Context> {
  const config = await loadConfig(join(home, "data/config.yaml"));
  const recognize = urlRecognizer(config);
  mkdirSync(join(home, "var"), { recursive: true });
  const registers = () => listRegisterNames(home);
  const intent = async (register = DEFAULT_REGISTER) => {
    const file = registerFile(register); // a bad name is refused before any path is built from it
    if (!registers().includes(register)) throw new RegisterError(`no such register: ${register}`);
    const label = registerLabel(register);
    return canonicalIntentFor(config, await loadIntent(join(home, file), label), label).intent;
  };
  const canonical = (url: string) => recognize(url)?.url ?? url;
  const subscriptions = async () => {
    const subs = await loadSubscriptions(join(home, SUBSCRIPTIONS_FILE));
    for (const s of subs.values()) {
      if (s.scope !== "all") s.scope = s.scope.map(canonical);
      s.exclude = s.exclude.map(canonical);
    }
    return subs;
  };
  /** What a failed read of a file says without a path: a system error (its message carries the path) only that it could not be read. */
  const safeMessage = (label: string, err: unknown) =>
    /^E[A-Z0-9]+$/.test(String((err as NodeJS.ErrnoException).code)) ? `${label}: could not be read` : (err as Error).message;
  return {
    home, config, recognize, canonical,
    where: { home, branch: config.commitBranch },
    store: new Store(join(home, "var/cache.sqlite")),
    intent, registers, subscriptions,
    // A register file that cannot be read is skipped with a warning, so one project's hand edit does not stop the poll for all; `default` (the tool's own file) still fails loudly.
    allIntent: async () => mergeIntents(await Promise.all(registers().map(async (r) => {
      try {
        return await intent(r);
      } catch (err) {
        if (r === DEFAULT_REGISTER) throw err;
        console.error(`watcher: warning: ${registerLabel(r)} skipped: ${(err as Error).message}`);
        return new Map();
      }
    }))),
    problems: async () => {
      const out: string[] = [];
      for (const r of registers().filter((r) => r !== DEFAULT_REGISTER)) {
        await intent(r).catch((err) => out.push(`${safeMessage(registerLabel(r), err)} (the poll skips this register)`));
      }
      await subscriptions().catch((err) => out.push(safeMessage("subscriptions.yaml", err)));
      return out;
    },
  };
}
