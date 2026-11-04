# Watcher — Plan 1: Foundation + GitHub (CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `watcher` CLI that polls GitHub for every PR/issue involving the user, stores all events in a SQLite cache with a signal/noise verdict, and lists items with unread meaningful activity.

**Architecture:** Bun + TypeScript, run directly with no build step. `src/core/` holds the forge-independent logic: config, intent, filter, store, HTTP helper, poller and query API. `src/adapters/` holds one adapter per forge type, which only fetches and normalizes. `src/cli.ts` is a thin front end over `src/core/api.ts` and `src/core/poller.ts`. Spec: `docs/superpowers/specs/2026-11-04-pr-watcher-design.md`.

**Tech Stack:** Bun ≥ 1.4 (`bun:sqlite`, `bun test`), TypeScript 7 (`tsc --noEmit` for type checking only), `yaml` 2.9.

**This is plan 1 of 3.** Plan 2 adds the GitLab, Forgejo and Bugzilla adapters. Plan 3 adds the HTTP API, the Vue UI and writing `items.yaml` with git commits. Each plan is written once the previous one has landed, so it builds on the real interfaces.

**Refinements to the spec decided while writing this plan** (the spec is updated to match):
- `Adapter` gains `refFromUrl(url)`, so items added by hand to `items.yaml` can be fetched, and the UI can later validate pasted URLs.
- `lastSignalAt` is the **detection time** (local clock), stored per event as `events.detected_at`. Unread compares local clock with local clock, and a late-arriving event with an old timestamp (e.g. an old commit pushed now) still counts.
- No ETag conditional requests: discovery only returns changed items, so a conditional fetch would almost never get a `304`. The `etag` column is dropped.
- GitHub's notifications discovery runs on every incremental poll (one cheap call) instead of daily. It is skipped silently if the token cannot read notifications (fine-grained tokens).
- Noise patterns apply only to comments of ≤ 100 normalized characters, so a substantive comment that starts with "Any update" still counts.
- First run discovers **open** items only. Later runs discover anything updated since the cursor, closed and merged included.
- CI: `ci_state` keeps the last *settled* result (`pending` doesn't overwrite it). A first green result is not signal; a first red result, or any later change, is.
- The CLI gains `list` and `seen`, so the tool is usable before the web UI exists.

**Conventions for every task:**
- Work in the repository root (`/project/watcher`). Run `git pull` before starting.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The commands below add it with a second `-m`.
- TypeScript style: plain and readable for a JS developer, i.e. interfaces, annotations and string-literal unions. No enums, no decorators. `any` only at untrusted-input boundaries (parsed YAML/JSON), with a comment saying so.

---

## File map

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `data/config.example.yaml`, `README.md` | project scaffold and docs |
| `src/core/model.ts` | shared types: `ItemRef`, `Snapshot`, `NormalizedEvent`, `Adapter`, `Verdict` |
| `src/core/filter.ts` | `classify(event, priority, cfg)` → signal/noise verdict with reason |
| `src/core/config.ts` | parse `data/config.yaml`, resolve tokens from env |
| `src/core/intent.ts` | parse `data/items.yaml`; `effectivePriority` |
| `src/core/store.ts` | SQLite cache: items, events, poll runs, locks |
| `src/core/http.ts` | `getJson`/`getAllPages`: timeout, retry, `GoneError`, `RateLimitError`, Link pagination |
| `src/core/summary.ts` | one-line summary of an event |
| `src/adapters/github.ts` | GitHub discovery + normalization |
| `src/adapters/index.ts` | `createAdapter(instance)` by type |
| `src/core/poller.ts` | `pollAll`, `pollInstance`, `applySnapshot`, `refilter` |
| `src/core/api.ts` | `listItems`, `markSeen` (shared by CLI and, later, HTTP/MCP) |
| `src/cli.ts` | `poll`, `list`, `seen`, `refilter` |
| `test/*.test.ts` | one test file per module |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `data/config.example.yaml`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "watcher",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "watcher": "src/cli.ts" },
  "scripts": {
    "watcher": "bun src/cli.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `bun add yaml@2.9.1 && bun add -d @types/bun typescript`
Expected: `package.json` gains `"dependencies": {"yaml": "2.9.1"}` and the two devDependencies; `bun.lock` is created.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src", "test", "web"]
}
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
var/
.env
```

- [ ] **Step 5: Create `.env.example`**

```sh
# One variable per instance, named by token_env in data/config.yaml.
GITHUB_TOKEN=
```

- [ ] **Step 6: Create `data/config.example.yaml`**

```yaml
# Instances to poll. Tokens live in .env; token_env names the variable.
# Only the github type is implemented so far; gitlab, forgejo and bugzilla come next.
instances:
  - id: github
    type: github
    url: https://api.github.com
    user: your-github-login
    token_env: GITHUB_TOKEN

# Optional filter tuning (these are the defaults).
filter:
  noise_patterns: ['^\+1$', '^me too', '^same here', '^any update', '^bump$']
  min_comment_length: 20
  bot_allowlist: []
```

- [ ] **Step 7: Verify the toolchain**

Run: `bun --version && bun run tsc --version`
Expected: `1.4.x` (or later) and `Version 7.x`.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock tsconfig.json .gitignore .env.example data/config.example.yaml
git commit -m "Scaffold Bun + TypeScript project for watcher" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared model types

**Files:**
- Create: `src/core/model.ts`

These are only types, so there's nothing to test at runtime. The type checker verifies them, along with every later use.

- [ ] **Step 1: Create `src/core/model.ts`**

```ts
// Shared types. Adapters produce these; the core consumes them.

export type ItemKind = "pr" | "issue" | "bug";
export type ItemState = "open" | "merged" | "closed" | "gone";
export type Priority = "important" | "normal";
export type CiState = "success" | "failure" | "pending";
export type ActorRole = "me" | "maintainer" | "contributor" | "bot" | "unknown";
export type EventKind =
  | "comment" | "review" | "state" | "label" | "milestone" | "push" | "ci"
  | "conflict" | "flag" | "attachment" | "assign" | "mention" | "review_request";

/** Identifies one tracked item. `url` is the canonical web URL and the primary key everywhere. */
export interface ItemRef {
  url: string;
  instance: string;
  kind: ItemKind;
}

/** One thing that happened on an item, in forge-independent form. */
export interface NormalizedEvent {
  key: string; // stable forge-native id, unique within the item
  kind: EventKind;
  actor: string;
  actorRole: ActorRole;
  at: Date;
  body?: string;
  details?: Record<string, unknown>;
}

/** Full current view of one item, as returned by an adapter. */
export interface Snapshot {
  ref: ItemRef;
  repo: string;
  title: string;
  state: ItemState;
  stateDetail?: string;
  ciState?: CiState | null;
  hasConflicts?: boolean;
  authoredByMe: boolean;
  labels: string[];
  events: NormalizedEvent[];
}

/** One forge type. Adapters only talk to the forge and normalize; no filtering, no storage. */
export interface Adapter {
  /** Parse a web URL belonging to this instance, or return null if it is not ours. */
  refFromUrl(url: string): ItemRef | null;
  /** Items involving me that changed since `since` (null: first run, open items only). */
  discover(since: Date | null): Promise<ItemRef[]>;
  /** Full current view of one item. Throws GoneError if it no longer exists. */
  fetch(ref: ItemRef): Promise<Snapshot>;
}

export interface Verdict {
  isSignal: boolean;
  reason: string;
}
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/core/model.ts
git commit -m "Add forge-independent model types shared by adapters and core" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Signal/noise filter

**Files:**
- Create: `src/core/filter.ts`
- Test: `test/filter.test.ts`

Rules (spec §5): own events are never signal. CI, push and conflict events count only on important items. Bots' comments and reviews are noise unless allowlisted, but a bot closing an item is still a state change and counts. Labels and milestones count only when set by a maintainer. Comments from maintainers always count; other comments are noise if emoji-only, if they match a noise pattern (only when ≤ 100 normalized characters), or if they are shorter than `minCommentLength`.

- [ ] **Step 1: Write the failing test `test/filter.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { classify, isEmojiOnly, normalizeText, type FilterConfig } from "../src/core/filter.ts";
import type { ActorRole, EventKind, NormalizedEvent, Priority } from "../src/core/model.ts";

const cfg: FilterConfig = {
  noisePatterns: ["^\\+1$", "^me too", "^same here", "^any update", "^bump$"],
  minCommentLength: 20,
  botAllowlist: ["ci-reporter[bot]"],
};

function ev(kind: EventKind, actorRole: ActorRole, body?: string, actor = "someone"): NormalizedEvent {
  return { key: "k", kind, actor, actorRole, at: new Date("2026-11-01T00:00:00Z"), body };
}

const cases: [string, NormalizedEvent, Priority, boolean, string][] = [
  ["+1 comment", ev("comment", "contributor", "+1"), "important", false, "noise:pattern:^\\+1$"],
  ["+1 with punctuation", ev("comment", "contributor", "+1!"), "important", false, "noise:pattern:^\\+1$"],
  ["emoji only", ev("comment", "contributor", "👍🏻 🎉"), "important", false, "noise:emoji"],
  ["shortcode only", ev("comment", "contributor", ":+1: :tada:"), "important", false, "noise:emoji"],
  ["any update?", ev("comment", "unknown", "Any updates on this?"), "important", false, "noise:pattern:^any update"],
  ["long comment starting with 'any update' counts",
    ev("comment", "contributor", "Any update: I re-tested on 14.1 and the crash persists, backtrace attached below. ".repeat(2)),
    "normal", true, "signal:comment"],
  ["short non-maintainer comment", ev("comment", "contributor", "works for me"), "normal", false, "noise:short"],
  ["short maintainer LGTM", ev("comment", "maintainer", "LGTM"), "normal", true, "signal:maintainer-comment"],
  ["substantive comment", ev("comment", "contributor", "This breaks the build on arm64 with clang 19."), "normal", true, "signal:comment"],
  ["bot comment", ev("comment", "bot", "This issue is stale", "stale[bot]"), "important", false, "noise:bot"],
  ["bot by name only", ev("comment", "unknown", "Coverage report: 87% of lines covered", "codecov"), "important", false, "noise:bot"],
  ["allowlisted bot", ev("comment", "bot", "Build failed on FreeBSD 14 amd64", "ci-reporter[bot]"), "important", true, "signal:comment"],
  ["own comment", ev("comment", "me", "Rebased on main, please take another look."), "important", false, "noise:own"],
  ["review", ev("review", "contributor", ""), "normal", true, "signal:review"],
  ["state change by bot still counts", ev("state", "bot", undefined, "stale[bot]"), "normal", true, "signal:state"],
  ["label by maintainer", ev("label", "maintainer"), "normal", true, "signal:label"],
  ["label by bot", ev("label", "bot", undefined, "github-actions[bot]"), "normal", false, "noise:label-by-non-maintainer"],
  ["CI on important", ev("ci", "unknown"), "important", true, "signal:ci"],
  ["CI on normal", ev("ci", "unknown"), "normal", false, "low-priority:ci"],
  ["push by other on important", ev("push", "contributor"), "important", true, "signal:push"],
  ["own push", ev("push", "me"), "important", false, "noise:own"],
  ["conflict on normal", ev("conflict", "unknown"), "normal", false, "low-priority:conflict"],
  ["bugzilla flag", ev("flag", "maintainer"), "normal", true, "signal:flag"],
  ["mention", ev("mention", "unknown"), "normal", true, "signal:mention"],
];

describe("classify", () => {
  for (const [name, event, priority, isSignal, reason] of cases) {
    test(name, () => {
      expect(classify(event, priority, cfg)).toEqual({ isSignal, reason });
    });
  }
});

describe("helpers", () => {
  test("normalizeText keeps + and drops punctuation", () => {
    expect(normalizeText("  Any UPDATE??  +1! ")).toBe("any update +1");
  });
  test("isEmojiOnly", () => {
    expect(isEmojiOnly("👍")).toBe(true);
    expect(isEmojiOnly("")).toBe(true);
    expect(isEmojiOnly("+1")).toBe(false);
    expect(isEmojiOnly("ok 👍")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/filter.test.ts`
Expected: FAIL with `Cannot find module '../src/core/filter.ts'`.

- [ ] **Step 3: Implement `src/core/filter.ts`**

