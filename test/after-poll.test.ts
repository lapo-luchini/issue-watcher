// The after_poll hook: a program the poll runs once it is done, so a notifier can look at the news.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import { parseConfig } from "../src/core/config.ts";
import { runAfterPoll } from "../src/core/hook.ts";

afterEach(cleanupTmp);

const script = (dir: string, name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

test("config: after_poll is a list of program and arguments, absent by default; a string is refused (no shell)", () => {
  expect(parseConfig("instances: []", {}).afterPoll).toBeUndefined();
  expect(parseConfig("instances: []\nafter_poll: [/bin/true, -x]", {}).afterPoll).toEqual(["/bin/true", "-x"]);
  expect(() => parseConfig("instances: []\nafter_poll: /bin/true", {})).toThrow("'after_poll' must be a list of strings");
  expect(() => parseConfig("instances: []\nafter_poll: []", {})).toThrow("'after_poll' must be a list of strings");
});

test("the hook runs in the watcher's directory with WATCHER_HOME, its arguments as they are (no shell)", async () => {
  const dir = tmpDir("hook");
  const out = join(dir, "out");
  const sh = script(dir, "h.sh", `echo "$PWD|$WATCHER_HOME|$1" > ${out}`);
  expect(await runAfterPoll([sh, "a;b $HOME"], dir)).toBeNull();
  expect(readFileSync(out, "utf8").trim()).toBe(`${dir}|${dir}|a;b $HOME`);
});

test("a hook that is absent, fails or prints is not the poll's failure; its output never reaches ours", async () => {
  const dir = tmpDir("hook");
  expect(await runAfterPoll(undefined, dir)).toBeNull();
  expect(await runAfterPoll([join(dir, "missing")], dir)).toContain("after_poll");
  const fails = script(dir, "f.sh", "echo noise; echo more >&2; exit 3");
  expect(await runAfterPoll([fails], dir)).toBe("after_poll exited with 3");
  const p = Bun.spawnSync([process.execPath, "-e", `import { runAfterPoll } from ${JSON.stringify(join(import.meta.dir, "../src/core/hook.ts"))}; await runAfterPoll([${JSON.stringify(fails)}], ${JSON.stringify(dir)});`]);
  expect(p.stdout.toString()).toBe("");
  expect(p.stderr.toString()).toBe("");
});

test("a hook that does not end is stopped after its time", async () => {
  const dir = tmpDir("hook");
  const marker = join(dir, "late");
  const slow = script(dir, "s.sh", `sleep 5; touch ${marker}`);
  const t = Date.now();
  expect(await runAfterPoll([slow], dir, 200)).toBe("after_poll did not finish in 0.2 s: stopped");
  expect(Date.now() - t).toBeLessThan(3000);
  await Bun.sleep(100);
  expect(existsSync(marker)).toBe(false);
});

test("the poll commands call it: CLI poll, not on a dry run", () => {
  const home = tmpDir("hookcli");
  for (const args of [["init", "-q"], ["config", "user.name", "T"], ["config", "user.email", "t@example.org"]]) Bun.spawnSync(["git", "-C", home, ...args]);
  mkdirSync(join(home, "data"));
  const out = join(home, "ran");
  const sh = script(home, "h.sh", `echo x >> ${out}`);
  writeFileSync(join(home, "data/config.yaml"), `instances: []\nafter_poll: [${sh}]\n`);
  writeFileSync(join(home, "data/items.yaml"), "items:\n");
  const run = (...a: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...a], { env: { ...process.env, WATCHER_HOME: home, WATCHER_REGISTER: "" } });
  expect(run("poll", "--dry-run").exitCode).toBe(0);
  expect(existsSync(out)).toBe(false);
  expect(run("poll").exitCode).toBe(0);
  expect(readFileSync(out, "utf8")).toBe("x\n");
});
