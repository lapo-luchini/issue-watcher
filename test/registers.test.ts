import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import type { Intent, IntentEntry } from "../src/core/intent.ts";
import {
  checkRegisterName, listRegisterNames, mergeIntents, registerFile, registerFromEnv, RegisterError,
} from "../src/core/registers.ts";

afterEach(cleanupTmp);

test("the default register is data/items.yaml, any other is data/registers/<name>.yaml", () => {
  expect(registerFile("default")).toBe("data/items.yaml");
  expect(registerFile("houston")).toBe("data/registers/houston.yaml");
  expect(registerFile("a-b_c9")).toBe("data/registers/a-b_c9.yaml");
});

test("a name that is not a plain lowercase file name is refused, whatever the way in", () => {
  for (const bad of ["", "..", "../x", "a/b", ".hidden", "-x", "_x", "A", "a b", "a.yaml", "a\u0000b", "x".repeat(65), "é"]) {
    expect(() => checkRegisterName(bad)).toThrow(RegisterError);
    expect(() => registerFile(bad)).toThrow(RegisterError);
  }
  expect(() => checkRegisterName("..")).toThrow("invalid register name '..'");
});

test("WATCHER_REGISTER names the register to use; unset or empty means default; a bad name is an error", () => {
  expect(registerFromEnv({})).toBe("default");
  expect(registerFromEnv({ WATCHER_REGISTER: "" })).toBe("default");
  expect(registerFromEnv({ WATCHER_REGISTER: "houston" })).toBe("houston");
  expect(() => registerFromEnv({ WATCHER_REGISTER: "../etc" })).toThrow(RegisterError);
});

test("registers: default first (even without its file), then the files of data/registers/ by name", () => {
  const home = tmpDir("reg");
  expect(listRegisterNames(home)).toEqual(["default"]);
  mkdirSync(join(home, "data/registers"), { recursive: true });
  for (const f of ["zeta.yaml", "alpha.yaml", "default.yaml", "Bad Name.yaml", "notes.txt", ".hidden.yaml"]) {
    writeFileSync(join(home, "data/registers", f), "items:\n");
  }
  mkdirSync(join(home, "data/registers/sub.yaml")); // a directory is not a register
  expect(listRegisterNames(home)).toEqual(["default", "alpha", "zeta"]);
});

const entry = (url: string, extra: Partial<IntentEntry> = {}): IntentEntry => ({ url, muted: false, manual: false, ...extra });
const intent = (...entries: IntentEntry[]): Intent => new Map(entries.map((e) => [e.url, e]));

test("merging registers: every URL once; important wins; else the priority all state; else none", () => {
  const merged = mergeIntents([
    intent(entry("https://a/1", { priority: "normal" }), entry("https://a/2"), entry("https://a/3", { priority: "normal" })),
    intent(entry("https://a/1", { priority: "important" }), entry("https://a/2", { priority: "normal" }), entry("https://a/3", { priority: "important" })),
    intent(entry("https://a/3", { priority: "normal" }), entry("https://a/4"), entry("https://a/5", { priority: "normal" })),
    intent(entry("https://a/5", { priority: "normal" })),
  ]);
  expect([...merged.keys()]).toEqual(["https://a/1", "https://a/2", "https://a/3", "https://a/4", "https://a/5"]);
  expect(merged.get("https://a/1")?.priority).toBe("important");
  expect(merged.get("https://a/2")?.priority).toBeUndefined(); // one says normal, one leaves it to the automatic rule
  expect(merged.get("https://a/3")?.priority).toBe("important");
  expect(merged.get("https://a/4")?.priority).toBeUndefined();
  expect(merged.get("https://a/5")?.priority).toBe("normal");
});

test("merging registers: an entry is manual only if every register lists it as manual", () => {
  const a = intent(entry("https://a/1", { manual: true }), entry("https://a/2", { manual: true }));
  const b = intent(entry("https://a/1"), entry("https://a/2", { manual: true }));
  const merged = mergeIntents([a, b]);
  expect(merged.get("https://a/1")?.manual).toBe(false);
  expect(merged.get("https://a/2")?.manual).toBe(true);
});

test("merging does not change the registers it was given", () => {
  const a = intent(entry("https://a/1", { priority: "normal" }));
  mergeIntents([a, intent(entry("https://a/1", { priority: "important" }))]);
  expect(a.get("https://a/1")?.priority).toBe("normal");
});
