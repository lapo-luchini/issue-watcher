import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import { openContext } from "../src/core/context.ts";

function home(config: string | null): string {
  const dir = tmpDir("ctx");
  mkdirSync(join(dir, "data"));
  if (config !== null) writeFileSync(join(dir, "data/config.yaml"), config);
  return dir;
}

afterEach(cleanupTmp);

const CONFIG = "instances:\n  - {id: github, type: github, url: https://api.github.com, user: lapo}\ncommit_branch: mine\n";

test("openContext: config, canonical URLs, commit branch, a cache under var/", async () => {
  const dir = home(CONFIG);
  const ctx = await openContext(dir);
  try {
    expect(ctx.where).toEqual({ home: dir, branch: "mine" });
    expect(ctx.canonical("https://github.com/foo/bar/pull/42/files")).toBe("https://github.com/foo/bar/pull/42");
    expect(ctx.canonical("https://lists.example.org/p1")).toBe("https://lists.example.org/p1");
    expect(ctx.store.listItems()).toEqual([]);
  } finally {
    ctx.store.close();
  }
});

test("openContext: items.yaml is read on every call, and may be missing", async () => {
  const dir = home(CONFIG);
  const ctx = await openContext(dir);
  try {
    expect((await ctx.intent()).size).toBe(0);
    writeFileSync(join(dir, "data/items.yaml"), "items:\n  - url: https://github.com/foo/bar/pull/42/files\n    muted: true\n");
    expect((await ctx.intent()).get("https://github.com/foo/bar/pull/42")?.muted).toBe(true);
  } finally {
    ctx.store.close();
  }
});

test("openContext: a missing config fails before anything is created", async () => {
  const dir = home(null);
  await expect(openContext(dir)).rejects.toThrow("config file not found");
  expect(Bun.file(join(dir, "var/cache.sqlite")).size).toBe(0);
});
