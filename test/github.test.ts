// GitHub adapter against a fake API: responses are minimal, sanitized shapes of real GitHub payloads.
import { expect, test } from "bun:test";
import { GitHubAdapter } from "../src/adapters/github.ts";
import type { InstanceConfig } from "../src/core/config.ts";
import { GoneError, HttpError, RateLimitError, type HttpDeps } from "../src/core/http.ts";
import { expectAdapterContract } from "./contract.ts";

const API = "https://api.github.com";
const inst = { id: "github", type: "github" as const, url: API, user: "lapo", emails: [] as string[], token: "t" };

/** Fake GitHub: maps "path?query" (without the API base) to a JSON body or a status code. */
function fakeGitHub(routes: Record<string, unknown>, extra: Partial<InstanceConfig> = {}) {
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
  return { adapter: new GitHubAdapter({ ...inst, ...extra }, http), calls };
}

const PR = "https://github.com/foo/bar/pull/42";

const prRoutes = {
  "/repos/foo/bar/issues/42": {
    title: "Fix build on FreeBSD", state: "closed", state_reason: null,
    user: { login: "Lapo" }, labels: [{ name: "bug" }],
    created_at: "2026-10-20T08:00:00Z", updated_at: "2026-11-02T09:30:00Z",
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

test("refFromUrl canonicalizes URLs copied from the browser", () => {
  const { adapter } = fakeGitHub({});
  for (const u of [
    `${PR}/`, `${PR}/files`, `${PR}/commits/`, `${PR}/checks?check_run_id=1`, `${PR}?w=1`,
    `${PR}#issuecomment-123`, "https://GitHub.com/foo/bar/pull/42", `${PR}/files#diff-abc`,
  ]) {
    expect(adapter.refFromUrl(u)?.url).toBe(PR);
  }
  expect(adapter.refFromUrl("https://github.com/foo/bar/issues/7#top")?.url).toBe("https://github.com/foo/bar/issues/7");
  expect(adapter.refFromUrl(`${PR}/other`)).toBeNull();
  expect(adapter.refFromUrl("https://github.com.evil.example/foo/bar/pull/42")).toBeNull();
  expect(adapter.refFromUrl("not a url")).toBeNull();
});

test("fetch normalizes a merged PR", async () => {
  const { adapter } = fakeGitHub(prRoutes);
  const snap = await adapter.fetch({ url: PR, instance: "github", kind: "pr" });
  expect(snap).toMatchObject({
    repo: "foo/bar", title: "Fix build on FreeBSD", state: "merged", ciState: "failure",
    hasConflicts: false, authoredByMe: true, labels: ["bug"],
    createdAt: new Date("2026-10-20T08:00:00Z"), updatedAt: new Date("2026-11-02T09:30:00Z"),
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

test("adapter contract", async () => {
  await expectAdapterContract(fakeGitHub(prRoutes).adapter, { url: PR, instance: "github", kind: "pr" });
});

test("mergeable_state maps to hasConflicts, with unknown as null", async () => {
  for (const [state, expected] of [["dirty", true], ["clean", false], ["unknown", null], [undefined, null]] as const) {
    const { adapter } = fakeGitHub({
      ...prRoutes,
      "/repos/foo/bar/pulls/42": { merged: false, mergeable_state: state, head: { sha: "abc123" } },
    });
    expect((await adapter.fetch({ url: PR, instance: "github", kind: "pr" })).hasConflicts).toBe(expected);
  }
});

test("own commits are recognized by committer login or configured email", async () => {
  const commit = (sha: string, author: unknown, committer: unknown, authorEmail: string, committerEmail: string) => ({
    sha, author, committer,
    commit: {
      message: "msg",
      author: { name: "Someone", email: authorEmail, date: "2026-10-30T09:00:00Z" },
      committer: { name: "Someone", email: committerEmail, date: "2026-10-30T09:00:00Z" },
    },
  });
  const { adapter } = fakeGitHub({
    ...prRoutes,
    "/repos/foo/bar/pulls/42/commits?per_page=100": [
      commit("unlinked0000", null, null, "Lapo@Home.Example", "noreply@github.com"), // email not linked to an account
      commit("committer000", { login: "maint" }, { login: "lapo" }, "maint@x.org", "x@y.org"), // I pushed someone's patch
      commit("committermail", null, null, "maint@x.org", "lapo@home.example"),
      commit("foreign00000", { login: "maint" }, { login: "web-flow" }, "maint@x.org", "noreply@github.com"),
    ],
  }, { emails: ["lapo@home.example"] });
  const snap = await adapter.fetch({ url: PR, instance: "github", kind: "pr" });
  const roles = Object.fromEntries(snap.events.filter((e) => e.kind === "push").map((e) => [e.key, e.actorRole]));
  expect(roles).toEqual({
    "commit:unlinked0000": "me", "commit:committer000": "me", "commit:committermail": "me", "commit:foreign00000": "unknown",
  });
});

test("only a 404 on the item itself means gone; a 404 on a sub-request is a plain error", async () => {
  const ref = { url: PR, instance: "github", kind: "pr" as const };
  const gone = await fakeGitHub({}).adapter.fetch(ref).catch((e) => e);
  expect(gone).toBeInstanceOf(GoneError);
  for (const path of ["/repos/foo/bar/issues/42/timeline?per_page=100", "/repos/foo/bar/pulls/42",
    "/repos/foo/bar/pulls/42/commits?per_page=100"]) { // (CI sources are best-effort: see below)
    const routes: Record<string, unknown> = { ...prRoutes, [path]: 404 };
    const err = await fakeGitHub(routes).adapter.fetch(ref).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(GoneError);
    expect(err.status).toBe(404);
  }
});

test("CI is best-effort: unreadable check runs and statuses give no CI state", async () => {
  const { adapter } = fakeGitHub({
    ...prRoutes,
    "/repos/foo/bar/commits/abc123/check-runs?per_page=100": 403, // e.g. token without checks permission
    "/repos/foo/bar/commits/abc123/status": 404,
  });
  const snap = await adapter.fetch({ url: PR, instance: "github", kind: "pr" });
  expect(snap.ciState).toBeNull();
  expect(snap.events.map((e) => e.key)).toContain("c:1");
});

test("CI uses whichever source is readable", async () => {
  const { adapter } = fakeGitHub({ ...prRoutes, "/repos/foo/bar/commits/abc123/check-runs?per_page=100": 403 });
  expect((await adapter.fetch({ url: PR, instance: "github", kind: "pr" })).ciState).toBe("success");
});

test("a rate limit on CI still stops the fetch", async () => {
  const http: HttpDeps = {
    fetchFn: async (url) => {
      const path = url.slice(API.length);
      if (path.includes("/check-runs")) return new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      const body = (prRoutes as Record<string, unknown>)[path];
      return body === undefined ? new Response("", { status: 404 }) : Response.json(body);
    },
    sleep: async () => {},
    retries: 0,
    timeoutMs: 1000,
  };
  const adapter = new GitHubAdapter({ ...inst }, http);
  expect(await adapter.fetch({ url: PR, instance: "github", kind: "pr" }).catch((e) => e)).toBeInstanceOf(RateLimitError);
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

/** The search path discover() requests for one involvement qualifier. */
const search = (who: string, when: string) =>
  `/search/issues?q=${encodeURIComponent(`${who}:lapo ${when}`)}&sort=updated&per_page=100`;

test("discover: first run searches open items only, including review requests and reviews", async () => {
  const { adapter, calls } = fakeGitHub({
    [search("involves", "is:open")]: { items: [{ html_url: PR }, { html_url: "https://github.com/x/y/issues/1" }] },
    [search("review-requested", "is:open")]: { items: [{ html_url: "https://github.com/r/q/pull/5" }] },
    [search("reviewed-by", "is:open")]: { items: [{ html_url: PR }, { html_url: "https://github.com/r/v/pull/6" }] },
  });
  const refs = await adapter.discover(null);
  expect(refs.map((r) => r.url)).toEqual([
    PR, "https://github.com/x/y/issues/1", "https://github.com/r/q/pull/5", "https://github.com/r/v/pull/6",
  ]);
  expect(calls).toHaveLength(3);
});

test("discover: incremental run adds subscribed items from notifications", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const when = "updated:>=2026-11-04T10:00:00Z";
  const { adapter } = fakeGitHub({
    [search("involves", when)]: { items: [{ html_url: PR }] },
    [search("review-requested", when)]: { items: [{ html_url: PR }] },
    [search("reviewed-by", when)]: { items: [] },
    [`/notifications?all=true&per_page=50&since=${encodeURIComponent(since.toISOString())}`]: [
      { subject: { url: "https://api.github.com/repos/k/l/issues/9" } },
      { subject: { url: "https://api.github.com/repos/k/l/pulls/10" } },
      { subject: { url: "https://api.github.com/repos/k/l/releases/1" } },
      { subject: { url: "https://api.github.com/repos/foo/bar/pulls/42" } },
    ],
  });
  const refs = await adapter.discover(since);
  expect(refs.map((r) => r.url)).toEqual([PR, "https://github.com/k/l/issues/9", "https://github.com/k/l/pull/10"]);
});

test("discover: notifications forbidden (fine-grained token) is skipped", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const when = "updated:>=2026-11-04T10:00:00Z";
  const { adapter } = fakeGitHub({
    [search("involves", when)]: { items: [] },
    [search("review-requested", when)]: { items: [] },
    [search("reviewed-by", when)]: { items: [] },
    [`/notifications?all=true&per_page=50&since=${encodeURIComponent(since.toISOString())}`]: 403,
  });
  expect(await adapter.discover(since)).toEqual([]);
});

/** Fake GitHub serving `pages` pages of a paged list: each page links to the next, and to the last. */
function pagedGitHub(pathOf: (page: number) => string, pages: number, body: (page: number) => unknown, routes: Record<string, unknown>) {
  const http: HttpDeps = {
    fetchFn: async (url) => {
      const path = url.slice(API.length);
      for (let p = 1; p <= pages; p++) {
        if (path !== pathOf(p)) continue;
        const link = [
          p < pages ? `<${API}${pathOf(p + 1)}>; rel="next"` : "",
          `<${API}${pathOf(pages)}>; rel="last"`,
        ].filter(Boolean).join(", ");
        return Response.json(body(p), { headers: { link } });
      }
      const route = routes[path];
      return route === undefined ? new Response(`no route for ${path}`, { status: 404 }) : Response.json(route);
    },
    sleep: async () => {},
    retries: 0,
    timeoutMs: 1000,
  };
  return new GitHubAdapter(inst, http);
}

test("discover: more than 20 notification pages do not fail discovery, the first 20 are delivered", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const when = "updated:>=2026-11-04T10:00:00Z";
  const base = `/notifications?all=true&per_page=50&since=${encodeURIComponent(since.toISOString())}`;
  const adapter = pagedGitHub((p) => (p === 1 ? base : `${base}&page=${p}`), 21,
    (p) => [{ subject: { url: `https://api.github.com/repos/k/l/issues/${p}` } }],
    { [search("involves", when)]: { items: [] }, [search("review-requested", when)]: { items: [] }, [search("reviewed-by", when)]: { items: [] } });
  const refs = await adapter.discover(since);
  expect(refs).toHaveLength(20);
  expect(refs.at(-1)?.url).toBe("https://github.com/k/l/issues/20");
});

test("fetch: an issue with 21 timeline pages keeps its new state and its newest comment", async () => {
  const tl = "/repos/foo/bar/issues/7/timeline?per_page=100";
  const adapter = pagedGitHub((p) => (p === 1 ? tl : `${tl}&page=${p}`), 21,
    (p) => [{ event: "commented", id: p, actor: { login: "maint" }, user: { login: "maint" }, author_association: "MEMBER",
      created_at: new Date(Date.UTC(2026, 10, 1, 0, p)).toISOString(), body: `comment ${p}` }],
    { "/repos/foo/bar/issues/7": { title: "Long thread", state: "closed", state_reason: "completed", user: { login: "x" }, labels: [],
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" } });
  const snap = await adapter.fetch({ url: "https://github.com/foo/bar/issues/7", instance: "github", kind: "issue" });
  expect(snap.state).toBe("closed");
  expect(snap.events.map((e) => e.key)).toContain("c:21");
  expect(snap.events).toHaveLength(20);
});
