// Radicle adapter against a fake radicle-httpd: responses are minimal, sanitized shapes of real
// seed.radicle.garden payloads (API v1). DIDs are shortened fakes.
import { expect, test } from "bun:test";
import { RadicleAdapter } from "../src/adapters/radicle.ts";
import type { InstanceConfig } from "../src/core/config.ts";
import { GoneError, HttpError } from "../src/core/http.ts";
import type { ItemRef, KnownItem } from "../src/core/model.ts";
import { expectAdapterContract } from "./contract.ts";
import { fakeApi, type Route } from "./fake-http.ts";

const API = "https://seed.example.org/api/v1";
const WEB = "https://app.radicle.xyz/nodes/seed.example.org";
const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const MINE = "rad:z4MineRepo";
const ME = "did:key:z6MkMeLaptop";
const ME2 = "did:key:z6MkMeDesktop";
const DELEGATE = "did:key:z6MkLorenz";
const OTHER = "did:key:z6MkAlice";
const inst: InstanceConfig = {
  id: "rad", type: "radicle", url: API, user: ME, users: [ME, ME2], emails: [], repos: [RID],
};

function fake(routes: Record<string, Route>, extra: Partial<InstanceConfig> = {}) {
  const api = fakeApi(API, routes);
  return { ...api, adapter: new RadicleAdapter({ ...inst, ...extra }, api.http) };
}

const who = (id: string, alias?: string) => (alias ? { id, alias } : { id });
const hex = (c: string) => c.repeat(40);
const ISSUE_ID = hex("1");
const PATCH_ID = hex("2");
const ISSUE = `${WEB}/${RID}/issues/${ISSUE_ID}`;
const PATCH = `${WEB}/${RID}/patches/${PATCH_ID}`;
const issueRef: ItemRef = { url: ISSUE, instance: "rad", kind: "issue" };
const patchRef: ItemRef = { url: PATCH, instance: "rad", kind: "pr" };
const T = 1786000000; // seconds, as httpd reports them

const comment = (id: string, author: string, alias: string, body: string, t: number) =>
  ({ id, author: who(author, alias), body, edits: [], embeds: [], reactions: [], timestamp: t, replyTo: null, resolved: false });

const repoInfo = (delegates: string[], name = "heartwood") => ({
  payloads: { "xyz.radicle.project": { data: { name, defaultBranch: "master" }, meta: {} } },
  delegates: delegates.map((d) => who(d)), threshold: 1, visibility: { type: "public" }, rid: RID,
});

const issue = {
  id: ISSUE_ID, author: who(ME2, "lapo-nix"), title: "git-remote-rad should support --signed=if-asked",
  state: { status: "closed", reason: "solved" }, assignees: [who(ME, "lapo")], labels: ["bug"],
  discussion: [
    comment(ISSUE_ID, ME2, "lapo-nix", "I use --signed=if-asked and pushing fails.", T),
    comment(hex("a"), DELEGATE, "lorenz", "Fixed in commit 3da781f.", T + 60),
    comment(hex("b"), OTHER, "alice", "+1", T + 120),
  ],
};

const patch = {
  id: PATCH_ID, author: who(ME, "lapo"), title: "Add OS info to rad debug", target: "delegates", labels: [],
  state: { status: "merged", revision: hex("4"), commit: hex("c") },
  assignees: [],
  merges: [{ author: who(DELEGATE, "lorenz"), commit: hex("c"), timestamp: T + 900, revision: hex("4") }],
  revisions: [
    { id: PATCH_ID, author: who(ME, "lapo"), description: "Adds the OS name.\n\nDetails…", base: hex("0"), oid: hex("5"),
      refs: [], edits: [], reactions: [], timestamp: T,
      discussions: [comment(hex("d"), OTHER, "alice", "Looks ready for a formal review to me.", T + 100)],
      reviews: [] },
    { id: hex("4"), author: who(ME, "lapo"), description: "Rebase on master", base: hex("0"), oid: hex("6"),
      refs: [], edits: [], reactions: [], timestamp: T + 300, discussions: [],
      reviews: [
        { id: hex("e"), author: who(DELEGATE, "lorenz"), verdict: "accept", summary: "Makes sense", comments: [], timestamp: T + 600 },
        { id: hex("f"), author: who(OTHER, "alice"), verdict: null, summary: "", comments: [], timestamp: T + 700 },
      ] },
  ],
};

