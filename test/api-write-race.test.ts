// Two processes (say the web server and `watcher mcp`) changing items.yaml at the same time.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
