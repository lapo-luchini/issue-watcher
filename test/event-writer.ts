// Run by subscription-race.test.ts as a separate process: stores `count` events of item <url> in the cache at <path>,
// keys <tag>0, <tag>1, …, one statement each, as the poll does.
import { Store } from "../src/core/store.ts";

const [path, url, tag, count] = process.argv.slice(2) as [string, string, string, string];
const store = new Store(path);
for (let i = 0; i < Number(count); i++) {
  store.insertEvent({
    itemUrl: url, key: `${tag}${i}`, kind: "comment", actor: "maint", actorRole: "maintainer", at: "2026-11-04T09:00:00.000Z",
    detectedAt: "2026-11-04T10:00:00.000Z", excerpt: `${tag}${i}`, details: null, isSignal: true, reason: "signal:comment", isBaseline: false,
  });
}
store.close();
