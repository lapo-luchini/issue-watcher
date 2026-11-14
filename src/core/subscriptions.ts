// data/subscriptions.yaml: who follows what. A subscription has a name, a register, a scope (all
// of the register's entries, or a list of item URLs) and URLs it excludes. Its cursor is state, and
// lives in the cache (see Store.subscriptionCursor), never in git.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { parseYaml } from "./intent.ts";
import { DEFAULT_REGISTER, isValidName } from "./registers.ts";

export const SUBSCRIPTIONS_FILE = "data/subscriptions.yaml";

export interface Subscription {
  name: string;
  register: string;
  scope: "all" | string[]; // all the register's entries (later ones too), or these item URLs
  exclude: string[]; // item URLs left out of the scope (the subscription's own "stop telling me")
}

/** A bad subscription name, or one that does not exist; the message names only what the caller passed, so it may be shown. */
export class SubscriptionError extends Error {}

/** `name` itself when it is a valid subscription name (the rules of a register's); throws SubscriptionError otherwise. */
export function checkSubscriptionName(name: string): string {
  if (!isValidName(name)) throw new SubscriptionError(`invalid subscription name '${name}' (lowercase letters, digits, - and _)`);
  return name;
}

/** The subscription named by WATCHER_SUBSCRIPTION, or undefined when none is: only a command that needs one asks for it. A bad name throws SubscriptionError. */
export function subscriptionFromEnv(env: Record<string, string | undefined>): string | undefined {
  const v = env.WATCHER_SUBSCRIPTION;
  return v === undefined || v === "" ? undefined : checkSubscriptionName(v);
}

const FIELDS = ["name", "register", "scope", "exclude"];

function urlList(raw: unknown, where: string, field: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: '${field}' must be ${field === "scope" ? "all or " : ""}a list of URLs`);
  return raw.map((u) => {
    if (typeof u !== "string" || !URL.canParse(u) || !/^https?:$/.test(new URL(u).protocol)) throw new Error(`${where}: invalid url '${String(u)}' (http or https only)`);
    return u;
  });
}

/** `file` names the file in error messages. */
export function parseSubscriptions(text: string, file = "subscriptions.yaml"): Map<string, Subscription> {
  const raw: any = parseYaml(text, file) ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: must be a mapping with a 'subscriptions' list`);
  const list = raw.subscriptions ?? [];
  if (!Array.isArray(list)) throw new Error(`${file}: 'subscriptions' must be a list`);
  const out = new Map<string, Subscription>();
  list.forEach((r: any, i: number) => {
    const where = `${file}: subscriptions[${i}]`;
    if (typeof r?.name !== "string" || r.name === "") throw new Error(`${where}: 'name' is required`);
    if (!isValidName(r.name)) throw new Error(`${where}: invalid name '${r.name}' (lowercase letters, digits, - and _)`);
    for (const key of Object.keys(r)) if (!FIELDS.includes(key)) throw new Error(`${where}: unknown field '${key}'`);
    if (out.has(r.name)) throw new Error(`${where}: duplicate name ${r.name}`);
    if (r.register !== undefined && (typeof r.register !== "string" || !isValidName(r.register))) throw new Error(`${where}: invalid register name`);
    out.set(r.name, {
      name: r.name,
      register: r.register ?? DEFAULT_REGISTER,
      scope: r.scope === undefined ? [] : r.scope === "all" ? "all" : urlList(r.scope, where, "scope"),
      exclude: r.exclude === undefined ? [] : urlList(r.exclude, where, "exclude"),
    });
  });
  return out;
}

/** The subscriptions of the file at `path`; none when there is no file. */
export async function loadSubscriptions(path: string, name = "subscriptions.yaml"): Promise<Map<string, Subscription>> {
  const file = Bun.file(path);
  return (await file.exists()) ? parseSubscriptions(await file.text(), name) : new Map();
}

