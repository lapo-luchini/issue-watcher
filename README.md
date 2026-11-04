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

The watcher only reads. Use a **classic** personal access token with just the
`notifications` scope: public repositories, search and CI status need no scope at all.
(Don't pick `public_repo` or `repo`: those grant write access. `repo` is only needed to
watch private repositories.)

Fine-grained tokens with "Public repositories (read-only)" access work too, but they cannot
read notifications, so issues you only *subscribed to* are not discovered.

## Commands

```
bun run watcher poll [--instance ID] [--dry-run]
bun run watcher list [--all] [--muted]
bun run watcher seen URL... | --all
bun run watcher refilter
```

`seen` takes item URLs as `list` shows them (a URL copied from the browser, e.g. with
`/files` or a `#fragment`, works too); marking everything seen needs `seen --all`.

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
