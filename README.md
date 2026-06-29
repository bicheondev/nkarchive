# nkarchive

## Search Backend Architecture

The `/search` portal reads from the local development index by default. UI components talk only to the stable provider contract in `search/SearchProvider.js`:

- `searchDocuments(query, filters)`
- `getSuggestions(query)`
- `getDocumentById(id)`

Local indexed data lives in:

- `data/search/documents.jsonl`
- `data/search/sources.json`

The source catalog is limited to the requested search scope: 로동신문, 조선중앙통신, 조선의 소리, 민주조선, 류경, 내나라, 조선신보, 조선의 출판물, KCNA Watch, 고려TV VOD video metadata, and scoped YouTube metadata from 메아리/supersuhui.

If the local index has no documents, the results page shows `아직 색인된 문서가 없습니다.` instead of fake placeholder cards. Test-only fixture documents live under `test/fixtures/search` and are not loaded by the production provider.

`MeilisearchSearchProvider` is available for the backend path, but it is only selected when both a Meilisearch host and search key are configured. When configured, the runtime wraps it with the local real-index provider so temporary backend, CORS, or network failures fall back to `data/search/documents.jsonl` instead of showing fake or empty results. In local development the app uses `LocalJsonSearchProvider` directly; a transient first-load JSON failure can be retried on the next search, a successfully loaded index is reused for results, suggestions, and document lookups, and each local search response reports `processingTimeMs` so the result summary stays consistent with the backend path. For static/browser deployments, replace `search/search-config.js` with a non-secret search key configuration before loading `searchPortal.js`:

```js
window.DPRK_SEARCH_CONFIG = {
  meilisearch: {
    host: "https://search.example.org",
    apiKey: "public-search-key"
  },
  assetProxy: {
    baseUrl: "https://gcp-proxy.example.org/search-asset",
    urlParam: "url"
  }
};
globalThis.DPRK_SEARCH_CONFIG = window.DPRK_SEARCH_CONFIG;
document.documentElement.dataset.searchConfigLoaded = "true";
```

Copy `.env.example` to `.env` when setting up crawler/search workers. Release, import, seed, sync, smoke, and asset-mirroring scripts load `.env` automatically without overriding variables already provided by the shell or deployment platform. `vercel.json` configures the Node asset proxy runtime, extensionless and trailing-slash `/search`, `/search/results`, and `/search/document` rewrites, and cache headers for search data, mirrored assets, and search pages; keep any host-level deployment changes consistent with those settings. `.vercelignore` keeps crawler fetch caches and the server-side Meilisearch seed payload out of static Vercel uploads while still deploying `/data/search/documents.jsonl`, `/data/search/sources.json`, and mirrored runtime assets. `.gitignore` keeps the same regenerable import intermediates and Meilisearch seed payload out of commits.

Use the ingestion and local search scripts while developing:

```sh
npm run ingest:search -- --documents path/to/official.jsonl --documents path/to/video.jsonl --sources path/to/sources.json
npm run search:local -- "화성"
npm run search:local -- "원산" --sort latest
npm run search:local -- "site:rodong.rep.kp 원산"
npm run search:local -- "site:(rodong.rep.kp) 원산"
npm run search:local -- "site:kp 원산"
npm run search:local -- "사이트:kp 원산"
npm run search:local -- "사이트:kp" --sort latest
npm run search:local -- "site:rep.kp 원산갈마"
npm run search:local -- "domain:rep.kp 원산갈마"
npm run search:local -- "site:*.rep.kp 원산갈마"
npm run search:local -- "(site:rodong.rep.kp OR site:vok.rep.kp) 원산갈마"
npm run search:local -- "-site:kcna.kp 원산"
npm run search:local -- "원산 NOT site:kcna.kp"
npm run search:local -- 'source:"조선중앙통신" 원산갈마'
npm run search:local -- "출처:로동신문 원산갈마"
npm run search:local -- 'source:“조선중앙통신” 원산갈마'
npm run search:local -- "filetype:pdf 원산"
npm run search:local -- "파일형식:pdf 원산"
npm run search:local -- "filetype:(pdf) 원산"
npm run search:local -- "ext:pdf 원산"
npm run search:local -- "원산 -filetype:pdf"
npm run search:local -- "원산 NOT filetype:pdf"
npm run search:local -- "원산 -lang:en"
npm run search:local -- "원산 NOT lang:en"
npm run search:local -- "after:2025-06-01 before:2025-06-30 원산갈마"
npm run search:local -- "이후:2025-06-01 이전:2025-06-30 원산갈마"
npm run search:local -- "date:2025-06-01..2025-06-30 원산갈마"
npm run search:local -- '"원산갈마해안관광지구 준공식"'
npm run search:local -- '+"원산갈마해안관광지구 준공식"'
npm run search:local -- "원산 -갈마"
npm run search:local -- "문헌" --tab pdf
npm run search:local -- "Korean" --tab video
```