```ts
// Signal/noise classification. A pure function, so it can later be replaced or
// backed up by another classifier (e.g. an LLM) without touching the poller.
import type { NormalizedEvent, Priority, Verdict } from "./model.ts";

export interface FilterConfig {
  noisePatterns: string[];
  minCommentLength: number;
  botAllowlist: string[];
}

/** Event kinds that only matter on important items. */
const IMPORTANT_ONLY = new Set(["ci", "push", "conflict"]);
/** Noise patterns only apply to short comments, so a long, substantive comment starting with "Any update" still counts. */
const PATTERN_MAX_LENGTH = 100;
const KNOWN_BOTS = new Set([
  "stale", "github-actions", "dependabot", "renovate", "codecov", "coveralls",
  "netlify", "vercel", "sonarcloud", "gitlab-bot", "forgejo-actions",
]);

export function isBot(actor: string): boolean {
  const a = actor.toLowerCase();
  return a.endsWith("[bot]") || a.endsWith("-bot") || KNOWN_BOTS.has(a);
}

/** Lowercase, drop punctuation (keeping '+'), collapse whitespace. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}+\s]/gu, "").replace(/\s+/g, " ").trim();
}

/** True when the body has no words or digits: only emoji, :shortcodes:, punctuation, whitespace. */
export function isEmojiOnly(s: string): boolean {
  const stripped = s
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]/gu, "");
  return !/[\p{L}\p{N}]/u.test(stripped);
}

const signal = (why: string): Verdict => ({ isSignal: true, reason: `signal:${why}` });
const noise = (why: string): Verdict => ({ isSignal: false, reason: `noise:${why}` });

export function classify(ev: NormalizedEvent, priority: Priority, cfg: FilterConfig): Verdict {
  if (ev.actorRole === "me") return noise("own");
  const bot = (ev.actorRole === "bot" || isBot(ev.actor)) && !cfg.botAllowlist.includes(ev.actor);
  if (IMPORTANT_ONLY.has(ev.kind)) {
    return priority === "important" ? signal(ev.kind) : { isSignal: false, reason: `low-priority:${ev.kind}` };
  }
  switch (ev.kind) {
    case "comment":
      return classifyComment(ev, bot, cfg);
    case "review":
      return bot ? noise("bot") : signal("review");
    case "label":
    case "milestone":
      return ev.actorRole === "maintainer" && !bot ? signal(ev.kind) : noise(`${ev.kind}-by-non-maintainer`);
    default:
      return signal(ev.kind);
  }
}

function classifyComment(ev: NormalizedEvent, bot: boolean, cfg: FilterConfig): Verdict {
  if (bot) return noise("bot");
  if (ev.actorRole === "maintainer") return signal("maintainer-comment");
  const body = ev.body ?? "";
  if (isEmojiOnly(body)) return noise("emoji");
  const text = normalizeText(body);
  if (text.length <= PATTERN_MAX_LENGTH) {
    for (const p of cfg.noisePatterns) if (new RegExp(p, "i").test(text)) return noise(`pattern:${p}`);
  }
  if (text.length < cfg.minCommentLength) return noise("short");
  return signal("comment");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/filter.test.ts`
Expected: `26 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/filter.ts test/filter.test.ts
git commit -m "Add signal/noise filter so +1s, emoji, bots and pings stay quiet" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Config loading

**Files:**
- Create: `src/core/config.ts`
- Test: `test/config.test.ts`

A missing token doesn't fail loading. It disables that one instance and records `disabledReason`, so the other instances still run (spec §7).

- [ ] **Step 1: Write the failing test `test/config.test.ts`**

```ts
import { expect, test } from "bun:test";
import { DEFAULT_FILTER, parseConfig } from "../src/core/config.ts";

const yaml = `
instances:
  - id: github
    type: github
    url: https://api.github.com/
    user: lapo
    token_env: GITHUB_TOKEN
  - id: freebsd-bz
    type: bugzilla
    url: https://bugs.freebsd.org/bugzilla
    user: lapo@example.org
    token_env: FREEBSD_BZ_KEY
filter:
  min_comment_length: 10
`;

test("parses instances, strips trailing slash, resolves tokens", () => {
  const cfg = parseConfig(yaml, { GITHUB_TOKEN: "dummy" });
  expect(cfg.instances[0]).toEqual({ id: "github", type: "github", url: "https://api.github.com", user: "lapo", token: "dummy" });
});

test("missing token disables the instance instead of failing", () => {
  const cfg = parseConfig(yaml, { GITHUB_TOKEN: "dummy" });
  expect(cfg.instances[1]?.disabledReason).toBe("missing FREEBSD_BZ_KEY in .env");
  expect(cfg.instances[1]?.token).toBeUndefined();
});

test("filter defaults are merged with overrides", () => {
  const cfg = parseConfig(yaml, {});
  expect(cfg.filter).toEqual({ ...DEFAULT_FILTER, minCommentLength: 10 });
});

