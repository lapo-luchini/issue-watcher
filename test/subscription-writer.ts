// Run by subscription-race.test.ts as a separate process: follows `count` items in subscription <name> of <home>
// (data/subscriptions.yaml), starting at epoch ms <start> when given, through the same locked write path as the registers.
import { rewriteFile } from "../src/core/api.ts";
import { editSubscriptions, SUBSCRIPTIONS_FILE } from "../src/core/subscriptions.ts";

const [home, name, tag, count, start] = process.argv.slice(2) as [string, string, string, string, string?];
while (start && Date.now() < Number(start)) {}
for (let i = 0; i < Number(count); i++) {
  const url = `https://lists.example.org/${tag}${i}`;
  const r = await rewriteFile({ home, branch: "config" }, SUBSCRIPTIONS_FILE, (t) => editSubscriptions(t, { kind: "follow", name, url, register: "default" }), `watcher: follow ${url} in ${name}`);
  if (!r.ok) throw new Error(r.warning); // a commit that lost a race is a failure here
}
