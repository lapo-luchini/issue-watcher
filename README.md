# watcher

Tracks the PRs, issues and bugs you are involved in across forges, and shows only meaningful
activity: reviews, maintainer comments, state changes, CI results. It ignores "+1"s, emoji, bots
and "any update?" pings. Design: `docs/superpowers/specs/2026-11-04-pr-watcher-design.md`.

## Setup

Requires [Bun](https://bun.sh) ≥ 1.4 (Linux or FreeBSD).

```sh
bun install
cp data/config.example.yaml data/config.yaml   # set your logins, then commit it (no secrets inside)
cp .env.example .env                           # put your tokens here (git-ignored)
bun run watcher poll --dry-run                 # check instances and tokens; saves nothing
bun run watcher poll                           # first real run: records history as baseline
```

### GitHub token

Use a **classic** personal access token with the `repo` scope (or only `public_repo`) and
the `notifications` scope. Fine-grained tokens work too, but they cannot read notifications,
so issues you only *subscribed to* are not discovered.

## Commands

```
bun run watcher poll [--instance ID] [--dry-run]
bun run watcher list [--all] [--muted]
bun run watcher seen [URL...]
bun run watcher refilter
```

## Polling periodically

The poll is a one-shot command, so run it from cron or a systemd timer, e.g. every 20 minutes:

```cron
*/20 * * * * cd /path/to/watcher && /usr/local/bin/bun src/cli.ts poll >/dev/null
```

## Files

| Path               | In git | Content                                              |
|--------------------|--------|------------------------------------------------------|
| `data/config.yaml` | yes    | instances and filter tuning                          |
| `data/items.yaml`  | yes    | your intent: priority, mute, notes, manual items     |
| `.env`             | no     | tokens                                               |
| `var/cache.sqlite` | no     | cache; delete it to start over from a quiet baseline |
