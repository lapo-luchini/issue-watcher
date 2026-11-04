# Watcher — Plan 2: GitLab, Forgejo and Bugzilla adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `watcher poll` also tracks merge requests, issues and bugs on GitLab (gitlab.com, invent.kde.org…), Forgejo (codeberg.org…) and Bugzilla (bugs.freebsd.org, bugs.kde.org, bugzilla.mozilla.org), with the same signal/noise rules as GitHub.

**Architecture:** One adapter per forge type in `src/adapters/`, each implementing the existing `Adapter` contract (`refFromUrl`, `discover`, `fetch`) and normalizing into `Snapshot`/`NormalizedEvent`; the poller, store and filter stay forge-independent. Small core changes support them: `discover` receives the instance's cached ("known") items, shared adapter helpers move to `src/adapters/util.ts`, Bugzilla gets `maintainer_domains`, and the filter learns two bot rules. Spec: `docs/superpowers/specs/2026-11-04-pr-watcher-design.md` (section 3, "Discovery strategy", describes each forge).

**Tech Stack:** Bun ≥ 1.4 (`bun:sqlite`, `bun test`), TypeScript 7 (`tsc --noEmit` for type checking only), `yaml` 2.9. No new dependencies.

**This is plan 2 of 3.** Plan 1 (foundation + GitHub CLI) has landed. Plan 3 adds the HTTP API, the Vue UI and writing `items.yaml` with git commits.

**How this plan was made:** every file below was prototyped and tested before writing the plan (162 tests pass, type check clean). Response field names, system-note texts and error formats were checked against the live public APIs of gitlab.com, invent.kde.org, codeberg.org, bugs.freebsd.org, bugs.kde.org and bugzilla.mozilla.org (anonymous requests only). Endpoints that need a token could not be checked live and follow the documented shapes: GitLab `/merge_requests`, `/issues`, `/todos`, `/events`, `/members/all`; Forgejo `/repos/issues/search` with its "me" flags, `/notifications`, `/assignees`. An independent review of the prototype found nine issues, all fixed in the code below.

**What the live checks changed compared to the spec's first draft** (the spec is already updated):
- GitLab and Forgejo search cannot find items I only commented on. GitLab adds my "commented" contribution events and re-checks the cached ("known") items; Forgejo relies on notifications, falling back to the known items when the token cannot read them.
- GitLab notes, resource events and member lookups refuse anonymous requests, and Forgejo's search ignores its "me" flags without a token: both adapters require a token. Bugzilla works anonymously.
- Bugzilla 5.0 (FreeBSD, KDE) ignores the `X-BUGZILLA-API-KEY` header, so the key goes in the query string, added below the HTTP helper so it never appears in logged URLs.
- Bugzilla flag requests made by automation (FreeBSD's `bugzilla@FreeBSD.org` asks every ports PR's maintainer for feedback) and bot assignments are noise; flag grants stay signal even when a bot relays them.

**Conventions for every task:**
- Work in the repository root (`/project/watcher`) on branch `plan-2-more-forges`. Run `git pull` before starting (if the branch has no upstream, there is nothing to pull).
- Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The commands below add it with a second `-m`.
- TypeScript style: plain and readable for a JS developer, i.e. interfaces, annotations and string-literal unions. No enums, no decorators. `any` only at untrusted-input boundaries, with a comment saying so.
- **Copy code blocks exactly.** Some tools mask token-like strings when displaying files (e.g. as `[REDACTED:…]`); never type such a marker into a file. Test fixtures use `token: "dummy"`. Before every commit, `grep -rn REDACTED src test` must print nothing.
- Edits to existing files are given as "replace this exact text with that". If the text to replace is not found exactly once, stop and report instead of guessing.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/core/model.ts` | modify | `Adapter.discover(since, known)` |
| `src/core/store.ts` | modify | `listKnown(instance, fetchedSince)` |
| `src/core/poller.ts` | modify | pass the known items to `discover` |
| `src/core/http.ts` | modify | read GitLab's `RateLimit-Reset` |
| `src/core/config.ts` | modify | `maintainer_domains` (Bugzilla) |
| `src/core/summary.ts` | modify | summaries of flag / attachment / assign events |
| `src/core/filter.ts` | modify | bot flag requests and bot assignments are noise |
| `src/adapters/util.ts` | create | `notGone`, `optional`, `mentions`, `parseUrl`, shared by adapters |
| `src/adapters/github.ts` | modify | use `util.ts` (no behaviour change) |
| `src/adapters/gitlab.ts` | create | GitLab discovery + normalization |
| `src/adapters/forgejo.ts` | create | Forgejo/Gitea discovery + normalization |
| `src/adapters/bugzilla.ts` | create | Bugzilla discovery + normalization |
| `src/adapters/index.ts` | modify | `createAdapter` for all four types |
| `test/fake-http.ts`, `test/contract.ts` | create | fake forge API; checks every adapter must pass |
| `test/*.test.ts` | create/modify | one test file per module |
| `data/config.example.yaml`, `.env.example`, `README.md` | modify | examples and token instructions for the new forges |

---

### Task 1: Pass the cached ("known") items to discovery

GitLab cannot search for items I only commented on, so its discovery re-checks the items already in the cache. The poller passes them: open items, plus closed ones fetched in the last 30 days (late comments on a just-closed item still arrive), never gone ones.

**Files:**
- Modify: `src/core/model.ts`, `src/core/store.ts`, `src/core/poller.ts`
- Test: `test/store.test.ts`, `test/poller.test.ts`

- [ ] **Step 1: Add the failing store test**

In `test/store.test.ts`, insert this test immediately before the line `test("seen markers", () => {`:

```ts
test("listKnown: open items, plus closed ones fetched recently; never gone ones or other instances", () => {
  const at = (u: string, state: ItemRow["state"], fetchedAt: string, instance = "github") =>
    store.upsertItem({ ...item, url: u, id: itemId(u), state, fetchedAt, instance });
  at("https://x/open-old", "open", "2026-01-01T00:00:00.000Z");
  at("https://x/merged-recent", "merged", "2026-11-01T00:00:00.000Z");
  at("https://x/closed-old", "closed", "2026-01-01T00:00:00.000Z");
  at("https://x/gone-recent", "gone", "2026-11-01T00:00:00.000Z");
  at("https://x/other", "open", "2026-11-01T00:00:00.000Z", "gitlab");
  expect(store.listKnown("github", "2026-10-01T00:00:00.000Z")).toEqual([
    { url: "https://x/merged-recent", instance: "github", kind: "pr" },
    { url: "https://x/open-old", instance: "github", kind: "pr" },
  ]);
});

```

- [ ] **Step 2: Make the poller test expect the known items**

In `test/poller.test.ts`, replace:

```ts
  sinceSeen: (Date | null)[] = [];
  refFromUrl(url: string): ItemRef | null {
    return url.startsWith("https://github.com/") ? { url, instance: "github", kind: url.includes("/pull/") ? "pr" : "issue" } : null;
  }
  async discover(since: Date | null) {
    this.sinceSeen.push(since);
```

with:

```ts
  sinceSeen: (Date | null)[] = [];
  knownSeen: ItemRef[][] = [];
  refFromUrl(url: string): ItemRef | null {
    return url.startsWith("https://github.com/") ? { url, instance: "github", kind: url.includes("/pull/") ? "pr" : "issue" } : null;
  }
  async discover(since: Date | null, known: ItemRef[]) {
    this.sinceSeen.push(since);
    this.knownSeen.push(known);
```

and replace:

```ts
  expect(adapter.sinceSeen).toEqual([null]);
  clock = minutes(30);
  await pollAll(ctx);
  expect(adapter.sinceSeen[1]?.getTime()).toBe(T0.getTime() - CURSOR_OVERLAP_MS);
});
```

with:

```ts
  expect(adapter.sinceSeen).toEqual([null]);
  expect(adapter.knownSeen).toEqual([[]]);
  clock = minutes(30);
  await pollAll(ctx);
  expect(adapter.sinceSeen[1]?.getTime()).toBe(T0.getTime() - CURSOR_OVERLAP_MS);
  // Discovery is told which items are already tracked, so it can check them for updates.
  expect(adapter.knownSeen[1]?.map((r) => r.url)).toEqual([ISSUE, PR]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/store.test.ts test/poller.test.ts`
Expected: FAIL: `store.listKnown is not a function`, and the poller test's `knownSeen` expectation fails (`[undefined]` received).

- [ ] **Step 4: Change the contract in `src/core/model.ts`**

Replace:

```ts
  /** Items involving me that changed since `since` (null: first run, open items only). */
  discover(since: Date | null): Promise<ItemRef[]>;
```

with:

```ts
  /**
   * Items involving me that changed since `since` (null: first run, open items only).
   * `known` lists this instance's items already in the cache (open, or fetched recently):
   * forges whose search cannot find items I only commented on check these for updates.
   */
  discover(since: Date | null, known: ItemRef[]): Promise<ItemRef[]>;
```

(`GitHubAdapter.discover(since)` still satisfies it: TypeScript allows an implementation to ignore trailing parameters.)

- [ ] **Step 5: Add `listKnown` to `src/core/store.ts`**

Replace:

```ts
  listItems(): ItemRow[] {
    return this.db.query("SELECT * FROM items").all().map(toItem);
  }
```

with:

```ts
  listItems(): ItemRow[] {
    return this.db.query("SELECT * FROM items").all().map(toItem);
  }

  /** Refs of an instance's items that may still change: open ones, and any fetched since `fetchedSince`. */
  listKnown(instance: string, fetchedSince: string): ItemRef[] {
    return this.db.query(`SELECT url, instance, kind FROM items
      WHERE instance = $instance AND state != 'gone' AND (state = 'open' OR fetched_at >= $fetchedSince)
      ORDER BY url`).all({ instance, fetchedSince }) as ItemRef[];
  }
```

(`ItemRef` is already imported there from `./model.ts`.)

- [ ] **Step 6: Pass them from `src/core/poller.ts`**

Replace:

```ts
const FETCH_CONCURRENCY = 4;
```

with:

```ts
const FETCH_CONCURRENCY = 4;
/** Closed items stay "known" to discovery for this long after their last fetch (late comments). */
const KNOWN_RECENT_MS = 30 * 24 * 60 * 60_000;
```

and replace:

```ts
    for (const r of await adapter.discover(since)) refs.set(r.url, r);
```

with:

```ts
    const known = ctx.store.listKnown(inst.id, new Date(startedAt.getTime() - KNOWN_RECENT_MS).toISOString());
    for (const r of await adapter.discover(since, known)) refs.set(r.url, r);
```

- [ ] **Step 7: Run the tests and the type checker**

Run: `bun test && bun run typecheck`
Expected: all tests pass (92), then no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/core/model.ts src/core/store.ts src/core/poller.ts test/store.test.ts test/poller.test.ts
git commit -m "Pass the cached items to discovery, for forges that cannot search for them" -m "GitLab has no 'involves' search, so items I only commented on can only be found by re-checking the ones already tracked." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Read GitLab's rate-limit reset header

GitHub sends `X-RateLimit-Reset`; GitLab sends `RateLimit-Reset` (also epoch seconds) with its 429s. Both already become a `RateLimitError`; this makes the reset time known for GitLab too.

**Files:**
- Modify: `src/core/http.ts`
- Test: `test/http.test.ts`

- [ ] **Step 1: Add the failing test**

In `test/http.test.ts`, insert immediately before the line `test("nextLink", () => {`:

```ts
test("GitLab-style 429 with RateLimit-Reset", async () => {
  const res = new Response("", { status: 429, headers: { "ratelimit-reset": "1790000000" } });
  const err = await getJson("http://x/", {}, fakeHttp([res]).deps).catch((e) => e);
  expect(err).toBeInstanceOf(RateLimitError);
  expect((err as RateLimitError).resetAt?.getTime()).toBe(1790000000 * 1000);
});

```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/http.test.ts`
Expected: FAIL: `resetAt?.getTime()` is `undefined`, expected `1790000000000`.

- [ ] **Step 3: Implement**

In `src/core/http.ts`, replace:

```ts
  const reset = res.headers.get("x-ratelimit-reset");
```

with:

```ts
  // GitHub sends X-RateLimit-Reset, GitLab RateLimit-Reset; both are epoch seconds.
  const reset = res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset");
```

- [ ] **Step 4: Run the test**

Run: `bun test test/http.test.ts`
Expected: `8 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/http.ts test/http.test.ts
git commit -m "Report GitLab's rate-limit reset time" -m "GitLab sends RateLimit-Reset rather than GitHub's X-RateLimit-Reset." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Shared adapter helpers and test helpers

`notGone` and `optional` move out of the GitHub adapter so every adapter uses them, together with two new helpers: `mentions` (does a comment @-mention me? GitLab and Forgejo report no mention events) and `parseUrl`. The tests get a reusable fake forge API (`test/fake-http.ts`; an unrouted path answers 599, not 404, because adapters treat some 404s as "absent", which would hide a wrongly built URL) and the contract checks every adapter must pass (`test/contract.ts`).

**Files:**
- Create: `src/adapters/util.ts`, `test/util.test.ts`, `test/fake-http.ts`, `test/contract.ts`
- Modify: `src/adapters/github.ts`, `test/github.test.ts`

- [ ] **Step 1: Write the failing test `test/util.test.ts`**

```ts
import { expect, test } from "bun:test";
import { mentions, notGone, optional, parseUrl } from "../src/adapters/util.ts";
import { GoneError, HttpError, RateLimitError } from "../src/core/http.ts";

test("mentions matches whole logins only", () => {
  expect(mentions("thanks @lapo!", "lapo")).toBe(true);
  expect(mentions("@Lapo please look", "lapo")).toBe(true);
  expect(mentions("cc @lapo, @other", "lapo")).toBe(true);
  expect(mentions("thanks @lapo.", "lapo")).toBe(true); // a dot ending the sentence
  expect(mentions("@lapo.luchini is someone else", "lapo")).toBe(false); // logins may contain dots
  expect(mentions("@lapo-l is someone else", "lapo")).toBe(false);
  expect(mentions("@lapoluchini", "lapo")).toBe(false);
  expect(mentions("mail me at x@lapo.org", "lapo")).toBe(false);
  expect(mentions("no mention", "lapo")).toBe(false);
  expect(mentions("@a.b+c", "a.b+c")).toBe(true); // regex characters in logins are literal
  expect(mentions("@axb+c", "a.b+c")).toBe(false);
});

test("notGone turns a 404 into an ordinary failure", async () => {
  const err = await notGone(Promise.reject(new GoneError(404, "u"))).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).not.toBeInstanceOf(GoneError);
  expect(await notGone(Promise.resolve(1))).toBe(1);
});

test("optional swallows 403/404 only", async () => {
  expect(await optional(Promise.reject(new HttpError(403, "u")))).toBeNull();
  expect(await optional(Promise.reject(new GoneError(404, "u")))).toBeNull();
  await expect(optional(Promise.reject(new RateLimitError(403, "u", null)))).rejects.toBeInstanceOf(RateLimitError);
  await expect(optional(Promise.reject(new HttpError(500, "u")))).rejects.toBeInstanceOf(HttpError);
});

test("parseUrl", () => {
  expect(parseUrl("https://a/b")?.host).toBe("a");
  expect(parseUrl("nope")).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/util.test.ts`
Expected: FAIL with `Cannot find module '../src/adapters/util.ts'`.

- [ ] **Step 3: Implement `src/adapters/util.ts`**

```ts
// Helpers shared by the forge adapters.
import { GoneError, HttpError, RateLimitError } from "../core/http.ts";

/**
 * Only a 404/410 on the item itself means it is gone; on a sub-request (timeline, commits,
 * CI…) it is an ordinary failure, so the item is retried instead of being marked gone.
 */
export async function notGone<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    if (err instanceof GoneError) throw new HttpError(err.status, err.url, err.message);
    throw err;
  }
}

/** null when the request is forbidden or not found; rate limits and other errors still throw. */
export async function optional<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (err) {
    if (err instanceof HttpError && !(err instanceof RateLimitError) && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

/**
 * True when `body` @-mentions `user` (case-insensitive, whole login only). Logins may
 * contain dots (GitLab, Forgejo), so "@lapo.luchini" is not "@lapo", but "@lapo." is.
 */
export function mentions(body: string, user: string): boolean {
  const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.@-])@${escaped}(?![\\w-]|\\.\\w)`, "i").test(body);
}

/** Parses a URL, or returns null when it is not one. */
export function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/util.test.ts`
Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Create the test helpers**

`test/fake-http.ts`:

```ts
// Fake forge API for adapter tests: maps "path?query" (without the API base) to a response;
// an unrouted path fails with status 599.
import type { HttpDeps } from "../src/core/http.ts";

/** A JSON body, a bare status code, or a full Response (for custom headers). */
export type Route = unknown;

export interface FakeApi {
  http: HttpDeps;
  /** Requested paths, in order (without the API base). */
  calls: string[];
  /** Request headers of each call, in the same order. */
  headers: Record<string, string>[];
}

export function fakeApi(base: string, routes: Record<string, Route>): FakeApi {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const http: HttpDeps = {
    fetchFn: async (url, init) => {
      if (!url.startsWith(base)) throw new Error(`request outside the API base: ${url}`);
      const path = url.slice(base.length);
      calls.push(path);
      headers.push({ ...(init?.headers as Record<string, string>) });
      const body = routes[path];
      // Not a 404: adapters treat some 404s as "absent", which would hide a wrongly built URL.
      // Tests route intentional 404s explicitly.
      if (body === undefined) return new Response(`no route for ${path}`, { status: 599 });
      if (body instanceof Response) return body.clone();
      if (typeof body === "number") return new Response("", { status: body });
      return Response.json(body);
    },
    sleep: async () => {},
    retries: 0,
    timeoutMs: 1000,
  };
  return { http, calls, headers };
}
```

`test/contract.ts`:

```ts
// Checks every adapter must pass, called from each adapter's test file with its own fake API.
import { expect } from "bun:test";
import type { Adapter, ItemRef } from "../src/core/model.ts";

const ROLES = ["me", "maintainer", "contributor", "bot", "unknown"];

/** Fetches `ref` twice and checks the invariants the poller relies on. */
export async function expectAdapterContract(adapter: Adapter, ref: ItemRef): Promise<void> {
  // Canonical URLs are fixed points, so items.yaml and the cache always agree on the key.
  expect(adapter.refFromUrl(ref.url)).toEqual(ref);
  const first = await adapter.fetch(ref);
  const second = await adapter.fetch(ref);
  expect(first.ref).toEqual(ref);
  const keys = first.events.map((e) => e.key);
  // Keys are unique within the item and stable across fetches: dedup depends on it.
  expect(new Set(keys).size).toBe(keys.length);
  expect(second.events.map((e) => e.key)).toEqual(keys);
  for (const e of first.events) {
    expect(Number.isNaN(e.at.getTime())).toBe(false);
    expect(e.at.getTime()).toBeGreaterThan(0);
    expect(ROLES).toContain(e.actorRole);
  }
}
```

- [ ] **Step 6: Apply the contract to the GitHub adapter**

In `test/github.test.ts`, replace:

```ts
import { GoneError, HttpError, RateLimitError, type HttpDeps } from "../src/core/http.ts";
```

with:

```ts
import { GoneError, HttpError, RateLimitError, type HttpDeps } from "../src/core/http.ts";
import { expectAdapterContract } from "./contract.ts";
```

and insert immediately before the line `test("mergeable_state maps to hasConflicts, with unknown as null", async () => {`:

```ts
test("adapter contract", async () => {
  await expectAdapterContract(fakeGitHub(prRoutes).adapter, { url: PR, instance: "github", kind: "pr" });
});

```

- [ ] **Step 7: Move the GitHub adapter onto the helpers**

Replace the whole of `src/adapters/github.ts` with the version below. It differs from the current file only in: importing `notGone`, `optional` and `parseUrl` from `./util.ts` (no more `GoneError` import), dropping its own `notGone` function and `optional` method, calling `optional(...)` instead of `this.optional(...)` in `ciState`, and using `parseUrl` in `refFromUrl`.

```ts
// GitHub (github.com, or GitHub Enterprise via its /api/v3 base URL).
import type { InstanceConfig } from "../core/config.ts";
import { defaultHttp, getAllPages, getJson, HttpError, RateLimitError, type HttpDeps } from "../core/http.ts";
import type { ActorRole, Adapter, CiState, ItemRef, ItemState, NormalizedEvent, Snapshot } from "../core/model.ts";
import { notGone, optional, parseUrl } from "./util.ts";

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
interface GhCommitPerson { name: string; email: string; date: string }
interface GhCommit {
  sha: string;
  author: GhUser | null; // GitHub account linked to the commit author email, if any
  committer: GhUser | null; // same, for the committer email
  commit: { message: string; author: GhCommitPerson | null; committer: GhCommitPerson | null };
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
  private readonly emails: Set<string>; // lowercase

  constructor(private readonly inst: InstanceConfig, private readonly http: HttpDeps = defaultHttp) {
    this.web = inst.url === "https://api.github.com" ? "https://github.com" : inst.url.replace(/\/api\/v3$/, "");
    this.me = inst.user.toLowerCase();
    this.emails = new Set(inst.emails.map((e) => e.toLowerCase()));
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

  /** Also accepts URLs copied from the browser: a PR tab (/files, /commits, /checks), a query, a #fragment. */
  refFromUrl(url: string): ItemRef | null {
    const u = parseUrl(url);
    if (!u) return null;
    // URL.origin lowercases the host, so "https://GitHub.com" matches too.
    if (u.origin !== new URL(this.web).origin) return null;
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)(?:\/(?:files|commits|checks))?\/?$/);
    if (!m) return null;
    return { url: `${this.web}/${m[1]}/${m[2]}/${m[3]}/${m[4]}`, instance: this.inst.id, kind: m[3] === "pull" ? "pr" : "issue" };
  }

  async discover(since: Date | null): Promise<ItemRef[]> {
    // First run: everything open that involves me. Later runs: anything updated since the cursor,
    // including closed/merged items, so state changes are seen.
    const when = since ? `updated:>=${since.toISOString().replace(/\.\d{3}Z$/, "Z")}` : "is:open";
    // `involves:` does not cover review requests or reviews, so those get their own searches.
    const refs = new Map<string, ItemRef>();
    for (const who of ["involves", "review-requested", "reviewed-by"]) {
      const q = encodeURIComponent(`${who}:${this.inst.user} ${when}`);
      const found = await this.all<{ html_url: string }>(`/search/issues?q=${q}&sort=updated&per_page=100`, (b) => b.items);
      for (const i of found) {
        const ref = this.refFromUrl(i.html_url);
        if (ref && !refs.has(ref.url)) refs.set(ref.url, ref);
      }
    }
    if (since) {
      for (const ref of await this.subscribed(since)) if (!refs.has(ref.url)) refs.set(ref.url, ref);
    }
    return [...refs.values()];
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
    const timeline = await notGone(this.all<GhTimelineEvent>(`${base}/issues/${num}/timeline?per_page=100`));
    const events = timeline.flatMap((e) => this.mapTimeline(e));
    let state: ItemState = issue.state === "open" ? "open" : "closed";
    let ciState: CiState | null = null;
    let hasConflicts: boolean | null = false;
    if (ref.kind === "pr") {
      const pr = await notGone(this.get<GhPull>(`${base}/pulls/${num}`));
      if (pr.merged) state = "merged";
      // "unknown" (or missing) while GitHub recomputes mergeability in the background.
      const ms = pr.mergeable_state;
      hasConflicts = ms === undefined || ms === "unknown" ? null : ms === "dirty";
      const commits = await notGone(this.all<GhCommit>(`${base}/pulls/${num}/commits?per_page=100`));
      for (const c of commits) events.push(this.mapCommit(c));
      ciState = await notGone(this.ciState(base, pr.head.sha));
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
    // c.author is null when the commit email is not linked to an account, so also check the
    // committer (I may have pushed someone else's patch) and my configured commit emails.
    const logins = [c.author?.login, c.committer?.login].map((l) => l?.toLowerCase());
    const emails = [c.commit.author?.email, c.commit.committer?.email].map((e) => e?.toLowerCase());
    const mine = logins.includes(this.me) || emails.some((e) => e !== undefined && this.emails.has(e));
    return {
      key: `commit:${c.sha}`,
      kind: "push",
      actor: c.author?.login ?? c.commit.author?.name ?? "unknown",
      actorRole: mine ? "me" : this.role(c.author),
      at: new Date(c.commit.committer?.date ?? c.commit.author?.date ?? 0),
      details: { sha: c.sha.slice(0, 12), message: c.commit.message.split("\n")[0] },
    };
  }

  /**
   * Combines check runs (GitHub Actions etc.) and legacy commit statuses into one state.
   * Best-effort: a source the token cannot read (403/404) counts as absent; null if neither is readable.
   */
  private async ciState(base: string, sha: string): Promise<CiState | null> {
    const runs = await optional(this.get<{ check_runs: { status: string; conclusion: string | null }[] }>(`${base}/commits/${sha}/check-runs?per_page=100`));
    const status = await optional(this.get<{ state: string; total_count: number }>(`${base}/commits/${sha}/status`));
    const states: CiState[] = (runs?.check_runs ?? []).map((r) =>
      r.status !== "completed" ? "pending" : FAILED_CONCLUSIONS.has(r.conclusion ?? "") ? "failure" : "success");
    if (status && status.total_count > 0) states.push(status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure");
    if (states.length === 0) return null;
    return states.includes("failure") ? "failure" : states.includes("pending") ? "pending" : "success";
  }
}
```

- [ ] **Step 8: Run all tests and the type checker**

Run: `bun test && bun run typecheck`
Expected: all tests pass (98), then no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/util.ts src/adapters/github.ts test/util.test.ts test/fake-http.ts test/contract.ts test/github.test.ts
git commit -m "Share adapter helpers and add adapter contract checks" -m "notGone/optional move out of the GitHub adapter for the new forges, plus mentions() for forges without mention events. Tests get a fake forge API and the invariants the poller relies on (canonical URLs, unique and stable event keys)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `maintainer_domains` for Bugzilla instances

Bugzilla exposes no project membership. Besides the bug's assignee, committers are recognized by email domain (e.g. `freebsd.org`), so their short "Committed, thanks!" is not dropped as a short non-maintainer comment.

**Files:**
- Modify: `src/core/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/config.test.ts`:

```ts

test("maintainer_domains: optional, lowercased, leading @ dropped", () => {
  const cfg = parseConfig("instances:\n  - {id: a, type: bugzilla, url: x, user: u, maintainer_domains: [FreeBSD.org, '@kde.org']}", {});
  expect(cfg.instances[0]?.maintainerDomains).toEqual(["freebsd.org", "kde.org"]);
  expect(parseConfig("instances:\n  - {id: a, type: bugzilla, url: x, user: u}", {}).instances[0]?.maintainerDomains).toBeUndefined();
  expect(() => parseConfig("instances:\n  - {id: a, type: bugzilla, url: x, user: u, maintainer_domains: x.org}", {}))
    .toThrow("config: instances[0]: 'maintainer_domains' must be a list of strings");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL: `maintainerDomains` is `undefined`, expected `["freebsd.org", "kde.org"]`.

- [ ] **Step 3: Implement**

In `src/core/config.ts`, replace:

```ts
  emails: string[];
  token?: string; // resolved from the env variable named by token_env
```

with:

```ts
  emails: string[];
  // Bugzilla only: email domains of the project's committers (e.g. freebsd.org), whose
  // comments count as a maintainer's. Lowercase; absent means none.
  maintainerDomains?: string[];
  token?: string; // resolved from the env variable named by token_env
```

replace the `emailList` function:

```ts
/** Validates an optional `emails` key from the YAML; undefined when it is absent. */
function emailList(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((e) => typeof e === "string" && e !== "")) {
    throw new Error(`${where}: 'emails' must be a list of strings`);
  }
  return value;
}
```

with:

```ts
/** Validates an optional list-of-strings key from the YAML; undefined when it is absent. */
function stringList(value: unknown, where: string, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((e) => typeof e === "string" && e !== "")) {
    throw new Error(`${where}: '${key}' must be a list of strings`);
  }
  return value;
}
```

replace:

```ts
  const defaultEmails = emailList(raw.emails, "config") ?? [];
