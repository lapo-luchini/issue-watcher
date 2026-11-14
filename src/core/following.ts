// What a subscription does: read the news after its cursor, acknowledge it, follow and unfollow items.
// The definitions are in data/subscriptions.yaml (written like a register: one lock, one commit);
// the cursor and the floors are state in the cache.
import {
  addItem, AlreadyTrackedError, eventView, itemLabel, listItems, rewriteFile, serialized, type ItemUpdates, type ItemView,
} from "./api.ts";
import type { Context } from "./context.ts";
import type { CommitResult } from "./intent.ts";
import { DEFAULT_REGISTER, RegisterError } from "./registers.ts";
import { checkSubscriptionName, checkSubscriptionsFile, editSubscriptions, SUBSCRIPTIONS_FILE, SubscriptionError, type Subscription } from "./subscriptions.ts";

export interface SubscriptionUpdates {
  subscription: string;
  /** What `ack` takes to move the cursor past everything this answer was made from. */
  token: string;
  items: ItemUpdates[];
}

/** The subscription called `name`; SubscriptionError when there is none. */
async function need(ctx: Context, name: string): Promise<Subscription> {
  const sub = (await ctx.subscriptions()).get(checkSubscriptionName(name));
  if (!sub) throw new SubscriptionError(`no such subscription: ${name}`);
  return sub;
}

const tokenOf = (name: string, seq: number) => `${name}.${seq}`;

/**
 * The news a subscription has not acknowledged: events numbered after its cursor, of the items in
 * its register and scope, not muted by the register, not excluded; the global noise filter has
 * already decided what is news. The cursor does not move. The token stands for everything up to the
 * newest number there was when the read began, so an event stored while the read ran is in the next
 * answer, and a filtered-out one is passed by the acknowledgement. A subscription that has no
 * cursor yet starts one now: it is given what comes after.
 */
export async function subscriptionUpdates(ctx: Context, name: string): Promise<SubscriptionUpdates> {
  const sub = await need(ctx, name);
  const { store } = ctx;
  const cursor = store.startCursor(sub.name);
  const upTo = store.maxSeq(); // before the events are read: a number stored meanwhile is above it
  const items = new Map(listItems(store, await ctx.intent(sub.register), { register: sub.register }).map((v) => [v.url, v]));
  const inScope = sub.scope === "all" ? () => true : ((urls) => (url: string) => urls.has(url))(new Set(sub.scope));
  const excluded = new Set(sub.exclude);
  const floors = sub.scope === "all" ? new Map<string, number>() : store.floors(sub.name);
  const groups = new Map<string, ItemUpdates>();
  for (const e of store.signalEventsBetween(cursor, upTo)) {
    const item = items.get(e.itemUrl); // muted, or not in the register
    if (!item || !inScope(item.url) || excluded.has(item.url) || e.seq <= (floors.get(item.url) ?? 0)) continue;
    let group = groups.get(item.url);
    if (!group) groups.set(item.url, (group = { item, events: [] }));
    group.events.push(eventView(e));
  }
  return { subscription: sub.name, token: tokenOf(sub.name, upTo), items: [...groups.values()] };
}

/** Moves the cursor to the token's point (forward only) and returns where it is. A token of another subscription or not given by a read is refused. */
export async function acknowledge(ctx: Context, name: string, token: string): Promise<{ subscription: string; cursor: number }> {
  const sub = await need(ctx, name);
  const m = token.match(/^(.+)\.(\d+)$/);
  if (!m || m[1] !== sub.name) throw new SubscriptionError(`that token is not from ${sub.name}'s updates`);
  ctx.store.startCursor(sub.name);
  const cursor = ctx.store.advanceCursor(sub.name, Number(m[2]));
  if (cursor === null) throw new SubscriptionError("unknown token: read the updates again");
  return { subscription: sub.name, cursor };
}

export interface FollowResult {
  subscription: string;
  url: string;
  /** The item as the subscription's register has it now; null while the poll has not fetched it yet. */
  item: ItemView | null;
  warning: string | null;
}

