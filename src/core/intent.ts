// Reads data/items.yaml: the user's intent (priority, mute, notes, manual items), keyed by URL.
// Writing it (with git commits) arrives together with the web UI.
import { parse } from "yaml";
import type { ItemKind, ItemRef, Priority } from "./model.ts";

export interface IntentEntry {
  url: string;
  priority?: Priority;
  muted: boolean;
  note?: string;
  manual: boolean; // listed, never polled
  title?: string; // only meaningful for manual items
}

export type Intent = Map<string, IntentEntry>;

export function parseIntent(text: string): Intent {
  const raw: any = parse(text) ?? {};
  const list = raw.items ?? [];
  if (!Array.isArray(list)) throw new Error("items.yaml: 'items' must be a list");
  const out: Intent = new Map();
  list.forEach((r: any, i: number) => {
    const where = `items.yaml: items[${i}]`;
    if (typeof r?.url !== "string" || r.url === "") throw new Error(`${where}: 'url' is required`);
    if (!URL.canParse(r.url)) throw new Error(`${where}: invalid url '${r.url}'`);
    if (r.priority !== undefined && r.priority !== "important" && r.priority !== "normal") {
      throw new Error(`${where}: priority must be 'important' or 'normal'`);
    }
    if (out.has(r.url)) throw new Error(`${where}: duplicate url ${r.url}`);
    out.set(r.url, {
      url: r.url,
      priority: r.priority,
      muted: r.muted === true,
      note: r.note,
      manual: r.manual === true,
      title: r.title,
    });
  });
  return out;
}

export async function loadIntent(path: string): Promise<Intent> {
  const file = Bun.file(path);
  return (await file.exists()) ? parseIntent(await file.text()) : new Map();
}

/**
 * Re-keys the intent by canonical item URL (as stored in the cache), so URLs copied from
 * the browser (trailing slash, PR tab, #fragment, …) still match. Manual entries are kept
 * as they are; other entries that no adapter recognizes are dropped and listed in `unknown`.
 */
export function canonicalizeIntent(
  intent: Intent,
  refFromUrl: (url: string) => ItemRef | null,
): { intent: Intent; unknown: string[] } {
  const out: Intent = new Map();
  const unknown: string[] = [];
  for (const entry of intent.values()) {
    const url = entry.manual ? entry.url : refFromUrl(entry.url)?.url;
    if (!url) {
      unknown.push(entry.url);
      continue;
    }
    if (out.has(url)) throw new Error(`items.yaml: duplicate url ${url} (${entry.url} is the same item as an earlier entry)`);
    out.set(url, { ...entry, url });
  }
  return { intent: out, unknown };
}

/**
 * Explicit priority wins; otherwise PRs/MRs/patches I authored, or that were sent to a repo I
 * maintain, are important, and everything else is normal.
 */
export function effectivePriority(
  entry: IntentEntry | undefined, kind: ItemKind, authoredByMe: boolean, maintainedByMe = false,
): Priority {
  return entry?.priority ?? (kind === "pr" && (authoredByMe || maintainedByMe) ? "important" : "normal");
}
