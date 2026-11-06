// GitLab (gitlab.com or self-hosted, e.g. invent.kde.org), via its /api/v4 base URL.
import type { InstanceConfig } from "../core/config.ts";
import { defaultHttp, getAllPages, getJson, type HttpDeps } from "../core/http.ts";
import type { ActorRole, Adapter, CiState, ItemKind, ItemRef, ItemState, NormalizedEvent, Snapshot } from "../core/model.ts";
import { forgeDate, mentions, notGone, optional, parseUrl } from "./util.ts";

// Only the fields we use from GitLab's REST responses.
interface GlUser { id: number; username: string; bot?: boolean }
interface GlItem {
  title: string;
  state: "opened" | "closed" | "merged" | "locked";
  author: GlUser | null;
  labels: string[];
  created_at: string;
  updated_at: string;
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
      createdAt: forgeDate(item.created_at),
      updatedAt: forgeDate(item.updated_at),
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