const listings = (rid: string, issues: unknown[], open: unknown[], draft: unknown[] = []) => ({
  [`/repos/${rid}/issues?status=open&page=0&perPage=100`]: issues,
  [`/repos/${rid}/patches?status=open&page=0&perPage=100`]: open,
  [`/repos/${rid}/patches?status=draft&page=0&perPage=100`]: draft,
});

const itemRoutes: Record<string, Route> = {
  [`/repos/${RID}`]: repoInfo([DELEGATE]),
  [`/repos/${RID}/issues/${ISSUE_ID}`]: issue,
  [`/repos/${RID}/patches/${PATCH_ID}`]: patch,
};

test("refFromUrl accepts this node's issue and patch URLs from the web UI", () => {
  const { adapter } = fake({});
  expect(adapter.refFromUrl(ISSUE)).toEqual(issueRef);
  expect(adapter.refFromUrl(PATCH)).toEqual(patchRef);
  for (const u of [`${PATCH}/`, `${PATCH}?tab=changes`, `${PATCH}#comment`, `${PATCH}/${hex("4")}`]) {
    expect(adapter.refFromUrl(u)?.url).toBe(PATCH);
  }
  for (const u of [
    `https://app.radicle.xyz/nodes/other.example/${RID}/issues/${ISSUE_ID}`, // another node: another instance
    `${WEB}/${RID}/issues/123`, `${WEB}/${RID}`, `${WEB}/not-a-rid/issues/${ISSUE_ID}`, "nope",
  ]) {
    expect(adapter.refFromUrl(u)).toBeNull();
  }
});

test("the web base can be configured, e.g. for a self-hosted explorer", () => {
  const { adapter } = fake({}, { web: "https://radicle.example.net" });
  expect(adapter.refFromUrl(`https://radicle.example.net/${RID}/issues/${ISSUE_ID}`)?.url)
    .toBe(`https://radicle.example.net/${RID}/issues/${ISSUE_ID}`);
});

test("fetch normalizes an issue: comments, closed state, assignment, roles of all my identities", async () => {
  const snap = await fake(itemRoutes).adapter.fetch(issueRef);
  expect(snap).toMatchObject({
    repo: "heartwood", title: "git-remote-rad should support --signed=if-asked", state: "closed", stateDetail: "solved",
    authoredByMe: true, maintainedByMe: false, labels: ["bug"], ciState: null,
  });
  const byKey = Object.fromEntries(snap.events.map((e) => [e.key, e]));
  expect(Object.keys(byKey).sort()).toEqual(["a:me", `c:${hex("a")}`, `c:${hex("b")}`, `c:${ISSUE_ID}`, "s:closed"].sort());
  expect(byKey[`c:${ISSUE_ID}`]).toMatchObject({ kind: "comment", actor: "lapo-nix", actorRole: "me" }); // second identity
  expect(byKey[`c:${ISSUE_ID}`]?.at.toISOString()).toBe(new Date(T * 1000).toISOString());
  expect(byKey[`c:${hex("a")}`]).toMatchObject({ actor: "lorenz", actorRole: "maintainer", body: "Fixed in commit 3da781f." });
  expect(byKey[`c:${hex("b")}`]).toMatchObject({ actor: "alice", actorRole: "contributor" });
  // No history of state changes: one event per state, timed by the latest activity.
  expect(byKey["s:closed"]).toMatchObject({ kind: "state", actor: "", actorRole: "unknown", details: { to: "closed" } });
  expect(byKey["s:closed"]?.at.toISOString()).toBe(new Date((T + 120) * 1000).toISOString());
  expect(byKey["a:me"]).toMatchObject({ kind: "assign", actorRole: "unknown" });
});