async function itemIn(ctx: Context, register: string, url: string): Promise<ItemView | null> {
  const intent = ctx.registers().includes(register) ? await ctx.intent(register) : new Map();
  return listItems(ctx.store, intent, { includeMuted: true, register }).find((v) => v.url === url) ?? null;
}

const warningOf = (r: CommitResult) => (r.ok ? null : (r.warning ?? "not committed"));

/** Creates the subscription, or changes its register and scope. `all` true: every entry of the register; false: only what is followed one by one. */
export async function defineSubscription(ctx: Context, name: string, opts: { register?: string; all?: boolean } = {}): Promise<{ subscription: string; warning: string | null }> {
  checkSubscriptionName(name);
  const existing = (await ctx.subscriptions()).get(name);
  const register = opts.register ?? existing?.register ?? DEFAULT_REGISTER;
  if (!ctx.registers().includes(register)) throw new RegisterError(`no such register: ${register}`);
  ctx.store.startCursor(name); // before the file: what is stored while it is written is news
  const r = await serialized(() => rewriteFile(ctx.where, SUBSCRIPTIONS_FILE,
    (t) => editSubscriptions(t, { kind: "define", name, register, all: opts.all }, ctx.canonical), `watcher: subscribe ${name}`, () => checkSubscriptionsFile(ctx.where.home)));
  return { subscription: name, warning: warningOf(r) };
}

/**
 * Adds the item to the subscription's register when it is not in it, follows it (the subscription is
 * created, on `default`, when there is none) and returns where the item stands. Its earlier events
 * are not news: they sit before the number the subscription's explicit scope takes it from.
 */
export async function trackItem(ctx: Context, name: string, url: string): Promise<FollowResult & { added: boolean }> {
  checkSubscriptionName(name);
  const before = (await ctx.subscriptions()).get(name);
  const register = before?.register ?? DEFAULT_REGISTER;
  const canonical = ctx.canonical(url.trim());
  const alreadyFollowed = before !== undefined && (before.scope === "all" || before.scope.includes(canonical));
  const listed = async () => (ctx.registers().includes(register) ? await ctx.intent(register) : new Map()).has(canonical);
  let added = false;
  if (!(await listed())) {
    try {
      const known = ctx.registers().includes(register) ? await ctx.intent(register) : new Map();
      await addItem(ctx.where, ctx.store, known, ctx.recognize, url.trim(), undefined, register);
      added = true;
    } catch (err) {
      // Listed already (or known to the cache, for `default`), or listed by someone else meanwhile: nothing to add.
      if (!(err instanceof AlreadyTrackedError) && !(await listed())) throw err;
    }
  }
  ctx.store.startCursor(name);
  // Before the file (a write that fails leaves a floor on an item not followed). Not for an item already followed: its news so far stays news.
  if (!alreadyFollowed) ctx.store.setFloor(name, canonical);
  const r = await serialized(() => rewriteFile(ctx.where, SUBSCRIPTIONS_FILE,
    (t) => editSubscriptions(t, { kind: "follow", name, url: canonical, register }, ctx.canonical), `watcher: follow ${itemLabel(canonical)} in ${name}`, () => checkSubscriptionsFile(ctx.where.home)));
  return { subscription: name, url: canonical, item: await itemIn(ctx, register, canonical), added, warning: warningOf(r) };
}

/** Stops following the item: out of an explicit scope, or on the exclusion list of an `all` one. The register keeps it. */
export async function untrackItem(ctx: Context, name: string, url: string): Promise<FollowResult> {
  const sub = await need(ctx, name);
  const canonical = ctx.canonical(url.trim());
  const r = await serialized(() => rewriteFile(ctx.where, SUBSCRIPTIONS_FILE,
    (t) => editSubscriptions(t, { kind: "unfollow", name, url: canonical }, ctx.canonical), `watcher: unfollow ${itemLabel(canonical)} in ${name}`, () => checkSubscriptionsFile(ctx.where.home)));
  ctx.store.dropFloor(name, canonical);
  return { subscription: name, url: canonical, item: await itemIn(ctx, sub.register, canonical), warning: warningOf(r) };
}

