// data/subscriptions.yaml: reading it and editing it (comments and order kept).
import { expect, test } from "bun:test";
import { editSubscriptions, parseSubscriptions, subscriptionFromEnv, SubscriptionError } from "../src/core/subscriptions.ts";

const A = "https://github.com/foo/bar/pull/1";
const B = "https://github.com/foo/bar/pull/2";
const strip = (u: string) => u.replace(/\/files$/, "");

test("a subscription has a name, a register (default when absent) and a scope: all, or a list of URLs (none when absent)", () => {
  const subs = parseSubscriptions(`subscriptions:
  - name: houston
    scope: all
    exclude: [${B}]
  - name: vault
    register: vault
    scope:
      - ${A}
  - name: bare
`);
  expect([...subs.keys()]).toEqual(["houston", "vault", "bare"]);
  expect(subs.get("houston")).toEqual({ name: "houston", register: "default", scope: "all", exclude: [B] });
  expect(subs.get("vault")).toEqual({ name: "vault", register: "vault", scope: [A], exclude: [] });
  expect(subs.get("bare")).toEqual({ name: "bare", register: "default", scope: [], exclude: [] });
  expect(parseSubscriptions("").size).toBe(0);
});

test("a wrong file is told as it is, with the file name and the place, no path", () => {
  const bad = (text: string, message: string) => expect(() => parseSubscriptions(text)).toThrow(message);
  bad("subscriptions: 3", "subscriptions.yaml: 'subscriptions' must be a list");
  bad("subscriptions:\n  - scope: all\n", "subscriptions.yaml: subscriptions[0]: 'name' is required");
  bad("subscriptions:\n  - name: Bad Name\n", "subscriptions.yaml: subscriptions[0]: invalid name 'Bad Name'");
  bad("subscriptions:\n  - name: a\n  - name: a\n", "subscriptions.yaml: subscriptions[1]: duplicate name a");
  bad("subscriptions:\n  - name: a\n    scope: some\n", "subscriptions.yaml: subscriptions[0]: 'scope' must be all or a list of URLs");
  bad("subscriptions:\n  - name: a\n    scope: [ftp://x/y]\n", "subscriptions.yaml: subscriptions[0]: invalid url 'ftp://x/y'");
  bad("subscriptions:\n  - name: a\n    exclude: x\n", "subscriptions.yaml: subscriptions[0]: 'exclude' must be a list of URLs");
  bad("subscriptions:\n  - name: a\n    register: No_Good\n", "subscriptions.yaml: subscriptions[0]: invalid register name");
  bad("subscriptions:\n  - name: a\n    excludes: []\n", "subscriptions.yaml: subscriptions[0]: unknown field 'excludes'");
});

test("WATCHER_SUBSCRIPTION names the default subscription; nothing, or empty, is none; a bad name is told", () => {
  expect(subscriptionFromEnv({})).toBeUndefined();
  expect(subscriptionFromEnv({ WATCHER_SUBSCRIPTION: "" })).toBeUndefined();
  expect(subscriptionFromEnv({ WATCHER_SUBSCRIPTION: "houston" })).toBe("houston");
  expect(() => subscriptionFromEnv({ WATCHER_SUBSCRIPTION: "../x" })).toThrow(SubscriptionError);
});

test("define creates a subscription (explicit and empty, or all) and keeps what is there", () => {
  const t1 = editSubscriptions("", { kind: "define", name: "houston", register: "default", all: true }, strip);
  expect(t1).toBe("subscriptions:\n  - name: houston\n    scope: all\n");
  const t2 = editSubscriptions(t1, { kind: "define", name: "vault", register: "vault", all: false }, strip);
  expect(t2).toBe("subscriptions:\n  - name: houston\n    scope: all\n  - name: vault\n    register: vault\n    scope: []\n");
  // again with another register: the register changes, the scope does not (all was not asked for)
  const t3 = editSubscriptions(t2, { kind: "define", name: "vault", register: "default" }, strip);
  expect(parseSubscriptions(t3).get("vault")).toEqual({ name: "vault", register: "default", scope: [], exclude: [] });
  expect(t3).not.toContain("register: vault");
  expect(editSubscriptions(t3, { kind: "define", name: "vault", register: "default" }, strip)).toBe(t3); // nothing to change
});

test("follow adds a URL to an explicit scope once, creating the subscription when absent; comments stay", () => {
  const t1 = editSubscriptions("# mine\nsubscriptions: []\n", { kind: "follow", name: "houston", url: A, register: "default" }, strip);
  expect(t1).toBe(`# mine\nsubscriptions:\n  - name: houston\n    scope:\n      - ${A}\n`);
  expect(editSubscriptions(t1, { kind: "follow", name: "houston", url: A, register: "default" }, strip)).toBe(t1);
  // an entry written as a browser URL is the same item
  const t2 = editSubscriptions(`subscriptions:\n  - name: houston\n    scope:\n      - ${A}/files\n`, { kind: "follow", name: "houston", url: A, register: "default" }, strip);
  expect(parseSubscriptions(t2).get("houston")!.scope).toEqual([`${A}/files`]);
  const t3 = editSubscriptions(t1, { kind: "follow", name: "houston", url: B, register: "default" }, strip);
  expect(parseSubscriptions(t3).get("houston")!.scope).toEqual([A, B]);
});

test("follow on an `all` subscription lifts the exclusion of that URL", () => {
  const t = editSubscriptions(`subscriptions:\n  - name: h\n    scope: all\n    exclude:\n      - ${A}\n      - ${B}\n`, { kind: "follow", name: "h", url: A, register: "default" }, strip);
  expect(parseSubscriptions(t).get("h")).toEqual({ name: "h", register: "default", scope: "all", exclude: [B] });
  const t2 = editSubscriptions(t, { kind: "follow", name: "h", url: B, register: "default" }, strip);
  expect(t2).toBe("subscriptions:\n  - name: h\n    scope: all\n"); // no empty list left behind
});

test("unfollow removes the URL from an explicit scope, or excludes it from `all`; an unknown subscription is an error", () => {
  const t = editSubscriptions(`subscriptions:\n  - name: h\n    scope:\n      - ${A}\n      - ${B}\n`, { kind: "unfollow", name: "h", url: A }, strip);
  expect(parseSubscriptions(t).get("h")!.scope).toEqual([B]);
  const t2 = editSubscriptions("subscriptions:\n  - name: h\n    scope: all\n", { kind: "unfollow", name: "h", url: A }, strip);
  expect(parseSubscriptions(t2).get("h")).toMatchObject({ scope: "all", exclude: [A] });
  expect(editSubscriptions(t2, { kind: "unfollow", name: "h", url: A }, strip)).toBe(t2); // once
  expect(() => editSubscriptions(t2, { kind: "unfollow", name: "nope", url: A }, strip)).toThrow("no such subscription: nope");
});

test("a subscriptions file that does not parse is one line naming the file and the line", () => {
  let message = "";
  try {
    parseSubscriptions("subscriptions: [unclosed\n  - : :\n");
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toStartWith("subscriptions.yaml: not valid YAML at line 1");
  expect(message).not.toContain("\n");
});