test("validation errors", () => {
  expect(() => parseConfig("instances: 3", {})).toThrow("'instances' must be a list");
  expect(() => parseConfig("instances:\n  - id: a\n    type: svn\n    url: x\n    user: u", {})).toThrow("unknown type 'svn'");
  expect(() => parseConfig("instances:\n  - id: a\n    type: github\n    user: u", {})).toThrow("'url' is required");
  const dup = "instances:\n  - {id: a, type: github, url: x, user: u}\n  - {id: a, type: gitlab, url: y, user: u}";
  expect(() => parseConfig(dup, {})).toThrow("duplicate id 'a'");
  expect(() => parseConfig("instances: []\nfilter:\n  noise_patterns: ['(']", {})).toThrow("invalid noise pattern");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL with `Cannot find module '../src/core/config.ts'`.

- [ ] **Step 3: Implement `src/core/config.ts`**

```ts
// Loads data/config.yaml (instances + filter tuning) and resolves tokens from the environment.
// Bun loads .env automatically, so tokens arrive via process.env.
import { parse } from "yaml";
import type { FilterConfig } from "./filter.ts";

export type InstanceType = "github" | "gitlab" | "forgejo" | "bugzilla";
const INSTANCE_TYPES: readonly string[] = ["github", "gitlab", "forgejo", "bugzilla"];

export interface InstanceConfig {
  id: string;
  type: InstanceType;
  url: string; // API base URL, no trailing slash
  user: string; // login (or email for Bugzilla)
  token?: string; // resolved from the env variable named by token_env
  disabledReason?: string; // set when token_env is configured but the variable is missing
}

export interface Config {
  instances: InstanceConfig[];
  filter: FilterConfig;
}

export const DEFAULT_FILTER: FilterConfig = {
  noisePatterns: ["^\\+1$", "^me too", "^same here", "^any update", "^bump$"],
  minCommentLength: 20,
  botAllowlist: [],
};

export function parseConfig(text: string, env: Record<string, string | undefined>): Config {
  // `any` here: this is untrusted YAML and every field is validated below.
  const raw: any = parse(text) ?? {};
  if (!Array.isArray(raw.instances)) throw new Error("config: 'instances' must be a list");
  const seen = new Set<string>();
  const instances = raw.instances.map((r: any, i: number): InstanceConfig => {
    const where = `config: instances[${i}]`;
    for (const k of ["id", "type", "url", "user"]) {
      if (typeof r?.[k] !== "string" || r[k] === "") throw new Error(`${where}: '${k}' is required`);
    }
    if (!INSTANCE_TYPES.includes(r.type)) throw new Error(`${where}: unknown type '${r.type}'`);
    if (seen.has(r.id)) throw new Error(`${where}: duplicate id '${r.id}'`);
    seen.add(r.id);
    const inst: InstanceConfig = { id: r.id, type: r.type, url: r.url.replace(/\/+$/, ""), user: r.user };
    if (r.token_env) {
      const token = env[r.token_env];
      if (token) inst.token = token;
      else inst.disabledReason = `missing ${r.token_env} in .env`;
    }
    return inst;
  });
  const f = raw.filter ?? {};
  const filter: FilterConfig = {
    noisePatterns: f.noise_patterns ?? DEFAULT_FILTER.noisePatterns,
    minCommentLength: f.min_comment_length ?? DEFAULT_FILTER.minCommentLength,
    botAllowlist: f.bot_allowlist ?? DEFAULT_FILTER.botAllowlist,
  };
  for (const p of filter.noisePatterns) {
    try {
      new RegExp(p);
    } catch {
      throw new Error(`config: invalid noise pattern '${p}'`);
    }
  }
  return { instances, filter };
}

export async function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`config file not found: ${path} (copy data/config.example.yaml)`);
  return parseConfig(await file.text(), env);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/config.test.ts`
Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts test/config.test.ts
git commit -m "Load instances and filter tuning from data/config.yaml" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Intent file (read side)

**Files:**
- Create: `src/core/intent.ts`
- Test: `test/intent.test.ts`

Only reading for now. Writing `items.yaml` with comment-preserving edits and git commits comes in plan 3, together with the UI that needs it.

- [ ] **Step 1: Write the failing test `test/intent.test.ts`**

```ts
import { expect, test } from "bun:test";
import { effectivePriority, loadIntent, parseIntent } from "../src/core/intent.ts";

const yaml = `
# my overrides
items:
  - url: https://github.com/foo/bar/issues/7
    priority: important
    note: waiting for 1.4
  - url: https://github.com/x/y/issues/1
    muted: true
  - url: https://lists.example.org/msg1.html
    manual: true
    title: "[PATCH] foo"
`;

test("parses entries keyed by url with defaults", () => {
  const intent = parseIntent(yaml);
  expect(intent.size).toBe(3);
  expect(intent.get("https://github.com/foo/bar/issues/7")).toEqual({
    url: "https://github.com/foo/bar/issues/7", priority: "important", muted: false,
    note: "waiting for 1.4", manual: false, title: undefined,
  });
  expect(intent.get("https://github.com/x/y/issues/1")?.muted).toBe(true);
  expect(intent.get("https://lists.example.org/msg1.html")?.manual).toBe(true);
});

test("empty or missing file means no intent", async () => {
  expect(parseIntent("").size).toBe(0);
  expect((await loadIntent("/nonexistent/items.yaml")).size).toBe(0);
});

test("validation", () => {
  expect(() => parseIntent("items:\n  - note: x")).toThrow("'url' is required");
  expect(() => parseIntent("items:\n  - url: a\n    priority: high")).toThrow("priority must be");
  expect(() => parseIntent("items:\n  - url: a\n  - url: a")).toThrow("duplicate url");
});

test("effectivePriority defaults", () => {
  expect(effectivePriority(undefined, "pr", true)).toBe("important");
  expect(effectivePriority(undefined, "pr", false)).toBe("normal");
  expect(effectivePriority(undefined, "issue", true)).toBe("normal");
  const flagged = parseIntent("items:\n  - url: a\n    priority: normal").get("a");
  expect(effectivePriority(flagged, "pr", true)).toBe("normal");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/intent.test.ts`
Expected: FAIL with `Cannot find module '../src/core/intent.ts'`.

- [ ] **Step 3: Implement `src/core/intent.ts`**

```ts
// Reads data/items.yaml: the user's intent (priority, mute, notes, manual items), keyed by URL.
// Writing it (with git commits) arrives together with the web UI.
import { parse } from "yaml";
import type { ItemKind, Priority } from "./model.ts";

export interface IntentEntry {
  url: string;
  priority?: Priority;
  muted: boolean;
  note?: string;
  manual: boolean; // listed, never polled
  title?: string; // only meaningful for manual items
}

export type Intent = Map<string, IntentEntry>;

export function parseIntent(text: string): Intent {
  const raw: any = parse(text) ?? {};
  const list = raw.items ?? [];
  if (!Array.isArray(list)) throw new Error("items.yaml: 'items' must be a list");
  const out: Intent = new Map();
  list.forEach((r: any, i: number) => {
    const where = `items.yaml: items[${i}]`;
    if (typeof r?.url !== "string" || r.url === "") throw new Error(`${where}: 'url' is required`);
    if (r.priority !== undefined && r.priority !== "important" && r.priority !== "normal") {
      throw new Error(`${where}: priority must be 'important' or 'normal'`);
    }
    if (out.has(r.url)) throw new Error(`${where}: duplicate url ${r.url}`);
    out.set(r.url, {
      url: r.url,
      priority: r.priority,
      muted: r.muted === true,
      note: r.note,
      manual: r.manual === true,
      title: r.title,
    });
  });
  return out;
}

export async function loadIntent(path: string): Promise<Intent> {
  const file = Bun.file(path);
  return (await file.exists()) ? parseIntent(await file.text()) : new Map();
}

/** Explicit priority wins; otherwise PRs/MRs I authored are important and everything else is normal. */
export function effectivePriority(entry: IntentEntry | undefined, kind: ItemKind, authoredByMe: boolean): Priority {
  return entry?.priority ?? (kind === "pr" && authoredByMe ? "important" : "normal");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/intent.test.ts`
Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/intent.ts test/intent.test.ts
git commit -m "Read user intent (priority, mute, manual items) from data/items.yaml" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: SQLite store

**Files:**
- Create: `src/core/store.ts`
- Test: `test/store.test.ts`

Notes: `strict: true` lets named parameters be passed as `{ url }` instead of `{ $url }`, and a missing parameter throws. All timestamps are `toISOString()` strings, so SQL text comparison orders them correctly. Tests use `":memory:"` databases.

- [ ] **Step 1: Write the failing test `test/store.test.ts`**

```ts
import { beforeEach, expect, test } from "bun:test";
import { itemId, Store, type EventRow, type ItemRow } from "../src/core/store.ts";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

const url = "https://github.com/foo/bar/pull/42";
const item: ItemRow = {
  url, id: itemId(url), instance: "github", kind: "pr", repo: "foo/bar", title: "Fix build",
  state: "open", stateDetail: null, ciState: "success", hasConflicts: false, authoredByMe: true,
  labels: ["bug"], lastSignalAt: null, lastSignalSummary: null, seenAt: null,
  baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-01T00:00:00.000Z", snapshotJson: null,
};
const event: EventRow = {
  itemUrl: url, key: "c:1", kind: "comment", actor: "maint", actorRole: "maintainer",
  at: "2026-11-02T00:00:00.000Z", detectedAt: "2026-11-02T00:05:00.000Z", excerpt: "LGTM",
  details: { x: 1 }, isSignal: true, reason: "signal:maintainer-comment",
};

test("itemId is short and stable", () => {
  expect(itemId(url)).toHaveLength(10);
  expect(itemId(url)).toBe(itemId(url));
});

test("item upsert round-trips and updates", () => {
  store.upsertItem(item);
  expect(store.getItem(url)).toEqual(item);
  store.upsertItem({ ...item, state: "merged", labels: [] });
  expect(store.getItem(url)?.state).toBe("merged");
  expect(store.getItem(url)?.labels).toEqual([]);
  expect(store.listItems()).toHaveLength(1);
  expect(store.getItem("nope")).toBeNull();
});

test("events dedup by key and filter noise", () => {
  expect(store.insertEvent(event)).toBe(true);
  expect(store.insertEvent(event)).toBe(false);
  store.insertEvent({ ...event, key: "c:2", isSignal: false, reason: "noise:+1", details: null });
  expect(store.eventsFor(url)).toEqual([event]);
  expect(store.eventsFor(url, true)).toHaveLength(2);
  store.setVerdict(url, "c:2", { isSignal: true, reason: "signal:comment" });
  expect(store.eventsFor(url)).toHaveLength(2);
});

test("seen markers", () => {
  store.upsertItem(item);
  expect(store.markSeen(url, "2026-11-03T00:00:00.000Z")).toBe(true);
  expect(store.getItem(url)?.seenAt).toBe("2026-11-03T00:00:00.000Z");
  expect(store.markSeen("nope", "x")).toBe(false);
  expect(store.markAllSeen("2026-11-04T00:00:00.000Z")).toBe(1);
});

test("cursor is taken from the latest run", () => {
  expect(store.getCursor("github")).toBeNull();
  store.recordRun({ instance: "github", startedAt: "a", finishedAt: "b", cursor: "c1", error: null });
  store.recordRun({ instance: "github", startedAt: "a", finishedAt: "b", cursor: "c2", error: null });
  store.recordRun({ instance: "other", startedAt: "a", finishedAt: "b", cursor: "zz", error: null });
  expect(store.getCursor("github")).toBe("c2");
});

test("locks exclude, release, and expire", () => {
  const t0 = new Date("2026-11-04T10:00:00Z");
  expect(store.acquireLock("poll", "a", t0)).toBe(true);
  expect(store.acquireLock("poll", "b", t0)).toBe(false);
  store.releaseLock("poll");
  expect(store.acquireLock("poll", "b", t0)).toBe(true);
  const muchLater = new Date(t0.getTime() + 31 * 60_000);
  expect(store.acquireLock("poll", "c", muchLater)).toBe(true);
});

test("rollback discards writes", () => {
  store.begin();
  store.upsertItem(item);
  store.rollback();
  expect(store.getItem(url)).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/store.test.ts`
Expected: FAIL with `Cannot find module '../src/core/store.ts'`.

- [ ] **Step 3: Implement `src/core/store.ts`**

```ts
// SQLite cache (var/cache.sqlite, git-ignored, rebuildable): items, events, poll runs, locks.
// All timestamps are ISO-8601 UTC strings from Date.toISOString(), so they compare correctly as text.
import { Database } from "bun:sqlite";
import type { ActorRole, CiState, EventKind, ItemKind, ItemState, Verdict } from "./model.ts";

export interface ItemRow {
  url: string;
  id: string;
  instance: string;
  kind: ItemKind;
  repo: string;
  title: string;
  state: ItemState;
  stateDetail: string | null;
  ciState: CiState | null;
  hasConflicts: boolean;
  authoredByMe: boolean;
  labels: string[];
  lastSignalAt: string | null; // when we detected the latest signal (local clock)
  lastSignalSummary: string | null;
  seenAt: string | null;
  baselineAt: string; // first time we saw the item; history before it never counts as unread
  fetchedAt: string;
  snapshotJson: string | null;
}

export interface EventRow {
  itemUrl: string;
  key: string;
  kind: EventKind;
  actor: string;
  actorRole: ActorRole;
  at: string; // when it happened (forge clock)
  detectedAt: string; // when we first stored it (local clock)
  excerpt: string | null;
  details: Record<string, unknown> | null;
  isSignal: boolean;
  reason: string;
}

export interface PollRun {
  instance: string;
  startedAt: string;
  finishedAt: string;
  cursor: string | null;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  url TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, instance TEXT NOT NULL, kind TEXT NOT NULL,
  repo TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, state_detail TEXT, ci_state TEXT,
  has_conflicts INTEGER NOT NULL DEFAULT 0, authored_by_me INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '[]', last_signal_at TEXT, last_signal_summary TEXT,
  seen_at TEXT, baseline_at TEXT NOT NULL, fetched_at TEXT NOT NULL, snapshot_json TEXT
);
CREATE TABLE IF NOT EXISTS events (
  item_url TEXT NOT NULL, event_key TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  actor_role TEXT NOT NULL, at TEXT NOT NULL, detected_at TEXT NOT NULL, excerpt TEXT,
  details_json TEXT, is_signal INTEGER NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY (item_url, event_key)
);
CREATE TABLE IF NOT EXISTS poll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL, cursor TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at TEXT NOT NULL);
`;

/** Short stable id for URLs in the HTTP API. */
export function itemId(url: string): string {
  return new Bun.CryptoHasher("sha1").update(url).digest("hex").slice(0, 10);
}

function toItem(r: any): ItemRow {
  return {
    url: r.url, id: r.id, instance: r.instance, kind: r.kind, repo: r.repo, title: r.title,
    state: r.state, stateDetail: r.state_detail, ciState: r.ci_state,
    hasConflicts: r.has_conflicts === 1, authoredByMe: r.authored_by_me === 1,
    labels: JSON.parse(r.labels_json), lastSignalAt: r.last_signal_at,
    lastSignalSummary: r.last_signal_summary, seenAt: r.seen_at, baselineAt: r.baseline_at,
    fetchedAt: r.fetched_at, snapshotJson: r.snapshot_json,
  };
}

function toEvent(r: any): EventRow {
  return {
    itemUrl: r.item_url, key: r.event_key, kind: r.kind, actor: r.actor, actorRole: r.actor_role,
    at: r.at, detectedAt: r.detected_at, excerpt: r.excerpt,
    details: r.details_json ? JSON.parse(r.details_json) : null,
    isSignal: r.is_signal === 1, reason: r.reason,
  };
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    // strict: named parameters are bound without the "$" prefix and missing ones throw.
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  getItem(url: string): ItemRow | null {
    const r = this.db.query("SELECT * FROM items WHERE url = $url").get({ url });
    return r ? toItem(r) : null;
  }

  listItems(): ItemRow[] {
    return this.db.query("SELECT * FROM items").all().map(toItem);
  }

  upsertItem(i: ItemRow): void {
    this.db.query(`
      INSERT INTO items (url, id, instance, kind, repo, title, state, state_detail, ci_state,
        has_conflicts, authored_by_me, labels_json, last_signal_at, last_signal_summary, seen_at,
        baseline_at, fetched_at, snapshot_json)
      VALUES ($url, $id, $instance, $kind, $repo, $title, $state, $stateDetail, $ciState,
        $hasConflicts, $authoredByMe, $labels, $lastSignalAt, $lastSignalSummary, $seenAt,
        $baselineAt, $fetchedAt, $snapshotJson)
      ON CONFLICT(url) DO UPDATE SET instance = excluded.instance, kind = excluded.kind,
        repo = excluded.repo, title = excluded.title, state = excluded.state,
        state_detail = excluded.state_detail, ci_state = excluded.ci_state,
        has_conflicts = excluded.has_conflicts, authored_by_me = excluded.authored_by_me,
        labels_json = excluded.labels_json, last_signal_at = excluded.last_signal_at,
        last_signal_summary = excluded.last_signal_summary, seen_at = excluded.seen_at,
        baseline_at = excluded.baseline_at, fetched_at = excluded.fetched_at,
        snapshot_json = excluded.snapshot_json`)
      .run({
        ...i,
        hasConflicts: i.hasConflicts ? 1 : 0,
        authoredByMe: i.authoredByMe ? 1 : 0,
        labels: JSON.stringify(i.labels),
      });
  }

  /** Returns false if the event was already stored (dedup by item + key). */
  insertEvent(e: EventRow): boolean {
    const res = this.db.query(`
      INSERT OR IGNORE INTO events (item_url, event_key, kind, actor, actor_role, at, detected_at,
        excerpt, details_json, is_signal, reason)
      VALUES ($itemUrl, $key, $kind, $actor, $actorRole, $at, $detectedAt, $excerpt, $details,
        $isSignal, $reason)`)
      .run({ ...e, details: e.details ? JSON.stringify(e.details) : null, isSignal: e.isSignal ? 1 : 0 });
    return res.changes > 0;
  }

  /** Newest first. */
  eventsFor(itemUrl: string, includeNoise = false): EventRow[] {
    const where = includeNoise ? "" : "AND is_signal = 1";
    return this.db.query(`SELECT * FROM events WHERE item_url = $itemUrl ${where} ORDER BY at DESC`)
      .all({ itemUrl }).map(toEvent);
  }

  setVerdict(itemUrl: string, key: string, v: Verdict): void {
    this.db.query("UPDATE events SET is_signal = $isSignal, reason = $reason WHERE item_url = $itemUrl AND event_key = $key")
      .run({ itemUrl, key, isSignal: v.isSignal ? 1 : 0, reason: v.reason });
  }

  markSeen(url: string, at: string): boolean {
    return this.db.query("UPDATE items SET seen_at = $at WHERE url = $url").run({ url, at }).changes > 0;
  }

  markAllSeen(at: string): number {
    return this.db.query("UPDATE items SET seen_at = $at").run({ at }).changes;
  }

  /** The cursor of the latest run (failed runs carry the previous cursor forward). */
  getCursor(instance: string): string | null {
    const r = this.db.query("SELECT cursor FROM poll_runs WHERE instance = $instance ORDER BY id DESC LIMIT 1")
      .get({ instance }) as { cursor: string | null } | null;
    return r?.cursor ?? null;
  }

  recordRun(r: PollRun): void {
    this.db.query(`INSERT INTO poll_runs (instance, started_at, finished_at, cursor, error)
      VALUES ($instance, $startedAt, $finishedAt, $cursor, $error)`).run({ ...r });
  }

  /** Locks older than staleMs are assumed to belong to a crashed process and are taken over. */
  acquireLock(name: string, holder: string, now: Date, staleMs = 30 * 60_000): boolean {
    const staleBefore = new Date(now.getTime() - staleMs).toISOString();
    this.db.query("DELETE FROM locks WHERE name = $name AND acquired_at < $staleBefore").run({ name, staleBefore });
    return this.db.query("INSERT OR IGNORE INTO locks (name, holder, acquired_at) VALUES ($name, $holder, $at)")
      .run({ name, holder, at: now.toISOString() }).changes > 0;
  }

  releaseLock(name: string): void {
    this.db.query("DELETE FROM locks WHERE name = $name").run({ name });
  }

  begin(): void {
    this.db.exec("BEGIN");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/store.test.ts`
Expected: `7 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts test/store.test.ts
git commit -m "Add SQLite cache for items, events, poll runs and locks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: HTTP helper

**Files:**
- Create: `src/core/http.ts`
- Test: `test/http.test.ts`

Shared by every adapter. `fetch` and `sleep` are injected (`HttpDeps`), so tests never touch the network or wait. Note that every `.rejects` assertion is `await`ed; without `await`, a failing assertion can go unnoticed.

- [ ] **Step 1: Write the failing test `test/http.test.ts`**

```ts
import { expect, test } from "bun:test";
import { getAllPages, getJson, GoneError, HttpError, nextLink, RateLimitError, type HttpDeps } from "../src/core/http.ts";

/** Builds HttpDeps whose fetch replays `responses` in order and records requested URLs. */
function fakeHttp(responses: (Response | Error)[]) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const deps: HttpDeps = {
    fetchFn: async (url) => {
      calls.push(url);
      const r = responses.shift();
      if (!r) throw new Error("no more fake responses");
      if (r instanceof Error) throw r;
      return r;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retries: 3,
    timeoutMs: 1000,
  };
  return { deps, calls, sleeps };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });

test("returns parsed JSON", async () => {
  const { deps } = fakeHttp([json({ a: 1 })]);
  expect((await getJson<{ a: number }>("http://x/", {}, deps)).data).toEqual({ a: 1 });
});

test("retries 5xx and network errors with backoff", async () => {
  const { deps, calls, sleeps } = fakeHttp([new Error("ECONNRESET"), new Response("", { status: 502 }), json([1])]);
  expect((await getJson("http://x/", {}, deps)).data).toEqual([1]);
  expect(calls).toHaveLength(3);
  expect(sleeps).toEqual([500, 1000]);
});

test("gives up after the retry budget", async () => {
  const { deps } = fakeHttp(Array.from({ length: 4 }, () => new Response("down", { status: 503 })));
  await expect(getJson("http://x/", {}, deps)).rejects.toThrow("HTTP 503");
});

test("404 is GoneError, 4xx is HttpError without retry", async () => {
  await expect(getJson("http://x/", {}, fakeHttp([new Response("", { status: 404 })]).deps)).rejects.toBeInstanceOf(GoneError);
  const { deps, calls } = fakeHttp([new Response("bad", { status: 401 })]);
  await expect(getJson("http://x/", {}, deps)).rejects.toBeInstanceOf(HttpError);
  expect(calls).toHaveLength(1);
});

test("rate limits are reported with their reset time", async () => {
  const res = new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" } });
  try {
    await getJson("http://x/", {}, fakeHttp([res]).deps);
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).resetAt?.getTime()).toBe(1790000000 * 1000);
  }
});

test("nextLink", () => {
  expect(nextLink('<https://a/?page=2>; rel="next", <https://a/?page=5>; rel="last"')).toBe("https://a/?page=2");
  expect(nextLink('<https://a/?page=1>; rel="prev"')).toBeNull();
  expect(nextLink(null)).toBeNull();
});

test("getAllPages follows Link headers and applies pick", async () => {
  const { deps, calls } = fakeHttp([
    json({ items: [1, 2] }, { headers: { link: '<http://x/?page=2>; rel="next"' } }),
    json({ items: [3] }),
  ]);
  expect(await getAllPages<number>("http://x/", {}, deps, (b) => b.items)).toEqual([1, 2, 3]);
  expect(calls).toEqual(["http://x/", "http://x/?page=2"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/http.test.ts`
Expected: FAIL with `Cannot find module '../src/core/http.ts'`.

- [ ] **Step 3: Implement `src/core/http.ts`**

```ts
// Minimal JSON-over-HTTP helper shared by all adapters: timeout, retry with backoff on
// transient failures, typed errors for "gone" and "rate limited", Link-header pagination.

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, message?: string) {
    super(message ?? `HTTP ${status} for ${url}`);
  }
}

/** 404/410: the item was deleted, made private, or never existed. */
export class GoneError extends HttpError {}

export class RateLimitError extends HttpError {
  constructor(status: number, url: string, readonly resetAt: Date | null) {
    super(status, url, `rate limited on ${url}` + (resetAt ? ` until ${resetAt.toISOString()}` : ""));
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpDeps {
  fetchFn: FetchFn;
  sleep: (ms: number) => Promise<void>;
  retries: number;
  timeoutMs: number;
}

export const defaultHttp: HttpDeps = {
  fetchFn: (url, init) => fetch(url, init),
  sleep: (ms) => Bun.sleep(ms),
  retries: 3,
  timeoutMs: 30_000,
};

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
}

const backoff = (attempt: number) => 500 * 2 ** attempt;

function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  return res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"));
}

function resetTime(res: Response): Date | null {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return new Date(Date.now() + Number(retryAfter) * 1000);
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) return new Date(Number(reset) * 1000);
  return null;
}

export async function getJson<T>(url: string, headers: Record<string, string>, deps: HttpDeps = defaultHttp): Promise<JsonResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetchFn(url, { headers, signal: AbortSignal.timeout(deps.timeoutMs) });
    } catch (err) {
      if (attempt < deps.retries) {
        await deps.sleep(backoff(attempt));
        continue;
      }
      throw new Error(`network error for ${url}: ${(err as Error).message}`);
    }
    if (res.ok) return { data: (await res.json()) as T, headers: res.headers };
    if (res.status === 404 || res.status === 410) throw new GoneError(res.status, url);
    if (isRateLimited(res)) throw new RateLimitError(res.status, url, resetTime(res));
    if (res.status >= 500 && attempt < deps.retries) {
      await deps.sleep(backoff(attempt));
      continue;
    }
    throw new HttpError(res.status, url, `HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Extracts the rel="next" URL from an RFC 8288 Link header (GitHub, GitLab, Forgejo). */
export function nextLink(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

/** Fetches every page and concatenates the arrays `pick` extracts from each body. */
export async function getAllPages<T>(
  url: string,
  headers: Record<string, string>,
  deps: HttpDeps = defaultHttp,
  pick: (body: any) => T[] = (body) => body,
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < maxPages; page++) {
    const res: JsonResponse<unknown> = await getJson<unknown>(next, headers, deps);
    out.push(...pick(res.data));
    next = nextLink(res.headers.get("link"));
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/http.test.ts`
Expected: `7 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/http.ts test/http.test.ts
git commit -m "Add HTTP helper with retry, rate-limit and gone detection, pagination" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Event summaries

**Files:**
- Create: `src/core/summary.ts`
- Test: `test/summary.test.ts`

- [ ] **Step 1: Write the failing test `test/summary.test.ts`**

```ts
import { expect, test } from "bun:test";
import { summarize } from "../src/core/summary.ts";

test("summaries", () => {
  expect(summarize({ kind: "comment", actor: "bob", excerpt: "Looks  good\nbut please\trebase", details: null }))
    .toBe("comment by @bob: Looks good but please rebase");
  expect(summarize({ kind: "review", actor: "m", excerpt: "", details: { state: "changes_requested" } }))
    .toBe("review (changes_requested) by @m");
  expect(summarize({ kind: "state", actor: "m", excerpt: null, details: { to: "merged" } })).toBe("→ merged by @m");
  expect(summarize({ kind: "label", actor: "m", excerpt: null, details: { action: "removed", label: "wip" } }))
    .toBe("label -wip by @m");
  expect(summarize({ kind: "ci", actor: "", excerpt: null, details: { from: "success", to: "failure" } })).toBe("CI → failure");
  expect(summarize({ kind: "review_request", actor: "m", excerpt: null, details: null })).toBe("review request by @m");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/summary.test.ts`
Expected: FAIL with `Cannot find module '../src/core/summary.ts'`.

- [ ] **Step 3: Implement `src/core/summary.ts`**

```ts
// One-line human summary of an event, used for "latest signal" in lists.
import type { EventRow } from "./store.ts";

const oneLine = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

export function summarize(e: Pick<EventRow, "kind" | "actor" | "excerpt" | "details">): string {
  const by = e.actor ? ` by @${e.actor}` : "";
  const d = e.details ?? {};
  const sign = d.action === "removed" ? "-" : "+";
  switch (e.kind) {
    case "comment":
      return `comment${by}: ${oneLine(e.excerpt)}`;
    case "review":
      return `review (${d.state ?? "?"})${by}` + (e.excerpt ? `: ${oneLine(e.excerpt)}` : "");
    case "state":
      return `→ ${d.to}${by}`;
    case "label":
      return `label ${sign}${d.label}${by}`;
    case "milestone":
      return `milestone ${sign}${d.milestone}${by}`;
    case "ci":
      return `CI → ${d.to}`;
    case "conflict":
      return "merge conflict";
    case "push":
      return `push${by}` + (d.message ? `: ${d.message}` : "");
    default:
      return `${e.kind.replace("_", " ")}${by}`;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/summary.test.ts`
Expected: `1 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/summary.ts test/summary.test.ts
git commit -m "Add one-line event summaries for item lists" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: GitHub adapter

**Files:**
- Create: `src/adapters/github.ts`, `src/adapters/index.ts`
- Test: `test/github.test.ts`

How GitHub data maps onto the model:
- **Discovery:** `search/issues?q=involves:USER is:open` on the first run. Later runs use `updated:>=T`, plus `/notifications?all=true&since=T` for items you only subscribed to (skipped on 401/403).
- **Item:** `issues/N` gives title, state, labels and author. `issues/N/timeline` gives comments, reviews, labels, milestones, state changes, force-pushes, assignment, review requests and mentions of you. For PRs, also `pulls/N` (merged, `mergeable_state == "dirty"` → conflicts), `pulls/N/commits` (one push event per commit, with the author's GitHub login) and `commits/SHA/check-runs` + `commits/SHA/status` (combined CI state).
- **Roles:** `author_association` OWNER/MEMBER/COLLABORATOR → maintainer. Label and milestone changes by any non-bot human count as maintainer, because GitHub requires triage rights for them. `type: "Bot"` or a `[bot]` suffix → bot.

- [ ] **Step 1: Write the failing test `test/github.test.ts`**

```ts
// GitHub adapter against a fake API: responses are minimal, sanitized shapes of real GitHub payloads.
import { expect, test } from "bun:test";
import { GitHubAdapter } from "../src/adapters/github.ts";
import type { HttpDeps } from "../src/core/http.ts";

const API = "https://api.github.com";
const inst = { id: "github", type: "github" as const, url: API, user: "lapo", token: "t" };

/** Fake GitHub: maps "path?query" (without the API base) to a JSON body or a status code. */
function fakeGitHub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const http: HttpDeps = {
    fetchFn: async (url) => {
      const path = url.slice(API.length);
      calls.push(path);
      const body = routes[path];
      if (body === undefined) return new Response(`no route for ${path}`, { status: 404 });
      if (typeof body === "number") return new Response("", { status: body });
      return Response.json(body);
    },
    sleep: async () => {},
    retries: 0,
    timeoutMs: 1000,
  };
  return { adapter: new GitHubAdapter(inst, http), calls };
}

const PR = "https://github.com/foo/bar/pull/42";

const prRoutes = {
  "/repos/foo/bar/issues/42": {
    title: "Fix build on FreeBSD", state: "closed", state_reason: null,
    user: { login: "Lapo" }, labels: [{ name: "bug" }],
  },
  "/repos/foo/bar/issues/42/timeline?per_page=100": [
    { event: "commented", id: 1, actor: { login: "maint" }, user: { login: "maint" }, author_association: "MEMBER",
      created_at: "2026-11-01T10:00:00Z", body: "Please rebase" },
    { event: "commented", id: 2, actor: { login: "rando" }, user: { login: "rando" }, author_association: "NONE",
      created_at: "2026-11-01T11:00:00Z", body: "+1" },
    { event: "reviewed", id: 3, user: { login: "maint" }, author_association: "MEMBER",
      submitted_at: "2026-11-01T12:00:00Z", state: "approved", body: "" },
    { event: "reviewed", id: 4, user: { login: "lapo" }, state: "pending", submitted_at: "2026-11-01T12:30:00Z" },
    { event: "labeled", id: 5, actor: { login: "triager" }, created_at: "2026-11-01T13:00:00Z", label: { name: "ready" } },
    { event: "mentioned", id: 6, actor: { login: "lapo" }, created_at: "2026-11-01T13:30:00Z" },
    { event: "mentioned", id: 7, actor: { login: "someone-else" }, created_at: "2026-11-01T13:30:00Z" },
    { event: "merged", id: 8, actor: { login: "maint" }, created_at: "2026-11-01T14:00:00Z" },
    { event: "cross-referenced", created_at: "2026-11-01T14:10:00Z" },
  ],
  "/repos/foo/bar/pulls/42": { merged: true, mergeable_state: "clean", head: { sha: "abc123" } },
  "/repos/foo/bar/pulls/42/commits?per_page=100": [
    { sha: "abc123def4567890", author: { login: "lapo" },
      commit: { message: "Fix build\n\nlong text", author: { name: "Lapo", date: "2026-10-30T09:00:00Z" }, committer: { date: "2026-10-30T09:00:00Z" } } },
  ],
  "/repos/foo/bar/commits/abc123/check-runs?per_page=100": {
    check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }],
  },
  "/repos/foo/bar/commits/abc123/status": { state: "success", total_count: 1 },
};

test("refFromUrl accepts only this instance's PR/issue URLs", () => {
  const { adapter } = fakeGitHub({});
  expect(adapter.refFromUrl(PR)).toEqual({ url: PR, instance: "github", kind: "pr" });
  expect(adapter.refFromUrl("https://github.com/foo/bar/issues/7/")?.kind).toBe("issue");
  expect(adapter.refFromUrl("https://gitlab.com/foo/bar/-/issues/7")).toBeNull();
  expect(adapter.refFromUrl("https://github.com/foo/bar")).toBeNull();
});

test("fetch normalizes a merged PR", async () => {
  const { adapter } = fakeGitHub(prRoutes);
  const snap = await adapter.fetch({ url: PR, instance: "github", kind: "pr" });
  expect(snap).toMatchObject({
    repo: "foo/bar", title: "Fix build on FreeBSD", state: "merged", ciState: "failure",
    hasConflicts: false, authoredByMe: true, labels: ["bug"],
  });
  const byKey = Object.fromEntries(snap.events.map((e) => [e.key, e]));
  expect(Object.keys(byKey).sort()).toEqual(["c:1", "c:2", "commit:abc123def4567890", "l:5", "m:6", "r:3", "s:8"]);
  expect(byKey["c:1"]).toMatchObject({ kind: "comment", actor: "maint", actorRole: "maintainer", body: "Please rebase" });
  expect(byKey["c:1"]?.at.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  expect(byKey["c:2"]?.actorRole).toBe("contributor");
  expect(byKey["r:3"]).toMatchObject({ kind: "review", details: { state: "approved" } });
  expect(byKey["l:5"]).toMatchObject({ kind: "label", actorRole: "maintainer", details: { action: "added", label: "ready" } });
  expect(byKey["m:6"]).toMatchObject({ kind: "mention", actorRole: "unknown" });
  expect(byKey["s:8"]).toMatchObject({ kind: "state", details: { to: "merged" } });
  expect(byKey["commit:abc123def4567890"]).toMatchObject({ kind: "push", actorRole: "me", details: { sha: "abc123def456", message: "Fix build" } });
});

test("issues skip PR-only calls", async () => {
  const { adapter, calls } = fakeGitHub({
    "/repos/foo/bar/issues/7": { title: "Crash", state: "open", user: { login: "x" }, labels: ["a"] },
    "/repos/foo/bar/issues/7/timeline?per_page=100": [],
  });
  const snap = await adapter.fetch({ url: "https://github.com/foo/bar/issues/7", instance: "github", kind: "issue" });
  expect(snap).toMatchObject({ state: "open", ciState: null, authoredByMe: false, labels: ["a"], events: [] });
  expect(calls).toHaveLength(2);
});

test("discover: first run searches open items only", async () => {
  const q = encodeURIComponent("involves:lapo is:open");
  const { adapter, calls } = fakeGitHub({
    [`/search/issues?q=${q}&sort=updated&per_page=100`]: { items: [{ html_url: PR }, { html_url: "https://github.com/x/y/issues/1" }] },
  });
  const refs = await adapter.discover(null);
  expect(refs.map((r) => r.url)).toEqual([PR, "https://github.com/x/y/issues/1"]);
  expect(calls).toHaveLength(1);
});

test("discover: incremental run adds subscribed items from notifications", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const q = encodeURIComponent("involves:lapo updated:>=2026-11-04T10:00:00Z");
  const { adapter } = fakeGitHub({
    [`/search/issues?q=${q}&sort=updated&per_page=100`]: { items: [{ html_url: PR }] },
    [`/notifications?all=true&per_page=50&since=${encodeURIComponent(since.toISOString())}`]: [
      { subject: { url: "https://api.github.com/repos/k/l/issues/9" } },
      { subject: { url: "https://api.github.com/repos/k/l/pulls/10" } },
      { subject: { url: "https://api.github.com/repos/k/l/releases/1" } },
    ],
  });
  const refs = await adapter.discover(since);
  expect(refs.map((r) => r.url)).toEqual([PR, "https://github.com/k/l/issues/9", "https://github.com/k/l/pull/10"]);
});

test("discover: notifications forbidden (fine-grained token) is skipped", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const q = encodeURIComponent("involves:lapo updated:>=2026-11-04T10:00:00Z");
  const { adapter } = fakeGitHub({
    [`/search/issues?q=${q}&sort=updated&per_page=100`]: { items: [] },
    [`/notifications?all=true&per_page=50&since=${encodeURIComponent(since.toISOString())}`]: 403,
  });
  expect(await adapter.discover(since)).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/github.test.ts`
Expected: FAIL with `Cannot find module '../src/adapters/github.ts'`.

- [ ] **Step 3: Implement `src/adapters/github.ts`**

```ts
// GitHub (github.com, or GitHub Enterprise via its /api/v3 base URL).
import type { InstanceConfig } from "../core/config.ts";
import { defaultHttp, getAllPages, getJson, HttpError, RateLimitError, type HttpDeps } from "../core/http.ts";
import type { ActorRole, Adapter, CiState, ItemRef, ItemState, NormalizedEvent, Snapshot } from "../core/model.ts";

// Only the fields we use from GitHub's REST responses.
interface GhUser { login: string; type?: string }
interface GhIssue {
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  user: GhUser | null;
  labels: (string | { name: string })[];
}
interface GhPull { merged: boolean; mergeable_state?: string; head: { sha: string } }
interface GhCommit {
  sha: string;
  author: GhUser | null; // GitHub account linked to the commit email, if any
  commit: { message: string; author: { name: string; date: string } | null; committer: { date: string } | null };
}
interface GhTimelineEvent {
  event: string;
  id?: number;
  actor?: GhUser | null;
  user?: GhUser | null;
  author_association?: string;
  created_at?: string;
  submitted_at?: string;
  body?: string | null;
  state?: string;
  label?: { name: string };
  milestone?: { title: string };
  assignee?: GhUser | null;
  requested_reviewer?: GhUser | null;
}
interface GhNotification { subject?: { url?: string | null } }

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export class GitHubAdapter implements Adapter {
  private readonly web: string;
  private readonly me: string;

  constructor(private readonly inst: InstanceConfig, private readonly http: HttpDeps = defaultHttp) {
    this.web = inst.url === "https://api.github.com" ? "https://github.com" : inst.url.replace(/\/api\/v3$/, "");
    this.me = inst.user.toLowerCase();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "watcher",
    };
    if (this.inst.token) h.authorization = `Bearer ${this.inst.token}`;
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    return (await getJson<T>(this.inst.url + path, this.headers(), this.http)).data;
  }

  private all<T>(path: string, pick?: (body: any) => T[]): Promise<T[]> {
    return getAllPages<T>(this.inst.url + path, this.headers(), this.http, pick);
  }

  refFromUrl(url: string): ItemRef | null {
    const m = url.match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\/?$/);
    if (!m || m[1] !== this.web) return null;
    return { url: `${m[1]}/${m[2]}/${m[3]}/${m[4]}/${m[5]}`, instance: this.inst.id, kind: m[4] === "pull" ? "pr" : "issue" };
  }

  async discover(since: Date | null): Promise<ItemRef[]> {
    // First run: everything open that involves me. Later runs: anything updated since the cursor,
    // including closed/merged items, so state changes are seen.
    const when = since ? `updated:>=${since.toISOString().replace(/\.\d{3}Z$/, "Z")}` : "is:open";
    const q = encodeURIComponent(`involves:${this.inst.user} ${when}`);
    const found = await this.all<{ html_url: string }>(`/search/issues?q=${q}&sort=updated&per_page=100`, (b) => b.items);
    const refs = found.map((i) => this.refFromUrl(i.html_url)).filter((r): r is ItemRef => r !== null);
    if (since) refs.push(...(await this.subscribed(since)));
    return refs;
  }

  /** Issues I merely subscribed to are not matched by `involves:`; notifications cover them. */
  private async subscribed(since: Date): Promise<ItemRef[]> {
    let notes: GhNotification[];
    try {
      notes = await this.all<GhNotification>(`/notifications?all=true&per_page=50&since=${encodeURIComponent(since.toISOString())}`);
    } catch (err) {
      // Fine-grained tokens cannot read notifications: skip this extra discovery rather than fail the run.
      if (err instanceof HttpError && !(err instanceof RateLimitError) && (err.status === 401 || err.status === 403)) return [];
      throw err;
    }
    const refs: ItemRef[] = [];
    for (const n of notes) {
      const m = n.subject?.url?.match(/\/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)$/);
      if (!m) continue;
      const ref = this.refFromUrl(`${this.web}/${m[1]}/${m[2]}/${m[3] === "pulls" ? "pull" : "issues"}/${m[4]}`);
      if (ref) refs.push(ref);
    }
    return refs;
  }

  async fetch(ref: ItemRef): Promise<Snapshot> {
    const [, owner, repo, , num] = new URL(ref.url).pathname.split("/"); // "/o/r/pull/5"
    const base = `/repos/${owner}/${repo}`;
    const issue = await this.get<GhIssue>(`${base}/issues/${num}`);
    const timeline = await this.all<GhTimelineEvent>(`${base}/issues/${num}/timeline?per_page=100`);
    const events = timeline.flatMap((e) => this.mapTimeline(e));
    let state: ItemState = issue.state === "open" ? "open" : "closed";
    let ciState: CiState | null = null;
    let hasConflicts = false;
    if (ref.kind === "pr") {
      const pr = await this.get<GhPull>(`${base}/pulls/${num}`);
      if (pr.merged) state = "merged";
      hasConflicts = pr.mergeable_state === "dirty";
      const commits = await this.all<GhCommit>(`${base}/pulls/${num}/commits?per_page=100`);
      for (const c of commits) events.push(this.mapCommit(c));
      ciState = await this.ciState(base, pr.head.sha);
    }
    return {
      ref,
      repo: `${owner}/${repo}`,
      title: issue.title,
      state,
      stateDetail: issue.state_reason ?? undefined,
      ciState,
      hasConflicts,
      authoredByMe: issue.user?.login.toLowerCase() === this.me,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
      events,
    };
  }

  private role(user: GhUser | null | undefined, association?: string): ActorRole {
    if (!user) return "unknown";
    if (user.login.toLowerCase() === this.me) return "me";
    if (user.type === "Bot" || user.login.endsWith("[bot]")) return "bot";
    if (association && MAINTAINER_ASSOCIATIONS.has(association)) return "maintainer";
    return association ? "contributor" : "unknown";
  }

  private mapTimeline(e: GhTimelineEvent): NormalizedEvent[] {
    const who = e.actor ?? e.user ?? null;
    const actor = who?.login ?? "";
    const role = this.role(who, e.author_association);
    // On GitHub only users with triage rights can label or set milestones, so a human doing it is a maintainer.
    const triager: ActorRole = role === "contributor" || role === "unknown" ? "maintainer" : role;
    const at = new Date(e.created_at ?? e.submitted_at ?? 0);
    const base = { actor, actorRole: role, at };
    switch (e.event) {
      case "commented":
        return [{ ...base, key: `c:${e.id}`, kind: "comment", body: e.body ?? "" }];
      case "reviewed":
        if (e.state === "pending") return [];
        return [{ ...base, key: `r:${e.id}`, kind: "review", body: e.body ?? "", details: { state: e.state } }];
      case "labeled":
      case "unlabeled":
        return [{ ...base, actorRole: triager, key: `l:${e.id}`, kind: "label",
          details: { action: e.event === "labeled" ? "added" : "removed", label: e.label?.name } }];
      case "milestoned":
      case "demilestoned":
        return [{ ...base, actorRole: triager, key: `ms:${e.id}`, kind: "milestone",
          details: { action: e.event === "milestoned" ? "added" : "removed", milestone: e.milestone?.title } }];
      case "closed":
      case "reopened":
      case "merged":
        return [{ ...base, key: `s:${e.id}`, kind: "state", details: { to: e.event } }];
      case "head_ref_force_pushed":
        return [{ ...base, key: `fp:${e.id}`, kind: "push", details: { force: true } }];
      case "assigned":
        return e.assignee?.login.toLowerCase() === this.me ? [{ ...base, key: `a:${e.id}`, kind: "assign" }] : [];
      case "review_requested":
        return e.requested_reviewer?.login.toLowerCase() === this.me ? [{ ...base, key: `rr:${e.id}`, kind: "review_request" }] : [];
      case "mentioned": // the actor of a "mentioned" event is the person mentioned
        return actor.toLowerCase() === this.me ? [{ ...base, actor: "", actorRole: "unknown", key: `m:${e.id}`, kind: "mention" }] : [];
      default:
        return [];
    }
  }

  private mapCommit(c: GhCommit): NormalizedEvent {
    return {
      key: `commit:${c.sha}`,
      kind: "push",
      actor: c.author?.login ?? c.commit.author?.name ?? "unknown",
      actorRole: this.role(c.author),
      at: new Date(c.commit.committer?.date ?? c.commit.author?.date ?? 0),
      details: { sha: c.sha.slice(0, 12), message: c.commit.message.split("\n")[0] },
    };
  }

  /** Combines check runs (GitHub Actions etc.) and legacy commit statuses into one state. */
  private async ciState(base: string, sha: string): Promise<CiState | null> {
    const runs = await this.get<{ check_runs: { status: string; conclusion: string | null }[] }>(`${base}/commits/${sha}/check-runs?per_page=100`);
    const status = await this.get<{ state: string; total_count: number }>(`${base}/commits/${sha}/status`);
    const states: CiState[] = runs.check_runs.map((r) =>
      r.status !== "completed" ? "pending" : FAILED_CONCLUSIONS.has(r.conclusion ?? "") ? "failure" : "success");
    if (status.total_count > 0) states.push(status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure");
    if (states.length === 0) return null;
    return states.includes("failure") ? "failure" : states.includes("pending") ? "pending" : "success";
  }
}
```

- [ ] **Step 4: Create the adapter factory `src/adapters/index.ts`**

```ts
import type { InstanceConfig } from "../core/config.ts";
import type { Adapter } from "../core/model.ts";
import { GitHubAdapter } from "./github.ts";

export function createAdapter(inst: InstanceConfig): Adapter {
  switch (inst.type) {
    case "github":
      return new GitHubAdapter(inst);
    default:
      throw new Error(`no adapter for type '${inst.type}' yet`);
  }
}
```

- [ ] **Step 5: Run the test and the type checker**

Run: `bun test test/github.test.ts && bun run typecheck`
Expected: `6 pass, 0 fail`, then no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github.ts src/adapters/index.ts test/github.test.ts
git commit -m "Add GitHub adapter: discovery via search + notifications, timeline normalization" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Poller

**Files:**
- Create: `src/core/poller.ts`
- Test: `test/poller.test.ts`

Key behaviours, each covered by a test:
- **Baseline:** the first fetch of an item stores its history but makes nothing unread.
- **Dedup:** events are keyed `(item_url, event_key)`, so re-fetching is idempotent.
- **New signal:** `lastSignalAt = now` (the detection time). Unread means `lastSignalAt > seenAt`.
- **Own activity:** your own event after the latest signal sets `seenAt = now`.
- **Derived events:** CI result changes and new merge conflicts.
- **Cursor:** each run queries from `cursor − 5 min`. The cursor advances only if the whole instance succeeded.
- **Errors:** `GoneError` marks the item `gone` with one signal. `RateLimitError` stops the instance. Other errors fail one item without blocking the rest.
- **Dry run:** wraps everything in a transaction that is rolled back. A `locks` row prevents overlapping polls.

- [ ] **Step 1: Write the failing test `test/poller.test.ts`**

```ts
import { beforeEach, expect, test } from "bun:test";
import { DEFAULT_FILTER, type Config, type InstanceConfig } from "../src/core/config.ts";
import { GoneError, RateLimitError } from "../src/core/http.ts";
import { parseIntent } from "../src/core/intent.ts";
import type { Adapter, ItemRef, NormalizedEvent, Snapshot } from "../src/core/model.ts";
import { applySnapshot, CURSOR_OVERLAP_MS, pollAll, refilter, type PollContext } from "../src/core/poller.ts";
import { Store } from "../src/core/store.ts";

const PR = "https://github.com/foo/bar/pull/42";
const ISSUE = "https://github.com/foo/bar/issues/7";
const inst: InstanceConfig = { id: "github", type: "github", url: "https://api.github.com", user: "lapo" };
const config: Config = { instances: [inst], filter: DEFAULT_FILTER };

const T0 = new Date("2026-11-04T10:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function comment(key: string, at: Date, actorRole: NormalizedEvent["actorRole"], body: string, actor = "maint"): NormalizedEvent {
  return { key, kind: "comment", actor, actorRole, at, body };
}

function snapshot(url: string, events: NormalizedEvent[], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    ref: { url, instance: "github", kind: url.includes("/pull/") ? "pr" : "issue" },
    repo: "foo/bar", title: "Title", state: "open", authoredByMe: true, labels: [], events, ...extra,
  };
}

/** A fake adapter whose discover/fetch results are set per test. */
class FakeAdapter implements Adapter {
  discovered: ItemRef[] = [];
  snapshots = new Map<string, Snapshot | Error>();
  sinceSeen: (Date | null)[] = [];
  refFromUrl(url: string): ItemRef | null {
    return url.startsWith("https://github.com/") ? { url, instance: "github", kind: url.includes("/pull/") ? "pr" : "issue" } : null;
  }
  async discover(since: Date | null) {
    this.sinceSeen.push(since);
    return this.discovered;
  }
  async fetch(ref: ItemRef) {
    const s = this.snapshots.get(ref.url);
    if (!s) throw new Error(`no snapshot for ${ref.url}`);
    if (s instanceof Error) throw s;
    return s;
  }
}

let store: Store;
let adapter: FakeAdapter;
let clock: Date;
let ctx: PollContext;
beforeEach(() => {
  store = new Store(":memory:");
  adapter = new FakeAdapter();
  clock = T0;
  ctx = { store, config, intent: new Map(), adapterFor: () => adapter, now: () => clock };
});

const unread = (url: string) => {
  const i = store.getItem(url)!;
  return i.lastSignalAt !== null && (i.seenAt === null || i.lastSignalAt > i.seenAt);
};

test("first sight is baseline: history stored, nothing unread", () => {
  const n = applySnapshot(snapshot(PR, [comment("c:1", minutes(-60), "maintainer", "Please rebase")]), ctx, T0);
  expect(n).toBe(0);
  expect(store.eventsFor(PR)).toHaveLength(1);
  expect(store.getItem(PR)).toMatchObject({ baselineAt: T0.toISOString(), lastSignalAt: null });
  expect(unread(PR)).toBe(false);
});

test("new signal after baseline makes the item unread, noise does not", () => {
  applySnapshot(snapshot(PR, []), ctx, T0);
  expect(applySnapshot(snapshot(PR, [comment("c:2", minutes(5), "contributor", "+1", "rando")]), ctx, minutes(10))).toBe(0);
  expect(unread(PR)).toBe(false);
  expect(applySnapshot(snapshot(PR, [comment("c:3", minutes(15), "maintainer", "LGTM")]), ctx, minutes(20))).toBe(1);
  expect(store.getItem(PR)).toMatchObject({ lastSignalAt: minutes(20).toISOString(), lastSignalSummary: "comment by @maint: LGTM" });
  expect(unread(PR)).toBe(true);
});

test("re-fetching the same events is idempotent", () => {
  applySnapshot(snapshot(PR, []), ctx, T0);
  const s = snapshot(PR, [comment("c:3", minutes(15), "maintainer", "LGTM")]);
  expect(applySnapshot(s, ctx, minutes(20))).toBe(1);
  expect(applySnapshot(s, ctx, minutes(40))).toBe(0);
  expect(store.getItem(PR)?.lastSignalAt).toBe(minutes(20).toISOString());
});

test("my own reply after the latest signal marks the item seen", () => {
  applySnapshot(snapshot(PR, []), ctx, T0);
  applySnapshot(snapshot(PR, [
    comment("c:1", minutes(5), "maintainer", "Please rebase"),
    comment("c:2", minutes(8), "me", "Done, rebased.", "lapo"),
  ]), ctx, minutes(10));
  expect(unread(PR)).toBe(false);
  applySnapshot(snapshot(PR, [comment("c:3", minutes(12), "maintainer", "Thanks, merging after CI")]), ctx, minutes(15));
  expect(unread(PR)).toBe(true);
});

test("CI changes and conflicts are derived; pending keeps the last settled state", () => {
  applySnapshot(snapshot(PR, [], { ciState: "success" }), ctx, T0);
  expect(applySnapshot(snapshot(PR, [], { ciState: "pending" }), ctx, minutes(5))).toBe(0);
  expect(store.getItem(PR)?.ciState).toBe("success");
  expect(applySnapshot(snapshot(PR, [], { ciState: "failure" }), ctx, minutes(10))).toBe(1);
  expect(store.getItem(PR)?.lastSignalSummary).toBe("CI → failure");
  expect(applySnapshot(snapshot(PR, [], { ciState: "failure", hasConflicts: true }), ctx, minutes(15))).toBe(1);
  expect(store.getItem(PR)?.lastSignalSummary).toBe("merge conflict");
});

test("first green CI is not news; CI on a normal-priority item is stored as noise", () => {
  applySnapshot(snapshot(PR, []), ctx, T0);
  expect(applySnapshot(snapshot(PR, [], { ciState: "success" }), ctx, minutes(5))).toBe(0);
  const other = "https://github.com/x/y/pull/1";
  applySnapshot(snapshot(other, [], { authoredByMe: false, ciState: "success" }), ctx, T0);
  expect(applySnapshot(snapshot(other, [], { authoredByMe: false, ciState: "failure" }), ctx, minutes(5))).toBe(0);
  expect(store.eventsFor(other, true)[0]?.reason).toBe("low-priority:ci");
});

test("pollAll: discovery, intent-only items, cursor and overlap", async () => {
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }];
  adapter.snapshots.set(PR, snapshot(PR, []));
  adapter.snapshots.set(ISSUE, snapshot(ISSUE, []));
  ctx.intent = parseIntent(`items:\n  - url: ${ISSUE}\n    priority: important\n  - url: https://lists.example.org/x\n    manual: true`);
  const [r] = await pollAll(ctx);
  expect(r).toEqual({ instance: "github", ok: true, fetched: 2, newSignals: 0 });
  expect(store.getItem(ISSUE)).not.toBeNull();
  expect(store.getItem("https://lists.example.org/x")).toBeNull();
  expect(adapter.sinceSeen).toEqual([null]);
  clock = minutes(30);
  await pollAll(ctx);
  expect(adapter.sinceSeen[1]?.getTime()).toBe(T0.getTime() - CURSOR_OVERLAP_MS);
});