```

with:

```ts
  const defaultEmails = stringList(raw.emails, "config", "emails") ?? [];
```

and replace:

```ts
      emails: emailList(r.emails, where) ?? defaultEmails,
    };
```

with:

```ts
      emails: stringList(r.emails, where, "emails") ?? defaultEmails,
    };
    const domains = stringList(r.maintainer_domains, where, "maintainer_domains");
    if (domains) inst.maintainerDomains = domains.map((d) => d.toLowerCase().replace(/^@/, ""));
```

- [ ] **Step 4: Run the test**

Run: `bun test test/config.test.ts`
Expected: `6 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts test/config.test.ts
git commit -m "Add maintainer_domains to recognize Bugzilla committers" -m "Bugzilla exposes no project membership; without this, a committer's short 'Committed, thanks!' would be dropped as a short non-maintainer comment." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Summaries and filter rules for Bugzilla-style events

Flag, attachment and assignment events get readable summaries (`flag +maintainer-approval+ by @x`, `attachment obsoleted by @x: v1 patch`, `assign → x@freebsd.org by @y`). The filter treats two kinds of bot activity as noise: a bot *requesting* a flag (FreeBSD's Bugzilla asks every ports PR's maintainer for feedback automatically) and a bot assigning someone (FreeBSD auto-assigns ports PRs). A flag grant or denial (`+`/`-`) stays signal even when a bot relays it, e.g. BMO's Phabricator bot.

**Files:**
- Modify: `src/core/summary.ts`, `src/core/filter.ts`
- Test: `test/summary.test.ts`, `test/filter.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `test/summary.test.ts`:

```ts

test("summaries of Bugzilla-style events", () => {
  expect(summarize({ kind: "flag", actor: "m", excerpt: null, details: { action: "added", flag: "maintainer-approval+" } }))
    .toBe("flag +maintainer-approval+ by @m");
  expect(summarize({ kind: "flag", actor: "m", excerpt: null, details: { action: "removed", flag: "review?" } }))
    .toBe("flag -review? by @m");
  expect(summarize({ kind: "attachment", actor: "m", excerpt: null, details: { action: "obsoleted", summary: "v1  patch" } }))
    .toBe("attachment obsoleted by @m: v1 patch");
  expect(summarize({ kind: "assign", actor: "m", excerpt: null, details: { to: "x@freebsd.org" } }))
    .toBe("assign → x@freebsd.org by @m");
  expect(summarize({ kind: "assign", actor: "m", excerpt: null, details: null })).toBe("assign by @m");
});
```

In `test/filter.test.ts`, replace:

```ts
  ["bugzilla flag", ev("flag", "maintainer"), "normal", true, "signal:flag"],
```

with:

```ts
  ["bugzilla flag", ev("flag", "maintainer"), "normal", true, "signal:flag"],
  ["flag request by a bot",
    { ...ev("flag", "bot", undefined, "bugzilla@freebsd.org"), details: { action: "added", flag: "maintainer-feedback?(x@y.org)" } },
    "important", false, "noise:bot"],
  ["bare flag request by a bot",
    { ...ev("flag", "bot", undefined, "phab-bot@bmo.tld"), details: { action: "added", flag: "review?" } }, "important", false, "noise:bot"],
  ["flag grant relayed by a bot",
    { ...ev("flag", "bot", undefined, "phab-bot@bmo.tld"), details: { action: "added", flag: "review+" } }, "normal", true, "signal:flag"],
  ["flag request by a person",
    { ...ev("flag", "contributor"), details: { action: "added", flag: "needinfo?(me@x.org)" } }, "normal", true, "signal:flag"],
  ["assignment by a bot", ev("assign", "bot", undefined, "bugzilla@freebsd.org"), "normal", false, "noise:bot"],
  ["assignment by a person", ev("assign", "maintainer"), "normal", true, "signal:assign"],
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/summary.test.ts test/filter.test.ts`
Expected: FAIL: the summary test receives `flag by @m`; the three bot cases receive `signal:flag` / `signal:assign` instead of `noise:bot`.

- [ ] **Step 3: Implement the summaries**

In `src/core/summary.ts`, replace:

```ts
    case "push":
      return `push${by}` + (d.message ? `: ${d.message}` : "");
```

with:

```ts
    case "push":
      return `push${by}` + (d.message ? `: ${d.message}` : "");
    case "flag":
      return `flag ${sign}${d.flag}${by}`;
    case "attachment":
      return `attachment ${d.action ?? "added"}${by}` + (d.summary ? `: ${oneLine(String(d.summary))}` : "");
    case "assign":
      return `assign${d.to ? ` → ${d.to}` : ""}${by}`;
```

- [ ] **Step 4: Implement the filter rules**

In `src/core/filter.ts`, replace:

```ts
    case "label":
    case "milestone":
      return ev.actorRole === "maintainer" && !bot ? signal(ev.kind) : noise(`${ev.kind}-by-non-maintainer`);
```

with:

```ts
    case "label":
    case "milestone":
      return ev.actorRole === "maintainer" && !bot ? signal(ev.kind) : noise(`${ev.kind}-by-non-maintainer`);
    case "assign":
      // Automation assigning on its own (e.g. FreeBSD's Bugzilla auto-assigning ports PRs) is not news.
      return bot ? noise("bot") : signal("assign");
    case "flag":
      // A bot *requesting* a flag (e.g. "maintainer-feedback?" on every new ports PR) is routine;
      // a granted or denied flag (+/-) is news even when a bot relays it.
      return bot && isFlagRequest(ev) ? noise("bot") : signal("flag");
```

and replace:

```ts
function classifyComment(ev: NormalizedEvent, bot: boolean, cfg: FilterConfig): Verdict {
```

with:

```ts
/** Bugzilla flag requests look like "review?" or "needinfo?(someone@example.org)". */
function isFlagRequest(ev: NormalizedEvent): boolean {
  return ev.details?.action === "added" && /\?(\(|$)/.test(String(ev.details?.flag ?? ""));
}

function classifyComment(ev: NormalizedEvent, bot: boolean, cfg: FilterConfig): Verdict {
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/summary.test.ts test/filter.test.ts`
Expected: `34 pass, 0 fail` (2 summary + 32 filter).

- [ ] **Step 6: Commit**

```bash
git add src/core/summary.ts src/core/filter.ts test/summary.test.ts test/filter.test.ts
git commit -m "Summarize flag, attachment and assign events; ignore routine bot requests" -m "FreeBSD's Bugzilla requests maintainer feedback and assigns every new ports PR automatically: that must not make the PR look updated. Flag grants relayed by bots still count." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: GitLab adapter

How GitLab data maps onto the model (`inst.url` is the API base, e.g. `https://invent.kde.org/api/v4`; the web UI is the same URL without `/api/v4`, possibly under a sub-path):
- **URLs:** `/<group/sub/project>/-/merge_requests/<iid>` (kind `pr`) and `/-/issues/<iid>` (kind `issue`). Newer GitLab links issues as `/-/work_items/<iid>`; both open the same page, so they are canonicalized to `/-/issues/`. Group-level work items (`/groups/…`, epics) are not items.
- **Discovery** (a token is required: every endpoint below refuses anonymous requests): `/merge_requests` by author, assignee and reviewer and `/issues` by author and assignee, with `scope=all` and `state=opened` on the first run, `updated_after=T` later; to-dos (mentions and direct addressing: all pending ones on the first run, the newest page of pending and done ones later); my "commented" contribution events (`/events`, from 90 days back on the first run, else 2 days before the cursor since `after` is a server-local date), resolved to project paths via `/projects/:id`; and on later runs the known items not already found, checked per project with `iids[]` + `updated_after` in batches of 50.
- **Item:** the MR/issue (title, state, labels, author, draft, `detailed_merge_status` + `has_conflicts` → conflicts, unknown while GitLab is still checking; `head_pipeline.status` → CI). Notes: comments, plus a `mention` when someone (not a bot) @-mentions me; system notes give pushes ("added N commits", with the pusher as actor, so my own pushes are recognized), approvals, "requested changes", review requests and assignments naming me. Resource state / label / milestone events give state changes, labels and milestones.
- **Roles:** project members with Developer access or more (`/projects/:p/members/all/:user_id`, cached) are maintainers; project/group access tokens (`project_123_bot_…`), users flagged `bot` and `-bot`/`[bot]` names are bots. Label and milestone changes by a human count as maintainer (only Reporter and up can make them).

**Files:**
- Create: `src/adapters/gitlab.ts`
- Test: `test/gitlab.test.ts`

- [ ] **Step 1: Write the failing test `test/gitlab.test.ts`**

```ts
// GitLab adapter against a fake API: responses are minimal, sanitized shapes of real GitLab payloads
// (invent.kde.org and gitlab.com; system-note texts as GitLab writes them).
import { expect, test } from "bun:test";
import { GitLabAdapter } from "../src/adapters/gitlab.ts";
import type { InstanceConfig } from "../src/core/config.ts";
import { GoneError, HttpError } from "../src/core/http.ts";
import type { ItemRef } from "../src/core/model.ts";
import { expectAdapterContract } from "./contract.ts";
import { fakeApi } from "./fake-http.ts";

const API = "https://gitlab.example.org/api/v4";
const WEB = "https://gitlab.example.org";
const inst: InstanceConfig = { id: "gl", type: "gitlab", url: API, user: "lapo", emails: [], token: "dummy" };
const NOW = new Date("2026-11-04T12:00:00.000Z");

function fakeGitLab(routes: Record<string, unknown>, extra: Partial<InstanceConfig> = {}) {
  const api = fakeApi(API, routes);
  return { ...api, adapter: new GitLabAdapter({ ...inst, ...extra }, api.http, () => NOW) };
}

const MR = `${WEB}/kde/apps/konsole/-/merge_requests/42`;
const MR_REF: ItemRef = { url: MR, instance: "gl", kind: "pr" };
const P = "/projects/kde%2Fapps%2Fkonsole";
const MRB = `${P}/merge_requests/42`;

const user = (id: number, username: string, bot = false) => ({ id, username, bot });
const LAPO = user(1, "Lapo");
const MAINT = user(2, "maint");
const RANDO = user(3, "rando");
const TOKEN_BOT = user(4, "project_318_bot_0123456789abcdef", true);

const mrRoutes: Record<string, unknown> = {
  [MRB]: {
    title: "Fix build on FreeBSD", state: "opened", draft: true, author: LAPO, labels: ["bug"],
    detailed_merge_status: "mergeable", has_conflicts: false, head_pipeline: { status: "failed" },
  },
  [`${MRB}/notes?sort=asc&per_page=100`]: [
    { id: 10, system: true, author: MAINT, created_at: "2026-11-01T09:00:00.000Z", body: "assigned to @lapo and @maint" },
    { id: 11, system: true, author: MAINT, created_at: "2026-11-01T09:01:00.000Z", body: "requested review from @Lapo" },
    { id: 12, system: false, author: MAINT, created_at: "2026-11-01T10:00:00.000Z", body: "Please rebase, @lapo" },
    { id: 13, system: false, author: RANDO, created_at: "2026-11-01T11:00:00.000Z", body: "+1" },
    { id: 14, system: false, author: LAPO, created_at: "2026-11-01T11:30:00.000Z", body: "Done, thanks @lapo-bot" },
    { id: 15, system: true, author: LAPO, created_at: "2026-11-01T11:31:00.000Z",
      body: "added 3 commits\n\n<ul><li>ebbe7a70...cd8963d7 - 2 commits from branch <code>master</code></li>" +
        "<li>c1fb19bf - Fix &quot;dark&quot; scrollbars &amp; more</li></ul>\n\n[Compare with previous version](/kde/apps/konsole/-/merge_requests/42/diffs?diff_id=1)" },
    { id: 16, system: true, author: MAINT, created_at: "2026-11-01T12:00:00.000Z", body: "approved this merge request" },
    { id: 17, system: true, author: RANDO, created_at: "2026-11-01T12:10:00.000Z", body: "requested changes" },
    { id: 18, system: true, author: MAINT, created_at: "2026-11-01T12:20:00.000Z", body: "changed the description" },
    { id: 19, system: true, author: MAINT, created_at: "2026-11-01T12:30:00.000Z", body: "mentioned in merge request !7353" },
    { id: 20, system: false, author: TOKEN_BOT, created_at: "2026-11-01T12:40:00.000Z", body: "Pipeline report for @lapo" },
  ],
  [`${MRB}/resource_state_events?per_page=100`]: [
    { id: 30, user: MAINT, created_at: "2026-11-01T13:00:00.000Z", state: "closed" },
    { id: 31, user: MAINT, created_at: "2026-11-01T13:05:00.000Z", state: "reopened" },
  ],
  [`${MRB}/resource_label_events?per_page=100`]: [
    { id: 40, user: RANDO, created_at: "2026-11-01T14:00:00.000Z", action: "add", label: { name: "ready" } },
    { id: 41, user: user(5, "gitlab-bot"), created_at: "2026-11-01T14:01:00.000Z", action: "remove", label: { name: "triage" } },
  ],
  [`${MRB}/resource_milestone_events?per_page=100`]: [
    { id: 50, user: MAINT, created_at: "2026-11-01T15:00:00.000Z", action: "add", milestone: { title: "6.9" } },
  ],
  [`${P}/members/all/2`]: { id: 2, username: "maint", access_level: 40 },
  [`${P}/members/all/3`]: 404, // not a member
};

test("refFromUrl accepts this instance's MR, issue and work item URLs, with nested groups", () => {
  const { adapter } = fakeGitLab({});
  expect(adapter.refFromUrl(MR)).toEqual(MR_REF);
  expect(adapter.refFromUrl(`${WEB}/foo/bar/-/issues/7`)).toEqual({ url: `${WEB}/foo/bar/-/issues/7`, instance: "gl", kind: "issue" });
  // Newer GitLab links issues as work items; both URLs open the same page, so they share one key.
  expect(adapter.refFromUrl(`${WEB}/foo/bar/-/work_items/7`)?.url).toBe(`${WEB}/foo/bar/-/issues/7`);
  expect(adapter.refFromUrl(`${WEB}/a/b/c/d/-/merge_requests/1`)?.url).toBe(`${WEB}/a/b/c/d/-/merge_requests/1`);
});

test("refFromUrl canonicalizes URLs copied from the browser", () => {
  const { adapter } = fakeGitLab({});
  for (const u of [
    `${MR}/`, `${MR}/diffs`, `${MR}/commits/`, `${MR}/pipelines`, `${MR}?tab=x`, `${MR}#note_123`,
    `${MR}/diffs#abc_1_2`, "https://GitLab.Example.org/kde/apps/konsole/-/merge_requests/42",
  ]) {
    expect(adapter.refFromUrl(u)?.url).toBe(MR);
  }
});

