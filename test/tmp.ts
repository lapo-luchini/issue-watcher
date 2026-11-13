import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/** A fresh temp dir that `cleanupTmp` removes; call `afterEach(cleanupTmp)` in each test file that uses it. */
export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `watcher-${prefix}-`));
  made.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
