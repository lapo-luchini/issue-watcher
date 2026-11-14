// Processes at once: the subscription file shares the one lock with the registers, and the cursor loses no event
// that is stored while a reader reads and acknowledges.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import { openContext } from "../src/core/context.ts";
import { acknowledge, defineSubscription, subscriptionUpdates } from "../src/core/following.ts";
import { itemId } from "../src/core/store.ts";

afterEach(cleanupTmp);

const gitOut = (home: string, ...args: string[]) => Bun.spawnSync(["git", "-C", home, ...args]).stdout.toString();
function newHome(): string {
  const home = tmpDir("subrace");
  for (const args of [["init", "-q"], ["config", "user.name", "T"], ["config", "user.email", "t@example.org"]]) gitOut(home, ...args);
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data/config.yaml"), "instances:\n  - {id: github, type: github, url: https://api.github.com, user: lapo}\n");
  writeFileSync(join(home, "data/items.yaml"), "items: []\n");
  gitOut(home, "add", "-f", "."), gitOut(home, "commit", "-qm", "init");
  return home;
}
const run = (script: string, ...args: string[]) => Bun.spawn([process.execPath, join(import.meta.dir, script), ...args], { stderr: "inherit" }).exited;
const follow = (home: string, name: string, tag: string, count: number, start = "") => run("subscription-writer.ts", home, name, tag, String(count), start);
const note = (home: string, tag: string, count: number, start = "") => run("items-writer.ts", home, tag, String(count), start, "");
const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

test("writers of the subscription file and of a register at once lose nothing, each change its own commit", async () => {
  const home = newHome();
  const start = String(Date.now() + 500);
  expect(await Promise.all([follow(home, "p", "a", 10, start), follow(home, "p", "b", 10, start), follow(home, "q", "c", 10, start), note(home, "n", 10, start)])).toEqual([0, 0, 0, 0]);
  const subs = gitOut(home, "show", "config:data/subscriptions.yaml");
  expect(count(subs, /lists\.example\.org\/[abc]\d/g)).toBe(30);
  expect(count(gitOut(home, "show", "config:data/items.yaml"), /note:/g)).toBe(10);
  expect(gitOut(home, "rev-list", "--count", "config")).toBe(String(1 + 40) + "\n");
  expect(readFileSync(join(home, "data/subscriptions.yaml"), "utf8")).toBe(subs);
}, 120_000);

test("two processes following at once, when each finds the same stale lock, do not both take it over", async () => {
  const home = newHome();
  const { mkdirSync: mk, utimesSync } = await import("node:fs");
  for (let round = 1; round <= 6; round++) {
    mk(join(home, "var"), { recursive: true });
    writeFileSync(join(home, "var/items.lock"), "crashed");
    const old = new Date(Date.now() - 180_000);
    utimesSync(join(home, "var/items.lock"), old, old);
    const start = String(Date.now() + 500);
    await Promise.all([follow(home, "p", `r${round}a`, 1, start), follow(home, "q", `r${round}b`, 1, start), note(home, `r${round}n`, 1, start)]);
  }
  expect(count(gitOut(home, "show", "config:data/subscriptions.yaml"), /lists\.example\.org/g)).toBe(12);
  expect(gitOut(home, "rev-list", "--count", "config")).toBe(String(1 + 18) + "\n");
}, 120_000);

test("a reader that reads and acknowledges while two other processes store events gets every event once", async () => {
  const home = newHome();
  const ctx = await openContext(home);
  try {
    await defineSubscription(ctx, "p", { all: true });
    const url = "https://github.com/foo/bar/pull/1";
    writeFileSync(join(home, "data/items.yaml"), `items:\n  - url: ${url}\n`);
    ctx.store.upsertItem({
      url, id: itemId(url), instance: "github", kind: "pr", repo: "foo/bar", title: "t", state: "open", stateDetail: null, ciState: null,
      hasConflicts: false, authoredByMe: false, maintainedByMe: false, labels: [], lastSignalAt: null, lastSignalSummary: null, seenAt: null,
      baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-04T10:00:00.000Z", snapshotJson: null,
    });
    const path = join(home, "var/cache.sqlite");
    const writers = Promise.all([run("event-writer.ts", path, url, "a", "150"), run("event-writer.ts", path, url, "b", "150")]);
    let done = false;
    void writers.then(() => (done = true));
    const got: string[] = [];
    let reads = 0;
    for (let after = false; !after; ) {
      after = done; // one more round after the writers have finished
      const r = await subscriptionUpdates(ctx, "p");
      reads++;
      for (const g of r.items) for (const e of g.events) got.push(e.summary.split(": ").pop()!);
      await acknowledge(ctx, "p", r.token);
    }
    expect(await writers).toEqual([0, 0]);
    expect(reads).toBeGreaterThan(2); // it did read while they wrote
    expect(got).toHaveLength(300);
    expect(new Set(got).size).toBe(300);
    expect(ctx.store.subscriptionCursor("p")).toBe(300);
  } finally {
    ctx.store.close();
  }
}, 120_000);