test("refFromUrl rejects other hosts, other paths and non-URLs", () => {
  const { adapter } = fakeGitLab({});
  for (const u of [
    "https://gitlab.com/foo/bar/-/merge_requests/1", "https://gitlab.example.org.evil.example/foo/bar/-/issues/1",
    `${WEB}/foo/bar`, `${WEB}/foo/bar/-/merge_requests`, `${WEB}/foo/bar/-/merge_requests/1/other`,
    `${WEB}/foo/bar/-/epics/1`, `${WEB}/bar/-/issues/1`, `${WEB}/foo/-/bar/-/issues/1`,
    `${WEB}/groups/foo/-/work_items/7`, // a group-level work item (epic), not a project's
    "https://github.com/foo/bar/pull/1", "not a url",
  ]) {
    expect(adapter.refFromUrl(u)).toBeNull();
  }
});

test("refFromUrl on a sub-path install requires the prefix", () => {
  const { adapter } = fakeGitLab({}, { url: "https://example.org/gitlab/api/v4" });
  expect(adapter.refFromUrl("https://example.org/gitlab/foo/bar/-/issues/3?x")?.url).toBe("https://example.org/gitlab/foo/bar/-/issues/3");
  expect(adapter.refFromUrl("https://example.org/foo/bar/-/issues/3")).toBeNull();
  expect(adapter.refFromUrl("https://example.org/gitlabx/foo/bar/-/issues/3")).toBeNull();
});

test("fetch normalizes an MR: comments, system notes, resource events, roles", async () => {
  const { adapter, calls } = fakeGitLab(mrRoutes);
  const snap = await adapter.fetch(MR_REF);
  expect(snap).toMatchObject({
    ref: MR_REF, repo: "kde/apps/konsole", title: "Fix build on FreeBSD", state: "open", stateDetail: "draft",
    ciState: "failure", hasConflicts: false, authoredByMe: true, labels: ["bug"],
  });
  const byKey = Object.fromEntries(snap.events.map((e) => [e.key, e]));
  expect(Object.keys(byKey).sort()).toEqual([
    "a:10", "c:12", "c:13", "c:14", "c:20", "l:40", "l:41", "m:12", "ms:50", "push:15", "r:16", "r:17", "rr:11", "s:30", "s:31",
  ]);
  expect(byKey["c:12"]).toMatchObject({ kind: "comment", actor: "maint", actorRole: "maintainer", body: "Please rebase, @lapo" });
  expect(byKey["c:12"]?.at.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  expect(byKey["m:12"]).toMatchObject({ kind: "mention", actor: "maint", actorRole: "maintainer" });
  expect(byKey["c:13"]?.actorRole).toBe("contributor");
  expect(byKey["c:14"]?.actorRole).toBe("me"); // "@lapo-bot" is not me, and my own notes never mention me
  expect(byKey["c:20"]?.actorRole).toBe("bot"); // project access token: its mention of me is not a person's
  expect(byKey["a:10"]).toMatchObject({ kind: "assign", actor: "maint" });
  expect(byKey["rr:11"]).toMatchObject({ kind: "review_request", actor: "maint" });
  expect(byKey["push:15"]).toMatchObject({ kind: "push", actor: "Lapo", actorRole: "me",
    details: { commits: 3, sha: "c1fb19bf", message: 'Fix "dark" scrollbars & more' } });
  expect(byKey["r:16"]).toMatchObject({ kind: "review", actorRole: "maintainer", details: { state: "approved" } });
  expect(byKey["r:17"]).toMatchObject({ kind: "review", actorRole: "contributor", details: { state: "changes_requested" } });
  expect(byKey["s:30"]).toMatchObject({ kind: "state", details: { to: "closed" } });
  expect(byKey["s:31"]).toMatchObject({ kind: "state", details: { to: "reopened" } });
  // Only Reporter+ can label: a non-member human doing it was a maintainer when it happened; bots stay bots.
  expect(byKey["l:40"]).toMatchObject({ kind: "label", actorRole: "maintainer", details: { action: "added", label: "ready" } });
  expect(byKey["l:41"]).toMatchObject({ actorRole: "bot", details: { action: "removed", label: "triage" } });
  expect(byKey["ms:50"]).toMatchObject({ kind: "milestone", actorRole: "maintainer", details: { action: "added", milestone: "6.9" } });
  // One member lookup per distinct human other than me, even though maint and rando act several times.
  expect(calls.filter((c) => c.includes("/members/"))).toEqual([`${P}/members/all/2`, `${P}/members/all/3`]);
});

test("member lookups are cached across fetches of the same project", async () => {
  const { adapter, calls } = fakeGitLab(mrRoutes);
  await adapter.fetch(MR_REF);
  await adapter.fetch(MR_REF);
  expect(calls.filter((c) => c.includes("/members/"))).toHaveLength(2);
});

test("a Reporter is not a maintainer", async () => {
  const { adapter } = fakeGitLab({ ...mrRoutes, [`${P}/members/all/2`]: { id: 2, username: "maint", access_level: 20 } });
  const snap = await adapter.fetch(MR_REF);
  expect(snap.events.find((e) => e.key === "c:12")?.actorRole).toBe("contributor");
});

test("assignment and review-request notes count only when they name me", async () => {
  const note = (id: number, body: string) => ({ id, system: true, author: MAINT, created_at: "2026-11-01T09:00:00.000Z", body });
  const { adapter } = fakeGitLab({
    ...mrRoutes,
    [`${MRB}/notes?sort=asc&per_page=100`]: [
      note(1, "assigned to @maint"),
      note(2, "assigned to @maint and unassigned @lapo"),
      note(3, "reassigned to @lapo"),
      note(4, "unassigned @lapo"),
      note(5, "requested review from @maint and removed review request for @lapo"),
      note(6, "requested review from @maint and @lapo"),
      note(7, "removed review request for @lapo"),
      note(8, "requested review from @lapo.luchini2"),
    ],
  });
  const keys = (await adapter.fetch(MR_REF)).events.filter((e) => e.key.startsWith("a:") || e.key.startsWith("rr:")).map((e) => e.key);
  expect(keys).toEqual(["a:3", "rr:6"]);
});

test("a push of only target-branch commits has no message", async () => {
  const { adapter } = fakeGitLab({
    ...mrRoutes,
    [`${MRB}/notes?sort=asc&per_page=100`]: [{ id: 1, system: true, author: MAINT, created_at: "2026-11-01T09:00:00.000Z",
      body: "added 7 commits\n\n<ul><li>a0000d8b...965334ce - 7 commits from branch <code>main</code></li></ul>" }],
  });
  const push = (await adapter.fetch(MR_REF)).events[0];
  expect(push).toMatchObject({ key: "push:1", kind: "push", actor: "maint", actorRole: "maintainer", details: { commits: 7 } });
  expect(push?.details?.message).toBeUndefined();
});

test("head pipeline status maps to CI state", async () => {
  const cases: [unknown, string | null][] = [
    [{ status: "success" }, "success"], [{ status: "failed" }, "failure"], [{ status: "canceled" }, "failure"],
    [{ status: "running" }, "pending"], [{ status: "manual" }, "pending"], [{ status: "waiting_for_resource" }, "pending"],
    [{ status: "skipped" }, null], [null, null], [undefined, null],
  ];
  for (const [pipeline, expected] of cases) {
    const { adapter } = fakeGitLab({ ...mrRoutes, [MRB]: { ...(mrRoutes[MRB] as object), head_pipeline: pipeline } });
    expect((await adapter.fetch(MR_REF)).ciState).toBe(expected as never);
  }
});

test("conflicts are unknown while GitLab is still checking mergeability", async () => {
  const cases: [string | undefined, boolean, boolean | null][] = [
    ["conflict", true, true], ["mergeable", false, false], ["need_rebase", false, false], ["not_open", false, false],
    ["checking", true, null], ["unchecked", false, null], ["preparing", false, null], ["approvals_syncing", false, null],
    [undefined, false, null],
  ];
  for (const [status, conflicts, expected] of cases) {
    const { adapter } = fakeGitLab({
      ...mrRoutes, [MRB]: { ...(mrRoutes[MRB] as object), detailed_merge_status: status, has_conflicts: conflicts },
    });
    expect((await adapter.fetch(MR_REF)).hasConflicts).toBe(expected);
  }
});

test("merged and locked MR states", async () => {
  for (const [glState, state, detail] of [["merged", "merged", undefined], ["locked", "open", "locked"], ["closed", "closed", undefined]]) {
    const { adapter } = fakeGitLab({ ...mrRoutes, [MRB]: { ...(mrRoutes[MRB] as object), state: glState } });
    expect(await adapter.fetch(MR_REF)).toMatchObject({ state, stateDetail: detail });
  }
});

test("fetch normalizes an issue", async () => {
  const I = `${P}/issues/7`;
  const { adapter } = fakeGitLab({
    [I]: { title: "Crash on start", state: "closed", author: RANDO, labels: ["crash"] },
    [`${I}/notes?sort=asc&per_page=100`]: [
      { id: 1, system: false, author: LAPO, created_at: "2026-11-01T09:00:00.000Z", body: "Backtrace attached" },
      { id: 2, system: true, author: MAINT, created_at: "2026-11-01T10:00:00.000Z", body: "closed" },
    ],
    [`${I}/resource_state_events?per_page=100`]: [{ id: 3, user: MAINT, created_at: "2026-11-01T10:00:00.000Z", state: "closed" }],
    [`${I}/resource_label_events?per_page=100`]: [],
    [`${I}/resource_milestone_events?per_page=100`]: [],
    [`${P}/members/all/2`]: { access_level: 50 },
  });
  const ref: ItemRef = { url: `${WEB}/kde/apps/konsole/-/issues/7`, instance: "gl", kind: "issue" };
  const snap = await adapter.fetch(ref);
  expect(snap).toMatchObject({
    repo: "kde/apps/konsole", title: "Crash on start", state: "closed", stateDetail: undefined,
    ciState: null, hasConflicts: false, authoredByMe: false, labels: ["crash"],
  });
  expect(snap.events.map((e) => [e.key, e.kind, e.actorRole])).toEqual([
    ["c:1", "comment", "me"], ["s:3", "state", "maintainer"],
  ]);
});

test("only a 404 on the item itself means gone; a 404 on a sub-request is a plain error", async () => {
  expect(await fakeGitLab({ [MRB]: 404 }).adapter.fetch(MR_REF).catch((e) => e)).toBeInstanceOf(GoneError);
  for (const sub of ["notes?sort=asc&per_page=100", "resource_state_events?per_page=100",
    "resource_label_events?per_page=100", "resource_milestone_events?per_page=100"]) {
    const err = await fakeGitLab({ ...mrRoutes, [`${MRB}/${sub}`]: 404 }).adapter.fetch(MR_REF).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(GoneError);
    expect(err.status).toBe(404);
  }
});

test("sends the token as PRIVATE-TOKEN, and nothing without one", async () => {
  const { adapter, headers } = fakeGitLab(mrRoutes);
  await adapter.fetch(MR_REF);
  expect(headers[0]).toEqual({ "user-agent": "watcher", "private-token": "dummy" });
  const anon = fakeGitLab(mrRoutes, { token: undefined });
  await anon.adapter.fetch(MR_REF);
  expect(anon.headers[0]).toEqual({ "user-agent": "watcher" });
});

/** The role-filter searches discover() issues, in order, for one `when` clause. */
const searches = (when: string) => [
  `/merge_requests?scope=all&author_username=lapo&${when}&per_page=100`,
  `/merge_requests?scope=all&assignee_username=lapo&${when}&per_page=100`,
  `/merge_requests?scope=all&reviewer_username=lapo&${when}&per_page=100`,
  `/issues?scope=all&author_username=lapo&${when}&per_page=100`,
  `/issues?scope=all&assignee_username=lapo&${when}&per_page=100`,
];

test("discover: first run finds open items by role, pending to-dos and items I commented on", async () => {
  const [mrAuthor, mrAssignee, mrReviewer, issueAuthor, issueAssignee] = searches("state=opened");
  const { adapter, calls } = fakeGitLab({
    [mrAuthor!]: [{ web_url: MR }],
    [mrAssignee!]: [{ web_url: MR }],
    [mrReviewer!]: [{ web_url: `${WEB}/r/q/-/merge_requests/5` }],
    [issueAuthor!]: [{ web_url: `${WEB}/x/y/-/work_items/1` }],
    [issueAssignee!]: [],
    "/todos?state=pending&per_page=100": [
      { target_url: `${WEB}/t/u/-/issues/2#note_9`, created_at: "2020-01-01T00:00:00.000Z" }, // first run: any age
      { target_url: `${WEB}/t/u/-/commit/abc123`, created_at: "2026-11-01T00:00:00.000Z" },
      { target_url: null, created_at: "2026-11-01T00:00:00.000Z" },
    ],
    // 90 days before NOW, as a date.
    "/events?action=commented&after=2026-08-06&per_page=100": [
      { project_id: 318, note: { noteable_type: "MergeRequest", noteable_iid: 1352 } },
      { project_id: 318, note: { noteable_type: "Issue", noteable_iid: 1 } },
      { project_id: 318, note: { noteable_type: "Commit", noteable_iid: null } },
      { project_id: 999, note: { noteable_type: "Issue", noteable_iid: 4 } }, // project since deleted
    ],
    "/projects/318": { id: 318, path_with_namespace: "utilities/konsole" },
    "/projects/999": 404,
  });
  const refs = await adapter.discover(null, []);
  expect(refs.map((r) => [r.url, r.kind])).toEqual([
    [MR, "pr"],
    [`${WEB}/r/q/-/merge_requests/5`, "pr"],
    [`${WEB}/x/y/-/issues/1`, "issue"],
    [`${WEB}/t/u/-/issues/2`, "issue"],
    [`${WEB}/utilities/konsole/-/merge_requests/1352`, "pr"],
    [`${WEB}/utilities/konsole/-/issues/1`, "issue"],
  ]);
  expect(calls.filter((c) => c.startsWith("/projects/"))).toEqual(["/projects/318", "/projects/999"]); // cached per id
});

test("discover: incremental run uses the cursor, recent to-dos of both states, and checks known items", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const after = `updated_after=${encodeURIComponent("2026-11-04T10:00:00.000Z")}`;
  const routes: Record<string, unknown> = Object.fromEntries(searches(after).map((s) => [s, []]));
  routes[searches(after)[0]!] = [{ web_url: MR }];
  routes["/todos?state=pending&per_page=100"] = [
    { target_url: `${WEB}/t/u/-/merge_requests/3`, created_at: "2026-11-04T10:30:00.000Z" },
    { target_url: `${WEB}/t/u/-/merge_requests/4`, created_at: "2026-11-01T10:30:00.000Z" }, // older than the cursor
  ];
  routes["/todos?state=done&per_page=100"] = [
    { target_url: `${WEB}/t/u/-/issues/5`, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-11-04T11:00:00.000Z" },
  ];
  routes["/events?action=commented&after=2026-11-02&per_page=100"] = []; // two days before the cursor
  // 55 known MRs in one project: two batches. MR 42 is known too, but the author search
  // already found it, so it is not checked again. One known issue in a project that is gone now.
  const known: ItemRef[] = [MR_REF];
  for (let i = 101; i <= 155; i++) known.push({ url: `${WEB}/kde/apps/konsole/-/merge_requests/${i}`, instance: "gl", kind: "pr" });
  known.push({ url: `${WEB}/gone/proj/-/issues/1`, instance: "gl", kind: "issue" });
  // Cached before the instance's url was edited: skipped, not fatal.
  known.push({ url: "https://old.example.org/x/y/-/issues/2", instance: "gl", kind: "issue" });
  const iids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `iids[]=${from + i}`).join("&");
  routes[`${P}/merge_requests?${iids(101, 150)}&${after}&per_page=100`] = [{ web_url: `${WEB}/kde/apps/konsole/-/merge_requests/107` }];
  routes[`${P}/merge_requests?${iids(151, 155)}&${after}&per_page=100`] = [];
  routes[`/projects/gone%2Fproj/issues?iids[]=1&${after}&per_page=100`] = 404; // the project is gone
  const { adapter, calls } = fakeGitLab(routes);

  const refs = await adapter.discover(since, known);
  expect(refs.map((r) => r.url)).toEqual([
    MR, `${WEB}/t/u/-/merge_requests/3`, `${WEB}/t/u/-/issues/5`, `${WEB}/kde/apps/konsole/-/merge_requests/107`,
  ]);
  expect(calls.some((c) => c.includes("iids[]=42&"))).toBe(false);
  expect(calls).toContain(`/projects/gone%2Fproj/issues?iids[]=1&${after}&per_page=100`);
});

test("adapter contract", async () => {
  await expectAdapterContract(fakeGitLab(mrRoutes).adapter, MR_REF);
});

test("discover: refuses to run without a token", async () => {
  const { adapter, calls } = fakeGitLab({}, { token: undefined });
  await expect(adapter.discover(null, [])).rejects.toThrow("GitLab discovery needs a token");
  expect(calls).toEqual([]);
});

