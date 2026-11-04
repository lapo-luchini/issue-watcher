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
