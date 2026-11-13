// Two processes (say the web server and `watcher mcp`) changing items.yaml at the same time.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("changes made by two processes at once are all kept, and each committed", async () => {
  const home = mkdtempSync(join(tmpdir(), "watcher-race-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@example.org"]]) {
    Bun.spawnSync(["git", "-C", home, ...args]);
  }
  mkdirSync(join(home, "data"));
  writeFileSync(join(home, "data/items.yaml"), "items:\n");
  Bun.spawnSync(["git", "-C", home, "add", "data/items.yaml"]);
  Bun.spawnSync(["git", "-C", home, "commit", "-qm", "init"]);
  const run = (tag: string) => Bun.spawn([process.execPath, join(import.meta.dir, "items-writer.ts"), home, tag, "12"], { stderr: "inherit" }).exited;
  expect(await Promise.all([run("a"), run("b")])).toEqual([0, 0]);
  expect(readFileSync(join(home, "data/items.yaml"), "utf8").match(/note:/g)).toHaveLength(24);
  const committed = Bun.spawnSync(["git", "-C", home, "show", "config:data/items.yaml"]).stdout.toString();
  expect(committed.match(/note:/g)).toHaveLength(24);
}, 60_000);