test("fetch normalizes a patch: revisions as pushes, comments, reviews, merge", async () => {
  const snap = await fake(itemRoutes).adapter.fetch(patchRef);
  expect(snap).toMatchObject({ state: "merged", authoredByMe: true, maintainedByMe: false, repo: "heartwood" });
  const byKey = Object.fromEntries(snap.events.map((e) => [e.key, e]));
  expect(Object.keys(byKey).sort()).toEqual([
    `c:${hex("d")}`, `m:${hex("c")}`, `r:${hex("e")}`, `r:${hex("f")}`, `rev:${hex("4")}`, `rev:${PATCH_ID}`,
  ].sort());
  expect(byKey[`rev:${PATCH_ID}`]).toMatchObject({ kind: "push", actorRole: "me", details: { message: "Adds the OS name." } });
  expect(byKey[`rev:${hex("4")}`]).toMatchObject({ kind: "push", actorRole: "me", details: { message: "Rebase on master" } });
  expect(byKey[`r:${hex("e")}`]).toMatchObject({
    kind: "review", actor: "lorenz", actorRole: "maintainer", body: "Makes sense", details: { state: "approved" },
  });
  expect(byKey[`r:${hex("f")}`]?.details).toEqual({ state: "commented" });
  expect(byKey[`m:${hex("c")}`]).toMatchObject({ kind: "state", actor: "lorenz", actorRole: "maintainer", details: { to: "merged" } });
  expect(byKey[`m:${hex("c")}`]?.at.toISOString()).toBe(new Date((T + 900) * 1000).toISOString());
});

test("patch states: draft is open, archived is closed; a rejected review asks for changes", async () => {
  const draft = { ...patch, state: { status: "draft" }, merges: [] };
  const archived = {
    ...patch, state: { status: "archived" }, merges: [],
    revisions: [{ ...patch.revisions[0]!, reviews: [{ id: hex("9"), author: who(DELEGATE), verdict: "reject", summary: "No", comments: [], timestamp: T }] }],
  };
  const d = await fake({ ...itemRoutes, [`/repos/${RID}/patches/${PATCH_ID}`]: draft }).adapter.fetch(patchRef);
  expect(d).toMatchObject({ state: "open", stateDetail: "draft" });
  expect(d.events.some((e) => e.kind === "state")).toBe(false);
  const a = await fake({ ...itemRoutes, [`/repos/${RID}/patches/${PATCH_ID}`]: archived }).adapter.fetch(patchRef);
  expect(a).toMatchObject({ state: "closed", stateDetail: "archived" });
  expect(a.events.find((e) => e.key === "s:archived")?.details).toEqual({ to: "archived" });
  // A reviewer without an alias is shown by a short form of their DID.
  expect(a.events.find((e) => e.key === `r:${hex("9")}`)).toMatchObject({ actor: "z6MkLorenz", details: { state: "changes_requested" } });
});

test("on a repo I maintain, incoming patches are mine to look at", async () => {
  const theirs = { ...patch, author: who(OTHER, "alice"), revisions: [{ ...patch.revisions[0]!, author: who(OTHER, "alice") }] };
  const snap = await fake({
    [`/repos/${RID}`]: repoInfo([ME2]), // I am a delegate, under my other identity
    [`/repos/${RID}/patches/${PATCH_ID}`]: theirs,
  }).adapter.fetch(patchRef);
  expect(snap).toMatchObject({ authoredByMe: false, maintainedByMe: true });
  expect(snap.events.find((e) => e.key === `rev:${PATCH_ID}`)).toMatchObject({ actor: "alice", actorRole: "contributor" });
});

test("adapter contract", async () => {
  await expectAdapterContract(fake(itemRoutes).adapter, issueRef);
  await expectAdapterContract(fake(itemRoutes).adapter, patchRef);
});

