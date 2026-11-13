import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

const PR = "https://github.com/foo/bar/pull/42";

async function withRegisters(files: Record<string, string>, body: (ctx: Awaited<ReturnType<typeof openContext>>, dir: string) => Promise<void>) {
  const dir = home(CONFIG);
  mkdirSync(join(dir, "data/registers"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const ctx = await openContext(dir);
  try {
    await body(ctx, dir);
  } finally {
    ctx.store.close();
  }
}

test("openContext: a register is read from its file, by canonical URL, and does not see the others", async () => {
  await withRegisters({
    "data/items.yaml": `items:\n  - url: ${PR}\n    muted: true\n`,
    "data/registers/houston.yaml": `items:\n  - url: ${PR}/files\n    priority: important\n    note: n\n`,
  }, async (ctx) => {
    expect(ctx.registers()).toEqual(["default", "houston"]);
    const houston = await ctx.intent("houston");
    expect([...houston.keys()]).toEqual([PR]);
    expect(houston.get(PR)).toMatchObject({ priority: "important", muted: false, note: "n" });
    expect((await ctx.intent("default")).get(PR)?.muted).toBe(true);
    expect((await ctx.intent()).get(PR)?.muted).toBe(true);
  });
});

test("openContext: a register that has no file is an error; default without its file is empty", async () => {
  await withRegisters({}, async (ctx) => {
    expect((await ctx.intent("default")).size).toBe(0);
    await expect(ctx.intent("nope")).rejects.toThrow("no such register: nope");
    await expect(ctx.intent("../x")).rejects.toThrow("invalid register name");
  });
});

test("openContext: a register file that cannot be read names itself, not items.yaml", async () => {
  await withRegisters({ "data/registers/bad.yaml": "items:\n  - url: nope\n" }, async (ctx) => {
    await expect(ctx.intent("bad")).rejects.toThrow("registers/bad.yaml: items[0]: invalid url");
  });
});

test("openContext: a broken register is skipped (with a warning) by the poll's union, not fatal; a broken default still is", async () => {
  await withRegisters({
    "data/items.yaml": `items:\n  - url: ${PR}\n`,
    "data/registers/bad.yaml": "items:\n  - url: nope\n",
  }, async (ctx, dir) => {
    const warn: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void warn.push(a.join(" "));
    try {
      expect([...(await ctx.allIntent()).keys()]).toEqual([PR]);
    } finally {
      console.error = orig;
    }
    expect(warn.join("\n")).toContain("registers/bad.yaml skipped");
    writeFileSync(join(dir, "data/items.yaml"), "items:\n  - url: nope\n");
    await expect(ctx.allIntent()).rejects.toThrow("items.yaml");
  });
});

test("openContext: a link or a directory in data/registers/ is not a register, to read or to list", async () => {
  await withRegisters({ "outside.yaml": "items:\n  - url: nope-secret\n" }, async (ctx, dir) => {
    symlinkSync(join(dir, "outside.yaml"), join(dir, "data/registers/link.yaml"));
    mkdirSync(join(dir, "data/registers/dir.yaml"));
    expect(ctx.registers()).toEqual(["default"]);
    await expect(ctx.intent("link")).rejects.toThrow("no such register: link");
    await expect(ctx.intent("dir")).rejects.toThrow("no such register: dir");
  });
});

test("openContext: the entries of every register as one, read on every call", async () => {
  await withRegisters({
    "data/items.yaml": `items:\n  - url: ${PR}\n`,
    "data/registers/a.yaml": `items:\n  - url: ${PR}\n    priority: important\n  - url: https://github.com/foo/bar/issues/1\n`,
  }, async (ctx, dir) => {
    const all = await ctx.allIntent();
    expect([...all.keys()].sort()).toEqual(["https://github.com/foo/bar/issues/1", PR]);
    expect(all.get(PR)?.priority).toBe("important");
    writeFileSync(join(dir, "data/registers/b.yaml"), "items:\n  - url: https://github.com/foo/bar/issues/2\n");
    expect((await ctx.allIntent()).size).toBe(3);
  });
});