test("discover: known items are not checked on the first run", async () => {
  const { adapter, calls } = fakeGitLab({
    ...Object.fromEntries(searches("state=opened").map((s) => [s, []])),
    "/todos?state=pending&per_page=100": [],
    "/events?action=commented&after=2026-08-06&per_page=100": [],
  });
  expect(await adapter.discover(null, [MR_REF])).toEqual([]);
  expect(calls.some((c) => c.includes("iids"))).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/gitlab.test.ts`
Expected: FAIL with `Cannot find module '../src/adapters/gitlab.ts'`.

- [ ] **Step 3: Implement `src/adapters/gitlab.ts`**

```ts
// GitLab (gitlab.com or self-hosted, e.g. invent.kde.org), via its /api/v4 base URL.
import type { InstanceConfig } from "../core/config.ts";
import { defaultHttp, getAllPages, getJson, type HttpDeps } from "../core/http.ts";
import type { ActorRole, Adapter, CiState, ItemKind, ItemRef, ItemState, NormalizedEvent, Snapshot } from "../core/model.ts";
import { mentions, notGone, optional, parseUrl } from "./util.ts";

// Only the fields we use from GitLab's REST responses.
interface GlUser { id: number; username: string; bot?: boolean }
interface GlItem {
  title: string;
  state: "opened" | "closed" | "merged" | "locked";
  author: GlUser | null;
  labels: string[];
  draft?: boolean; // merge requests only
  detailed_merge_status?: string; // merge requests only
  has_conflicts?: boolean; // merge requests only
  head_pipeline?: { status: string } | null; // merge requests only; null without pipelines or access
}
interface GlNote { id: number; body: string; system: boolean; author: GlUser | null; created_at: string }
interface GlResourceEvent {
  id: number;
  user: GlUser | null;
  created_at: string;
  state?: string; // resource_state_events: closed | reopened | merged
  action?: "add" | "remove"; // label and milestone events
  label?: { name: string } | null; // null once the label is deleted
  milestone?: { title: string } | null;
}
interface GlTodo { target_url?: string | null; created_at: string; updated_at?: string }
interface GlEvent { project_id: number; note?: { noteable_type?: string; noteable_iid?: number | null } | null }

/** Developer (30) and up can push, merge and triage; Reporter (20) and Guest (10) cannot. */
const MAINTAINER_ACCESS = 30;
/** Project/group access tokens act as users named like "project_123_bot_<hash>". */
const TOKEN_BOT = /^(project|group)_\d+_bot/;
/** While these are reported, GitLab is still (re)computing mergeability, so has_conflicts may be stale. */
const MERGE_STATUS_UNKNOWN = new Set(["unchecked", "checking", "preparing", "approvals_syncing"]);
const CI_FAILED = new Set(["failed", "canceled", "canceling"]);
const CI_PENDING = new Set(["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled", "manual"]);
/** How far back the first run looks for items I commented on (the events API has no "open only" filter). */
const FIRST_RUN_DAYS = 90;
/** iids per known-items request, to keep URLs short. */
const IID_CHUNK = 50;
const DAY_MS = 86_400_000;

/** The API path segment of each item kind. */
const API_KIND: Record<string, string> = { pr: "merge_requests", issue: "issues" };

export class GitLabAdapter implements Adapter {
  private readonly web: string; // web base URL, no trailing slash
  private readonly webPrefix: string; // its path part: "" or e.g. "/gitlab" for a sub-path install
  private readonly me: string; // lowercase
  private readonly projectPaths = new Map<number, string | null>(); // project id -> path, null if unreadable
  private readonly maintainers = new Map<string, boolean>(); // "<project path>#<user id>" -> Developer+

  constructor(
    private readonly inst: InstanceConfig,
    private readonly http: HttpDeps = defaultHttp,
    private readonly now: () => Date = () => new Date(), // injectable for tests
  ) {
    this.web = inst.url.replace(/\/api\/v4$/, "");
    this.webPrefix = new URL(this.web).pathname.replace(/\/$/, "");
    this.me = inst.user.toLowerCase();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "user-agent": "watcher" };
    if (this.inst.token) h["private-token"] = this.inst.token; // a read_api token is enough
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    return (await getJson<T>(this.inst.url + path, this.headers(), this.http)).data;
  }

  private all<T>(path: string): Promise<T[]> {
    return getAllPages<T>(this.inst.url + path, this.headers(), this.http);
  }

  /**
   * Also accepts URLs copied from the browser: an MR tab (/diffs, /commits, /pipelines), a query,
   * a #fragment, and the /-/work_items/ URLs newer GitLab shows for issues.
   */
  refFromUrl(url: string): ItemRef | null {
    const u = parseUrl(url);
    if (!u) return null;
    if (u.origin !== new URL(this.web).origin || !u.pathname.startsWith(this.webPrefix + "/")) return null;
    const m = u.pathname.slice(this.webPrefix.length)
      .match(/^\/((?:[^/]+\/)+?[^/]+)\/-\/(merge_requests|issues|work_items)\/(\d+)(?:\/(?:diffs|commits|pipelines))?\/?$/);
    // Project paths are "group/sub/project": at least two segments, never a "-" segment.
    // "/groups/<group>/-/work_items/N" is a group-level item (an epic), not a project's.
    if (!m || m[1]!.split("/").includes("-") || m[1]!.startsWith("groups/")) return null;
    const kind: ItemKind = m[2] === "merge_requests" ? "pr" : "issue";
    return this.ref(m[1]!, kind, Number(m[3]));
  }

  /** Canonical ref. Issues use /-/issues/ even where GitLab links /-/work_items/: both URLs work. */
  private ref(project: string, kind: ItemKind, iid: number): ItemRef {
    return { url: `${this.web}/${project}/-/${API_KIND[kind]}/${iid}`, instance: this.inst.id, kind };
  }

  /** Project path and iid of a canonical ref. */
  private parts(ref: ItemRef): { project: string; iid: string } {
    const m = ref.url.slice(this.web.length).match(/^\/(.+)\/-\/[a-z_]+\/(\d+)$/);
    if (!m) throw new Error(`not a GitLab item URL: ${ref.url}`);
    return { project: m[1]!, iid: m[2]! };
  }

  async discover(since: Date | null, known: ItemRef[]): Promise<ItemRef[]> {
    // /merge_requests, /issues, /todos and /events all answer 401 to anonymous requests.
    if (!this.inst.token) throw new Error("GitLab discovery needs a token: set token_env for this instance");
    const refs = new Map<string, ItemRef>();
    const add = (ref: ItemRef | null) => {
      if (ref && !refs.has(ref.url)) refs.set(ref.url, ref);
    };
    // First run: everything open that involves me. Later runs: anything updated since the cursor,
    // including closed/merged items, so state changes are seen.
    const when = since ? `updated_after=${encodeURIComponent(since.toISOString())}` : "state=opened";
    // GitLab has no "involves" filter: one query per role, deduplicated by URL.
    const searches = [
      ...["author_username", "assignee_username", "reviewer_username"].map((f) => `/merge_requests?scope=all&${f}`),
      ...["author_username", "assignee_username"].map((f) => `/issues?scope=all&${f}`),
    ];
    for (const s of searches) {
      for (const item of await this.all<{ web_url: string }>(`${s}=${encodeURIComponent(this.inst.user)}&${when}&per_page=100`)) {
        add(this.refFromUrl(item.web_url));
      }
    }
    for (const ref of await this.fromTodos(since)) add(ref);
    for (const ref of await this.commentedOn(since)) add(ref);
    // Known items the queries above already found need no extra check.
    if (since) for (const ref of await this.updatedKnown(since, known.filter((r) => !refs.has(r.url)))) add(ref);
    return [...refs.values()];
  }

  /** To-dos cover mentions, direct addressing and review requests that the role filters miss. */
  private async fromTodos(since: Date | null): Promise<ItemRef[]> {
    let todos: GlTodo[];
    if (!since) {
      todos = await this.all<GlTodo>("/todos?state=pending&per_page=100");
    } else {
      // Newest first, so the first page of each state covers any normal polling interval. Done ones
      // count too: I may have marked a to-do done in the browser before this run saw it. An old
      // to-do re-triggered beyond the first page is missed here, but its item is already known
      // from the run that first saw the to-do, so updatedKnown() still finds it.
      todos = [];
      for (const state of ["pending", "done"]) {
        const page = await this.get<GlTodo[]>(`/todos?state=${state}&per_page=100`);
        todos.push(...page.filter((t) => new Date(t.updated_at ?? t.created_at) >= since));
      }
    }
    // A to-do can also point at a commit, an epic, a design…: refFromUrl skips those.
    return todos.flatMap((t) => (t.target_url ? this.refFromUrl(t.target_url) ?? [] : []));
  }

  /** Items I commented on, from my contribution events (the search filters cannot find them). */
  private async commentedOn(since: Date | null): Promise<ItemRef[]> {
    // `after` takes a date, is exclusive and is read in the server's time zone, so ask from two
    // days before the cursor: the overlap only re-reports items, which discovery deduplicates.
    const from = since ? new Date(since.getTime() - 2 * DAY_MS) : new Date(this.now().getTime() - FIRST_RUN_DAYS * DAY_MS);
    const events = await this.all<GlEvent>(`/events?action=commented&after=${from.toISOString().slice(0, 10)}&per_page=100`);
    const refs: ItemRef[] = [];
    for (const e of events) {
      const type = e.note?.noteable_type;
      const iid = e.note?.noteable_iid;
      const kind: ItemKind | null = type === "MergeRequest" ? "pr" : type === "Issue" || type === "WorkItem" ? "issue" : null;
      if (!kind || !iid) continue; // a comment on a commit or snippet
      const project = await this.projectPath(e.project_id);
      if (project) refs.push(this.ref(project, kind, iid));
    }
    return refs;
  }

  /** Project path by id, cached; null when the project is gone or no longer readable. */
  private async projectPath(id: number): Promise<string | null> {
    if (!this.projectPaths.has(id)) {
      const p = await optional(this.get<{ path_with_namespace: string }>(`/projects/${id}`));
      this.projectPaths.set(id, p?.path_with_namespace ?? null);
    }
    return this.projectPaths.get(id) ?? null;
  }

  /** Known items updated since the cursor, checked in batches per project (e.g. ones I was only mentioned in once). */
  private async updatedKnown(since: Date, known: ItemRef[]): Promise<ItemRef[]> {
    const groups = new Map<string, { project: string; kind: ItemKind; iids: string[] }>();
    for (const ref of known) {
      // A cached URL from before the instance's `url` was edited no longer parses: skip it
      // rather than fail discovery on every run.
      if (!this.refFromUrl(ref.url)) continue;
      const { project, iid } = this.parts(ref);
      const key = `${ref.kind} ${project}`;
      if (!groups.has(key)) groups.set(key, { project, kind: ref.kind, iids: [] });
      groups.get(key)!.iids.push(iid);
    }
    const refs: ItemRef[] = [];
    for (const { project, kind, iids } of groups.values()) {
      for (let i = 0; i < iids.length; i += IID_CHUNK) {
        const filter = iids.slice(i, i + IID_CHUNK).map((n) => `iids[]=${n}`).join("&");
        const path = `/projects/${encodeURIComponent(project)}/${API_KIND[kind]}?${filter}` +
          `&updated_after=${encodeURIComponent(since.toISOString())}&per_page=100`;
        // A deleted or now-private project must not fail discovery; fetch() will mark its items gone.
        const found = await optional(this.all<{ web_url: string }>(path));
        for (const item of found ?? []) {
          const ref = this.refFromUrl(item.web_url);
          if (ref) refs.push(ref);
        }
      }
    }
    return refs;
  }

  async fetch(ref: ItemRef): Promise<Snapshot> {
    const { project, iid } = this.parts(ref);
    const base = `/projects/${encodeURIComponent(project)}/${API_KIND[ref.kind]}/${iid}`;
    const item = await this.get<GlItem>(base); // a 404 here (GoneError) means the item is gone
    const notes = await notGone(this.all<GlNote>(`${base}/notes?sort=asc&per_page=100`));
    const states = await notGone(this.all<GlResourceEvent>(`${base}/resource_state_events?per_page=100`));
    const labels = await notGone(this.all<GlResourceEvent>(`${base}/resource_label_events?per_page=100`));
    const milestones = await notGone(this.all<GlResourceEvent>(`${base}/resource_milestone_events?per_page=100`));

    const people = [...notes.map((n) => n.author), ...[...states, ...labels, ...milestones].map((e) => e.user)];
    const roles = await this.roles(project, people);
    const role = (u: GlUser | null): ActorRole => (u ? roles.get(u.id) ?? "unknown" : "unknown");
    // Only Reporter and up can set labels and milestones, so a human doing it counts as a maintainer.
    const triager = (u: GlUser | null): ActorRole => {
      const r = role(u);
      return r === "contributor" || r === "unknown" ? "maintainer" : r;
    };
    const who = (u: GlUser | null, at: string) => ({ actor: u?.username ?? "", actorRole: role(u), at: new Date(at) });

    const events: NormalizedEvent[] = notes.flatMap((n) => this.mapNote(n, role(n.author)));
    for (const e of states) {
      if (e.state === "closed" || e.state === "reopened" || e.state === "merged") {
        events.push({ ...who(e.user, e.created_at), key: `s:${e.id}`, kind: "state", details: { to: e.state } });
      }
    }
    for (const e of labels) {
      events.push({ ...who(e.user, e.created_at), actorRole: triager(e.user), key: `l:${e.id}`, kind: "label",
        details: { action: e.action === "add" ? "added" : "removed", label: e.label?.name } });
    }
    for (const e of milestones) {
      events.push({ ...who(e.user, e.created_at), actorRole: triager(e.user), key: `ms:${e.id}`, kind: "milestone",
        details: { action: e.action === "add" ? "added" : "removed", milestone: e.milestone?.title } });
    }

    const state: ItemState = item.state === "merged" ? "merged" : item.state === "closed" ? "closed" : "open";
    let stateDetail: string | undefined;
    let ciState: CiState | null = null;
    let hasConflicts: boolean | null = false;
    if (ref.kind === "pr") {
      // "locked" is the short transitional state while GitLab performs a merge.
      if (item.state === "locked") stateDetail = "locked";
      else if (state === "open" && item.draft) stateDetail = "draft";
      hasConflicts = MERGE_STATUS_UNKNOWN.has(item.detailed_merge_status ?? "unchecked") ? null : item.has_conflicts === true;
      ciState = pipelineState(item.head_pipeline?.status);
    }
    return {
      ref,
      repo: project,
      title: item.title,
      state,
      stateDetail,
      ciState,
      hasConflicts,
      authoredByMe: item.author?.username.toLowerCase() === this.me,
      labels: item.labels,
      events,
    };
  }

  /** Notes: comments, plus the system notes that carry pushes, reviews, review requests and assignments. */
  private mapNote(n: GlNote, actorRole: ActorRole): NormalizedEvent[] {
    const base = { actor: n.author?.username ?? "", actorRole, at: new Date(n.created_at) };
    if (!n.system) {
      const out: NormalizedEvent[] = [{ ...base, key: `c:${n.id}`, kind: "comment", body: n.body }];
      // A bot pinging me (pipeline reports, triage reminders) is not someone asking for me.
      if (actorRole !== "me" && actorRole !== "bot" && mentions(n.body, this.inst.user)) {
        out.push({ ...base, key: `m:${n.id}`, kind: "mention" });
      }
      return out;
    }
    const body = n.body;
    // "added 2 commits\n\n<ul><li>0e7a0ff1 - Title</li>…</ul>"; a merge of the target branch is
    // listed as "<li>abc...def - 3 commits from branch <code>main</code></li>" and has no title.
    const added = body.match(/^added (\d+) commits?\b/);
    if (added) {
      const commit = body.match(/<li>([0-9a-f]{7,40}) - (.*?)<\/li>/);
      return [{ ...base, key: `push:${n.id}`, kind: "push",
        details: { commits: Number(added[1]), sha: commit?.[1], message: commit ? unescapeHtml(commit[2]!) : undefined } }];
    }
    if (/^approved this merge request\b/.test(body)) {
      return [{ ...base, key: `r:${n.id}`, kind: "review", details: { state: "approved" } }];
    }
    if (/^requested changes\b/.test(body)) {
      return [{ ...base, key: `r:${n.id}`, kind: "review", details: { state: "changes_requested" } }];
    }
    // "requested review from @a and @b and removed review request for @c": only the first part adds reviewers.
    const review = body.match(/^requested review from (.*?)(?: and removed review request for .*)?$/s);
    if (review && this.namesMe(review[1]!)) return [{ ...base, key: `rr:${n.id}`, kind: "review_request" }];
    // "assigned to @a and @b", "assigned to @a and unassigned @c"; older GitLab says "reassigned to".
    const assigned = body.match(/^(?:re)?assigned to (.*?)(?: and unassigned .*)?$/s);
    if (assigned && this.namesMe(assigned[1]!)) return [{ ...base, key: `a:${n.id}`, kind: "assign" }];
    return []; // description/title edits, "mentioned in …", merge trains, status changes, …
  }

  /**
   * True when a system note's user list ("@a, @b and @c") contains me. Matches whole usernames,
   * which may contain dots: "@lapo.luchini" is not "@lapo".
   */
  private namesMe(list: string): boolean {
    return [...list.matchAll(/@([\w.-]+)/g)].some((m) => m[1]!.toLowerCase() === this.me);
  }

  /**
   * Role of each distinct user. GitLab events carry no author association, so maintainers are
   * looked up as project members with Developer access or more (cached for this adapter's life).
   */
  private async roles(project: string, users: (GlUser | null)[]): Promise<Map<number, ActorRole>> {
    const roles = new Map<number, ActorRole>();
    for (const u of users) {
      if (!u || roles.has(u.id)) continue;
      const name = u.username.toLowerCase();
      if (name === this.me) roles.set(u.id, "me");
      else if (u.bot || TOKEN_BOT.test(name) || name.endsWith("-bot") || name.endsWith("[bot]")) roles.set(u.id, "bot");
      else roles.set(u.id, (await this.isMaintainer(project, u.id)) ? "maintainer" : "contributor");
    }
    return roles;
  }

  private async isMaintainer(project: string, userId: number): Promise<boolean> {
    const key = `${project}#${userId}`;
    if (!this.maintainers.has(key)) {
      // members/all includes members inherited from parent groups; 404 means not a member.
      const m = await optional(this.get<{ access_level: number }>(`/projects/${encodeURIComponent(project)}/members/all/${userId}`));
      this.maintainers.set(key, (m?.access_level ?? 0) >= MAINTAINER_ACCESS);
    }
    return this.maintainers.get(key)!;
  }
}

/** Head pipeline status to CI state; null without a pipeline, or when it was skipped. */
function pipelineState(status: string | undefined): CiState | null {
  if (status === "success") return "success";
  if (status && CI_FAILED.has(status)) return "failure";
  if (status && CI_PENDING.has(status)) return "pending";
  return null;
}

/** System notes are HTML: commit titles arrive with &amp; &lt; &gt; &quot; &#39; escaped. */
function unescapeHtml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);
}
```

- [ ] **Step 4: Run the test and the type checker**

Run: `bun test test/gitlab.test.ts && bun run typecheck`
Expected: `20 pass, 0 fail`, then no type errors.

- [ ] **Step 5: Commit**

```bash
grep -rn REDACTED src test   # must print nothing
git add src/adapters/gitlab.ts test/gitlab.test.ts
git commit -m "Add GitLab adapter" -m "GitLab has no 'involves' search: discovery combines the role filters, to-dos, my comment events and a re-check of known items. System notes provide pushes, approvals, review requests and assignments; project membership decides maintainers." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Forgejo adapter

How Forgejo (and Gitea) data maps onto the model (`inst.url` is the API base, e.g. `https://codeberg.org/api/v1`):
- **URLs:** `/<owner>/<repo>/pulls/<n>` (kind `pr`) and `/issues/<n>` (kind `issue`), with tabs (`/files`, `/commits`), queries and fragments stripped.
- **Discovery** (a token is required: without one, Forgejo silently ignores the "me" flags and returns everyone's items): `/repos/issues/search` with each of `created`, `assigned`, `mentioned`, `review_requested`, `reviewed`, plus `/notifications`, which covers items I commented on (Forgejo makes commenters watchers). On the first run only open items are kept. When the token cannot read notifications (401/403), later runs check the known items instead, with one `/repos/:o/:r/issues?state=all&since=T` listing per repository.
- **Item:** the issue (title, state, labels, author); the timeline, requested without paging parameters (Forgejo then returns all of it; with `page` it truncates without a Link header): comments (+ `mention`), close/reopen/merge, labels (`body` "1" = added), milestones, assignments and review requests naming me, pushes (`pull_push`; a force push's `commit_ids` are the old and new heads, so only plain pushes get a commit count). For PRs: `pulls/N` (merged; `mergeable` is false on a conflict but also while checking and for drafts, so drafts give unknown and other false values a conflict), reviews (approved / changes requested / commented; pending drafts and review-request placeholders skipped), the combined commit status (CI).
- **Roles:** maintainer = the repo owner, a user with write access (the repo's `/assignees` list, which needs a token; without it others are `unknown`), or the author of an official review. Bots by name only (Forgejo exposes no user type). Label and milestone changes by a human count as maintainer.

**Files:**
- Create: `src/adapters/forgejo.ts`
- Test: `test/forgejo.test.ts`

- [ ] **Step 1: Write the failing test `test/forgejo.test.ts`**

```ts
// Forgejo adapter against a fake API: responses are minimal, sanitized shapes of real Codeberg payloads.
import { expect, test } from "bun:test";
import { ForgejoAdapter } from "../src/adapters/forgejo.ts";
import type { InstanceConfig } from "../src/core/config.ts";
import { GoneError, HttpError, RateLimitError } from "../src/core/http.ts";
import { expectAdapterContract } from "./contract.ts";
import { fakeApi, type Route } from "./fake-http.ts";

const API = "https://codeberg.org/api/v1";
const inst: InstanceConfig = { id: "codeberg", type: "forgejo", url: API, user: "lapo", emails: [], token: "dummy" };

function fake(routes: Record<string, Route>, extra: Partial<InstanceConfig> = {}) {
  const api = fakeApi(API, routes);
  return { ...api, adapter: new ForgejoAdapter({ ...inst, ...extra }, api.http) };
}

const PR = "https://codeberg.org/foo/bar/pulls/42";
const prRef = { url: PR, instance: "codeberg", kind: "pr" as const };
const user = (login: string) => ({ login });
/** A timeline entry with the fields every type carries. */
const ev = (id: number, type: string, login: string, extra: Record<string, unknown> = {}) =>
  ({ id, type, user: user(login), created_at: "2026-11-01T10:00:00+01:00", body: "", ...extra });

const prRoutes: Record<string, Route> = {
  "/repos/foo/bar/issues/42": {
    title: "Fix build on FreeBSD", state: "closed", user: user("Lapo"), labels: [{ name: "bug" }],
  },
  "/repos/foo/bar/issues/42/timeline": [
    ev(1, "comment", "writer", { body: "Please rebase onto main" }),
    ev(2, "comment", "rando", { body: "+1" }),
    ev(3, "comment", "rando", { body: "@lapo wrote in https://codeberg.org/foo/bar/pulls/42:\n> ...\nWhat about NetBSD?" }),
    ev(4, "comment", "lapo", { body: "cc @lapo" }), // my own mention of myself is no mention
    ev(5, "label", "rando", { body: "1", label: { name: "ready" } }),
    ev(6, "label", "writer", { body: "", label: { name: "wip" } }),
    ev(7, "milestone", "foo", { milestone: { title: "v2.0" } }),
    ev(8, "milestone", "foo", { milestone: null, old_milestone: { title: "v1.9" } }),
    ev(9, "assignees", "writer", { assignee: user("lapo"), removed_assignee: false }),
    ev(10, "assignees", "writer", { assignee: user("other"), removed_assignee: false }),
    ev(11, "assignees", "writer", { assignee: user("lapo"), removed_assignee: true }),
    ev(12, "review_request", "writer", { assignee: user("LAPO"), removed_assignee: false }),
    ev(13, "review_request", "writer", { assignee: user("other"), removed_assignee: false }),
    ev(14, "pull_push", "lapo", { body: '{"is_force_push":false,"commit_ids":["aaa","bbb"]}' }),
    ev(15, "pull_push", "writer", { body: '{"is_force_push":true,"commit_ids":["bbb","ccc"]}' }),
    ev(16, "close", "writer"),
    ev(17, "reopen", "lapo"),
    ev(18, "merge_pull", "writer"),
    ev(19, "review", "writer", { body: "LGTM" }), // reported via the reviews endpoint instead
    ev(20, "change_title", "lapo"),
    ev(21, "comment", "renovate-bot", { body: "Dependency dashboard updated" }),
  ],
  "/repos/foo/bar/pulls/42": { merged: true, mergeable: true, draft: false, head: { sha: "abc123" } },
  "/repos/foo/bar/pulls/42/reviews": [
    { id: 100, user: user("other"), state: "REQUEST_REVIEW", official: false, body: "", submitted_at: "2026-11-01T09:00:00Z" },
    { id: 101, user: user("reviewer"), state: "APPROVED", official: true, body: "Thanks @lapo!", submitted_at: "2026-11-01T12:00:00Z" },
    { id: 102, user: user("rando"), state: "REQUEST_CHANGES", official: false, body: "nit", submitted_at: "2026-11-01T12:30:00Z" },
    { id: 103, user: user("writer"), state: "COMMENT", official: false, body: "", submitted_at: "2026-11-01T12:40:00Z" },
    { id: 104, user: user("lapo"), state: "PENDING", official: false, body: "draft", submitted_at: "2026-11-01T12:50:00Z" },
  ],
  "/repos/foo/bar/commits/abc123/status": { state: "failure", total_count: 18 },
  "/repos/foo/bar/assignees": [user("Writer"), user("foo")],
};

test("refFromUrl accepts only this instance's PR/issue URLs", () => {
  const { adapter } = fake({});
  expect(adapter.refFromUrl(PR)).toEqual(prRef);
  expect(adapter.refFromUrl("https://codeberg.org/foo/bar/issues/7/")).toEqual(
    { url: "https://codeberg.org/foo/bar/issues/7", instance: "codeberg", kind: "issue" });
  expect(adapter.refFromUrl("https://github.com/foo/bar/pull/42")).toBeNull();
  expect(adapter.refFromUrl("https://codeberg.org/foo/bar/pull/42")).toBeNull(); // GitHub spelling
  expect(adapter.refFromUrl("https://codeberg.org/foo/bar")).toBeNull();
});

test("refFromUrl canonicalizes URLs copied from the browser", () => {
  const { adapter } = fake({});
  for (const u of [
    `${PR}/`, `${PR}/files`, `${PR}/commits/`, `${PR}/files?style=split`, `${PR}#issuecomment-123`,
    "https://Codeberg.org/foo/bar/pulls/42", `${PR}/files#diff-abc`,
  ]) {
    expect(adapter.refFromUrl(u)?.url).toBe(PR);
  }
  expect(adapter.refFromUrl(`${PR}/other`)).toBeNull();
  expect(adapter.refFromUrl("https://codeberg.org.evil.example/foo/bar/pulls/42")).toBeNull();
  expect(adapter.refFromUrl("not a url")).toBeNull();
});