Importer scripts fetch real pages and write JSONL candidates. If a site is unavailable or yields no indexable pages, they write zero documents rather than placeholders:

```sh
npm run import:search
npm run import:official-sites
npm run import:kcna-watch -- --limit 50
npm run import:koryo-vod -- --limit 50
npm run import:youtube-metadata -- --limit 50
npm run import:search -- --limit 120 --max-links-per-source 600 --max-discovery-pages 80
npm run import:search -- --proxy http://34.11.153.107:3128
HTTP_PROXY=http://34.11.153.107:3128 HTTPS_PROXY=http://34.11.153.107:3128 NO_PROXY=www.kcna.kp,kcna.kp npm run import:search
npm run import:search -- --proxy http://34.11.153.107:3128 --no-proxy-direct-fallback
npm run import:search -- --proxy http://34.11.153.107:3128 --request-delay-ms 850 --discovery-reserve-ms 70000
npm run smoke:search-crawl -- --proxy http://34.11.153.107:3128
npm run smoke:search-crawl -- --sources kcna,rodong-sinmun,voice-of-korea --proxy http://34.11.153.107:3128 --limit 24 --min-documents 1
npm run smoke:search-crawl -- --all-official-sites --proxy http://34.11.153.107:3128 --limit 12 --min-documents 1
npm run preflight:search -- --proxy http://34.11.153.107:3128
npm run preflight:search -- --all-official-sites --proxy http://34.11.153.107:3128
npm run preflight:search -- --skip-smoke
npm run preflight:search -- --skip-smoke --skip-tests
npm run import:official-sites -- --source korean-books --merge-existing-output
npm run import:search -- --source rodong-sinmun --limit 80 --max-source-ms 180000
```

`import:search` runs the real importers, merges their JSONL outputs, validates the index, writes `data/search/documents.jsonl`, and records source reachability in `data/search/source-health.json`. `smoke:search-crawl` runs the official-site importer against one or more sources with temporary output, verifies that each selected source indexed at least `--min-documents` real records, prints each crawl report summary, and removes the temporary files unless `--keep-output`, `--out`, or `--report` is supplied. Planned source-budget warnings such as source time-budget exhaustion or detail fetch caps are printed without failing smoke once that source has indexed enough real records. Use it before a broad production refresh to confirm that the crawler worker, proxy, and source routes are alive without mutating the checked-in search index; pass `--source` for one source, `--sources kcna,rodong-sinmun,voice-of-korea` for an official-source panel, or `--all-official-sites` for every source handled by the official-site importer. `preflight:search` bundles that live smoke with the non-mutating release gates: `test:search`, `validate:search`, `seed:search`, `audit:search`, and `sync:meilisearch -- --dry-run`; by default the live smoke checks KCNA, 로동신문, and 조선의 소리, `--source`/`--sources` can narrow or expand it, and `--all-official-sites` runs the full catalog-derived official-site importer smoke panel. Pass `--skip-smoke` when running in an offline CI environment that should only validate the checked-in bundle, and reserve `--skip-tests` for an explicit fast storage-only check after correctness tests have already run. The default official-site crawl budget is intentionally broad enough for source-level search coverage: 160 documents per source, 800 discovered links, 100 discovery pages, 15s fetch timeouts, 240s per source, four concurrent document fetches, and a small source-configured request delay so readable mirrors do not immediately rate-limit broad listing crawls. Source-specific budgets can go higher when a site benefits from deeper direct indexing; for example KCNA is configured for at least 260 detail-page records so the direct official source does not stay far behind KCNA Watch breadth. Discovery also reserves part of the source runtime for article fetches, which prevents listing-page traversal from consuming the whole budget before any documents are indexed. Use `--limit`, `--max-links-per-source`, `--max-discovery-pages`, `--max-source-ms`, `--request-delay-ms`, or `--discovery-reserve-ms` to override those defaults for a targeted run. The official DPRK-site crawlers can use `--proxy` or standard `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` environment variables; `NO_PROXY`/`no_proxy` is honored for hosts that should stay on the direct route when a proxy reaches the crawler but not a specific upstream source. When a configured proxy route itself times out or fails before a source HTTP response is received, the crawler makes one bounded direct retry so a reachable-but-upstream-blocked proxy does not suppress directly reachable sources; pass `--no-proxy-direct-fallback` or set `DPRK_SEARCH_PROXY_DIRECT_FALLBACK=0` in strictly proxied environments. Without a proxy, blocked Korean-network fetches prefer readable `r.jina.ai` copies of the original official URLs before falling back to cached real documents. Health summaries separate `searchableSources` from clean `healthySources`: a source can remain searchable from preserved real documents while still appearing in `warningSources` when the latest live import failed or timed out.

