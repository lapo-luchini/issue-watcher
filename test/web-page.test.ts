// The page's HTML without a browser: components rendered to a string, and the bundle the server sends.
import { expect, test } from "bun:test";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import type { SubscriptionStatus } from "../src/core/following.ts";
import { SubscriptionList } from "../web/components/SubscriptionList.ts";
import { TopBar } from "../web/components/TopBar.ts";
import { itemId } from "../src/core/store.ts";

const render = (component: unknown, props: Record<string, unknown>) =>
  renderToString(createSSRApp({ render: () => h(component as Component, props) }));

const FILTERS = { unread: false, important: false, muted: false, instance: "" };
const topbar = (props: Record<string, unknown> = {}) =>
  render(TopBar, { filters: FILTERS, status: null, view: "items", registers: ["default"], register: "default", subscriptionUnseen: 0, ...props });

const PR = "https://github.com/foo/bar/pull/42";
const sub = (over: Partial<SubscriptionStatus> = {}): SubscriptionStatus => ({
  name: "proj", register: "default", scope: "all", exclude: [], cursor: 2, latest: 4, unseen: 0, items: [], error: null, ...over,
});
const list = (props: Record<string, unknown>) => render(SubscriptionList, { subscriptions: [], loaded: true, error: "", checkedAt: "", ...props });

test("the register switcher lists every register and selects the current one", async () => {
  const html = await topbar({ registers: ["default", "houston", "vault"], register: "houston" });
  expect(html).toContain('aria-label="Register"');
  expect(html).toMatch(/<option value="default"[^>]*>default<\/option>/);
  expect(html).toMatch(/<option value="vault"[^>]*>vault<\/option>/);
  expect(html).toMatch(/<select[^>]*value="houston"[^>]*aria-label="Register"/);
});

test("with only default there is no switcher: nothing to choose", async () => {
  expect(await topbar()).not.toContain('aria-label="Register"');
});

test("the nav links the two views, marks the current one and counts what is unseen", async () => {
  const items = await topbar({ subscriptionUnseen: 3 });
  expect(items).toContain('href="#items" aria-current="page"');
  expect(items).toContain('href="#subscriptions"');
  expect(items).not.toMatch(/href="#subscriptions"[^>]*aria-current/);
  expect(items).toContain("3 unseen");
  const subs = await topbar({ view: "subscriptions" });
  expect(subs).toContain('href="#subscriptions" aria-current="page"');
  expect(subs).not.toContain("unseen");
});

test("the subscription view has no item filters, register switcher, adding or mark-all-seen: it only polls", async () => {
  const html = await topbar({ view: "subscriptions", registers: ["default", "houston"] });
  for (const gone of ['aria-label="Filters"', 'aria-label="Register"', "Add item", "Mark all seen"]) expect(html).not.toContain(gone);
  expect(html).toContain("Poll now");
});

test("a subscription shows its name, register, scope, cursor and that it is up to date", async () => {
  const html = await list({ subscriptions: [sub()], checkedAt: "14:05" });
  expect(html).toContain(">proj</h2>");
  expect(html).toContain("default");
  expect(html).toContain("Every item of the register");
  expect(html).toContain("Read up to update 2 of 4");
  expect(html).toContain("Up to date");
  expect(html).toContain("Checked 14:05");
});

test("unseen updates are counted and named by item, with a link only for web URLs", async () => {
  const items = [{ url: PR, id: itemId(PR), title: "Fix build", count: 2 }, { url: "mailto:x@example.org", id: "m1", title: "A list post", count: 1 }];
  const html = await list({ subscriptions: [sub({ unseen: 3, items })] });
  expect(html).toContain("3 unseen updates");
  expect(html).toContain(`href="${PR}"`);
  expect(html).toContain("Fix build");
  expect(html).toContain("A list post");
  expect(html).not.toContain("mailto:");
});

test("an explicit scope lists what it follows, and the exclusions are listed too", async () => {
  const html = await list({ subscriptions: [sub({ scope: [PR] }), sub({ name: "rest", exclude: ["https://github.com/x/y/issues/1"] })] });
  expect(html).toContain("1 item");
  expect(html).toContain(PR);
  expect(html).toContain("Every item of the register except 1");
  expect(html).toContain("https://github.com/x/y/issues/1");
});

test("a subscription that could not be worked out says why, in words", async () => {
  const html = await list({ subscriptions: [sub({ register: "gone", error: "no such register: gone" })] });
  expect(html).toContain("Cannot tell: no such register: gone");
});

test("the empty, error and loading states say what they mean and what to do", async () => {
  expect(await list({})).toContain("No subscriptions yet");
  expect(await list({})).toContain("watcher subscribe");
  expect(await list({ loaded: false })).toContain("Loading");
  const bad = await list({ error: "subscriptions.yaml: bad scope" });
  expect(bad).toContain("subscriptions.yaml: bad scope");
  expect(bad).not.toContain("No subscriptions yet");
});

test("the view is read-only and says where acknowledging happens", async () => {
  const html = await list({ subscriptions: [sub({ unseen: 1, items: [{ url: PR, id: itemId(PR), title: "Fix build", count: 1 }] })] });
  expect(html).not.toContain("<button");
  expect(html).toContain("watcher ack");
});

test("the subscription with news comes first, whatever order the server sent", async () => {
  const html = await list({ subscriptions: [sub({ name: "calm" }), sub({ name: "busy", unseen: 2, items: [{ url: PR, id: "x", title: "T", count: 2 }] })] });
  expect(html.indexOf(">busy</h2>")).toBeLessThan(html.indexOf(">calm</h2>"));
});