test("refFromUrl and fetch handle a web UI under a path prefix", async () => {
  const api = fakeApi("https://example.org/git/api/v1", {
    "/repos/o/r/issues/3": { title: "T", state: "open", user: user("x"), labels: [] },
    "/repos/o/r/issues/3/timeline": [],
    "/repos/o/r/assignees": [],
  });
  const adapter = new ForgejoAdapter({ ...inst, url: "https://example.org/git/api/v1" }, api.http);
  const ref = adapter.refFromUrl("https://example.org/git/o/r/issues/3#top");
  expect(ref?.url).toBe("https://example.org/git/o/r/issues/3");
  expect(adapter.refFromUrl("https://example.org/o/r/issues/3")).toBeNull();
  expect((await adapter.fetch(ref!)).repo).toBe("o/r");
});

test("fetch normalizes a merged PR", async () => {
  const { adapter } = fake(prRoutes);
  const snap = await adapter.fetch(prRef);
  expect(snap).toMatchObject({
    repo: "foo/bar", title: "Fix build on FreeBSD", state: "merged", ciState: "failure",
    hasConflicts: false, authoredByMe: true, labels: ["bug"],
  });
  expect(snap.stateDetail).toBeUndefined();
  const byKey = Object.fromEntries(snap.events.map((e) => [e.key, e]));
  expect(Object.keys(byKey).sort()).toEqual([
    "a:9", "c:1", "c:2", "c:21", "c:3", "c:4", "l:5", "l:6", "m:3", "ms:7", "ms:8", "p:14", "p:15",
    "r:101", "r:102", "r:103", "rm:101", "rr:12", "s:16", "s:17", "s:18",
  ]);
  expect(byKey["c:1"]).toMatchObject({ kind: "comment", actor: "writer", actorRole: "maintainer", body: "Please rebase onto main" });
  expect(byKey["c:1"]?.at.toISOString()).toBe("2026-11-01T09:00:00.000Z");
  expect(byKey["c:2"]?.actorRole).toBe("contributor");
  expect(byKey["c:4"]?.actorRole).toBe("me");
  expect(byKey["c:21"]?.actorRole).toBe("bot");
  expect(byKey["m:3"]).toMatchObject({ kind: "mention", actor: "rando", actorRole: "contributor" });
  // Labels and milestones need write access, so even an unlisted human setting them is a maintainer.
  expect(byKey["l:5"]).toMatchObject({ kind: "label", actorRole: "maintainer", details: { action: "added", label: "ready" } });
  expect(byKey["l:6"]?.details).toEqual({ action: "removed", label: "wip" });
  expect(byKey["ms:7"]).toMatchObject({ kind: "milestone", actorRole: "maintainer", details: { action: "added", milestone: "v2.0" } });
  expect(byKey["ms:8"]?.details).toEqual({ action: "removed", milestone: "v1.9" });
  expect(byKey["a:9"]).toMatchObject({ kind: "assign", actor: "writer" });
  expect(byKey["rr:12"]).toMatchObject({ kind: "review_request", actor: "writer" });
  expect(byKey["p:14"]).toMatchObject({ kind: "push", actorRole: "me", details: { force: false, commits: 2 } });
  expect(byKey["p:15"]).toMatchObject({ kind: "push", actor: "writer", actorRole: "maintainer", details: { force: true } });
  expect(byKey["s:16"]?.details).toEqual({ to: "closed" });
  expect(byKey["s:17"]).toMatchObject({ actorRole: "me", details: { to: "reopened" } });
  expect(byKey["s:18"]).toMatchObject({ kind: "state", details: { to: "merged" } });
  // An official review needs write access, so its author is a maintainer even if not listed.
  expect(byKey["r:101"]).toMatchObject({ kind: "review", actorRole: "maintainer", body: "Thanks @lapo!", details: { state: "approved" } });
  expect(byKey["r:101"]?.at.toISOString()).toBe("2026-11-01T12:00:00.000Z");
  expect(byKey["rm:101"]).toMatchObject({ kind: "mention", actor: "reviewer" });
  expect(byKey["r:102"]).toMatchObject({ actorRole: "contributor", details: { state: "changes_requested" } });
  expect(byKey["r:103"]?.details).toEqual({ state: "commented" });
});

test("the repo owner is a maintainer and the writers list is fetched once per repo", async () => {
  const { adapter, calls } = fake({
    ...prRoutes,
    "/repos/foo/bar/issues/42/timeline": [ev(1, "comment", "Foo", { body: "ok" })],
    "/repos/foo/bar/assignees": [],
  });
  expect((await adapter.fetch(prRef)).events[0]?.actorRole).toBe("maintainer");
  await adapter.fetch(prRef);
  expect(calls.filter((c) => c.endsWith("/assignees"))).toHaveLength(1);
});

test("without a readable writers list, other users are unknown rather than contributors", async () => {
  const forbidden = fake({ ...prRoutes, "/repos/foo/bar/assignees": 403 }); // token without repository scope
  const anonymous = fake(prRoutes, { token: undefined }); // the endpoint needs a token
  for (const { adapter } of [forbidden, anonymous]) {
    const byKey = Object.fromEntries((await adapter.fetch(prRef)).events.map((e) => [e.key, e]));
    expect(byKey["c:2"]?.actorRole).toBe("unknown");
    expect(byKey["c:1"]?.actorRole).toBe("unknown"); // "writer" is only known from the list
    expect(byKey["r:101"]?.actorRole).toBe("maintainer");
  }
  expect(anonymous.calls).not.toContain("/repos/foo/bar/assignees");
});

test("mergeable maps to hasConflicts; drafts are unknown", async () => {
  const cases = [
    [{ merged: false, mergeable: false, draft: false }, "open", "Fix", true],
    [{ merged: false, mergeable: true, draft: false }, "open", "Fix", false],
    [{ merged: false, mergeable: false, draft: true }, "open", "WIP: Fix", null], // drafts are never mergeable
    [{ merged: false, mergeable: false }, "open", "[WIP] Fix", null], // older Gitea: no draft field
    [{ merged: false, mergeable: false }, "closed", "Fix", false],
    [{ merged: true, mergeable: false, draft: false }, "closed", "Fix", false],
  ] as const;
  for (const [pr, state, title, expected] of cases) {
    const { adapter } = fake({
      ...prRoutes,
      "/repos/foo/bar/issues/42": { title, state, user: user("lapo"), labels: [] },
      "/repos/foo/bar/pulls/42": { ...pr, head: { sha: "abc123" } },
    });
    expect((await adapter.fetch(prRef)).hasConflicts).toBe(expected);
  }
});

test("the combined commit status maps to a CI state", async () => {
  const cases = [
    [{ state: "success", total_count: 3 }, "success"],
    [{ state: "warning", total_count: 1 }, "success"],
    [{ state: "skipped", total_count: 1 }, "success"],
    [{ state: "pending", total_count: 2 }, "pending"],
    [{ state: "error", total_count: 1 }, "failure"],
    [{ state: "failure", total_count: 1 }, "failure"],
    [{ state: "", total_count: 0 }, null], // what Forgejo returns for a commit without statuses
    [403, null],
    [404, null],
  ] as const;
  for (const [status, expected] of cases) {
    const { adapter } = fake({ ...prRoutes, "/repos/foo/bar/commits/abc123/status": status });
    expect((await adapter.fetch(prRef)).ciState).toBe(expected);
  }
});

test("a rate limit on CI still stops the fetch", async () => {
  const { adapter } = fake({
    ...prRoutes,
    "/repos/foo/bar/commits/abc123/status": new Response("", { status: 429, headers: { "retry-after": "60" } }),
  });
  expect(await adapter.fetch(prRef).catch((e) => e)).toBeInstanceOf(RateLimitError);
});

test("fetch normalizes an issue and skips PR-only calls", async () => {
  const { adapter, calls } = fake({
    "/repos/foo/bar/issues/7": { title: "Crash", state: "open", user: user("x"), labels: [{ name: "a" }] },
    "/repos/foo/bar/issues/7/timeline": [ev(1, "comment", "x", { body: "Still crashing on 1.2" })],
    "/repos/foo/bar/assignees": [],
  });
  const snap = await adapter.fetch({ url: "https://codeberg.org/foo/bar/issues/7", instance: "codeberg", kind: "issue" });
  expect(snap).toMatchObject({ state: "open", ciState: null, hasConflicts: false, authoredByMe: false, labels: ["a"] });
  expect(snap.events.map((e) => [e.key, e.actorRole])).toEqual([["c:1", "contributor"]]);
  expect(calls).toEqual(["/repos/foo/bar/issues/7", "/repos/foo/bar/issues/7/timeline", "/repos/foo/bar/assignees"]);
});

test("only a 404 on the item itself means gone; a 404 on a sub-request is a plain error", async () => {
  const gone = await fake({ "/repos/foo/bar/issues/42": 404 }).adapter.fetch(prRef).catch((e) => e);
  expect(gone).toBeInstanceOf(GoneError);
  for (const path of ["/repos/foo/bar/issues/42/timeline", "/repos/foo/bar/pulls/42", "/repos/foo/bar/pulls/42/reviews"]) {
    const err = await fake({ ...prRoutes, [path]: 404 }).adapter.fetch(prRef).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(GoneError);
    expect(err.status).toBe(404);
  }
});

test("requests send the token and JSON headers", async () => {
  const { adapter, headers } = fake(prRoutes);
  await adapter.fetch(prRef);
  for (const h of headers) {
    expect(h).toMatchObject({ authorization: "token dummy", accept: "application/json", "user-agent": "watcher" });
  }
  const anon = fake(prRoutes, { token: undefined });
  await anon.adapter.fetch(prRef);
  expect(anon.headers.every((h) => !("authorization" in h))).toBe(true);
});

/** The search path discover() requests for one involvement flag. */
const search = (flag: string, when: string) => `/repos/issues/search?${flag}=true&${when}&limit=50`;
const FLAGS = ["created", "assigned", "mentioned", "review_requested", "reviewed"];
const noSearchHits = (when: string) => Object.fromEntries(FLAGS.map((f) => [search(f, when), []]));

test("discover: first run searches open items and adds open notified items", async () => {
  const { adapter, calls } = fake({
    ...noSearchHits("state=open"),
    [search("created", "state=open")]: [{ html_url: PR }, { html_url: "https://codeberg.org/x/y/issues/1" }],
    [search("review_requested", "state=open")]: [{ html_url: "https://codeberg.org/r/q/pulls/5" }],
    [search("reviewed", "state=open")]: [{ html_url: PR }],
    "/notifications?all=true&limit=50": [
      { subject: { type: "Issue", state: "open", html_url: "https://codeberg.org/k/l/issues/9" } },
      { subject: { type: "Pull", state: "closed", html_url: "https://codeberg.org/k/l/pulls/10" } },
    ],
  });
  const refs = await adapter.discover(null);
  expect(refs.map((r) => r.url)).toEqual([
    PR, "https://codeberg.org/x/y/issues/1", "https://codeberg.org/r/q/pulls/5", "https://codeberg.org/k/l/issues/9",
  ]);
  expect(refs.map((r) => r.kind)).toEqual(["pr", "issue", "pr", "issue"]);
  expect(calls).toHaveLength(6);
});

test("discover: incremental run asks for all states since the cursor, plus notifications", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const when = `state=all&since=${encodeURIComponent(since.toISOString())}`;
  const { adapter } = fake({
    ...noSearchHits(when),
    [search("mentioned", when)]: [{ html_url: PR }],
    [search("assigned", when)]: [{ html_url: PR }],
    [`/notifications?all=true&since=${encodeURIComponent(since.toISOString())}&limit=50`]: [
      { subject: { type: "Issue", state: "closed", html_url: "https://codeberg.org/k/l/issues/9" } }, // closed is a change too
      { subject: { type: "Pull", state: "open", html_url: "https://codeberg.org/k/l/pulls/10" } },
      { subject: { type: "Commit", html_url: "https://codeberg.org/k/l/commit/abc" } },
      { subject: { type: "Pull", state: "open", html_url: PR } },
    ],
  });
  const refs = await adapter.discover(since);
  expect(refs.map((r) => r.url)).toEqual([PR, "https://codeberg.org/k/l/issues/9", "https://codeberg.org/k/l/pulls/10"]);
});

test("discover: without notifications, known items are checked per repo instead", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const iso = encodeURIComponent(since.toISOString());
  const when = `state=all&since=${iso}`;
  const known = [
    prRef, // also found by a search: not checked again
    { url: "https://codeberg.org/foo/bar/issues/7", instance: "codeberg", kind: "issue" as const },
    { url: "https://codeberg.org/foo/bar/issues/8", instance: "codeberg", kind: "issue" as const },
    { url: "https://codeberg.org/gone/repo/issues/1", instance: "codeberg", kind: "issue" as const },
  ];
  const { adapter, calls } = fake({
    ...noSearchHits(when),
    [search("created", when)]: [{ html_url: PR }],
    [`/notifications?all=true&since=${iso}&limit=50`]: 403,
    [`/repos/foo/bar/issues?state=all&since=${iso}&limit=50`]: [
      { html_url: "https://codeberg.org/foo/bar/issues/7" }, // known and updated
      { html_url: "https://codeberg.org/foo/bar/pulls/99" }, // updated, but not mine
    ],
    [`/repos/gone/repo/issues?state=all&since=${iso}&limit=50`]: 404,
  });
  expect((await adapter.discover(since, known)).map((r) => r.url)).toEqual([PR, "https://codeberg.org/foo/bar/issues/7"]);
  expect(calls.filter((c) => c.includes("/issues?state=all"))).toHaveLength(2); // one per repo
});

test("discover: unreadable notifications are skipped, a rate limit is not", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const when = `state=all&since=${encodeURIComponent(since.toISOString())}`;
  const notes = `/notifications?all=true&since=${encodeURIComponent(since.toISOString())}&limit=50`;
  for (const status of [401, 403]) {
    const { adapter } = fake({ ...noSearchHits(when), [search("created", when)]: [{ html_url: PR }], [notes]: status });
    expect((await adapter.discover(since)).map((r) => r.url)).toEqual([PR]);
  }
  const { adapter } = fake({ ...noSearchHits(when), [notes]: new Response("", { status: 429 }) });
  expect(await adapter.discover(since).catch((e) => e)).toBeInstanceOf(RateLimitError);
});

test("adapter contract", async () => {
  await expectAdapterContract(fake(prRoutes).adapter, prRef);
});

test("a bot's @-mention is only a comment", async () => {
  const { adapter } = fake({
    ...prRoutes,
    "/repos/foo/bar/issues/42/timeline": [ev(1, "comment", "ci-bot", { body: "@lapo the build failed" })],
  });
  const snap = await adapter.fetch(prRef);
  expect(snap.events.filter((e) => e.key === "c:1" || e.key === "m:1").map((e) => e.key)).toEqual(["c:1"]);
});