test("discover: open items involving me in the configured repos, every item in repos I maintain", async () => {
  const notMine = { ...issue, id: hex("3"), author: who(OTHER), assignees: [], discussion: [comment(hex("3"), OTHER, "alice", "Unrelated", T)] };
  const commented = { ...notMine, id: hex("5"), discussion: [...notMine.discussion, comment(hex("6"), ME, "lapo", "Same here, on FreeBSD 14.", T)] };
  const reviewed = {
    ...patch, id: hex("7"), author: who(OTHER), state: { status: "open" }, merges: [],
    revisions: [{ ...patch.revisions[1]!, author: who(OTHER), reviews: [{ ...patch.revisions[1]!.reviews[0]!, author: who(ME) }] }],
  };
  const foreignDraft = { ...reviewed, id: hex("8"), revisions: [{ ...reviewed.revisions[0]!, reviews: [] }] };
  const incoming = { ...foreignDraft, id: hex("9") };
  const { adapter, calls } = fake({
    [`/repos/${RID}`]: repoInfo([DELEGATE]),
    ...listings(RID, [notMine, commented], [reviewed], [foreignDraft]),
    [`/repos/${MINE}`]: repoInfo([ME]),
    ...listings(MINE, [], [incoming]),
  }, { repos: [RID, MINE] });
  const refs = await adapter.discover(null, []);
  expect(refs.map((r) => [r.url, r.kind])).toEqual([
    [`${WEB}/${RID}/issues/${hex("5")}`, "issue"],
    [`${WEB}/${RID}/patches/${hex("7")}`, "pr"],
    [`${WEB}/${MINE}/patches/${hex("9")}`, "pr"],
  ]);
  // Listings already hold the whole item: fetching a discovered item costs no request.
  const before = calls.length;
  expect((await adapter.fetch(refs[0]!)).title).toBe(notMine.title);
  expect(calls.length).toBe(before);
});

test("discover: known items no longer listed as open are re-checked; closed ones are not", async () => {
  const known: KnownItem[] = [
    { ...issueRef, state: "open" }, // closed since: not in the open listing any more
    { ...patchRef, state: "merged" }, // already closed in the cache: left alone
    { url: `https://elsewhere.example/${RID}/issues/${ISSUE_ID}`, instance: "rad", kind: "issue", state: "open" }, // old web base
  ];
  const { adapter, calls } = fake({ [`/repos/${RID}`]: repoInfo([DELEGATE]), ...listings(RID, [], []) });
  // The cursor plays no part: Radicle timestamps come from the authors' clocks.
  expect(await adapter.discover(new Date("2026-11-04T10:00:00Z"), known)).toEqual([issueRef]);
  expect(calls.filter((c) => c.includes("status="))).toHaveLength(3);
});

test("discover without a repos list watches every repo the node seeds", async () => {
  const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ rid: `rad:z${n}x${i}` }));
  const routes: Record<string, Route> = {
    "/repos?show=all&page=0&perPage=100": page(0, 100),
    "/repos?show=all&page=1&perPage=100": page(1, 1),
  };
  for (const r of [...page(0, 100), ...page(1, 1)]) {
    routes[`/repos/${r.rid}`] = repoInfo([DELEGATE]);
    Object.assign(routes, listings(r.rid, [], []));
  }
  const { adapter } = fake(routes, { repos: undefined });
  expect(await adapter.discover(null, [])).toEqual([]);
});

test("a configured repo the node does not have is an error, not silence", async () => {
  const { adapter } = fake({ [`/repos/${RID}`]: 404 });
  await expect(adapter.discover(null, [])).rejects.toThrow(`Radicle repo ${RID} not found on ${API}`);
});

test("only a 404 on the item itself means gone", async () => {
  const gone = await fake({ [`/repos/${RID}/issues/${ISSUE_ID}`]: 404 }).adapter.fetch(issueRef).catch((e) => e);
  expect(gone).toBeInstanceOf(GoneError);
  const sub = await fake({ [`/repos/${RID}/issues/${ISSUE_ID}`]: issue, [`/repos/${RID}`]: 404 }).adapter.fetch(issueRef).catch((e) => e);
  expect(sub).toBeInstanceOf(HttpError);
  expect(sub).not.toBeInstanceOf(GoneError);
});

test("bare z6Mk identities work like did:key ones", async () => {
  const snap = await fake(itemRoutes, { user: "z6MkMeLaptop", users: ["z6MkMeLaptop", "z6MkMeDesktop"] }).adapter.fetch(issueRef);
  expect(snap.authoredByMe).toBe(true);
});
