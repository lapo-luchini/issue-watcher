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
