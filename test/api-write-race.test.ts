// Two processes (say the web server and `watcher mcp`) changing items.yaml at the same time.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withItemsLock } from "../src/core/api.ts";
import { lockHolder } from "../src/core/store.ts";

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "watcher-race-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@example.org"]]) {
    Bun.spawnSync(["git", "-C", home, ...args]);
  }
  mkdirSync(join(home, "data"));
  writeFileSync(join(home, "data/items.yaml"), "items:\n");
  Bun.spawnSync(["git", "-C", home, "add", "data/items.yaml"]);
  Bun.spawnSync(["git", "-C", home, "commit", "-qm", "init"]);
  return home;
}

test("changes made by two processes at once are all kept, and each committed", async () => {
  const home = newHome();
  const run = (tag: string) => Bun.spawn([process.execPath, join(import.meta.dir, "items-writer.ts"), home, tag, "12"], { stderr: "inherit" }).exited;
  expect(await Promise.all([run("a"), run("b")])).toEqual([0, 0]);
  expect(readFileSync(join(home, "data/items.yaml"), "utf8").match(/note:/g)).toHaveLength(24);
  const committed = Bun.spawnSync(["git", "-C", home, "show", "config:data/items.yaml"]).stdout.toString();
  expect(committed.match(/note:/g)).toHaveLength(24);
}, 60_000);

const notes = (home: string) => readFileSync(join(home, "data/items.yaml"), "utf8").match(/note:/g)?.length ?? 0;
const lockFile = (home: string) => join(home, "var/items.lock");
const makeLock = (home: string, content: string, ageSeconds: number) => {
  mkdirSync(join(home, "var"), { recursive: true });
  writeFileSync(lockFile(home), content);
  const t = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(lockFile(home), t, t);
};

test("writers that all find the same stale lock do not both take it over", async () => {
  const home = newHome();
  const writers = 8;
  for (let round = 1; round <= 25; round++) {
    makeLock(home, "crashed", 180);
    const start = String(Date.now() + 500);
    const run = (tag: string) => Bun.spawn([process.execPath, join(import.meta.dir, "items-writer.ts"), home, tag, "1", start], { stderr: "inherit" }).exited;
    await Promise.all(Array.from({ length: writers }, (_, w) => run(`r${round}w${w}`)));
    expect(notes(home)).toBe(round * writers);
  }
}, 120_000);

test("a lock taken over while its first holder still ran is not released by that holder", async () => {
  const home = newHome();
  await withItemsLock(home, async () => {
    writeFileSync(lockFile(home), "someone else"); // what a takeover leaves
  });
  expect(readFileSync(lockFile(home), "utf8")).toBe("someone else");
});

test("a lock left by a process that has exited is taken over at once", async () => {
  const home = newHome();
  const gone = Bun.spawnSync(["true"]);
  makeLock(home, lockHolder(gone.pid), 5);
  const t0 = Date.now();
  await withItemsLock(home, async () => {});
  expect(Date.now() - t0).toBeLessThan(2000);
}, 10_000);

test("a recent lock of a live process is waited for", async () => {
  const home = newHome();
  makeLock(home, lockHolder(), 5);
  let got = false;
  const waiting = withItemsLock(home, async () => void (got = true));
  await Bun.sleep(300);
  expect(got).toBe(false);
  unlinkSync(lockFile(home)); // the holder lets go
  await waiting;
  expect(got).toBe(true);
});

test("a break claim left by a process that has exited does not hold the others up", async () => {
  const home = newHome();
  const gone = Bun.spawnSync(["true"]);
  makeLock(home, lockHolder(gone.pid), 5);
  writeFileSync(`${lockFile(home)}.break`, `${lockHolder(gone.pid)} claim`); // killed between taking the claim and dropping it
  const t0 = Date.now();
  await withItemsLock(home, async () => {});
  expect(Date.now() - t0).toBeLessThan(2000);
}, 40_000);

const leftovers = (home: string) => readdirSync(join(home, "var")).filter((f) => f.startsWith("items.lock.")).sort();

test("waiting for a lock that is never let go ends in an error after the time given, leaving nothing of ours", async () => {
  const home = newHome();
  makeLock(home, lockHolder(), 5);
  const t0 = Date.now();
  await expect(withItemsLock(home, async () => {}, 300)).rejects.toThrow("items.yaml is locked by another process");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  expect(readFileSync(lockFile(home), "utf8")).toBe(lockHolder()); // still the other's
  expect(leftovers(home)).toEqual([]);
});

test("a lock taken and let go leaves only what the next one needs: nothing", async () => {
  const home = newHome();
  await withItemsLock(home, async () => {});
  expect(readdirSync(join(home, "var"))).toEqual([]);
});

test("deciding that a lock is stale does not keep its file open", async () => {
  const home = newHome();
  const open = () => readdirSync("/proc/self/fd").length;
  const takeOver = async () => {
    makeLock(home, lockHolder(Bun.spawnSync(["true"]).pid), 5);
    await withItemsLock(home, async () => {});
  };
  await takeOver(); // whatever the runtime opens once
  const before = open();
  for (let i = 0; i < 10; i++) await takeOver();
  expect(open()).toBeLessThanOrEqual(before); // a leaked descriptor per takeover would add ten
});

test("a lock is not taken over while another process holds the break claim, however stale the lock", async () => {
  const home = newHome();
  makeLock(home, lockHolder(Bun.spawnSync(["true"]).pid), 5);
  writeFileSync(`${lockFile(home)}.break`, `${lockHolder()} claim`); // a live process is looking at the lock
  let got = false;
  const waiting = withItemsLock(home, async () => void (got = true));
  await Bun.sleep(300);
  expect(got).toBe(false);
  expect(readFileSync(`${lockFile(home)}.break`, "utf8")).toBe(`${lockHolder()} claim`); // its claim is still its own
  unlinkSync(`${lockFile(home)}.break`);
  await waiting;
  expect(got).toBe(true);
});

test("a break claim older than a minute is dropped even when its process still runs", async () => {
  const home = newHome();
  makeLock(home, lockHolder(Bun.spawnSync(["true"]).pid), 5);
  const claim = `${lockFile(home)}.break`;
  writeFileSync(claim, `${lockHolder()} claim`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(claim, old, old);
  const t0 = Date.now();
  await withItemsLock(home, async () => {});
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("the file of a process killed before it could link or drop its lock is cleaned up by the next; a live one's is not", async () => {
  const home = newHome();
  mkdirSync(join(home, "var"), { recursive: true });
  const orphan = join(home, "var/items.lock.11111111-2222-3333-4444-555555555555");
  const live = join(home, "var/items.lock.66666666-7777-8888-9999-000000000000");
  writeFileSync(orphan, `${lockHolder(Bun.spawnSync(["true"]).pid)} 11111111-2222-3333-4444-555555555555`);
  writeFileSync(live, `${lockHolder()} 66666666-7777-8888-9999-000000000000`);
  await withItemsLock(home, async () => {});
  expect(leftovers(home)).toEqual([live.split("/").pop()!]);
});
