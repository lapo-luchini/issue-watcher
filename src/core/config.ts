// Loads data/config.yaml (instances + filter tuning) and resolves tokens from the environment.
// Bun loads .env automatically, so tokens arrive via process.env.
import { parse } from "yaml";
import type { FilterConfig } from "./filter.ts";

export type InstanceType = "github" | "gitlab" | "forgejo" | "bugzilla";
const INSTANCE_TYPES: readonly string[] = ["github", "gitlab", "forgejo", "bugzilla"];

export interface InstanceConfig {
  id: string;
  type: InstanceType;
  url: string; // API base URL, no trailing slash
  user: string; // login (or email for Bugzilla)
  emails?: string[]; // my commit emails, to recognize my commits when the forge does not link them to `user`
  token?: string; // resolved from the env variable named by token_env
  disabledReason?: string; // set when token_env is configured but the variable is missing
}

export interface Config {
  instances: InstanceConfig[];
  filter: FilterConfig;
}

export const DEFAULT_FILTER: FilterConfig = {
  noisePatterns: ["^\\+1$", "^me too", "^same here", "^any update", "^bump$"],
  minCommentLength: 20,
  botAllowlist: [],
};

export function parseConfig(text: string, env: Record<string, string | undefined>): Config {
  // `any` here: this is untrusted YAML and every field is validated below.
  const raw: any = parse(text) ?? {};
  if (!Array.isArray(raw.instances)) throw new Error("config: 'instances' must be a list");
  const seen = new Set<string>();
  const instances = raw.instances.map((r: any, i: number): InstanceConfig => {
    const where = `config: instances[${i}]`;
    for (const k of ["id", "type", "url", "user"]) {
      if (typeof r?.[k] !== "string" || r[k] === "") throw new Error(`${where}: '${k}' is required`);
    }
    if (!INSTANCE_TYPES.includes(r.type)) throw new Error(`${where}: unknown type '${r.type}'`);
    if (seen.has(r.id)) throw new Error(`${where}: duplicate id '${r.id}'`);
    seen.add(r.id);
    const inst: InstanceConfig = { id: r.id, type: r.type, url: r.url.replace(/\/+$/, ""), user: r.user };
    if (r.emails !== undefined) {
      if (!Array.isArray(r.emails) || !r.emails.every((e: unknown) => typeof e === "string" && e !== "")) {
        throw new Error(`${where}: 'emails' must be a list of strings`);
      }
      inst.emails = r.emails;
    }
    if (r.token_env) {
      const token = env[r.token_env];
      if (token) inst.token = token;
      else inst.disabledReason = `missing ${r.token_env} in .env`;
    }
    return inst;
  });
  const f = raw.filter ?? {};
  const filter: FilterConfig = {
    noisePatterns: f.noise_patterns ?? DEFAULT_FILTER.noisePatterns,
    minCommentLength: f.min_comment_length ?? DEFAULT_FILTER.minCommentLength,
    botAllowlist: f.bot_allowlist ?? DEFAULT_FILTER.botAllowlist,
  };
  for (const p of filter.noisePatterns) {
    try {
      new RegExp(p);
    } catch {
      throw new Error(`config: invalid noise pattern '${p}'`);
    }
  }
  return { instances, filter };
}

export async function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`config file not found: ${path} (copy data/config.example.yaml)`);
  return parseConfig(await file.text(), env);
}
