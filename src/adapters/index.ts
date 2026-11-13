import type { Config, InstanceConfig } from "../core/config.ts";
import { defaultHttp, type HttpDeps } from "../core/http.ts";
import { canonicalizeIntent, type Intent } from "../core/intent.ts";
import type { Adapter, ItemRef } from "../core/model.ts";
import { BugzillaAdapter } from "./bugzilla.ts";
import { ForgejoAdapter } from "./forgejo.ts";
import { GitHubAdapter } from "./github.ts";
import { GitLabAdapter } from "./gitlab.ts";
import { RadicleAdapter } from "./radicle.ts";

/** The HTTP settings for one instance: the defaults, with its own timeout if it sets one. */
export function httpFor(inst: InstanceConfig): HttpDeps {
  return inst.timeoutMs ? { ...defaultHttp, timeoutMs: inst.timeoutMs } : defaultHttp;
}

export function createAdapter(inst: InstanceConfig): Adapter {
  const http = httpFor(inst);
  switch (inst.type) {
    case "github":
      return new GitHubAdapter(inst, http);
    case "gitlab":
      return new GitLabAdapter(inst, http);
    case "forgejo":
      return new ForgejoAdapter(inst, http);
    case "bugzilla":
      return new BugzillaAdapter(inst, http);
    case "radicle":
      return new RadicleAdapter(inst, http);
  }
}

/**
 * Returns a function that maps any item URL (also one copied from the browser) to its
 * canonical ref, using the adapters of the configured instances; null if none recognizes it.
 * An instance whose adapter cannot be created (e.g. its `url` is not a URL) is skipped here;
 * polling it reports the error.
 */
export function urlRecognizer(config: Config): (url: string) => ItemRef | null {
  const adapters: Adapter[] = [];
  for (const inst of config.instances) {
    try {
      adapters.push(createAdapter(inst));
    } catch {
      // Misconfigured instance: its URLs cannot be recognized.
    }
  }
  return (url) => {
    for (const a of adapters) {
      const ref = a.refFromUrl(url);
      if (ref) return ref;
    }
    return null;
  };
}

/** items.yaml keyed by canonical URL; `unknown` lists the non-manual URLs no instance recognizes. */
export function canonicalIntentFor(config: Config, intent: Intent, file?: string): { intent: Intent; unknown: string[] } {
  return canonicalizeIntent(intent, urlRecognizer(config), file);
}
