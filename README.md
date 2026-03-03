# Peach API

`Peach API` is a Bun + TypeScript API that resolves movie/TV streaming sources by TMDB ID, normalizes them into a single response shape, and proxies HLS/MP4 streams for browser-safe playback.

It currently supports these providers:
- `moviebox`
- `myflixerz`
- `vixsrc`

It also includes subtitle lookup endpoints (via `sub.wyzie.ru`) and Redis-based caching to reduce repeated upstream scraping.

## Features

- TMDB-driven source lookup for movies and TV episodes
- Provider abstraction layer with a shared output format
- Built-in stream proxy endpoints:
  - M3U8 manifest rewriting
  - TS segment proxying
  - MP4 byte-range proxying (seek support)
- Subtitle lookup endpoints with cache
- OpenAPI docs via `@elysiajs/openapi`
- Redis cache for mapped IDs, source URLs, and subtitles

## Tech Stack

- Runtime: `Bun`
- Language: `TypeScript` (strict mode enabled)
- Web framework: `Elysia`
- Docs: `@elysiajs/openapi`
- CORS: `@elysiajs/cors`
- TMDB client: `tmdb-ts`
- HTML parsing: `cheerio`
- String matching: `string-comparison`
- Cache: Bun `RedisClient`

## Project Structure

```text
src/
  index.ts                 # Main API server + routes
  helpers/
    const.ts               # Subtitle cache TTL constants
    errors.ts              # TMDB error type guard
    logger.ts              # Colored logger helpers
    util.ts                # User agent, date conversion, utility helpers
  lib/
    proxy.ts               # Converts source URLs into Peach proxy URLs
    redis.ts               # Redis client setup
    sources.ts             # Provider registry/dispatcher
    subtitle.ts            # Subtitle fetch + cache logic
  scrapers/
    moviebox.ts            # MovieBox scraper
    myflixerz.ts           # MyFlixerZ scraper
    vixsrc.ts              # VixSrc scraper
  types/
    types.ts               # Shared Source type
test/
  index.html               # Basic HLS proxy playback test page
```

## Requirements

- Bun installed
- Redis server running
- TMDB API Read Access Token (v4)

## Installation

```bash
bun install
```

## Environment Variables

Copy `.env.example` to `.env` and set values:

```bash
TMDB_ACCESS_TOKEN=""
REDIS_URL=redis://localhost:6379
PORT=3000
SERVER_ORIGIN=http://localhost:3000
ALLOWED_ORIGINS="http://localhost:5173,http://localhost:5500"
```

Variable notes:
- `TMDB_ACCESS_TOKEN`: Required. Must be TMDB **access token**, not API key.
- `REDIS_URL`: Required for caching.
- `PORT`: Optional. Defaults to `3000`.
- `SERVER_ORIGIN`: Required for generating proxy URLs in returned sources.
- `ALLOWED_ORIGINS`: Comma-separated CORS allowlist.

## Run

Development (watch mode):

```bash
bun run dev
```

Manual run:

```bash
bun run src/index.ts
```

## API Docs

OpenAPI plugin is enabled:
- UI: `GET /openapi`
- JSON spec: `GET /openapi/json`

## API Overview

Base URL (local): `http://localhost:3000`

### Health/Info

- `GET /`
  - Returns API name, endpoint summary, and provider list.

### Source Endpoints

- `GET /:provider/movie/:tmdbId`
- `GET /:provider/tv/:tmdbId/:season/:episode`

Path params:
- `provider`: `moviebox | myflixerz | vixsrc`
- `tmdbId`: TMDB numeric ID
- `season`, `episode`: TV episode target

Query params:
- `serve_cache` (optional boolean string):
  - `true` (default): serve cached values when available
  - `false`: bypass cache and fetch fresh

Success response shape:

```json
{
  "type": "movie",
  "tmdbId": 786892,
  "providerName": "vixsrc",
  "tookMs": 381.17,
  "sources": [
    {
      "url": "http://localhost:3000/m3u8-proxy?url=...",
      "dub": "English",
      "type": "hls",
      "quality": 1080,
      "sizeBytes": 1234567890,
      "headers": {
        "referer": "https://..."
      }
    }
  ]
}
```

Possible non-200 responses:
- `404`: provider not found, title not found, unreleased content
- `422`: validation error (bad path/query type)
- `500`: upstream/internal failure

