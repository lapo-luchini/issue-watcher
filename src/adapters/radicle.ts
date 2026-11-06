// Radicle, through a radicle-httpd node: a public seed (e.g. seed.radicle.garden) for repos I send
// patches to, or my own node for the repos it seeds. `inst.url` is the API base, e.g.
// https://seed.radicle.garden/api/v1. Read-only and public: no token.
//
// Radicle is peer-to-peer: there is no "involving me" search, no "updated since" filter, and no
// history of state, label or assignee changes (only current values). Timestamps come from each
// author's own clock. So discovery lists the open issues and patches of each watched repo on every
// poll and keeps those involving me; event keys make repeated sightings harmless.
import type { InstanceConfig } from "../core/config.ts";
import { defaultHttp, getJson, GoneError, type HttpDeps } from "../core/http.ts";
import type { ActorRole, Adapter, ItemKind, ItemRef, ItemState, KnownItem, NormalizedEvent, Snapshot } from "../core/model.ts";
import { notGone, parseUrl } from "./util.ts";

// Only the fields we use from radicle-httpd's responses.
interface RadAuthor { id: string; alias?: string }
interface RadComment { id: string; author: RadAuthor; body: string; timestamp: number }
interface RadIssue {
  id: string;
  author: RadAuthor;
  title: string;
  state: { status: string; reason?: string }; // open | closed (reason: solved, other)
  assignees: RadAuthor[];
  labels: string[];
  discussion: RadComment[]; // the first one is the issue's description
}
interface RadReview { id: string; author: RadAuthor; verdict: "accept" | "reject" | null; summary: string | null; timestamp: number }
interface RadRevision {
  id: string; // the first revision's id is the patch id
  author: RadAuthor;
  description: string;
  timestamp: number;
  discussions: RadComment[];
  reviews: RadReview[];
}
interface RadPatch {
  id: string;
  author: RadAuthor;
  title: string;
  state: { status: string }; // open | draft | archived | merged
  assignees: RadAuthor[];
  labels: string[];
  merges: { author: RadAuthor; commit: string; timestamp: number }[];
  revisions: RadRevision[];
}
interface RadRepo {
  rid: string;
  delegates: RadAuthor[];
  payloads?: { "xyz.radicle.project"?: { data?: { name?: string } } };
}
/** Repo facts needed for every item: its display name and whether I am one of its delegates. */
interface RepoFacts { name: string; delegates: Set<string>; mine: boolean }

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const API_KIND: Record<string, string> = { pr: "patches", issue: "issues" };
const VERDICTS: Record<string, string> = { accept: "approved", reject: "changes_requested" };

/** Canonical "did:key:z6Mk…" form of an identity given as a DID or a bare z6Mk… key. */
function did(id: string): string {
  return id.startsWith("did:key:") ? id : `did:key:${id}`;
}

export class RadicleAdapter implements Adapter {
  private readonly web: string; // where item links point, no trailing slash
  private readonly me: Set<string>; // my DIDs
  private readonly repoFacts = new Map<string, RepoFacts>();
  /** Items read from the listings during discover(), so fetch() needs no request for them. */
  private readonly listed = new Map<string, RadIssue | RadPatch>();

  constructor(private readonly inst: InstanceConfig, private readonly http: HttpDeps = defaultHttp) {
    // The public explorer shows any reachable node's repos; a self-hosted explorer can be configured.
    this.web = inst.web ?? `https://app.radicle.xyz/nodes/${new URL(inst.url).host}`;
    this.me = new Set((inst.users ?? [inst.user]).map(did));
  }

  private async get<T>(path: string): Promise<T> {
    return (await getJson<T>(this.inst.url + path, { accept: "application/json", "user-agent": "watcher" }, this.http)).data;
  }