/** Run under the lock before a change: a file that does not parse is left as it is, never overwritten by the edit. */
export function checkSubscriptionsFile(home: string): void {
  let text: string;
  try {
    text = readFileSync(join(home, SUBSCRIPTIONS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // not there yet: the write creates it
    throw err;
  }
  parseSubscriptions(text);
}

/** A change to subscriptions.yaml. `define` makes or updates a subscription; `follow` and `unfollow` change what it follows. */
export type SubscriptionEdit =
  | { kind: "define"; name: string; register: string; all?: boolean }
  | { kind: "follow"; name: string; url: string; register: string }
  | { kind: "unfollow"; name: string; url: string };

/** The `subscriptions` sequence of the document, created (as a block list) if missing. */
function subsOf(doc: Document): YAMLSeq {
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
  let subs = doc.get("subscriptions");
  if (!isSeq(subs)) {
    subs = doc.createNode([]);
    doc.set("subscriptions", subs);
  }
  (subs as YAMLSeq).flow = false;
  return subs as YAMLSeq;
}

/** The URL list at `key` of an entry, or null when the entry has none. */
function listAt(entry: YAMLMap, key: string): YAMLSeq | null {
  const seq = entry.get(key, true);
  return isSeq(seq) ? seq : null;
}

/** Returns `text` with the edit made; comments and order elsewhere are kept. `canonical` finds an entry written as a browser URL. Unfollowing in an unknown subscription throws SubscriptionError. */
export function editSubscriptions(text: string, edit: SubscriptionEdit, canonical: (url: string) => string = (u) => u): string {
  const doc = parseDocument(text);
  const subs = subsOf(doc);
  const found = subs.items.find((n) => isMap(n) && n.get("name") === edit.name) as YAMLMap | undefined;
  const same = (n: unknown, url: string) => {
    const u = isScalar(n) && typeof n.value === "string" ? n.value : null;
    return u !== null && (u === url || canonical(u) === url);
  };
  /** The list at `key`, created empty when the entry has none; one URL added once. */
  const addTo = (entry: YAMLMap, key: string, url: string) => {
    let seq = listAt(entry, key);
    if (!seq) entry.set(key, (seq = doc.createNode([]) as YAMLSeq));
    if (!seq.items.some((n) => same(n, url))) {
      seq.flow = false;
      seq.add(url);
    }
  };
  /** One URL taken out of the list at `key`; the list goes with its last URL when `dropWhenEmpty`. */
  const removeFrom = (entry: YAMLMap, key: string, url: string, dropWhenEmpty: boolean) => {
    const seq = listAt(entry, key);
    if (!seq) return;
    seq.items = seq.items.filter((n) => !same(n, url));
    if (dropWhenEmpty && seq.items.length === 0) entry.delete(key);
  };

  if (!found) {
    if (edit.kind === "unfollow") throw new SubscriptionError(`no such subscription: ${edit.name}`);
    const entry = doc.createNode({ name: edit.name }) as YAMLMap;
    if (edit.register !== DEFAULT_REGISTER) entry.set("register", edit.register);
    entry.set("scope", edit.kind === "define" && edit.all ? "all" : doc.createNode(edit.kind === "follow" ? [edit.url] : []));
    subs.add(entry);
    return doc.toString();
  }
  const isAll = found.get("scope") === "all";
  if (edit.kind === "define") {
    if (edit.register === DEFAULT_REGISTER) found.delete("register");
    else found.set("register", edit.register);
    if (edit.all === true) found.set("scope", "all");
    else if (edit.all === false && isAll) found.set("scope", doc.createNode([]));
  } else if (edit.kind === "follow") {
    if (isAll) removeFrom(found, "exclude", edit.url, true);
    else addTo(found, "scope", edit.url);
  } else if (isAll) addTo(found, "exclude", edit.url);
  else removeFrom(found, "scope", edit.url, false);
  return doc.toString();
}