test("pollAll: a failed item keeps the cursor; gone items get one signal", async () => {
  applySnapshot(snapshot(ISSUE, []), ctx, T0);
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }, { url: ISSUE, instance: "github", kind: "issue" }];
  adapter.snapshots.set(PR, new Error("boom"));
  adapter.snapshots.set(ISSUE, new GoneError(404, "x"));
  clock = minutes(10);
  const [r] = await pollAll(ctx);
  expect(r).toMatchObject({ ok: false, newSignals: 1, error: `1 item(s) failed; first: ${PR}: boom` });
  expect(store.getItem(ISSUE)).toMatchObject({ state: "gone", lastSignalSummary: "→ gone" });
  expect(store.getCursor("github")).toBeNull();
});

test("pollAll: rate limit stops the instance; disabled instances report why", async () => {
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }];
  adapter.snapshots.set(PR, new RateLimitError(403, "x", null));
  const [r] = await pollAll(ctx);
  expect(r).toMatchObject({ ok: false, error: "rate limited on x" });
  ctx.config = { ...config, instances: [{ ...inst, disabledReason: "missing GITHUB_TOKEN in .env" }] };
  const [d] = await pollAll(ctx);
  expect(d).toMatchObject({ ok: false, error: "missing GITHUB_TOKEN in .env" });
});