  /** All pages of a list endpoint (`page` counts from 0; httpd sends no Link header). */
  private async pages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const items = await this.get<T[]>(`${path}${path.includes("?") ? "&" : "?"}page=${page}&perPage=${PAGE_SIZE}`);
      out.push(...items);
      if (items.length < PAGE_SIZE) break;
    }
    return out;
  }

  /** Accepts explorer URLs `<web>/<rid>/issues/<id>` and `/patches/<id>`, also with a revision, query or #fragment. */
  refFromUrl(url: string): ItemRef | null {
    const u = parseUrl(url);
    const base = parseUrl(this.web);
    if (!u || !base || u.origin !== base.origin) return null;
    const prefix = base.pathname.replace(/\/$/, "");
    if (!u.pathname.startsWith(prefix + "/")) return null;
    const m = u.pathname.slice(prefix.length).match(/^\/(rad:z[1-9A-HJ-NP-Za-km-z]+)\/(issues|patches)\/([0-9a-f]{40})(?:\/[0-9a-f]{40})?\/?$/);
    if (!m) return null;
    return this.ref(m[1]!, m[2] === "patches" ? "pr" : "issue", m[3]!);
  }

  private ref(rid: string, kind: ItemKind, id: string): ItemRef {
    return { url: `${this.web}/${rid}/${API_KIND[kind]}/${id}`, instance: this.inst.id, kind };
  }

  /**
   * Open issues and patches (drafts included) of every watched repo that involve me, or all of
   * them in repos I maintain; plus known items still open in the cache but no longer listed as
   * open (closed, merged or archived since). `since` is not used: there is no reliable clock.
   */
  async discover(_since: Date | null, known: KnownItem[]): Promise<ItemRef[]> {
    const refs = new Map<string, ItemRef>();
    for (const rid of await this.watchedRepos()) {
      const facts = await this.facts(rid, true);
      const issues = await this.pages<RadIssue>(`/repos/${rid}/issues?status=open`);
      const patches = [
        ...await this.pages<RadPatch>(`/repos/${rid}/patches?status=open`),
        ...await this.pages<RadPatch>(`/repos/${rid}/patches?status=draft`),
      ];
      for (const [kind, items] of [["issue", issues], ["pr", patches]] as [ItemKind, (RadIssue | RadPatch)[]][]) {
        for (const item of items) {
          const ref = this.ref(rid, kind, item.id);
          this.listed.set(ref.url, item);
          if (facts.mine || this.involvesMe(item)) refs.set(ref.url, ref);
        }
      }
    }
    for (const k of known) {
      // Every item known as open is checked again: one still listed costs nothing (it may no
      // longer involve me, e.g. added by hand or unassigned, but I still follow it); one no
      // longer listed as open costs a request and shows what became of it.
      // (A URL under an old `web` base no longer parses: skip it.)
      const ref = k.state === "open" ? this.refFromUrl(k.url) : null;
      if (ref) refs.set(ref.url, ref);
    }
    return [...refs.values()];
  }

  private async watchedRepos(): Promise<string[]> {
    if (this.inst.repos) return this.inst.repos;
    // My own node: every repo it seeds. The listing already has each repo's delegates and
    // name, so their facts need no request of their own.
    const repos = await this.pages<RadRepo>("/repos?show=all");
    for (const r of repos) if (!this.repoFacts.has(r.rid)) this.repoFacts.set(r.rid, this.toFacts(r));
    return repos.map((r) => r.rid);
  }

  private toFacts(repo: RadRepo): RepoFacts {
    const delegates = new Set(repo.delegates.map((d) => d.id));
    return {
      name: repo.payloads?.["xyz.radicle.project"]?.data?.name ?? repo.rid,
      delegates,
      mine: [...delegates].some((d) => this.me.has(d)),
    };
  }

  /** Name and delegates of a repo, cached. In discovery a missing repo is a configuration error. */
  private async facts(rid: string, discovering = false): Promise<RepoFacts> {
    let facts = this.repoFacts.get(rid);
    if (!facts) {
      let repo: RadRepo;
      try {
        repo = await this.get<RadRepo>(`/repos/${rid}`);
      } catch (err) {
        if (discovering && err instanceof GoneError) throw new Error(`Radicle repo ${rid} not found on ${this.inst.url}: is it seeded there?`);
        throw err;
      }
      facts = this.toFacts({ ...repo, rid });
      this.repoFacts.set(rid, facts);
    }
    return facts;
  }

  /** Authored, assigned, commented on, or (patches) a revision or review of mine. */
  private involvesMe(item: RadIssue | RadPatch): boolean {
    const ids = [item.author.id, ...item.assignees.map((a) => a.id)];
    if ("discussion" in item) ids.push(...item.discussion.map((c) => c.author.id));
    else {
      for (const r of item.revisions) {
        ids.push(r.author.id, ...r.discussions.map((c) => c.author.id), ...r.reviews.map((v) => v.author.id));
      }
    }
    return ids.some((id) => this.me.has(id));
  }

  async fetch(ref: ItemRef): Promise<Snapshot> {
    const m = ref.url.slice(this.web.length).match(/^\/(rad:[^/]+)\/(issues|patches)\/([0-9a-f]{40})$/);
    if (!m) throw new Error(`not a Radicle item URL: ${ref.url}`);
    const [, rid, kind, id] = m as unknown as [string, string, string, string];
    // A 404 on the item itself (GoneError) means it is gone; on the repo it is an ordinary failure.
    const item = this.listed.get(ref.url) ?? await this.get<RadIssue | RadPatch>(`/repos/${rid}/${kind}/${id}`);
    const facts = await notGone(this.facts(rid));
    const role = (a: RadAuthor | null): ActorRole =>
      !a ? "unknown" : this.me.has(a.id) ? "me" : facts.delegates.has(a.id) ? "maintainer" : "contributor";
    const name = (a: RadAuthor) => a.alias ?? a.id.replace(/^did:key:/, "");
    const by = (a: RadAuthor, t: number) => ({ actor: name(a), actorRole: role(a), at: new Date(t * 1000) });

    const events: NormalizedEvent[] = [];
    const comment = (c: RadComment) => events.push({ ...by(c.author, c.timestamp), key: `c:${c.id}`, kind: "comment", body: c.body });
    let state: ItemState;
    let stateDetail: string | undefined;
    if ("discussion" in item) {
      item.discussion.forEach(comment);
      state = item.state.status === "open" ? "open" : "closed";
      stateDetail = item.state.reason;
    } else {
      item.revisions.forEach((r) => {
        // Every revision is a push by its author (the first one opens the patch).
        events.push({ ...by(r.author, r.timestamp), key: `rev:${r.id}`, kind: "push",
          details: { message: r.description.split("\n")[0] || item.title } });
        r.discussions.forEach(comment);
        for (const v of r.reviews) {
          events.push({ ...by(v.author, v.timestamp), key: `r:${v.id}`, kind: "review", body: v.summary ?? "",
            details: { state: VERDICTS[v.verdict ?? ""] ?? "commented" } });
        }
      });
      for (const mg of item.merges) {
        events.push({ ...by(mg.author, mg.timestamp), key: `m:${mg.commit}`, kind: "state", details: { to: "merged" } });
      }
      const s = item.state.status;
      state = s === "merged" ? "merged" : s === "archived" ? "closed" : "open";
      stateDetail = s === "draft" || s === "archived" ? s : undefined;
    }
    // No history of state or assignee changes: an event when a closed/archived state is seen,
    // and one when I first appear among the assignees, timed by the item's latest activity.
    // The state key counts the activity so far, so closing again after a reopen and some new
    // activity is reported again (a reopen and re-close with nothing in between is not).
    const latest = new Date(Math.max(0, ...events.map((e) => e.at.getTime())));
    // No dates of its own either: it was created by its first comment or revision, and last
    // updated by its latest event (author clocks, see timesUnreliable).
    const first = "discussion" in item ? item.discussion[0] : item.revisions[0];
    const createdAt = first ? new Date(first.timestamp * 1000) : null;
    const updatedAt = events.length > 0 ? latest : null;
    const anon = { actor: "", actorRole: "unknown" as const, at: latest };
    const closedAs = "discussion" in item ? (item.state.status === "closed" ? "closed" : null)
      : item.state.status === "archived" ? "archived" : null;
    if (closedAs) events.push({ ...anon, key: `s:${closedAs}:${events.length}`, kind: "state", details: { to: closedAs } });
    if (item.assignees.some((a) => this.me.has(a.id))) events.push({ ...anon, key: "a:me", kind: "assign" });

    return {
      ref,
      repo: facts.name,
      title: item.title,
      state,
      stateDetail,
      ciState: null,
      authoredByMe: this.me.has(item.author.id),
      maintainedByMe: facts.mine,
      // Author clocks, and items that reach the node late by gossip.
      timesUnreliable: true,
      labels: item.labels,
      createdAt,
      updatedAt,
      events,
    };
  }
}
