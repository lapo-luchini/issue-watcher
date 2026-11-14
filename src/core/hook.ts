// The `after_poll` hook of data/config.yaml: a program (argv list, never a shell line) run once a poll is done,
// so something outside the watcher (a notifier) can look at the news.

export const HOOK_TIMEOUT_MS = 60_000;

/**
 * Runs the hook in the watcher's directory with WATCHER_HOME set. Its output is dropped (stdout may be an MCP protocol
 * stream) and a hook that does not end in time is killed. It never throws: the poll is done and saved either way, so a
 * failure comes back as a line for the caller to show, null when it ran well or there is none.
 */
export async function runAfterPoll(argv: string[] | undefined, home: string, timeoutMs = HOOK_TIMEOUT_MS): Promise<string | null> {
  if (!argv) return null;
  try {
    const proc = Bun.spawn(argv, { cwd: home, env: { ...process.env, WATCHER_HOME: home }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve("timeout");
      }, timeoutMs);
    });
    const outcome = await Promise.race([proc.exited, stopped]);
    clearTimeout(timer);
    if (outcome === "timeout") return `after_poll did not finish in ${timeoutMs / 1000} s: stopped`;
    return outcome === 0 ? null : `after_poll exited with ${outcome}`;
  } catch (err) {
    return `after_poll could not start: ${(err as Error).message}`;
  }
}
