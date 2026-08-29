# mc-build-bot

Discord bot that compiles uploaded Minecraft plugin source `.zip` files
(Maven or Gradle) into a `.jar` — right inside Discord.

## Features

- **`/build`** — attach a `.zip`, get back a compiled `.jar` or a build log
  - Auto-detects Maven (`pom.xml`) vs Gradle (`build.gradle`/`.kts`)
  - Handles multi-module projects — pick a module with `module:`, or the
    bot tells you what modules it found
  - Pick a Java target with `java:` (17 or 21, both installed in the image)
  - Pass a small whitelist of safe extra build flags with `args:`
    (e.g. `-DskipTests`, `--stacktrace`) — see `lib/args.js` for the full list
  - Long build logs are attached as `.txt` instead of flooding the channel
- **`/queue`** — see how many builds are running/queued right now
- **`/cancel`** — cancel your own in-flight or queued build
- **`/history`** — your last 10 builds (status, duration, jar name)
- **`/stats`** — your build stats, or bot-wide stats if you're an admin
- **`/config`** — admin-only: current concurrency limits, cooldown, DB mode,
  installed Java versions

## Why it's fast

- Maven builds run with `-T 1C` (one thread per core) and try `-o` (offline,
  using a persistent local repo cache) first, falling back to online only if
  that fails
- Gradle builds use `--build-cache --parallel` with a persistent Gradle home
- Both caches live under `BUILD_CACHE_DIR` and survive across builds in the
  same container (set `MAVEN_THREADS` to tune Maven's thread count)

## Reliability

- Builds run through an in-process queue (`MAX_CONCURRENT_BUILDS`) with a
  per-user cooldown (`PER_USER_COOLDOWN_MS`) instead of unbounded parallel
  compiler processes
- Every failure mode has a typed error (`lib/errors.js`) with a safe,
  specific message — download failures, bad zips, missing build files,
  build failures, missing/oversized jar output, timeouts, cancellation
- A hard `BUILD_TIMEOUT_MS` kills runaway builds
- Global `unhandledRejection` / `uncaughtException` handlers log and exit
  cleanly so the container orchestrator can restart the process
- All outgoing Discord messages go through mention-sanitizing helpers so
  build output or filenames can never trigger `@everyone`/`@here`/user pings

## Logging

Structured logging via `lib/logger.js` — no external dependency:
- `NODE_ENV=development` (default): colorized, human-readable lines
- `NODE_ENV=production`: JSON lines, one per log entry, ready to ship to
  any log aggregator
- `LOG_LEVEL` controls verbosity (`debug` | `info` | `warn` | `error`)

## History & stats

Build history and stats persist in a small SQLite database
(`better-sqlite3`) at `DATA_DIR/builds.sqlite3`. If the native module isn't
available, the bot automatically falls back to in-memory history (lost on
restart) rather than failing to start — check `/config` to see which mode
is active.

## Setup

1. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and
   `DISCORD_CLIENT_ID`. Optionally set `DISCORD_GUILD_ID` for instant
   command registration during development.
2. `npm install`
3. `npm run dev` (pretty logs) or `npm start` (JSON logs)

### Docker

```bash
docker build -t mc-build-bot .
docker run -d \
  --env-file .env \
  -v mc-build-bot-data:/app/data \
  mc-build-bot
```

The image includes JDK 17 and 21, Maven, and Gradle. Mount `/app/data` as a
volume so build history survives redeploys.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` | — | required |
| `DISCORD_GUILD_ID` | — | instant per-guild command registration |
| `ALLOWED_USER_IDS` / `ALLOWED_ROLE_IDS` | — | who can use `/build` (blank = everyone) |
| `ADMIN_USER_IDS` | — | who can use `/config` and see bot-wide `/stats` |
| `MAX_CONCURRENT_BUILDS` | `1` | parallel build slots |
| `PER_USER_COOLDOWN_MS` | `15000` | per-user rate limit between `/build` calls |
| `BUILD_TIMEOUT_MS` | `300000` | kill a build after this long |
| `MAVEN_THREADS` | `1C` | Maven `-T` thread count |
| `MAX_ZIP_BYTES` | `26214400` (25MB) | max upload size |
| `MAX_JAR_BYTES` | `8589934592` (8GB) | max output jar size (Discord upload limits still apply) |
| `INLINE_LOG_LIMIT` | `1500` | chars before a build log becomes a file attachment |
| `BUILD_CACHE_DIR` | temp dir | Maven/Gradle cache location |
| `DATA_DIR` | `./data` | SQLite history location |
| `NODE_ENV` | `development` | `production` = JSON logs |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## Project layout

```
index.js              entrypoint: Discord client, command routing, global error handlers
lib/
  logger.js            structured logging
  errors.js            typed errors with user-safe messages
  db.js                SQLite build history/stats (falls back to memory)
  build.js             project detection + compiler invocation
  queue.js             concurrency-capped build queue
  access.js            allowlist / admin checks
  args.js              whitelist for user-supplied extra build flags
  discord-helpers.js   mention-safe replies, embeds, log attachments
  commands.js          slash command schema + registration
commands/
  build.js              /build handler
  misc.js                /queue /cancel /history /stats /config handlers
```
