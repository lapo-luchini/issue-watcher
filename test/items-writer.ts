// Run by api-write-race.test.ts as a separate process: makes `count` note changes to items.yaml of <home>,
// starting at epoch ms <start> when given (so several writers begin together).
import { changeIntent } from "../src/core/api.ts";

const [home, tag, count, start] = process.argv.slice(2) as [string, string, string, string?];
while (start && Date.now() < Number(start)) {}
for (let i = 0; i < Number(count); i++) {
  await changeIntent({ home, branch: "config" }, `https://lists.example.org/${tag}${i}`, { note: `n-${tag}${i}` }, (u) => u);
}
