// One-line human summary of an event, used for "latest signal" in lists.
import type { EventRow } from "./store.ts";

const oneLine = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

export function summarize(e: Pick<EventRow, "kind" | "actor" | "excerpt" | "details">): string {
  const by = e.actor ? ` by @${e.actor}` : "";
  const d = e.details ?? {};
  const sign = d.action === "removed" ? "-" : "+";
  switch (e.kind) {
    case "comment":
      return `comment${by}: ${oneLine(e.excerpt)}`;
    case "review":
      return `review (${d.state ?? "?"})${by}` + (e.excerpt ? `: ${oneLine(e.excerpt)}` : "");
    case "state":
      return `→ ${d.to}${by}`;
    case "label":
      return `label ${sign}${d.label}${by}`;
    case "milestone":
      return `milestone ${sign}${d.milestone}${by}`;
    case "ci":
      return `CI → ${d.to}`;
    case "conflict":
      return "merge conflict";
    case "push":
      return `push${by}` + (d.message ? `: ${d.message}` : "");
    case "flag":
      return `flag ${sign}${d.flag}${by}`;
    case "attachment":
      return `attachment ${d.action ?? "added"}${by}` + (d.summary ? `: ${oneLine(String(d.summary))}` : "");
    case "assign":
      return `assign${d.to ? ` → ${d.to}` : ""}${by}`;
    default:
      return `${e.kind.replace("_", " ")}${by}`;
  }
}