Release gating rules:
- Movies are treated as released if they are within 30 days of TMDB release date.
- TV is allowed if current date is within 7 days of show first-air date.
- Season/episode-level air-date validation is not fully implemented yet.

### Subtitle Endpoints

- `GET /subs/movie/:tmdbId`
- `GET /subs/tv/:tmdbId/:season/:episode`

Behavior:
- Fetches subtitle data from `https://sub.wyzie.ru/search`
- Caches success for 7 days
- Caches empty/error results for 3 hours

### Proxy Endpoints

- `GET /m3u8-proxy?url={encodedUrl}&headers={encodedJsonHeaders}`
  - Fetches and rewrites M3U8 manifests so nested playlists/segments continue through Peach proxy.
- `GET /ts-segment?url={encodedUrl}&headers={encodedJsonHeaders}`
  - Proxies TS segments for HLS playback.
- `GET /mp4-proxy?url={encodedUrl}&headers={encodedJsonHeaders}`
  - Proxies MP4 and forwards byte-range requests for seeking.
- `GET /fetch?url={encodedUrl}&headers={encodedJsonHeaders}`
  - Generic fetch proxy for non-segment linked assets.

`headers` must be URL-encoded JSON, for example:

```json
{"referer":"https://vixsrc.to/movie/786892"}
```

## Providers and Internals

### moviebox

- Uses search/mapping flow + separate source extraction.
- Attempts fuzzy matching and release month checks.
- Supports multiple dubs when available.
- Caches:
  - mapped IDs (hit/miss)
  - resolved sources (hit/miss)

### myflixerz

- Scrapes search results and uses string similarity matching.
- Resolves episode/server IDs from HTML fragments.
- Extracts embed nonce/token and fetches final stream source list.
- Filters for `hls`/`mp4`, validates link reachability.
- Caches mapping and sources (hit/miss).

### vixsrc

- Direct path by TMDB ID for movie/TV.
- Checks endpoint with `HEAD`, then parses inline script for master URL token params.
- Returns HLS source with required referer header.
- Caches sources (hit/miss).

## Caching Details (Redis)

General behavior:
- Cache serving is enabled by default.
- `serve_cache=false` forces a fresh scrape/fetch.

TTL summary:
- Subtitles:
  - success: `604800s` (7 days)
  - empty/error: `10800s` (3 hours)
- MovieBox:
  - mapping hit: `259200s` (3 days)
  - mapping miss: `3600s` (1 hour)
  - source hit: `7200s` (2 hours)
  - source miss: `900s` (15 minutes)
- MyFlixerZ:
  - mapping hit: `259200s` (3 days)
  - mapping miss: `3600s` (1 hour)
  - source hit: `3600s` (1 hour)
  - source miss: `900s` (15 minutes)
- VixSrc:
  - source hit: `3600s` (1 hour)
  - source miss: `900s` (15 minutes)

## Example Requests

```bash
# Movie sources
curl "http://localhost:3000/vixsrc/movie/786892"

# TV episode sources
curl "http://localhost:3000/myflixerz/tv/1399/1/1?serve_cache=true"

# Movie subtitles
curl "http://localhost:3000/subs/movie/786892"

# TV subtitles
curl "http://localhost:3000/subs/tv/1399/1/1"
```

## Notes and Limitations

- Provider sites can change HTML/anti-bot flows at any time.
- Some sources require strict upstream headers (`referer`, optional range headers).
- Source availability and dub coverage vary by provider/title.
- There is currently no automated test suite in this repository.
- `test/index.html` is a manual HLS playback test page for proxy debugging.

## Security and Ops Recommendations

- Keep `.env` private and rotate exposed TMDB tokens.
- Restrict `ALLOWED_ORIGINS` in production.
- Put this API behind rate limiting/reverse proxy.
- Monitor upstream failures and cache hit/miss ratios.
- Consider provider-specific circuit breakers/timeouts for production hardening.

## Disclaimer

This project aggregates links from third-party sources and depends on external websites that are not controlled by this repository. Availability, legality, and rights to access or stream content vary by jurisdiction. You are solely responsible for how you use this software, including compliance with copyright laws, platform terms, and local regulations. The maintainers provide this code as-is, without warranty, and are not responsible for any misuse or damages.