Because many users cannot load DPRK-hosted images, PDFs, or video thumbnails directly, indexed documents support mirrored asset fields:

- `cachedUrl` for the primary media/file asset
- `cachedThumbnailUrl` for image and video thumbnails

The UI always prefers those cached fields before source-hosted URLs, while keeping a separate `원문 사이트` link for provenance. Video records are thumbnail-only: the portal does not mirror, proxy, or inline-play original video files, including 고려TV VOD. If an indexed direct image/PDF/thumbnail asset has not been mirrored yet, `/api/search-asset` can act as a same-origin fallback proxy on Vercel; it only accepts direct image/PDF URLs from the configured source hosts, including KCNA's extensionless `/image/q/*.kcmsf` image endpoints, rejects article/page/video URLs, caps response size, forwards HEAD checks without downloading the asset body, preserves browser `Range` requests and `206 Content-Range` metadata for PDF previews, and sends restrictive nosniff/CSP/CORP headers for proxied files. A stronger production option is to point `DPRK_SEARCH_CONFIG.assetProxy.baseUrl` at a GCP-hosted proxy, so cache misses are fetched by the US server while the browser still receives a normal image/PDF response.

For local development, mirror direct image/PDF/video-thumbnail URLs into `data/search/assets` after importing:

```sh
npm run cache:search-assets -- --timeout-ms 12000
npm run cache:search-assets -- --proxy http://34.11.153.107:3128 --timeout-ms 12000
npm run cache:search-assets -- --proxy http://34.11.153.107:3128 --no-proxy-direct-fallback --timeout-ms 12000
npm run cache:search-assets -- --proxy http://34.11.153.107:3128 --timeout-ms 8000 --concurrency 8
npm run cache:search-assets -- --source kcna-watch,koryo-vod,youtube --timeout-ms 12000
npm run cache:search-assets -- --exclude-source korean-books --timeout-ms 12000
npm run cache:search-assets -- --fetch-proxy-template 'https://gcp-proxy.example.org/search-asset?url={url}'
npm run cache:search-assets -- --public-base-url https://pub-<bucket>.r2.dev/search/assets
npm run upload:search-assets -- --public-base-url https://pub-<bucket>.r2.dev --bucket <bucket-name>
```