test("pollAll: dry run writes nothing; lock prevents overlap", async () => {
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }];
  adapter.snapshots.set(PR, snapshot(PR, []));
  const [r] = await pollAll(ctx, { dryRun: true });
  expect(r?.fetched).toBe(1);
  expect(store.getItem(PR)).toBeNull();
  expect(store.getCursor("github")).toBeNull();
  store.acquireLock("poll", "other", T0);
  await expect(pollAll(ctx)).rejects.toThrow("a poll is already running");
  await expect(pollAll(ctx, { only: "nope" })).rejects.toThrow("unknown instance 'nope'");
});

test("refilter re-evaluates stored events with a new config", () => {
  applySnapshot(snapshot(PR, []), ctx, T0);
  applySnapshot(snapshot(PR, [comment("c:1", minutes(5), "contributor", "works for me on 14.1 amd64 with the patch applied", "user")]), ctx, minutes(10));
  expect(unread(PR)).toBe(true);
  const stricter: Config = { ...config, filter: { ...DEFAULT_FILTER, noisePatterns: ["^works for me"] } };
  expect(refilter(store, stricter, new Map())).toEqual({ changed: 1 });
  expect(store.getItem(PR)?.lastSignalAt).toBeNull();
  expect(unread(PR)).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/poller.test.ts`
Expected: FAIL with `Cannot find module '../src/core/poller.ts'`.

- [ ] **Step 3: Implement `src/core/poller.ts`**

```ts
// discover → fetch → diff → filter → store, per instance.
import type { Config, InstanceConfig } from "./config.ts";
import { classify } from "./filter.ts";
import { GoneError, RateLimitError } from "./http.ts";
import { effectivePriority, type Intent } from "./intent.ts";
import type { Adapter, ItemRef, NormalizedEvent, Snapshot } from "./model.ts";
import { itemId, type EventRow, type ItemRow, type Store } from "./store.ts";
import { summarize } from "./summary.ts";

/** Each run re-queries this much before the cursor, to tolerate clock skew; event keys dedup the overlap. */
export const CURSOR_OVERLAP_MS = 5 * 60_000;
const FETCH_CONCURRENCY = 4;

export interface PollContext {
  store: Store;
  config: Config;
  intent: Intent;
  adapterFor: (inst: InstanceConfig) => Adapter;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface InstanceResult {
  instance: string;
  ok: boolean;
  fetched: number;
  newSignals: number;
  error?: string;
}

export async function pollAll(ctx: PollContext, opts: { only?: string; dryRun?: boolean } = {}): Promise<InstanceResult[]> {
  const now = ctx.now ?? (() => new Date());
  const instances = ctx.config.instances.filter((i) => !opts.only || i.id === opts.only);
  if (opts.only && instances.length === 0) throw new Error(`unknown instance '${opts.only}'`);
  if (!ctx.store.acquireLock("poll", `pid:${process.pid}`, now())) throw new Error("a poll is already running");
  if (opts.dryRun) ctx.store.begin(); // everything below is rolled back at the end
  try {
    const results: InstanceResult[] = [];
    for (const inst of instances) results.push(await pollInstance(inst, ctx));
    return results;
  } finally {
    if (opts.dryRun) ctx.store.rollback();
    ctx.store.releaseLock("poll");
  }
}

export async function pollInstance(inst: InstanceConfig, ctx: PollContext): Promise<InstanceResult> {
  const now = ctx.now ?? (() => new Date());
  const log = ctx.log ?? (() => {});
  const startedAt = now();
  const result: InstanceResult = { instance: inst.id, ok: false, fetched: 0, newSignals: 0 };
  const cursor = ctx.store.getCursor(inst.id);
  let error: string | null = null;
  try {
    if (inst.disabledReason) throw new Error(inst.disabledReason);
    const adapter = ctx.adapterFor(inst);
    const since = cursor ? new Date(new Date(cursor).getTime() - CURSOR_OVERLAP_MS) : null;
    const refs = new Map<string, ItemRef>();
    for (const r of await adapter.discover(since)) refs.set(r.url, r);
    // Items listed in items.yaml that the cache has never seen (e.g. added by hand).
    for (const entry of ctx.intent.values()) {
      if (entry.manual || ctx.store.getItem(entry.url)) continue;
      const r = adapter.refFromUrl(entry.url);
      if (r) refs.set(r.url, r);
    }
    const failures: string[] = [];
    await forEachLimit([...refs.values()], FETCH_CONCURRENCY, async (ref) => {
      try {
        const snap = await adapter.fetch(ref);
        result.fetched++;
        result.newSignals += applySnapshot(snap, ctx, now(), log);
      } catch (err) {
        if (err instanceof GoneError) {
          result.newSignals += markGone(ref, ctx, now(), log);
          return;
        }
        if (err instanceof RateLimitError) throw err; // stop the whole instance
        failures.push(`${ref.url}: ${(err as Error).message}`);
      }
    });
    if (failures.length) error = `${failures.length} item(s) failed; first: ${failures[0]}`;
  } catch (err) {
    error = (err as Error).message;
  }
  result.ok = error === null;
  if (error) result.error = error;
  // The cursor only advances on full success, so failed items are re-discovered next time.
  ctx.store.recordRun({
    instance: inst.id,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    cursor: error ? cursor : startedAt.toISOString(),
    error,
  });
  return result;
}

/** Runs `fn` over `items` with at most `limit` in flight; the first thrown error stops new work and is rethrown. */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        stopped = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Synthesizes events the forge does not report as such: CI result changes and new merge conflicts. */
function derivedEvents(prev: ItemRow | null, snap: Snapshot, ci: ItemRow["ciState"], now: Date): NormalizedEvent[] {
  if (!prev) return [];
  const out: NormalizedEvent[] = [];
  const stamp = now.toISOString();
  // A first green result is not news; a first red one, or any change of a settled result, is.
  if (ci && ci !== prev.ciState && !(prev.ciState === null && ci === "success")) {
    out.push({ key: `ci:${stamp}`, kind: "ci", actor: "", actorRole: "unknown", at: now, details: { from: prev.ciState, to: ci } });
  }
  if (snap.hasConflicts && !prev.hasConflicts) {
    out.push({ key: `conflict:${stamp}`, kind: "conflict", actor: "", actorRole: "unknown", at: now });
  }
  return out;
}

/**
 * Stores a fetched snapshot and returns how many new signal events it brought.
 * On first sight of an item everything is recorded as baseline (nothing unread).
 */
export function applySnapshot(snap: Snapshot, ctx: PollContext, now: Date, log: (line: string) => void = () => {}): number {
  const { store, config, intent } = ctx;
  const url = snap.ref.url;
  const prev = store.getItem(url);
  const nowIso = now.toISOString();
  const priority = effectivePriority(intent.get(url), snap.ref.kind, snap.authoredByMe);
  // CI: remember the last settled result; "pending" does not overwrite it.
  const ci = snap.ciState === "pending" ? (prev?.ciState ?? null) : (snap.ciState ?? null);

  let latestSignal: EventRow | null = null;
  let latestOwnAt: string | null = null;
  let newSignals = 0;
  for (const ev of [...snap.events, ...derivedEvents(prev, snap, ci, now)]) {
    const verdict = classify(ev, priority, config.filter);
    const row: EventRow = {
      itemUrl: url, key: ev.key, kind: ev.kind, actor: ev.actor, actorRole: ev.actorRole,
      at: ev.at.toISOString(), detectedAt: nowIso, excerpt: ev.body ? ev.body.slice(0, 500) : null,
      details: ev.details ?? null, isSignal: verdict.isSignal, reason: verdict.reason,
    };
    if (!store.insertEvent(row) || !prev) continue; // already known, or baseline
    if (ev.actorRole === "me") {
      if (!latestOwnAt || row.at > latestOwnAt) latestOwnAt = row.at;
      continue;
    }
    if (!verdict.isSignal) continue;
    newSignals++;
    log(`  ${snap.repo}: ${snap.title} — ${summarize(row)}`);
    if (!latestSignal || row.at >= latestSignal.at) latestSignal = row;
  }

  let lastSignalAt = prev?.lastSignalAt ?? null;
  let lastSignalSummary = prev?.lastSignalSummary ?? null;
  let seenAt = prev?.seenAt ?? null;
  if (latestSignal) {
    lastSignalAt = nowIso;
    lastSignalSummary = summarize(latestSignal);
  }
  // My own activity after the latest signal means I have already looked at it.
  if (latestOwnAt && (!latestSignal || latestSignal.at <= latestOwnAt)) seenAt = nowIso;

  const { events: _events, ...meta } = snap;
  store.upsertItem({
    url, id: itemId(url), instance: snap.ref.instance, kind: snap.ref.kind, repo: snap.repo,
    title: snap.title, state: snap.state, stateDetail: snap.stateDetail ?? null, ciState: ci,
    hasConflicts: snap.hasConflicts ?? false, authoredByMe: snap.authoredByMe, labels: snap.labels,
    lastSignalAt, lastSignalSummary, seenAt, baselineAt: prev?.baselineAt ?? nowIso,
    fetchedAt: nowIso, snapshotJson: JSON.stringify(meta),
  });
  return newSignals;
}

function markGone(ref: ItemRef, ctx: PollContext, now: Date, log: (line: string) => void): number {
  const prev = ctx.store.getItem(ref.url);
  if (!prev || prev.state === "gone") return 0;
  const nowIso = now.toISOString();
  const row: EventRow = {
    itemUrl: ref.url, key: `gone:${nowIso}`, kind: "state", actor: "", actorRole: "unknown",
    at: nowIso, detectedAt: nowIso, excerpt: null, details: { to: "gone" },
    isSignal: true, reason: "signal:state",
  };
  ctx.store.insertEvent(row);
  ctx.store.upsertItem({ ...prev, state: "gone", lastSignalAt: nowIso, lastSignalSummary: summarize(row), fetchedAt: nowIso });
  log(`  ${prev.repo}: ${prev.title} — ${summarize(row)}`);
  return 1;
}

/** Re-runs the filter over all stored events (after tuning config) and recomputes each item's latest signal. */
export function refilter(store: Store, config: Config, intent: Intent): { changed: number } {
  let changed = 0;
  for (const item of store.listItems()) {
    const priority = effectivePriority(intent.get(item.url), item.kind, item.authoredByMe);
    for (const e of store.eventsFor(item.url, true)) {
      const v = classify(
        { key: e.key, kind: e.kind, actor: e.actor, actorRole: e.actorRole, at: new Date(e.at),
          body: e.excerpt ?? undefined, details: e.details ?? undefined },
        priority, config.filter);
      if (v.isSignal !== e.isSignal || v.reason !== e.reason) {
        store.setVerdict(item.url, e.key, v);
        changed++;
      }
    }
    const latest = store.eventsFor(item.url)
      .filter((e) => e.detectedAt > item.baselineAt)
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt) || b.at.localeCompare(a.at))[0];
    store.upsertItem({
      ...item,
      lastSignalAt: latest?.detectedAt ?? null,
      lastSignalSummary: latest ? summarize(latest) : null,
    });
  }
  return { changed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/poller.test.ts`
Expected: `11 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/poller.ts test/poller.test.ts
git commit -m "Add poller: incremental discovery, baseline, dedup, unread tracking, refilter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Query API

**Files:**
- Create: `src/core/api.ts`
- Test: `test/api.test.ts`

The single place where front ends read and change state. The CLI uses it now; the HTTP server (plan 3) and a future MCP server will use the same functions.

- [ ] **Step 1: Write the failing test `test/api.test.ts`**

```ts
import { beforeEach, expect, test } from "bun:test";
import { listItems, markSeen } from "../src/core/api.ts";
import { parseIntent } from "../src/core/intent.ts";
import { itemId, Store, type ItemRow } from "../src/core/store.ts";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

function row(url: string, extra: Partial<ItemRow>): ItemRow {
  return {
    url, id: itemId(url), instance: "github", kind: "issue", repo: "foo/bar", title: url.slice(-1),
    state: "open", stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: false, labels: [],
    lastSignalAt: null, lastSignalSummary: null, seenAt: null, baselineAt: "2026-11-01T00:00:00.000Z",
    fetchedAt: "2026-11-01T00:00:00.000Z", snapshotJson: null, ...extra,
  };
}

const A = "https://github.com/f/b/issues/A";
const B = "https://github.com/f/b/issues/B";
const C = "https://github.com/f/b/pull/C";
const M = "https://github.com/f/b/issues/M";

test("sorting, priority, unread, muted, manual", () => {
  store.upsertItem(row(A, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  store.upsertItem(row(B, { lastSignalAt: "2026-11-04T00:00:00.000Z", seenAt: "2026-11-04T01:00:00.000Z" }));
  store.upsertItem(row(C, { kind: "pr", authoredByMe: true, lastSignalAt: "2026-11-01T00:00:00.000Z" }));
  store.upsertItem(row(M, { lastSignalAt: "2026-11-05T00:00:00.000Z" }));
  const intent = parseIntent(`items:
  - url: ${M}
    muted: true
  - url: https://lists.example.org/p1
    manual: true
    title: "[PATCH] x"
`);
  const all = listItems(store, intent);
  expect(all.map((v) => v.title)).toEqual(["C", "B", "A", "[PATCH] x"]);
  expect(all[0]).toMatchObject({ priority: "important", unread: true });
  expect(all[1]?.unread).toBe(false);
  expect(all[3]).toMatchObject({ kind: "manual", repo: "lists.example.org", instance: null });
  expect(listItems(store, intent, { unreadOnly: true }).map((v) => v.title)).toEqual(["C", "A"]);
  expect(listItems(store, intent, { includeMuted: true })).toHaveLength(5);
});

test("markSeen by url or all", () => {
  store.upsertItem(row(A, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  store.upsertItem(row(B, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  const now = new Date("2026-11-04T00:00:00.000Z");
  expect(markSeen(store, [A, "https://nope"], now)).toBe(1);
  expect(listItems(store, new Map(), { unreadOnly: true }).map((v) => v.url)).toEqual([B]);
  expect(markSeen(store, [], now)).toBe(2);
  expect(listItems(store, new Map(), { unreadOnly: true })).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/api.test.ts`
Expected: FAIL with `Cannot find module '../src/core/api.ts'`.

- [ ] **Step 3: Implement `src/core/api.ts`**

```ts
// Query/command API shared by every front end (CLI now; HTTP server and MCP later).
import { effectivePriority, type Intent } from "./intent.ts";
import type { CiState, ItemKind, Priority } from "./model.ts";
import { itemId, type Store } from "./store.ts";

export interface ItemView {
  id: string;
  url: string;
  instance: string | null; // null for manual items
  kind: ItemKind | "manual";
  repo: string;
  title: string;
  state: string;
  ciState: CiState | null;
  priority: Priority;
  muted: boolean;
  note: string | null;
  unread: boolean;
  lastSignalAt: string | null;
  lastSignalSummary: string | null;
}

export interface ListOptions {
  unreadOnly?: boolean;
  includeMuted?: boolean;
}

/** Important first, then most recent signal first; items that never had a signal last. */
export function listItems(store: Store, intent: Intent, opts: ListOptions = {}): ItemView[] {
  const views: ItemView[] = store.listItems().map((i) => {
    const entry = intent.get(i.url);
    return {
      id: i.id, url: i.url, instance: i.instance, kind: i.kind, repo: i.repo, title: i.title,
      state: i.stateDetail ? `${i.state} (${i.stateDetail})` : i.state, ciState: i.ciState,
      priority: effectivePriority(entry, i.kind, i.authoredByMe),
      muted: entry?.muted ?? false, note: entry?.note ?? null,
      unread: i.lastSignalAt !== null && (i.seenAt === null || i.lastSignalAt > i.seenAt),
      lastSignalAt: i.lastSignalAt, lastSignalSummary: i.lastSignalSummary,
    };
  });
  for (const entry of intent.values()) {
    if (!entry.manual) continue;
    views.push({
      id: itemId(entry.url), url: entry.url, instance: null, kind: "manual", repo: new URL(entry.url).host,
      title: entry.title ?? entry.url, state: "manual", ciState: null, priority: entry.priority ?? "normal",
      muted: entry.muted, note: entry.note ?? null, unread: false, lastSignalAt: null, lastSignalSummary: null,
    });
  }
  return views
    .filter((v) => (opts.includeMuted || !v.muted) && (!opts.unreadOnly || v.unread))
    .sort((a, b) =>
      (a.priority === b.priority ? 0 : a.priority === "important" ? -1 : 1) ||
      (b.lastSignalAt ?? "").localeCompare(a.lastSignalAt ?? "") ||
      a.title.localeCompare(b.title));
}

/** Marks items seen by URL (or all items when `urls` is empty); returns how many were updated. */
export function markSeen(store: Store, urls: string[], now: Date): number {
  const at = now.toISOString();
  if (urls.length === 0) return store.markAllSeen(at);
  return urls.filter((u) => store.markSeen(u, at)).length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/api.test.ts`
Expected: `2 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/api.ts test/api.test.ts
git commit -m "Add query API (list, mark seen) shared by all front ends" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: CLI, README and live smoke test

**Files:**
- Create: `src/cli.ts`, `README.md`

- [ ] **Step 1: Implement `src/cli.ts`**

```ts
#!/usr/bin/env bun
// Command-line front end: `bun src/cli.ts <command>` (or `bun run watcher <command>`).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createAdapter } from "./adapters/index.ts";
import { listItems, markSeen } from "./core/api.ts";
import { loadConfig } from "./core/config.ts";
import { loadIntent } from "./core/intent.ts";
import { pollAll, refilter } from "./core/poller.ts";
import { Store } from "./core/store.ts";

const USAGE = `usage: watcher <command> [options]

  poll [--instance ID] [--dry-run]   poll forges for changes (--dry-run saves nothing)
  list [--all] [--muted]             show unread items (--all: every item)
  seen [URL...]                      mark items seen (no URL: all items)
  refilter                           re-run the noise filter over stored events`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      instance: { type: "string" },
      "dry-run": { type: "boolean" },
      all: { type: "boolean" },
      muted: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [cmd, ...args] = positionals;
  if (!cmd) {
    console.error(USAGE);
    return 2;
  }

  const home = process.env.WATCHER_HOME ?? join(import.meta.dir, "..");
  const config = await loadConfig(join(home, "data/config.yaml"));
  const intent = await loadIntent(join(home, "data/items.yaml"));
  mkdirSync(join(home, "var"), { recursive: true });
  const store = new Store(join(home, "var/cache.sqlite"));
  try {
    switch (cmd) {
      case "poll": {
        const dryRun = values["dry-run"] ?? false;
        const results = await pollAll({ store, config, intent, adapterFor: createAdapter, log: console.log }, { only: values.instance, dryRun });
        for (const r of results) {
          console.log(r.ok
            ? `${r.instance}: ok, ${r.fetched} fetched, ${r.newSignals} new signal(s)`
            : `${r.instance}: ERROR ${r.error} (${r.fetched} fetched, ${r.newSignals} new signal(s))`);
        }
        if (dryRun) console.log("(dry run: nothing was saved)");
        return results.every((r) => r.ok) ? 0 : 1;
      }
      case "list": {
        const items = listItems(store, intent, { unreadOnly: !values.all, includeMuted: values.muted });
        for (const i of items) {
          const flags = `${i.unread ? "●" : " "}${i.priority === "important" ? "★" : " "}`;
          console.log(`${flags} ${i.repo}  ${i.title}  [${i.state}${i.ciState ? `, CI ${i.ciState}` : ""}]`);
          console.log(`     ${i.lastSignalSummary ?? "—"}  ${i.url}`);
        }
        if (items.length === 0) console.log(values.all ? "no items" : "nothing unread");
        return 0;
      }
      case "seen": {
        console.log(`${markSeen(store, args, new Date())} item(s) marked seen`);
        return 0;
      }
      case "refilter": {
        const { changed } = refilter(store, config, intent);
        console.log(`${changed} event verdict(s) changed`);
        return 0;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  } finally {
    store.close();
  }
}

try {
  process.exit(await main(Bun.argv.slice(2)));
} catch (err) {
  console.error(`watcher: ${(err as Error).message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Write `README.md`**

````markdown
# watcher

Tracks the PRs, issues and bugs you are involved in across forges, and shows only meaningful
activity: reviews, maintainer comments, state changes, CI results. It ignores "+1"s, emoji, bots
and "any update?" pings. Design: `docs/superpowers/specs/2026-11-04-pr-watcher-design.md`.

## Setup

Requires [Bun](https://bun.sh) ≥ 1.4 (Linux or FreeBSD).

```sh
bun install
cp data/config.example.yaml data/config.yaml   # set your logins, then commit it (no secrets inside)
cp .env.example .env                           # put your tokens here (git-ignored)
bun run watcher poll --dry-run                 # check instances and tokens; saves nothing
bun run watcher poll                           # first real run: records history as baseline
```

### GitHub token

Use a **classic** personal access token with the `repo` scope (or only `public_repo`) and
the `notifications` scope. Fine-grained tokens work too, but they cannot read notifications,
so issues you only *subscribed to* are not discovered.

## Commands

```
bun run watcher poll [--instance ID] [--dry-run]
bun run watcher list [--all] [--muted]
bun run watcher seen [URL...]
bun run watcher refilter
```

## Polling periodically

The poll is a one-shot command, so run it from cron or a systemd timer, e.g. every 20 minutes:

```cron
*/20 * * * * cd /path/to/watcher && /usr/local/bin/bun src/cli.ts poll >/dev/null
```

## Files

| Path               | In git | Content                                              |
|--------------------|--------|------------------------------------------------------|
| `data/config.yaml` | yes    | instances and filter tuning                          |
| `data/items.yaml`  | yes    | your intent: priority, mute, notes, manual items     |
| `.env`             | no     | tokens                                               |
| `var/cache.sqlite` | no     | cache; delete it to start over from a quiet baseline |
````

- [ ] **Step 3: Run the full suite and the type checker**

Run: `bun test && bun run typecheck`
Expected: `68 pass, 0 fail` across 9 files, then no type errors.

- [ ] **Step 4: Check usage and the missing-config error**

Run: `bun run watcher; echo "exit=$?"`
Expected: the usage text on stderr, `exit=2`.

Run: `bun run watcher list; echo "exit=$?"`
Expected (with no `data/config.yaml` yet): `watcher: config file not found: …/data/config.yaml (copy data/config.example.yaml)`, `exit=1`.

- [ ] **Step 5: Live smoke test with a throwaway home (no token needed)**

Create a scratch home outside the repo with an anonymous GitHub instance (unauthenticated: 60 requests per hour, which is enough for a smoke test) and an instance with a missing token:

```bash
SMOKE=$(mktemp -d) && mkdir -p "$SMOKE/data" && cat > "$SMOKE/data/config.yaml" <<'EOF'
instances:
  - id: github
    type: github
    url: https://api.github.com
    user: octocat
  - id: needs-token
    type: github
    url: https://api.github.com
    user: octocat
    token_env: WATCHER_SMOKE_MISSING_TOKEN
EOF
WATCHER_HOME="$SMOKE" bun run watcher poll --dry-run; echo "exit=$?"
```

Expected:
- `github: ok, N fetched, 0 new signal(s)`. `octocat` is involved in many items, though, so the anonymous budget of 60 requests per hour may run out first. In that case the line reads `github: ERROR rate limited on https://api.github.com/… until <time> (N fetched, …)`. That is also a pass: it exercises the real rate-limit path, which stops the instance cleanly.
- `needs-token: ERROR missing WATCHER_SMOKE_MISSING_TOKEN in .env (0 fetched, 0 new signal(s))`
- `(dry run: nothing was saved)`, then `exit=1`, because at least one instance failed.

If the first line said `ok`, also check a real (non-dry) run and the listing:

```bash
WATCHER_HOME="$SMOKE" bun run watcher poll --instance github && WATCHER_HOME="$SMOKE" bun run watcher list --all
```

Expected: the poll reports `ok`, and `list --all` shows the discovered items with none marked `●`, because the first run is the baseline.

Clean up: `rm -rf "$SMOKE"`.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts README.md
git commit -m "Add watcher CLI (poll, list, seen, refilter) and README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand over to the user for real configuration** (not something an agent does)

The user copies `data/config.example.yaml` to `data/config.yaml` with their real GitHub login and commits it, puts a classic token with `public_repo` + `notifications` in `.env`, then runs `bun run watcher poll` twice (baseline, then incremental) and `bun run watcher list`.

---

## Outcome and deferred review items

Implemented on branch `plan-1-foundation-github`. Two code reviews led to follow-up fix commits (see `git log`): baselining only on an instance's first run, review-request discovery, own-commit recognition via `emails`, mergeability/CI "unknown" handling, URL canonicalization, a retry table so one failing item no longer freezes the cursor, safe stop on rate limits, a SQLite busy timeout, `seen --all`, best-effort CI and a cache-upgrade backfill.

Deferred by agreement; to be considered when writing plan 3 (HTTP API + UI):
- Comment-only reviews with an empty body are signal; inline review threads (`/pulls/N/comments`) are not fetched. Decide: fetch them, or drop empty-body reviews.
- Review requests to a team I belong to are discovered but produce no `review_request` event.
- Poll lock: store the pid and take over a lock whose process is dead, instead of the 30-minute stale window.
- Pagination: check-runs read only page 1; `getAllPages` stops silently at 20 pages (newest timeline events dropped); PR commits cap at 250. At least log truncation.
- Config values (`noise_patterns`, `min_comment_length`, `bot_allowlist`) are not type-checked; `bot_allowlist` matching is case-sensitive.
- HTTP: timeouts while reading a body are not retried; GitHub secondary rate limits without rate-limit headers are treated as item failures.
- One helper for API timestamps (search strips milliseconds, notifications keep them).
- URL canonicalization: owner/repo case and PRs written as `/issues/N` still don't match.
- A `--dry-run` holds one write transaction for the whole poll; revisit when the server's "Poll now" exists.
- api.ts for the server: expose `state` and `stateDetail` separately, add lookup by item `id`, add an events/status read path so the server never touches `Store` directly; move `GoneError`/`HttpError` types to `model.ts` so the adapter contract is self-contained.
