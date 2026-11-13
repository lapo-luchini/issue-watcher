// Registers: named lists of entries (priority, mute, note, manual items), each one a file of the
// format of data/items.yaml. `default` is data/items.yaml itself; any other is data/registers/<name>.yaml.
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { Intent, IntentEntry } from "./intent.ts";

export const DEFAULT_REGISTER = "default";
/** Where the register `default` lives (it is the file of the tool before registers existed). */
export const ITEMS_FILE = "data/items.yaml";
const REGISTERS_DIR = "data/registers";
// A name is a file name: lowercase letters, digits, "-" and "_", starting with a letter or digit.
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A bad register name, or one that does not exist; the message names only what the caller passed, so it may be shown. */
export class RegisterError extends Error {}

/** `name` itself when it is a valid register name; throws RegisterError otherwise. */
export function checkRegisterName(name: string): string {
  if (!NAME.test(name)) throw new RegisterError(`invalid register name '${name}' (lowercase letters, digits, - and _)`);
  return name;
}

/** The register file, relative to the watcher home. */
export function registerFile(name: string): string {
  checkRegisterName(name);
  return name === DEFAULT_REGISTER ? ITEMS_FILE : `${REGISTERS_DIR}/${name}.yaml`;
}

/**
 * Every register, `default` first (it exists even without its file), then the files of
 * data/registers/ by name. A file whose name is not a valid register name, or that is called
 * default.yaml (that register is data/items.yaml), is not a register.
 */
export function listRegisterNames(home: string): string[] {
  let files: Dirent[] = [];
  try {
    files = readdirSync(join(home, REGISTERS_DIR), { withFileTypes: true });
  } catch {} // no such directory: only `default`
  const names = files
    .filter((f) => f.isFile() && f.name.endsWith(".yaml") && f.name !== `${DEFAULT_REGISTER}.yaml`)
    .map((f) => f.name.slice(0, -".yaml".length))
    .filter((n) => NAME.test(n))
    .sort();
  return [DEFAULT_REGISTER, ...names];
}

/** The register named by WATCHER_REGISTER (default `default`); a bad name throws RegisterError. */
export function registerFromEnv(env: Record<string, string | undefined>): string {
  const v = env.WATCHER_REGISTER;
  return v === undefined || v === "" ? DEFAULT_REGISTER : checkRegisterName(v);
}

/**
 * The entries of all registers as one intent, for what is shared by all: the poll fetches every
 * entry, and the noise filter judges an item by one priority. An item in several registers has
 * `important` if any says so, else the first explicit priority (in the order given); it is
 * manual only if every entry says so (a forge item in any register is fetched).
 */
export function mergeIntents(intents: Intent[]): Intent {
  const out: Intent = new Map();
  for (const intent of intents) {
    for (const e of intent.values()) {
      const have = out.get(e.url);
      if (!have) {
        out.set(e.url, { ...e });
        continue;
      }
      const merged: IntentEntry = { ...have, manual: have.manual && e.manual };
      if (have.priority !== "important") merged.priority = e.priority === "important" ? "important" : (have.priority ?? e.priority);
      out.set(e.url, merged);
    }
  }
  return out;
}