In production, run this mirroring step from a crawler/worker environment that can reach the source hosts, upload the resulting files to Cloudflare R2 or another public object store, and write the public object URL back to `cachedUrl`/`cachedThumbnailUrl` before seeding Meilisearch. If any selected asset fails, `cache:search-assets` exits non-zero by default so CI does not silently bless a broken mirror pass; use `--allow-failures` only for an intentionally partial diagnostic run. Each asset-cache report includes `assetCoverage.before` and `assetCoverage.after` summaries for the full index and selected source scope, so a targeted pass still reveals how many deployable preview assets remain uncached by source. Failed diagnostic passes also include `failureSummary.bySource` and `failureSummary.byError`, which makes a blocked host, timeout class, HTTP status, or unexpected content-type issue visible without reading every failed URL. When an image document uses the same source URL for `thumbnailUrl` and `url`, the mirror stores that source asset once and assigns the same public object to both cached fields instead of double-fetching or double-counting it. `npm run audit:search` also verifies that local `/data/search/assets/...` cache references point to files that exist and cannot escape the mirrored asset directory. If the crawler environment is in Korea, pass `--proxy <http-proxy-url>` or set `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` so direct source asset fetches go through a reachable US proxy; alternatively point `--fetch-proxy-template` at a reachable US-hosted backend such as GCP. Like the document crawler, the asset mirror makes one bounded direct retry when an outbound proxy route times out or fails before returning source asset bytes; pass `--no-proxy-direct-fallback` or set `DPRK_SEARCH_PROXY_DIRECT_FALLBACK=0` when the worker must never bypass the proxy. `{url}` is replaced with the encoded source asset URL, so the crawler stores the proxy response while keeping the original source URL for provenance. `--fetch-proxy-base-url <url>` and `--fetch-proxy-url-param <name>` are also supported for simple query-param proxy endpoints. Use `--concurrency <n>` with a bounded timeout so one slow DPRK asset host cannot stall the whole mirror pass. Use `--source <source-id[,source-id]>` for targeted mirror passes and `--exclude-source <source-id[,source-id]>` when a temporarily blocked source would otherwise consume the attempt budget before reachable archive/video assets are mirrored. The same-origin `/api/search-asset` fallback honors `DPRK_SEARCH_ASSET_PROXY` first, then standard proxy environment variables, for uncached image/PDF source assets. Configure the R2 upload with `R2_PUBLIC_BASE_URL`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and either `R2_ENDPOINT` or `R2_ACCOUNT_ID`. Keep R2 cost bounded with lifecycle rules: temporary cache prefixes can expire after 30/90 days, while manually curated preservation assets can live under a separate permanent prefix. Vercel should serve the portal and APIs; it should not be the only long-running crawler and asset-mirroring system.

The 고려TV importer uses the public `https://vod.koryo.tv/api/v1/media` metadata feed, enforces the source `robotsPolicy` for both the API URL and returned item URLs, and indexes those records as video documents. The YouTube metadata importer uses the public channel RSS feeds for 메아리 and supersuhui and merges both channels into one `YouTube` source. Because 전체 means every matching media type, all indexed video documents appear in both 전체 and 동영상; the 동영상 tab simply narrows the result set to video/broadcast records. KCNA Watch is the only source whose own search page is used as a discovery surface; its `?s=` results seed crawl frontier URLs for configured Korean/English query pairs such as 원산갈마/Wonsan Kalma. 조선신보 uses its public WordPress posts list API as a source listing, not its site-search UI, and converts returned `title`/`excerpt`/`content` records into indexed article documents. Other official sites should not use their weak site-search UIs: they remain conservative HTML/feed/sitemap/listing crawlers that reject blocking pages, skip home/listing pages, follow bounded source-approved listing pages with `--max-discovery-pages`, enforce source `robots.txt` when `robotsPolicy` is `respect`, index extracted real URLs, turn RSS/Atom feed items into real source records, and convert discovered `.pdf` links into `mediaType: "pdf"` records for the 문헌 tab.

KCNA Watch and 고려TV are treated as directly reachable archive/video sources for Korean users, so the UI still keeps clear original-site links for them. Mirroring/proxy support remains important for DPRK-hosted `.kp` source assets that may not load directly from Korea.

YouTube is deliberately limited to metadata and embedded playback from the configured 메아리/supersuhui channel feeds. The portal does not mirror YouTube video files; it stores indexed metadata, thumbnails, and source/embed URLs. YouTube RSS thumbnail shard hosts such as `i1.ytimg.com` through `i4.ytimg.com` are treated as public direct image hosts so thumbnails are not sent through the DPRK-source asset proxy.

When direct access is blocked or times out, the crawler can fall back to a readable public snapshot of the same URL and extract Markdown links/content from that real source page. Successful direct, feed, JSON, and readable responses are cached under `data/import/fetch-cache` by default; later live failures can fall back to that previously fetched real response instead of fabricating records. Disable readable fallback with `--no-readable-fallback`, disable the fetch cache with `--no-fetch-cache`, override its location with `--cache-dir <path>`, and tune transient retry attempts with `--retries <count>`. Use `--source <source-id>` to refresh one official source; `import:search -- --source ...` automatically passes `--merge-existing-output` to the official-site importer, and direct `import:official-sites -- --source ...` runs should include `--merge-existing-output` to merge that refresh into the current importer output without deleting documents from untouched sources. Failed sources preserve previous documents per source unless `--allow-empty-overwrite` is passed or the source disables preservation because only generic/navigation pages were discovered.

