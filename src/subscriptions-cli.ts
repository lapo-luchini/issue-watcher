// The subscription commands of the CLI: updates, ack, subscriptions, subscribe, track, unsubscribe.
import { openContext } from "./core/context.ts";
import { acknowledge, defineSubscription, subscriptionUpdates, trackItem, untrackItem } from "./core/following.ts";
import { checkRegisterName } from "./core/registers.ts";
import { subscriptionFromEnv } from "./core/subscriptions.ts";

export const SUBSCRIPTION_COMMANDS = ["updates", "ack", "subscriptions", "subscribe", "track", "unsubscribe"];

export const SUBSCRIPTION_USAGE = `  updates [--subscription S] [--peek] [--json]  the news S has not acknowledged (never moves the cursor; --peek says so)
  ack [--subscription S] TOKEN       move S's cursor to the token \`updates\` gave (env: WATCHER_SUBSCRIPTION names S when no flag does)
  subscriptions                      the subscriptions: register, scope, exclusions
  subscribe NAME [--register R] [--all]  make or change a subscription (--all: every entry of R, else one item at a time)
  track [--subscription S] URL       add the item to S's register if absent and follow it
  unsubscribe [--subscription S] URL stop following the item`;

export interface SubscriptionOptions {
  home: string;
  subscription?: string;
  register?: string;
  all?: boolean;
  json?: boolean;
}

export async function runSubscriptionCommand(cmd: string, args: string[], o: SubscriptionOptions): Promise<number> {
  const ctx = await openContext(o.home);
  try {
    /** The subscription of the flag, else of WATCHER_SUBSCRIPTION; a command that needs one and has none is told so. */
    const named = (): string => {
      const name = o.subscription ?? subscriptionFromEnv(process.env);
      if (!name) throw new Error("no subscription: name one with --subscription or WATCHER_SUBSCRIPTION");
      return name;
    };
    const one = (what: string): string => {
      if (args.length !== 1) throw new Error(`${cmd} takes exactly one ${what}`);
      return args[0]!;
    };
    switch (cmd) {
      case "updates": {
        const r = await subscriptionUpdates(ctx, named());
        if (o.json) {
          console.log(JSON.stringify(r));
          return 0;
        }
        if (r.items.length === 0) console.log(`${r.subscription}: no updates`);
        for (const g of r.items) {
          console.log(`${g.item.repo}  ${g.item.title}`);
          for (const e of g.events) console.log(`  ${e.summary}`);
          console.log(`  ${g.item.url}`);
        }
        if (r.items.length > 0) console.log(`token: ${r.token}  (watcher ack --subscription ${r.subscription} ${r.token})`);
        return 0;
      }
      case "ack": {
        const r = await acknowledge(ctx, named(), one("token"));
        console.log(`${r.subscription}: read up to ${r.cursor}`);
        return 0;
      }
      case "subscriptions": {
        for (const s of (await ctx.subscriptions()).values()) {
          const scope = s.scope === "all" ? "all" : `${s.scope.length} item(s)`;
          console.log(`${s.name}  register ${s.register}  ${scope}${s.exclude.length ? `, ${s.exclude.length} excluded` : ""}`);
        }
        return 0;
      }
      case "subscribe": {
        const name = args[0] ?? o.subscription ?? subscriptionFromEnv(process.env);
        if (!name || args.length > 1) throw new Error("subscribe takes one subscription name");
        const register = o.register === undefined ? undefined : checkRegisterName(o.register);
        const r = await defineSubscription(ctx, name, { register, all: o.all ? true : undefined });
        console.log(`${r.subscription}: subscribed`);
        if (r.warning) console.error(`watcher: warning: ${r.warning}`);
        return 0;
      }
      case "track": {
        const r = await trackItem(ctx, named(), one("URL"));
        console.log(`${r.subscription}: following ${r.url}${r.added ? " (added to the register)" : ""}`);
        console.log(r.item ? `${r.item.repo}  ${r.item.title}  [${r.item.state}]  ${r.item.lastSignalSummary ?? "no news yet"}` : "not fetched yet: the next poll fetches it");
        if (r.warning) console.error(`watcher: warning: ${r.warning}`);
        return 0;
      }
      default: {
        const r = await untrackItem(ctx, named(), one("URL"));
        console.log(`${r.subscription}: no longer following ${r.url}`);
        if (r.warning) console.error(`watcher: warning: ${r.warning}`);
        return 0;
      }
    }
  } finally {
    ctx.store.close();
  }
}
