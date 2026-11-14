// Loads data/config.yaml (instances + filter tuning) and resolves tokens from the environment.
// Bun loads .env automatically, so tokens arrive via process.env.
import { parse } from "yaml";
import type { FilterConfig } from "./filter.ts";

export type InstanceType = "github" | "gitlab" | "forgejo" | "bugzilla" | "radicle";
const INSTANCE_TYPES: readonly string[] = ["github", "gitlab", "forgejo", "bugzilla", "radicle"];

export interface InstanceConfig {
  id: string;
  type: InstanceType;
  url: string; // API base URL, no trailing slash
  user: string; // login (or email for Bugzilla, DID for Radicle); the first one if `user` is a list
  // Radicle only: all my identities when `user` is a list (e.g. one DID per machine).
  users?: string[];
  // Radicle only: the repos (rad:…) to watch; absent means every repo the node seeds.
  repos?: string[];
  // Radicle only: web base for item links, no trailing slash (default: app.radicle.xyz for the node).
  web?: string;
  // My commit emails, to recognize my commits when the forge does not link them to `user`:
  // the instance's own `emails` list if it has one, else the top-level `emails` list, else [].
  emails: string[];
  // Bugzilla only: email domains of the project's committers (e.g. freebsd.org), whose
  // comments count as a maintainer's. Lowercase; absent means none.
  maintainerDomains?: string[];
  // Per-request timeout, from `timeout` (seconds); absent means the default (30 s). For forges
  // whose searches are slow, e.g. Codeberg's issue search, which can take well over 30 s when busy.
  timeoutMs?: number;
  token?: string; // resolved from the env variable named by token_env
  disabledReason?: string; // set when token_env is configured but the variable is missing
}

export interface Config {
  instances: InstanceConfig[];
  filter: FilterConfig;
  // The branch changes to items.yaml are committed to, which can stay local while the code is published.
  commitBranch: string;
  // MCP server: true (the default) lists and accepts only the tools that read; see `mcp.read_only`.
  mcpReadOnly: boolean;
  // A program (and its arguments) run after every poll that saves, see core/hook.ts; absent: none.
  afterPoll?: string[];
}

export const DEFAULT_FILTER: FilterConfig = {
  noisePatterns: ["^\\+1$", "^me too", "^same here", "^any update", "^bump$"],
  minCommentLength: 20,
  botAllowlist: [],
};

/** Validates an optional list-of-strings key from the YAML; undefined when it is absent. */
function stringList(value: unknown, where: string, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((e) => typeof e === "string" && e !== "")) {
    throw new Error(`${where}: '${key}' must be a list of strings`);
  }
  return value;
}

