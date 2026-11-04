// End-to-end checks of CLI argument handling, against a throwaway WATCHER_HOME (no network).
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemId, Store } from "../src/core/store.ts";

const PR = "https://github.com/foo/bar/pull/42";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "watcher-cli-"));
  mkdirSync(join(home, "data"));
  mkdirSync(join(home, "var"));
  writeFileSync(join(home, "data/config.yaml"), "instances:\n  - {id: github, type: github, url: https://api.github.com, user: lapo}\n");
  const store = new Store(join(home, "var/cache.sqlite"));
  store.upsertItem({
    url: PR, id: itemId(PR), instance: "github", kind: "pr", repo: "foo/bar", title: "Fix build",
    state: "open", stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: true, labels: [],
    lastSignalAt: "2026-11-04T10:00:00.000Z", lastSignalSummary: "comment by @maint: LGTM", seenAt: null,
    baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-04T10:00:00.000Z", snapshotJson: null,
  });
  store.close();
});

function watcher(...args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, WATCHER_HOME: home },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function seenAt(): string | null {
  const store = new Store(join(home, "var/cache.sqlite"));
  try {
    return store.getItem(PR)?.seenAt ?? null;
  } finally {
    store.close();
  }
}

test("seen without URLs refuses to mark everything", () => {
  const r = watcher("seen");
  expect(r.code).toBe(2);
  expect(r.err).toContain("seen --all");
  expect(seenAt()).toBeNull();
});

test("seen --all marks every item", () => {
  const r = watcher("seen", "--all");
  expect(r).toMatchObject({ code: 0, out: "1 item(s) marked seen\n" });
  expect(seenAt()).not.toBeNull();
});

test("seen URL marks that item; an unknown URL gets a hint", () => {
  expect(watcher("seen", PR)).toMatchObject({ code: 0, out: "1 item(s) marked seen\n" });
  const r = watcher("seen", `${PR}/files`);
  expect(r.out).toContain("0 item(s) marked seen");
  expect(r.err).toContain(`no item with URL ${PR}/files`);
  expect(r.err).toContain("canonical");
});