The validation, test, and seed scripts operate on the indexed storage:

```sh
npm run validate:search
npm run audit:search
npm run test:search
npm run ci:search
npm run seed:search
npm run seed:search -- --write
npm run sync:meilisearch -- --dry-run
npm run verify:vercel-bundle
npm run release:search -- --skip-smoke
npm run release:search -- --proxy http://34.11.153.107:3128
npm run verify:search-production -- --base-url https://nkarchive.vercel.app
```

`seed:search -- --write` writes a deployable `data/search/meilisearch-seed.json` payload containing documents, suggestions, suggestion-only known-entity synonyms, and index settings. To upload it, set `MEILISEARCH_HOST` and `MEILISEARCH_KEY`, then run:

```sh
npm run sync:meilisearch -- --wait
npm run release:search -- --confirm-production --proxy http://34.11.153.107:3128
npm run release:search -- --confirm-production --deploy-vercel --proxy http://34.11.153.107:3128
```

`ci:search` is the repeatable no-secret CI gate: it validates JSON manifests, checks script syntax, runs `test:search`, verifies the Vercel deploy bundle, and finishes with a non-mutating `release:search -- --skip-smoke --skip-tests` dry run. `verify:vercel-bundle` applies `.vercelignore` locally and fails if runtime search files such as `/data/search/documents.jsonl`, `/data/search/sources.json`, or search route shells would be missing from the deploy upload, or if crawler caches/server seed payloads would be uploaded. `release:search` is the final operator command. Without `--confirm-production` it is a safe dry run: it builds the current seed, reports missing Meilisearch/R2/Vercel/public-URL environment, runs `preflight:search`, skips R2 upload when R2 credentials are absent, runs the Meilisearch dry-run sync, and skips deployed-site verification when no public URL is configured. With `--confirm-production`, it requires the production environment documented in `.env.example`, uploads cached search assets to R2, runs the atomic Meilisearch sync with `--wait`, can run a non-interactive Vercel production deploy when `--deploy-vercel` and Vercel environment variables are present, pulls Vercel production project settings before deploy, and verifies the public `/search` deployment with `verify:search-production` unless `--skip-verify` is explicitly passed. The verification command fetches the deployed search shells and `/data/search` index, validates the deployed source/document payload, checks critical coverage for `원산`, `원산갈마해안관광지구 준공식`, and `사이트:kp`, and confirms that KCNA Watch source-filtered records still carry origin-pill metadata. `audit:search` checks the full deployable bundle together: canonical source scope, indexed documents, source-health counts, latest asset-cache report status, generated or supplied Meilisearch seed content, Meilisearch settings, suggestion payloads, critical query coverage, and backend-only visibility rules. It fails if any requested source loses all indexed real documents, if source-health no longer reports every configured source as searchable, if the latest asset mirroring report is a dry run, omits `assetCoverage.after`, contains failed fetches, or leaves the selected mirror scope with uncached candidates, if core searches such as `원산`, `원산갈마`, `원산갈마해안관광지구 준공식`, `김정은 원산갈마`, `-site:kcna.kp 원산`, `site:rodong.rep.kp`, `site:rodong.rep.kp -원산`, `사이트:kp`, `사이트:kp 원산갈마`, `출처:로동신문 원산갈마`, `filetype:pdf`, `파일형식:pdf`, `-filetype:pdf`, `-lang:en`, or `이후:2025-06-01 이전:2025-06-30 원산갈마` stop spanning the expected sources, if source-exclusion, media-exclusion, or language-exclusion searches leak excluded records back into results, if filter-only operators stop stripping to an empty backend text query with real structured filters, if structured negative-only text searches return excluded terms, if test fixture/mock/placeholder records leak into the production index, or if indexed publication dates are in the future. Passing audits print critical query coverage, full/selected asset-cache coverage, top remaining uncached asset sources, and warning-source details when a source remains searchable but degraded, for example a timed-out KCNA Watch refresh or a video source temporarily served from preserved documents. When a seed file is supplied, it compares that seed against the current seed builder output, so a stale seed with unchanged document IDs but old titles, bodies, preview text, facets, or suggestions fails the production audit. The sync script configures filterable attributes for `sourceId`, `displaySourceId`, `sourceType`, `displaySourceType`, `mediaType`, `date`, `language`, `searchTabs`, `visibleTabs`, and `storyKey`, sortable attributes for `integratedRank`, `date`, and `displayOrder`, builds replacement staging indexes, atomically swaps them into the live Meilisearch index names, and keeps separate indexes for documents and suggestions. `visibleTabs` preserves local tab behavior in Meilisearch: every document is visible in 전체, while image/video/pdf-specific tabs narrow by media type. `sourceId` preserves source facets and `site:`/`-site:` semantics; `displaySourceName`/`displaySourceId` preserve the original publication provenance for KCNA Watch preserved copies, while `storyKey` collapses duplicate article/story hits. `integratedRank` preserves the local 전체 ranking policy that keeps article/web-like records ahead of matching image/video assets. The document index disables typo tolerance and broad synonyms, and document search uses dateline-stripped `searchSnippet`/`searchBody` fields instead of raw source datelines, so location searches such as `평양` do not fill with articles that only mention the city in a wire dateline. Document search requests use Meilisearch `matchingStrategy: "all"`, explicit document search attributes, ranking scores, and a minimum `rankingScoreThreshold` so backend retrieval stays strict; the suggestion index keeps typo/synonym support for autocomplete. The UI should not need a redesign for that swap.