export function parseConfig(text: string, env: Record<string, string | undefined>): Config {
  // `any` here: this is untrusted YAML and every field is validated below.
  const raw: any = parse(text) ?? {};
  if (!Array.isArray(raw.instances)) throw new Error("config: 'instances' must be a list");
  const defaultEmails = stringList(raw.emails, "config", "emails") ?? [];
  const seen = new Set<string>();
  const instances = raw.instances.map((r: any, i: number): InstanceConfig => {
    const where = `config: instances[${i}]`;
    for (const k of ["id", "type", "url"]) {
      if (typeof r?.[k] !== "string" || r[k] === "") throw new Error(`${where}: '${k}' is required`);
    }
    if (!INSTANCE_TYPES.includes(r.type)) throw new Error(`${where}: unknown type '${r.type}'`);
    if (seen.has(r.id)) throw new Error(`${where}: duplicate id '${r.id}'`);
    seen.add(r.id);
    // `user` is one login, or (Radicle, where each machine may have its own identity) a list.
    const users = typeof r?.user === "string" && r.user !== "" ? [r.user]
      : r.type === "radicle" && Array.isArray(r?.user) && r.user.length > 0 ? stringList(r.user, where, "user")!
      : undefined;
    if (!users) throw new Error(`${where}: 'user' is required` + (r.type === "radicle" ? " (one identity or a list)" : ""));
    const inst: InstanceConfig = {
      id: r.id, type: r.type, url: r.url.replace(/\/+$/, ""), user: users[0]!,
      emails: stringList(r.emails, where, "emails") ?? defaultEmails,
    };
    if (users.length > 1) inst.users = users;
    const domains = stringList(r.maintainer_domains, where, "maintainer_domains");
    if (domains) inst.maintainerDomains = domains.map((d) => d.toLowerCase().replace(/^@/, ""));
    if (r.type !== "radicle" && (r.repos !== undefined || r.web !== undefined)) {
      throw new Error(`${where}: 'repos' and 'web' are for radicle instances only`);
    }
    if (r.type === "radicle") {
      const bad = users.find((u) => !/^(did:key:)?z6Mk[1-9A-HJ-NP-Za-km-z]+$/.test(u));
      if (bad) throw new Error(`${where}: '${bad}' is not a Radicle identity (did:key:z6Mk… or z6Mk…)`);
    }
    const repos = stringList(r.repos, where, "repos");
    if (repos) {
      if (repos.length === 0) throw new Error(`${where}: 'repos' is empty: leave it out to watch every repo the node seeds`);
      const bad = repos.find((x) => !/^rad:z[1-9A-HJ-NP-Za-km-z]+$/.test(x));
      if (bad) throw new Error(`${where}: '${bad}' is not a Radicle repo id (rad:z…)`);
      inst.repos = repos;
    }
    if (r.web !== undefined) {
      if (typeof r.web !== "string" || !URL.canParse(r.web) || !/^https?:$/.test(new URL(r.web).protocol)) {
        throw new Error(`${where}: 'web' must be an http(s) URL`);
      }
      inst.web = r.web.replace(/\/+$/, "");
    }
    if (r.timeout !== undefined) {
      if (typeof r.timeout !== "number" || !(r.timeout > 0)) throw new Error(`${where}: 'timeout' must be a number of seconds`);
      inst.timeoutMs = Math.round(r.timeout * 1000);
    }
    if (r.token_env) {
      const token = env[r.token_env];
      if (token) inst.token = token;
      else inst.disabledReason = `missing ${r.token_env} in .env`;
    }
    return inst;
  });
  const f = raw.filter ?? {};
  if (typeof f !== "object" || Array.isArray(f)) throw new Error("config: 'filter' must be a mapping");
  const min = f.min_comment_length ?? DEFAULT_FILTER.minCommentLength;
  if (!Number.isInteger(min) || min < 0) throw new Error("config: filter: 'min_comment_length' must be a number of characters");
  const filter: FilterConfig = {
    noisePatterns: stringList(f.noise_patterns, "config: filter", "noise_patterns") ?? DEFAULT_FILTER.noisePatterns,
    minCommentLength: min,
    botAllowlist: stringList(f.bot_allowlist, "config: filter", "bot_allowlist") ?? DEFAULT_FILTER.botAllowlist,
  };
  for (const p of filter.noisePatterns) {
    try {
      new RegExp(p);
    } catch {
      throw new Error(`config: invalid noise pattern '${p}'`);
    }
  }
  const commitBranch = raw.commit_branch ?? "config";
  // A plain branch name, as git accepts them (no leading "-", "..", spaces, ".lock" end…).
  if (typeof commitBranch !== "string" || !/^(?!-)(?!.*\.\.)(?!.*\/\/)[\w.\/-]+(?<![./]|\.lock)$/.test(commitBranch)) {
    throw new Error("config: 'commit_branch' must be a branch name");
  }
  const mcp = raw.mcp ?? {};
  if (typeof mcp !== "object" || Array.isArray(mcp)) throw new Error("config: 'mcp' must be a mapping");
  // Read-only unless explicitly turned off: only a real boolean `false` allows the write tools.
  if (mcp.read_only !== undefined && typeof mcp.read_only !== "boolean") throw new Error("config: mcp: 'read_only' must be true or false");
  const afterPoll = stringList(raw.after_poll, "config", "after_poll");
  if (afterPoll?.length === 0) throw new Error("config: 'after_poll' must be a list of strings");
  return { instances, filter, commitBranch, mcpReadOnly: mcp.read_only ?? true, ...(afterPoll ? { afterPoll } : {}) };
}

export async function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`config file not found: ${path} (copy data/config.example.yaml)`);
  return parseConfig(await file.text(), env);
}