test("discover: refuses to run without a token", async () => {
  // Anonymous searches ignore the "…by the authenticated user" flags and return everyone's items.
  const { adapter, calls } = fake({}, { token: undefined });
  await expect(adapter.discover(null)).rejects.toThrow("Forgejo discovery needs a token");
  expect(calls).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/forgejo.test.ts`
Expected: FAIL with `Cannot find module '../src/adapters/forgejo.ts'`.

- [ ] **Step 3: Implement `src/adapters/forgejo.ts`**

```ts
// Forgejo (e.g. codeberg.org) and Gitea, which share this API. `inst.url` is the API base,
// e.g. https://codeberg.org/api/v1; the web UI lives at the same URL without /api/v1.
import type { InstanceConfig } from "../core/config.ts";
import { defaultHttp, getAllPages, getJson, HttpError, RateLimitError, type HttpDeps } from "../core/http.ts";
import type { ActorRole, Adapter, CiState, ItemRef, ItemState, NormalizedEvent, Snapshot } from "../core/model.ts";
import { mentions, notGone, optional, parseUrl } from "./util.ts";

// Only the fields we use from Forgejo's REST responses.
interface FjUser { login: string }
interface FjIssue {
  title: string;
  state: "open" | "closed";
  user: FjUser | null;
  labels: { name: string }[];
}
interface FjPull {
  merged: boolean;
  mergeable: boolean;
  draft?: boolean; // missing on older Gitea
  head: { sha: string };
}
interface FjTimelineEvent {
  id: number;
  type: string;
  user: FjUser | null; // who did it
  created_at: string;
  body: string;
  label?: { name: string } | null;
  milestone?: { title: string } | null;
  old_milestone?: { title: string } | null;
  assignee?: FjUser | null; // the assignee, or for "review_request" the requested reviewer
  removed_assignee?: boolean; // true when the assignment or review request was withdrawn
}
interface FjReview {
  id: number;
  user: FjUser | null;
  state: string; // APPROVED, REQUEST_CHANGES, COMMENT, PENDING, REQUEST_REVIEW
  official: boolean; // the reviewer's verdict counts towards approval, i.e. they have write access
  body: string;
  submitted_at: string;
}
interface FjNotification { subject?: { html_url?: string; state?: string } | null }

/** Who counts as a maintainer of one repo; `complete` is false when the writers list was unreadable. */
interface Maintainers { logins: Set<string>; complete: boolean }

/** Forgejo's search flags for "involves me": `involves` does not exist, and nothing covers "commented". */
const SEARCH_FLAGS = ["created", "assigned", "mentioned", "review_requested", "reviewed"];
const REVIEW_STATES: Record<string, string> = {
  APPROVED: "approved", REQUEST_CHANGES: "changes_requested", COMMENT: "commented",
};
// Forgejo's default WORK_IN_PROGRESS_PREFIXES; only used when the API has no `draft` field.
const WIP_TITLE = /^\s*(wip:|\[wip\])/i;

export class ForgejoAdapter implements Adapter {
  private readonly web: string;
  private readonly webPrefix: string; // path of the web UI, "" or e.g. "/git"
  private readonly me: string;
  /** "owner/repo" → lowercase logins with write access; null when the list is unreadable. */
  private readonly writers = new Map<string, Set<string> | null>();

  constructor(private readonly inst: InstanceConfig, private readonly http: HttpDeps = defaultHttp) {
    this.web = inst.url.replace(/\/api\/v1$/, "");
    this.webPrefix = new URL(this.web).pathname.replace(/\/$/, "");
    this.me = inst.user.toLowerCase();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", "user-agent": "watcher" };
    if (this.inst.token) h.authorization = `token ${this.inst.token}`;
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    return (await getJson<T>(this.inst.url + path, this.headers(), this.http)).data;
  }

  private all<T>(path: string): Promise<T[]> {
    return getAllPages<T>(this.inst.url + path, this.headers(), this.http);
  }

  /** Also accepts URLs copied from the browser: a PR tab (/files, /commits), a query, a #fragment. */
  refFromUrl(url: string): ItemRef | null {
    const u = parseUrl(url);
    if (!u) return null;
    // URL.origin lowercases the host; the web UI may live under a path prefix (https://example.org/git).
    if (u.origin !== new URL(this.web).origin || !u.pathname.startsWith(this.webPrefix + "/")) return null;
    const m = u.pathname.slice(this.webPrefix.length).match(/^\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)(?:\/(?:files|commits))?\/?$/);
    if (!m) return null;
    return { url: `${this.web}/${m[1]}/${m[2]}/${m[3]}/${m[4]}`, instance: this.inst.id, kind: m[3] === "pulls" ? "pr" : "issue" };
  }

  async discover(since: Date | null, known: ItemRef[] = []): Promise<ItemRef[]> {
    // The search flags mean "…the authenticated user": without a token Forgejo silently ignores
    // them and returns everyone's items: refuse, rather than silently finding nothing.
    if (!this.inst.token) throw new Error("Forgejo discovery needs a token: set token_env for this instance");
    // First run: everything open that involves me. Later runs: anything updated since the cursor,
    // including closed/merged items, so state changes are seen.
    const when = since ? `state=all&since=${encodeURIComponent(since.toISOString())}` : "state=open";
    const refs = new Map<string, ItemRef>();
    const add = (url: string | undefined) => {
      const ref = url ? this.refFromUrl(url) : null;
      if (ref && !refs.has(ref.url)) refs.set(ref.url, ref);
    };
    for (const flag of SEARCH_FLAGS) {
      for (const i of await this.all<{ html_url: string }>(`/repos/issues/search?${flag}=true&${when}&limit=50`)) add(i.html_url);
    }
    const participating = await this.participating(since);
    if (participating) {
      for (const url of participating) add(url);
    } else if (since) {
      // Without notifications, at least check the items already tracked (e.g. ones I commented on).
      for (const url of await this.updatedKnown(since, known.filter((r) => !refs.has(r.url)))) add(url);
    }
    return [...refs.values()];
  }

  /**
   * Items I commented on or subscribed to are not matched by any search flag; Forgejo notifies
   * their watchers (commenting watches an item), so notifications cover them. Also on the first
   * run, keeping only open items, as the searches do. null when the token cannot read them.
   */
  private async participating(since: Date | null): Promise<string[] | null> {
    const when = since ? `&since=${encodeURIComponent(since.toISOString())}` : "";
    let notes: FjNotification[];
    try {
      notes = await this.all<FjNotification>(`/notifications?all=true${when}&limit=50`);
    } catch (err) {
      // A token without the notification scope: fall back rather than fail the run.
      if (err instanceof HttpError && !(err instanceof RateLimitError) && (err.status === 401 || err.status === 403)) return null;
      throw err;
    }
    const urls: string[] = [];
    for (const n of notes) {
      if (!since && n.subject?.state && n.subject.state !== "open") continue;
      // Commit and repository notifications have html_urls refFromUrl rejects.
      if (n.subject?.html_url) urls.push(n.subject.html_url);
    }
    return urls;
  }

  /** Web URLs of known items updated since the cursor: one listing per repo (issues and PRs alike). */
  private async updatedKnown(since: Date, known: ItemRef[]): Promise<string[]> {
    const byRepo = new Map<string, Set<string>>(); // "owner/repo" -> canonical URLs
    for (const ref of known) {
      if (!this.refFromUrl(ref.url)) continue; // cached under an old instance url
      const [owner, repo] = new URL(ref.url).pathname.slice(this.webPrefix.length + 1).split("/");
      const key = `${owner}/${repo}`;
      if (!byRepo.has(key)) byRepo.set(key, new Set());
      byRepo.get(key)!.add(ref.url);
    }
    const urls: string[] = [];
    for (const [repo, wanted] of byRepo) {
      // A deleted or now-private repo must not fail discovery; fetch() will mark its items gone.
      const found = await optional(this.all<{ html_url: string }>(
        `/repos/${repo}/issues?state=all&since=${encodeURIComponent(since.toISOString())}&limit=50`));
      for (const i of found ?? []) {
        const ref = this.refFromUrl(i.html_url);
        if (ref && wanted.has(ref.url)) urls.push(ref.url);
      }
    }
    return urls;
  }

  async fetch(ref: ItemRef): Promise<Snapshot> {
    // ref.url is canonical (see refFromUrl): "<prefix>/owner/repo/pulls/5"
    const [owner = "", repo = "", , num = ""] = new URL(ref.url).pathname.slice(this.webPrefix.length + 1).split("/");
    const base = `/repos/${owner}/${repo}`;
    const issue = await this.get<FjIssue>(`${base}/issues/${num}`);
    // No limit/page: Forgejo then returns the whole timeline at once and sends no Link header
    // (with `page` it truncates, still without a Link header). getAllPages is ready if that changes.
    const timeline = await notGone(this.all<FjTimelineEvent>(`${base}/issues/${num}/timeline`));
    let state: ItemState = issue.state === "open" ? "open" : "closed";
    let ciState: CiState | null = null;
    let hasConflicts: boolean | null = false;
    let reviews: FjReview[] = [];
    if (ref.kind === "pr") {
      const pr = await notGone(this.get<FjPull>(`${base}/pulls/${num}`));
      if (pr.merged) state = "merged";
      hasConflicts = this.conflicts(state, pr, issue.title);
      reviews = await notGone(this.all<FjReview>(`${base}/pulls/${num}/reviews`));
      ciState = await notGone(this.ciState(base, pr.head.sha));
    }
    const maintainers = await this.maintainers(owner, repo, reviews);
    const events = [
      ...timeline.flatMap((e) => this.mapTimeline(e, maintainers)),
      ...reviews.flatMap((r) => this.mapReview(r, maintainers)),
    ];
    return {
      ref,
      repo: `${owner}/${repo}`,
      title: issue.title,
      state,
      ciState,
      hasConflicts,
      authoredByMe: issue.user?.login.toLowerCase() === this.me,
      labels: issue.labels.map((l) => l.name),
      events,
    };
  }

  /**
   * Forgejo's `mergeable` is false not only on a conflict but also while it is still checking,
   * after a check error, and for drafts ("WIP:" titles): a draft's conflicts are unknown (null);
   * otherwise false is read as a conflict, as the API has no way to tell "checking" apart.
   */
  private conflicts(state: ItemState, pr: FjPull, title: string): boolean | null {
    if (state !== "open" || pr.mergeable) return false;
    return (pr.draft ?? WIP_TITLE.test(title)) ? null : true;
  }

  /**
   * Comments carry no author association, so maintainers are: the repo owner, users with write
   * access (the assignees list, which needs a token), and authors of official reviews (an
   * official verdict needs write access). Logins are lowercase.
   */
  private async maintainers(owner: string, repo: string, reviews: FjReview[]): Promise<Maintainers> {
    const key = `${owner}/${repo}`.toLowerCase();
    if (!this.writers.has(key)) {
      // The endpoint needs a token even for public repos; 403/404 (scope, unit disabled) count as unknown.
      const users = this.inst.token ? await optional(this.get<FjUser[]>(`/repos/${owner}/${repo}/assignees`)) : null;
      this.writers.set(key, users ? new Set(users.map((u) => u.login.toLowerCase())) : null);
    }
    const writers = this.writers.get(key) ?? null;
    const logins = new Set(writers ?? []);
    logins.add(owner.toLowerCase());
    for (const r of reviews) if (r.official && r.user) logins.add(r.user.login.toLowerCase());
    return { logins, complete: writers !== null };
  }

  private role(user: FjUser | null | undefined, maintainers: Maintainers): ActorRole {
    if (!user) return "unknown";
    const login = user.login.toLowerCase();
    if (login === this.me) return "me";
    // Forgejo exposes no user type, so bots are recognized by name only.
    if (login.endsWith("[bot]") || login.endsWith("-bot")) return "bot";
    if (maintainers.logins.has(login)) return "maintainer";
    // Without the writers list, someone else may still be a maintainer.
    return maintainers.complete ? "contributor" : "unknown";
  }

  private mapTimeline(e: FjTimelineEvent, maintainers: Maintainers): NormalizedEvent[] {
    const actor = e.user?.login ?? "";
    const role = this.role(e.user, maintainers);
    // Only users with write access can label or set milestones, so a human doing it is a maintainer.
    const triager: ActorRole = role === "contributor" || role === "unknown" ? "maintainer" : role;
    const base = { actor, actorRole: role, at: new Date(e.created_at) };
    const forMe = (u: FjUser | null | undefined) => u?.login.toLowerCase() === this.me && !e.removed_assignee;
    switch (e.type) {
      case "comment": {
        const out: NormalizedEvent[] = [{ ...base, key: `c:${e.id}`, kind: "comment", body: e.body }];
        // A bot pinging me (CI reports, reminders) is not someone asking for me.
        if (role !== "me" && role !== "bot" && mentions(e.body, this.inst.user)) out.push({ ...base, key: `m:${e.id}`, kind: "mention", body: e.body });
        return out;
      }
      case "close":
      case "reopen":
        return [{ ...base, key: `s:${e.id}`, kind: "state", details: { to: e.type === "close" ? "closed" : "reopened" } }];
      case "merge_pull":
        return [{ ...base, key: `s:${e.id}`, kind: "state", details: { to: "merged" } }];
      case "label": // body "1" when the label was added, "" when removed
        return [{ ...base, actorRole: triager, key: `l:${e.id}`, kind: "label",
          details: { action: e.body === "1" ? "added" : "removed", label: e.label?.name } }];
      case "milestone": // a removal has only old_milestone; a change has both
        return [{ ...base, actorRole: triager, key: `ms:${e.id}`, kind: "milestone",
          details: e.milestone ? { action: "added", milestone: e.milestone.title } : { action: "removed", milestone: e.old_milestone?.title } }];
      case "assignees":
        return forMe(e.assignee) ? [{ ...base, key: `a:${e.id}`, kind: "assign" }] : [];
      case "review_request": // the requested reviewer is in `assignee`; team requests are ignored
        return forMe(e.assignee) ? [{ ...base, key: `rr:${e.id}`, kind: "review_request" }] : [];
      case "pull_push":
        return [{ ...base, key: `p:${e.id}`, kind: "push", details: this.pushDetails(e.body) }];
      default: // title changes, references, branch deletions… ; "review": see the reviews endpoint
        return [];
    }
  }

  /**
   * The body is JSON {is_force_push, commit_ids}. For a force push commit_ids is [old head, new head],
   * not the pushed commits, so only plain pushes get a commit count.
   */
  private pushDetails(body: string): Record<string, unknown> {
    try {
      const p = JSON.parse(body) as { is_force_push?: boolean; commit_ids?: string[] | null };
      return p.is_force_push ? { force: true } : { force: false, commits: p.commit_ids?.length ?? 0 };
    } catch {
      return { force: false };
    }
  }

  private mapReview(r: FjReview, maintainers: Maintainers): NormalizedEvent[] {
    // PENDING is an unsubmitted draft; REQUEST_REVIEW is a placeholder for a review request
    // (the timeline's "review_request" event reports those).
    const state = REVIEW_STATES[r.state];
    if (!state) return [];
    const base = { actor: r.user?.login ?? "", actorRole: this.role(r.user, maintainers), at: new Date(r.submitted_at) };
    const out: NormalizedEvent[] = [{ ...base, key: `r:${r.id}`, kind: "review", body: r.body, details: { state } }];
    if (base.actorRole !== "me" && base.actorRole !== "bot" && mentions(r.body, this.inst.user)) out.push({ ...base, key: `rm:${r.id}`, kind: "mention", body: r.body });
    return out;
  }

  /**
   * The combined commit status (Forgejo Actions and external CI both report statuses).
   * Best-effort: unreadable (403/404) or no statuses at all gives null.
   */
  private async ciState(base: string, sha: string): Promise<CiState | null> {
    const status = await optional(this.get<{ state: string; total_count: number }>(`${base}/commits/${sha}/status`));
    if (!status || status.total_count === 0) return null;
    switch (status.state) {
      case "success":
      case "warning":
      case "skipped":
        return "success";
      case "pending":
        return "pending";
      case "error":
      case "failure":
        return "failure";
      default:
        return null;
    }
  }
}
```

- [ ] **Step 4: Run the test and the type checker**

Run: `bun test test/forgejo.test.ts && bun run typecheck`
Expected: `19 pass, 0 fail`, then no type errors.

- [ ] **Step 5: Commit**

```bash
grep -rn REDACTED src test   # must print nothing
git add src/adapters/forgejo.ts test/forgejo.test.ts
git commit -m "Add Forgejo adapter (Codeberg, Gitea)" -m "Discovery uses the search 'me' flags plus notifications, which cover items I commented on; without notification access it re-checks known items. Maintainers are the owner, writers (assignees list) and official reviewers." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Bugzilla adapter

How Bugzilla 5.x data maps onto the model (`inst.url` is the **web** base, e.g. `https://bugs.freebsd.org/bugzilla`; the API is under `/rest`; `user` is the login email):
- **URLs:** `<base>/show_bug.cgi?id=N` (other parameters and `#c3` fragments ignored) and the short forms `<origin>/N` and `<base>/N`; canonical `<base>/show_bug.cgi?id=N`, kind `bug`. Aliases are rejected (they can be reassigned).
- **Discovery** (works anonymously): `/rest/bug` with buglist-style email criteria (my login as reporter, assignee, CC, QA contact or commenter), and a second search for bugs where a flag was requested of me (`requestees.login_name`, e.g. `needinfo?(me)`, which does not CC me); `resolution=---` on the first run, `last_change_time=T` later; `limit`/`offset` paging in a stable `bug_id` order.
- **Item:** `/rest/bug/N` (summary, status, resolution, `is_open`, product/component → repo, creator, assignee, keywords → labels; stateDetail like `Closed/FIXED`). Comments (the automatic "Created attachment N" header is dropped, and a comment with nothing else is skipped). History: status + resolution changed together → one `state` event; flags (a granted request reports only the grant; removals only on their own; a flag cleared by obsoleting its attachment is not reported); obsoleted attachments; keyword changes (→ label, by a maintainer, since they need editbugs rights); assignee changes (someone took the bug). Attachments (new uploads). History has no ids: keys are built from the change time and field, not from `who`, because logins are emails that may change.
- **API key** (optional): sent as `api_key` in the query string, because Bugzilla 5.0 (FreeBSD, KDE) ignores the `X-BUGZILLA-API-KEY` header. It is added inside the adapter's fetch function, below the HTTP helper, so URLs in error messages and logs never contain it. A bug I may no longer see (HTTP 401 with error code 102) counts as gone, as GitHub reports private repositories with a 404; an error body is never taken for data.
- **Roles:** me = `user` or any of `emails`; bot = automation accounts (`bugzilla@…`, `-bot`/`.bot` local parts, BMO's `.tld`/`.bugs` domains; FreeBSD's `commit-hook@` is deliberately not a bot: its comments announce the fixing commit); maintainer = the current assignee or an address in `maintainer_domains`.

**Files:**
- Create: `src/adapters/bugzilla.ts`
- Test: `test/bugzilla.test.ts`

- [ ] **Step 1: Write the failing test `test/bugzilla.test.ts`**

```ts
// Bugzilla adapter against a fake API: responses are minimal, sanitized shapes of real
// bugs.freebsd.org / bugs.kde.org / bugzilla.mozilla.org REST payloads (Bugzilla 5.0 and BMO).
import { expect, test } from "bun:test";
import { BugzillaAdapter } from "../src/adapters/bugzilla.ts";
import type { InstanceConfig } from "../src/core/config.ts";
import { GoneError, HttpError } from "../src/core/http.ts";
import type { ItemRef } from "../src/core/model.ts";
import { expectAdapterContract } from "./contract.ts";
import { fakeApi, type Route } from "./fake-http.ts";

const WEB = "https://bugs.freebsd.org/bugzilla";
const API = `${WEB}/rest`;
const inst: InstanceConfig = {
  id: "freebsd", type: "bugzilla", url: WEB, user: "me@example.org",
  emails: ["me@work.example"], maintainerDomains: ["freebsd.org"],
};

function fakeBugzilla(routes: Record<string, Route>, extra: Partial<InstanceConfig> = {}) {
  const api = fakeApi(API, routes);
  return { adapter: new BugzillaAdapter({ ...inst, ...extra }, api.http), ...api };
}

const BUG = `${WEB}/show_bug.cgi?id=300491`;
const ref: ItemRef = { url: BUG, instance: "freebsd", kind: "bug" };
const MAIN = "/bug/300491?include_fields=summary,status,resolution,is_open,product,component,creator,assigned_to,keywords";

const comment = (id: number, creator: string, time: string, text: string, attachment_id: number | null = null) =>
  ({ id, creator, creation_time: time, time, text, attachment_id, is_private: false, count: id - 1, bug_id: 300491 });
const attachment = (id: number, summary: string, is_patch: number, time: string) =>
  ({ id, summary, is_patch, creator: "me@example.org", creation_time: time, is_obsolete: 0, is_private: 0, flags: [], bug_id: 300491 });

const bugRoutes: Record<string, Route> = {
  [MAIN]: {
    bugs: [{
      summary: "archivers/urbackup-server: Update to version 2.5.38", status: "Closed", resolution: "FIXED", is_open: false,
      product: "Ports & Packages", component: "Individual Port(s)", creator: "Me@Example.org",
      assigned_to: "committer@FreeBSD.org", keywords: ["patch"],
    }],
    faults: [],
  },
  "/bug/300491/comment": {
    bugs: {
      "300491": {
        comments: [
          comment(1, "me@example.org", "2026-11-03T23:40:10Z", "Created attachment 1001\nUpdate patch\n\nUpdate to version 2.5.38.", 1001),
          comment(2, "me@example.org", "2026-11-03T23:41:27Z", "Created attachment 1002\nPoudriere build log", 1002),
          comment(3, "committer@FreeBSD.org", "2026-11-04T04:31:29Z", "Thanks."),
          comment(4, "commit-hook@FreeBSD.org", "2026-11-04T19:38:26Z",
            "A commit in branch main references this bug:\n\nURL: https://cgit.FreeBSD.org/ports/commit/?id=dc6bd49f5245\n\n"),
          comment(5, "ME@work.example", "2026-11-04T19:45:00Z", "Thank you!"),
          comment(6, "helper@example.net", "2026-11-04T20:00:00Z", "Builds and runs fine here on 15.0-RELEASE."),
        ],
      },
    },
    comments: {},
  },
  "/bug/300491/history": {
    bugs: [{
      id: 300491, alias: [],
      history: [
        { who: "bugzilla@FreeBSD.org", when: "2026-11-03T23:40:11Z", changes: [
          { field_name: "assigned_to", removed: "ports-bugs@FreeBSD.org", added: "committer@FreeBSD.org" },
          { field_name: "flagtypes.name", removed: "", added: "maintainer-feedback?(maint@example.com)" },
        ] },
        { who: "me@example.org", when: "2026-11-03T23:41:27Z", changes: [
          { field_name: "flagtypes.name", removed: "", added: "maintainer-approval+", attachment_id: 1001 },
          { field_name: "cc", removed: "", added: "me@example.org" },
        ] },
        { who: "me@example.org", when: "2026-11-04T17:47:51Z", changes: [
          { field_name: "attachments.isobsolete", removed: "0", added: "1", attachment_id: 1001 },
          { field_name: "flagtypes.name", removed: "maintainer-approval+", added: "", attachment_id: 1001 },
          { field_name: "flagtypes.name", removed: "", added: "maintainer-approval+", attachment_id: 1003 },
        ] },
        { who: "committer@FreeBSD.org", when: "2026-11-04T19:44:15Z", changes: [
          { field_name: "flagtypes.name", removed: "", added: "merge-quarterly+" },
          { field_name: "keywords", removed: "", added: "patch, needs-qa" },
          { field_name: "severity", removed: "Affects Only Me", added: "Affects Some People" },
          { field_name: "resolution", removed: "", added: "FIXED" },
          { field_name: "status", removed: "New", added: "Closed" },
        ] },
        { who: "helper@example.net", when: "2026-11-04T20:10:00Z", changes: [
          { field_name: "flagtypes.name", removed: "merge-quarterly+", added: "" },
          { field_name: "keywords", removed: "needs-qa", added: "" },
          { field_name: "maintainer-feedback", removed: "", added: "ignored" },
        ] },
        { who: "helper@example.net", when: "2026-11-04T20:20:00Z", changes: [
          { field_name: "flagtypes.name", removed: "maintainer-feedback?(maint@example.com)", added: "maintainer-feedback+" },
          { field_name: "cc", removed: "", added: "helper@example.net" },
        ] },
      ],
    }],
  },
  "/bug/300491/attachment?exclude_fields=data": {
    bugs: {
      "300491": [
        attachment(1001, "Update patch", 1, "2026-11-03T23:40:10Z"),
        attachment(1002, "Poudriere build log", 0, "2026-11-03T23:41:27Z"),
        attachment(1003, "Updated patch", 1, "2026-11-04T17:47:51Z"),
      ],
    },
    attachments: {},
  },
};

test("refFromUrl accepts show_bug.cgi and the short forms, canonicalized", () => {
  const { adapter } = fakeBugzilla({});
  expect(adapter.refFromUrl(BUG)).toEqual(ref);
  for (const u of [
    `${BUG}#c3`, `${WEB}/show_bug.cgi?ctype=xml&id=300491`, `${BUG}&format=multiple`,
    "https://bugs.freebsd.org/300491", "https://bugs.freebsd.org/bugzilla/300491", "https://BUGS.FreeBSD.org/300491/",
  ]) {
    expect(adapter.refFromUrl(u)?.url).toBe(BUG);
  }
});

test("refFromUrl rejects aliases, other pages and other hosts", () => {
  const { adapter } = fakeBugzilla({});
  for (const u of [
    `${WEB}/show_bug.cgi?id=CVE-2026-1234`, `${WEB}/show_bug.cgi`, `${WEB}/show_bug.cgi?id=0`, `${WEB}/show_bug.cgi?id=12a`,
    `${WEB}/buglist.cgi?id=300491`, "https://bugs.freebsd.org/show_bug.cgi?id=300491", "https://bugs.freebsd.org/other/300491",
    "https://bugs.kde.org/show_bug.cgi?id=300491", "http://bugs.freebsd.org/bugzilla/show_bug.cgi?id=300491",
    "https://bugs.freebsd.org.evil.example/300491", "not a url",
  ]) {
    expect(adapter.refFromUrl(u)).toBeNull();
  }
});

test("refFromUrl on a Bugzilla installed at the root (KDE, BMO)", () => {
  const kde = new BugzillaAdapter({ ...inst, id: "kde", url: "https://bugs.kde.org" });
  const canonical = "https://bugs.kde.org/show_bug.cgi?id=527546";
  expect(kde.refFromUrl("https://bugs.kde.org/527546")?.url).toBe(canonical);
  expect(kde.refFromUrl(`${canonical}#c2`)).toEqual({ url: canonical, instance: "kde", kind: "bug" });
});

const SEARCH = "/bug?email1=me%40example.org&emailtype1=equals&emailreporter1=1&emailassigned_to1=1&emailcc1=1"
  + "&emaillongdesc1=1&emailqa_contact1=1&include_fields=id&order=bug_id";