GitHub Actions includes `.github/workflows/search-ci.yml` for the no-secret `ci:search` gate on pushes and pull requests, plus `.github/workflows/search-production-release.yml` for manual production releases. Configure repository secrets for `MEILISEARCH_HOST`, `MEILISEARCH_KEY`, `R2_PUBLIC_BASE_URL`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and either `R2_ENDPOINT` or `R2_ACCOUNT_ID`; add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` only when using the workflow's `deploy_vercel` option. Optional repository variables can provide `MEILI_DOCUMENT_INDEX`, `MEILI_SUGGESTION_INDEX`, `R2_OBJECT_PREFIX`, and `R2_REGION`. The workflow passes the DPRK crawler proxy as a `release:search --proxy` argument instead of setting job-wide `HTTP_PROXY`/`HTTPS_PROXY`, so npm install, Meilisearch, R2, and Vercel infrastructure calls stay on their normal network route.

Document search responses also expose source facets with real source IDs, display names, and match counts. KCNA Watch preserved records stay in the KCNA Watch source group and filter category; when the preserved page identifies an original publisher such as 로동신문 or 조선중앙통신, the result metadata renders that publisher as an origin pill instead of moving the document into the original source facet. The results UI renders source facets as compact filters above grouped cards, and Meilisearch-backed search derives the same shape from `facetDistribution.sourceId`, so source drilldown works the same locally and after the backend swap. On source-filtered pages, the Meilisearch provider makes a lightweight facet-only request without the active `sourceId` filter, preserving the full source switcher instead of trapping the user inside one source. Results also support shareable `sort=latest` URLs alongside the default relevance ranking; local JSON search and Meilisearch both preserve that sort through tabs, source facets, pagination, and document back links. Google-like `site:` and `source:` operators are accepted in search input and the local CLI. The provider strips them from backend document text and turns them into structured source filters, while the results URL keeps the typed operator in `q` when no explicit `source=` filter is active; for example `site:rodong.rep.kp 원산` stays shareable as `q=site:rodong.rep.kp 원산` but searches with `sourceId=rodong-sinmun`. Clicking a specific source facet or source-card drilldown then removes broad typed source operators and uses the explicit source-filter route, for example `q=원산&source=rodong-sinmun`, so stale mixed URLs cannot keep conflicting source scopes; aliases such as `domain:`, `host:`, `사이트:`, `도메인:`, `src:`, `출처:`, and `자료원:` resolve to the same structured filters. Parent-domain forms such as `site:rep.kp 원산갈마`, bare TLD forms such as `site:kp 원산`, and wildcard host forms such as `site:*.rep.kp 원산갈마` expand to every configured source under that host suffix instead of requiring users to know each exact subdomain. Structured operator values may be bare, straight-quoted, curly-quoted, or parenthesized, so rich-text pasted queries such as `source:“조선중앙통신” 원산갈마`, `filetype:“pdf” 원산`, or `date:“2025-06-01..2025-06-30” 원산갈마` behave like their plain ASCII forms. Parenthesized forms such as `(site:rodong.rep.kp OR site:vok.rep.kp) 원산갈마` are parsed as structured source filters too, without leaking `OR` or parentheses into the backend document query. Filter-only searches such as `site:rodong.rep.kp` or `filetype:pdf` are valid too, using an empty backend text query plus real source/tab filters instead of returning an empty-query state. Negative source operators are accepted too: `-site:kcna.kp 원산` becomes `q=원산&exclude_source=kcna` and is sent to Meilisearch as a real `sourceId` exclusion filter instead of a mock/client-only rewrite. Structured filters can also be combined with only negative text terms, so `site:rodong.rep.kp -원산` browses 로동신문 documents and removes indexed records containing `원산` instead of degenerating into an empty search. Media operators are also accepted and canonicalized into the existing tab routes: `filetype:pdf 원산`, `ext:pdf 원산`, and `extension:pdf 원산` become `q=원산&tab=pdf`, while `type:image` and `media:video` map to the 이미지 and 동영상 tabs; aliases such as `format:`, `mime:`, `파일형식:`, `형식:`, `매체:`, and `종류:` follow the same path. Negative media operators become structured media-type exclusions too: `원산 -filetype:pdf` or `원산 -ext:pdf` becomes `q=원산&exclude_type=pdf`, and `-filetype:pdf` is a valid filter-only browse over non-PDF records. Language operators become structured filters against indexed document language: `lang:en Wonsan` becomes `q=Wonsan&lang=en`, with aliases such as `language:english`, `lang:korean`, and `언어:일본어`. Negative language operators become structured exclusions as well: `원산 -lang:en` becomes `q=원산&exclude_lang=en`, and `-lang:en` browses non-English records with an empty backend text query. Date operators become structured filters against indexed publication dates: `after:2025-06-01 before:2025-06-30 원산갈마` becomes `q=원산갈마&after=2025-06-01&before=2025-06-30`; aliases such as `since:`, `from:`, `이후:`, `부터:`, `until:`, `to:`, `이전:`, and `까지:` resolve to the same date bounds, while explicit single-token ranges such as `date:2025-06-01..2025-06-30 원산갈마`, `날짜:2025-06-01..2025-06-30`, and `daterange:2025..2025 원산갈마` map to the same date filters. Quoted phrases use exact contiguous phrase matching over the same indexed fields locally and after the Meilisearch backend swap, so `"원산갈마해안관광지구 준공식"` excludes documents that only scatter those terms across unrelated text. Negative terms and phrases are also honored: `원산 -갈마` or `원산 -"항구 새 소식"` keeps the visible query shareable while filtering out matching indexed fields. Required-term markers are accepted too: `원산 AND 갈마`, `+원산 +갈마`, and `+"원산갈마 관광지구"` normalize to the same strict term or phrase search without sending literal `AND` or `+` markers to the backend. Field-scoped operators are also parsed locally and after the backend swap: `intitle:`/`allintitle:` restrict terms to titles, `intext:`/`allintext:` restrict terms to indexed snippet/body text, and `inurl:`/`allinurl:` restrict terms to URL fields while preserving the original shareable query.

`NOT` is accepted as the readable form of the same negative syntax: `원산 NOT 갈마` and `원산 NOT "항구 새 소식"` keep the visible text query shareable while applying the existing exclusion filter, and structured forms such as `원산 NOT site:kcna.kp`, `원산 NOT filetype:pdf`, and `원산 NOT lang:en` canonicalize into the same `exclude_source`, `exclude_type`, and `exclude_lang` route state as `-site:`, `-filetype:`, and `-lang:`.

Local JSON search mirrors the backend's strict multi-word behavior for development: space-separated query terms are treated as required term groups across title, snippet/body, explicit aliases, and source name. That keeps searches like `평양 야경` useful without allowing a document that only matches `평양` or only matches `야경` to appear. Known English entity aliases such as `Wonsan`, `Kalma`, and `Kim Jong Un Wonsan Kalma` are normalized to their Korean canonical search terms before strict retrieval, so Korean and English entry points share the same real indexed coverage.

When a query has no matching documents, the results page may show recovery links from the same suggestion index/dictionary used by autocomplete. It does not create fallback result cards, and it suppresses no-op suggestions that are identical to the submitted query.
