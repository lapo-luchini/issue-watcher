import type { InstanceConfig } from "../core/config.ts";
import type { Adapter } from "../core/model.ts";
import { GitHubAdapter } from "./github.ts";

export function createAdapter(inst: InstanceConfig): Adapter {
  switch (inst.type) {
    case "github":
      return new GitHubAdapter(inst);
    default:
      throw new Error(`no adapter for type '${inst.type}' yet`);
  }
}