/** Bugs where a flag was requested of me. */
const REQUESTED = "/bug?f1=requestees.login_name&o1=equals&v1=me%40example.org&include_fields=id&order=bug_id";

test("discover: first run asks for open bugs I am involved in, paging until a short page", async () => {
  const fullPage = Array.from({ length: 500 }, (_, i) => ({ id: i + 1 }));
  const { adapter, calls } = fakeBugzilla({
    [`${SEARCH}&resolution=---&limit=500&offset=0`]: { bugs: fullPage },
    [`${SEARCH}&resolution=---&limit=500&offset=500`]: { bugs: [{ id: 300491 }] },
    [`${REQUESTED}&resolution=---&limit=500&offset=0`]: { bugs: [{ id: 300491 }, { id: 7 }] }, // 300491: deduplicated
  });
  const refs = await adapter.discover(null);
  expect(calls).toHaveLength(3);
  expect(refs).toHaveLength(501);
  expect(refs[0]).toEqual({ url: `${WEB}/show_bug.cgi?id=1`, instance: "freebsd", kind: "bug" });
  expect(refs[500]).toEqual(ref);
});

test("discover: later runs ask for anything changed since the cursor, closed bugs included", async () => {
  const { adapter, calls } = fakeBugzilla({
    [`${SEARCH}&last_change_time=2026-11-01T10%3A00%3A00Z&limit=500&offset=0`]: { bugs: [{ id: 300491 }] },
    [`${REQUESTED}&last_change_time=2026-11-01T10%3A00%3A00Z&limit=500&offset=0`]: { bugs: [{ id: 42 }] },
  });
  expect(await adapter.discover(new Date("2026-11-01T10:00:00.123Z"))).toEqual([
    ref, { url: `${WEB}/show_bug.cgi?id=42`, instance: "freebsd", kind: "bug" },
  ]);
  expect(calls).toHaveLength(2);
});

test("fetch normalizes a closed ports PR", async () => {
  const { adapter } = fakeBugzilla(bugRoutes);
  const snap = await adapter.fetch(ref);
  expect(snap).toMatchObject({
    ref, repo: "Ports & Packages/Individual Port(s)", title: "archivers/urbackup-server: Update to version 2.5.38",
    state: "closed", stateDetail: "Closed/FIXED", authoredByMe: true, labels: ["patch"],
  });
  expect(snap.ciState).toBeUndefined();
  expect(snap.hasConflicts).toBeUndefined();
  const byKey = Object.fromEntries(snap.events.map((e) => [e.key, e]));
  expect(Object.keys(byKey).sort()).toEqual([
    "att:1001", "att:1002", "att:1003",
    "c:1", "c:3", "c:4", "c:5", "c:6",
    "h:2026-11-03T23:40:11Z:assign",
    "h:2026-11-03T23:40:11Z:flag:bug:maintainer-feedback?(maint@example.com)",
    "h:2026-11-03T23:41:27Z:flag:1001:maintainer-approval+",
    "h:2026-11-04T17:47:51Z:flag:1003:maintainer-approval+",
    "h:2026-11-04T17:47:51Z:obsolete:1001",
    "h:2026-11-04T19:44:15Z:flag:bug:merge-quarterly+",
    "h:2026-11-04T19:44:15Z:kw+:needs-qa",
    "h:2026-11-04T19:44:15Z:kw+:patch",
    "h:2026-11-04T19:44:15Z:state",
    "h:2026-11-04T20:10:00Z:flag:bug:merge-quarterly+",
    "h:2026-11-04T20:10:00Z:kw-:needs-qa",
    "h:2026-11-04T20:20:00Z:flag:bug:maintainer-feedback+",
  ]);
  // Comments: the automatic attachment header is dropped, attachment-only comments are skipped.
  expect(byKey["c:1"]).toMatchObject({ kind: "comment", actor: "me@example.org", actorRole: "me", body: "Update to version 2.5.38." });
  expect(byKey["c:1"]?.at.toISOString()).toBe("2026-11-03T23:40:10.000Z");
  expect(byKey["c:3"]).toMatchObject({ actorRole: "maintainer", body: "Thanks." });
  expect(byKey["c:4"]).toMatchObject({ actor: "commit-hook@FreeBSD.org", actorRole: "maintainer" });
  expect(byKey["c:5"]?.actorRole).toBe("me"); // one of my extra emails, case-insensitive
  expect(byKey["c:6"]?.actorRole).toBe("contributor");
  // History.
  expect(byKey["h:2026-11-03T23:40:11Z:assign"]).toMatchObject({
    kind: "assign", actor: "bugzilla@FreeBSD.org", actorRole: "bot", details: { to: "committer@FreeBSD.org" },
  });
  expect(byKey["h:2026-11-03T23:41:27Z:flag:1001:maintainer-approval+"]).toMatchObject({
    kind: "flag", actorRole: "me", details: { action: "added", flag: "maintainer-approval+", attachment: 1001 },
  });
  expect(byKey["h:2026-11-04T17:47:51Z:obsolete:1001"]).toMatchObject({
    kind: "attachment", details: { action: "obsoleted", id: 1001, summary: "Update patch" },
  });
  expect(byKey["h:2026-11-04T19:44:15Z:state"]).toMatchObject({
    kind: "state", actor: "committer@FreeBSD.org", actorRole: "maintainer", details: { to: "Closed/FIXED" },
  });
  expect(byKey["h:2026-11-04T19:44:15Z:kw+:patch"]).toMatchObject({ kind: "label", details: { action: "added", label: "patch" } });
  // Only editbugs users can change keywords: treated as a maintainer, like GitHub labels.
  expect(byKey["h:2026-11-04T20:10:00Z:kw-:needs-qa"]).toMatchObject({
    kind: "label", actor: "helper@example.net", actorRole: "maintainer", details: { action: "removed", label: "needs-qa" },
  });
  expect(byKey["h:2026-11-04T20:10:00Z:flag:bug:merge-quarterly+"]).toMatchObject({
    actorRole: "contributor", details: { action: "removed", flag: "merge-quarterly+" },
  });
  expect(byKey["h:2026-11-04T20:20:00Z:flag:bug:maintainer-feedback+"]?.details).toEqual({ action: "added", flag: "maintainer-feedback+" });
  // Attachments.
  expect(byKey["att:1001"]).toMatchObject({
    kind: "attachment", actorRole: "me", details: { action: "added", id: 1001, summary: "Update patch", isPatch: true },
  });
  expect(byKey["att:1002"]?.details).toMatchObject({ isPatch: false });
});

test("adapter contract (canonical ref, unique and stable event keys)", async () => {
  await expectAdapterContract(fakeBugzilla(bugRoutes).adapter, ref);
});

test("a reopened bug is open, and the transition has no resolution", async () => {
  const { adapter } = fakeBugzilla({
    ...bugRoutes,
    [MAIN]: { bugs: [{ ...(bugRoutes[MAIN] as any).bugs[0], status: "Open", resolution: "", is_open: true }] },
    "/bug/300491/history": { bugs: [{ id: 300491, history: [
      { who: "committer@FreeBSD.org", when: "2026-11-05T08:00:00Z", changes: [
        { field_name: "status", removed: "Closed", added: "Open" },
        { field_name: "resolution", removed: "FIXED", added: "" },
      ] },
      { who: "committer@FreeBSD.org", when: "2026-11-06T08:00:00Z", changes: [
        { field_name: "resolution", removed: "FIXED", added: "DUPLICATE" },
      ] },
    ] }] },
  });
  const snap = await adapter.fetch(ref);
  expect(snap).toMatchObject({ state: "open", stateDetail: "Open" });
  const states = snap.events.filter((e) => e.kind === "state").map((e) => e.details?.to);
  expect(states).toEqual(["Open", "DUPLICATE"]);
});

test("roles: the assignee is a maintainer even without maintainer domains; bots are recognized", async () => {
  const { adapter } = fakeBugzilla({
    ...bugRoutes,
    "/bug/300491/comment": { bugs: { "300491": { comments: [
      comment(1, "committer@FreeBSD.org", "2026-11-04T04:31:29Z", "Committed, thanks!"),
      comment(2, "other@FreeBSD.org", "2026-11-04T04:32:00Z", "Looks good to me too."),
      comment(3, "phab-bot@bmo.tld", "2026-11-04T04:33:00Z", "Revision updated"),
      comment(4, "update-bot@example.org", "2026-11-04T04:34:00Z", "New version available"),
      comment(5, "", "2026-11-04T04:35:00Z", "Imported comment with no author"),
    ] } } },
  }, { maintainerDomains: undefined });
  const roles = (await adapter.fetch(ref)).events.filter((e) => e.kind === "comment").map((e) => e.actorRole);
  expect(roles).toEqual(["maintainer", "contributor", "bot", "bot", "unknown"]);
});

test("a maintainer domain also covers its subdomains, but not look-alikes", async () => {
  const { adapter } = fakeBugzilla({
    ...bugRoutes,
    "/bug/300491/comment": { bugs: { "300491": { comments: [
      comment(1, "dev@mail.FreeBSD.org", "2026-11-04T04:31:29Z", "ok"),
      comment(2, "dev@notfreebsd.org", "2026-11-04T04:32:00Z", "ok"),
    ] } } },
  });
  const roles = (await adapter.fetch(ref)).events.filter((e) => e.kind === "comment").map((e) => e.actorRole);
  expect(roles).toEqual(["maintainer", "contributor"]);
});

test("a missing bug is gone", async () => {
  const notFound = Response.json(
    { error: true, code: 101, message: "Bug #300491 does not exist.", documentation: "https://bugzilla.readthedocs.org/en/5.0/api/" },
    { status: 404 });
  await expect(fakeBugzilla({ [MAIN]: notFound }).adapter.fetch(ref)).rejects.toBeInstanceOf(GoneError);
  await expect(fakeBugzilla({ [MAIN]: { bugs: [], faults: [] } }).adapter.fetch(ref)).rejects.toBeInstanceOf(GoneError);
});

test("a bug I may no longer see (HTTP 401, code 102) is gone; other 401s are failures", async () => {
  const denied = Response.json(
    { error: 1, code: 102, message: "You are not authorized to access bug 300491." }, { status: 401 });
  await expect(fakeBugzilla({ [MAIN]: denied }).adapter.fetch(ref)).rejects.toBeInstanceOf(GoneError);
  const mustLogIn = Response.json({ error: 1, code: 410, message: "You must log in before using this part of Bugzilla." }, { status: 401 });
  const err = await fakeBugzilla({ [MAIN]: mustLogIn }).adapter.fetch(ref).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).not.toBeInstanceOf(GoneError);
  expect(err.status).toBe(401);
});

test("an error body is never taken for data, whatever the HTTP status", async () => {
  const { adapter } = fakeBugzilla({ [MAIN]: { error: true, code: 32000, message: "Something odd" } });
  const err = await adapter.fetch(ref).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).not.toBeInstanceOf(GoneError);
  expect(err.message).toContain("Something odd");
  const gone = fakeBugzilla({ [MAIN]: { error: true, code: 101, message: "Bug #300491 does not exist." } });
  await expect(gone.adapter.fetch(ref)).rejects.toBeInstanceOf(GoneError);
});

test("a sub-request that is not found or denied is an ordinary failure, not gone", async () => {
  for (const path of ["/bug/300491/comment", "/bug/300491/history", "/bug/300491/attachment?exclude_fields=data"]) {
    for (const failure of [404, Response.json({ error: 1, code: 102, message: "denied" }, { status: 401 }), 500]) {
      const { adapter } = fakeBugzilla({ ...bugRoutes, [path]: failure });
      const err = await adapter.fetch(ref).catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err).not.toBeInstanceOf(GoneError);
    }
  }
});

test("the API key goes in the query string (Bugzilla 5.0 ignores the header) and never into error messages", async () => {
  const withKey = (path: string) => `${path}${path.includes("?") ? "&" : "?"}api_key=dummy`;
  const routes = Object.fromEntries(Object.entries(bugRoutes).map(([p, r]) => [withKey(p), r]));
  const { adapter, calls, headers } = fakeBugzilla(routes, { token: "dummy" });
  await adapter.fetch(ref);
  expect(calls).toEqual(Object.keys(bugRoutes).map(withKey));
  expect(headers[0]).toEqual({ accept: "application/json", "user-agent": "watcher" });

  const failing = fakeBugzilla({ [withKey(MAIN)]: 500 }, { token: "dummy" });
  const err = await failing.adapter.fetch(ref).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err.url).not.toContain("dummy");
  expect(err.message).not.toContain("dummy");
});

