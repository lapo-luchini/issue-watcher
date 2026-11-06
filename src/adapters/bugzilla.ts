// Bugzilla 5.x REST (bugs.freebsd.org/bugzilla, bugs.kde.org, bugzilla.mozilla.org).
// `inst.url` is the web base (e.g. https://bugs.freebsd.org/bugzilla); the API lives under /rest.
import type { InstanceConfig } from "../core/config.ts";
import { isBot } from "../core/filter.ts";
import { defaultHttp, getJson, GoneError, HttpError, type FetchFn, type HttpDeps } from "../core/http.ts";
import type { ActorRole, Adapter, ItemRef, NormalizedEvent, Snapshot } from "../core/model.ts";
import { forgeDate, notGone, parseUrl } from "./util.ts";

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
  creation_time: string;
  last_change_time: string;
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
const MAIN_FIELDS = "summary,status,resolution,is_open,product,component,creator,assigned_to,keywords,creation_time,last_change_time";
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
  private storedLogin: string | null = null; // inst.user as Bugzilla spells it, see login()

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
   * My login as Bugzilla stores it. Email searches are case-sensitive ("lapo@freebsd.org" finds
   * nothing when the account is "lapo@FreeBSD.org"), but the user lookup is not, and it returns
   * the stored spelling. It also turns a mistyped `user` into an error instead of an empty result.
   * Looked up once per adapter; works anonymously.
   */
  private async login(): Promise<string> {
    if (this.storedLogin) return this.storedLogin;
    let users: { name: string }[];
    try {
      users = (await this.get<{ users: { name: string }[] }>(`/user?names=${encodeURIComponent(this.inst.user)}`)).users;
    } catch (err) {
      // Bugzilla answers an unknown name with HTTP 404 (error code 51).
      if (!(err instanceof GoneError)) throw err;
      users = [];
    }
    const name = users[0]?.name;
    if (!name) throw new Error(`Bugzilla has no account named '${this.inst.user}': check \`user\` in config.yaml`);
    this.storedLogin = name;
    return name;
  }

  /**
   * Two searches: bugs I reported, am assigned to, am CC'd on, am QA contact for or commented on;
   * and bugs where someone asked me for a flag (needinfo?(me), review?(me)), which does not CC
   * me. Together they cover everything, so `known` is not needed. Both work anonymously.
   */
  async discover(since: Date | null): Promise<ItemRef[]> {
    const login = await this.login();
    const criteria: Record<string, string>[] = [
      { email1: login, emailtype1: "equals",
        emailreporter1: "1", emailassigned_to1: "1", emailcc1: "1", emaillongdesc1: "1", emailqa_contact1: "1" },
      { f1: "requestees.login_name", o1: "equals", v1: login },
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
      createdAt: forgeDate(bug.creation_time),
      updatedAt: forgeDate(bug.last_change_time),
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
