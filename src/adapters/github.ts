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