test("without a token no key is sent", async () => {
  const { adapter, calls } = fakeBugzilla(bugRoutes);
  await adapter.fetch(ref);
  expect(calls.some((c) => c.includes("api_key"))).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/bugzilla.test.ts`
Expected: FAIL with `Cannot find module '../src/adapters/bugzilla.ts'`.

- [ ] **Step 3: Implement `src/adapters/bugzilla.ts`**

```ts
// Bugzilla 5.x REST (bugs.freebsd.org/bugzilla, bugs.kde.org, bugzilla.mozilla.org).
// `inst.url` is the web base (e.g. https://bugs.freebsd.org/bugzilla); the API lives under /rest.
import type { InstanceConfig } from "../core/config.ts";
import { isBot } from "../core/filter.ts";
import { defaultHttp, getJson, GoneError, HttpError, type FetchFn, type HttpDeps } from "../core/http.ts";
import type { ActorRole, Adapter, ItemRef, NormalizedEvent, Snapshot } from "../core/model.ts";
import { notGone, parseUrl } from "./util.ts";

// Only the fields we use from Bugzilla's REST responses. People are identified by their
// login, which is an email address (shown in full even to anonymous users on all three targets).
interface BzBug {
  summary: string;
  status: string; // "New", "Closed" on FreeBSD; "NEW", "RESOLVED" on KDE and BMO
  resolution: string; // "" while open
  is_open: boolean;
  product: string;
  component: string;
  creator: string;
  assigned_to: string;
  keywords: string[];
}
interface BzComment {
  id: number;
  creator: string;
  creation_time: string;
  text: string;
  attachment_id: number | null; // set on the comment Bugzilla writes when an attachment is created
}
interface BzChange {
  field_name: string; // API field names: "status", "resolution", "flagtypes.name", "attachments.isobsolete"…
  added: string; // multi-valued fields (keywords, flags) are comma-separated lists
  removed: string;
  attachment_id?: number; // set when the change is to an attachment (its flags, obsolete bit…)
}
interface BzHistoryEntry { when: string; who: string; changes: BzChange[] }
interface BzAttachment {
  id: number;
  creator: string;
  creation_time: string;
  summary: string;
  is_patch: number | boolean; // 0/1 in Bugzilla 5.0
}
/** Bugzilla's error body: `error` is true (5.0) or 1 (BMO). */
interface BzError { error?: boolean | number; code?: number; message?: string }

/** "Bug does not exist" (HTTP 404) and "you are not authorized to access bug" (HTTP 401). */
const BUG_NOT_FOUND = 101;
const BUG_ACCESS_DENIED = 102;
const PAGE_SIZE = 500; // all three targets return at least this many per search page
const MAX_PAGES = 20;
const MAIN_FIELDS = "summary,status,resolution,is_open,product,component,creator,assigned_to,keywords";
/** Bugzilla's own automation account (FreeBSD's auto-assigns ports PRs to their maintainer). */
const AUTOMATION_LOCAL_PARTS = new Set(["bugzilla"]);
/** The comment Bugzilla writes for a new attachment: "Created attachment N\n<summary>", then any text the uploader added. */
const ATTACHMENT_HEADER = /^Created attachment \d+\n[^\n]*\n?/;

/** Splits a history value like "maintainer-approval+, merge-quarterly?" into its items. */
function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Automated accounts. Logins are emails, so the generic isBot() (which looks at the end of a
 * login) is applied to the local part. BMO puts its bots on unroutable domains
 * (phab-bot@bmo.tld, release-mgmt-account-bot@mozilla.tld, intermittent-bug-filer@mozilla.bugs).
 * Deliberately not a bot: FreeBSD's commit-hook@FreeBSD.org, whose comments announce the commit
 * that fixed the bug.
 */
function isBugzillaBot(login: string): boolean {
  const at = login.lastIndexOf("@");
  const local = at < 0 ? login : login.slice(0, at);
  const domain = at < 0 ? "" : login.slice(at + 1);
  return isBot(local) || /[-_.]bot$/.test(local) || AUTOMATION_LOCAL_PARTS.has(local) || /\.(tld|bugs)$/.test(domain);
}

export class BugzillaAdapter implements Adapter {
  private readonly web: URL;
  private readonly api: string;
  private readonly http: HttpDeps;
  private readonly mine: Set<string>; // my logins/emails, lowercase

  constructor(private readonly inst: InstanceConfig, http: HttpDeps = defaultHttp) {
    this.web = new URL(inst.url);
    this.api = `${inst.url}/rest`;
    this.mine = new Set([inst.user, ...inst.emails].map((e) => e.toLowerCase()));
    const fetchFn = http.fetchFn;
    this.http = { ...http, fetchFn: (url, init) => this.send(fetchFn, url, init) };
  }

  /**
   * Every request goes through here, below getJson, to adapt Bugzilla to the shared HTTP helper:
   * - The API key goes in the query string: Bugzilla 5.0 (FreeBSD, KDE) silently ignores the
   *   X-BUGZILLA-API-KEY header, which only BMO honours. Adding it here, rather than to the URLs
   *   we build, keeps it out of the URLs that getJson puts in error messages and logs.
   * - "Not authorized to access bug" comes as a 401, which getJson would report as an ordinary
   *   failure. A bug I can no longer see (moved to a security group, or my access was revoked)
   *   is gone as far as I am concerned, as GitHub reports private repositories with a 404, so
   *   it becomes a 404 too. Other 401s (e.g. "you must log in") stay failures.
   */
  private async send(fetchFn: FetchFn, url: string, init?: RequestInit): Promise<Response> {
    const target = this.inst.token
      ? `${url}${url.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(this.inst.token)}`
      : url;
    const res = await fetchFn(target, init);
    if (res.status === 401) {
      const body = (await res.clone().json().catch(() => null)) as BzError | null;
      if (body?.code === BUG_ACCESS_DENIED) return new Response(null, { status: 404 });
    }
    return res;
  }

  private headers(): Record<string, string> {
    return { accept: "application/json", "user-agent": "watcher" };
  }

  private async get<T>(path: string): Promise<T> {
    const data = (await getJson<T & BzError>(this.api + path, this.headers(), this.http)).data;
    // Bugzilla maps its errors to HTTP statuses (101 → 404, 102 → 401, others → 400), but the
    // body is the authority: never take an error body for data, whatever the status was.
    if (data.error) {
      const url = this.api + path;
      if (data.code === BUG_NOT_FOUND || data.code === BUG_ACCESS_DENIED) throw new GoneError(404, url, data.message);
      throw new HttpError(200, url, `Bugzilla error ${data.code} for ${url}: ${data.message}`);
    }
    return data;
  }

  /**
   * Accepts `<base>/show_bug.cgi?id=N` (other parameters and #fragments, e.g. #c3, ignored) and
   * the short forms `<origin>/N` and `<base>/N` that BMO, KDE and FreeBSD hand out.
   * Bug aliases are rejected: the canonical URL must be stable, and an alias can be reassigned.
   */
  refFromUrl(url: string): ItemRef | null {
    const u = parseUrl(url);
    if (!u || u.origin !== this.web.origin) return null;
    const basePath = this.web.pathname.replace(/\/$/, ""); // "" or e.g. "/bugzilla"
    const inBase = basePath === "" || u.pathname.startsWith(`${basePath}/`);
    const path = inBase ? u.pathname.slice(basePath.length) : u.pathname; // "/show_bug.cgi", "/123"
    const id = inBase && path === "/show_bug.cgi" ? u.searchParams.get("id") : path.match(/^\/(\d+)\/?$/)?.[1];
    if (!id || !/^[1-9]\d*$/.test(id)) return null;
    return { url: this.bugUrl(id), instance: this.inst.id, kind: "bug" };
  }

  private bugUrl(id: string | number): string {
    return `${this.inst.url}/show_bug.cgi?id=${id}`;
  }

  /**
   * Two searches: bugs I reported, am assigned to, am CC'd on, am QA contact for or commented on;
   * and bugs where someone asked me for a flag (needinfo?(me), review?(me)), which does not CC
   * me. Together they cover everything, so `known` is not needed. Both work anonymously.
   */
  async discover(since: Date | null): Promise<ItemRef[]> {
    const criteria: Record<string, string>[] = [
      { email1: this.inst.user, emailtype1: "equals",
        emailreporter1: "1", emailassigned_to1: "1", emailcc1: "1", emaillongdesc1: "1", emailqa_contact1: "1" },
      { f1: "requestees.login_name", o1: "equals", v1: this.inst.user },
    ];
    const ids = new Set<number>();
    for (const c of criteria) {
      const params = new URLSearchParams({
        ...c,
        include_fields: "id",
        order: "bug_id", // a stable order, so offset paging neither skips nor repeats bugs
      });
      // First run: open bugs only ("---" is Bugzilla's "no resolution"). Later runs: anything
      // changed since the cursor (inclusive, UTC), closed or not, so resolutions are seen.
      if (since) params.set("last_change_time", since.toISOString().replace(/\.\d{3}Z$/, "Z"));
      else params.set("resolution", "---");
      params.set("limit", String(PAGE_SIZE));
      for (let page = 0; page < MAX_PAGES; page++) {
        params.set("offset", String(page * PAGE_SIZE));
        const res = await this.get<{ bugs: { id: number }[] }>(`/bug?${params}`);
        for (const b of res.bugs) ids.add(b.id);
        if (res.bugs.length < PAGE_SIZE) break;
      }
    }
    return [...ids].map((id) => ({ url: this.bugUrl(id), instance: this.inst.id, kind: "bug" as const }));
  }

  async fetch(ref: ItemRef): Promise<Snapshot> {
    const id = new URL(ref.url).searchParams.get("id");
    const res = await this.get<{ bugs: BzBug[] }>(`/bug/${id}?include_fields=${MAIN_FIELDS}`);
    const bug = res.bugs[0];
    if (!bug) throw new GoneError(404, this.api + `/bug/${id}`);
    const comments = await notGone(this.get<{ bugs: Record<string, { comments: BzComment[] }> }>(`/bug/${id}/comment`));
    const history = await notGone(this.get<{ bugs: { history: BzHistoryEntry[] }[] }>(`/bug/${id}/history`));
    const attachments = await notGone(this.get<{ bugs: Record<string, BzAttachment[]> }>(`/bug/${id}/attachment?exclude_fields=data`));

    const assignee = bug.assigned_to.toLowerCase();
    const roleOf = (who: string) => this.role(who, assignee);
    const atts = attachments.bugs[String(id)] ?? [];
    const summaries = new Map(atts.map((a) => [a.id, a.summary]));
    const events: NormalizedEvent[] = [];
    for (const c of comments.bugs[String(id)]?.comments ?? []) {
      const e = this.mapComment(c, roleOf);
      if (e) events.push(e);
    }
    for (const h of history.bugs[0]?.history ?? []) events.push(...this.mapHistory(h, roleOf, summaries));
    for (const a of atts) {
      events.push({
        key: `att:${a.id}`, kind: "attachment", actor: a.creator, actorRole: roleOf(a.creator), at: new Date(a.creation_time),
        details: { action: "added", id: a.id, summary: a.summary, isPatch: Boolean(a.is_patch) },
      });
    }
    return {
      ref,
      repo: `${bug.product}/${bug.component}`,
      title: bug.summary,
      state: bug.is_open ? "open" : "closed",
      stateDetail: bug.resolution ? `${bug.status}/${bug.resolution}` : bug.status,
      authoredByMe: this.mine.has(bug.creator.toLowerCase()),
      labels: bug.keywords,
      events,
    };
  }

  /**
   * Maintainer: the current assignee (on FreeBSD, the committer who took the PR) or anyone from
   * the project's own email domains (committers, e.g. @FreeBSD.org): their short "Committed,
   * thanks!" must not be dropped as noise.
   */
  private role(who: string, assignee: string): ActorRole {
    const login = who.toLowerCase();
    if (!login) return "unknown";
    if (this.mine.has(login)) return "me";
    if (isBugzillaBot(login)) return "bot";
    const domain = login.slice(login.lastIndexOf("@") + 1);
    const ownDomain = (this.inst.maintainerDomains ?? []).some((d) => domain === d || domain.endsWith(`.${d}`));
    return login === assignee || ownDomain ? "maintainer" : "contributor";
  }

  /**
   * Comments include the bug's description (count 0). Private comments are only returned to
   * users allowed to read them, so they need no special treatment. The automatic
   * "Created attachment N" header is dropped (the attachment event reports the upload), and a
   * comment with nothing else in it is skipped.
   */
  private mapComment(c: BzComment, roleOf: (who: string) => ActorRole): NormalizedEvent | null {
    const body = c.attachment_id ? c.text.replace(ATTACHMENT_HEADER, "").trim() : c.text;
    if (c.attachment_id && body === "") return null;
    return { key: `c:${c.id}`, kind: "comment", actor: c.creator, actorRole: roleOf(c.creator), at: new Date(c.creation_time), body };
  }

  /**
   * History entries have no ids. Bugzilla groups changes by (who, when), so `when` plus the field
   * identifies a change. `who` is left out of keys on purpose: it is the user's current login,
   * and a user changing their email would otherwise make their whole history look new.
   */
  private mapHistory(h: BzHistoryEntry, roleOf: (who: string) => ActorRole, summaries: Map<number, string>): NormalizedEvent[] {
    const role = roleOf(h.who);
    // Keywords need editbugs rights, like labels on GitHub need triage rights.
    const triager: ActorRole = role === "contributor" || role === "unknown" ? "maintainer" : role;
    const base = { actor: h.who, actorRole: role, at: new Date(h.when) };
    const key = (what: string) => `h:${h.when}:${what}`;
    // Obsoleting an attachment also clears its pending flags; that removal is not news of its own.
    const obsoleted = new Set(h.changes.filter((c) => c.field_name === "attachments.isobsolete" && c.added === "1").map((c) => c.attachment_id));
    const events: NormalizedEvent[] = [];
    let status: string | undefined;
    let resolution: string | undefined;
    for (const c of h.changes) {
      switch (c.field_name) {
        case "status":
          status = c.added;
          break;
        case "resolution":
          resolution = c.added;
          break;
        case "assigned_to": // someone took the bug (or handed it on): worth knowing
          events.push({ ...base, key: key("assign"), kind: "assign", details: { to: c.added } });
          break;
        case "keywords":
          for (const k of splitList(c.added)) events.push({ ...base, actorRole: triager, key: key(`kw+:${k}`), kind: "label", details: { action: "added", label: k } });
          for (const k of splitList(c.removed)) events.push({ ...base, actorRole: triager, key: key(`kw-:${k}`), kind: "label", details: { action: "removed", label: k } });
          break;
        case "flagtypes.name": {
          // Granting a request ("approval?(x)" → "approval+") removes the request and adds the
          // grant in one change: report only what was added, and removals only on their own.
          const target = c.attachment_id ?? "bug";
          const added = splitList(c.added);
          const removed = c.attachment_id && obsoleted.has(c.attachment_id) ? [] : splitList(c.removed);
          const action = added.length > 0 ? "added" : "removed";
          for (const flag of added.length > 0 ? added : removed) {
            events.push({ ...base, key: key(`flag:${target}:${flag}`), kind: "flag",
              details: { action, flag, ...(c.attachment_id ? { attachment: c.attachment_id } : {}) } });
          }
          break;
        }
        case "attachments.isobsolete":
          if (c.added === "1" && c.attachment_id) {
            events.push({ ...base, key: key(`obsolete:${c.attachment_id}`), kind: "attachment",
              details: { action: "obsoleted", id: c.attachment_id, summary: summaries.get(c.attachment_id) } });
          }
          break;
        // Ignored: cc, priority, severity, summary, blocks/depends_on, see_also, whiteboard,
        // target_milestone, custom cf_* fields, comment tags…: triage bookkeeping, not progress.
      }
    }
    // A status and a resolution changed together are one transition, e.g. "Closed/FIXED".
    const to = [status, resolution].filter((s) => s).join("/");
    if (to) events.push({ ...base, key: key("state"), kind: "state", details: { to } });
    return events;
  }
}
```

- [ ] **Step 4: Run the test and the type checker**

Run: `bun test test/bugzilla.test.ts && bun run typecheck`
Expected: `16 pass, 0 fail`, then no type errors.

- [ ] **Step 5: Commit**

```bash
grep -rn REDACTED src test   # must print nothing
git add src/adapters/bugzilla.ts test/bugzilla.test.ts
git commit -m "Add Bugzilla adapter (FreeBSD, KDE, Mozilla)" -m "Searches by my email in every role plus flag requests to me; normalizes comments, history (status, flags, keywords, assignee, obsoleted attachments) and attachments. The API key goes in the query, since Bugzilla 5.0 ignores the header, without ever reaching logged URLs." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Wire the adapters in, examples and README

**Files:**
- Modify: `src/adapters/index.ts`, `test/adapters.test.ts`, `data/config.example.yaml`, `.env.example`, `README.md`

- [ ] **Step 1: Update the failing test `test/adapters.test.ts`**

Replace the whole file with:

```ts
import { expect, test } from "bun:test";
import { canonicalIntentFor, createAdapter, urlRecognizer } from "../src/adapters/index.ts";
import { DEFAULT_FILTER, type Config } from "../src/core/config.ts";
import { parseIntent } from "../src/core/intent.ts";

const config: Config = {
  instances: [
    { id: "github", type: "github", url: "https://api.github.com", user: "lapo", emails: [] },
    { id: "kde", type: "gitlab", url: "https://invent.kde.org/api/v4", user: "lapo", emails: [] },
    { id: "codeberg", type: "forgejo", url: "https://codeberg.org/api/v1", user: "lapo", emails: [] },
    { id: "freebsd", type: "bugzilla", url: "https://bugs.freebsd.org/bugzilla", user: "lapo@example.org", emails: [] },
    { id: "broken", type: "gitlab", url: "not a url", user: "lapo", emails: [] },
  ],
  filter: DEFAULT_FILTER,
};

test("createAdapter knows every instance type", () => {
  for (const inst of config.instances.slice(0, 4)) expect(createAdapter(inst)).toBeDefined();
});

test("urlRecognizer canonicalizes URLs of every forge and skips misconfigured instances", () => {
  const recognize = urlRecognizer(config);
  expect(recognize("https://github.com/foo/bar/pull/42/files")).toEqual({
    url: "https://github.com/foo/bar/pull/42", instance: "github", kind: "pr",
  });
  expect(recognize("https://invent.kde.org/utilities/konsole/-/merge_requests/7/diffs")?.url)
    .toBe("https://invent.kde.org/utilities/konsole/-/merge_requests/7");
  expect(recognize("https://codeberg.org/foo/bar/issues/3#issuecomment-1")?.url).toBe("https://codeberg.org/foo/bar/issues/3");
  expect(recognize("https://bugs.freebsd.org/bugzilla/show_bug.cgi?id=123#c4")?.url)
    .toBe("https://bugs.freebsd.org/bugzilla/show_bug.cgi?id=123");
  expect(recognize("https://gitlab.com/foo/bar/-/issues/3")).toBeNull(); // no gitlab.com instance
});

test("canonicalIntentFor re-keys items.yaml by canonical URL", () => {
  const raw = parseIntent(`
items:
  - url: https://github.com/foo/bar/pull/42/
    priority: important
  - url: https://gitlab.com/foo/bar/-/issues/3
`);
  const { intent, unknown } = canonicalIntentFor(config, raw);
  expect([...intent.keys()]).toEqual(["https://github.com/foo/bar/pull/42"]);
  expect(unknown).toEqual(["https://gitlab.com/foo/bar/-/issues/3"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/adapters.test.ts`
Expected: FAIL: `no adapter for type 'gitlab' yet`, and the KDE, Codeberg and FreeBSD URLs are not recognized.

- [ ] **Step 3: Replace `src/adapters/index.ts`**

```ts
import type { Config, InstanceConfig } from "../core/config.ts";
import { canonicalizeIntent, type Intent } from "../core/intent.ts";
import type { Adapter, ItemRef } from "../core/model.ts";
import { BugzillaAdapter } from "./bugzilla.ts";
import { ForgejoAdapter } from "./forgejo.ts";
import { GitHubAdapter } from "./github.ts";
import { GitLabAdapter } from "./gitlab.ts";

export function createAdapter(inst: InstanceConfig): Adapter {
  switch (inst.type) {
    case "github":
      return new GitHubAdapter(inst);
    case "gitlab":
      return new GitLabAdapter(inst);
    case "forgejo":
      return new ForgejoAdapter(inst);
    case "bugzilla":
      return new BugzillaAdapter(inst);
  }
}

/**
 * Returns a function that maps any item URL (also one copied from the browser) to its
 * canonical ref, using the adapters of the configured instances; null if none recognizes it.
 * An instance whose adapter cannot be created (e.g. its `url` is not a URL) is skipped here;
 * polling it reports the error.
 */
export function urlRecognizer(config: Config): (url: string) => ItemRef | null {
  const adapters: Adapter[] = [];
  for (const inst of config.instances) {
    try {
      adapters.push(createAdapter(inst));
    } catch {
      // Misconfigured instance: its URLs cannot be recognized.
    }
  }
  return (url) => {
    for (const a of adapters) {
      const ref = a.refFromUrl(url);
      if (ref) return ref;
    }
    return null;
  };
}

/** items.yaml keyed by canonical URL; `unknown` lists the non-manual URLs no instance recognizes. */
export function canonicalIntentFor(config: Config, intent: Intent): { intent: Intent; unknown: string[] } {
  return canonicalizeIntent(intent, urlRecognizer(config));
}
```

- [ ] **Step 4: Replace `data/config.example.yaml`**

```yaml
# Optional: your commit emails, so your own pushes are recognized even when an email is
# not linked to your forge account (compared case-insensitively). Applies to every
# instance; an instance with its own `emails:` list uses that list instead.
# Bugzilla instances also use them to recognize your own comments and changes.
emails: [you@example.org]

# Instances to poll. Tokens live in .env; token_env names the variable.
# `url` is the API base for GitHub, GitLab and Forgejo, and the web base for Bugzilla.
instances:
  - id: github
    type: github
    url: https://api.github.com
    user: your-github-login
    token_env: GITHUB_TOKEN
    # emails: [you@work.example]   # replaces the top-level list for this instance

  - id: kde
    type: gitlab
    url: https://invent.kde.org/api/v4
    user: your-kde-login
    token_env: KDE_GITLAB_TOKEN

  - id: codeberg
    type: forgejo
    url: https://codeberg.org/api/v1
    user: your-codeberg-login
    token_env: CODEBERG_TOKEN

  - id: freebsd-bz
    type: bugzilla
    url: https://bugs.freebsd.org/bugzilla
    user: you@example.org          # your Bugzilla login email
    token_env: FREEBSD_BZ_KEY      # Bugzilla works anonymously too: drop this line to poll without a key
    # Email domains of the project's committers: their short comments ("Committed, thanks!")
    # count as a maintainer's. The bug's assignee always counts.
    maintainer_domains: [freebsd.org]

  # - id: kde-bz
  #   type: bugzilla
  #   url: https://bugs.kde.org
  #   user: you@example.org
  #   maintainer_domains: [kde.org]

  # - id: mozilla-bz
  #   type: bugzilla
  #   url: https://bugzilla.mozilla.org
  #   user: you@example.org
  #   maintainer_domains: [mozilla.com]

# Optional filter tuning (these are the defaults).
filter:
  noise_patterns: ['^\+1$', '^me too', '^same here', '^any update', '^bump$']
  min_comment_length: 20
  bot_allowlist: []
```

- [ ] **Step 5: Replace `.env.example`**

```sh
# One variable per instance, named by token_env in data/config.yaml.
GITHUB_TOKEN=
KDE_GITLAB_TOKEN=
CODEBERG_TOKEN=
FREEBSD_BZ_KEY=
```

- [ ] **Step 6: Replace `README.md`** (the "GitHub token" section becomes "Tokens", covering every forge)

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

### Tokens

The watcher only reads, so give every token read-only access.

- **GitHub**: a **classic** personal access token with just the `notifications` scope:
  public repositories, search and CI status need no scope at all. (Don't pick `public_repo`
  or `repo`: those grant write access. `repo` is only needed to watch private repositories.)
  Fine-grained tokens with "Public repositories (read-only)" access work too, but they cannot
  read notifications, so issues you only *subscribed to* are not discovered.
- **GitLab** (gitlab.com, invent.kde.org, …): a personal access token with the `read_api`
  scope (User settings → Access tokens). Required: GitLab's searches, to-dos and comments are
  not readable anonymously.
- **Forgejo** (codeberg.org, …): an access token (Settings → Applications) with read access
  to *issue*, *notification* and *repository*. Required: without a token, searches return
  everyone's items. Without the notification permission, items you only commented on are not
  discovered; without the repository permission, maintainers are not recognized.
- **Bugzilla** (bugs.freebsd.org, bugs.kde.org, bugzilla.mozilla.org): an API key
  (Preferences → API Keys). Optional: public bugs and searches work anonymously; a key is
  needed for bugs only logged-in users can see. `user` is your login email; list your other
  addresses in `emails` so your comments under them are recognized as yours.

## Commands

```
bun run watcher poll [--instance ID] [--dry-run]
bun run watcher list [--all] [--muted]
bun run watcher seen URL... | --all
bun run watcher refilter
```

`seen` takes item URLs as `list` shows them (a URL copied from the browser, e.g. with
`/files` or a `#fragment`, works too); marking everything seen needs `seen --all`.

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

- [ ] **Step 7: Run everything**

Run: `bun test && bun run typecheck && grep -rn REDACTED src test; echo "grep exit=$?"`
Expected: `162 pass, 0 fail` across 15 files, no type errors, `grep exit=1` (nothing found).

Also check that the example config parses: `bun -e 'import {parseConfig} from "./src/core/config.ts"; console.log(parseConfig(await Bun.file("data/config.example.yaml").text(), {}).instances.map((i) => i.id).join(" "))'`
Expected: `github kde codeberg freebsd-bz`.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/index.ts test/adapters.test.ts data/config.example.yaml .env.example README.md
git commit -m "Enable the GitLab, Forgejo and Bugzilla adapters; document their tokens" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live smoke test (no tokens needed)

Bugzilla works anonymously, so a real end-to-end run is possible without credentials: an address with no bugs makes discovery cheap, and one real bug listed in `items.yaml` exercises a full fetch. GitLab and Forgejo instances without tokens must fail with a clear message.

- [ ] **Step 1: Create a scratch home outside the repo**

```bash
SMOKE=/tmp/watcher-smoke-plan2 && rm -rf "$SMOKE" && mkdir -p "$SMOKE/data" && cd /project/watcher
printf '%s\n' 'instances:' '  - id: freebsd-bz' '    type: bugzilla' '    url: https://bugs.freebsd.org/bugzilla' \
  '    user: watcher-smoke@example.invalid' '    maintainer_domains: [freebsd.org]' \
  '  - id: codeberg' '    type: forgejo' '    url: https://codeberg.org/api/v1' '    user: watcher-smoke' \
  '  - id: kde' '    type: gitlab' '    url: https://invent.kde.org/api/v4' '    user: watcher-smoke' > "$SMOKE/data/config.yaml"
printf '%s\n' 'items:' '  - url: https://bugs.freebsd.org/300512' > "$SMOKE/data/items.yaml"
```

- [ ] **Step 2: Dry run of all instances**

Run: `WATCHER_HOME="$SMOKE" bun run watcher poll --dry-run; echo "exit=$?"`
Expected:
```
freebsd-bz: ok, 1 fetched, 0 new signal(s)
codeberg: ERROR Forgejo discovery needs a token: set token_env for this instance (0 fetched, 0 new signal(s))
kde: ERROR GitLab discovery needs a token: set token_env for this instance (0 fetched, 0 new signal(s))
(dry run: nothing was saved)
exit=1
```

- [ ] **Step 3: Real run of the Bugzilla instance, then the listing**

Run: `WATCHER_HOME="$SMOKE" bun run watcher poll --instance freebsd-bz && WATCHER_HOME="$SMOKE" bun run watcher list --all`
Expected: `freebsd-bz: ok, 1 fetched, 0 new signal(s)`, then one row for `Ports & Packages/Individual Port(s)  devel/doctest: …` with URL `https://bugs.freebsd.org/bugzilla/show_bug.cgi?id=300512` (canonicalized from the short URL), not marked `●` (first run: baseline). The title and state may have changed since this plan was written.

- [ ] **Step 4: Check the stored verdicts**

Run:
```bash
WATCHER_HOME="$SMOKE" bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.env.WATCHER_HOME + "/var/cache.sqlite"); for (const r of db.query("SELECT kind, actor, actor_role, reason FROM events ORDER BY at").all()) console.log(Object.values(r).join(" | "))'
```
Expected (at least these, in this order; later activity may add rows):
```
comment | thierry@FreeBSD.org | maintainer | signal:maintainer-comment
flag | bugzilla@FreeBSD.org | bot | noise:bot
attachment | thierry@FreeBSD.org | maintainer | signal:attachment
assign | thierry@FreeBSD.org | maintainer | signal:assign
```
The second row is the automatic `maintainer-feedback?` request: it must be noise.

Clean up: `rm -rf "$SMOKE"`. Nothing to commit.

- [ ] **Step 5: Hand over to the user for real configuration** (not something an agent does)

The user adds their GitLab, Forgejo and Bugzilla instances to `data/config.yaml` (see `data/config.example.yaml`) and commits it, puts the tokens in `.env` (README, "Tokens"), then runs `bun run watcher poll --dry-run --instance <id>` for each new instance, and a real `poll` twice (baseline, then incremental). The token-only endpoints listed at the top of this plan are exercised for the first time there.

---

## Known limitations (accepted; revisit when they bite)

- **Forgejo conflicts:** the API cannot tell "still checking mergeability" from "conflict", so polling a non-draft PR during the few seconds after a push may report a conflict once (signal on important items only).
- **Forgejo without the notification permission:** items I only commented on, and never otherwise tracked, are not discovered (known ones are re-checked).
- **GitLab first run:** items I commented on in the last 90 days are fetched whatever their state, so the first run may bring in closed or merged items (as baseline; one-off API cost).
- **GitLab "requested changes"** system-note wording comes from GitLab's source; it never appeared on the live instances checked.
- **Bugzilla on BMO:** sheriffs and Mozilla staff count as contributors unless `maintainer_domains` lists their domains (e.g. `mozilla.com`).
- **Bugzilla default assignees** (`ports-bugs@`, `nobody@mozilla.org`) count as maintainers if they ever comment.
- **Rate limits:** Codeberg sends the IETF `ratelimit` header, which is not parsed; a 429 still stops the instance cleanly, but the reset time is only known when `Retry-After` is present.
