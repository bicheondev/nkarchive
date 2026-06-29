#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalJsonSearchProvider } from "../search/LocalJsonSearchProvider.js";
import { parseJsonl, stringifyJsonl, validateSearchIndex } from "../search/localIndex.js";
import { preserveCachedAssetFields } from "../search/cachedAssetFields.js";
import { enrichArchiveOriginalSourceUrls } from "../search/originalSourceLinks.js";
import { RESULT_TABS, groupResultsBySource } from "../search/resultFilters.js";
import { collapseDuplicateResults, createResultStoryKey, dedupeDocumentsByStory } from "../search/resultIdentity.js";
import { cleanDisplaySnippetText, getDocumentSearchTextQueries } from "../search/documentSearch.js";
import { enrichSearchResultPreviews, findRicherPreviewRecord, isWeakDocumentPreview } from "../search/previewEnrichment.js";
import { SEARCH_SOURCES } from "../search/sourceConfig.js";
import { MeilisearchSearchProvider } from "../search/MeilisearchSearchProvider.js";
import { normalizeKoreanSourceBodySpacing, normalizeKoreanSourceSpacing, SEARCH_SOURCE_TYPES } from "../search/schemas.js";
import { createSearchProvider } from "../search/provider.js";
import { auditSearchProductionBundle } from "./audit-search-production.ts";
import {
  discoverFeedEntries,
  discoverSitemapEntries,
  discoverEmbeddedDocumentEntries,
  discoverLinkEntries,
  discoverSourceEntries,
  crawlSources,
  createConfiguredSearchUrls,
  cleanSourceSearchContextText,
  extractDocumentFromReadableText,
  extractFeedDocumentFromEntry,
  extractSourceSearchDocumentFromEntry,
  enrichPdfDocumentWithReadableText,
  extractMediaDocumentFromLink,
  extractPdfDocumentFromLink,
  fetchTextResource,
  isRobotsAllowed,
  parseRobotsTxt,
  writeImportOutput,
} from "./search-crawler-utils.ts";
import { fetchKoryoVodDocuments } from "./import-koryo-vod.ts";
import { buildSearchSeed } from "./seed-search.ts";
import { syncMeilisearchPayload } from "./sync-meilisearch.ts";
import { createReleaseSteps, getMissingReleaseEnvironment, parseReleaseOptions } from "./release-search-production.ts";
import { parseDotEnv } from "./script-env.ts";
import { normalizeBaseUrl, verifyProductionSearch } from "./verify-search-production.ts";
import { cacheSearchAssets, createAssetFetchUrl, getAssetCacheCandidates, inferExtension } from "./cache-search-assets.ts";
import { uploadSearchAssetsToR2, createR2ObjectKey, createR2PublicUrl } from "./upload-search-assets-r2.ts";
import { connectSearchSuggestions, createSearchSuggestions, updateSearchSuggestions } from "../components/SearchSuggestions.js";
import { createSourceResultCard } from "../components/SourceResultCard.js";
import searchAssetHandler from "../api/search-asset.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(ROOT_DIR, "test/fixtures/search");
const PRODUCTION_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/search/documents.jsonl");

const OLD_MOCK_RESULT_TITLES = [
  "끝없이 넘쳐나는 인민의 행복 화성지구의 새 거리가 새집들이 ...",
  "화성지구 4단계 거리 사진 모음",
  "평양 새 살림집 입주 소식",
  "Respected Comrade Kim Jong Un Guides Construction Sector",
];
const FORBIDDEN_MANUAL_WONSAN_BACKFILL_IDS = new Set([
  "rodong-sinmun-wonsan-kalma-ceremony-2025-06-26",
  "voice-of-korea-wonsan-kalma-ceremony-2025-06-26",
  "kcna-wonsan-kalma-ceremony-2025-06-26",
  "kcna-wonsan-kalma-kim-jong-un-ceremony-2025-06-26",
]);
const KCNA_WONSAN_KALMA_CEREMONY_URL = "http://www.kcna.kp/kp/article/q/39fe6d16626f743979dbf8421474aca9.kcmsf";
const KCNA_WONSAN_KALMA_SERVICE_URL = "http://www.kcna.kp/kp/article/q/7814962e12328ec63931b157c5b3d5ceae3d0eb9cfe8dcd1cfb706a70acfaa0f2a339be80aceaeaf7192c1713ecd8235.kcmsf";
const KCNA_WONSAN_KALMA_CATEGORY_SEED_URLS = [
  "http://www.kcna.kp/kp/category/articles/q/54c0ca4ca013a92cc9cf95bd4004c61a.kcmsf?page=16",
  "http://www.kcna.kp/kp/category/articles/q/5394b80bdae203fadef02522cfb578c0.kcmsf?page=33",
];

async function main() {
  const [fixtureDocuments, fixtureSources, productionDocumentsText] = await Promise.all([
    readJsonl(path.join(FIXTURE_DIR, "documents.jsonl")),
    readJson(path.join(FIXTURE_DIR, "sources.json")),
    fs.readFile(PRODUCTION_DOCUMENTS_PATH, "utf8"),
  ]);

  await assertProductionProviderDoesNotImportMocks();
  await assertProviderSupportsBrowserRuntimeConfig();
  await assertProviderFallsBackToLocalIndexWhenBackendFails(fixtureDocuments, fixtureSources);
  await assertLocalJsonProviderRetriesTransientIndexFailures(fixtureDocuments, fixtureSources);
  await assertNoHardcodedResultTitlesInRuntime();
  await assertNormalizeModuleDoesNotOwnDocumentRetrieval();
  await assertProductionIndexStorageIsSourceLike(productionDocumentsText);
  await assertSearchNavigationIsAccessible();
  await assertProjectShellNavigationIsAccessible();
  await assertDeploymentConfigIsProductionReady();
  await assertProductionReleaseRunnerIsSafe();
  await assertHomeSearchStartsBlank();
  await assertSearchSuggestionsAreKeyboardAccessible();
  await assertSearchSuggestionKeyboardPreviewRestoresTypedQuery();
  await assertSearchTabsAreAccessible();
  await assertSearchStatesAreAnnounced();
  await assertSearchShortcutIsFunctional();
  await assertBlankSubmitDoesNotNavigate();
  await assertResultsTitleIncludesQuery();
  await assertResultsUrlsAreCanonical();
  await assertBlankSuggestionsDoNotLoadIndex();
  await assertFigmaSourceLogosAreLocalAssets();
  await assertFallbackSourceLogosAreCompactBadges();
  await assertYouTubeSourceCardMatchesFigmaDesign();
  await assertExternalResultLinksDoNotLeakReferrers();
  await assertResultCardsExposeTrustMetadata();
  await assertKcnaWatchArchiveCardsRenderOriginalSourcePills();
  await assertResultCardsOpenInternalDocumentViewer();
  await assertSourceCardsHideRedundantMoreLinks();
  await assertImageTabRendersImageGrid();
  await assertSearchAssetsAreMirrorReady();
  await assertEmptyIndexState();
  await assertNoResultsOfferIndexedSuggestions(fixtureDocuments, fixtureSources);
  await assertFixtureSearchWorksOnlyInTests(fixtureDocuments, fixtureSources, productionDocumentsText);
  await assertHwaseongSearchDoesNotReturnWeakResults(productionDocumentsText);
  await assertDecoratedShipNameSearchMatchesIndexedTitles(productionDocumentsText);
  await assertFullWidthSearchNormalization();
  await assertKoreanSourceSpacingIsNormalized();
  await assertBroadEnglishPrefixesDoNotExpandIntoEntityResults();
  await assertSourceNameQueriesPrioritizeMatchingSource(productionDocumentsText);
  await assertMultiTermLocalSearchRequiresEveryTerm();
  await assertQuotedPhraseSearchRequiresExactPhrase();
  await assertExcludedTermSearchFiltersResults();
  await assertOrSearchSupportsAlternatives();
  await assertRequiredOperatorSyntaxBehavesLikeStrictTerms();
  await assertTitleRestrictedSearchRequiresTitleMatches();
  await assertUrlRestrictedSearchRequiresUrlMatches();
  await assertAllScopedSearchOperatorsRequireFollowingTerms();
  await assertTextRestrictedSearchRequiresTextMatches();
  await assertBodyOnlyMatchesDoNotOutrankTitleOrSnippetMatches();
  await assertDatelineOnlyMatchesDoNotBehaveLikeSubstantiveSnippets();
  await assertResultCardsRenderQueryAwareExcerpts();
  await assertResultSnippetsSuppressArchiveDuplicateChrome();
  await assertResultSnippetsSuppressDateOnlyChrome(productionDocumentsText);
  await assertDuplicateStoryResultsAreCollapsed();
  await assertVoiceOfKoreaChromeDoesNotWinPreviewSelection();
  await assertEquivalentSourceTitlesCanShareRicherPreviews();
  await assertDistantPageChromeDoesNotDriveSearch(productionDocumentsText);
  await assertSuggestionsUseIndexAndKnownEntities(fixtureDocuments, fixtureSources);
  await assertChoseongSearchIsDisabled(fixtureDocuments, fixtureSources);
  await assertPdfTabShowsLiteratureOnly();
  await assertPdfLinksBecomeDocuments();
  await assertReadableSnapshotsBecomeDocuments();
  await assertReadableMediaAssetsBecomeDocuments();
  await assertRodongReadableListingsBecomeDocuments();
  await assertNaenaraReadableTablesBecomeDocuments();
  await assertFetchCacheFallsBackToRealStoredResponses();
  await assertCrawlerFetchHonorsHttpProxyEnv();
  await assertFeedItemsBecomeDocuments();
  await assertSitemapEntriesBecomeCrawlerFrontier();
  await assertSourceSearchDiscoveryUsesRealSiteSearches();
  await assertKcnaWatchSearchFallbacksAreCleaned(productionDocumentsText);
  await assertWordPressApiEntriesBecomeDocuments();
  await assertDiscoveryFollowsListingPages();
  await assertListingFallbacksRecoverDetailFetchFailures();
  await assertCrawlerRespectsRobotsPolicy();
  await assertKoryoVodImporterRespectsRobotsPolicy();
  await assertProductionDocumentsDoNotIndexPageChrome(productionDocumentsText);
  await assertProductionKcnaDatelineDatesMatch(productionDocumentsText);
  await assertProductionDocumentsDoNotIndexRodongPageChrome(productionDocumentsText);
  await assertProductionVoiceOfKoreaDocumentsDoNotIndexRepeatedPageChrome(productionDocumentsText);
  await assertProductionChosonSinboDocumentsUseArticleText(productionDocumentsText);
  await assertArchiveOriginalSourceUrlsAreLinked(productionDocumentsText);
  await assertProductionWonsanCoverageSpansMultipleSources(productionDocumentsText);
  await assertProductionDocumentsDoNotIndexGenericNaenaraSections(productionDocumentsText);
  await assertProductionDocumentsIncludeNaenaraRows(productionDocumentsText);
  await assertProductionDocumentsIncludeMinjuRows(productionDocumentsText);
  await assertProductionDocumentsDoNotIndexUtilityPages(productionDocumentsText);
  await assertFailedImportPreservesExistingDocuments();
  await assertImportPipelineHasRuntimeGuards();
  await assertSourceCatalogMatchesGoal();
  await assertYouTubeMetadataImporterIsScoped();
  await assertProductionDocumentsStayInsideConfiguredSources(productionDocumentsText);
  await assertProductionVideoDocumentsAreVisibleInAll(productionDocumentsText);
  await assertSourceHealthCoversCatalog();
  await assertProductionAuditPasses();
  await assertSearchSeedIsBackendReady();
  await assertMeilisearchSyncReplacesIndexesExactly();
  await assertMeilisearchProviderUsesVisibleTabs();
  await assertMeilisearchProviderPromotesExactSourceNameQueries();
  await assertMeilisearchProviderKeepsFormattedSnippets();
  await assertMeilisearchProviderCompletesSearchOperators();
  await assertMeilisearchProviderNormalizesQueries();
  await assertGroupedResultsKeepSourceMetadata();
  await assertSourceFacetsExposeRealCounts();
  await assertLocalSourceFiltersUsePhysicalSourceIds();
  await assertSearchOperatorsUseVisibleSourceFilters();
  await assertResultsShowProviderBackedSummary();
  await assertResultsSupportShareableSortModes();
  await assertDateFiltersHaveVisibleClearState();
  await assertSourceFilteringHasClearState();
  await assertSourceFilteredCardsCanRenderFullResultPage();
  await assertResultsPaginationUsesProviderOffsets();
  await assertDocumentViewerUsesRicherIndexedPreview();
  await assertBackendDocumentLookupsPreservePreviewFields();
  await assertWeakArticleResultsUseRicherIndexedPreview(productionDocumentsText);
  await assertYouTubeVideosAppearInAll();
  await assertVideosAppearInAll();

  console.log("Search correctness tests passed.");
}

async function assertProductionProviderDoesNotImportMocks() {
  const providerSource = await fs.readFile(path.join(ROOT_DIR, "search/provider.js"), "utf8");
  assert.equal(providerSource.includes("mockDocuments"), false, "production provider must not import mockDocuments");
  assert.equal(providerSource.includes("MockSearchProvider"), false, "production provider must not import MockSearchProvider");
}

async function assertProviderSupportsBrowserRuntimeConfig() {
  const [homeHtml, resultsHtml, documentHtml, configSource, readme, css, normalizeSource, packageJson] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/index.html"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/results/index.html"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/document/index.html"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search-config.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "README.md"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/normalizeQuery.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "package.json"), "utf8"),
  ]);
  const provider = createSearchProvider({
    meilisearch: {
      host: "https://meili.example.test",
      apiKey: "public-search-key",
    },
  });
  const originalConfig = globalThis.DPRK_SEARCH_CONFIG;
  globalThis.DPRK_SEARCH_CONFIG = {
    meilisearch: {
      host: "https://runtime.example.test",
      apiKey: "runtime-search-key",
    },
  };
  const runtimeProvider = createSearchProvider();
  globalThis.DPRK_SEARCH_CONFIG = originalConfig;

  assert.equal(provider.constructor?.name, "ResilientSearchProvider", "browser runtime config should wrap Meilisearch with a real-index fallback provider");
  assert.equal(provider.primary?.constructor?.name, "MeilisearchSearchProvider", "browser runtime config should select Meilisearch as the primary provider");
  assert.equal(provider.host, "https://meili.example.test", "browser runtime config should pass the configured Meilisearch host");
  assert.equal(runtimeProvider.constructor?.name, "ResilientSearchProvider", "default provider creation should wrap runtime Meilisearch with a fallback provider");
  assert.equal(runtimeProvider.primary?.constructor?.name, "MeilisearchSearchProvider", "default provider creation should read DPRK_SEARCH_CONFIG for the primary provider");
  assert.equal(runtimeProvider.host, "https://runtime.example.test", "default provider creation should use the runtime config host");
  assert.equal(homeHtml.includes("/search/search-config.js"), true, "home page should load runtime search config before the portal module");
  assert.equal(resultsHtml.includes("/search/search-config.js"), true, "results page should load runtime search config before the portal module");
  assert.equal(homeHtml.indexOf("/search/search-config.js") < homeHtml.indexOf("/search/searchPortal.js"), true, "home runtime config should load before searchPortal");
  assert.equal(resultsHtml.indexOf("/search/search-config.js") < resultsHtml.indexOf("/search/searchPortal.js"), true, "results runtime config should load before searchPortal");
  for (const [name, source] of [["home", homeHtml], ["results", resultsHtml], ["document", documentHtml], ["css", css]]) {
    assert.equal(/https:\/\/(?:esm\.sh|cdn\.jsdelivr\.net)|type=["']importmap["']|@toss\/es-hangul/i.test(source), false, `${name} search runtime should not depend on CDN-hosted modules or styles`);
  }
  assert.equal(normalizeSource.includes("function convertQwertyToHangulText"), true, "search query normalization should keep qwerty Hangul conversion in the local runtime");
  assert.equal(normalizeSource.includes("function disassembleHangul"), true, "search query normalization should keep Hangul disassembly in the local runtime");
  assert.equal(packageJson.includes("@toss/es-hangul"), false, "browser search runtime should not require the es-hangul CDN/package dependency");
  assert.equal(configSource.includes("window.DPRK_SEARCH_CONFIG"), true, "runtime search config should expose DPRK_SEARCH_CONFIG on window");
  assert.equal(configSource.includes("globalThis.DPRK_SEARCH_CONFIG"), true, "runtime search config should mirror DPRK_SEARCH_CONFIG onto globalThis");
  assert.equal(configSource.includes("searchConfigLoaded"), true, "runtime search config should leave a DOM-visible loaded marker");
  assert.equal(readme.includes("search/search-config.js"), true, "README should document browser runtime search config");
  assert.equal(readme.includes("window.DPRK_SEARCH_CONFIG"), true, "README should show browser-safe runtime config syntax");
  assert.equal(readme.includes("globalThis.DPRK_SEARCH_CONFIG"), true, "README should show globalThis runtime config mirroring");
}

async function assertProviderFallsBackToLocalIndexWhenBackendFails(fixtureDocuments, fixtureSources) {
  const provider = createSearchProvider({
    meilisearch: {
      host: "https://meili-down.example.test",
      apiKey: "public-search-key",
      fetchImpl: async () => {
        throw new Error("backend unavailable");
      },
    },
    local: {
      documents: fixtureDocuments,
      sources: fixtureSources,
    },
  });

  const result = await provider.searchDocuments("화성");
  const suggestions = await provider.getSuggestions("화성");
  const record = await provider.getDocumentById("fixture-hwaseong-article");

  assert.equal(provider.constructor?.name, "ResilientSearchProvider", "configured backend provider should expose a resilient wrapper");
  assert.equal(result.documents[0]?.id, "fixture-hwaseong-article", "backend search failures should fall back to the checked-in real JSON index");
  assert.equal(suggestions.some((suggestion) => suggestion.label.includes("화성")), true, "backend suggestion failures should fall back to local real-index suggestions");
  assert.equal(record?.id, "fixture-hwaseong-article", "backend document lookup failures should fall back to local document lookup");
  assert.equal(provider.lastFallback?.message, "backend unavailable", "fallback diagnostics should keep the backend failure message");
}

async function assertLocalJsonProviderRetriesTransientIndexFailures(fixtureDocuments, fixtureSources) {
  const fetchCalls = [];
  let failedDocumentFetch = false;
  const provider = new LocalJsonSearchProvider({
    documentsUrl: "/test-documents.jsonl",
    sourcesUrl: "/test-sources.json",
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      fetchCalls.push(requestUrl);
      if (requestUrl.endsWith("/test-documents.jsonl")) {
        if (!failedDocumentFetch) {
          failedDocumentFetch = true;
          throw new Error("transient documents outage");
        }
        return new Response(stringifyJsonl(fixtureDocuments), { status: 200 });
      }
      if (requestUrl.endsWith("/test-sources.json")) {
        return new Response(JSON.stringify(fixtureSources), { status: 200 });
      }
      throw new Error(`Unexpected local search index URL: ${requestUrl}`);
    },
  });

  await assert.rejects(
    () => provider.searchDocuments("화성"),
    /transient documents outage/,
    "initial local index load failures should be surfaced to the UI",
  );

  const result = await provider.searchDocuments("화성");
  const callsAfterRetry = fetchCalls.length;
  provider.fetchImpl = async () => {
    throw new Error("loaded local index should be reused without refetching");
  };
  const record = await provider.getDocumentById("fixture-hwaseong-article");
  const suggestions = await provider.getSuggestions("화성");

  assert.equal(result.documents[0]?.id, "fixture-hwaseong-article", "transient local JSON failures should be retried on the next search");
  assert.equal(fetchCalls.filter((url) => url.endsWith("/test-documents.jsonl")).length, 2, "failed local document loads should not poison future load attempts");
  assert.equal(record?.id, "fixture-hwaseong-article", "successfully loaded local indexes should be reused for document lookups");
  assert.equal(suggestions.some((suggestion) => suggestion.label.includes("화성")), true, "successfully loaded local indexes should be reused for suggestions");
  assert.equal(fetchCalls.length, callsAfterRetry, "cached local indexes should avoid repeated JSON downloads after a successful load");
}

async function assertNoHardcodedResultTitlesInRuntime() {
  const runtimeFiles = await listRuntimeFiles([
    path.join(ROOT_DIR, "search"),
    path.join(ROOT_DIR, "components"),
    path.join(ROOT_DIR, "data/search"),
  ]);
  for (const filePath of runtimeFiles) {
    const text = await fs.readFile(filePath, "utf8");
    for (const title of OLD_MOCK_RESULT_TITLES) {
      assert.equal(text.includes(title), false, `${path.relative(ROOT_DIR, filePath)} contains hardcoded result title: ${title}`);
    }
  }
}

async function assertNormalizeModuleDoesNotOwnDocumentRetrieval() {
  const normalizeSource = await fs.readFile(path.join(ROOT_DIR, "search/normalizeQuery.js"), "utf8");

  assert.equal(normalizeSource.includes("export function searchDocuments"), false, "normalizeQuery must not expose a second document-search implementation");
  assert.equal(normalizeSource.includes("createDocumentSearchText"), false, "document field selection must stay in documentSearch/provider code, not query normalization");
}

async function assertProductionIndexStorageIsSourceLike(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const productionSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));

  assert.equal(
    productionDocuments.some((document) => "searchFields" in document),
    false,
    "stored production documents must not ship provider-generated searchFields",
  );
  assert.equal(
    productionSources.some((source) => "searchFields" in source),
    false,
    "stored production sources must not ship provider-generated searchFields",
  );
}

async function assertSearchNavigationIsAccessible() {
  const [homeHtml, resultsHtml, documentHtml, css, portalSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/index.html"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/results/index.html"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/document/index.html"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
  ]);

  for (const [name, html] of [["search/index.html", homeHtml], ["search/results/index.html", resultsHtml], ["search/document/index.html", documentHtml]]) {
    assert.equal(html.includes('id="searchNavMenu"'), true, `${name} should expose a controlled mobile nav menu region`);
    assert.equal(html.includes('aria-controls="searchNavMenu"'), true, `${name} menu button should control the nav region`);
    assert.equal(html.includes('aria-expanded="false"'), true, `${name} menu button should start collapsed`);
    assert.equal(html.includes('href="#"'), false, `${name} should not ship dead placeholder navigation links`);
    assert.equal(html.includes('aria-disabled="true"'), true, `${name} should mark unavailable nav destinations as disabled text`);
    assert.equal(html.includes('aria-label="검색 홈"'), true, `${name} logo link should use a Korean accessible name`);
    assert.equal(html.includes('aria-label="주요 메뉴"'), true, `${name} primary navigation should use a Korean accessible name`);
    assert.equal(html.includes('aria-label="Search home"'), false, `${name} should not expose English logo labels inside the Korean search portal`);
    assert.equal(html.includes('aria-label="Primary"'), false, `${name} should not expose English nav labels inside the Korean search portal`);
  }

  assert.equal(css.includes("body.search-nav-open .search-nav-menu"), true, "mobile nav CSS should render the collapsed menu when opened");
  assert.equal(css.includes(".search-nav-disabled"), true, "disabled nav destinations should keep explicit styling");
  assert.equal(/letter-spacing:\s*-\d/.test(css), false, "search UI CSS should not use negative letter spacing");
  assertCssCustomPropertiesResolved(css, "search/search.css");
  assert.equal(portalSource.includes("initializeSearchNavigation"), true, "search portal should initialize mobile nav behavior");
  assert.equal(portalSource.includes('event.key === "Escape"'), true, "mobile nav should close from Escape");
}

async function assertProjectShellNavigationIsAccessible() {
  const [homeHtml, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "index.html"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "styles.css"), "utf8"),
  ]);

  const navMatch = homeHtml.match(/<nav class="site-nav"[\s\S]*?<\/nav>/);
  assert.notEqual(navMatch, null, "project shell should keep a primary navigation region");
  assert.equal(homeHtml.includes('href="#"'), false, "project shell should not ship dead placeholder links anywhere in the page");
  const navHtml = navMatch?.[0] || "";
  assert.equal(navHtml.includes('href="#"'), false, "project shell navigation should not ship dead placeholder links");
  assert.equal(navHtml.includes('class="site-nav-disabled"'), true, "unavailable project shell destinations should render as disabled text");
  assert.equal(navHtml.includes('aria-disabled="true"'), true, "unavailable project shell destinations should expose disabled state");
  assert.equal(css.includes(".site-nav-disabled"), true, "disabled project shell nav destinations should keep explicit styling");
  assert.equal(homeHtml.includes('class="download-button" download'), true, "download card template should start without a placeholder URL before app.js assigns the real font asset");
  assert.equal((await fs.readFile(path.join(ROOT_DIR, "app.js"), "utf8")).includes('card.querySelector(".download-button").href = encodeFontUrl(assetUrl(font.path));'), true, "project shell should assign real font download URLs when rendering cards");
}

async function assertDeploymentConfigIsProductionReady() {
  const [
    vercelConfig,
    envExample,
    packageJson,
    readme,
    envLoaderSource,
    releaseSource,
    ciSource,
    bundleVerifierSource,
    searchCiWorkflow,
    productionReleaseWorkflow,
    vercelIgnore,
    gitIgnore,
    syncSource,
    uploadSource,
    importSource,
  ] = await Promise.all([
    readJson(path.join(ROOT_DIR, "vercel.json")),
    fs.readFile(path.join(ROOT_DIR, ".env.example"), "utf8"),
    readJson(path.join(ROOT_DIR, "package.json")),
    fs.readFile(path.join(ROOT_DIR, "README.md"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/script-env.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/release-search-production.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/ci-search-release.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/verify-vercel-bundle.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, ".github/workflows/search-ci.yml"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, ".github/workflows/search-production-release.yml"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, ".vercelignore"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, ".gitignore"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/sync-meilisearch.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/upload-search-assets-r2.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/import-search-index.ts"), "utf8"),
  ]);

  assert.equal(vercelConfig.functions?.["api/search-asset.js"]?.maxDuration >= 30, true, "Vercel config should give the asset proxy enough time for slow source hosts");
  const rewriteMap = new Map((vercelConfig.rewrites || []).map((entry) => [entry.source, entry.destination]));
  assert.equal(rewriteMap.get("/search"), "/search/index.html", "Vercel config should rewrite /search to the search shell");
  assert.equal(rewriteMap.get("/search/"), "/search/index.html", "Vercel config should rewrite /search/ to the search shell");
  assert.equal(rewriteMap.get("/search/results"), "/search/results/index.html", "Vercel config should rewrite extensionless result routes to the result shell");
  assert.equal(rewriteMap.get("/search/results/"), "/search/results/index.html", "Vercel config should rewrite trailing-slash result routes to the result shell");
  assert.equal(rewriteMap.get("/search/document"), "/search/document/index.html", "Vercel config should rewrite extensionless document routes to the document shell");
  assert.equal(rewriteMap.get("/search/document/"), "/search/document/index.html", "Vercel config should rewrite trailing-slash document routes to the document shell");
  const headerSources = new Set((vercelConfig.headers || []).map((entry) => entry.source));
  assert.equal(headerSources.has("/data/search/assets/(.*)"), true, "Vercel config should cache mirrored search assets aggressively");
  assert.equal(headerSources.has("/data/search/(.*)"), true, "Vercel config should explicitly cache indexed search data");
  assert.equal(headerSources.has("/search/(.*)"), true, "Vercel config should attach basic security headers to search pages");
  for (const requiredEnv of [
    "MEILISEARCH_HOST",
    "MEILISEARCH_KEY",
    "DPRK_SEARCH_ASSET_PROXY",
    "DPRK_SEARCH_PUBLIC_BASE_URL",
    "R2_PUBLIC_BASE_URL",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "HTTPS_PROXY",
  ]) {
    assert.equal(envExample.includes(requiredEnv), true, `.env.example should document ${requiredEnv}`);
  }
  assert.equal(packageJson.scripts["preflight:search"], "node scripts/preflight-search-release.ts", "package scripts should expose the production search preflight");
  assert.equal(packageJson.scripts["release:search"], "node scripts/release-search-production.ts", "package scripts should expose the final production release runner");
  assert.equal(packageJson.scripts["ci:search"], "node scripts/ci-search-release.ts", "package scripts should expose the no-secret search CI gate");
  assert.equal(packageJson.scripts["verify:search-production"], "node scripts/verify-search-production.ts", "package scripts should expose the deployed search verification gate");
  assert.equal(packageJson.scripts["verify:vercel-bundle"], "node scripts/verify-vercel-bundle.ts", "package scripts should expose the local Vercel bundle verification gate");
  assert.equal(envExample.includes("meilisearch-write-key"), true, ".env.example should describe MEILISEARCH_KEY as a write-capable release key instead of a browser-only key");
  assert.equal(envExample.includes("VERCEL_TOKEN"), true, ".env.example should document optional non-interactive Vercel deploy credentials");
  assert.equal(envLoaderSource.includes("loadDotEnvFile"), true, "release scripts should have a shared .env loader");
  assert.equal(envLoaderSource.includes("override = false"), true, ".env loader should not override shell or platform environment by default");
  assert.equal(releaseSource.includes("loadDotEnvFile()"), true, "release runner should load .env before checking production environment");
  assert.equal(ciSource.includes("test:search"), true, "CI search gate should run the full correctness suite");
  assert.equal(ciSource.includes("verify:vercel-bundle"), true, "CI search gate should verify Vercel deploy bundle contents");
  assert.equal(ciSource.includes("release:search"), true, "CI search gate should finish with the release dry run");
  assert.equal(bundleVerifierSource.includes("data/search/documents.jsonl"), true, "Vercel bundle verifier should require browser search documents in the deploy upload");
  assert.equal(bundleVerifierSource.includes("/search/results/"), true, "Vercel bundle verifier should require trailing-slash search result rewrites");
  assert.equal(bundleVerifierSource.includes("data/search/meilisearch-seed.json"), true, "Vercel bundle verifier should reject server-only seed payload uploads");
  assert.equal(searchCiWorkflow.includes("npm run ci:search"), true, "GitHub pull request CI should run the no-secret search gate");
  assert.equal(searchCiWorkflow.includes('node-version: "26"'), true, "GitHub search CI should use the Node runtime that supports the repository scripts");
  assert.equal(productionReleaseWorkflow.includes("workflow_dispatch"), true, "GitHub production release should be a manually triggered workflow");
  assert.equal(productionReleaseWorkflow.includes("npm run release:search"), true, "GitHub production release workflow should call the same release runner used locally");
  assert.equal(productionReleaseWorkflow.includes("--confirm-production"), true, "GitHub production release workflow should require the mutating production release flag");
  assert.equal(productionReleaseWorkflow.includes('args+=(--proxy "${{ inputs.proxy }}")'), true, "GitHub production release workflow should pass the crawler proxy only to the release runner");
  assert.equal(productionReleaseWorkflow.includes("HTTP_PROXY:"), false, "GitHub production release workflow should not route npm, Meilisearch, or R2 through the crawler proxy at job scope");
  assert.equal(productionReleaseWorkflow.includes("HTTPS_PROXY:"), false, "GitHub production release workflow should not route HTTPS infrastructure calls through the crawler proxy at job scope");
  assert.equal(productionReleaseWorkflow.includes("secrets.MEILISEARCH_KEY"), true, "GitHub production release workflow should source Meilisearch credentials from secrets");
  assert.equal(productionReleaseWorkflow.includes("secrets.R2_SECRET_ACCESS_KEY"), true, "GitHub production release workflow should source R2 credentials from secrets");
  assert.equal(vercelIgnore.includes("data/import/"), true, "Vercel deploys should exclude crawler fetch caches and importer intermediates");
  assert.equal(vercelIgnore.includes("data/search/meilisearch-seed.json"), true, "Vercel deploys should exclude the server-side Meilisearch seed payload");
  assert.equal(vercelIgnore.includes("data/search/documents.jsonl"), false, "Vercel deploys must still include the browser local search documents");
  assert.equal(vercelIgnore.includes("data/search/sources.json"), false, "Vercel deploys must still include the browser local search source catalog");
  assert.equal(gitIgnore.includes("data/import/"), true, "Git commits should exclude crawler fetch caches and importer intermediates");
  assert.equal(gitIgnore.includes("data/search/meilisearch-seed.json"), true, "Git commits should exclude the regenerable server-side Meilisearch seed payload");
  assert.equal(syncSource.includes("loadDotEnvFile()"), true, "Meilisearch sync should load .env for direct operator runs");
  assert.equal(uploadSource.includes("loadDotEnvFile()"), true, "R2 asset upload should load .env for direct operator runs");
  assert.equal(importSource.includes("loadDotEnvFile()"), true, "top-level importer should load .env for crawler proxy configuration");
  assert.equal(readme.includes("load `.env` automatically"), true, "README should document automatic .env loading for operational scripts");
  assert.equal(readme.includes("verify:search-production"), true, "README should document deployed-site search verification");
  assert.equal(readme.includes("ci:search"), true, "README should document the no-secret CI search gate");
  assert.equal(readme.includes("search-production-release.yml"), true, "README should document the manual production release workflow");
}

async function assertProductionReleaseRunnerIsSafe() {
  assert.deepEqual(parseDotEnv(`
    # comment
    MEILISEARCH_HOST=https://search.example.org
    export R2_BUCKET="nkarchive search"
    R2_REGION=auto # inline comment
  `), {
    MEILISEARCH_HOST: "https://search.example.org",
    R2_BUCKET: "nkarchive search",
    R2_REGION: "auto",
  }, ".env parser should handle comments, export prefixes, quoted values, and inline comments");

  const dryRunOptions = parseReleaseOptions(["--proxy", "http://34.11.153.107:3128", "--skip-smoke"], {});
  assert.equal(dryRunOptions.dryRun, true, "release runner should default to a non-mutating dry run unless production is confirmed");
  assert.deepEqual(dryRunOptions.forwardedPreflightArgs, ["--skip-smoke", "--proxy", "http://34.11.153.107:3128"], "release runner should forward live-smoke options to preflight");

  const productionOptions = parseReleaseOptions(["--confirm-production", "--deploy-vercel"], {});
  const missingEnv = getMissingReleaseEnvironment(productionOptions, {});
  assert.deepEqual(missingEnv, [
    "MEILISEARCH_HOST or MEILI_HOST",
    "MEILISEARCH_KEY or MEILI_MASTER_KEY or MEILI_API_KEY",
    "R2_PUBLIC_BASE_URL",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT or R2_ACCOUNT_ID",
    "VERCEL_TOKEN",
    "VERCEL_ORG_ID",
    "VERCEL_PROJECT_ID",
    "DPRK_SEARCH_PUBLIC_BASE_URL or VERCEL_PROJECT_PRODUCTION_URL or VERCEL_URL",
  ], "production release should fail closed when required Meilisearch, R2, Vercel, or public verification environment is missing");

  const dryRunSteps = createReleaseSteps(dryRunOptions, missingEnv);
  assert.deepEqual(dryRunSteps.map((step) => step.label), [
    "search release preflight",
    "search asset R2 upload dry run",
    "Meilisearch sync dry run",
    "production search verification check",
  ], "dry-run release should still exercise the non-mutating release gates");
  assert.equal(dryRunSteps[1]?.skipReason, "R2 environment is not fully configured", "dry-run release should not call the R2 uploader when credentials are absent");
  assert.deepEqual(dryRunSteps[2]?.args, ["run", "sync:meilisearch", "--", "--dry-run"], "dry-run release should not mutate Meilisearch");
  assert.equal(dryRunSteps[3]?.skipReason, "production search URL is not configured", "dry-run release should not call deployed-site verification when no public URL is configured");

  const productionSteps = createReleaseSteps(parseReleaseOptions([
    "--confirm-production",
    "--deploy-vercel",
    "--verify-url",
    "https://nkarchive.vercel.app",
  ], {}), []);
  assert.deepEqual(productionSteps.map((step) => step.label), [
    "search release preflight",
    "search asset R2 upload",
    "Meilisearch sync",
    "Vercel project link",
    "Vercel production deploy",
    "production search verification",
  ], "confirmed production release should run preflight, R2 upload, Meilisearch sync, Vercel project linking, optional Vercel deploy, and deployed-site verification in order");
  assert.deepEqual(productionSteps[2]?.args, ["run", "sync:meilisearch", "--", "--wait"], "production release should wait for Meilisearch tasks to complete");
  assert.deepEqual(productionSteps[3]?.args.slice(0, 5), ["--yes", "vercel", "pull", "--yes", "--environment=production"], "production release should pull Vercel project settings before deploy");
  assert.deepEqual(productionSteps[5]?.args, ["run", "verify:search-production", "--", "--base-url", "https://nkarchive.vercel.app"], "production release should verify the public deployed search URL after sync/deploy");

  const [documentsText, sourcesText] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "data/search/documents.jsonl"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "data/search/sources.json"), "utf8"),
  ]);
  const deployedVerification = await verifyProductionSearch({
    baseUrl: "nkarchive.vercel.app/search",
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/search/" || pathname === "/search/results/") return new Response('<script src="/search/searchPortal.js"></script>', { status: 200 });
      if (pathname === "/data/search/sources.json") return new Response(sourcesText, { status: 200 });
      if (pathname === "/data/search/documents.jsonl") return new Response(documentsText, { status: 200 });
      return new Response("not found", { status: 404 });
    },
  });
  assert.equal(normalizeBaseUrl("nkarchive.vercel.app/search"), "https://nkarchive.vercel.app/search", "production verifier should normalize bare host URLs to HTTPS");
  assert.equal(deployedVerification.coverage.some((entry) => entry.query === "원산"), true, "deployed verifier should run critical Wonsan coverage checks");
  assert.equal(deployedVerification.documents.length > 2000, true, "deployed verifier should validate the public deployed search index payload");
}

async function assertHomeSearchStartsBlank() {
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");

  assert.equal(portalSource.includes('const DEFAULT_QUERY = "";'), true, "/search should start as a clean initial search screen");
  assert.equal(portalSource.includes('const DEFAULT_QUERY = "화성";'), false, "/search must not ship demo/example query state");
  assert.equal(portalSource.includes('const initialQuery = params.get("q") || DEFAULT_QUERY;'), true, "/search?q=... should still be able to prefill the home search input from the URL");
}

async function assertSearchSuggestionsAreKeyboardAccessible() {
  const [barSource, suggestionsSource, portalSource, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SearchBar.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "components/SearchSuggestions.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(barSource.includes("event.defaultPrevented"), true, "search bar should not override handled suggestion keys");
  assert.equal(barSource.includes('form.setAttribute("role", "search")'), true, "search form should expose search landmark semantics");
  assert.equal(barSource.includes('form.setAttribute("aria-label", "북한 공개자료 검색")'), true, "search form should have a durable accessible name");
  assert.equal(barSource.includes('input.setAttribute("aria-label", "검색어")'), true, "search input should not rely on placeholder text as its accessible name");
  assert.equal(barSource.includes('button.setAttribute("aria-label", "검색하기")'), true, "search submit button should have an explicit accessible name");
  assert.equal(suggestionsSource.includes("connectSearchSuggestions"), true, "suggestion component should expose keyboard connection behavior");
  assert.equal(suggestionsSource.includes('aria-autocomplete", "list"'), true, "search input should advertise list autocomplete");
  assert.equal(suggestionsSource.includes("aria-activedescendant"), true, "search input should track the active suggestion");
  assert.equal(suggestionsSource.includes('event.key === "ArrowDown"'), true, "suggestions should support ArrowDown");
  assert.equal(suggestionsSource.includes('event.key === "ArrowUp"'), true, "suggestions should support ArrowUp");
  assert.equal(suggestionsSource.includes('event.key === "Enter"'), true, "suggestions should support Enter selection");
  assert.equal(suggestionsSource.includes('event.key === "Escape"'), true, "suggestions should support Escape dismissal");
  assert.equal(suggestionsSource.includes("rememberNavigationValue"), true, "suggestion keyboard previews should remember the user's typed query");
  assert.equal(suggestionsSource.includes("restoreNavigationValue"), true, "Escape should restore the user's typed query after suggestion preview");
  assert.equal(suggestionsSource.includes("clearNavigationValue"), true, "typing new text or accepting a suggestion should clear stale preview state");
  assert.equal(suggestionsSource.includes('input.addEventListener("input", () => {\n    clearNavigationValue(list);\n    clearActiveSuggestion(input, list);\n  })'), true, "typing after previewing a suggestion should clear the stale active descendant immediately");
  assert.equal(suggestionsSource.includes("portal-suggestion-meta"), true, "suggestions should render compact provenance metadata");
  assert.equal(suggestionsSource.includes("createSuggestionAccessibleLabel"), true, "suggestion options should expose label and provenance as a readable accessible name");
  assert.equal(suggestionsSource.includes('button.setAttribute("aria-label", createSuggestionAccessibleLabel(suggestion))'), true, "suggestion option accessible names should not concatenate label and metadata");
  assert.equal(suggestionsSource.includes("applySuggestionDataset"), true, "suggestions should keep structured metadata for selection handlers");
  assert.equal(suggestionsSource.includes("button.dataset.sourceId = suggestion.sourceId || \"\""), true, "source suggestions should retain their source id through mouse selection");
  assert.equal(suggestionsSource.includes("getSuggestionSelection(active)"), true, "keyboard selection should pass structured suggestion metadata");
  assert.equal(portalSource.includes("connectSearchSuggestions(bar.input, suggestions"), true, "home/results search bars should connect to keyboardable suggestions");
  assert.equal(css.includes(".portal-suggestion.active"), true, "active suggestion should have the same visual affordance as hover/focus");
  assert.equal(css.includes(".portal-suggestion-meta"), true, "suggestion provenance metadata should have scoped styling");
  assert.equal(css.includes("top: calc(100% + 10px);"), true, "home suggestions should keep the Figma 10px search-bar offset");
  assert.equal(css.includes("top: 74px;"), true, "results suggestions should keep the same 10px offset below the 64px search bar");
}

async function assertSearchSuggestionKeyboardPreviewRestoresTypedQuery() {
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;
  globalThis.document = new TestDocument();
  globalThis.CustomEvent = class TestCustomEvent {
    constructor(type) {
      this.type = type;
    }
  };

  try {
    let selectedValue = "";
    let selectedSuggestion = null;
    const input = new TestElement("input");
    const list = createSearchSuggestions({ suggestions: [], onSelect: (value, suggestion) => {
      selectedValue = value;
      selectedSuggestion = suggestion || null;
    } });
    connectSearchSuggestions(input, list, { onSelect: (value, suggestion) => {
      selectedValue = value;
      selectedSuggestion = suggestion || null;
    } });

    input.value = "화성";
    updateSearchSuggestions(list, [
      {
        label: "화성지구 1단계",
        description: "추천어",
        highlightRanges: [{ start: 0, end: 2 }],
      },
      {
        label: "화성지구 살림집건설",
        description: "Fixture Daily · 기사",
        highlightRanges: [{ start: 0, end: 2 }],
      },
      {
        label: "로동신문",
        type: "source",
        sourceId: "rodong-sinmun",
        sourceName: "로동신문",
        description: "공식 자료원",
        highlightRanges: [],
      },
      {
        label: "site:rodong.rep.kp",
        value: "원산 site:rodong.rep.kp",
        type: "operator",
        description: "로동신문 · 공식 자료원",
        highlightRanges: [{ start: 5, end: 7 }],
      },
    ], (value, suggestion) => {
      selectedValue = value;
      selectedSuggestion = suggestion || null;
    });

    assert.equal(input.getAttribute("aria-expanded"), "true", "suggestion updates should expand the combobox");
    assert.equal(list.querySelectorAll(".portal-suggestion")[0]?.getAttribute("aria-label"), "화성지구 1단계, 추천어", "suggestion options should separate visible label from provenance metadata in their accessible name");
    assert.equal(list.querySelectorAll(".portal-suggestion")[2]?.dataset.sourceId, "rodong-sinmun", "source suggestion buttons should retain source ids for contextual navigation");
    assert.equal(list.querySelectorAll(".portal-suggestion")[3]?.dataset.value, "원산 site:rodong.rep.kp", "operator suggestions should retain the full replacement query separately from the visible label");

    const arrowDown = dispatchKeyboardEvent(input, "ArrowDown");
    assert.equal(arrowDown.defaultPrevented, true, "ArrowDown should be handled by the suggestion list");
    assert.equal(input.value, "화성지구 1단계", "ArrowDown should preview the active suggestion in the input");
    assert.equal(input.getAttribute("aria-activedescendant"), `${list.id}Option0`, "ArrowDown should expose the active suggestion id");

    input.value = "화성ㄱ";
    input.dispatchEvent({ type: "input" });
    assert.equal(input.getAttribute("aria-activedescendant"), null, "typing after a suggestion preview should immediately clear the active descendant");
    assert.equal(list.querySelectorAll(".portal-suggestion")[0]?.getAttribute("aria-selected"), "false", "typing after a suggestion preview should clear the selected option state");

    input.value = "화성";
    dispatchKeyboardEvent(input, "ArrowDown");
    const escape = dispatchKeyboardEvent(input, "Escape");
    assert.equal(escape.defaultPrevented, true, "Escape should be handled by the suggestion list");
    assert.equal(input.value, "화성", "Escape should restore the user's typed query after suggestion preview");
    assert.equal(list.hidden, true, "Escape should hide the suggestion list");
    assert.equal(input.getAttribute("aria-expanded"), "false", "Escape should collapse the combobox");
    assert.equal(input.getAttribute("aria-activedescendant"), null, "Escape should clear the active suggestion id");

    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.value = "화성";
    dispatchKeyboardEvent(input, "ArrowDown");
    const enter = dispatchKeyboardEvent(input, "Enter");
    assert.equal(enter.defaultPrevented, true, "Enter should select the active suggestion");
    assert.equal(selectedValue, "화성지구 1단계", "Enter should submit the active suggestion value");
    assert.equal(selectedSuggestion?.label, "화성지구 1단계", "Enter should pass structured suggestion metadata alongside the value");
    dispatchKeyboardEvent(input, "Escape");
    assert.equal(input.value, "화성지구 1단계", "Escape after accepting a suggestion should not restore a stale typed query");

    list.querySelectorAll(".portal-suggestion")[2]?.dispatchEvent({ type: "click" });
    assert.equal(selectedValue, "로동신문", "clicking a source suggestion should submit the source label");
    assert.equal(selectedSuggestion?.sourceId, "rodong-sinmun", "clicking a source suggestion should expose its source id");
    list.querySelectorAll(".portal-suggestion")[3]?.dispatchEvent({ type: "click" });
    assert.equal(selectedValue, "원산 site:rodong.rep.kp", "clicking an operator suggestion should submit the full replacement query");
    assert.equal(selectedSuggestion?.label, "site:rodong.rep.kp", "clicking an operator suggestion should preserve the visible completion label");
  } finally {
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
    if (originalCustomEvent === undefined) {
      delete globalThis.CustomEvent;
    } else {
      globalThis.CustomEvent = originalCustomEvent;
    }
  }
}

async function assertSearchTabsAreAccessible() {
  const [tabsSource, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SearchTabs.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(tabsSource.includes('role", "tablist"'), true, "results tabs should expose tablist semantics");
  assert.equal(tabsSource.includes('role", "tab"'), true, "each result tab should expose tab semantics");
  assert.equal(tabsSource.includes("aria-selected"), true, "result tabs should expose the active tab to assistive technology");
  assert.equal(tabsSource.includes("controlsId"), true, "result tabs should accept the controlled results panel id");
  assert.equal(tabsSource.includes("export function createSearchTabId"), true, "result tabs should share stable tab ids with the results panel");
  assert.equal(tabsSource.includes("button.id = createSearchTabId(tab.id)"), true, "result tab ids should use the shared id helper");
  assert.equal(tabsSource.includes('button.setAttribute("aria-controls", controlsId)'), true, "result tabs should point at the results panel they update");
  assert.equal(tabsSource.includes('if (isActive) return;'), true, "clicking the already active result tab should not push duplicate history or rerun search");
  assert.equal(tabsSource.includes('key === "ArrowRight"'), true, "result tabs should support keyboard navigation");
  assert.equal(tabsSource.includes('key === "Home"'), true, "result tabs should support Home/End keyboard shortcuts");
  assert.equal(css.includes(".source-result-source {\n    position: static;"), true, "mobile result cards should reveal source text when source logos are hidden");
}

async function assertSearchStatesAreAnnounced() {
  const [portalSource, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(portalSource.includes("createLoadingState"), true, "results UI should centralize loading state rendering");
  assert.equal(portalSource.includes('state.setAttribute("role", "status")'), true, "search loading and empty states should be announced as status regions");
  assert.equal(portalSource.includes('state.setAttribute("aria-live", "polite")'), true, "search states should use polite live-region announcements");
  assert.equal(portalSource.includes('state.setAttribute("aria-busy", "true")'), true, "loading state should expose busy status to assistive technology");
  assert.equal(portalSource.includes("검색 결과를 불러오는 중입니다."), true, "loading status regions should contain an actual readable status message");
  assert.equal(portalSource.includes('line.setAttribute("aria-hidden", "true")'), true, "decorative loading skeleton lines should be hidden from assistive technology");
  assert.equal(css.includes(".search-state-message"), true, "loading status text should be visually hidden without changing the Figma skeleton");
  assert.equal(css.includes(".search-loading-line:nth-of-type(1)"), true, "loading skeleton widths should remain stable after adding hidden status text");
}

async function assertSearchShortcutIsFunctional() {
  const [barSource, portalSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SearchBar.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
  ]);

  assert.equal(barSource.includes('shortcut.textContent = "⌘K"'), true, "search bar should visibly advertise the keyboard shortcut");
  assert.equal(portalSource.includes("initializeSearchShortcut"), true, "search portal should initialize the advertised shortcut");
  assert.equal(portalSource.includes("event.metaKey || event.ctrlKey"), true, "search shortcut should work with Cmd+K and Ctrl+K");
  assert.equal(portalSource.includes('event.key.toLocaleLowerCase() === "k"'), true, "search shortcut should be bound to K");
  assert.equal(portalSource.includes('input.focus({ preventScroll: true })'), true, "search shortcut should focus the active search input");
  assert.equal(portalSource.includes("input.select()"), true, "search shortcut should select the current query for replacement");
}

async function assertBlankSubmitDoesNotNavigate() {
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");

  assert.equal(portalSource.includes("function submitSearch(value, context = {})"), true, "search submissions should be centralized with optional result context");
  assert.equal(portalSource.includes("if (!hasResultIntent)"), true, "blank search submissions should be rejected while structured filter-only submissions remain valid");
  assert.equal(portalSource.includes('document.querySelector(".portal-search-input")?.focus({ preventScroll: true })'), true, "blank search submissions should keep focus on the active search input");
}

async function assertResultsTitleIncludesQuery() {
  const [portalSource, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(portalSource.includes("createResultsDocumentTitle"), true, "results pages should compute a query-aware browser title");
  assert.equal(portalSource.includes("createResultsDocumentTitle(new URLSearchParams(location.search))"), true, "results page titles should derive all shareable context from URL params");
  assert.equal(portalSource.includes("const parts = normalizedQuery ? [normalizedQuery] : []"), true, "results page title should include the active query for browser history");
  assert.equal(portalSource.includes("const hasIntent = normalizedQuery || hasStructuredSearchOperators(parsedQuery) || hasActiveResultFilters"), true, "results page titles should announce tab/source/page filters for structured filter-only result routes");
  assert.equal(portalSource.includes('if (activeTab !== "all") parts.push(`${RESULT_TABS[activeTab].label} 탭`);'), true, "results page title should include the active result tab when filtered");
  assert.equal(portalSource.includes('if (sourceId) parts.push(`${SOURCE_BY_ID[sourceId]?.name || sourceId} 자료원`);'), true, "results page title should include the active source filter when present");
  assert.equal(portalSource.includes('if (activeSort !== "relevance") parts.push(SEARCH_SORTS[activeSort].label);'), true, "results page title should include non-default sort context when shared");
  assert.equal(portalSource.includes('if (page > 1) parts.push(`${formatCount(page)}페이지`);'), true, "results page title should include pagination context for shareable paged URLs");
  assert.equal(portalSource.includes('const RESULTS_PANEL_ID = "search-results-panel";'), true, "results pages should use a stable controlled panel id");
  assert.equal(portalSource.includes("controlsId: RESULTS_PANEL_ID"), true, "result tabs should be wired to the rendered results panel");
  assert.equal(portalSource.includes("const nextQuery = bar.input.value.trim();"), true, "tab changes should use the current search box value as the next query");
  assert.equal(portalSource.includes("const nextHasIntent = hasSearchQuery(nextQuery) || hasActiveResultFilters"), true, "tab changes should allow filter-only result navigation while still avoiding empty duplicate history entries");
  assert.equal(portalSource.includes("if (!nextHasIntent) return;"), true, "blank result tabs should not push duplicate empty-query history entries");
  assert.equal(portalSource.includes('const params = createResultParams(\n      nextQuery,\n      nextTab,\n      activeSourceId,\n      1,\n      activeSort,\n      activeDateRange,\n    );'), true, "tab changes should build a clean query/tab/source/sort/date URL instead of mutating stale location params");
  assert.equal(portalSource.includes("const nextParams = new URLSearchParams(location.search);"), false, "tab changes should not inherit stale URL params like page/cache/debug");
  assert.equal(portalSource.includes("createResultsHeading"), true, "results pages should expose a page-level heading without changing the visual Figma layout");
  assert.equal(portalSource.includes('heading.id = "search-results-heading"'), true, "result headings should expose a stable id for region labelling");
  assert.equal(portalSource.includes('heading.className = "search-results-heading"'), true, "result headings should use a scoped visually-hidden class");
  assert.equal(portalSource.includes("content.id = RESULTS_PANEL_ID"), true, "results content should expose the stable controlled panel id");
  assert.equal(portalSource.includes('content.setAttribute("role", "tabpanel")'), true, "results content should identify itself as the panel controlled by result tabs");
  assert.equal(portalSource.includes("createSearchTabId(activeTab)"), true, "results content should reference the active result tab in its accessible label");
  assert.equal(portalSource.includes('content.setAttribute("aria-labelledby", `${heading.id} ${createSearchTabId(activeTab)}`)'), true, "results content should be labelled by both the contextual heading and active tab");
  assert.equal(portalSource.includes('content.setAttribute("aria-busy", "true")'), true, "results content should expose loading state while provider work is pending");
  assert.equal(portalSource.includes('content.setAttribute("aria-busy", "false")'), true, "results content should clear loading state after rendering provider results");
  assert.equal(portalSource.includes("header.append(heading, searchWrap, tabs)"), true, "result headings should be part of the results header landmark order");
  assert.equal(portalSource.includes('`${normalizedQuery} 검색 결과`'), true, "result headings should announce the active query");
  assert.equal(portalSource.includes('if (activeSourceId) parts.push(`${SOURCE_BY_ID[activeSourceId]?.name || activeSourceId} 자료원`);'), true, "result headings should announce the active source filter");
  assert.equal(portalSource.includes('if (activeSort !== "relevance") parts.push(SEARCH_SORTS[activeSort].label);'), true, "result headings should announce non-default sort context");
  assert.equal(portalSource.includes('if (activePage > 1) parts.push(`${formatCount(activePage)}페이지`);'), true, "result headings should announce pagination context");
  assert.equal(css.includes(".search-results-heading,\n.search-state-message"), true, "result headings should be visually hidden with the same Figma-safe utility as loading text");
}

async function assertResultsUrlsAreCanonical() {
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");

  assert.equal(portalSource.includes("canonicalizeResultsUrl"), true, "results pages should canonicalize ignored URL state");
  assert.equal(portalSource.includes("CANONICAL_RESULT_PARAMS"), true, "results URLs should use an allowlist so stale cache/debug params are dropped");
  assert.equal(portalSource.includes("canonicalParams.delete(key)"), true, "results URL canonicalization should strip ignored params like stale cache keys");
  assert.equal(portalSource.includes('import { SOURCE_BY_ID } from "./sourceConfig.js?v=search-'), true, "results URL handling should validate source filters against the canonical source catalog");
  assert.equal(portalSource.includes("function getValidSourceId(sourceId)"), true, "results pages should reject unknown source filter IDs before searching");
  assert.equal(portalSource.includes('canonicalParams.delete("tab")'), true, "invalid or all-result tab params should be removed from shareable URLs");
  assert.equal(portalSource.includes('canonicalParams.delete("source")'), true, "invalid source filter params should be removed from shareable URLs");
  assert.equal(portalSource.includes('canonicalParams.delete("sort")'), true, "invalid or default sort params should be removed from shareable URLs");
  assert.equal(portalSource.includes("const hasResultIntent = hasSearchQuery(query) || hasStructuredSearchOperators(parsedQuery) || hasActiveResultFilters"), true, "results pages should distinguish empty searches from structured filter-only result routes");
  assert.equal(portalSource.includes('const activePage = hasResultIntent ? normalizePage(params.get("page")) : 1;'), true, "results pages should accept pagination only for query or filter-backed views");
  assert.equal(portalSource.includes('const activeSourceId = hasResultIntent ? routeSourceId : "";'), true, "filter-only result URLs should keep validated source filters active");
  assert.equal(portalSource.includes('const activeSort = hasResultIntent ? routeSort : "relevance";'), true, "blank result URLs should not keep sort params active without query or filters");
  assert.equal(portalSource.includes("if (!normalizedQuery && !hasFilterState)"), true, "blank result URLs should canonicalize away tab/source/excluded-source/page/sort params only when no structured filter remains");
  assert.equal(portalSource.includes('if (activePage <= 1)'), true, "first-page URLs should omit noisy page params");
  assert.equal(portalSource.includes('canonicalParams.set("sort", activeSort)'), true, "valid non-default sort params should be normalized instead of dropped");
  assert.equal(portalSource.includes('canonicalParams.set("page", String(activePage))'), true, "valid page params should be normalized instead of dropped");
  assert.equal(portalSource.includes("history.replaceState(null, \"\", canonicalUrl)"), true, "URL canonicalization should replace history instead of adding noisy entries");
  assert.equal(portalSource.includes("CANONICAL_DOCUMENT_PARAMS"), true, "document viewer URLs should use an allowlist so stale cache/debug params are dropped");
  assert.equal(portalSource.includes("canonicalizeDocumentUrl(params, { query, activeTab, activeSourceId, activeSort, activePage, ...activeDateRange, id })"), true, "document pages should canonicalize URL state before rendering shareable document views");
  assert.equal(portalSource.includes('const CANONICAL_DOCUMENT_PARAMS = new Set(["q", "tab", "source", "exclude_source", "exclude_type", "lang", "exclude_lang", "page", "sort", "after", "before", "id"]);'), true, "document URL canonicalization should preserve only result context plus the document id");
  assert.equal(portalSource.includes('const id = String(params.get("id") || "").trim();'), true, "document lookups should trim URL ids before loading records");
  assert.equal(portalSource.includes("function canonicalizeDocumentUrl"), true, "document pages should have dedicated canonicalization instead of inheriting result-only URL rules");
  assert.equal(portalSource.includes("if (!CANONICAL_DOCUMENT_PARAMS.has(key)) canonicalParams.delete(key);"), true, "document URL canonicalization should strip ignored params like stale cache keys");
  assert.equal(portalSource.includes('canonicalParams.delete("id")'), true, "document URL canonicalization should remove empty document ids");
  assert.equal(portalSource.includes('const canonicalUrl = `${DOCUMENT_PATH}${queryString ? `?${queryString}` : ""}`'), true, "document URL canonicalization should stay on the document route");
}

async function assertBlankSuggestionsDoNotLoadIndex() {
  const provider = new LocalJsonSearchProvider({
    fetchImpl: async () => {
      throw new Error("blank suggestions should not fetch the local index");
    },
  });
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");
  const localProviderSource = await fs.readFile(path.join(ROOT_DIR, "search/LocalJsonSearchProvider.js"), "utf8");

  assert.deepEqual(await provider.getSuggestions(""), [], "blank suggestion requests should not fetch documents");
  assert.deepEqual(await provider.getSuggestions("   "), [], "whitespace-only suggestion requests should not fetch documents");
  assert.equal(portalSource.includes("if (!hasSearchQuery(value))"), true, "UI suggestion refresh should short-circuit blank input");
  assert.equal(localProviderSource.includes("if (!hasSearchQuery(query)) return [];"), true, "local provider should avoid loading the index for blank suggestions");
}

async function assertFigmaSourceLogosAreLocalAssets() {
  const [cardSource, css, rodongLogo, kcnaLogo] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "assets/search-rodong-logo.svg"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "assets/search-kcna-logo.svg"), "utf8"),
  ]);

  assert.equal(cardSource.includes("SOURCE_LOGO_ASSETS"), true, "result cards should use local Figma source logo assets");
  assert.equal(cardSource.includes("/assets/search-rodong-logo.svg?v=search-"), true, "로동신문 result logo should be stored locally with the search runtime cache key");
  assert.equal(cardSource.includes("/assets/search-kcna-logo.svg?v=search-"), true, "조선중앙통신 result logo should be stored locally with the search runtime cache key");
  assert.equal(cardSource.includes("/assets/search-youtube-logo.svg?v=search-"), true, "YouTube result logo should use the same search runtime cache key");
  assert.equal(cardSource.includes('logo.setAttribute("aria-hidden", "true")'), true, "decorative source logos should not duplicate accessible source names");
  assert.equal(css.includes(".source-result-logo-artwork-rodong"), true, "로동신문 Figma logo should have source-specific dimensions");
  assert.equal(css.includes(".source-result-logo-artwork-kcna"), true, "조선중앙통신 Figma logo should have source-specific dimensions");
  for (const logo of [rodongLogo, kcnaLogo]) {
    assert.equal(/<script|onload=|onclick=|javascript:|foreignObject/i.test(logo), false, "stored Figma logo SVGs must stay passive");
  }
}

async function assertFallbackSourceLogosAreCompactBadges() {
  const [cardSource, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(cardSource.includes('parent.classList.add("source-result-logo-fallback")'), true, "sources without Figma artwork should use compact fallback badges");
  assert.equal(cardSource.includes('"KCNA Watch": "KW"'), true, "KCNA Watch fallback logo should not repeat the full source title");
  assert.equal(cardSource.includes('"조선신보": "신보"'), true, "archive fallback logos should use short source badges");
  assert.equal(cardSource.includes('if (sourceName === "KCNA Watch") return "KCNA Watch";'), false, "fallback logos must not duplicate long source names beside the card title");
  assert.equal(css.includes(".source-result-logo-fallback"), true, "compact fallback badges should have dedicated styling");
  assert.equal(css.includes("min-width: 40px;"), true, "compact fallback badges should be favicon-sized instead of full source labels");
  assert.equal(css.includes("flex: 0 0 40px;"), true, "compact fallback badges should remain visible in narrow result layouts");
}

async function assertYouTubeSourceCardMatchesFigmaDesign() {
  const [cardSource, css, youtubeLogo] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "assets/search-youtube-logo.svg"), "utf8"),
  ]);

  assert.equal(cardSource.includes("source-result-card-youtube"), true, "YouTube result groups should use the Figma-specific source card");
  assert.equal(cardSource.includes("/assets/search-youtube-logo.svg?v=search-"), true, "YouTube logo asset should use the search runtime cache key");
  assert.equal(cardSource.includes("createYouTubeResultItem"), true, "YouTube result groups should keep the Figma-specific video item entry point");
  assert.equal(cardSource.includes("createVideoResultItem"), true, "video archive result groups should render thumbnail grid items");
  assert.equal(cardSource.includes("isVideoPreviewSource"), true, "non-YouTube video archive groups such as 고려TV should use visual thumbnail cards");
  assert.equal(cardSource.includes('sourceType === "video_archive"'), true, "video_archive sources should not fall back to text-only result lists");
  assert.equal(cardSource.includes("source-result-video-grid"), true, "generic video source cards should expose a visual grid class");
  assert.equal(cardSource.includes("getVideoSourceLabel"), true, "generic video cards should show their indexed source name instead of a YouTube-only channel label");
  assert.equal(cardSource.includes("createSearchAssetDisplayUrl"), true, "source-card video thumbnails should use the same cached/direct/proxied asset resolver as media result grids");
  assert.equal(cardSource.includes("DPRK_SEARCH_CONFIG"), true, "source-card media previews should honor configured production asset proxies for uncached DPRK thumbnails");
  assert.equal(cardSource.includes("isKcnaImageEndpoint"), true, "source-card media previews should recognize extensionless KCNA image endpoints");
  assert.equal(cardSource.includes("getFallbackThumbnailSrc"), true, "source-card media previews should retry the original thumbnail when the configured asset proxy is unavailable locally");
  assert.equal(cardSource.includes("retriedFallback"), true, "source-card thumbnail retries should avoid looping forever after a proxy miss");
  assert.equal(cardSource.includes("source-result-youtube-thumbnail"), true, "YouTube result items should expose video thumbnails");
  assert.equal(cardSource.includes("getYouTubeChannelName"), true, "YouTube result items should show the channel name from indexed aliases");
  assert.equal(youtubeLogo.includes('viewBox="0 0 136 48"'), true, "YouTube logo SVG should use the 136x48 Figma artwork frame");
  assert.equal(youtubeLogo.includes("#314158"), true, "YouTube logo SVG should use the Figma navy logo color");
  assert.equal(/#ff0000|#1f2937/i.test(youtubeLogo), false, "YouTube logo should not use the non-Figma red/dark-gray artwork");
  assert.equal(css.includes(".source-result-card-youtube"), true, "YouTube Figma card should have scoped styling");
  assert.equal(css.includes("grid-template-columns: repeat(4, minmax(0, 1fr));"), true, "YouTube Figma card should use a four-column desktop grid");
  assert.equal(css.includes("height: 120px;"), true, "YouTube thumbnail rail should match the Figma 120px thumbnail height");
  assert.equal(css.includes(".source-result-youtube-title"), true, "YouTube titles should have compact two-line Figma typography");
  assert.equal(css.includes("width: 136px;"), true, "YouTube logo should match the Figma 136px header artwork width");
}

async function assertExternalResultLinksDoNotLeakReferrers() {
  const [cardSource, portalSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
  ]);

  assert.equal(cardSource.includes("configureResultLink"), true, "result cards should centralize source link hardening");
  assert.equal(cardSource.includes('link.rel = "noreferrer"'), true, "external source links should suppress referrers");
  assert.equal(cardSource.includes('link.referrerPolicy = "no-referrer"'), true, "external source links should explicitly set no-referrer policy");
  assert.equal(cardSource.includes("isExternalHref"), true, "internal source-filter links should not be treated as external source documents");
  assert.equal(cardSource.includes('link.removeAttribute("href")'), true, "result cards should remove empty hrefs instead of shipping # fallbacks");
  assert.equal(cardSource.includes('link.setAttribute("aria-disabled", "true")'), true, "result cards should expose missing destinations as disabled links");
  assert.equal(cardSource.includes('href = "#"'), false, "result cards should not default missing destinations to #");
  assert.equal(cardSource.includes("configureMediaElement"), true, "source logos and video thumbnails should centralize referrer hardening");
  assert.equal(cardSource.includes('element.referrerPolicy = "no-referrer"'), true, "result-card media requests should not leak search result URLs as referrers");
  assert.equal(portalSource.includes("configureEmbeddedMedia"), true, "document/image media embeds should centralize referrer hardening");
  assert.equal(portalSource.includes('element.referrerPolicy = "no-referrer"'), true, "document media and iframes should not leak search result URLs as referrers");
  assert.equal(portalSource.includes('function configureExternalDocumentLink(link, href = "")'), true, "document/image action links should not default missing destinations to #");
  assert.equal(portalSource.includes('link.setAttribute("aria-disabled", "true")'), true, "document/image action links should expose missing destinations as disabled links");
}

async function assertResultCardsExposeTrustMetadata() {
  const [cardSource, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(cardSource.includes("MEDIA_LABELS"), true, "result cards should map indexed media types to visible result metadata");
  assert.equal(cardSource.includes("createResultMetadata"), true, "result cards should render trustworthy per-result metadata");
  assert.equal(cardSource.includes("const date = formatDate(result.date)"), true, "result metadata should preserve each result date outside the snippet body");
  assert.equal(cardSource.includes("const parts = [mediaType, date, url].filter(Boolean)"), true, "result metadata should show media type, date, and destination context together");
  assert.equal(cardSource.includes("formatDisplayUrl"), true, "result cards should format the destination host/path instead of hiding it");
  assert.equal(cardSource.includes("host, ...segments"), true, "display URLs should expose both host and path context");
  assert.equal(cardSource.includes("getSourceLinkLabel"), true, "result cards should label archive-preserved links by their physical provenance");
  assert.equal(cardSource.includes("getSourceOriginalHref"), true, "result cards should keep source-original links separate from archive-preserved copies");
  assert.equal(cardSource.includes("result.originalSourceUrl"), true, "result cards should render indexed original-source URLs when an archive exposes them");
  assert.equal(cardSource.includes("getVisibleSourceResults"), true, "result cards should centralize source-card preview selection");
  assert.equal(cardSource.includes("compactArchiveDuplicateResults"), true, "KCNA Watch grouped previews should compact repeated preserved copies instead of filling the first screen with duplicate titles");
  assert.equal(cardSource.includes("relatedOriginNames"), true, "compacted archive previews should preserve original-source provenance");
  assert.equal(cardSource.includes("formatRelatedOriginNames"), true, "compacted archive previews should show combined original-source pills");
  assert.equal(cardSource.includes("source-result-archive-count"), true, "compacted archive previews should visibly report how many preserved copies were folded together");
  assert.equal(cardSource.includes("getRelatedOriginNameList(result).length > 1"), true, "combined original-source pills should not link to only one of several folded source URLs");
  assert.equal(cardSource.includes("createOriginalSourceAccessibleLabel"), true, "repeated source links should expose result-specific accessible labels");
  assert.equal(cardSource.includes('original.setAttribute("aria-label", createOriginalSourceAccessibleLabel(result, sourceLabel))'), true, "source link accessible labels should include the result title context");
  assert.equal(cardSource.includes('origin.setAttribute("aria-label", createOriginalSourceAccessibleLabel(result, `원출처 ${originSourceName}`))'), true, "linked original-source pills should expose result-specific accessible labels");
  assert.equal(cardSource.includes("보존본"), true, "result cards should not call archive-preserved source links original-site links");
  assert.equal(cardSource.includes('metadata.className = "source-result-metadata"'), true, "result metadata should use a scoped class");
  assert.equal(cardSource.includes('sourceMeta.textContent = `${SOURCE_LABELS[sourceType] || "자료"} · ${formatCount(totalCount)}건`'), true, "source card totals should use localized count formatting");
  assert.equal(css.includes(".source-result-metadata"), true, "result metadata should have scoped styling");
  assert.equal(css.includes("text-overflow: ellipsis"), true, "long source URLs should not break the Figma card layout");
}

async function assertKcnaWatchArchiveCardsRenderOriginalSourcePills() {
  const originalDocument = globalThis.document;
  globalThis.document = new TestDocument();

  try {
    const card = createSourceResultCard({
      sourceId: "kcna-watch",
      sourceName: "KCNA Watch",
      sourceType: "archive",
      total: 1,
      results: [{
        id: "kcna-watch-origin-pill-fixture",
        title: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행",
        snippet: "원산갈마해안관광지구 준공식 보존본입니다.",
        date: "2025-06-26",
        sourceId: "kcna-watch",
        sourceName: "KCNA Watch",
        sourceType: "archive",
        displaySourceId: "rodong-sinmun",
        displaySourceName: "로동신문",
        displaySourceType: "official_site",
        mediaType: "article",
        url: "https://kcnawatch.org/newstream/wonsan-kalma-preserved/",
        originalSourceUrl: "http://www.rodong.rep.kp/ko/index.php?fixture",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      }],
    }, {
      getDocumentHref: (result) => `/search/document?id=${encodeURIComponent(result.id)}`,
      query: "원산갈마",
    });

    const originPills = card.querySelectorAll(".source-result-origin-pill");
    const archiveLinks = card.querySelectorAll(".source-result-original");

    assert.equal(card.dataset.sourceId, "kcna-watch", "KCNA Watch preserved copies should render in the KCNA Watch source card");
    assert.equal(card.textContent.includes("KCNA Watch"), true, "KCNA Watch archive cards should keep the physical archive source as the card title");
    assert.equal(originPills.length, 1, "KCNA Watch preserved copies with source provenance should render one visible original-source pill");
    assert.equal(originPills[0]?.textContent, "원출처 로동신문", "KCNA Watch preserved copies should show the original source as a pill");
    assert.equal(originPills[0]?.href, "http://www.rodong.rep.kp/ko/index.php?fixture", "linked original-source pills should open the indexed original URL");
    assert.equal(archiveLinks[0]?.textContent, "KCNA Watch 보존본", "KCNA Watch archive URLs should be labelled as preserved copies, not original sites");
    assert.equal(archiveLinks[0]?.href, "https://kcnawatch.org/newstream/wonsan-kalma-preserved/", "the preserved-copy link should still open the KCNA Watch archive URL");
  } finally {
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
}

async function assertResultCardsOpenInternalDocumentViewer() {
  const [cardSource, portalSource, documentHtml, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/document/index.html"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(cardSource.includes("getDocumentHref"), true, "result title links should be able to point at the internal document viewer");
  assert.equal(cardSource.includes("source-result-original"), true, "result cards should keep a separate original-source link");
  assert.equal(portalSource.includes('const DOCUMENT_PATH = "/search/document";'), true, "search portal should route indexed documents through /search/document");
  assert.equal(portalSource.includes('const DOCUMENT_TITLE_ID = "search-document-title";'), true, "document pages should use a stable title id for region labelling");
  assert.equal(portalSource.includes("renderDocumentPage"), true, "search portal should render an internal indexed-document page");
  assert.equal(portalSource.includes("searchProvider.getDocumentById"), true, "document pages should load records from the active search provider");
  assert.equal(portalSource.includes('content.setAttribute("role", "region")'), true, "document content should expose a labelled region");
  assert.equal(portalSource.includes('content.setAttribute("aria-label", "자료 보기")'), true, "document content should have a loading-time accessible label");
  assert.equal(portalSource.includes('content.setAttribute("aria-busy", "true")'), true, "document content should expose loading state while the record is fetched");
  assert.equal(portalSource.includes('content.setAttribute("aria-busy", "false")'), true, "document content should clear loading state after lookup");
  assert.equal(portalSource.includes('content.setAttribute("aria-labelledby", DOCUMENT_TITLE_ID)'), true, "loaded document content should be labelled by the document title");
  assert.equal(portalSource.includes('title.id = DOCUMENT_TITLE_ID'), true, "document h1 should expose the stable region label id");
  assert.equal(portalSource.includes("createDocumentBackAccessibleLabel"), true, "document back links should expose the search context they restore");
  assert.equal(portalSource.includes('back.setAttribute("aria-label", createDocumentBackAccessibleLabel(params))'), true, "document back links should not rely on generic visible text alone");
  assert.equal(portalSource.includes("색인된 미리보기"), true, "document pages should label the locally displayed indexed preview");
  assert.equal(portalSource.includes("원문 사이트로 이동"), true, "document pages should preserve a clear link to the original site");
  assert.equal(portalSource.includes("getDocumentActionLabel"), true, "document pages should label archive-preserved links by their physical provenance");
  assert.equal(portalSource.includes("getDocumentOriginalSourceHref"), true, "document pages should expose source-original links separately from archive-preserved copies");
  assert.equal(portalSource.includes("createDocumentOriginPill"), true, "document pages should render archive original-source provenance in metadata");
  assert.equal(portalSource.includes('origin.className = "search-document-origin-pill"'), true, "document origin provenance should use a stable pill class");
  assert.equal(portalSource.includes('origin.textContent = `원출처 ${originSourceName}`'), true, "document origin provenance should be labelled as original source");
  assert.equal(portalSource.includes("getDocumentOriginalSourceName"), true, "document origin pills should use display-source provenance instead of physical archive provenance");
  assert.equal(portalSource.includes("record.originalSourceUrl"), true, "document pages should preserve indexed original-source URLs");
  assert.equal(portalSource.includes("보존본 열기"), true, "document pages should not call archive-preserved source links original-site links");
  assert.equal(portalSource.includes("원출처 열기"), true, "document pages should name original-source links distinctly from archive links");
  assert.equal(portalSource.includes("createDocumentActionAccessibleLabel"), true, "document action links should expose the active document title to assistive technology");
  assert.equal(portalSource.includes('original.setAttribute("aria-label", createDocumentActionAccessibleLabel(record, originalLabel))'), true, "primary document action links should not rely on repeated visible text alone");
  assert.equal(portalSource.includes('archive.setAttribute("aria-label", createDocumentActionAccessibleLabel(record, archiveLabel))'), true, "secondary archive action links should include document title context");
  assert.equal(portalSource.includes("createPdfPreview"), true, "document pages should try to display indexed PDF/file records inline");
  assert.equal(documentHtml.includes('/search/searchPortal.js?v=search-'), true, "document page should load the same versioned portal runtime");
  assert.equal(css.includes(".search-document-view"), true, "document viewer should have scoped page styling");
  assert.equal(css.includes(".search-document-metadata-text"), true, "document metadata should keep summary text separate from origin pills");
  assert.equal(css.includes(".search-document-origin-pill"), true, "document origin provenance pills should have scoped styling");
  assert.equal(css.includes(".source-result-original"), true, "original-source links should be styled separately from document titles");
}

async function assertSourceCardsHideRedundantMoreLinks() {
  const [cardSource, portalSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
  ]);

  assert.equal(cardSource.includes("const shouldShowMore"), true, "source cards should compute whether a more link is useful");
  assert.equal(cardSource.includes("totalCount > visibleResults.length"), true, "source cards should hide more links when all results are already visible");
  assert.equal(cardSource.includes("if (shouldShowMore) header.append(more);"), true, "source cards should not render redundant more links");
  assert.equal(cardSource.includes("createMoreLinkAccessibleLabel"), true, "source-card more links should expose query, source, and count context to assistive technology");
  assert.equal(cardSource.includes("visibleCount: visibleResults.length"), true, "source-card more link labels should state how many results are currently visible");
  assert.equal(cardSource.includes("모두 보기, 현재"), true, "source-card more link labels should distinguish the full source result set from the previewed subset");
  assert.equal(portalSource.includes("query,\n      moreHref"), true, "result pages should pass the active query into source-card more link labels");
  assert.equal(portalSource.includes("showMore: !isSourceScopedResult"), true, "source-filtered and typed site: result pages should let pagination handle more results instead of showing a self-link");
}

async function assertImageTabRendersImageGrid() {
  const [portalSource, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(portalSource.includes('activeTab === "image"'), true, "image tab should use a media-specific rendering path");
  assert.equal(portalSource.includes("createImageResultsGrid"), true, "image tab should render image records as an image grid");
  assert.equal(portalSource.includes("search-image-card-media"), true, "image results should expose actual image media, not only text links");
  assert.equal(portalSource.includes("getImageDisplaySrc"), true, "image result cards should resolve display media through a single asset helper");
  assert.equal(portalSource.includes("PUBLIC_DIRECT_ASSET_HOSTS"), true, "UI should distinguish directly reachable public archive/video asset hosts from DPRK-hosted assets");
  assert.equal(portalSource.includes("assets.korearisk.com"), true, "KCNA Watch image assets should be allowed to load directly");
  assert.equal(portalSource.includes("vod.koryo.tv"), true, "고려TV video assets should be allowed to load directly");
  assert.equal(portalSource.includes("createSearchAssetDisplayUrl"), true, "UI should centralize direct-vs-proxied asset URL selection");
  assert.equal(portalSource.includes("record.cachedThumbnailUrl"), true, "image result cards should prefer mirrored thumbnail assets over blocked source URLs");
  assert.equal(portalSource.includes("record.cachedUrl"), true, "image result cards should prefer mirrored primary assets over blocked source URLs");
  assert.equal(portalSource.includes("createImageOriginalAccessibleLabel"), true, "image original links should include result title context");
  assert.equal(portalSource.includes('original.setAttribute("aria-label", createImageOriginalAccessibleLabel(result))'), true, "image original links should not all expose the same repeated accessible name");
  assert.equal(css.includes(".search-image-grid"), true, "image result grid should have scoped layout styling");
  assert.equal(css.includes("aspect-ratio: 4 / 3"), true, "image result cards should reserve stable media dimensions");
}

async function assertSearchAssetsAreMirrorReady() {
  const tempDir = await fs.mkdtemp(path.join(ROOT_DIR, ".tmp-search-assets-"));
  try {
    const documentsPath = path.join(tempDir, "documents.jsonl");
    const sourcesPath = path.join(tempDir, "sources.json");
    const assetDir = path.join(tempDir, "assets");
    const reportPath = path.join(tempDir, "asset-report.json");
    const fixtureDocument = {
      id: "fixture-image-asset",
      title: "원산갈마해안관광지구",
      snippet: "원산갈마해안관광지구 사진 자료입니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Source",
      sourceType: "official_site",
      mediaType: "image",
      url: "https://example.test/photo.jpg",
      archiveUrl: "",
      thumbnailUrl: "https://example.test/thumb.jpg",
      language: "ko",
      aliases: [],
    };
    const fixtureVideoDocument = {
      id: "fixture-video-asset",
      title: "고려TV 영상",
      snippet: "영상 검색 결과는 썸네일만 미러링합니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Source",
      sourceType: "official_site",
      mediaType: "video",
      url: "https://example.test/video.mp4",
      archiveUrl: "",
      thumbnailUrl: "https://example.test/video-thumb.jpg",
      language: "ko",
      aliases: [],
      searchTabs: ["all", "video"],
    };
    const fixtureExtensionlessThumbnailDocument = {
      id: "fixture-kcna-extensionless-thumbnail",
      title: "KCNA 공식 이미지",
      snippet: "확장자가 없는 KCNA 이미지 엔드포인트 썸네일입니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Source",
      sourceType: "official_site",
      mediaType: "article",
      url: "http://www.kcna.kp/en/article/q/example.kcmsf",
      archiveUrl: "",
      thumbnailUrl: "http://www.kcna.kp/en/image/q/example.kcmsf",
      language: "en",
      aliases: [],
    };
    const fixtureSameUrlImageDocument = {
      id: "fixture-same-url-image-asset",
      title: "같은 원본 이미지",
      snippet: "thumbnailUrl과 url이 같은 이미지 검색 결과입니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Source",
      sourceType: "official_site",
      mediaType: "image",
      url: "https://example.test/same-photo.jpg",
      archiveUrl: "",
      thumbnailUrl: "https://example.test/same-photo.jpg",
      language: "ko",
      aliases: [],
    };
    const fixtureSource = {
      id: "fixture-source",
      name: "Fixture Source",
      sourceType: "official_site",
      baseUrl: "https://example.test/",
      languages: ["ko"],
      mediaTypes: ["image", "video"],
      aliases: [],
      crawler: {
        enabled: true,
        entryUrl: "https://example.test/",
        strategy: "fixture",
        schedule: "manual",
        robotsPolicy: "ignore",
      },
    };

    await Promise.all([
      fs.writeFile(documentsPath, `${JSON.stringify(fixtureDocument)}\n${JSON.stringify(fixtureVideoDocument)}\n`, "utf8"),
      fs.writeFile(sourcesPath, `${JSON.stringify([fixtureSource], null, 2)}\n`, "utf8"),
    ]);

    const fetchedAssetUrls = [];
    const { documents, report } = await cacheSearchAssets({
      documentsPath,
      sourcesPath,
      outDocumentsPath: documentsPath,
      assetDir,
      publicBaseUrl: "/cached/search-assets",
      reportPath,
      fetchImpl: async (url) => {
        fetchedAssetUrls.push(url);
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      },
    });
    const proxyFetchTemplate = "https://gcp-proxy.example.test/search-asset?url={url}";
    const proxyFetchedAssetUrls = [];
    const proxyRun = await cacheSearchAssets({
      documentsPath,
      sourcesPath,
      outDocumentsPath: path.join(tempDir, "proxy-documents.jsonl"),
      assetDir: path.join(tempDir, "proxy-assets"),
      publicBaseUrl: "/proxy/search-assets",
      reportPath: path.join(tempDir, "proxy-report.json"),
      refresh: true,
      dryRun: true,
      fetchProxyTemplate: proxyFetchTemplate,
      fetchImpl: async (url) => {
        proxyFetchedAssetUrls.push(String(url));
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      },
    });
    const skippedSourceRunFetches = [];
    const skippedSourceRun = await cacheSearchAssets({
      documentsPath,
      sourcesPath,
      outDocumentsPath: path.join(tempDir, "skipped-source-documents.jsonl"),
      assetDir: path.join(tempDir, "skipped-source-assets"),
      publicBaseUrl: "/skipped/search-assets",
      reportPath: path.join(tempDir, "skipped-source-report.json"),
      sourceIds: ["missing-source"],
      dryRun: true,
      fetchImpl: async (url) => {
        skippedSourceRunFetches.push(String(url));
        throw new Error("filtered documents should not fetch");
      },
    });
    const excludedSourceRunFetches = [];
    const excludedSourceRun = await cacheSearchAssets({
      documentsPath,
      sourcesPath,
      outDocumentsPath: path.join(tempDir, "excluded-source-documents.jsonl"),
      assetDir: path.join(tempDir, "excluded-source-assets"),
      publicBaseUrl: "/excluded/search-assets",
      reportPath: path.join(tempDir, "excluded-source-report.json"),
      excludedSourceIds: ["fixture-source"],
      dryRun: true,
      fetchImpl: async (url) => {
        excludedSourceRunFetches.push(String(url));
        throw new Error("excluded documents should not fetch");
      },
    });
    const originalProxyEnv = snapshotProxyEnv();
    const envProxyFetches = [];
    const envProxyFallbackFetches = [];
    const noProxyFetches = [];
    let envProxyRun;
    let envProxyFallbackRun;
    let noProxyRun;
    try {
      clearProxyEnv();
      process.env.HTTPS_PROXY = "http://proxy.example.test:3128";
      envProxyRun = await cacheSearchAssets({
        documentsPath,
        sourcesPath,
        outDocumentsPath: path.join(tempDir, "env-proxy-documents.jsonl"),
        assetDir: path.join(tempDir, "env-proxy-assets"),
        publicBaseUrl: "/env-proxy/search-assets",
        reportPath: path.join(tempDir, "env-proxy-report.json"),
        refresh: true,
        dryRun: true,
        limit: 1,
        fetchImpl: async (url, options = {}) => {
          envProxyFetches.push({
            url: String(url),
            hasDispatcher: Boolean(options.dispatcher),
          });
          return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        },
      });
      envProxyFallbackRun = await cacheSearchAssets({
        documentsPath,
        sourcesPath,
        outDocumentsPath: path.join(tempDir, "env-proxy-fallback-documents.jsonl"),
        assetDir: path.join(tempDir, "env-proxy-fallback-assets"),
        publicBaseUrl: "/env-proxy-fallback/search-assets",
        reportPath: path.join(tempDir, "env-proxy-fallback-report.json"),
        refresh: true,
        dryRun: true,
        limit: 1,
        fetchImpl: async (url, options = {}) => {
          envProxyFallbackFetches.push({
            url: String(url),
            hasDispatcher: Boolean(options.dispatcher),
          });
          if (options.dispatcher) throw new Error("network timeout through proxy");
          return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        },
      });
      process.env.NO_PROXY = "example.test,source.example";
      noProxyRun = await cacheSearchAssets({
        documentsPath,
        sourcesPath,
        outDocumentsPath: path.join(tempDir, "no-proxy-documents.jsonl"),
        assetDir: path.join(tempDir, "no-proxy-assets"),
        publicBaseUrl: "/no-proxy/search-assets",
        reportPath: path.join(tempDir, "no-proxy-report.json"),
        refresh: true,
        dryRun: true,
        limit: 1,
        fetchImpl: async (url, options = {}) => {
          noProxyFetches.push({
            url: String(url),
            hasDispatcher: Boolean(options.dispatcher),
          });
          return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        },
      });
    } finally {
      restoreProxyEnv(originalProxyEnv);
    }
    let concurrentActiveFetches = 0;
    let maxConcurrentFetches = 0;
    const concurrentRun = await cacheSearchAssets({
      documentsPath,
      sourcesPath,
      outDocumentsPath: path.join(tempDir, "concurrent-documents.jsonl"),
      assetDir: path.join(tempDir, "concurrent-assets"),
      publicBaseUrl: "/concurrent/search-assets",
      reportPath: path.join(tempDir, "concurrent-report.json"),
      refresh: true,
      dryRun: true,
      limit: 3,
      concurrency: 2,
      fetchImpl: async () => {
        concurrentActiveFetches += 1;
        maxConcurrentFetches = Math.max(maxConcurrentFetches, concurrentActiveFetches);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrentActiveFetches -= 1;
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      },
    });
    const sameUrlDocumentsPath = path.join(tempDir, "same-url-documents.jsonl");
    const sameUrlSourcesPath = path.join(tempDir, "same-url-sources.json");
    await Promise.all([
      fs.writeFile(sameUrlDocumentsPath, `${JSON.stringify(fixtureSameUrlImageDocument)}\n`, "utf8"),
      fs.writeFile(sameUrlSourcesPath, `${JSON.stringify([fixtureSource], null, 2)}\n`, "utf8"),
    ]);
    const sameUrlRun = await cacheSearchAssets({
      documentsPath: sameUrlDocumentsPath,
      sourcesPath: sameUrlSourcesPath,
      outDocumentsPath: sameUrlDocumentsPath,
      assetDir: path.join(tempDir, "same-url-assets"),
      publicBaseUrl: "/same-url/search-assets",
      reportPath: path.join(tempDir, "same-url-report.json"),
      fetchImpl: async () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    });
    const failedAssetRun = await cacheSearchAssets({
      documentsPath,
      sourcesPath,
      outDocumentsPath: path.join(tempDir, "failed-asset-documents.jsonl"),
      assetDir: path.join(tempDir, "failed-asset-assets"),
      publicBaseUrl: "/failed/search-assets",
      reportPath: path.join(tempDir, "failed-asset-report.json"),
      refresh: true,
      dryRun: true,
      limit: 2,
      fetchImpl: async () => {
        throw new Error("This operation was aborted");
      },
    });
    const storedDocuments = parseJsonl(await fs.readFile(documentsPath, "utf8"));
    const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");
    const cardSource = await fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8");
    const schemaSource = await fs.readFile(path.join(ROOT_DIR, "search/schemas.js"), "utf8");
    const packageJson = await readJson(path.join(ROOT_DIR, "package.json"));
    const cacheScript = await fs.readFile(path.join(ROOT_DIR, "scripts/cache-search-assets.ts"), "utf8");
    const importScript = await fs.readFile(path.join(ROOT_DIR, "scripts/import-search-index.ts"), "utf8");
    const importerUtilsSource = await fs.readFile(path.join(ROOT_DIR, "scripts/search-crawler-utils.ts"), "utf8");
    const assetProxySource = await fs.readFile(path.join(ROOT_DIR, "api/search-asset.js"), "utf8");
    const uploadScript = await fs.readFile(path.join(ROOT_DIR, "scripts/upload-search-assets-r2.ts"), "utf8");
    const candidates = getAssetCacheCandidates(fixtureDocument);
    const videoCandidates = getAssetCacheCandidates(fixtureVideoDocument);
    const extensionlessThumbnailCandidates = getAssetCacheCandidates(fixtureExtensionlessThumbnailDocument);
    const sameUrlCandidates = getAssetCacheCandidates(fixtureSameUrlImageDocument);
    const preservedAssetDocuments = preserveCachedAssetFields([
      {
        ...fixtureDocument,
        cachedUrl: "",
        cachedThumbnailUrl: "",
      },
      {
        ...fixtureVideoDocument,
        cachedUrl: "",
        cachedThumbnailUrl: "",
      },
      {
        ...fixtureDocument,
        id: "fixture-image-asset-new-thumbnail",
        thumbnailUrl: "https://example.test/new-thumb.jpg",
        cachedUrl: "",
        cachedThumbnailUrl: "",
      },
    ], [
      {
        ...fixtureDocument,
        cachedUrl: "/cached/search-assets/fixture-source/photo-old.jpg",
        cachedThumbnailUrl: "/cached/search-assets/fixture-source/thumb-old.jpg",
      },
      {
        ...fixtureVideoDocument,
        cachedUrl: "/cached/search-assets/fixture-source/video-original-should-not-survive.mp4",
        cachedThumbnailUrl: "/cached/search-assets/fixture-source/video-thumb-old.jpg",
      },
    ]);
    const headProxyFetches = [];
    const headProxyResponse = await invokeSearchAssetProxy({
      method: "HEAD",
      assetUrl: "http://www.rodong.rep.kp/photo.jpg",
      fetchImpl: async (url, options = {}) => {
        headProxyFetches.push({ url: String(url), method: options.method || "GET" });
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": "1234",
          },
        });
      },
    });
    const rangeProxyFetches = [];
    const rangeProxyResponse = await invokeSearchAssetProxy({
      method: "GET",
      assetUrl: "http://www.korean-books.com.kp/book.pdf",
      headers: { range: "bytes=0-3" },
      fetchImpl: async (url, options = {}) => {
        rangeProxyFetches.push({
          url: String(url),
          method: options.method || "GET",
          range: options.headers?.Range || options.headers?.range || "",
        });
        return new Response(Buffer.from([0x25, 0x50, 0x44, 0x46]), {
          status: 206,
          headers: {
            "content-type": "application/pdf",
            "content-length": "4",
            "content-range": "bytes 0-3/100",
            "accept-ranges": "bytes",
          },
        });
      },
    });
    const kcnaImageProxyFetches = [];
    const kcnaImageProxyResponse = await invokeSearchAssetProxy({
      method: "GET",
      assetUrl: "http://www.kcna.kp/en/image/q/example.kcmsf",
      fetchImpl: async (url, options = {}) => {
        kcnaImageProxyFetches.push({ url: String(url), method: options.method || "GET" });
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      },
    });
    const kcnaArticleProxyResponse = await invokeSearchAssetProxy({
      method: "GET",
      assetUrl: "http://www.kcna.kp/en/article/q/example.kcmsf",
      fetchImpl: async () => {
        throw new Error("KCNA article pages must not be fetched through the asset proxy");
      },
    });
    const originalAssetProxyEnv = snapshotProxyEnv();
    const outboundProxyFetches = [];
    const noProxyAssetFetches = [];
    try {
      clearProxyEnv();
      process.env.DPRK_SEARCH_ASSET_PROXY = "http://proxy.example.test:3128";
      await invokeSearchAssetProxy({
        method: "GET",
        assetUrl: "http://www.rodong.rep.kp/photo.jpg",
        fetchImpl: async (url, options = {}) => {
          outboundProxyFetches.push({
            url: String(url),
            hasDispatcher: Boolean(options.dispatcher),
          });
          return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        },
      });
      process.env.NO_PROXY = ".rep.kp";
      await invokeSearchAssetProxy({
        method: "GET",
        assetUrl: "http://www.rodong.rep.kp/photo.jpg",
        fetchImpl: async (url, options = {}) => {
          noProxyAssetFetches.push({
            url: String(url),
            hasDispatcher: Boolean(options.dispatcher),
          });
          return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        },
      });
    } finally {
      restoreProxyEnv(originalAssetProxyEnv);
    }
    const provider = new LocalJsonSearchProvider({ documents: storedDocuments, sources: [fixtureSource] });
    const result = await provider.searchDocuments("원산갈마", { tab: "image" });
    const uploadedObjects = [];
    const r2 = await uploadSearchAssetsToR2({
      documentsPath,
      sourcesPath,
      outDocumentsPath: documentsPath,
      assetDir,
      reportPath: path.join(tempDir, "r2-report.json"),
      publicBaseUrl: "https://pub-example.r2.dev",
      endpoint: "https://account.r2.cloudflarestorage.com",
      bucket: "nkarchive-search-assets",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      headObjectImpl: async () => {
        const error = new Error("HTTP 404");
        error.status = 404;
        throw error;
      },
      putObjectImpl: async ({ key, contentType }) => {
        uploadedObjects.push({ key, contentType });
      },
    });
    const uploadedStoredDocuments = parseJsonl(await fs.readFile(documentsPath, "utf8"));
    const thumbnailCandidate = candidates.find((candidate) => candidate.targetField === "cachedThumbnailUrl");

    assert.equal(candidates.some((candidate) => candidate.targetField === "cachedThumbnailUrl"), true, "asset cache should mirror thumbnails");
    assert.equal(candidates.some((candidate) => candidate.targetField === "cachedUrl"), true, "asset cache should mirror primary image/PDF files");
    assert.equal(videoCandidates.some((candidate) => candidate.targetField === "cachedThumbnailUrl"), true, "video search records should mirror thumbnails");
    assert.equal(videoCandidates.some((candidate) => candidate.targetField === "cachedUrl"), false, "video originals must not be mirrored or proxied");
    assert.equal(extensionlessThumbnailCandidates.some((candidate) => candidate.targetField === "cachedThumbnailUrl"), true, "asset cache should mirror extensionless KCNA-style image endpoint thumbnails");
    assert.equal(sameUrlCandidates.length, 1, "asset cache should mirror a shared thumbnailUrl/url source asset only once");
    assert.deepEqual(sameUrlCandidates[0]?.targetFields, ["cachedThumbnailUrl", "cachedUrl"], "shared thumbnailUrl/url assets should update both cached fields from one mirrored object");
    assert.equal(inferExtension("http://www.kcna.kp/en/image/q/example.kcmsf", "image"), ".jpg", "extensionless KCNA image endpoints should be stored with a browser-friendly image extension");
    assert.equal(preservedAssetDocuments[0].cachedThumbnailUrl, "/cached/search-assets/fixture-source/thumb-old.jpg", "search reimports should preserve cached thumbnail URLs when the source thumbnail URL is unchanged");
    assert.equal(preservedAssetDocuments[0].cachedUrl, "/cached/search-assets/fixture-source/photo-old.jpg", "search reimports should preserve cached primary asset URLs when the source asset URL is unchanged");
    assert.equal(preservedAssetDocuments[1].cachedThumbnailUrl, "/cached/search-assets/fixture-source/video-thumb-old.jpg", "search reimports should preserve cached video thumbnails");
    assert.equal(preservedAssetDocuments[1].cachedUrl, "", "search reimports should not preserve cached video originals");
    assert.equal(preservedAssetDocuments[2].cachedThumbnailUrl, "", "search reimports should not reuse stale cached thumbnails after the source thumbnail URL changes");
    assert.equal(fetchedAssetUrls.includes("https://example.test/video.mp4"), false, "asset cache must never fetch video originals");
    assert.equal(createAssetFetchUrl("https://example.test/thumb.jpg", { baseUrl: "/api/search-asset" }), "/api/search-asset?url=https%3A%2F%2Fexample.test%2Fthumb.jpg", "asset fetch proxy helper should support same-origin proxy URLs");
    assert.equal(proxyRun.report.fetchProxy.mode, "template", "asset cache should report configured fetch proxy mode");
    assert.equal(envProxyRun?.report?.outboundProxy?.mode, "env", "asset cache should report env-based outbound proxy mode");
    assert.equal(envProxyFallbackRun?.report?.cached, 1, "asset cache should recover through direct retry when a configured outbound proxy route times out");
    assert.equal(noProxyRun?.report?.outboundProxy?.mode, "direct", "NO_PROXY should bypass env proxy dispatchers for matching source asset hosts");
    assert.equal(report.selectedDocuments, 2, "asset cache reports should distinguish selected source documents from the full index size");
    assert.equal(report.assetCoverage.before.candidates, 3, "asset cache reports should count every cacheable asset candidate before a mirror pass");
    assert.equal(report.assetCoverage.before.missing, 3, "asset cache reports should expose uncached asset candidates before a mirror pass");
    assert.equal(report.assetCoverage.after.cached, 3, "asset cache reports should expose cached asset candidate coverage after a mirror pass");
    assert.equal(report.assetCoverage.after.selectedMissing, 0, "asset cache reports should show whether the selected mirror scope still has missing assets");
    assert.equal(report.assetCoverage.after.bySource[0]?.sourceId, "fixture-source", "asset cache coverage reports should break candidate counts down by source");
    assert.equal(skippedSourceRun.report.selectedDocuments, 0, "asset cache --source should allow targeted runs without consuming attempts on other sources");
    assert.equal(skippedSourceRun.report.assetCoverage.before.selectedCandidates, 0, "asset cache --source reports should expose zero selected candidates when no documents match");
    assert.equal(skippedSourceRun.report.attempted, 0, "asset cache --source should not fetch assets for unselected sources");
    assert.equal(skippedSourceRunFetches.length, 0, "asset cache --source should avoid all network fetches when no documents match");
    assert.equal(excludedSourceRun.report.selectedDocuments, 0, "asset cache --exclude-source should omit excluded sources from the work set");
    assert.equal(excludedSourceRun.report.attempted, 0, "asset cache --exclude-source should not consume attempts on excluded sources");
    assert.equal(excludedSourceRunFetches.length, 0, "asset cache --exclude-source should avoid excluded-source network fetches");
    assert.equal(proxyRun.report.cached, 3, "proxied dry run should still cover image primary, image thumbnail, and video thumbnail assets");
    assert.equal(proxyFetchedAssetUrls.includes(createAssetFetchUrl("https://example.test/thumb.jpg", { template: proxyFetchTemplate })), true, "asset cache should fetch thumbnails through the configured backend proxy");
    assert.equal(proxyFetchedAssetUrls.includes("https://example.test/thumb.jpg"), false, "asset cache should not fetch blocked thumbnail hosts directly when a backend proxy is configured");
    assert.equal(proxyFetchedAssetUrls.includes(createAssetFetchUrl("https://example.test/video.mp4", { template: proxyFetchTemplate })), false, "backend proxy configuration must not make video originals cacheable");
    assert.equal(envProxyFetches[0]?.url, "https://example.test/thumb.jpg", "asset cache should still request the source asset URL when using an HTTP proxy dispatcher");
    assert.equal(envProxyFetches[0]?.hasDispatcher, true, "asset cache should honor HTTPS_PROXY for direct source asset fetches");
    assert.deepEqual(envProxyFallbackFetches.map((fetch) => fetch.hasDispatcher), [true, false], "asset cache should retry direct when an outbound proxy route times out before returning source asset bytes");
    assert.equal(noProxyFetches[0]?.hasDispatcher, false, "asset cache should honor NO_PROXY for hosts that should stay direct");
    assert.equal(concurrentRun.report.concurrency, 2, "asset cache reports should record the configured worker concurrency");
    assert.equal(maxConcurrentFetches, 2, "asset cache should fetch independent assets concurrently so one slow DPRK host does not block the whole mirror pass");
    assert.equal(sameUrlRun.report.attempted, 1, "asset cache should not attempt duplicate fetches when thumbnailUrl and url point to the same file");
    assert.equal(sameUrlRun.documents[0].cachedThumbnailUrl, sameUrlRun.documents[0].cachedUrl, "same-source image assets should reuse one cached file for thumbnail and primary image display");
    assert.equal(failedAssetRun.report.failed, 2, "asset cache reports should keep failed mirror attempt counts");
    assert.equal(failedAssetRun.report.failureSummary.bySource[0]?.sourceId, "fixture-source", "asset cache reports should summarize failures by source");
    assert.equal(failedAssetRun.report.failureSummary.bySource[0]?.failed, 2, "asset cache source failure summaries should count failed assets");
    assert.equal(failedAssetRun.report.failureSummary.byError[0]?.errorType, "timeout", "asset cache reports should classify timeout-like failures");
    assert.equal(failedAssetRun.report.failureSummary.byError[0]?.failed, 2, "asset cache error summaries should count failed assets by error class");
    assert.equal(report.cached, 3, "asset cache should write image primary, image thumbnail, and video thumbnail assets");
    assert.equal(documents[0].cachedThumbnailUrl.startsWith("/cached/search-assets/fixture-source/"), true, "cached thumbnail URL should use the configured public base");
    assert.equal(documents[0].cachedUrl.startsWith("/cached/search-assets/fixture-source/"), true, "cached primary URL should use the configured public base");
    assert.equal(documents[1].cachedThumbnailUrl.startsWith("/cached/search-assets/fixture-source/"), true, "video thumbnail URL should use the configured public base");
    assert.equal(documents[1].cachedUrl, "", "video documents should not receive cachedUrl for the original video");
    assert.equal(storedDocuments[0].cachedThumbnailUrl, documents[0].cachedThumbnailUrl, "stored JSONL should persist cached thumbnail URLs");
    assert.equal(result.documents[0].cachedThumbnailUrl, documents[0].cachedThumbnailUrl, "local provider should preserve cached thumbnail URLs for UI rendering");
    assert.equal(schemaSource.includes("cachedUrl"), true, "normalized document schema should include cachedUrl");
    assert.equal(schemaSource.includes("cachedThumbnailUrl"), true, "normalized document schema should include cachedThumbnailUrl");
    assert.equal(portalSource.includes("const imageSrc = getImageDisplaySrc(result)"), true, "image cards should use mirrored asset helper output");
    assert.equal(portalSource.includes("if (imageSrc)"), true, "image cards should not assign an empty src when no mirrored/source image is available");
    assert.equal(portalSource.includes('imageWrap.dataset.fallback = "이미지 미러링 필요"'), true, "image cards without a usable image URL should show the media fallback state");
    assert.equal(portalSource.includes("getConfiguredAssetProxyUrl"), true, "UI should support a configured GCP/server-side asset proxy for cache misses");
    assert.equal(portalSource.includes("DPRK_SEARCH_CONFIG"), true, "asset proxy should be configured through DPRK_SEARCH_CONFIG");
    assert.equal(portalSource.includes("getFallbackAssetSrc"), true, "media previews should retry alternate indexed assets when a cached/proxied preview is unavailable");
    assert.equal(portalSource.includes("const displayUrl = createSearchAssetDisplayUrl(value);"), true, "document media fallbacks should stay on cached, public, or same-origin proxied asset URLs instead of leaking blocked source URLs");
    assert.equal(cardSource.includes("const displayUrl = createSearchAssetDisplayUrl(thumbnailUrl);"), true, "source-card thumbnail fallbacks should stay on cached, public, or same-origin proxied asset URLs instead of leaking blocked source URLs");
    assert.equal(portalSource.includes("retriedFallback"), true, "media fallback retries should not loop forever after source asset failure");
    assert.equal(portalSource.includes("shouldUseMediaFallbackTimer"), true, "lazy media previews should not be downgraded from cached assets to blocked originals by a blind timeout");
    assert.equal(portalSource.includes('media.loading !== "lazy"'), true, "image fallback timers should only apply to eagerly loaded media");
    assert.equal(portalSource.includes("i1.ytimg.com"), true, "YouTube RSS thumbnails should load directly instead of being sent through the DPRK source asset proxy");
    assert.equal(portalSource.includes("i4.ytimg.com"), true, "YouTube RSS thumbnail shard hosts should be treated as public direct assets");
    assert.equal(portalSource.includes("isKcnaImageEndpoint"), true, "UI asset routing should treat extensionless KCNA image endpoints as preview assets");
    assert.equal(portalSource.includes("document.createElement(\"video\")"), false, "video document previews should render thumbnails, not playable video originals");
    assert.equal(portalSource.includes("createSearchAssetProxyUrl"), true, "uncached source assets should fall back to a same-origin asset proxy");
    assert.equal(portalSource.includes("frame.src = src"), true, "document PDF preview should render the chosen cached/source URL inline");
    assert.equal(assetProxySource.includes("ALLOWED_ASSET_HOSTS"), true, "asset proxy should restrict upstream hosts to the configured search scope");
    assert.equal(assetProxySource.includes("ProxyAgent"), true, "same-origin asset proxy should support outbound HTTP proxy dispatchers for blocked source hosts");
    assert.equal(assetProxySource.includes("DPRK_SEARCH_ASSET_PROXY"), true, "same-origin asset proxy should support a dedicated production asset proxy environment variable");
    assert.equal(cacheScript.includes("ProxyAgent"), true, "asset cache worker should support HTTP_PROXY/HTTPS_PROXY dispatchers for source asset fetches");
    assert.equal(importerUtilsSource.includes("NO_PROXY"), true, "official-site crawler should honor standard NO_PROXY bypass lists for mixed direct/proxied DPRK hosts");
    assert.equal(importScript.includes("preserveCachedAssetFields"), true, "search import should keep mirrored asset URLs when regenerating documents.jsonl");
    assert.equal(cacheScript.includes('getArgumentValue("--proxy")'), true, "asset cache CLI should support --proxy for one-off DPRK source asset mirroring");
    assert.equal(cacheScript.includes("shouldAllowAssetProxyDirectFallback"), true, "asset cache worker should share the crawler's bounded direct retry behavior for upstream-blocked proxies");
    assert.equal(cacheScript.includes('getArgumentValue("--concurrency")'), true, "asset cache CLI should support --concurrency for production mirror workers");
    assert.equal(cacheScript.includes('getArgumentList("--source", "--sources")'), true, "asset cache CLI should support targeted source mirroring");
    assert.equal(cacheScript.includes('getArgumentList("--exclude-source", "--exclude-sources")'), true, "asset cache CLI should support excluding temporarily blocked source hosts");
    assert.equal(cacheScript.includes("outboundProxy"), true, "asset cache reports should distinguish HTTP proxy dispatchers from backend asset-proxy fetches");
    assert.equal(cacheScript.includes("summarizeAssetCacheCoverage"), true, "asset cache reports should expose overall and selected cached-asset coverage instead of only attempted fetches");
    assert.equal(cacheScript.includes("--allow-failures"), true, "asset cache CLI should require an explicit opt-in before a failed production mirror pass exits successfully");
    assert.equal(cacheScript.includes("Asset cache failed for"), true, "asset cache CLI should surface failed mirror passes as deployment-blocking diagnostics");
    assert.equal(cacheScript.includes("failureSummary"), true, "asset cache reports should summarize failed mirror passes by source and error class");
    assert.equal(outboundProxyFetches[0]?.hasDispatcher, true, "same-origin asset proxy should honor the configured outbound proxy for source asset fetches");
    assert.equal(noProxyAssetFetches[0]?.hasDispatcher, false, "same-origin asset proxy should honor NO_PROXY for direct source asset hosts");
    assert.equal(assetProxySource.includes("isDirectAssetUrl"), true, "asset proxy should reject non-asset article/page URLs");
    assert.equal(assetProxySource.includes("isKcnaImageEndpoint"), true, "asset proxy should allow extensionless KCNA image endpoints without allowing article pages");
    assert.equal(assetProxySource.includes("video/"), false, "same-origin asset proxy should not proxy video originals");
    assert.equal(assetProxySource.includes("mp4"), false, "same-origin asset proxy should reject mp4 originals");
    assert.equal(assetProxySource.includes("MAX_ASSET_BYTES"), true, "asset proxy should cap response size");
    assert.equal(assetProxySource.includes("setAssetSecurityHeaders"), true, "same-origin asset proxy should centralize response security headers");
    assert.equal(assetProxySource.includes("Content-Security-Policy"), true, "same-origin asset proxy should sandbox proxied SVG/PDF responses");
    assert.equal(assetProxySource.includes("Cross-Origin-Resource-Policy"), true, "same-origin asset proxy should prevent cross-origin embedding abuse");
    assert.deepEqual(headProxyFetches, [{ url: "http://www.rodong.rep.kp/photo.jpg", method: "HEAD" }], "HEAD asset proxy requests should stay HEAD upstream instead of downloading the asset body");
    assert.equal(headProxyResponse.statusCode, 200, "HEAD asset proxy requests should return successful asset metadata");
    assert.equal(headProxyResponse.body, undefined, "HEAD asset proxy requests should not write a response body");
    assert.equal(headProxyResponse.headers.get("content-length"), "1234", "HEAD asset proxy requests should preserve upstream content length metadata");
    assert.equal(headProxyResponse.headers.get("content-security-policy")?.includes("default-src 'none'"), true, "HEAD asset proxy responses should keep security headers");
    assert.deepEqual(rangeProxyFetches, [{ url: "http://www.korean-books.com.kp/book.pdf", method: "GET", range: "bytes=0-3" }], "range asset proxy requests should forward the browser Range header upstream");
    assert.equal(rangeProxyResponse.statusCode, 206, "range asset proxy requests should preserve partial-content status");
    assert.equal(rangeProxyResponse.headers.get("content-range"), "bytes 0-3/100", "range asset proxy requests should preserve upstream Content-Range metadata");
    assert.equal(rangeProxyResponse.headers.get("accept-ranges"), "bytes", "range asset proxy requests should preserve byte-range support metadata");
    assert.equal(Buffer.from(rangeProxyResponse.body).toString("utf8"), "%PDF", "range asset proxy requests should return the requested partial body");
    assert.deepEqual(kcnaImageProxyFetches, [{ url: "http://www.kcna.kp/en/image/q/example.kcmsf", method: "GET" }], "extensionless KCNA image endpoints should pass through the asset proxy as images");
    assert.equal(kcnaImageProxyResponse.statusCode, 200, "extensionless KCNA image endpoints should return proxied image bytes");
    assert.equal(kcnaArticleProxyResponse.statusCode, 400, "KCNA article pages must remain blocked by the asset proxy");
    assert.equal(cacheScript.includes("DEFAULT_PUBLIC_ASSET_BASE_URL"), true, "asset cache script should expose a deployable public asset base URL option");
    assert.equal(cacheScript.includes("--fetch-proxy-template"), true, "asset cache script should support crawler-side backend fetch proxy configuration");
    assert.equal(uploadScript.includes("R2_PUBLIC_BASE_URL"), true, "R2 uploader should be configured through environment variables");
    assert.equal(uploadScript.includes("createSignedR2Request"), true, "R2 uploader should sign S3-compatible requests");
    assert.equal(createR2ObjectKey(fixtureDocument, thumbnailCandidate), "search/assets/fixture-source/thumbnailUrl-c0c33a3c66918cfb.jpg", "R2 object keys should be deterministic and deduplicated by source URL hash");
    assert.equal(createR2PublicUrl("search/assets/fixture-source/thumb.jpg", "https://pub-example.r2.dev"), "https://pub-example.r2.dev/search/assets/fixture-source/thumb.jpg", "R2 public URL helper should map object keys to public URLs");
    assert.equal(uploadedObjects.length, 3, "R2 upload should upload the cached image primary, image thumbnail, and video thumbnail only");
    assert.equal(uploadedObjects.some((object) => object.key.includes("video.mp4")), false, "R2 upload must not upload video originals");
    assert.equal(r2.documents[1].cachedUrl, "", "R2 upload must keep video original cachedUrl empty");
    assert.equal(uploadedStoredDocuments[1].cachedThumbnailUrl.startsWith("https://pub-example.r2.dev/search/assets/fixture-source/"), true, "R2 upload should rewrite video thumbnails to the public R2 URL");
    assert.equal(packageJson.scripts["cache:search-assets"], "node scripts/cache-search-assets.ts", "package scripts should expose the asset mirroring step");
    assert.equal(packageJson.scripts["upload:search-assets"], "node scripts/upload-search-assets-r2.ts", "package scripts should expose the R2 upload step");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function assertEmptyIndexState() {
  const provider = new LocalJsonSearchProvider({ documents: [], sources: [] });
  const result = await provider.searchDocuments("화성");
  assert.equal(result.status, "empty_index", "empty local index should report empty_index");
  assert.deepEqual(result.documents, [], "empty local index must not return documents");

  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");
  assert.equal(portalSource.includes("아직 색인된 문서가 없습니다."), true, "UI must include the empty-index state copy");
}

async function assertNoResultsOfferIndexedSuggestions(fixtureDocuments, fixtureSources) {
  const provider = new LocalJsonSearchProvider({ documents: fixtureDocuments, sources: fixtureSources });
  const [result, suggestions, portalSource, css] = await Promise.all([
    provider.searchDocuments("화성지구 1ㄷ"),
    provider.getSuggestions("화성지구 1ㄷ"),
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.deepEqual(result.documents, [], "fixture should represent a no-results query with real suggestions available");
  assert.equal(suggestions.some((suggestion) => suggestion.label === "화성지구 1단계"), true, "no-results recovery suggestions should come from the suggestion index/dictionary");
  assert.equal(portalSource.includes("createNoResultsState"), true, "results UI should have a distinct no-results state");
  assert.equal(portalSource.includes("getNoResultSuggestions"), true, "no-results state should query provider suggestions instead of hardcoding examples");
  assert.equal(portalSource.includes("getSuggestionSearchValue(suggestion) !== currentQuery"), true, "no-results recovery should avoid offering the exact same query as a no-op");
  assert.equal(portalSource.includes("추천 검색어"), true, "no-results state should label recovery suggestions");
  assert.equal(portalSource.includes("createTabRecoveryLink"), true, "no-results state should offer a direct recovery path from narrow tabs to 전체");
  assert.equal(portalSource.includes("전체 탭에서 보기"), true, "narrow-tab no-results state should label the 전체-tab recovery action");
  assert.equal(portalSource.includes("createSuggestionResultParams"), true, "no-results recovery suggestions should share source-aware suggestion routing");
  assert.equal(portalSource.includes('suggestion.type === "source"'), true, "no-results source suggestions should become source-filtered result links");
  assert.equal(portalSource.includes("getSuggestionResultSourceId"), true, "no-results operator suggestions should share source-filter conflict handling");
  assert.equal(portalSource.includes("hasPositiveSourceOperator(parsedSuggestionQuery) ? \"\" : filters.sourceIds?.[0] || \"\""), true, "no-results site:/source: operator suggestions should not inherit a conflicting active source filter");
  assert.equal(portalSource.includes("filters.sourceIds?.[0] || \"\""), true, "no-results non-source suggestions should preserve an active source filter while trying a better query");
  assert.equal(portalSource.includes('createResultParams(query, "all", filters.sourceIds?.[0] || "", 1, filters.sort, filters)'), true, "tab recovery should preserve an active source filter, sort, and date range while widening to 전체");
  assert.equal(portalSource.includes("navigateToResults(params)"), true, "no-results recovery suggestions should navigate through the same search flow");
  assert.equal(css.includes(".search-state-suggestions"), true, "no-results recovery suggestions should have scoped styling");
  assert.equal(css.includes(".search-state-tab-recovery"), true, "tab recovery action should have scoped styling");
}

async function assertFixtureSearchWorksOnlyInTests(fixtureDocuments, fixtureSources, productionDocumentsText) {
  const fixtureProvider = new LocalJsonSearchProvider({ documents: fixtureDocuments, sources: fixtureSources });
  const fixtureResult = await fixtureProvider.searchDocuments("화성");
  assert.equal(fixtureResult.documents[0]?.id, "fixture-hwaseong-article", "fixture search should work in tests");
  assert.equal(productionDocumentsText.includes("fixture-hwaseong-article"), false, "fixture document must not exist in production index");
}

async function assertHwaseongSearchDoesNotReturnWeakResults(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const productionSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));
  const provider = new LocalJsonSearchProvider({ documents: productionDocuments, sources: productionSources });
  const result = await provider.searchDocuments("화성");
  const weakTitlePattern = /거리 사진 모음|사진 모음|generic|placeholder/i;

  assert.equal(result.documents[0]?.mediaType, "article", "전체 검색에서 화성처럼 기사와 이미지가 함께 맞는 질의는 기사형 결과가 먼저 와야 합니다");
  for (const document of result.documents) {
    const searchableText = [
      document.title,
      document.snippet,
      document.body,
      document.sourceName,
      ...(document.aliases || []),
    ].join(" ");
    assert.equal(searchableText.includes("화성"), true, `"화성" result must explicitly match the query: ${document.title}`);
    assert.equal(weakTitlePattern.test(document.title), false, `"화성" must not return weak placeholder-looking result: ${document.title}`);
  }
}

async function assertDecoratedShipNameSearchMatchesIndexedTitles(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const productionSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));
  const provider = new LocalJsonSearchProvider({ documents: productionDocuments, sources: productionSources });
  const result = await provider.searchDocuments("최현호");

  assert.equal(result.documents.length > 0, true, "최현호 should match indexed documents whose source-visible titles use decorative quotes");
  assert.equal(
    result.documents.some((document) => /《최현》호/.test(`${document.title} ${document.snippet} ${document.body}`)),
    true,
    "query 최현호 should find records written as 《최현》호",
  );
}

async function assertFullWidthSearchNormalization() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "fixture-source",
        name: "시험자료원",
        sourceType: "official_site",
        baseUrl: "https://fixture.example/",
        languages: ["ko"],
        mediaTypes: ["article"],
      },
    ],
    documents: [
      {
        id: "fixture-fullwidth-number",
        title: "원산갈마해안관광지구 １단계 준공",
        snippet: "전각 숫자가 들어간 문서입니다.",
        body: "원산갈마해안관광지구 １단계와 ２단계 관련 본문입니다.",
        date: "2026-05-19",
        sourceId: "fixture-source",
        sourceName: "시험자료원",
        sourceType: "official_site",
        mediaType: "article",
        url: "https://fixture.example/fullwidth",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const halfWidthResult = await provider.searchDocuments("원산갈마해안관광지구 1단계");
  const fullWidthResult = await provider.searchDocuments("원산갈마해안관광지구 ２단계");

  assert.equal(halfWidthResult.documents[0]?.id, "fixture-fullwidth-number", "half-width numbers should match full-width numbers in indexed fields");
  assert.equal(fullWidthResult.documents[0]?.id, "fixture-fullwidth-number", "full-width query numbers should match normalized half-width search tokens");
}

async function assertKoreanSourceSpacingIsNormalized() {
  const normalized = normalizeKoreanSourceSpacing(
    "조선로동당 총비서 이시며 경애하는 김정은 동지 께서 현지지도하시였다 . 김정은 동지 의 연설을 원수님 을 우러러 들었다.",
  );
  const bodyNormalized = normalizeKoreanSourceBodySpacing(
    "비실태를 료해하시였다 .\n김정은 동지 께서 현지지도하시였다.\n\n원문 두번째 문단이다.",
  );
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");

  assert.equal(normalized.includes("김정은동지께서"), true, "김정은동지 honorific should stay attached to the name and particle");
  assert.equal(normalized.includes("총비서이시며"), true, "honorific predicate particles should attach to source text");
  assert.equal(normalized.includes("김정은동지의 연설"), true, "possessive particle after 김정은동지 should attach");
  assert.equal(normalized.includes("원수님을"), true, "object particle after 원수님 should attach");
  assert.equal(normalized.includes("하시였다. 김정은동지"), true, "punctuation should attach to the preceding sentence, not begin the next display chunk");
  assert.equal(bodyNormalized.includes("료해하시였다.\n김정은동지께서"), true, "body normalization should preserve source line breaks while fixing Korean spacing");
  assert.equal(bodyNormalized.includes("\n\n원문 두번째 문단이다."), true, "body normalization should preserve explicit paragraph breaks");
  assert.equal(portalSource.includes("cleanPreviewBlockText"), true, "document viewer should preserve indexed source line breaks");
  assert.equal(portalSource.includes("findParagraphEnd"), false, "document viewer must not invent paragraph breaks by text length");
}

async function assertBroadEnglishPrefixesDoNotExpandIntoEntityResults() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "kcna",
        name: "조선중앙통신",
        sourceType: "official_site",
        baseUrl: "http://www.kcna.kp/",
        languages: ["ko", "en"],
        mediaTypes: ["article"],
        aliases: ["KCNA", "Korean Central News Agency"],
      },
      {
        id: "fixture-source",
        name: "Fixture Source",
        sourceType: "archive",
        baseUrl: "https://example.test/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: [],
      },
    ],
    documents: [
      {
        id: "fixture-kcna-source-name-only",
        title: "보통 기사",
        snippet: "본문에는 검색용 영문 출처 별칭이 없습니다.",
        body: "본문 고유 내용 조선중앙통신 KCNA Korean Central News Agency",
        date: "2026-05-19",
        sourceId: "kcna",
        sourceName: "조선중앙통신",
        sourceType: "official_site",
        mediaType: "article",
        url: "http://www.kcna.kp/kp/article/q/source-name-only.kcmsf",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-korean-content",
        title: "Korean Central Television Report",
        snippet: "A document that explicitly contains the English query.",
        body: "",
        date: "2026-05-18",
        sourceId: "fixture-source",
        sourceName: "Fixture Source",
        sourceType: "archive",
        mediaType: "article",
        url: "https://example.test/korean-content",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "en",
        aliases: [],
      },
    ],
  });
  const [koreanResults, qwertyResults, partialJamoResults] = await Promise.all([
    provider.searchDocuments("Korean"),
    provider.searchDocuments("rla wjddms"),
    provider.searchDocuments("김정ㅇ"),
  ]);

  assert.deepEqual(koreanResults.documents.map((document) => document.id), ["fixture-korean-content"], "broad English prefixes must not expand into known-entity source-name results");
  assert.deepEqual(qwertyResults.documents, [], "QWERTY known-entity completion must remain strict when no document explicitly matches 김정은");
  assert.deepEqual(partialJamoResults.documents, [], "partial jamo completion must remain strict when no document explicitly matches 김정은");
}

async function assertSourceNameQueriesPrioritizeMatchingSource(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const productionSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));
  const provider = new LocalJsonSearchProvider({ documents: productionDocuments, sources: productionSources });
  const rodongResult = await provider.searchDocuments("로동신문", { tab: "all", limit: 20 });
  const kcnaResult = await provider.searchDocuments("조선중앙통신", { tab: "all", limit: 20 });

  assert.equal(rodongResult.documents[0]?.sourceId, "rodong-sinmun", "exact 로동신문 searches should prioritize 로동신문's own indexed documents over articles merely mentioning 로동신문");
  assert.equal(rodongResult.groupedSources[0]?.sourceId, "rodong-sinmun", "exact 로동신문 searches should show the 로동신문 source group first");
  assert.equal(kcnaResult.documents[0]?.sourceId, "kcna", "exact 조선중앙통신 searches should prioritize 조선중앙통신's own indexed documents over syndicated/archive mentions");
  assert.equal(kcnaResult.groupedSources[0]?.sourceId, "kcna", "exact 조선중앙통신 searches should show the 조선중앙통신 source group first");
}

async function assertMultiTermLocalSearchRequiresEveryTerm() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "fixture-source",
        name: "Fixture Daily",
        sourceType: "archive",
        baseUrl: "https://example.test/",
        languages: ["ko"],
        mediaTypes: ["article", "image"],
        aliases: [],
      },
    ],
    documents: [
      {
        id: "fixture-pyongyang-night",
        title: "평양의 야경",
        snippet: "대동강반의 불빛을 담은 사진 기록입니다.",
        date: "2026-05-19",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "image",
        url: "https://example.test/pyongyang-night",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-pyongyang-only",
        title: "평양 소식",
        snippet: "야간 경관과 무관한 기사입니다.",
        date: "2026-05-18",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "article",
        url: "https://example.test/pyongyang",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-night-only",
        title: "야경 사진",
        snippet: "다른 도시와 관련된 사진입니다.",
        date: "2026-05-17",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "image",
        url: "https://example.test/night",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-kim-pyongyang",
        title: "현지지도 보도",
        snippet: "김정은 동지께서 평양에서 사업을 료해하시였다.",
        date: "2026-05-16",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "article",
        url: "https://example.test/kim-pyongyang",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const nightResult = await provider.searchDocuments("평양 야경");
  const personPlaceResult = await provider.searchDocuments("김정은 평양");
  const searchSource = await fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8");

  assert.deepEqual(nightResult.documents.map((document) => document.id), ["fixture-pyongyang-night"], "local multi-term search should require every meaningful term while allowing Korean particles between terms");
  assert.equal(nightResult.documents[0]?.scoreReason.includes("multi:"), true, "multi-term local matches should use the AND scoring path");
  assert.equal(nightResult.documents[0]?.highlightRanges.title.length >= 2, true, "multi-term result highlights should mark each matched term");
  assert.deepEqual(personPlaceResult.documents.map((document) => document.id), ["fixture-kim-pyongyang"], "multi-term local search should match terms across approved snippet/body fields");
  assert.equal(searchSource.includes("requiredTermGroups"), true, "local search should model multi-word document search as required term groups");
}

async function assertQuotedPhraseSearchRequiresExactPhrase() {
  const sources = [{
    id: "fixture-source",
    name: "Fixture Daily",
    sourceType: "archive",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article"],
    aliases: [],
  }];
  const documents = [
    {
      id: "fixture-exact-phrase",
      title: "원산갈마해안관광지구 준공식 성대히 진행",
      snippet: "원산갈마해안관광지구 준공식 소식입니다.",
      date: "2026-05-20",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/exact-phrase",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-scattered-terms",
      title: "원산갈마해안관광지구 새 소식",
      snippet: "관광지구 주변에서 다른 준공식 준비가 진행됩니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/scattered-terms",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const quotedResult = await provider.searchDocuments('"원산갈마해안관광지구 준공식"');
  const [documentSearchSource, meiliSource, meiliResult] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/MeilisearchSearchProvider.js"), "utf8"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          hits: documents,
          estimatedTotalHits: documents.length,
          processingTimeMs: 0,
          facetDistribution: { displaySourceId: { "fixture-source": documents.length } },
        }),
      }),
    }).searchDocuments('"원산갈마해안관광지구 준공식"'),
  ]);

  assert.deepEqual(quotedResult.documents.map((document) => document.id), ["fixture-exact-phrase"], "quoted phrase search should require the exact contiguous phrase in local search");
  assert.equal(quotedResult.documents[0]?.scoreReason.includes("phrase"), true, "quoted phrase local matches should use the phrase-required scoring path");
  assert.equal(quotedResult.query, '"원산갈마해안관광지구 준공식"', "quoted phrases should remain shareable in the visible query state");
  assert.equal(documentSearchSource.includes("createDocumentSyntaxQuery"), true, "document search should parse exact phrase syntax centrally");
  assert.equal(documentSearchSource.includes("filterDocumentsForExactPhraseQuery"), true, "document search should expose exact phrase filtering for backend parity");
  assert.equal(meiliSource.includes("getDocumentSearchTextQueries"), true, "Meilisearch document queries should strip quote syntax before backend retrieval");
  assert.equal(meiliSource.includes("filterDocumentsForExactPhraseQuery"), true, "Meilisearch results should be post-filtered with the same exact phrase semantics as local search");
  assert.deepEqual(meiliResult.documents.map((document) => document.id), ["fixture-exact-phrase"], "Meilisearch quoted phrase search should filter backend candidates to exact phrase matches");
  assert.equal(meiliResult.total, 1, "Meilisearch quoted phrase totals should reflect phrase-filtered candidate results");
}

async function assertExcludedTermSearchFiltersResults() {
  const sources = [{
    id: "fixture-source",
    name: "Fixture Daily",
    sourceType: "archive",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article"],
    aliases: [],
  }];
  const documents = [
    {
      id: "fixture-wonsan-port",
      title: "원산 항구 새 소식",
      snippet: "원산 항구와 시내 소식입니다.",
      date: "2026-05-20",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/wonsan-port",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-wonsan-kalma",
      title: "원산갈마해안관광지구 준공식",
      snippet: "원산과 갈마를 함께 다루는 기사입니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/wonsan-kalma",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const excludedResult = await provider.searchDocuments("원산 -갈마");
  const excludedPhraseResult = await provider.searchDocuments('원산 -"항구 새 소식"');
  const notResult = await provider.searchDocuments("원산 NOT 갈마");
  const notPhraseResult = await provider.searchDocuments('원산 NOT "항구 새 소식"');
  const meiliRequests = [];
  const [documentSearchSource, meiliSource, cliSource, meiliResult] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/MeilisearchSearchProvider.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/search-local.ts"), "utf8"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        meiliRequests.push({ url, body });
        return {
          ok: true,
          json: async () => ({
            hits: documents,
            estimatedTotalHits: documents.length,
            processingTimeMs: 0,
            facetDistribution: { displaySourceId: { "fixture-source": documents.length } },
          }),
        };
      },
    }).searchDocuments("원산 NOT 갈마"),
  ]);

  assert.deepEqual(excludedResult.documents.map((document) => document.id), ["fixture-wonsan-port"], "local -term searches should exclude documents containing the omitted term");
  assert.deepEqual(excludedPhraseResult.documents.map((document) => document.id), ["fixture-wonsan-kalma"], "local -\"phrase\" searches should exclude documents containing the omitted phrase");
  assert.deepEqual(notResult.documents.map((document) => document.id), excludedResult.documents.map((document) => document.id), "local NOT term searches should behave like the existing -term exclusion syntax");
  assert.deepEqual(notPhraseResult.documents.map((document) => document.id), excludedPhraseResult.documents.map((document) => document.id), "local NOT \"phrase\" searches should behave like the existing -\"phrase\" exclusion syntax");
  assert.equal(excludedResult.query, "원산 -갈마", "negative terms should remain shareable in the visible query state");
  assert.equal(notResult.query, "원산 NOT 갈마", "NOT terms should remain shareable in the visible query state");
  assert.deepEqual(getDocumentSearchTextQueries("원산 NOT 갈마"), ["원산"], "backend text queries should strip NOT exclusions before retrieval");
  assert.equal(documentSearchSource.includes("filterDocumentsForExcludedTerms"), true, "document search should expose shared exclusion filtering");
  assert.equal(documentSearchSource.includes("documentMatchesExcludedTerms"), true, "document search should test negative terms against approved indexed fields");
  assert.equal(documentSearchSource.includes("normalizeGoogleNotOperators"), true, "document search should centralize Google-like NOT exclusion normalization");
  assert.equal(meiliSource.includes("hasExcludedTermQuery"), true, "Meilisearch should detect negative-term syntax before backend retrieval");
  assert.equal(meiliSource.includes("filterDocumentsForExcludedTerms"), true, "Meilisearch should post-filter backend candidates with the local negative-term semantics");
  assert.equal(meiliRequests[0]?.body.q, "원산", "Meilisearch NOT searches should strip excluded terms from the backend query");
  assert.deepEqual(meiliResult.documents.map((document) => document.id), ["fixture-wonsan-port"], "Meilisearch NOT searches should filter backend candidates");
  assert.equal(meiliResult.total, 1, "Meilisearch NOT totals should reflect filtered candidate results");
  assert.equal(cliSource.includes("NOT"), true, "local search CLI help should document NOT exclusion syntax");
}

async function assertOrSearchSupportsAlternatives() {
  const sources = [{
    id: "fixture-source",
    name: "Fixture Daily",
    sourceType: "archive",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article"],
    aliases: [],
  }];
  const documents = [
    {
      id: "fixture-wonsan",
      title: "원산 항구 새 소식",
      snippet: "원산 시내 소식입니다.",
      date: "2026-05-20",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/wonsan",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-hwaseong",
      title: "화성지구 살림집 소식",
      snippet: "화성지구의 새 거리 소식입니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/hwaseong",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-scattered-phrase",
      title: "원산 관광지구 일반 소식",
      snippet: "준공식과 무관하게 흩어진 단어만 들어있는 기사입니다.",
      date: "2026-05-18",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/scattered",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-unrelated",
      title: "농업 부문 소식",
      snippet: "검색 분기와 관계없는 기사입니다.",
      date: "2026-05-17",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/unrelated",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const orResult = await provider.searchDocuments("원산 OR 화성지구");
  const pipeResult = await provider.searchDocuments("원산 | 화성지구");
  const phraseOrResult = await provider.searchDocuments('"원산 항구" OR 화성지구');
  const parenthesizedOrResult = await provider.searchDocuments("(원산 OR 화성지구)");
  const parenthesizedSuffixOrResult = await provider.searchDocuments("(항구 OR 화성지구) 새");

  const meiliRequests = [];
  const meiliResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliRequests.push({ url, body });
      const hits = body.q === "원산"
        ? [{ ...documents[0], _rankingScore: 0.81 }]
        : (body.q === "화성지구" ? [{ ...documents[1], _rankingScore: 0.91 }] : []);
      return {
        ok: true,
        json: async () => ({
          hits,
          estimatedTotalHits: hits.length,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": hits.length } },
        }),
      };
    },
  }).searchDocuments("원산 OR 화성지구");

  const parenthesizedMeiliRequests = [];
  const parenthesizedMeiliResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      parenthesizedMeiliRequests.push({ url, body });
      const hits = body.q === "항구 새"
        ? [{ ...documents[0], _rankingScore: 0.81 }]
        : (body.q === "화성지구 새" ? [{ ...documents[1], _rankingScore: 0.91 }] : []);
      return {
        ok: true,
        json: async () => ({
          hits,
          estimatedTotalHits: hits.length,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": hits.length } },
        }),
      };
    },
  }).searchDocuments("(항구 OR 화성지구) 새");

  const [documentSearchSource, meiliSource, cliSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/MeilisearchSearchProvider.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/search-local.ts"), "utf8"),
  ]);

  assert.deepEqual(orResult.documents.map((document) => document.id), ["fixture-wonsan", "fixture-hwaseong", "fixture-scattered-phrase"], "local OR searches should match any alternative branch instead of requiring the literal OR token");
  assert.deepEqual(pipeResult.documents.map((document) => document.id), orResult.documents.map((document) => document.id), "pipe syntax should behave like the Google-like OR operator");
  assert.deepEqual(phraseOrResult.documents.map((document) => document.id), ["fixture-wonsan", "fixture-hwaseong"], "quoted phrases inside OR branches should only constrain that branch");
  assert.deepEqual(parenthesizedOrResult.documents.map((document) => document.id), orResult.documents.map((document) => document.id), "parenthesized OR searches should behave like plain Google-like OR searches");
  assert.deepEqual(parenthesizedSuffixOrResult.documents.map((document) => document.id), ["fixture-wonsan", "fixture-hwaseong"], "parenthesized OR groups should share surrounding required terms across each branch");
  assert.equal(orResult.documents[0]?.scoreReason.startsWith("or:"), true, "local OR matches should expose the alternative scoring path");
  assert.equal(orResult.query, "원산 OR 화성지구", "OR queries should remain shareable in the visible query state");
  assert.deepEqual(getDocumentSearchTextQueries("(항구 OR 화성지구) 새"), ["항구 새", "화성지구 새"], "backend OR branch queries should strip grouping parentheses and keep shared suffix terms");
  assert.equal(documentSearchSource.includes("splitDocumentOrBranches"), true, "document search should parse OR branches centrally");
  assert.equal(documentSearchSource.includes("cleanDocumentOrBranchBoundary"), true, "document search should clean orphan grouping parentheses from backend OR branches");
  assert.equal(documentSearchSource.includes("hasAlternativeQuery"), true, "document search should expose alternative-query detection for backend parity");
  assert.equal(documentSearchSource.includes("getDocumentSearchTextQueries"), true, "document search should expose per-branch backend query text");
  assert.equal(meiliSource.includes("getDocumentSearchTextQueries"), true, "Meilisearch should receive stripped per-branch query text");
  assert.equal(meiliSource.includes("Promise.all(backendQueries.map"), true, "Meilisearch OR searches should run one strict backend query per branch");
  assert.equal(meiliSource.includes("sortMergedMeilisearchDocuments"), true, "Meilisearch OR searches should merge and sort branch results before pagination");
  assert.deepEqual(meiliRequests.map((request) => request.body.q), ["원산", "화성지구"], "Meilisearch OR searches should send each branch as its own all-terms query");
  assert.equal(meiliRequests.every((request) => request.body.matchingStrategy === "all"), true, "Meilisearch OR branches should keep strict AND semantics within each branch");
  assert.equal(meiliRequests.every((request) => request.body.limit >= 500), true, "Meilisearch OR searches should fetch a wide candidate window before client-side merging");
  assert.deepEqual(meiliResult.documents.map((document) => document.id), ["fixture-hwaseong", "fixture-wonsan"], "Meilisearch OR searches should merge, dedupe, and rank backend branch results");
  assert.equal(meiliResult.total, 2, "Meilisearch OR totals should reflect merged candidate results");
  assert.deepEqual(parenthesizedMeiliRequests.map((request) => request.body.q), ["항구 새", "화성지구 새"], "Meilisearch parenthesized OR groups should receive clean branch queries with shared terms");
  assert.deepEqual(parenthesizedMeiliResult.documents.map((document) => document.id), ["fixture-hwaseong", "fixture-wonsan"], "Meilisearch parenthesized OR searches should merge clean grouped branch results");
  assert.equal(cliSource.includes("OR"), true, "local search CLI help should document OR syntax for debugging production queries");
}

async function assertRequiredOperatorSyntaxBehavesLikeStrictTerms() {
  const sources = [{
    id: "fixture-source",
    name: "Fixture Daily",
    sourceType: "archive",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article"],
    aliases: [],
  }];
  const documents = [
    {
      id: "fixture-wonsan-kalma",
      title: "원산갈마 관광지구 소식",
      snippet: "원산갈마 준공식 소식입니다.",
      date: "2026-05-20",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/wonsan-kalma",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-wonsan-only",
      title: "원산 항구 소식",
      snippet: "해안과 무관한 원산 기사입니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/wonsan-only",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-kalma-only",
      title: "갈마 해안 소식",
      snippet: "항구와 무관한 갈마 기사입니다.",
      date: "2026-05-18",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/kalma-only",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const strictResult = await provider.searchDocuments("원산 갈마");
  const andResult = await provider.searchDocuments("원산 AND 갈마");
  const plusResult = await provider.searchDocuments("+원산 +갈마");
  const phrasePlusResult = await provider.searchDocuments('+"원산갈마 관광지구"');
  const curlyPhrasePlusResult = await provider.searchDocuments("+“원산갈마 관광지구”");

  const meiliRequests = [];
  const meiliResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [{ ...documents[0], _rankingScore: 0.91 }],
          estimatedTotalHits: 1,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": 1 } },
        }),
      };
    },
  }).searchDocuments("원산 AND 갈마");

  const plusPhraseMeiliRequests = [];
  const plusPhraseMeiliResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      plusPhraseMeiliRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [{ ...documents[0], _rankingScore: 0.91 }],
          estimatedTotalHits: 1,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": 1 } },
        }),
      };
    },
  }).searchDocuments('+"원산갈마 관광지구"');

  const [documentSearchSource, cliSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/search-local.ts"), "utf8"),
  ]);

  assert.deepEqual(strictResult.documents.map((document) => document.id), ["fixture-wonsan-kalma"], "baseline strict multi-term search should require all terms");
  assert.deepEqual(andResult.documents.map((document) => document.id), strictResult.documents.map((document) => document.id), "local AND syntax should behave like the existing strict all-term search");
  assert.deepEqual(plusResult.documents.map((document) => document.id), strictResult.documents.map((document) => document.id), "local +term syntax should behave like required terms instead of literal plus signs");
  assert.deepEqual(phrasePlusResult.documents.map((document) => document.id), ["fixture-wonsan-kalma"], "+\"phrase\" syntax should keep quoted phrase semantics after dropping the required marker");
  assert.deepEqual(curlyPhrasePlusResult.documents.map((document) => document.id), ["fixture-wonsan-kalma"], "+“phrase” syntax should keep quoted phrase semantics after dropping the required marker");
  assert.equal(andResult.query, "원산 AND 갈마", "AND syntax should remain shareable in the visible query state");
  assert.deepEqual(getDocumentSearchTextQueries('+"원산갈마 관광지구"'), ["원산갈마 관광지구"], "+\"phrase\" syntax should strip the required marker from backend text queries");
  assert.deepEqual(getDocumentSearchTextQueries("+“원산갈마 관광지구”"), ["원산갈마 관광지구"], "+“phrase” syntax should strip the required marker from backend text queries");
  assert.equal(documentSearchSource.includes("normalizeGoogleRequiredOperators"), true, "document search should centralize Google-like required operator normalization");
  assert.equal(documentSearchSource.includes("transformUnquotedSegments"), true, "required operator normalization should not rewrite quoted text");
  assert.equal(String(meiliRequests[0]?.body.q || "").includes("AND"), false, "Meilisearch AND searches should strip the AND marker before backend retrieval");
  assert.equal(plusPhraseMeiliRequests[0]?.body.q, "원산갈마 관광지구", "Meilisearch +\"phrase\" searches should strip the required marker before backend retrieval");
  assert.equal(String(plusPhraseMeiliRequests[0]?.body.q || "").includes("+"), false, "Meilisearch +\"phrase\" searches should not send a literal plus marker");
  assert.deepEqual(meiliResult.documents.map((document) => document.id), ["fixture-wonsan-kalma"], "Meilisearch AND searches should still return strict all-term candidates");
  assert.deepEqual(plusPhraseMeiliResult.documents.map((document) => document.id), ["fixture-wonsan-kalma"], "Meilisearch +\"phrase\" searches should still return exact phrase candidates");
  assert.equal(cliSource.includes("AND"), true, "local search CLI help should document AND syntax");
  assert.equal(cliSource.includes("+term"), true, "local search CLI help should document +term syntax");
}

async function assertTitleRestrictedSearchRequiresTitleMatches() {
  const sources = [{
    id: "fixture-source",
    name: "Fixture Daily",
    sourceType: "archive",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article"],
    aliases: [],
  }];
  const documents = [
    {
      id: "fixture-title-wonsan",
      title: "원산 항구 새 소식",
      snippet: "준공식 준비 소식입니다.",
      date: "2026-05-20",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/title-wonsan",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-snippet-wonsan",
      title: "항구 준공식 소식",
      snippet: "원산 시내에서 진행된 행사입니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/snippet-wonsan",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-title-hwaseong",
      title: "화성지구 살림집 소식",
      snippet: "평양의 새 거리 소식입니다.",
      date: "2026-05-18",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/title-hwaseong",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const titleResult = await provider.searchDocuments("intitle:원산 준공식");
  const phraseTitleResult = await provider.searchDocuments('title:"원산 항구" 준공식');
  const koreanTitleResult = await provider.searchDocuments("제목:화성지구");
  const titleOrResult = await provider.searchDocuments("원산 OR intitle:화성지구");

  const meiliRequests = [];
  const meiliResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [
            { ...documents[0], _rankingScore: 0.91 },
            { ...documents[1], _rankingScore: 0.95 },
          ],
          estimatedTotalHits: 2,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": 2 } },
        }),
      };
    },
  }).searchDocuments("intitle:원산 준공식");

  const [documentSearchSource, meiliSource, cliSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/MeilisearchSearchProvider.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/search-local.ts"), "utf8"),
  ]);

  assert.deepEqual(titleResult.documents.map((document) => document.id), ["fixture-title-wonsan"], "local intitle: searches should require the title term while allowing remaining query terms in approved fields");
  assert.deepEqual(phraseTitleResult.documents.map((document) => document.id), ["fixture-title-wonsan"], "local title:\"phrase\" searches should require the full title phrase");
  assert.deepEqual(koreanTitleResult.documents.map((document) => document.id), ["fixture-title-hwaseong"], "Korean 제목: should behave as a title-restricted operator");
  assert.deepEqual([...titleOrResult.documents.map((document) => document.id)].sort(), ["fixture-snippet-wonsan", "fixture-title-hwaseong", "fixture-title-wonsan"], "title restrictions inside OR should constrain only their own alternative branch");
  assert.equal(titleResult.query, "intitle:원산 준공식", "title operators should remain shareable in the visible query state");
  assert.equal(titleResult.documents[0]?.scoreReason.includes("title"), true, "title-restricted matches should score through title-aware paths");
  assert.equal(documentSearchSource.includes("extractTitleOperators"), true, "document search should parse title operators centrally");
  assert.equal(documentSearchSource.includes("filterDocumentsForTitleQuery"), true, "document search should expose title filtering for backend parity");
  assert.equal(documentSearchSource.includes("hasTitleQuery"), true, "document search should expose title-query detection for backend parity");
  assert.equal(meiliSource.includes("hasTitleQuery"), true, "Meilisearch should detect title-restricted syntax before backend retrieval");
  assert.equal(meiliSource.includes("filterDocumentsForTitleQuery"), true, "Meilisearch should post-filter backend candidates with local title semantics");
  assert.equal(meiliRequests[0]?.body.q, "원산 준공식", "Meilisearch title searches should strip the intitle: operator while preserving the title term for candidate retrieval");
  assert.equal(meiliRequests[0]?.body.limit >= 500, true, "Meilisearch title searches should fetch a wide candidate window before client-side filtering");
  assert.deepEqual(meiliResult.documents.map((document) => document.id), ["fixture-title-wonsan"], "Meilisearch intitle: searches should filter backend candidates to title matches");
  assert.equal(meiliResult.total, 1, "Meilisearch intitle: totals should reflect title-filtered candidate results");
  assert.equal(cliSource.includes("intitle:"), true, "local search CLI help should document intitle: syntax");
  assert.equal(cliSource.includes("title:"), true, "local search CLI help should document title: syntax");
}

async function assertUrlRestrictedSearchRequiresUrlMatches() {
  const sources = [{
    id: "fixture-source",
    name: "Fixture Daily",
    sourceType: "archive",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article"],
    aliases: [],
  }];
  const documents = [
    {
      id: "fixture-url-match",
      title: "김정은 현지지도",
      snippet: "URL 제한과 본문 검색어가 함께 맞는 기사입니다.",
      date: "2026-05-20",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/Home/index/disp/8541/ko",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-url-text-only",
      title: "김정은 행사 소식",
      snippet: "검색어는 맞지만 URL 경로가 다릅니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/articles/8541/ko",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-url-only",
      title: "민주조선 문서",
      snippet: "본문 검색어 없이 URL만 맞는 기사입니다.",
      body: "문서 하단 주소 꼬리말: https://example.test/Home/index/disp/9000/ko",
      date: "2026-05-18",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/Home/index/disp/9000/ko",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-url-footer-only",
      title: "경제 기사",
      snippet: "본문 검색어는 없지만 주소 꼬리말에 disp가 들어간 기사입니다.",
      body: "공유 주소: https://example.test/Home/index/disp/9100/ko",
      date: "2026-05-17",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/Home/index/disp/9100/ko",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const urlAndTextResult = await provider.searchDocuments("inurl:disp 김정은");
  const urlOnlyResult = await provider.searchDocuments("inurl:disp");
  const numericUrlResult = await provider.searchDocuments("url:9000");
  const koreanUrlResult = await provider.searchDocuments("주소:articles 김정은");
  const urlOrResult = await provider.searchDocuments("김정은 OR inurl:9000");

  const meiliRequests = [];
  const meiliResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [
            { ...documents[0], _rankingScore: 0.91 },
            { ...documents[1], _rankingScore: 0.95 },
            { ...documents[2], _rankingScore: 0.9 },
            { ...documents[3], _rankingScore: 0.89 },
          ],
          estimatedTotalHits: 4,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": 4 } },
        }),
      };
    },
  }).searchDocuments("inurl:disp 김정은");

  const [documentSearchSource, meiliSource, cliSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/MeilisearchSearchProvider.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/search-local.ts"), "utf8"),
  ]);

  assert.deepEqual(urlAndTextResult.documents.map((document) => document.id), ["fixture-url-match"], "local inurl: searches should require URL terms while allowing remaining query terms in approved fields");
  assert.deepEqual([...urlOnlyResult.documents.map((document) => document.id)].sort(), ["fixture-url-footer-only", "fixture-url-match", "fixture-url-only"], "bare inurl: searches should work even when there is no body/title query");
  assert.deepEqual(numericUrlResult.documents.map((document) => document.id), ["fixture-url-only"], "local url: numeric path searches should match URL fields");
  assert.deepEqual(koreanUrlResult.documents.map((document) => document.id), ["fixture-url-text-only"], "Korean 주소: should behave as a URL-restricted operator");
  assert.deepEqual([...urlOrResult.documents.map((document) => document.id)].sort(), ["fixture-url-match", "fixture-url-only", "fixture-url-text-only"], "URL restrictions inside OR should constrain only their own alternative branch");
  assert.equal(urlAndTextResult.query, "inurl:disp 김정은", "URL operators should remain shareable in the visible query state");
  assert.equal(urlOnlyResult.documents[0]?.scoreReason.includes("url"), true, "URL-only matches should expose URL-aware scoring");
  assert.equal(documentSearchSource.includes("extractUrlOperators"), true, "document search should parse URL operators centrally");
  assert.equal(documentSearchSource.includes("filterDocumentsForUrlQuery"), true, "document search should expose URL filtering for backend parity");
  assert.equal(documentSearchSource.includes("hasUrlQuery"), true, "document search should expose URL-query detection for backend parity");
  assert.equal(meiliSource.includes("hasUrlQuery"), true, "Meilisearch should detect URL-restricted syntax before backend retrieval");
  assert.equal(meiliSource.includes("filterDocumentsForUrlQuery"), true, "Meilisearch should post-filter backend candidates with local URL semantics");
  assert.equal(meiliRequests[0]?.body.q, "김정은 disp", "Meilisearch URL searches should strip inurl: while preserving the URL term for candidate retrieval");
  assert.equal(meiliRequests[0]?.body.attributesToSearchOn.includes("url"), true, "Meilisearch URL searches should search primary URLs");
  assert.equal(meiliRequests[0]?.body.attributesToSearchOn.includes("archiveUrl"), true, "Meilisearch URL searches should search archive URLs");
  assert.equal(meiliRequests[0]?.body.limit >= 500, true, "Meilisearch URL searches should fetch a wide candidate window before client-side filtering");
  assert.deepEqual(meiliResult.documents.map((document) => document.id), ["fixture-url-match"], "Meilisearch inurl: searches should filter backend candidates to URL matches");
  assert.equal(meiliResult.total, 1, "Meilisearch inurl: totals should reflect URL-filtered candidate results");
  assert.equal(cliSource.includes("inurl:"), true, "local search CLI help should document inurl: syntax");
  assert.equal(cliSource.includes("url:"), true, "local search CLI help should document url: syntax");
}

async function assertAllScopedSearchOperatorsRequireFollowingTerms() {
  const sources = [{
    id: "fixture-source",
    name: "Fixture Daily",
    sourceType: "archive",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article"],
    aliases: [],
  }];
  const documents = [
    {
      id: "fixture-alltitle-wonsan",
      title: "원산갈마해안관광지구 준공식 진행",
      snippet: "대표참석 행사본문을 담은 기사입니다.",
      date: "2026-05-20",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/articles/wonsan-kalma-opening",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-alltitle-snippet-only",
      title: "원산갈마해안관광지구 새 소식",
      snippet: "준공식 소식은 본문에만 나옵니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/articles/wonsan-kalma-news",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-alltitle-hwaseong",
      title: "화성지구 살림집 입주 소식",
      snippet: "평양의 새 거리 소식입니다.",
      date: "2026-05-18",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/articles/hwaseong-housing",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-allurl-match",
      title: "경로 조건 일치 문서",
      snippet: "URL의 모든 조각이 맞는 문서입니다.",
      date: "2026-05-17",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/Home/index/disp/8541/ko",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-allurl-missing-index",
      title: "경로 조건 일부 문서",
      snippet: "URL의 일부 조각만 맞는 문서입니다.",
      date: "2026-05-16",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/Home/articles/disp/8541/ko",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const allTitleResult = await provider.searchDocuments("allintitle:원산갈마해안관광지구 준공식");
  const allTitlePhraseResult = await provider.searchDocuments('allintitle:"원산갈마해안관광지구 준공식"');
  const allTitleOrResult = await provider.searchDocuments("행사본문 OR allintitle:화성지구 살림집");
  const allUrlResult = await provider.searchDocuments("allinurl:Home index disp");
  const allUrlPhraseResult = await provider.searchDocuments('allinurl:"Home index" disp');
  const allUrlOrResult = await provider.searchDocuments("행사본문 OR allinurl:Home index disp");

  const meiliTitleRequests = [];
  const meiliTitleResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliTitleRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [
            { ...documents[0], _rankingScore: 0.91 },
            { ...documents[1], _rankingScore: 0.95 },
          ],
          estimatedTotalHits: 2,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": 2 } },
        }),
      };
    },
  }).searchDocuments("allintitle:원산갈마해안관광지구 준공식");

  const meiliUrlRequests = [];
  const meiliUrlResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliUrlRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [
            { ...documents[3], _rankingScore: 0.91 },
            { ...documents[4], _rankingScore: 0.95 },
          ],
          estimatedTotalHits: 2,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": 2 } },
        }),
      };
    },
  }).searchDocuments("allinurl:Home index disp");

  const [documentSearchSource, meiliSource, cliSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/MeilisearchSearchProvider.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/search-local.ts"), "utf8"),
  ]);

  assert.deepEqual(allTitleResult.documents.map((document) => document.id), ["fixture-alltitle-wonsan"], "local allintitle: searches should require every following term in the title");
  assert.deepEqual(allTitlePhraseResult.documents.map((document) => document.id), ["fixture-alltitle-wonsan"], "local allintitle: searches should keep quoted title phrases together");
  assert.deepEqual([...allTitleOrResult.documents.map((document) => document.id)].sort(), ["fixture-alltitle-hwaseong", "fixture-alltitle-wonsan"], "allintitle: should apply only inside its own OR branch");
  assert.deepEqual(allUrlResult.documents.map((document) => document.id), ["fixture-allurl-match"], "local allinurl: searches should require every following term in URL fields");
  assert.deepEqual(allUrlPhraseResult.documents.map((document) => document.id), ["fixture-allurl-match"], "local allinurl: searches should keep quoted URL phrases together");
  assert.deepEqual([...allUrlOrResult.documents.map((document) => document.id)].sort(), ["fixture-alltitle-wonsan", "fixture-allurl-match"], "allinurl: should apply only inside its own OR branch");
  assert.equal(allTitleResult.query, "allintitle:원산갈마해안관광지구 준공식", "allintitle: should remain shareable in the visible query state");
  assert.equal(allUrlResult.query, "allinurl:Home index disp", "allinurl: should remain shareable in the visible query state");
  assert.equal(documentSearchSource.includes("extractAllTitleOperators"), true, "document search should parse allintitle: centrally");
  assert.equal(documentSearchSource.includes("extractAllUrlOperators"), true, "document search should parse allinurl: centrally");
  assert.equal(meiliSource.includes("hasTitleQuery"), true, "Meilisearch should reuse title-restricted filtering for allintitle:");
  assert.equal(meiliSource.includes("hasUrlQuery"), true, "Meilisearch should reuse URL-restricted filtering for allinurl:");
  assert.equal(meiliTitleRequests[0]?.body.q, "원산갈마해안관광지구 준공식", "Meilisearch allintitle: searches should strip the operator and preserve all scoped terms for candidate retrieval");
  assert.equal(meiliUrlRequests[0]?.body.q, "Home index disp", "Meilisearch allinurl: searches should strip the operator and preserve all URL terms for candidate retrieval");
  assert.deepEqual(meiliTitleResult.documents.map((document) => document.id), ["fixture-alltitle-wonsan"], "Meilisearch allintitle: searches should filter backend candidates to titles containing all scoped terms");
  assert.deepEqual(meiliUrlResult.documents.map((document) => document.id), ["fixture-allurl-match"], "Meilisearch allinurl: searches should filter backend candidates to URLs containing all scoped terms");
  assert.equal(cliSource.includes("allintitle:"), true, "local search CLI help should document allintitle: syntax");
  assert.equal(cliSource.includes("allinurl:"), true, "local search CLI help should document allinurl: syntax");
}

async function assertTextRestrictedSearchRequiresTextMatches() {
  const sources = [{
    id: "fixture-source",
    name: "Fixture Daily",
    sourceType: "archive",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article"],
    aliases: [],
  }];
  const documents = [
    {
      id: "fixture-text-match",
      title: "관광지구 현장 소식",
      snippet: "원산 관련 행사 소식을 본문에서 다룹니다.",
      body: "원산갈마 준공식 준비 소식입니다.",
      date: "2026-05-20",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/text-match",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-title-only",
      title: "원산 행사 소식",
      snippet: "본문에는 다른 내용만 있습니다.",
      body: "제목에만 검색어가 있는 문서입니다.",
      date: "2026-05-19",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/title-only",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-text-body",
      title: "평양 새 거리 소식",
      snippet: "요약에는 단서가 없습니다.",
      body: "화성지구 살림집 입주 소식을 본문에서 다룹니다.",
      date: "2026-05-18",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/body-match",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-alltext-missing",
      title: "준공식 제목만 있는 기사",
      snippet: "원산갈마 소식만 본문에 있습니다.",
      body: "다른 본문입니다.",
      date: "2026-05-17",
      sourceId: "fixture-source",
      sourceName: "Fixture Daily",
      sourceType: "archive",
      mediaType: "article",
      url: "https://example.test/alltext-missing",
      archiveUrl: "",
      cachedUrl: "",
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const textResult = await provider.searchDocuments("intext:원산 행사");
  const phraseTextResult = await provider.searchDocuments('text:"원산 관련" 행사');
  const koreanTextResult = await provider.searchDocuments("본문:화성지구");
  const allTextResult = await provider.searchDocuments("allintext:원산갈마 준공식");
  const allTextPhraseResult = await provider.searchDocuments('allintext:"원산 관련" 행사');
  const textOrResult = await provider.searchDocuments("원산 OR intext:화성지구");

  const meiliTextRequests = [];
  const meiliTextResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliTextRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [
            { ...documents[0], _rankingScore: 0.91 },
            { ...documents[1], _rankingScore: 0.95 },
          ],
          estimatedTotalHits: 2,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": 2 } },
        }),
      };
    },
  }).searchDocuments("intext:원산 행사");

  const meiliAllTextRequests = [];
  const meiliAllTextResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliAllTextRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [
            { ...documents[0], _rankingScore: 0.91 },
            { ...documents[3], _rankingScore: 0.95 },
          ],
          estimatedTotalHits: 2,
          processingTimeMs: 1,
          facetDistribution: { displaySourceId: { "fixture-source": 2 } },
        }),
      };
    },
  }).searchDocuments("allintext:원산갈마 준공식");

  const [documentSearchSource, meiliSource, cliSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/MeilisearchSearchProvider.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/search-local.ts"), "utf8"),
  ]);

  assert.deepEqual(textResult.documents.map((document) => document.id), ["fixture-text-match"], "local intext: searches should require the scoped term in snippet/body text rather than title/source fields");
  assert.deepEqual(phraseTextResult.documents.map((document) => document.id), ["fixture-text-match"], "local text:\"phrase\" searches should require the phrase in snippet/body text");
  assert.deepEqual(koreanTextResult.documents.map((document) => document.id), ["fixture-text-body"], "Korean 본문: should behave as a text-restricted operator");
  assert.deepEqual(allTextResult.documents.map((document) => document.id), ["fixture-text-match"], "local allintext: searches should require every following term in snippet/body text");
  assert.deepEqual(allTextPhraseResult.documents.map((document) => document.id), ["fixture-text-match"], "local allintext: searches should keep quoted text phrases together");
  assert.deepEqual([...textOrResult.documents.map((document) => document.id)].sort(), ["fixture-alltext-missing", "fixture-text-body", "fixture-text-match", "fixture-title-only"], "text restrictions inside OR should constrain only their own alternative branch");
  assert.equal(textResult.query, "intext:원산 행사", "text operators should remain shareable in the visible query state");
  assert.equal(allTextResult.query, "allintext:원산갈마 준공식", "allintext: should remain shareable in the visible query state");
  assert.equal(documentSearchSource.includes("extractTextOperators"), true, "document search should parse intext: centrally");
  assert.equal(documentSearchSource.includes("extractAllTextOperators"), true, "document search should parse allintext: centrally");
  assert.equal(documentSearchSource.includes("filterDocumentsForTextQuery"), true, "document search should expose text filtering for backend parity");
  assert.equal(documentSearchSource.includes("hasTextQuery"), true, "document search should expose text-query detection for backend parity");
  assert.equal(meiliSource.includes("hasTextQuery"), true, "Meilisearch should detect text-restricted syntax before backend retrieval");
  assert.equal(meiliSource.includes("filterDocumentsForTextQuery"), true, "Meilisearch should post-filter backend candidates with local text semantics");
  assert.equal(meiliTextRequests[0]?.body.q, "원산 행사", "Meilisearch intext: searches should strip the operator and preserve scoped terms for candidate retrieval");
  assert.equal(meiliAllTextRequests[0]?.body.q, "원산갈마 준공식", "Meilisearch allintext: searches should strip the operator and preserve all scoped terms for candidate retrieval");
  assert.equal(meiliTextRequests[0]?.body.limit >= 500, true, "Meilisearch text searches should fetch a wide candidate window before client-side filtering");
  assert.deepEqual(meiliTextResult.documents.map((document) => document.id), ["fixture-text-match"], "Meilisearch intext: searches should filter backend candidates to snippet/body text matches");
  assert.deepEqual(meiliAllTextResult.documents.map((document) => document.id), ["fixture-text-match"], "Meilisearch allintext: searches should filter backend candidates to snippet/body text matches");
  assert.equal(cliSource.includes("intext:"), true, "local search CLI help should document intext: syntax");
  assert.equal(cliSource.includes("allintext:"), true, "local search CLI help should document allintext: syntax");
}

async function assertBodyOnlyMatchesDoNotOutrankTitleOrSnippetMatches() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "fixture-source",
        name: "Fixture Daily",
        sourceType: "archive",
        baseUrl: "https://example.test/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: [],
      },
    ],
    documents: [
      {
        id: "fixture-title-pyongyang",
        title: "평양 시민들의 새 소식",
        snippet: "제목에서 검색어가 직접 드러나는 기사입니다.",
        body: "본문은 짧습니다.",
        date: "2026-05-19",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "article",
        url: "https://example.test/title-pyongyang",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-snippet-pyongyang",
        title: "새 제품 전시회",
        snippet: "평양에서 열린 행사 소식입니다.",
        body: "본문은 짧습니다.",
        date: "2026-05-18",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "article",
        url: "https://example.test/snippet-pyongyang",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-body-pyongyang-dateline",
        title: "원산갈마해안관광지구 봉사 시작",
        snippet: "제목과 스니펫에는 검색어가 없는 기사입니다.",
        body: "평양 5월 19일발 조선중앙통신 보도입니다. 본문은 원산갈마해안관광지구 소식을 다룹니다.",
        date: "2026-05-20",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "article",
        url: "https://example.test/body-pyongyang",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const result = await provider.searchDocuments("평양", { tab: "all", limit: 10 });
  const ids = result.documents.map((document) => document.id);
  const bodyOnly = result.documents.find((document) => document.id === "fixture-body-pyongyang-dateline");
  const snippetMatch = result.documents.find((document) => document.id === "fixture-snippet-pyongyang");

  assert.deepEqual(ids.slice(0, 2), ["fixture-title-pyongyang", "fixture-snippet-pyongyang"], "title and snippet matches should outrank body-only dateline/page-text matches");
  assert.equal(bodyOnly, undefined, "body-only dateline matches should be excluded from ordinary location searches");
  assert.equal(Boolean(snippetMatch), true, "substantive snippet matches should remain searchable");
}

async function assertDatelineOnlyMatchesDoNotBehaveLikeSubstantiveSnippets() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "fixture-source",
        name: "Fixture Daily",
        sourceType: "archive",
        baseUrl: "https://example.test/",
        languages: ["ko"],
        mediaTypes: ["article", "image"],
        aliases: [],
      },
    ],
    documents: [
      {
        id: "fixture-substantive-image",
        title: "평양의 야경",
        snippet: "도시 풍경 사진",
        body: "도시 풍경 사진",
        date: "2026-05-19",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "image",
        url: "https://example.test/pyongyang-night.jpg",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-fullwidth-dateline",
        title: "원산갈마해안관광지구건설장 현지료해",
        snippet: "【평양 ４월 ７일발 조선중앙통신】 원산갈마해안관광지구건설장의 운영정형을 현지에서 료해하였다.",
        body: "【평양 ４월 ７일발 조선중앙통신】 원산갈마해안관광지구건설장의 운영정형을 현지에서 료해하였다.",
        date: "2026-05-18",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "article",
        url: "https://example.test/fullwidth-dateline",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const result = await provider.searchDocuments("평양", { tab: "all", limit: 10 });
  const datelineOnly = result.documents.find((document) => document.id === "fixture-fullwidth-dateline");

  assert.equal(result.documents[0]?.id, "fixture-substantive-image", "full-width Korean datelines should not outrank substantive title matches");
  assert.equal(datelineOnly, undefined, "dateline-only snippet matches should not appear as substantive location results");
}

async function assertResultCardsRenderQueryAwareExcerpts() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "fixture-source",
        name: "Fixture Daily",
        sourceType: "archive",
        baseUrl: "https://example.test/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: [],
      },
    ],
    documents: [
      {
        id: "fixture-body-excerpt",
        title: "자료 검색 품질 점검",
        snippet: "첫 문장에는 찾는 단어가 없어서 본문에서 발췌해야 합니다.",
        body: "서두 설명입니다. 여러 문장이 이어진 뒤 핵심검색어가 실제 본문 가운데 나타납니다. 뒤쪽 문장은 발췌 범위를 확인합니다.",
        date: "2026-05-19",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "article",
        url: "https://example.test/body-excerpt",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const result = await provider.searchDocuments("핵심검색어");
  const [document] = result.documents;
  const cardSource = await fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8");
  const css = await fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8");

  assert.equal(document?.id, "fixture-body-excerpt", "document search should match focused body text");
  assert.equal(document.displaySnippet.includes("핵심검색어"), true, "search results should expose a query-aware display snippet");
  assert.equal(document.highlightRanges.snippet.length > 0, true, "search results should expose snippet highlight ranges");
  assert.equal(cardSource.includes("getResultSnippetText"), true, "result cards should render query-aware snippets when available");
  assert.equal(cardSource.includes('Object.hasOwn(result, "displaySnippet")'), true, "result cards should respect intentionally empty cleaned snippets");
  assert.equal(cardSource.includes("if (snippetText) item.append(snippet)"), true, "result cards should not render empty date-only snippet rows");
  assert.equal(cardSource.includes("snippet.append(dateNode)"), false, "result snippets should not prepend date chrome to query-aware excerpts");
  assert.equal(cardSource.includes("appendHighlightedText"), true, "result cards should render provider-supplied highlight ranges without owning search logic");
  assert.equal(css.includes(".source-result-snippet mark"), true, "result highlight styling should be scoped to result cards");
}

async function assertResultSnippetsSuppressArchiveDuplicateChrome() {
  const duplicatedText = "사회주의문명의 눈부신 개화를 우리 땅에서 우리의 자원을 가지고 우리 식으로 안아오려는 조선로동당의 견결한 혁명의지에 의하여 전국각지에 창조의 열풍이 세차게 일고있습니다.";
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "kcna-watch",
        name: "KCNA Watch",
        sourceType: "archive",
        baseUrl: "https://kcnawatch.org/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: [],
      },
    ],
    documents: [
      {
        id: "fixture-kcna-watch-duplicated-snippet",
        title: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행",
        snippet: `사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행 ${duplicatedText} June 26, 2025 ${duplicatedText}`,
        body: "",
        date: "2026-05-20",
        sourceId: "kcna-watch",
        sourceName: "KCNA Watch",
        sourceType: "archive",
        mediaType: "article",
        url: "https://kcnawatch.org/newstream/duplicated-snippet",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const result = await provider.searchDocuments("사회주의문명");
  const [document] = result.documents;
  const documentSearchSource = await fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8");

  assert.equal(document?.id, "fixture-kcna-watch-duplicated-snippet", "duplicated archive snippet fixture should be searchable");
  assert.equal(document.displaySnippet.startsWith(document.title), false, "result snippets should not repeat the already visible result title");
  assert.equal(/June 26, 2025/.test(document.displaySnippet), false, "result snippets should hide KCNA Watch English date separators");
  assert.equal((document.displaySnippet.match(/사회주의문명의 눈부신 개화/g) || []).length, 1, "result snippets should collapse date-separated duplicate text");
  assert.equal(document.displaySnippet.length <= 200, true, "cleaned result snippets should remain compact");
  assert.equal(documentSearchSource.includes("collapseEnglishDateSeparatedDuplicate"), true, "document search should own archive snippet display cleanup");
}

async function assertResultSnippetsSuppressDateOnlyChrome(productionDocumentsText) {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "fixture-source",
        name: "Fixture Daily",
        sourceType: "archive",
        baseUrl: "https://example.test/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: [],
      },
    ],
    documents: [
      {
        id: "fixture-date-only-snippet",
        title: "우리 녀자축구선수들 2026년 아시아축구련맹 경기대회에서 1위 쟁취",
        snippet: "우리 녀자축구선수들 2026년 아시아축구련맹 경기대회에서 1위 쟁취 [2026-05-18]",
        body: "우리 녀자축구선수들 2026년 아시아축구련맹 경기대회에서 1위 쟁취 [2026-05-18]",
        date: "2026-05-18",
        sourceId: "fixture-source",
        sourceName: "Fixture Daily",
        sourceType: "archive",
        mediaType: "article",
        url: "https://example.test/date-only",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const result = await provider.searchDocuments("녀자축구");
  const [document] = result.documents;
  const productionDocuments = parseJsonl(productionDocumentsText);
  const productionSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));
  const productionProvider = new LocalJsonSearchProvider({ documents: productionDocuments, sources: productionSources });
  const productionResult = await productionProvider.searchDocuments("녀자축구", { tab: "all", limit: 10 });
  const dateOnlyPattern = /^(?:[\[(【]\s*)?\d{4}\s*(?:[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}|년\s*\d{1,2}\s*월\s*\d{1,2}\s*일?)\s*(?:[\])】.]|\.)?$/u;
  const documentSearchSource = await fs.readFile(path.join(ROOT_DIR, "search/documentSearch.js"), "utf8");

  assert.equal(document?.id, "fixture-date-only-snippet", "date-only snippet fixture should be searchable from its title");
  assert.equal(document.displaySnippet, "", "title-plus-date snippets should clean to an intentionally empty display snippet");
  assert.equal(productionResult.documents.some((item) => dateOnlyPattern.test(String(item.displaySnippet || "").trim())), false, "production result snippets should not render date-only chrome as summaries");
  assert.equal(documentSearchSource.includes("stripStandaloneDateSnippet"), true, "document search should own standalone date-snippet cleanup");
}

async function assertDistantPageChromeDoesNotDriveSearch(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const productionSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));
  const provider = new LocalJsonSearchProvider({ documents: productionDocuments, sources: productionSources });
  const query = "녀자아시아컵";
  const result = await provider.searchDocuments(query);

  assert.equal(result.documents.some((document) => document.sourceId === "naenara"), true, "녀자아시아컵 should find the real 내나라 visible row");
  assert.equal(result.documents.some((document) => (
    document.sourceId === "rodong-sinmun"
    && !`${document.title} ${document.snippet}`.includes(query)
  )), false, "distant latest-news chrome in long article bodies must not create unrelated 로동신문 matches");
}

async function assertSuggestionsUseIndexAndKnownEntities(fixtureDocuments, fixtureSources) {
  const provider = new LocalJsonSearchProvider({ documents: fixtureDocuments, sources: fixtureSources });
  const operatorProvider = new LocalJsonSearchProvider({
    documents: fixtureDocuments,
    sources: [
      ...fixtureSources,
      {
        id: "rodong-sinmun",
        name: "로동신문",
        sourceType: "official_site",
        baseUrl: "http://www.rodong.rep.kp/",
        languages: ["ko"],
        mediaTypes: ["article", "image"],
        aliases: ["Rodong Sinmun", "Rodong"],
      },
    ],
  });
  const [titleSuggestions, sourceSuggestions, entitySuggestions, hwaseongSuggestions, compositeEnglishSuggestions] = await Promise.all([
    provider.getSuggestions("살림집"),
    provider.getSuggestions("Fixture"),
    provider.getSuggestions("김정ㅇ"),
    provider.getSuggestions("화성"),
    provider.getSuggestions("Kim Jong Un Wonsan"),
  ]);
  const [siteOperatorSuggestions, koreanSiteOperatorSuggestions, sourceOperatorSuggestions, quotedSourceOperatorSuggestions, mediaOperatorSuggestions, languageOperatorSuggestions, koreanLanguageOperatorSuggestions] = await Promise.all([
    operatorProvider.getSuggestions("원산 site:ro"),
    operatorProvider.getSuggestions("사이트:k"),
    operatorProvider.getSuggestions("출처:로동"),
    provider.getSuggestions("source:Fix"),
    provider.getSuggestions("파일형식:"),
    provider.getSuggestions("lang:e"),
    provider.getSuggestions("언어:영"),
  ]);
  const hwaseongLabels = hwaseongSuggestions.map((suggestion) => suggestion.label);
  const titleSuggestion = titleSuggestions.find((suggestion) => suggestion.label === "화성지구 살림집건설 소식");
  const sourceSuggestion = sourceSuggestions.find((suggestion) => suggestion.label === "Fixture Daily");
  const rodongSiteSuggestion = siteOperatorSuggestions.find((suggestion) => suggestion.label === "site:rodong.rep.kp");
  const kpSiteSuggestion = koreanSiteOperatorSuggestions.find((suggestion) => suggestion.label === "사이트:kp");
  const rodongSourceSuggestion = sourceOperatorSuggestions.find((suggestion) => suggestion.label === "출처:로동신문");
  const quotedSourceSuggestion = quotedSourceOperatorSuggestions.find((suggestion) => suggestion.label === "source:\"Fixture Daily\"");

  assert.notEqual(titleSuggestion, undefined, "suggestions should include indexed document titles");
  assert.notEqual(sourceSuggestion, undefined, "suggestions should include indexed source names");
  assert.equal(titleSuggestion?.sourceName, "Fixture Daily", "indexed title suggestions should carry source provenance");
  assert.equal(titleSuggestion?.mediaType, "article", "indexed title suggestions should carry media type provenance");
  assert.equal(titleSuggestion?.description, "Fixture Daily · 기사", "indexed title suggestions should expose compact source/media metadata");
  assert.equal(sourceSuggestion?.description, "아카이브 자료원", "source suggestions should expose source-type metadata");
  assert.equal(entitySuggestions[0]?.label, "김정은", "suggestions should include known dictionary entities");
  assert.equal(entitySuggestions[0]?.description, "추천어", "known dictionary suggestions should identify themselves as suggestions, not fake documents");
  assert.equal(compositeEnglishSuggestions[0]?.label, "김정은 원산갈마해안관광지구", "English person/place input should suggest the normalized Korean search query before submission");
  assert.equal(compositeEnglishSuggestions[0]?.type, "entity", "composite English person/place suggestions should come from the known entity dictionary");
  assert.equal(rodongSiteSuggestion?.value, "원산 site:rodong.rep.kp", "site: autocomplete should preserve the leading query while completing the host filter");
  assert.equal(rodongSiteSuggestion?.type, "operator", "site: autocomplete should mark structured completions as operator suggestions");
  assert.equal(kpSiteSuggestion?.description.includes("자료원"), true, "Korean 사이트: autocomplete should offer a whole .kp host-suffix filter");
  assert.equal(rodongSourceSuggestion?.value, "출처:로동신문", "Korean 출처: autocomplete should complete indexed source names");
  assert.equal(quotedSourceSuggestion?.value, "source:\"Fixture Daily\"", "source: autocomplete should quote source names that contain spaces");
  assert.equal(mediaOperatorSuggestions[0]?.label, "파일형식:문헌", "Korean filetype autocomplete should suggest parser-supported Korean media values");
  assert.equal(languageOperatorSuggestions.some((suggestion) => suggestion.label === "lang:en"), true, "lang: autocomplete should suggest parser-supported language codes");
  assert.equal(koreanLanguageOperatorSuggestions.some((suggestion) => suggestion.label === "언어:영어"), true, "Korean 언어: autocomplete should suggest parser-supported language names");
  assert.deepEqual(
    hwaseongLabels.slice(0, 8),
    ["화성", "화성지구", "화성거리", "화성지구 1단계", "화성지구 2단계", "화성지구 3단계", "화성지구 4단계", "화성락원불고기식당"],
    "화성 suggestions should match the Figma known-entity completion stack without adding fake documents",
  );
  assert.equal(hwaseongSuggestions.every((suggestion) => suggestion.type === "entity"), true, "Figma-style 화성 completions should come from the known entity dictionary");
}

async function assertChoseongSearchIsDisabled(fixtureDocuments, fixtureSources) {
  const provider = new LocalJsonSearchProvider({ documents: fixtureDocuments, sources: fixtureSources });
  const [suggestions, singleConsonantSuggestions, sourceConsonantSuggestions, results] = await Promise.all([
    provider.getSuggestions("ㄱㅈㅇ"),
    provider.getSuggestions("ㄱ"),
    provider.getSuggestions("ㅈ"),
    provider.searchDocuments("ㄱㅈㅇ"),
  ]);

  assert.equal(suggestions.some((suggestion) => suggestion.label === "김정은"), false, "consonant-only suggestions should be disabled");
  assert.deepEqual(singleConsonantSuggestions, [], "single consonant suggestions should be disabled");
  assert.deepEqual(sourceConsonantSuggestions, [], "standalone consonants must not suggest sources or titles");
  assert.deepEqual(results.documents, [], "consonant-only document search should not return results");
}

async function assertPdfTabShowsLiteratureOnly() {
  assert.deepEqual(
    Object.values(RESULT_TABS).map((tab) => tab.label),
    ["전체", "이미지", "동영상", "문헌"],
    "results tabs should include 문헌 after 동영상",
  );

  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "korean-books",
        name: "조선의 출판물",
        sourceType: "official_site",
        baseUrl: "http://www.korean-books.com.kp/",
        languages: ["ko"],
        mediaTypes: ["pdf"],
        aliases: ["Korean Books"],
      },
      {
        id: "fixture-video-source",
        name: "Fixture Video Source",
        sourceType: "video_archive",
        baseUrl: "https://video.example.test/",
        languages: ["ko"],
        mediaTypes: ["video"],
        aliases: [],
      },
    ],
    documents: [
      {
        id: "fixture-literature-pdf",
        title: "조선의 출판물 문헌",
        snippet: "조선의 출판물 PDF 문헌 검색 전용 시험 문서입니다.",
        date: "2026-05-19",
        sourceId: "korean-books",
        sourceName: "조선의 출판물",
        sourceType: "official_site",
        mediaType: "pdf",
        url: "http://www.korean-books.com.kp/fixture.pdf",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: ["문헌"],
      },
      {
        id: "fixture-literature-video",
        title: "조선의 출판물 문헌 영상",
        snippet: "문헌과 같은 질의어를 가진 동영상 시험 문서입니다.",
        date: "2026-05-19",
        sourceId: "fixture-video-source",
        sourceName: "Fixture Video Source",
        sourceType: "video_archive",
        mediaType: "video",
        url: "https://video.example.test/fixture-video",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const pdfResults = await provider.searchDocuments("문헌", { tab: "pdf" });

  assert.equal(pdfResults.documents.length, 1, "문헌 tab should return PDF records");
  assert.equal(pdfResults.documents[0].mediaType, "pdf", "문헌 tab must be backed by PDF mediaType");
}

async function assertPdfLinksBecomeDocuments() {
  const source = {
    id: "korean-books",
    name: "조선의 출판물",
    sourceType: "official_site",
    baseUrl: "http://www.korean-books.com.kp/",
    languages: ["ko"],
    mediaTypes: ["article", "pdf"],
    aliases: ["Korean Books"],
  };
  const html = `
    <main>
      <article>
        <a href="/books/juche-literature.pdf">주체문학론</a>
        <time>2026.5.19</time>
      </article>
    </main>
  `;
  const [entry] = discoverLinkEntries(html, source.baseUrl, source);
  const document = extractPdfDocumentFromLink(entry, source);

  assert.equal(document.mediaType, "pdf", "PDF links should be indexed as PDF documents");
  assert.equal(document.sourceName, "조선의 출판물", "PDF document should keep its source");
  assert.equal(document.title, "주체문학론", "PDF document title should use link text");
  assert.equal(document.date, "2026-05-19", "PDF document should use nearby date text");

  const timestampDocument = extractPdfDocumentFromLink({
    url: "http://www.korean-books.com.kp/KBMbooks/ko/etc/cahier/20260508125846.pdf",
    linkText: "룡문대굴",
    contextText: "룡문대굴 2026 조선출판물수출입사 36 페지",
  }, source);
  assert.equal(timestampDocument.date, "2026-05-08", "Korean Books PDF filenames should provide publication dates when the card only has a year");

  const readablePdf = `
Title: 20250703115805.pdf
URL Source: http://www.korean-books.com.kp/KBMbooks/ko/etc/cahier/20250703115805.pdf
Number of Pages: 3
Markdown Content:
117 324122 21 20 19 18

# 명사십리휴양구역-1

원산갈마관광안내소 갈마백화점 명사십리호텔 묘향호텔

> Wonsan Kalma Tour Information Office

Myongsasimni Resort Area 1 Foreign Languages Publishing House, DPRK 2025
`;
  const enrichedPdf = enrichPdfDocumentWithReadableText({
    ...timestampDocument,
    title: "원산갈마해안관광지구안내",
    url: "http://www.korean-books.com.kp/KBMbooks/ko/etc/cahier/20250703115805.pdf",
  }, readablePdf, { ...source, crawler: { maxPdfTextLength: 2000 } });
  assert.equal(enrichedPdf.body.includes("Wonsan Kalma Tour Information Office"), true, "Korean Books PDF readable snapshots should enrich searchable PDF body text");
  assert.equal(enrichedPdf.body.includes("117 324122"), false, "PDF text enrichment should drop map-coordinate number noise");
}

async function assertReadableSnapshotsBecomeDocuments() {
  const source = {
    id: "fixture-readable",
    name: "Readable Source",
    sourceType: "official_site",
    baseUrl: "https://readable.example.test/",
    languages: ["ko"],
    mediaTypes: ["article", "pdf"],
    aliases: [],
    crawler: {
      entryUrl: "https://readable.example.test/",
      indexEntryUrl: false,
      includeUrlPatterns: ["/article/", ".pdf"],
    },
  };
  const readableHome = `
Title: Readable Source
URL Source: https://readable.example.test/
Markdown Content:
# Readable Source
[실제 기사 제목](https://readable.example.test/article/real)
[목록 날짜 기사](https://readable.example.test/article/dated)[2026.5.18.]
[원산갈마해안관광지구 준공식 성대히 진행 [2025.06.26.]](https://readable.example.test/article/nested-date)
[문헌 PDF](https://readable.example.test/books/real.pdf)
`;
  const readableArticle = `
Title: 실제 기사 제목
URL Source: https://readable.example.test/article/real
Published Time: Tue, 19 May 2026 04:00:00 GMT
Markdown Content:
# 실제 기사 제목
이것은 차단되거나 시간초과되는 원본 사이트를 읽기 가능한 실자료 스냅샷으로 수집한 본문입니다.
`;

  const entries = await discoverSourceEntries(source, {
    maxLinks: 10,
    fetchHtmlImpl: async () => readableHome,
  });
  const urls = entries.map((entry) => entry.url);
  const datedEntry = entries.find((entry) => entry.url.endsWith("/article/dated"));
  const nestedDateEntry = entries.find((entry) => entry.url.endsWith("/article/nested-date"));
  const article = extractDocumentFromReadableText(readableArticle, "https://readable.example.test/article/real", source);
  const pdf = extractPdfDocumentFromLink(entries.find((entry) => entry.url.endsWith("/books/real.pdf")), source);
  const readableListing = `
Title: Newstream | KCNA Watch
URL Source: https://readable.example.test/article/focused
Markdown Content:
#### [집중 기사 제목](https://readable.example.test/article/focused)
이 문장만 해당 기사 카드의 실자료 요약입니다.
May 19, 2026

#### [다른 기사 제목](https://readable.example.test/article/other)
이 문장은 다른 기사 카드라서 본문에 들어가면 안됩니다.
`;
  const [focusedEntry] = discoverLinkEntries(readableListing, source.baseUrl, source)
    .filter((entry) => entry.url.endsWith("/article/focused"));
  const focusedArticle = extractDocumentFromReadableText(readableListing, focusedEntry.url, source, focusedEntry);
  const readableArticleWithChrome = `
Title: 크롬 없는 기사 제목
URL Source: https://readable.example.test/article/chrome
Markdown Content:
# 크롬 없는 기사 제목 | Fixture
메뉴
첫페지
# 크롬 없는 기사 제목
2026년 05월 19일
본문 첫문장입니다. 본문 둘째문장입니다.
## 많이 본 기사
다른 기사 제목
`;
  const chromeFreeArticle = extractDocumentFromReadableText(readableArticleWithChrome, "https://readable.example.test/article/chrome", source);
  const readableArticleWithEmptyBreadcrumb = `
Title: 경애하는 김정은 동지 께서 전군의 사, 려단 지휘관회합을 소집하시고 그들을 만나시였다(2026.5.18)
URL Source: https://readable.example.test/article/vok
Markdown Content:
# 경애하는 김정은 동지 께서 전군의 사, 려단 지휘관회합을 소집하시고 그들을 만나시였다(2026.5.18)
[](https://readable.example.test/) / 혁명활동소식
조선로동당 총비서이시며 조선민주주의인민공화국 국무위원장이신 경애하는 김정은 동지께서 5월 17일 전군의 사, 려단 지휘관들의 회합을 소집하시고 그들을 만나시였다.
`;
  const breadcrumbFreeArticle = extractDocumentFromReadableText(readableArticleWithEmptyBreadcrumb, "https://readable.example.test/article/vok", source);
  const kcnaReadableArticle = `
Title: 조선중앙통신 | 기사 | 경애하는 김정은동지께서 전군의 사,려단 지휘관회합을 소집하시고 그들을 만나시였다
URL Source: http://www.kcna.kp/kp/article/q/fixture.kcmsf
Published Time: Fri, 15 May 2026 04:00:00 GMT
Markdown Content:
**경애하는 김정은 동지 께서 전군의 사,려단 지휘관회합을 소집하시고 그들을 만나시였다**

(평양 5월 18일발 조선중앙통신)

조선로동당 총비서 이시며 조선민주주의인민공화국 국무위원장 이신 경애하는 김정은 동지 께서 5월 17일 전군의 사,려단 지휘관들의 회합을 소집하시고 그들을 만나시였다.

www.kcna.kp (2026.05.18.)
`;
  const kcnaArticle = extractDocumentFromReadableText(
    kcnaReadableArticle,
    "http://www.kcna.kp/kp/article/q/fixture.kcmsf",
    { ...source, id: "kcna", name: "조선중앙통신", baseUrl: "http://www.kcna.kp/" },
    { date: "2026-05-15" },
  );

  assert.equal(urls.includes("https://readable.example.test/article/real"), true, "readable snapshots should expose Markdown article links for indexing");
  assert.equal(urls.includes("https://readable.example.test/article/nested-date"), true, "readable snapshots should expose Markdown links whose titles contain bracketed dates");
  assert.equal(datedEntry?.date, "2026.5.18", "readable Markdown links should use dates adjacent to the link before scanning neighboring cards");
  assert.equal(nestedDateEntry?.date, "2025.06.26", "readable Markdown links should parse dates inside bracketed source titles");
  assert.equal(article.title, "실제 기사 제목", "readable article title should become a document title");
  assert.equal(article.date, "2026-05-19", "readable Published Time should normalize");
  assert.equal(article.body.includes("실자료 스냅샷"), true, "readable Markdown content should become document body");
  assert.equal(pdf.mediaType, "pdf", "readable Markdown PDF links should become 문헌 documents");
  assert.equal(focusedArticle.body.includes("실자료 요약"), true, "readable listing entries should keep their card text");
  assert.equal(focusedArticle.body.includes("다른 기사 카드"), false, "readable listing entries must not index neighboring cards");
  assert.equal(chromeFreeArticle.body.includes("본문 첫문장"), true, "readable article extraction should keep the real article body");
  assert.equal(chromeFreeArticle.body.includes("많이 본 기사"), false, "readable article extraction should drop related-list page chrome");
  assert.equal(breadcrumbFreeArticle.title.endsWith("(2026.5.18)"), false, "readable article titles should not keep trailing date chrome");
  assert.equal(breadcrumbFreeArticle.snippet.includes("조선로동당 총비서"), true, "readable article snippets should prefer real article text over breadcrumbs");
  assert.equal(breadcrumbFreeArticle.body.includes("혁명활동소식"), false, "readable article bodies should drop empty-link breadcrumb categories");
  assert.equal(breadcrumbFreeArticle.body.includes("[]("), false, "readable article bodies should drop empty Markdown links");
  assert.equal(kcnaArticle.date, "2026-05-18", "KCNA readable article datelines should beat stale metadata dates");
}

async function assertReadableMediaAssetsBecomeDocuments() {
  const source = {
    id: "ryugyong",
    name: "류경",
    sourceType: "official_site",
    baseUrl: "http://www.mediaryugyong.com.kp/",
    languages: ["ko"],
    mediaTypes: ["article", "image", "video"],
    aliases: ["Ryugyong"],
  };
  const readableHome = `
Title: 류경
URL Source: http://www.mediaryugyong.com.kp/
Markdown Content:
![Image 1: RGMark](http://www.mediaryugyong.com.kp/static/mark.png)
![Image 2: 화성지구 3단계 1만세대 살림집](http://www.mediaryugyong.com.kp/contents/photo/normal/ko/2025/08/14/20250814_104958_huasong105003_thumb.jpg)
![Image 3: 화보《조선》 2026년 5월호](http://www.mediaryugyong.com.kp/contents/video/ko/2026/05/13/20260513_181923_000182001_thumb.jpg)
`;
  const entries = discoverLinkEntries(readableHome, source.baseUrl, source);
  const documents = entries.map((entry) => extractMediaDocumentFromLink(entry, source)).filter(Boolean);

  assert.equal(documents.some((document) => document.title === "화성지구 3단계 1만세대 살림집" && document.mediaType === "image"), true, "류경 photo assets should become image documents");
  assert.equal(documents.some((document) => document.title === "화보《조선》 2026년 5월호" && document.mediaType === "video"), true, "류경 video thumbnails should become video documents");
  assert.deepEqual(
    documents.find((document) => document.title === "화보《조선》 2026년 5월호")?.searchTabs,
    ["all", "video"],
    "video media extracted from mixed official pages should be visible in 전체 and 동영상",
  );
  assert.equal(documents.some((document) => /RGMark/i.test(document.title)), false, "류경 static logos must not become search documents");

  const minjuSource = {
    id: "minju-choson",
    name: "민주조선",
    sourceType: "official_site",
    baseUrl: "http://www.minju.rep.kp/",
    languages: ["ko"],
    mediaTypes: ["article", "image"],
    aliases: ["Minju Choson"],
  };
  const minjuReadablePhotos = `
Title: 조선민주주의인민공화국 최고인민회의 상임위원회 및 내각기관지
URL Source: http://www.minju.rep.kp/home/index/photos/0/ko
Markdown Content:
[![Image 9: image](http://www.minju.rep.kp/resource/mark111.png)](http://www.minju.rep.kp/home/index/first/0/ko)
[![Image 17: image](http://www.minju.rep.kp/uploads/photo/2025/10/2025-10-09-043.jpg)](http://www.minju.rep.kp/uploads/photo/2025/10/2025-10-09-043.jpg "《원산갈마료리축전-2025》진행(1/7)")

 《원산갈마료리축전-2025》진행 [2025.10.9.]

[](http://www.minju.rep.kp/uploads/photo/2025/10/2025-10-09-044.jpg "《원산갈마료리축전-2025》진행(2/7)")
`;
  const minjuEntries = discoverLinkEntries(minjuReadablePhotos, minjuSource.baseUrl, minjuSource);
  const minjuDocuments = minjuEntries.map((entry) => extractMediaDocumentFromLink(entry, minjuSource)).filter(Boolean);

  assert.equal(minjuDocuments.some((document) => document.title === "《원산갈마료리축전 2025》진행" && document.date === "2025-10-09"), true, "민주조선 photo rows should use the visible caption and date instead of generic image alt text");
  assert.equal(minjuDocuments.some((document) => document.title === "《원산갈마료리축전 2025》진행(2/7)"), true, "민주조선 empty Markdown photo links should use their source title attribute");
  assert.deepEqual(
    minjuDocuments.find((document) => document.title === "《원산갈마료리축전 2025》진행")?.searchTabs,
    ["all", "image"],
    "민주조선 photo documents should be visible in 전체 and 이미지",
  );
  assert.equal(minjuDocuments.some((document) => document.aliases.includes("Wonsan Kalma")), true, "민주조선 원산갈마 photo documents should stay reachable through English Wonsan/Kalma aliases");
  assert.equal(minjuDocuments.some((document) => /mark111/i.test(document.url)), false, "민주조선 resource marks must not become search documents");
}

async function assertRodongReadableListingsBecomeDocuments() {
  const source = {
    id: "rodong-sinmun",
    name: "로동신문",
    sourceType: "official_site",
    baseUrl: "http://www.rodong.rep.kp/",
    languages: ["ko"],
    mediaTypes: ["article", "image"],
    aliases: ["Rodong Sinmun"],
    crawler: {
      entryUrl: "http://www.rodong.rep.kp/",
      indexEntryUrl: false,
      includeUrlPatterns: ["index.php?MT"],
    },
  };
  const readableListing = `
Title: 로동신문
URL Source: http://www.rodong.rep.kp/index.php?MUBAMUAxQA==
Markdown Content:
# 로동신문
[혁명활동소식](http://www.rodong.rep.kp/index.php?MUBAMUAxQA==)
[경애하는 **김정은**동지께서 전군의 사,려단 지휘관회합을 소집하시고 그들을 만나시였다](http://www.rodong.rep.kp/index.php?MTJAMjAyNi0wNS0xOC0wMTNAMUAxQEAwQDFA==)
*   [경애하는 **김정은**동지께서 전군의 사,려단 지휘관회합을 소집하시고 그들을 만나시였다](http://www.rodong.rep.kp/index.php?MTJAMjAyNi0wNS0xOC0wMTNAMUAxQEAwQDFA==) 2026.5.18.
*   [경애하는 **김정은**동지께서 여러 군수공업기업소들을 현지지도하시였다](http://www.rodong.rep.kp/index.php?MTJAMjAyNi0wNS0xMy0wMTZAMUAxQEAwQDNA==) 2026.5.13.
[＞＞＞](http://www.rodong.rep.kp/index.php?MUBAMkAxQA==)
`;
  const entries = discoverEmbeddedDocumentEntries(readableListing, "http://www.rodong.rep.kp/index.php?MUBAMUAxQA==", source);
  const documents = entries.map((entry) => entry.fallbackDocument).filter(Boolean);

  assert.equal(documents.length, 2, "로동신문 readable listing pages should keep lightweight real article records as detail-fetch fallbacks");
  assert.equal(entries.every((entry) => !entry.embeddedDocument && entry.fallbackDocument && entry.readableSource), true, "로동신문 listing records should not preempt richer readable detail fetches");
  assert.equal(documents[0].title.includes("김정은 동지께서 전군"), true, "로동신문 listing document title should keep the real article title");
  assert.equal(documents[0].date, "2026-05-18", "로동신문 listing document should preserve nearby date text");
  assert.equal(documents[0].body.includes("오늘호 기사"), false, "로동신문 listing documents must not index whole-page navigation chrome");
  assert.equal(documents.some((document) => document.title === "혁명활동소식" || document.title === "＞＞＞"), false, "로동신문 category and more links must not become documents");

  const readableDetail = `
Title: 로동신문
URL Source: http://www.rodong.rep.kp/index.php?MTJAMjAyNi0wNS0xOC0wMTNAMUAxQEAwQDFA==
Markdown Content:
경애하는 **김정은**동지께서 전군의 사,려단 지휘관회합을 소집하시고 그들을 만나시였다

전군의 지휘관들을 만나시고 부대들의 전투력강화에서 나서는 귀중한 가르치심을 주시였다.

회의에서는 새시대 군건설방향과 훈련혁명에 관한 실천적문제들이 토의되였다.

Copyright @ 2026 by The Rodong Sinmun.

All rights reserved.
`;
  const crawl = await crawlSources([{
    ...source,
    crawler: {
      ...source.crawler,
      preferReadable: true,
      indexListingFallbacks: true,
      maxDetailFetchesPerSource: 2,
    },
  }], {
    limitPerSource: 2,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    concurrency: 1,
    fetchHtmlImpl: async (url) => (url === source.crawler.entryUrl || url.includes("MUBA") ? readableListing : readableDetail),
  });
  const fetchedDocument = crawl.documents.find((document) => document.url.includes("MTJAMjAyNi0wNS0xOC"));
  assert.equal(fetchedDocument?.body.includes("훈련혁명"), true, "로동신문 listing fallback should yield to richer readable detail bodies when detail fetch succeeds");
  assert.equal(fetchedDocument?.body.includes("Copyright @ 2026 by The Rodong Sinmun"), false, "로동신문 readable detail bodies should strip footer chrome without discarding the article text");
  assert.equal((fetchedDocument?.body || "").length > (documents[0]?.body || "").length, true, "로동신문 fetched detail should be richer than the listing fallback");
}

async function assertNaenaraReadableTablesBecomeDocuments() {
  const source = {
    id: "naenara",
    name: "내나라",
    sourceType: "official_site",
    baseUrl: "http://www.naenara.com.kp/",
    languages: ["ko"],
    mediaTypes: ["article", "image", "pdf"],
    aliases: ["Naenara"],
  };
  const readableNews = `
Title: 내나라 - 소식, 기사
URL Source: http://www.naenara.com.kp/main/index/ko/news
Markdown Content:
*   [전체보기(1334)](javascript:View_Content(5);)
|  | 번호 | 기사제목 |
| --- | --- | --- |
|  | 1 | 우리 녀자축구선수들 2026년 아시아축구련맹 17살미만 녀자아시아컵경기대회에서 1위 쟁취[ 2026-05-18 ] |
|  | 2 | 로씨야외무성 대변인 일본의 주장을 일축[ 2026-05-18 ] |
`;
  const readableHome = `
Title: 내나라 - 조선민주주의인민공화국
URL Source: http://www.naenara.com.kp/main/index/ko/first
Markdown Content:
##### **경애하는****김정은****동지의 혁명활동소식**
![Image 10: naenara-image](http://www.naenara.com.kp/images/periodic/news_daily/2026/05/18/aaa26051801.jpg)
조선로동당 총비서이시며 조선민주주의인민공화국 국무위원장이신 경애하는 김정은 동지께서 5월 17일 전군의 지휘관들을 만나시였다.
지휘관들은 최고사령관동지를 만나뵈옵는 영광의 시각을 맞이하게 된 격정으로 설레이였다.
경애하는 김정은 동지께서 전군의 사, 려단 지휘관회합을 소집하시고 그들을 만나시였다 [2026-05-18]

##### **소식, 기사**
*   건설의 대번영기를 펼치시여 [2026-05-18]
`;
  const readableEnglishNews = `
Title: Naenara Democratic People's Republic of Korea
URL Source: http://www.naenara.com.kp/main/index/en/news
Markdown Content:
Respected Comrade Kim Jong Un Convenes Meeting of Commanding Officers of Divisions and Brigades of Entire Army and Meets Them[ 2026-05-18 ]
Inauguration Ceremony of Memorial Museum of Combat Feats at Overseas Military Operations Solemnly Held[ 2026-04-27 ]
`;
  const readableTourism = `
Title: 내나라 - 조선민주주의인민공화국
URL Source: http://www.naenara.com.kp/main/index/ko/tourism
Markdown Content:
관광소식

|  | 번호 | 기사제목 | 날자 |
| --- | --- | --- | --- |
|  | 1 | 고산지대의 체육문화휴식기지[2026-05-15] |  |
|  | 2 | 적극화되고있는 관광업[2026-05-14] |  |
`;
  const readableEnglishTourism = `
Title: Naenara Democratic People's Republic of Korea
URL Source: http://www.naenara.com.kp/main/index/en/tourism
Markdown Content:
News

|  | Number | Article | Date |
| --- | --- | --- | --- |
|  | 1 | Impressive Mountainous Tourist Resort[2026-05-04] |  |
`;
  const newsEntries = discoverEmbeddedDocumentEntries(readableNews, "http://www.naenara.com.kp/main/index/ko/news", source);
  const homeEntries = discoverEmbeddedDocumentEntries(readableHome, "http://www.naenara.com.kp/main/index/ko/first", source);
  const englishNewsEntries = discoverEmbeddedDocumentEntries(readableEnglishNews, "http://www.naenara.com.kp/main/index/en/news", source);
  const tourismEntries = discoverEmbeddedDocumentEntries(readableTourism, "http://www.naenara.com.kp/main/index/ko/tourism", source);
  const englishTourismEntries = discoverEmbeddedDocumentEntries(readableEnglishTourism, "http://www.naenara.com.kp/main/index/en/tourism", source);
  const documents = [...newsEntries, ...homeEntries, ...englishNewsEntries, ...tourismEntries, ...englishTourismEntries].map((entry) => entry.embeddedDocument).filter(Boolean);

  assert.equal(documents.some((document) => document.title.includes("녀자축구선수들") && document.sourceId === "naenara"), true, "내나라 readable news table rows should become indexed source documents");
  assert.equal(documents.some((document) => document.title.includes("Respected Comrade Kim Jong Un") && document.url.includes("/main/index/en/news#")), true, "내나라 English readable news rows should become indexed source documents");
  assert.equal(documents.some((document) => document.title === "적극화되고있는 관광업" && document.snippet.includes("관광소식")), true, "내나라 Korean tourism table rows should become searchable 관광소식 documents");
  assert.equal(documents.some((document) => document.title === "Impressive Mountainous Tourist Resort" && document.snippet.includes("Tourism News")), true, "내나라 English tourism table rows should become searchable tourism documents");
  assert.equal(documents.some((document) => document.title.includes("전군의 사") && document.thumbnailUrl.includes("aaa26051801.jpg")), true, "내나라 homepage feature should keep its real image");
  assert.equal(documents.some((document) => document.title.includes("전군의 사") && document.body.includes("전군의 지휘관들을 만나시였다")), true, "내나라 homepage feature should keep readable article paragraphs, not only title/date rows");
  assert.equal(documents.some((document) => /전체보기|기사제목/.test(document.title)), false, "내나라 navigation/table chrome must not become documents");
}

async function assertFetchCacheFallsBackToRealStoredResponses() {
  const tempDir = await fs.mkdtemp(path.join(ROOT_DIR, "tmp-search-cache-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const realSnapshot = `
Title: Cached Real Source
URL Source: https://cache.example.test/real
Markdown Content:
# Cached Real Source
This is a previously fetched real response, reused only when the live request fails.
`;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        headers: { get: () => "text/plain; charset=utf-8" },
        arrayBuffer: async () => new TextEncoder().encode(realSnapshot),
      };
    }
    throw new Error("fetch failed");
  };

  try {
    const first = await fetchTextResource("https://cache.example.test/real", {
      cacheDir: tempDir,
      cacheNamespace: "test",
      useFetchCache: true,
      retries: 0,
    });
    const second = await fetchTextResource("https://cache.example.test/real", {
      cacheDir: tempDir,
      cacheNamespace: "test",
      useFetchCache: true,
      retries: 0,
    });

    assert.equal(first, realSnapshot, "successful real fetch should be returned");
    assert.equal(second, realSnapshot, "failed live fetch should fall back to the stored real response");
    assert.equal(calls, 2, "cache fallback should still try live data before using the stale response");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function assertCrawlerFetchHonorsHttpProxyEnv() {
  const envSnapshot = snapshotProxyEnv();
  const originalFetch = globalThis.fetch;
  const fetches = [];

  clearProxyEnv();
  process.env.HTTPS_PROXY = "http://proxy.example.test:3128";
  globalThis.fetch = async (url, options = {}) => {
    fetches.push({
      url: String(url),
      hasDispatcher: Boolean(options.dispatcher),
    });
    return {
      ok: true,
      headers: { get: () => "text/plain; charset=utf-8" },
      arrayBuffer: async () => new TextEncoder().encode("real source response"),
    };
  };

  try {
    const direct = await fetchTextResource("https://www.rodong.rep.kp/ko/index.php", { retries: 0 });
    assert.equal(direct, "real source response", "crawler should return the proxied source response");
    assert.equal(fetches[0]?.hasDispatcher, true, "crawler should honor HTTPS_PROXY for direct DPRK source fetches");

    fetches.length = 0;
    await fetchTextResource("https://r.jina.ai/http://www.rodong.rep.kp/ko/index.php", { retries: 0 });
    assert.equal(fetches[0]?.hasDispatcher, false, "readable fallback mirror requests should bypass the DPRK source proxy");

    fetches.length = 0;
    globalThis.fetch = async (url, options = {}) => {
      fetches.push({
        url: String(url),
        hasDispatcher: Boolean(options.dispatcher),
      });
      if (options.dispatcher) throw new Error("network timeout");
      return {
        ok: true,
        headers: { get: () => "text/plain; charset=utf-8" },
        arrayBuffer: async () => new TextEncoder().encode("direct fallback response"),
      };
    };
    const fallback = await fetchTextResource("https://www.kcna.kp/kp", { retries: 0 });
    assert.equal(fallback, "direct fallback response", "crawler should retry direct when a configured proxy route times out before reaching the source");
    assert.deepEqual(fetches.map((fetch) => fetch.hasDispatcher), [true, false], "proxy direct fallback should first try the proxy and then retry without a dispatcher");

    fetches.length = 0;
    globalThis.fetch = async (url, options = {}) => {
      fetches.push({
        url: String(url),
        hasDispatcher: Boolean(options.dispatcher),
      });
      if (options.dispatcher) throw new Error("HTTP 500");
      return {
        ok: true,
        headers: { get: () => "text/plain; charset=utf-8" },
        arrayBuffer: async () => new TextEncoder().encode("should not be used"),
      };
    };
    await assert.rejects(
      () => fetchTextResource("https://www.kcna.kp/kp", { retries: 0 }),
      /HTTP 500/,
      "crawler should not bypass real HTTP upstream responses through direct proxy fallback",
    );
    assert.deepEqual(fetches.map((fetch) => fetch.hasDispatcher), [true], "HTTP status errors should not trigger a direct retry around the configured proxy");
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(envSnapshot);
  }
}

async function assertFeedItemsBecomeDocuments() {
  const source = {
    id: "kcna-watch",
    name: "KCNA Watch",
    sourceType: "archive",
    baseUrl: "https://kcnawatch.org/",
    languages: ["en"],
    mediaTypes: ["article", "pdf", "image", "video"],
    aliases: ["Korean Central News Agency"],
  };
  const feed = `
    <rss><channel>
      <item>
        <title>Fixture KCNA Watch Article</title>
        <link>https://kcnawatch.org/newstream/fixture-kcna-watch-article/</link>
        <description><![CDATA[Real feed summary from the archive source.]]></description>
        <pubDate>Tue, 19 May 2026 04:00:00 GMT</pubDate>
      </item>
    </channel></rss>
  `;
  const [entry] = discoverFeedEntries(feed, "https://kcnawatch.org/feed/", source);
  const document = extractFeedDocumentFromEntry(entry, source);

  assert.equal(document.title, "Fixture KCNA Watch Article", "feed item title should become document title");
  assert.equal(document.snippet, "Real feed summary from the archive source.", "feed summary should become document snippet");
  assert.equal(document.date, "2026-05-19", "feed pubDate should normalize");
  assert.equal(document.sourceName, "KCNA Watch", "feed document should retain source name");
}

async function assertSitemapEntriesBecomeCrawlerFrontier() {
  const source = {
    id: "fixture-archive",
    name: "Fixture Archive",
    sourceType: "archive",
    baseUrl: "https://archive.example.test/",
    languages: ["ko"],
    mediaTypes: ["article", "image"],
    crawler: {
      entryUrl: "https://archive.example.test/",
      indexEntryUrl: false,
      includeUrlPatterns: ["/newstream/"],
      sitemapUrls: ["https://archive.example.test/sitemap_index.xml"],
      maxSitemaps: 4,
      robotsPolicy: "ignore",
    },
  };
  const sitemapIndex = `
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://archive.example.test/post-sitemap.xml</loc></sitemap>
    </sitemapindex>
  `;
  const urlset = `
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <url>
        <loc>https://archive.example.test/newstream/sitemap-article/</loc>
        <lastmod>2026-05-19T00:00:00+00:00</lastmod>
        <image:image>
          <image:loc>https://archive.example.test/wp-content/uploads/sitemap.jpg</image:loc>
          <image:title>원산갈마해안관광지구</image:title>
          <image:caption>원산갈마해안관광지구 사진이 포함된 기사</image:caption>
        </image:image>
      </url>
      <url>
        <loc>https://archive.example.test/category/non-article/</loc>
      </url>
    </urlset>
  `;
  const parsed = discoverSitemapEntries(urlset, "https://archive.example.test/post-sitemap.xml", source);
  const report = { errors: [] };
  const entries = await discoverSourceEntries(source, {
    report,
    maxLinks: 10,
    maxDiscoveryPages: 1,
    fetchHtmlImpl: async () => "<main></main>",
    fetchTextResourceImpl: async (url) => {
      if (url.endsWith("sitemap_index.xml")) return sitemapIndex;
      if (url.endsWith("post-sitemap.xml")) return urlset;
      throw new Error(`unexpected fixture URL ${url}`);
    },
  });
  const urls = entries.map((entry) => entry.url);
  const sitemapEntry = entries.find((entry) => entry.url === "https://archive.example.test/newstream/sitemap-article/");

  assert.equal(parsed.entries[0]?.linkText, "원산갈마해안관광지구", "sitemap image titles should become usable result titles");
  assert.equal(parsed.entries[0]?.thumbnailUrl, "https://archive.example.test/wp-content/uploads/sitemap.jpg", "sitemap image loc should become a thumbnail candidate");
  assert.equal(report.sitemapFetched, 2, "crawler should report sitemap index and urlset fetches");
  assert.equal(urls.includes("https://archive.example.test/newstream/sitemap-article/"), true, "sitemap discovery should add matching article URLs to the crawl frontier");
  assert.equal(urls.includes("https://archive.example.test/category/non-article/"), false, "sitemap discovery must still respect include/exclude URL rules");
  assert.equal(sitemapEntry?.date, "2026-05-19", "sitemap lastmod should become a normalized discovery date");
  assert.equal(sitemapEntry?.contextText, "원산갈마해안관광지구 사진이 포함된 기사", "sitemap captions should be preserved as discovery context");
}

async function assertSourceSearchDiscoveryUsesRealSiteSearches() {
  const source = {
    id: "kcna-watch",
    name: "KCNA Watch",
    sourceType: "archive",
    baseUrl: "https://kcnawatch.org/",
    languages: ["ko", "en"],
    mediaTypes: ["article"],
    crawler: {
      entryUrl: "https://kcnawatch.org/",
      includeUrlPatterns: ["/newstream/"],
      searchUrlTemplates: ["https://kcnawatch.org/?s={query}"],
      searchPreferReadable: true,
      indexSearchResults: true,
      searchQueries: ["원산갈마", "Wonsan Kalma"],
      robotsPolicy: "ignore",
    },
  };
  const searchPage = `
    <main>
      <article>
        <a href="/newstream/fixture-wonsan-kalma/"><img src="https://assets.korearisk.com/uploads/sites/5/2015/11/rodong-korean.png" alt="">Wonsan Kalma search result</a>
        <p>Search result excerpt from KCNA Watch. September 29, 2025</p>
      </article>
      <a href="/category/archive/">category archive</a>
    </main>
  `;
  const report = { errors: [] };
  const requestedUrls = [];
  const entries = await discoverSourceEntries(source, {
    report,
    maxLinks: 10,
    maxDiscoveryPages: 1,
    fetchHtmlImpl: async (url) => {
      requestedUrls.push(url);
      return url.includes("?s=") ? searchPage : "<main></main>";
    },
  });
  const configuredUrls = createConfiguredSearchUrls(source);
  const rodongSource = SEARCH_SOURCES.find((candidate) => candidate.id === "rodong-sinmun");
  const rodongConfiguredUrls = createConfiguredSearchUrls(rodongSource);
  const rodongSearchToken = Buffer.from("19@@19@@원산갈마@1").toString("base64");
  const sourcesWithSearchDiscovery = SEARCH_SOURCES
    .filter((candidate) => Array.isArray(candidate.crawler?.searchUrlTemplates) && candidate.crawler.searchUrlTemplates.length > 0)
    .map((candidate) => candidate.id);
  const searchEntry = entries.find((entry) => entry.url === "https://kcnawatch.org/newstream/fixture-wonsan-kalma/");
  const searchDocument = extractSourceSearchDocumentFromEntry(searchEntry, source);

  assert.deepEqual(sourcesWithSearchDiscovery, ["rodong-sinmun", "kcna-watch"], "source search discovery should be limited to real site-search frontiers that improve official/archive coverage");
  assert.equal(configuredUrls.includes("https://kcnawatch.org/?s=%EC%9B%90%EC%82%B0%EA%B0%88%EB%A7%88"), true, "KCNA Watch search URLs should encode Korean queries");
  assert.equal(configuredUrls.includes("https://kcnawatch.org/?s=Wonsan%20Kalma"), true, "KCNA Watch search URLs should encode English alias queries");
  assert.equal(rodongConfiguredUrls.includes(`http://www.rodong.rep.kp/ko/index.php?${encodeURIComponent(rodongSearchToken)}`), true, "로동신문 search URLs should encode its own base64 search-token format");
  assert.equal(rodongSource?.crawler?.searchPreferReadable, true, "로동신문 search discovery should prefer readable search snapshots because direct HTML fetches are slow through DPRK routes");
  assert.equal(rodongSource?.crawler?.fetchSearchResultPages, true, "로동신문 search-result entries should fetch available detail pages before falling back to result cards");
  assert.equal((rodongSource?.crawler?.maxDetailFetchesPerSource || 0) >= 120, true, "로동신문 production crawl should fetch enough search-result detail pages to avoid a shallow title-only index");
  assert.equal(rodongSource?.crawler?.includeUrlPatterns.some((pattern) => pattern instanceof RegExp && pattern.test("http://www.rodong.rep.kp/ko/index.php?OEAyMDI1LTA2LTI2LTAxN0AxOUBA7JuQ7IKw6rCI66eIQDExMDg==")), true, "로동신문 search-result detail URLs should be indexable crawl targets");
  assert.equal((SEARCH_SOURCES.find((candidate) => candidate.id === "kcna")?.crawler?.maxDetailFetchesPerSource || 0) >= 120, true, "조선중앙통신 production crawl should fetch enough article detail pages for substantive snippets");
  assert.equal(SEARCH_SOURCES.find((candidate) => candidate.id === "kcna-watch")?.crawler?.searchPreferReadable, true, "KCNA Watch search discovery should be able to prefer readable search snapshots when direct fetches are slow");
  assert.equal(SEARCH_SOURCES.find((candidate) => candidate.id === "kcna-watch")?.crawler?.indexSearchResults, true, "KCNA Watch should use its own search results as a crawl frontier");
  assert.equal(SEARCH_SOURCES.find((candidate) => candidate.id === "kcna-watch")?.crawler?.fetchSearchResultPages, true, "KCNA Watch search results should fetch detail pages for full cached previews");
  assert.equal(report.searchFetched, 2, "crawler should report every configured KCNA Watch search result page fetch");
  assert.equal(requestedUrls.some((url) => url.includes("?s=%EC%9B%90%EC%82%B0")), true, "KCNA Watch discovery should request its search endpoint");
  assert.equal(
    Boolean(searchEntry),
    true,
    "KCNA Watch search results should become crawl frontier entries",
  );
  assert.equal(searchEntry?.fromSourceSearch, true, "KCNA Watch search-result entries should be marked for search-result indexing");
  assert.equal(searchDocument?.title, "Wonsan Kalma search result", "KCNA Watch search-result entries should become indexed documents");
  assert.equal(searchDocument?.date, "2025-09-29", "KCNA Watch search-result fallback documents should preserve readable result dates");
  assert.equal(searchDocument?.sourceName, "KCNA Watch", "KCNA Watch search-result documents should retain source provenance");
  assert.equal(searchDocument?.displaySourceId, "rodong-sinmun", "KCNA Watch search-result documents should expose source-logo provenance for grouping");
  assert.equal(searchDocument?.displaySourceName, "로동신문", "KCNA Watch source-logo provenance should use the configured Korean source name");
  const fallbackCrawl = await crawlSources([{
    ...source,
    crawler: {
      ...source.crawler,
      fetchSearchResultPages: true,
    },
  }], {
    limitPerSource: 4,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => {
      if (url.includes("?s=")) return searchPage;
      throw new Error("HTTP 429");
    },
  });

  assert.equal(
    fallbackCrawl.documents.some((document) => document.title === "Wonsan Kalma search result"),
    true,
    "KCNA Watch search-result entries should still be indexed when detail fetches are rate-limited",
  );
  assert.equal(
    fallbackCrawl.crawlReports[0]?.searchResultFallbacks,
    1,
    "KCNA Watch importer should report search-result fallback indexing",
  );
  assert.equal(
    (fallbackCrawl.crawlReports[0]?.errors || []).some((error) => error.includes("/newstream/")),
    false,
    "KCNA Watch detail fetch failures should not become source health errors when search-result fallback indexing succeeds",
  );
  const unrelatedListingDetail = `
Title: Newstream | KCNA Watch
URL Source: https://kcnawatch.org/newstream/fixture-wonsan-kalma/
Markdown Content:
[![Image 1: KCNA Watch Logo](https://assets.example/logo.png)](https://kcnawatch.org/newstream/other/)
#### [Unrelated current listing item](https://kcnawatch.org/newstream/other/)
Browse
This unrelated listing text is long enough to look substantial but must not replace the search-result excerpt.
May 20, 2026
`;
  const listingCrawl = await crawlSources([{
    ...source,
    crawler: {
      ...source.crawler,
      fetchSearchResultPages: true,
    },
  }], {
    limitPerSource: 1,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => (url.includes("?s=") ? searchPage : unrelatedListingDetail),
  });
  assert.equal(
    listingCrawl.documents[0]?.body.includes("Search result excerpt from KCNA Watch"),
    true,
    "KCNA Watch listing-like detail responses should fall back to the source-search card text",
  );
  assert.equal(
    /Unrelated current listing item|Browse|KCNA Watch Logo/.test(listingCrawl.documents[0]?.body || ""),
    false,
    "KCNA Watch listing-like detail responses should not index unrelated listing chrome",
  );
  const originalSourceDetail = `
Title: Newstream | KCNA Watch
URL Source: https://kcnawatch.org/newstream/fixture-wonsan-kalma/
Markdown Content:
## Wonsan Kalma source fixture

Date: 26/06/2025 | Source: Voice of Korea (EN) | [Read original version at source](http://www.vok.rep.kp/index.php/revo_de/getDetail/ien250625008/en)

The Wonsan Kalma Coastal Tourist Area fixture body is deliberately long enough to be treated as article text rather than listing chrome. It preserves the archive copy while exposing the original Voice of Korea URL for the source pill.
`;
  const originalSourceCrawl = await crawlSources([{
    ...source,
    crawler: {
      ...source.crawler,
      fetchSearchResultPages: true,
    },
  }], {
    limitPerSource: 1,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => (url.includes("?s=") ? searchPage : originalSourceDetail),
  });
  assert.equal(
    originalSourceCrawl.documents[0]?.originalSourceUrl,
    "http://www.vok.rep.kp/index.php/revo_de/getDetail/ien250625008/en",
    "KCNA Watch readable details should preserve the source-visible original URL separately from the archive URL",
  );
  assert.equal(
    entries.some((entry) => entry.url === "https://kcnawatch.org/category/archive/"),
    false,
    "KCNA Watch search discovery should still reject category/archive chrome links",
  );

  const rodongSearchPage = `
Title: 로동신문
URL Source: http://www.rodong.rep.kp/ko/index.php?${rodongSearchToken}
Markdown Content:
*   검색결과 : 109건
*   [사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행 2025.6.26.](http://www.rodong.rep.kp/ko/index.php?OEAyMDI1LTA2LTI2LTAxN0AxOUBA7JuQ7IKw6rCI66eIQDExMDg==)
*   [로동신문 검색 페지](http://www.rodong.rep.kp/ko/index.php?MTlAQDE5QEDsm5DsgrDqsIjrp4hAMQ==)
`;
  const rodongFixtureSource = {
    ...rodongSource,
    crawler: { ...rodongSource.crawler, detailSeedUrls: [], robotsPolicy: "ignore" },
  };
  const rodongEntries = await discoverSourceEntries(rodongFixtureSource, {
    report: { errors: [] },
    maxLinks: 5,
    maxDiscoveryPages: 1,
    fetchHtmlImpl: async (url) => (url.includes("/ko/index.php?") ? rodongSearchPage : "<main></main>"),
  });
  const rodongSearchEntry = rodongEntries.find((entry) => /OEAyMDI1LTA2LTI2/.test(entry.url));
  const rodongSearchDocument = extractSourceSearchDocumentFromEntry(rodongSearchEntry, rodongFixtureSource);

  assert.equal(rodongSearchEntry?.fromSourceSearch, true, "로동신문 site-search result links should become marked crawl frontier entries");
  assert.equal(rodongSearchDocument?.title, "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행", "로동신문 search-result fallback titles should drop the trailing result date");
  assert.equal(rodongSearchDocument?.date, "2025-06-26", "로동신문 search-result fallback documents should preserve the result date");
  assert.equal(
    rodongEntries.some((entry) => /MTlAQDE5/.test(entry.url)),
    false,
    "로동신문 search discovery should reject search-result chrome URLs as indexable documents",
  );
}

async function assertKcnaWatchSearchFallbacksAreCleaned(productionDocumentsText) {
  const noisyContext = "김정은위원장 원산갈마해안관광지구건설장 현지지도 김정은위원장 원산갈마해안관광지구건설장 현지지도 (평양 4월 6일발 조선중앙통신)조선로동당 위원장이시며 조선민주주의인민공화국 국무위원회 위원장이시며 조선인민군 최고사령관이신 우리 April 06, 2019 (평양 4월 6일발 조선중앙통신)조선로동당 위원장이시며 조선민주주의인민공화국 국무위원회 위원장이시며 조선인민군 최고사령관이신 우리 Browse KCNA Watch Logo";
  const cleanedContext = cleanSourceSearchContextText("김정은위원장 원산갈마해안관광지구건설장 현지지도", noisyContext);
  const document = extractSourceSearchDocumentFromEntry({
    url: "https://kcnawatch.org/newstream/fixture-clean-fallback/",
    linkText: "김정은위원장 원산갈마해안관광지구건설장 현지지도",
    contextText: noisyContext,
    fromSourceSearch: true,
  }, {
    id: "kcna-watch",
    name: "KCNA Watch",
    sourceType: "archive",
    baseUrl: "https://kcnawatch.org/",
    languages: ["ko"],
    mediaTypes: ["article"],
    crawler: { includeUrlPatterns: ["/newstream/"] },
  });
  const productionDocuments = parseJsonl(productionDocumentsText);
  const productionNoise = productionDocuments
    .filter((candidate) => candidate.sourceId === "kcna-watch")
    .filter((candidate) => /\b(?:Browse|KCNA Watch Logo)\b/i.test(`${candidate.snippet} ${candidate.body}`));
  const genericNewstreamDocuments = productionDocuments
    .filter((candidate) => candidate.sourceId === "kcna-watch")
    .filter((candidate) => /\/newstream\/?$/i.test(candidate.url) || candidate.title === "Newstream | KCNA Watch");

  assert.equal(cleanedContext.includes("Browse"), false, "KCNA Watch search-result context should drop Browse chrome");
  assert.equal(cleanedContext.includes("KCNA Watch Logo"), false, "KCNA Watch search-result context should drop logo alt chrome");
  assert.equal(cleanedContext.includes("April 06, 2019"), false, "KCNA Watch search-result context should drop repeated English date separators");
  assert.equal(cleanedContext.startsWith("김정은위원장"), false, "KCNA Watch search-result context should not repeat the title before the excerpt");
  assert.equal(document?.date, "2019-04-06", "cleaning source-search context should not lose readable result dates");
  assert.equal(productionNoise.length, 0, "production KCNA Watch snippets/bodies should not expose search-page chrome text");
  assert.equal(genericNewstreamDocuments.length, 0, "production KCNA Watch should not index the generic newstream listing page");
}

async function assertWordPressApiEntriesBecomeDocuments() {
  const source = {
    id: "choson-sinbo",
    name: "조선신보",
    sourceType: "archive",
    baseUrl: "https://www.chosonsinbo.com/",
    languages: ["ko"],
    mediaTypes: ["article", "image"],
    crawler: {
      entryUrl: "https://www.chosonsinbo.com/",
      includeUrlPatterns: [/^https?:\/\/(?:www\.)?chosonsinbo\.com\/20\d{2}\/\d{2}\//i],
      wordpressPostsUrl: "https://www.chosonsinbo.com/wp-json/wp/v2/posts?per_page=2&_fields=id,date,link,title,excerpt,content,featured_media",
      wordpressSearchUrlTemplate: "https://www.chosonsinbo.com/wp-json/wp/v2/posts?per_page=2&search={query}&_fields=id,date,link,title,excerpt,content,featured_media",
      wordpressSearchQueries: ["원산갈마해안관광지구 준공식"],
      wordpressPreferReadable: true,
      robotsPolicy: "ignore",
    },
  };
  const readableApi = `
Title:
URL Source: https://www.chosonsinbo.com/wp-json/wp/v2/posts?per_page=2
Markdown Content:
[{"id":1,"date":"2026-05-19T17:33:04","link":"https://www.chosonsinbo.com/2026/05/19-380/","title":{"rendered":"온천시설에서 즐거운 한때"},"excerpt":{"rendered":"
<p>총련효고 니시고베조선초급학교 학생들이 온천시설에서 즐거운 시간을 보냈다.</p>"},"content":{"rendered":"<p>총련효고 니시고베조선초급학교 학생들이 지역 온천시설을 찾아 교류모임을 진행하였다.</p>"}},{"id":2,"date":"2026-05-18T08:00:00","link":"https://www.chosonsinbo.com/category/archive/","title":{"rendered":"분류 페지"},"excerpt":{"rendered":"<p>목록</p>"},"content":{"rendered":"<p>목록</p>"}},{"id":3,"date":"2026-05-19T10:00:00","link":"https://www.chosonsinbo.com/2026/05/19-381/","title":{"rendered":"약한 상세 본문 기사"},"excerpt":{"rendered":"<p>목록 API 발췌문은 약한 상세 페이지보다 검색에 쓸 수 있는 실제 기사 요약을 제공한다.</p>"},"content":{"rendered":"<p>목록 API 발췌문은 약한 상세 페이지보다 검색에 쓸 수 있는 실제 기사 요약을 제공한다.</p>"}}]
`;
  const readableSearchApi = `
Title:
URL Source: https://www.chosonsinbo.com/wp-json/wp/v2/posts?per_page=2&search=%EC%9B%90%EC%82%B0
Markdown Content:
[{"id":4,"date":"2025-06-26T07:14:37","link":"https://www.chosonsinbo.com/2025/06/26-293/","title":{"rendered":"원산갈마해안관광지구 준공식 성대히 진행/김정은원수님께서 참석"},"excerpt":{"rendered":"<p>사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 조선중앙통신은 원산갈마해안관광지구 준공식이 진행된 소식을 전하였다.</p>"},"content":{"rendered":"<p>사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 조선중앙통신은 원산갈마해안관광지구 준공식이 진행된 소식을 전하였다.</p>"}}]
`;
  const report = { errors: [] };
  const requestedUrls = [];
  const entries = await discoverSourceEntries(source, {
    report,
    maxLinks: 10,
    maxDiscoveryPages: 1,
    fetchHtmlImpl: async () => "<main></main>",
    fetchTextResourceImpl: async (url) => {
      requestedUrls.push(url);
      if (url.includes("search=")) return readableSearchApi;
      if (url.startsWith("https://r.jina.ai/http://https://www.chosonsinbo.com/wp-json/wp/v2/posts")) return readableApi;
      throw new Error(`unexpected fixture URL ${url}`);
    },
  });
  const documentEntry = entries.find((entry) => entry.url === "https://www.chosonsinbo.com/2026/05/19-380/");
  const searchDocumentEntry = entries.find((entry) => entry.url === "https://www.chosonsinbo.com/2025/06/26-293/");
  const productionChosonConfig = SEARCH_SOURCES.find((candidate) => candidate.id === "choson-sinbo")?.crawler;
  const detailSource = {
    ...source,
    crawler: {
      ...source.crawler,
      wordpressFetchDetailPages: true,
    },
  };
  const readableArticle = `
Title: 조선신보 | 온천시설에서 즐거운 한때
URL Source: https://www.chosonsinbo.com/2026/05/19-380/
Markdown Content:
# 온천시설에서 즐거운 한때
총련효고 니시고베조선초급학교 학생들이 지역 온천시설을 찾아 교류모임을 진행하였다.
상세 기사 본문은 목록 API의 짧은 발췌보다 길고 검색 가능한 실제 문장들을 포함한다.
`;
  const weakReadableArticle = `
Title: 조선신보 | 약한 상세 본문 기사
URL Source: https://www.chosonsinbo.com/2026/05/19-381/
Markdown Content:
# 약한 상세 본문 기사
2026년 05월 19일 10:00공화국
`;
  const detailCrawl = await crawlSources([detailSource], {
    limitPerSource: 3,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    timeoutMs: 1000,
    fetchHtmlImpl: async (url, options = {}) => {
      if (url === detailSource.crawler.entryUrl) return "<main></main>";
      if (url === "https://www.chosonsinbo.com/2026/05/19-380/") {
        assert.equal(options.preferReadable, true, "WordPress detail fetches should honor readable-first source config");
        return readableArticle;
      }
      if (url === "https://www.chosonsinbo.com/2026/05/19-381/") return weakReadableArticle;
      throw new Error(`unexpected detail fixture URL ${url}`);
    },
    fetchTextResourceImpl: async (url) => {
      if (url.includes("search=")) return readableSearchApi;
      if (url.startsWith("https://r.jina.ai/http://https://www.chosonsinbo.com/wp-json/wp/v2/posts")) return readableApi;
      throw new Error(`unexpected detail fixture API URL ${url}`);
    },
  });

  assert.equal(productionChosonConfig?.wordpressPreferReadable, true, "조선신보 importer should prefer readable snapshots for its public posts API when direct access is slow");
  assert.equal(Boolean(productionChosonConfig?.wordpressPostsUrl), true, "조선신보 should use its public posts list API instead of weak site-search");
  assert.equal(Boolean(productionChosonConfig?.wordpressSearchUrlTemplate), true, "조선신보 should use WordPress search API backfill for older topic coverage");
  assert.equal(productionChosonConfig?.wordpressSearchQueries?.includes("원산갈마해안관광지구 준공식"), true, "조선신보 search backfill should cover the Wonsan Kalma completion ceremony");
  assert.equal(productionChosonConfig?.wordpressFetchDetailPages, false, "조선신보 should index full WordPress API content directly instead of refetching rate-limited detail pages");
  assert.equal(productionChosonConfig?.skipHtmlDiscovery, true, "조선신보 should skip redundant HTML discovery once WordPress API content is available");
  assert.equal(productionChosonConfig?.wordpressPostsUrl?.includes("content"), true, "조선신보 WordPress API requests should include rendered content, not excerpt-only cards");
  assert.equal(requestedUrls[0].startsWith("https://r.jina.ai/http://https://www.chosonsinbo.com/wp-json/wp/v2/posts"), true, "WordPress API discovery should honor readable-first source config");
  assert.equal(requestedUrls[0].includes("search="), true, "WordPress search API backfill should be fetched before the latest-posts list so targeted coverage survives source limits");
  assert.equal(report.apiFetched, 2, "crawler should report public API/list fetch diagnostics");
  assert.equal(Boolean(documentEntry?.embeddedDocument), true, "WordPress API records should become embedded indexed documents");
  assert.equal(searchDocumentEntry?.embeddedDocument?.title, "원산갈마해안관광지구 준공식 성대히 진행/김정은원수님께서 참석", "WordPress search API records should backfill older topic articles");
  assert.equal(documentEntry?.embeddedDocument?.title, "온천시설에서 즐거운 한때", "WordPress title.rendered should become the document title");
  assert.equal(documentEntry?.embeddedDocument?.sourceName, "조선신보", "WordPress documents should retain source provenance");
  assert.equal(documentEntry?.embeddedDocument?.date, "2026-05-19", "WordPress dates should normalize");
  assert.equal(documentEntry?.embeddedDocument?.body.includes("교류모임"), true, "WordPress content.rendered should become indexed body text");
  assert.equal(entries.some((entry) => entry.url === "https://www.chosonsinbo.com/category/archive/"), false, "WordPress API discovery should still respect source include/exclude URL rules");
  const detailedDocument = detailCrawl.documents.find((document) => document.title === "온천시설에서 즐거운 한때");
  const fallbackDetailDocument = detailCrawl.documents.find((document) => document.title === "약한 상세 본문 기사");
  assert.equal(detailedDocument?.body.includes("상세 기사 본문"), true, "WordPress detail-page mode should index the readable article body");
  assert.equal(detailedDocument?.body.includes("짧은 발췌보다"), true, "WordPress detail-page mode should avoid excerpt-only documents");
  assert.equal(fallbackDetailDocument?.body.includes("목록 API 발췌문"), true, "WordPress detail-page mode should fall back to API text when readable pages expose only chrome");
}

async function assertDiscoveryFollowsListingPages() {
  const source = {
    id: "fixture-source",
    name: "Fixture Source",
    sourceType: "official_site",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article", "pdf"],
    crawler: {
      entryUrl: "https://example.test/",
      indexEntryUrl: false,
      includeUrlPatterns: ["/article/", "/books/"],
      discoverUrlPatterns: ["/list/"],
    },
  };
  const pages = new Map([
    ["https://example.test/", `
      <main>
        <a href="/list/latest">최신 목록</a>
        <a href="/article/direct">직접 기사</a>
      </main>
    `],
    ["https://example.test/list/latest", `
      <main>
        <a href="/article/deep">깊은 기사</a>
        <a href="/books/literature.pdf">문헌 PDF</a>
      </main>
    `],
  ]);
  const report = { errors: [] };
  const entries = await discoverSourceEntries(source, {
    report,
    maxLinks: 10,
    maxDiscoveryPages: 3,
    fetchHtmlImpl: async (url) => {
      if (!pages.has(url)) throw new Error(`unexpected fixture URL ${url}`);
      return pages.get(url);
    },
  });
  const urls = entries.map((entry) => entry.url);

  assert.equal(report.discoveryFetched, 2, "crawler should fetch the entry page and configured listing page");
  assert.equal(urls.includes("https://example.test/article/deep"), true, "discovery should include articles from listing pages");
  assert.equal(urls.includes("https://example.test/books/literature.pdf"), true, "discovery should include PDFs from listing pages");

  const overlappingPatternSource = {
    ...source,
    crawler: {
      entryUrl: "https://example.test/",
      indexEntryUrl: false,
      includeUrlPatterns: ["/category/articles/q/"],
      discoverUrlPatterns: ["/category/"],
    },
  };
  const overlappingEntries = await discoverSourceEntries(overlappingPatternSource, {
    maxLinks: 10,
    maxDiscoveryPages: 3,
    fetchHtmlImpl: async (url) => {
      if (url === "https://example.test/") {
        return `<main><a href="/category/articles/q/real-article.kcmsf">실제 기사</a></main>`;
      }
      throw new Error(`indexable detail URL should not be refetched as a discovery page: ${url}`);
    },
  });
  assert.equal(
    overlappingEntries.some((entry) => entry.url === "https://example.test/category/articles/q/real-article.kcmsf"),
    true,
    "discovery should keep indexable detail URLs in the frontier without following them as listing pages",
  );

  const ryugyongSource = {
    id: "ryugyong",
    name: "류경",
    sourceType: "official_site",
    baseUrl: "http://www.mediaryugyong.com.kp/",
    languages: ["ko", "en"],
    mediaTypes: ["image", "video"],
    crawler: {
      entryUrl: "http://www.mediaryugyong.com.kp/",
      indexEntryUrl: false,
      generatedListingPages: 2,
      listingSections: ["photo", "movie"],
      listingLanguages: ["ko"],
      includeUrlPatterns: ["/contents/photo/", "/contents/video/"],
    },
  };
  const fetchedRyugyongPages = [];
  const ryugyongEntries = await discoverSourceEntries(ryugyongSource, {
    maxLinks: 20,
    maxDiscoveryPages: 5,
    fetchHtmlImpl: async (url) => {
      fetchedRyugyongPages.push(url);
      if (url.includes("/photo?lang=ko&page=2")) {
        return `<main><div><a href="/contents/photo/normal/ko/2025/08/14/20250814_113249_001113255_thumb.jpg"><img src="/contents/photo/normal/ko/2025/08/14/20250814_113249_001113255_thumb.jpg" alt="Flower Festival 2025"></a> 9 44</div></main>`;
      }
      if (url.includes("/movie?lang=ko&page=2")) {
        return `<main><a href="/contents/video/ko/2025/11/03/20251103_101819_Golpu-1101829_thumb.jpg"><img src="/contents/video/ko/2025/11/03/20251103_101819_Golpu-1101829_thumb.jpg" alt="잊을수 없는 추억을 간직하게 하는 평양골프장"></a></main>`;
      }
      return "<main></main>";
    },
  });
  assert.equal(fetchedRyugyongPages.some((url) => url.includes("/photo?lang=ko&page=2")), true, "류경 discovery should generate deeper source-visible photo listing pages");
  assert.equal(fetchedRyugyongPages.some((url) => url.includes("/movie?lang=ko&page=2")), true, "류경 discovery should generate deeper source-visible movie listing pages");
  assert.equal(
    ryugyongEntries.some((entry) => (
      entry.embeddedDocument?.title === "Flower Festival 2025"
      && entry.embeddedDocument?.mediaType === "image"
      && entry.embeddedDocument?.date === "2025-08-14"
    )),
    true,
    "류경 generated photo listing pages should become indexed image records using URL dates instead of noisy listing counters",
  );
  assert.equal(
    ryugyongEntries.some((entry) => entry.embeddedDocument?.title.includes("평양골프장") && entry.embeddedDocument?.mediaType === "video"),
    true,
    "류경 generated movie listing pages should become indexed video records",
  );

  const wwwSource = {
    ...source,
    baseUrl: "https://www.example.test/",
    crawler: {
      entryUrl: "https://www.example.test/",
      indexEntryUrl: false,
      includeUrlPatterns: ["/article/"],
    },
  };
  const [apexEntry] = discoverLinkEntries(
    `<a href="https://example.test/article/apex">apex-domain article</a>`,
    "https://www.example.test/",
    wwwSource,
  );
  assert.equal(apexEntry?.url, "https://example.test/article/apex", "crawler should treat apex and www hostnames as the same source");
}

async function assertListingFallbacksRecoverDetailFetchFailures() {
  const source = {
    id: "kcna",
    name: "조선중앙통신",
    sourceType: "official_site",
    baseUrl: "http://www.kcna.kp/",
    languages: ["ko"],
    mediaTypes: ["article"],
    crawler: {
      entryUrl: "http://www.kcna.kp/kp",
      indexEntryUrl: false,
      indexListingFallbacks: true,
      includeUrlPatterns: [/\/kp\/article\/q\//i],
      robotsPolicy: "ignore",
      selectors: {
        title: "h1",
        date: "time",
        body: "article",
      },
    },
  };
  const listing = `
    <main>
      <article>
        <a href="/kp/article/q/listing-fallback.kcmsf">조선민주주의인민공화국 외무상이 회담</a>
        <span>[2026.05.14.]</span>
      </article>
    </main>
  `;
  const crawl = await crawlSources([source], {
    limitPerSource: 2,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => {
      if (url === "http://www.kcna.kp/kp") return listing;
      throw new Error("network timeout");
    },
  });

  assert.equal(crawl.documents[0]?.title, "조선민주주의인민공화국 외무상이 회담", "KCNA listing fallback should preserve the real listing title");
  assert.equal(crawl.documents[0]?.date, "2026-05-14", "KCNA listing fallback should preserve listing dates");
  assert.equal(crawl.crawlReports[0]?.listingFallbacks, 1, "listing fallbacks should be reported separately");
  assert.deepEqual(crawl.crawlReports[0]?.errors, [], "successful listing fallback should not leave a detail-fetch health error");

  const vokSource = {
    id: "voice-of-korea",
    name: "조선의 소리",
    sourceType: "official_site",
    baseUrl: "http://www.vok.rep.kp/",
    languages: ["ko"],
    mediaTypes: ["article", "broadcast"],
    crawler: {
      entryUrl: "http://www.vok.rep.kp/index.php/Colist/newslist/18/ko",
      indexEntryUrl: false,
      indexListingFallbacks: true,
      includeUrlPatterns: ["/index.php/detail_com/"],
      robotsPolicy: "ignore",
    },
  };
  const vokListing = `
    <main>
      <a href="/index.php/detail_com/vi_audio/ike260408026">조선의 소리 방송 오디오</a>
      <a href="/index.php/detail_com/comde/ikn260519005/18/ko">2026년 아시아축구련맹 17살미만 녀자아시아컵경기대회에서 우승한 우리 선수들 귀국(2026.5.20)</a>
      <a href="/index.php/detail_com/comde/ikn260519005/18/ko"></a>
    </main>
  `;
  const vokCrawl = await crawlSources([vokSource], {
    limitPerSource: 3,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => {
      if (url === "http://www.vok.rep.kp/index.php/Colist/newslist/18/ko") return vokListing;
      throw new Error("HTTP 429");
    },
  });
  const vokAudioDocument = vokCrawl.documents.find((document) => document.url.includes("/vi_audio/"));
  const vokArticleDocument = vokCrawl.documents.find((document) => document.url.includes("/comde/"));

  assert.equal(vokCrawl.crawlReports[0]?.listingFallbacks, 2, "VOK listing fallback should preserve detail links when the site rate-limits detail fetches");
  assert.equal(vokAudioDocument?.mediaType, "broadcast", "VOK vi_audio fallback documents should use the broadcast media type allowed by the source");
  assert.deepEqual(vokAudioDocument?.searchTabs, ["all", "video"], "VOK broadcast fallbacks should be visible in 전체 and 동영상");
  assert.equal(vokArticleDocument?.title.includes("아시아축구련맹"), true, "duplicate empty VOK anchors should not overwrite a titled listing link");
  assert.equal(vokArticleDocument?.date, "2026-05-20", "VOK article listing fallback should preserve the date embedded in the listing title");
  assert.deepEqual(vokCrawl.crawlReports[0]?.errors, [], "VOK successful listing fallbacks should not leave HTTP 429 health errors");

  const vokReadableListing = `Title: 조선의 소리
URL Source: http://www.vok.rep.kp/index.php/Colist/cscdlist/69/10/ko

Markdown Content:
| #### [삼지연관광지구의 봉사시설들](https://www.vok.rep.kp/index.php/detail_com/vi_video/ike260317008) | 2026.5.13 |

[![Image 8: 평양국제관광기념품 및 건강제품전시회](http://www.vok.rep.kp/resources/cbc_pddata/cbc_ike260418009/000.jpg) 평양국제관광기념품 및 건강제품전시회 2026.4.22](http://www.vok.rep.kp/index.php/detail_com/vi_video/ike260418009)
`;
  const vokReadableEntries = discoverEmbeddedDocumentEntries(
    vokReadableListing,
    "http://www.vok.rep.kp/index.php/Colist/cscdlist/69/10/ko",
    vokSource,
  );
  const samjiyonEntry = vokReadableEntries.find((entry) => entry.linkText === "삼지연관광지구의 봉사시설들");
  const tourismEntry = vokReadableEntries.find((entry) => entry.linkText === "평양국제관광기념품 및 건강제품전시회");
  assert.equal(samjiyonEntry?.url, "http://www.vok.rep.kp/index.php/detail_com/vi_video/ike260317008", "VOK readable table rows should normalize detail URLs to the faster http source route");
  assert.equal(samjiyonEntry?.date, "2026-05-13", "VOK readable table rows should keep source-visible listing dates");
  assert.equal(tourismEntry?.date, "2026-04-22", "VOK readable image cards should keep source-visible card dates");
  assert.equal(tourismEntry?.thumbnailUrl?.includes("/cbc_ike260418009/000.jpg"), true, "VOK readable image cards should preserve source thumbnails");
  assert.equal(Boolean(tourismEntry?.embeddedDocument), false, "VOK readable listing entries should still attempt detail fetches before falling back");

  const vokReadableCrawl = await crawlSources([{
    ...vokSource,
    crawler: {
      ...vokSource.crawler,
      entryUrl: "http://www.vok.rep.kp/index.php/Colist/cscdlist/69/10/ko",
    },
  }], {
    limitPerSource: 3,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => {
      if (url === "http://www.vok.rep.kp/index.php/Colist/cscdlist/69/10/ko") return vokReadableListing;
      throw new Error("HTTP 429");
    },
  });
  const vokReadableTourismDocument = vokReadableCrawl.documents.find((document) => document.title === "평양국제관광기념품 및 건강제품전시회");
  assert.equal(vokReadableTourismDocument?.mediaType, "broadcast", "VOK readable image-card fallback documents should infer broadcast detail media");
  assert.equal(vokReadableTourismDocument?.archiveUrl, "http://www.vok.rep.kp/index.php/Colist/cscdlist/69/10/ko", "VOK readable image-card fallbacks should link back to the source-visible listing page");
  assert.equal(vokReadableTourismDocument?.thumbnailUrl?.includes("/cbc_ike260418009/000.jpg"), true, "VOK readable image-card fallback documents should keep thumbnails");

  const vokDetailSeedCrawl = await crawlSources([{
    ...vokSource,
    crawler: {
      ...vokSource.crawler,
      detailSeedUrls: [{
        url: "http://www.vok.rep.kp/index.php/revo_de/getDetail/ikn250625008/ko",
        title: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행",
        date: "2025-06-26",
      }],
      includeUrlPatterns: ["/index.php/revo_de/getDetail/"],
    },
  }], {
    limitPerSource: 1,
    maxLinksPerSource: 1,
    maxDiscoveryPages: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async () => `
      <main>
        <h1>조선의 소리</h1>
        <nav>어종선택 Deutsch Русский English</nav>
        <footer>《조선의 소리》조선어방송편집부 www.vok.rep.kpE mail: vok@star-co.net.kp</footer>
      </main>
    `,
  });
  assert.equal(vokDetailSeedCrawl.documents[0]?.title.includes("원산갈마해안관광지구 준공식"), true, "VOK priority detail seeds should fall back to the source-visible seed title when detail pages return language chrome");
  assert.equal(/어종선택|vok@star-co\.net\.kp/i.test(vokDetailSeedCrawl.documents[0]?.body || ""), false, "VOK priority detail seeds should not index language-selector chrome as article body");

  const minjuSource = {
    id: "minju-choson",
    name: "민주조선",
    sourceType: "official_site",
    baseUrl: "http://www.minju.rep.kp/",
    languages: ["ko"],
    mediaTypes: ["article"],
    crawler: {
      entryUrl: "http://www.minju.rep.kp/",
      indexEntryUrl: false,
      indexListingFallbacks: true,
      preferListingDocuments: true,
      includeUrlPatterns: [/\/Home\/index\/disp\/\d+\/ko$/i],
      robotsPolicy: "ignore",
    },
  };
  const minjuListing = `
    <main>
      <article>
        <a href="/Home/index/disp/8560/ko">지하명승－룡문대굴</a>
        <span>[2026.5.20.]</span>
      </article>
    </main>
  `;
  const minjuCrawl = await crawlSources([minjuSource], {
    limitPerSource: 2,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => {
      if (url === "http://www.minju.rep.kp/") return minjuListing;
      throw new Error(`민주조선 preferListingDocuments should not fetch chrome-heavy detail pages: ${url}`);
    },
  });

  assert.equal(minjuCrawl.documents[0]?.title, "지하명승－룡문대굴", "민주조선 should index clean listing rows without fetching chrome-heavy detail pages");
  assert.equal(minjuCrawl.documents[0]?.date, "2026-05-20", "민주조선 listing-first documents should preserve listing dates");
  assert.equal(minjuCrawl.crawlReports[0]?.fetched, 0, "민주조선 listing-first documents should skip detail fetches");

  const deadlineListing = `
    <main>
      <article><a href="/kp/article/q/deadline-1.kcmsf">시간예산 첫번째 기사 [2026.05.20.]</a></article>
      <article><a href="/kp/article/q/deadline-2.kcmsf">시간예산 두번째 기사 [2026.05.19.]</a></article>
      <article><a href="/kp/article/q/deadline-3.kcmsf">시간예산 세번째 기사 [2026.05.18.]</a></article>
    </main>
  `;
  const deadlineCrawl = await crawlSources([source], {
    limitPerSource: 4,
    maxSourceMs: 10,
    maxLinksPerSource: 6,
    maxDiscoveryPages: 1,
    concurrency: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => {
      if (url === "http://www.kcna.kp/kp") return deadlineListing;
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("late detail fetch");
    },
  });
  const deadlineReport = deadlineCrawl.crawlReports[0];

  assert.equal(deadlineCrawl.documents.length, 3, "deadline fallback should preserve listing-backed documents that remain after the fetch budget expires");
  assert.equal(deadlineReport?.deadlineFallbacks >= 1, true, "deadline fallback recovery should be reported separately");
  assert.deepEqual(deadlineReport?.errors, ["source time budget exceeded while fetching documents"], "deadline fetch warnings should be deduplicated");

  const postDiscoveryDeadlineSource = {
    ...source,
    crawler: {
      ...source.crawler,
      preferListingDocuments: true,
    },
  };
  const postDiscoveryDeadlineCrawl = await crawlSources([postDiscoveryDeadlineSource], {
    limitPerSource: 4,
    maxSourceMs: 5,
    maxLinksPerSource: 6,
    maxDiscoveryPages: 1,
    concurrency: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => {
      if (url === "http://www.kcna.kp/kp") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return deadlineListing;
      }
      throw new Error("post-discovery deadline should not fetch detail pages");
    },
  });
  assert.equal(
    postDiscoveryDeadlineCrawl.documents.length,
    3,
    "listing-first sources should preserve discovered rows when the source deadline expires after discovery",
  );

  const reserveAwareDiscoverySource = {
    id: "kcna-watch",
    name: "KCNA Watch",
    sourceType: "archive",
    baseUrl: "https://kcnawatch.org/",
    languages: ["ko"],
    mediaTypes: ["article"],
    crawler: {
      entryUrl: "https://kcnawatch.org/",
      sitemapUrls: ["https://kcnawatch.org/sitemap_index.xml"],
      searchUrlTemplates: ["https://kcnawatch.org/?s={query}"],
      searchQueries: ["원산갈마"],
      includeUrlPatterns: ["/newstream/"],
      indexEntryUrl: false,
      skipHtmlDiscovery: true,
      robotsPolicy: "ignore",
      selectors: {
        title: "h1",
        date: "time",
        body: "article",
      },
    },
  };
  let reserveSitemapFetches = 0;
  const reserveAwareCrawl = await crawlSources([reserveAwareDiscoverySource], {
    limitPerSource: 2,
    maxSourceMs: 120,
    discoveryReserveMs: 70,
    maxLinksPerSource: 4,
    maxDiscoveryPages: 1,
    concurrency: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchTextResourceImpl: async (url) => {
      reserveSitemapFetches += 1;
      if (url === "https://kcnawatch.org/sitemap_index.xml") {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return `
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://kcnawatch.org/newstream/reserve-1/</loc></url>
          </urlset>
        `;
      }
      await new Promise((resolve) => setTimeout(resolve, 90));
      return "<urlset></urlset>";
    },
    fetchHtmlImpl: async (url) => {
      if (url === "https://kcnawatch.org/?s=%EC%9B%90%EC%82%B0%EA%B0%88%EB%A7%88") {
        throw new Error("search discovery should stop once sitemap entries have reserved detail-fetch time");
      }
      return `
        <article>
          <h1>원산갈마 검색 발견 문서</h1>
          <time>2026-05-20</time>
          <p>원산갈마해안관광지구 관련 상세 본문이 충분히 길게 색인되어 검색 결과로 제공된다.</p>
        </article>
      `;
    },
  });
  const reserveAwareReport = reserveAwareCrawl.crawlReports[0];
  assert.equal(reserveSitemapFetches, 1, "configured sitemap discovery should leave the detail-fetch reserve instead of continuing into search discovery");
  assert.equal(reserveAwareReport?.discoveryStoppedForFetchReserve, true, "configured sitemap/search discovery should report when it stops to preserve detail-fetch time");
  assert.equal(reserveAwareCrawl.documents[0]?.title, "원산갈마 검색 발견 문서", "reserved discovery time should leave enough budget to fetch discovered KCNA Watch detail pages");

  const detailLimitListing = `
    <main>
      <article><a href="/kp/article/q/detail-limit-1.kcmsf">상세상한 첫번째 기사 [2026.05.20.]</a></article>
      <article><a href="/kp/article/q/detail-limit-2.kcmsf">상세상한 두번째 기사 [2026.05.19.]</a></article>
      <article><a href="/kp/article/q/detail-limit-3.kcmsf">상세상한 세번째 기사 [2026.05.18.]</a></article>
    </main>
  `;
  const detailLimitCrawl = await crawlSources([source], {
    limitPerSource: 4,
    maxDetailFetchesPerSource: 1,
    maxLinksPerSource: 6,
    maxDiscoveryPages: 1,
    concurrency: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async (url) => {
      if (url === "http://www.kcna.kp/kp") return detailLimitListing;
      if (url.endsWith("detail-limit-1.kcmsf")) {
        return "<article><h1>상세상한 첫번째 기사</h1><p>상세 본문이 충분히 길게 색인되고 목록 대체문서와 함께 보존된다.</p><time>2026-05-20</time></article>";
      }
      throw new Error(`detail fetch limit should skip ${url}`);
    },
  });
  const detailLimitReport = detailLimitCrawl.crawlReports[0];

  assert.equal(detailLimitReport?.fetched, 1, "detail fetch limits should cap expensive detail-page requests");
  assert.equal(detailLimitCrawl.documents.length, 3, "detail fetch limits should preserve remaining listing-backed documents as fallback records");
  assert.equal(detailLimitReport?.detailFetchLimitFallbacks, 2, "detail fetch limit fallbacks should be reported separately from deadline fallbacks");
  assert.equal(detailLimitReport?.detailFetchLimitReached, true, "detail fetch limit recovery should preserve a health diagnostic");
  assert.deepEqual(detailLimitReport?.errors, [], "planned detail fetch limits should not look like crawler failures");

  const pdfReadableFetches = [];
  const pdfLimitSource = {
    id: "korean-books",
    name: "조선의 출판물",
    sourceType: "official_site",
    baseUrl: "http://www.korean-books.com.kp/",
    languages: ["ko"],
    mediaTypes: ["pdf"],
    crawler: {
      entryUrl: "http://www.korean-books.com.kp/",
      indexEntryUrl: false,
      includeUrlPatterns: [".pdf"],
      fetchPdfText: true,
      maxPdfTextFetchesPerSource: 1,
      maxPdfTextLength: 2000,
      detailSeedUrls: [{
        url: "http://www.korean-books.com.kp/KBMbooks/ko/etc/cahier/20250703115805.pdf",
        title: "원산갈마해안관광지구안내",
        date: "2025-07-03",
      }],
      robotsPolicy: "ignore",
    },
  };
  const pdfLimitCrawl = await crawlSources([pdfLimitSource], {
    limitPerSource: 4,
    maxLinksPerSource: 5,
    maxDiscoveryPages: 1,
    concurrency: 1,
    retries: 0,
    useFetchCache: false,
    allowReadableFallback: false,
    fetchHtmlImpl: async () => `
      <main>
        <article><a href="/KBMbooks/ko/etc/cahier/20250703115805.pdf">원산갈마해안관광지구안내 2025.07.03</a></article>
        <article><a href="/KBMbooks/ko/etc/post/20260413105243.pdf">원산갈마해안관광지구 2026.04.13</a></article>
        <article><a href="/KBMbooks/ko/etc/cahier/20260508125846.pdf">룡문대굴 2026.05.08</a></article>
      </main>
    `,
    fetchReadableTextResourceImpl: async (url) => {
      pdfReadableFetches.push(url);
      return `
Title: 20250703115805.pdf
URL Source: ${url}
Markdown Content:
# 명사십리휴양구역-1
원산갈마관광안내소 갈마백화점 명사십리호텔 묘향호텔
Wonsan Kalma Tour Information Office
Myongsasimni Resort Area 1 Foreign Languages Publishing House, DPRK 2025
`;
    },
  });
  const pdfLimitReport = pdfLimitCrawl.crawlReports[0];
  assert.deepEqual(pdfReadableFetches, ["http://www.korean-books.com.kp/KBMbooks/ko/etc/cahier/20250703115805.pdf"], "PDF text fetch caps should spend the budget on configured priority PDF seeds first");
  assert.equal(pdfLimitReport?.pdfTextFetchAttempts, 1, "PDF readable text fetch attempts should respect the source-scoped cap");
  assert.equal(pdfLimitReport?.pdfTextFetchLimitFallbacks, 2, "PDF records beyond the readable text cap should remain indexed as metadata-backed documents");
  assert.deepEqual(pdfLimitReport?.errors, [], "planned PDF text fetch caps should not look like crawler failures");
  assert.equal(pdfLimitCrawl.documents.some((document) => document.title.includes("원산갈마해안관광지구안내") && /Wonsan Kalma Tour Information Office/.test(document.body || "")), true, "priority Wonsan Kalma PDFs should still receive searchable body text");
}

async function assertCrawlerRespectsRobotsPolicy() {
  const source = {
    id: "fixture-source",
    name: "Fixture Source",
    sourceType: "official_site",
    baseUrl: "https://example.test/",
    languages: ["ko"],
    mediaTypes: ["article"],
    crawler: {
      entryUrl: "https://example.test/",
      indexEntryUrl: false,
      includeUrlPatterns: ["/article/"],
      discoverUrlPatterns: ["/list/"],
      robotsPolicy: "respect",
    },
  };
  const robotsText = `
User-agent: *
Disallow: /private/
Allow: /private/public
Disallow: /list/private
Disallow: /blocked-feed
`;
  const rules = parseRobotsTxt(robotsText, "DPRKArchiveSearchBot/0.1");
  const pages = new Map([
    ["https://example.test/", `
      <main>
        <a href="/article/open">공개 기사</a>
        <a href="/private/article/hidden">차단 기사</a>
        <a href="/private/public/article/visible">허용된 예외 기사</a>
        <a href="/list/private">차단 목록</a>
      </main>
    `],
    ["https://example.test/list/private", `
      <main><a href="/article/from-disallowed-list">차단 목록 기사</a></main>
    `],
  ]);
  const report = { errors: [] };
  const entries = await discoverSourceEntries(source, {
    report,
    maxLinks: 10,
    maxDiscoveryPages: 3,
    fetchTextResourceImpl: async (url) => {
      assert.equal(url, "https://example.test/robots.txt", "respectful crawler should request source robots.txt");
      return robotsText;
    },
    fetchHtmlImpl: async (url) => {
      if (!pages.has(url)) throw new Error(`robots test fetched disallowed or unexpected URL ${url}`);
      return pages.get(url);
    },
  });
  const urls = entries.map((entry) => entry.url);

  assert.equal(isRobotsAllowed("https://example.test/article/open", source, rules), true, "robots parser should allow unmatched public paths");
  assert.equal(isRobotsAllowed("https://example.test/private/article/hidden", source, rules), false, "robots parser should disallow matching private paths");
  assert.equal(isRobotsAllowed("https://example.test/private/public/article/visible", source, rules), true, "robots parser should honor more-specific Allow rules");
  assert.equal(urls.includes("https://example.test/article/open"), true, "crawler should keep robots-allowed article URLs");
  assert.equal(urls.includes("https://example.test/private/public/article/visible"), true, "crawler should keep robots-allowed exception URLs");
  assert.equal(urls.includes("https://example.test/private/article/hidden"), false, "crawler should drop robots-disallowed article URLs");
  assert.equal(urls.includes("https://example.test/article/from-disallowed-list"), false, "crawler should not fetch or index links from robots-disallowed listing pages");
  assert.equal(report.robotsDisallowed > 0, true, "crawler report should expose robots-disallowed skips");
}

async function assertKoryoVodImporterRespectsRobotsPolicy() {
  const source = {
    id: "koryo-vod",
    name: "고려TV VOD",
    sourceType: "video_archive",
    baseUrl: "https://vod.example.test/",
    languages: ["ko", "en"],
    mediaTypes: ["video"],
    searchTabs: ["all", "video"],
    aliases: ["고려TV"],
    crawler: {
      apiUrl: "https://vod.example.test/api/v1/media",
      robotsPolicy: "respect",
    },
  };
  const robotsText = `
User-agent: *
Disallow: /view
Allow: /view?m=allowed
`;
  const apiPayload = {
    results: [
      {
        title: "Allowed VOD",
        url: "https://vod.example.test/view?m=allowed",
        state: "public",
        friendly_token: "allowed",
        add_date: "2026-05-19T00:00:00Z",
        duration: 100,
        thumbnail_url: "https://vod.example.test/thumb/allowed.jpg",
      },
      {
        title: "Blocked VOD",
        url: "https://vod.example.test/view?m=blocked",
        state: "public",
        friendly_token: "blocked",
        add_date: "2026-05-19T00:00:00Z",
        duration: 100,
        thumbnail_url: "https://vod.example.test/thumb/blocked.jpg",
      },
    ],
    next: null,
  };
  const { documents, report } = await fetchKoryoVodDocuments(source, {
    limitPerSource: 5,
    fetchTextResourceImpl: async (url) => {
      if (url === "https://vod.example.test/robots.txt") return robotsText;
      if (url.startsWith("https://vod.example.test/api/v1/media")) return JSON.stringify(apiPayload);
      throw new Error(`unexpected 고려TV fixture URL ${url}`);
    },
  });

  assert.deepEqual(documents.map((document) => document.id), ["koryo-vod-allowed"], "고려TV importer should index only robots-allowed VOD items");
  assert.deepEqual(documents[0]?.searchTabs, ["all", "video"], "고려TV VOD documents should be visible in both 전체 and 동영상");
  assert.equal(report.robotsDisallowed, 1, "고려TV importer should report robots-disallowed VOD items");
  assert.equal(report.robotsSkippedUrls[0], "https://vod.example.test/view?m=blocked", "고려TV importer should expose skipped robots URL");
}

async function assertProductionDocumentsDoNotIndexPageChrome(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const pageChromePattern = /언어선택|첫페지|분야별기사|저작권\s+2026|더보기\s+최근소식/;
  const minjuDocuments = productionDocuments.filter((document) => document.sourceId === "minju-choson");

  for (const document of minjuDocuments) {
    assert.equal(/\/en$/i.test(document.url || ""), false, `민주조선 Korean index should not include English page chrome: ${document.url}`);
    assert.equal(pageChromePattern.test(document.body || ""), false, `민주조선 body should not index page chrome: ${document.title}`);
    assert.equal((document.body || "").length < 800, true, `민주조선 body should stay focused on one result item: ${document.title}`);
  }
}

async function assertProductionKcnaDatelineDatesMatch(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const kcnaDocuments = productionDocuments.filter((document) => document.sourceId === "kcna");
  const substantialKcnaDocuments = kcnaDocuments.filter((document) => (document.body || "").length >= 900);

  assert.equal(kcnaDocuments.length > 0, true, "조선중앙통신 should contribute indexed article documents");
  assert.equal(substantialKcnaDocuments.length >= 30, true, "조선중앙통신 production index should include substantial article bodies, not mostly listing cards");
  for (const document of kcnaDocuments) {
    const datelineMonthDay = extractKcnaDatelineMonthDay(document.body || document.snippet || "");
    if (!datelineMonthDay) continue;
    assert.equal(
      String(document.date || "").slice(5, 10),
      datelineMonthDay,
      `조선중앙통신 date should match its article dateline: ${document.title}`,
    );
  }
}

async function assertProductionDocumentsDoNotIndexRodongPageChrome(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const rodongDocuments = productionDocuments.filter((document) => document.sourceId === "rodong-sinmun");
  const substantialRodongDocuments = rodongDocuments.filter((document) => (document.body || "").length >= 900);
  const meaningfulRodongDocuments = rodongDocuments.filter((document) => (document.body || "").length >= 240);
  const pageChromePattern = /오늘호 기사|Copyright @ 2026 by The Rodong Sinmun|검색 혁명활동소식|인민을 위한 정치/;

  assert.equal(rodongDocuments.length > 0, true, "로동신문 should contribute indexed article documents");
  assert.equal(rodongDocuments.length >= 200, true, "로동신문 production index should preserve broad source-visible article coverage");
  assert.equal(meaningfulRodongDocuments.length >= 110, true, "로동신문 production index should include meaningful article bodies, not mostly title/date cards");
  assert.equal(substantialRodongDocuments.length >= 75, true, "로동신문 production index should keep a substantial readable-body floor after broad crawling");
  for (const document of rodongDocuments) {
    assert.equal(pageChromePattern.test(document.body || ""), false, `로동신문 body should not index page chrome: ${document.title}`);
    assert.equal((document.body || "").length < 15000, true, `로동신문 body should stay bounded to article text: ${document.title}`);
  }
}

async function assertProductionVoiceOfKoreaDocumentsDoNotIndexRepeatedPageChrome(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const voiceDocuments = productionDocuments.filter((document) => document.sourceId === "voice-of-korea");
  const pageChromePattern = /(?:^|\n)(?:vok|첫페지로|어종선택|Deutsch|Русский|汉\s*语|Français|العربية|English|日\s*本\s*語|Español|Audio\s+\d+)(?:\n|$)|조선어방송편집부|www\.vok\.rep\.kp/i;

  assert.equal(voiceDocuments.length > 0, true, "조선의 소리 should contribute indexed article documents");
  assert.equal(voiceDocuments.length >= 350, true, "조선의 소리 production index should include broad source-visible coverage beyond first-page news");
  const tourismCardDocument = voiceDocuments.find((document) => document.title === "평양국제관광기념품 및 건강제품전시회");
  assert.equal(Boolean(tourismCardDocument), true, "조선의 소리 production index should include source-visible tourism/culture card listings");
  assert.equal(
    tourismCardDocument?.archiveUrl?.includes("/Colist/cscdlist/69/10/ko"),
    true,
    "조선의 소리 tourism/culture card fallback should preserve its source-visible listing URL",
  );
  assert.equal(
    voiceDocuments.some((document) => document.title === "유화 《천지개벽된 삼지연시》"),
    true,
    "조선의 소리 production index should include non-news culture/video listing records",
  );
  for (const document of voiceDocuments) {
    const body = document.body || "";
    const repeatedLines = countRepeatedBodyLines(body);
    assert.equal(pageChromePattern.test(body), false, `조선의 소리 body should not index language/audio page chrome: ${document.title}`);
    assert.equal(repeatedLines.length, 0, `조선의 소리 body should collapse repeated article chrome lines: ${document.title}`);
  }
}

function countRepeatedBodyLines(body = "") {
  const counts = new Map();
  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 12) continue;
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1);
}

async function assertProductionChosonSinboDocumentsUseArticleText(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const chosonDocuments = productionDocuments.filter((document) => document.sourceId === "choson-sinbo");
  const paywallPattern = /この記事の続きを読む|有料プラン|로그인 폼|신규회원등록|パスワードをお忘れですか|Login/;

  assert.equal(chosonDocuments.length > 0, true, "조선신보 should contribute indexed article documents");
  for (const document of chosonDocuments) {
    assert.equal((document.body || "").length >= 80, true, `조선신보 body should contain article text, not only date/category chrome: ${document.title}`);
    assert.equal(paywallPattern.test(document.body || ""), false, `조선신보 body should not index paywall/login chrome: ${document.title}`);
  }
}

async function assertProductionWonsanCoverageSpansMultipleSources(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const productionSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));
  const provider = new LocalJsonSearchProvider({ documents: productionDocuments, sources: productionSources });
  const broadResult = await provider.searchDocuments("원산", { tab: "all", limit: 40 });
  const result = await provider.searchDocuments("원산갈마", { tab: "all", limit: 40 });
  const ceremonyResult = await provider.searchDocuments("원산갈마해안관광지구 준공식", { tab: "all", limit: 40 });
  const spacedResult = await provider.searchDocuments("원산 갈마", { tab: "all", limit: 40 });
  const englishWonsanResult = await provider.searchDocuments("Wonsan", { tab: "all", limit: 40 });
  const englishKalmaResult = await provider.searchDocuments("Kalma", { tab: "all", limit: 40 });
  const personPlaceResult = await provider.searchDocuments("김정은 원산갈마", { tab: "all", limit: 40 });
  const englishPersonPlaceResult = await provider.searchDocuments("Kim Jong Un Wonsan Kalma", { tab: "all", limit: 40 });
  const broadFacetSourceIds = new Set(broadResult.sourceFacets.map((facet) => facet.sourceId));
  const resultFacetSourceIds = new Set(result.sourceFacets.map((facet) => facet.sourceId));
  const ceremonyFacetSourceIds = new Set(ceremonyResult.sourceFacets.map((facet) => facet.sourceId));
  const ceremonyPhysicalSourceIds = new Set(ceremonyResult.documents.map((document) => document.sourceId));
  const physicalSourceIds = new Set(result.documents.map((document) => document.sourceId));
  const originalSourceIds = new Set(result.documents
    .filter((document) => document.sourceId === "kcna-watch")
    .map((document) => document.displaySourceId || "")
    .filter((sourceId) => sourceId && sourceId !== "kcna-watch"));
  const ceremonyOriginalSourceIds = new Set(ceremonyResult.documents
    .filter((document) => document.sourceId === "kcna-watch")
    .map((document) => document.displaySourceId || "")
    .filter((sourceId) => sourceId && sourceId !== "kcna-watch"));
  const chosonArticle = productionDocuments.find((document) => (
    document.sourceId === "choson-sinbo"
    && /원산갈마해안관광지구 준공식/.test(`${document.title} ${document.snippet} ${document.body}`)
  ));
  const resultFacetCounts = result.sourceFacets.map(({ sourceId, count }) => [sourceId, count]);
  const spacedFacetCounts = spacedResult.sourceFacets.map(({ sourceId, count }) => [sourceId, count]);
  const englishWonsanFacetCounts = englishWonsanResult.sourceFacets.map(({ sourceId, count }) => [sourceId, count]);
  const englishKalmaFacetCounts = englishKalmaResult.sourceFacets.map(({ sourceId, count }) => [sourceId, count]);
  const forbiddenManualBackfillDocuments = productionDocuments.filter((document) => FORBIDDEN_MANUAL_WONSAN_BACKFILL_IDS.has(document.id));
  const discoveredKcnaCeremonyArticle = productionDocuments.find((document) => (
    document.sourceId === "kcna"
    && document.url === KCNA_WONSAN_KALMA_CEREMONY_URL
  ));
  const discoveredKcnaServiceArticle = productionDocuments.find((document) => (
    document.sourceId === "kcna"
    && document.url === KCNA_WONSAN_KALMA_SERVICE_URL
  ));
  const discoveredVoiceOfKoreaCeremonyArticle = productionDocuments.find((document) => (
    document.sourceId === "voice-of-korea"
    && /\/revo_de\/getDetail\/i[ek]n250625008\/(?:ko|en)$/i.test(document.url)
    && /원산갈마해안관광지구 준공식|Wonsan Kalma Coastal Tourist Area/i.test(`${document.title} ${document.snippet} ${document.body}`)
  ));
  const voiceOfKoreaCeremonySeedDocuments = (await buildSearchSeed()).documents.filter((document) => (
    document.sourceId === "voice-of-korea"
    && /\/revo_de\/getDetail\/i[ek]n250625008\/(?:ko|en)$/i.test(document.url)
  ));

  assert.equal(Boolean(chosonArticle), true, "production 조선신보 index should include Wonsan Kalma completion ceremony backfill coverage");
  assert.deepEqual(forbiddenManualBackfillDocuments.map((document) => document.id), [], "production index should not contain configured Wonsan Kalma backfill documents");
  assert.equal(Boolean(discoveredKcnaCeremonyArticle), true, "KCNA Wonsan Kalma ceremony coverage should be discovered from paginated source listings");
  assert.equal((discoveredKcnaServiceArticle?.body || "").length >= 500, true, "KCNA Wonsan Kalma service-start article should be fetched from readable detail text, not left as a title/date listing fallback");
  assert.equal(Boolean(discoveredVoiceOfKoreaCeremonyArticle), true, "조선의 소리 Wonsan Kalma ceremony coverage should be fetched from source-visible priority detail URLs");
  assert.equal(voiceOfKoreaCeremonySeedDocuments.length >= 2, true, "조선의 소리 Wonsan Kalma ceremony seed should keep Korean and English official detail records");
  assert.equal(voiceOfKoreaCeremonySeedDocuments.every((document) => document.previewText.length >= 300 && document.previewSourceName && document.previewDocumentId), true, "조선의 소리 ceremony backend records should keep enriched preview provenance because source detail pages expose only sparse chrome");
  assert.equal(broadFacetSourceIds.size >= 3, true, "원산 search should surface multiple source categories, not only KCNA Watch and 류경");
  assert.equal(broadFacetSourceIds.has("kcna-watch"), true, "원산 search should keep KCNA Watch preserved copies in the KCNA Watch source category");
  assert.equal(broadFacetSourceIds.has("choson-sinbo"), true, "원산 search should expose 조선신보 direct coverage through source facets");
  assert.equal(broadFacetSourceIds.has("ryugyong"), true, "원산 search should expose 류경 direct coverage through source facets");
  assert.equal(ceremonyResult.total >= 6, true, "원산갈마해안관광지구 준공식 should return multiple real indexed ceremony reports");
  assert.equal(ceremonyResult.documents.every((document) => document.scoreReason?.startsWith("multi:")), true, "원산갈마해안관광지구 준공식 should require both place and event terms");
  assert.equal(ceremonyFacetSourceIds.size >= 2, true, "원산갈마해안관광지구 준공식 should span KCNA Watch archives and direct sources");
  assert.equal(ceremonyFacetSourceIds.has("kcna-watch"), true, "원산갈마해안관광지구 준공식 should keep KCNA Watch preserved copies in the KCNA Watch source category");
  assert.equal(ceremonyFacetSourceIds.has("choson-sinbo"), true, "원산갈마해안관광지구 준공식 should expose 조선신보 direct coverage");
  assert.equal(ceremonyOriginalSourceIds.has("kcna"), true, "KCNA Watch ceremony results should expose 조선중앙통신 as original-source provenance");
  assert.equal(ceremonyOriginalSourceIds.has("rodong-sinmun"), true, "KCNA Watch ceremony results should expose 로동신문 as original-source provenance");
  assert.equal(ceremonyOriginalSourceIds.has("voice-of-korea"), true, "KCNA Watch ceremony results should expose 조선의 소리 as original-source provenance");
  assert.equal(ceremonyPhysicalSourceIds.has("kcna-watch"), true, "원산갈마해안관광지구 준공식 should include KCNA Watch as a physical archive source");
  assert.equal(ceremonyPhysicalSourceIds.has("choson-sinbo"), true, "원산갈마해안관광지구 준공식 should include 조선신보 as a direct physical source");
  assert.equal(ceremonyPhysicalSourceIds.has("voice-of-korea"), true, "원산갈마해안관광지구 준공식 should include 조선의 소리 as a direct physical source when its official detail URL is known");
  assert.equal(spacedResult.total, result.total, "원산 갈마 should match the same production result count as 원산갈마");
  assert.deepEqual(spacedFacetCounts, resultFacetCounts, "원산 갈마 should preserve the same source-facet distribution as 원산갈마");
  assert.equal(englishWonsanResult.total >= result.total, true, "Wonsan should include at least the 원산갈마 production coverage and may include broader Wonsan-only records");
  assert.equal(englishKalmaResult.total >= result.total, true, "Kalma should include at least the 원산갈마 production coverage and may include broader English archive records");
  assertFacetSourcesInclude(englishWonsanFacetCounts, resultFacetCounts, "Wonsan should preserve the 원산갈마 source categories while allowing broader Wonsan-only coverage");
  assertFacetSourcesInclude(englishKalmaFacetCounts, resultFacetCounts, "Kalma should preserve the 원산갈마 source categories while allowing broader English archive records");
  assert.equal(personPlaceResult.documents.length > 0, true, "김정은 원산갈마 should find ceremony/site records containing both person and place terms");
  assert.equal(personPlaceResult.documents.every((document) => document.scoreReason?.startsWith("multi:")), true, "김정은 원산갈마 should use the strict multi-term matching path, not broad OR retrieval");
  assert.equal(englishPersonPlaceResult.total, personPlaceResult.total, "Kim Jong Un Wonsan Kalma should resolve to the same strict person/place coverage as 김정은 원산갈마");
  assert.equal(englishPersonPlaceResult.documents.every((document) => document.scoreReason?.startsWith("multi:")), true, "Kim Jong Un Wonsan Kalma should use strict multi-term matching after known-entity normalization");
  assert.equal(physicalSourceIds.has("kcna-watch"), true, "원산갈마 search should still include KCNA Watch archive coverage");
  assert.equal(physicalSourceIds.has("choson-sinbo"), true, "원산갈마 search should include 조선신보 direct coverage, not only KCNA Watch");
  assert.equal(resultFacetSourceIds.has("ryugyong"), true, "원산갈마 search should include 류경 image coverage");
  assert.equal(originalSourceIds.has("kcna"), true, "KCNA Watch archived 원산갈마 results should expose 조선중앙통신 as original-source provenance");
  assert.equal(originalSourceIds.has("rodong-sinmun"), true, "KCNA Watch archived 원산갈마 results should expose 로동신문 as original-source provenance");
  assert.equal(originalSourceIds.has("voice-of-korea"), true, "KCNA Watch archived 원산갈마 results should expose 조선의 소리 as original-source provenance");
}

async function assertArchiveOriginalSourceUrlsAreLinked(productionDocumentsText) {
  const officialRodong = {
    id: "fixture-rodong-original",
    title: "원산갈마해안관광지구 준공식 성대히 진행",
    snippet: "직접 원문",
    body: "직접 원문",
    date: "2025-06-26",
    sourceId: "rodong-sinmun",
    sourceName: "로동신문",
    sourceType: "official_site",
    mediaType: "article",
    url: "http://www.rodong.rep.kp/ko/index.php?fixture-original",
    archiveUrl: "",
    thumbnailUrl: "",
    language: "ko",
    aliases: [],
  };
  const archiveCopy = {
    id: "fixture-kcna-watch-copy",
    title: "원산갈마해안관광지구 준공식 성대히 진행",
    snippet: "보존본",
    body: "보존본",
    date: "2025-06-26",
    sourceId: "kcna-watch",
    sourceName: "KCNA Watch",
    sourceType: "archive",
    displaySourceId: "rodong-sinmun",
    displaySourceName: "로동신문",
    displaySourceType: "official_site",
    mediaType: "article",
    url: "https://kcnawatch.org/newstream/fixture",
    archiveUrl: "",
    originalSourceUrl: "",
    thumbnailUrl: "",
    language: "ko",
    aliases: [],
  };
  const linked = enrichArchiveOriginalSourceUrls([officialRodong, archiveCopy]);
  const linkedArchiveCopy = linked.find((document) => document.id === archiveCopy.id);
  const productionDocuments = parseJsonl(productionDocumentsText);
  const productionLinkedCopy = productionDocuments.find((document) => (
    document.sourceId === "kcna-watch"
    && document.displaySourceId === "rodong-sinmun"
    && /원산갈마해안관광지구 준공식/.test(document.title || "")
  ));

  assert.equal(linkedArchiveCopy?.originalSourceUrl, officialRodong.url, "KCNA Watch preserved copies should link to same-title official originals already in the index");
  assert.equal(Boolean(productionLinkedCopy?.originalSourceUrl), true, "production KCNA Watch preserved copies with matching direct originals should carry originalSourceUrl");
  assert.equal(/rodong\.rep\.kp/.test(productionLinkedCopy?.originalSourceUrl || ""), true, "linked KCNA Watch 로동신문 origin pills should open the indexed official Rodong URL");
}

function assertFacetCountsIncludeAtLeast(actualPairs, expectedPairs, message) {
  const actual = new Map(actualPairs);
  for (const [sourceId, expectedCount] of expectedPairs) {
    assert.equal(
      (actual.get(sourceId) || 0) >= expectedCount,
      true,
      `${message}: ${sourceId} expected at least ${expectedCount}, got ${actual.get(sourceId) || 0}`,
    );
  }
}

function assertFacetSourcesInclude(actualPairs, expectedPairs, message) {
  const actualSourceIds = new Set(actualPairs.map(([sourceId]) => sourceId));
  const missing = expectedPairs
    .map(([sourceId]) => sourceId)
    .filter((sourceId) => !actualSourceIds.has(sourceId));
  assert.deepEqual(missing, [], message);
}

async function assertProductionDocumentsDoNotIndexGenericNaenaraSections(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const genericNaenaraTitles = new Set(["첫페지", "소식, 기사", "조선개관", "경제, 무역", "사회문화"]);
  const genericNaenaraDocument = productionDocuments.find((document) => (
    document.sourceId === "naenara" && genericNaenaraTitles.has(document.title)
  ));

  assert.equal(genericNaenaraDocument, undefined, "내나라 section/navigation pages must not be indexed as article results");
}

async function assertProductionDocumentsIncludeNaenaraRows(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const naenaraDocuments = productionDocuments.filter((document) => document.sourceId === "naenara");

  assert.equal(naenaraDocuments.length > 0, true, "내나라 should contribute real readable-source article rows");
  assert.equal(naenaraDocuments.some((document) => /녀자축구선수|김정은/.test(document.title)), true, "내나라 documents should be real source-visible titles");
  assert.equal(
    naenaraDocuments.every((document) => /naenara\.com\.kp\/main\/index\/(?:ko|en|fr|sp|ge|ru|ch|ja|ar)\//.test(document.url)),
    true,
    "내나라 documents should point back to source-visible language pages",
  );
  assert.equal(
    naenaraDocuments.some((document) => document.url.includes("/tourism#") && /관광소식|Tourism News/.test(document.snippet)),
    true,
    "내나라 should include source-visible tourism rows from its topical pages",
  );
  assert.equal(
    naenaraDocuments.some((document) => document.thumbnailUrl && (document.body || "").length >= 500),
    true,
    "내나라 first-page feature records should include readable paragraph bodies when source-visible snapshots expose them",
  );
}

async function assertProductionDocumentsIncludeMinjuRows(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const minjuDocuments = productionDocuments.filter((document) => document.sourceId === "minju-choson");

  assert.equal(minjuDocuments.length >= 18, true, "민주조선 should index broad real listing coverage, not only a handful of fetched detail pages");
  assert.equal(minjuDocuments.some((document) => /룡문대굴|단천발전소|축전/.test(document.title)), true, "민주조선 should include source-visible recent-news and government-news rows");
  assert.equal(
    minjuDocuments.some((document) => document.mediaType === "image" && /원산갈마료리축전/.test(document.title) && /\/uploads\/photo\//i.test(document.url)),
    true,
    "민주조선 should index source-visible photo rows such as 원산갈마료리축전, not only article detail URLs",
  );
  assert.equal(
    minjuDocuments.every((document) => /minju\.rep\.kp\/Home\/index\/disp\/\d+\/ko/i.test(document.url) || /minju\.rep\.kp\/uploads\/photo\/\d{4}\/\d{2}\/[^?#]+\.(?:png|jpe?g|webp)$/i.test(document.url)),
    true,
    "민주조선 indexed documents should point to real article detail URLs or source-hosted photo assets",
  );
}

async function assertProductionDocumentsDoNotIndexUtilityPages(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const utilityPattern = /구독신청|사진프린트구입|日本語|privacy|copyright|contact/i;
  const utilityDocument = productionDocuments.find((document) => (
    ["choson-sinbo", "naenara"].includes(document.sourceId) && utilityPattern.test(`${document.title} ${document.url}`)
  ));
  const kcnaGenericTitles = new Set(["최신소식", "대외관계", "혁명일화", "world", "最新ニュース", "국제新闻", "조선중앙통신 | 기사", "KCNA | Article"]);
  const kcnaGenericDocument = productionDocuments.find((document) => (
    document.sourceId === "kcna" && kcnaGenericTitles.has(String(document.title || "").replace(/\s+/g, " ").trim())
  ));
  const kcnaCategoryListingDocument = productionDocuments.find((document) => (
    document.sourceId === "kcna"
    && /\/(?:kp|en|jp|cn|ru|sp|es)\/category\/articles\/q\//i.test(document.url || "")
    && !/^kcna-wonsan-kalma/i.test(document.id || "")
  ));

  assert.equal(utilityDocument, undefined, "utility/navigation pages must not be indexed as article results");
  assert.equal(kcnaGenericDocument, undefined, "KCNA category labels must not be indexed as article results");
  assert.equal(kcnaCategoryListingDocument, undefined, "KCNA category listing pages must not be indexed as article results");
}

async function assertFailedImportPreservesExistingDocuments() {
  const tempDir = await fs.mkdtemp(path.join(ROOT_DIR, "tmp-search-import-"));
  const documentsPath = path.join(tempDir, "documents.jsonl");
  const reportPath = path.join(tempDir, "report.json");
  const existingDocument = {
    id: "existing-real-document",
    title: "Existing Real Document",
    snippet: "Already imported real data.",
    date: "2026-05-19",
    sourceId: "kcna-watch",
    sourceName: "KCNA Watch",
    sourceType: "archive",
    mediaType: "article",
    url: "https://kcnawatch.org/existing",
    archiveUrl: "",
    thumbnailUrl: "",
    language: "en",
    aliases: [],
  };

  await fs.writeFile(documentsPath, `${JSON.stringify(existingDocument)}\n`, "utf8");
  await writeImportOutput({
    documents: [],
    sources: [],
    reports: [{ sourceId: "kcna-watch", errors: ["network timeout"] }],
    outputPath: documentsPath,
    reportPath,
  });

  assert.equal((await fs.readFile(documentsPath, "utf8")).includes("existing-real-document"), true, "failed empty imports should preserve existing non-empty document output");
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(report.preservedExistingDocuments, true, "preservation should be reported");

  const multiSourcePath = path.join(tempDir, "multi-source.documents.jsonl");
  const multiSourceReportPath = path.join(tempDir, "multi-source.report.json");
  const preservedSourceDocument = {
    ...existingDocument,
    id: "existing-korean-books-document",
    sourceId: "korean-books",
    sourceName: "조선의 출판물",
    url: "http://www.korean-books.com.kp/existing.pdf",
    mediaType: "pdf",
  };
  const freshSourceDocument = {
    ...existingDocument,
    id: "fresh-rodong-document",
    sourceId: "rodong-sinmun",
    sourceName: "로동신문",
    url: "http://www.rodong.rep.kp/fresh",
  };

  await fs.writeFile(multiSourcePath, `${JSON.stringify(preservedSourceDocument)}\n`, "utf8");
  await writeImportOutput({
    documents: [freshSourceDocument],
    sources: [],
    reports: [
      { sourceId: "rodong-sinmun", indexed: 1, errors: [] },
      { sourceId: "korean-books", indexed: 0, errors: ["HTTP 429"], preserveOnFailure: true },
    ],
    outputPath: multiSourcePath,
    reportPath: multiSourceReportPath,
  });

  const preservedRows = parseJsonl(await fs.readFile(multiSourcePath, "utf8"));
  const multiSourceReport = JSON.parse(await fs.readFile(multiSourceReportPath, "utf8"));
  assert.equal(preservedRows.some((document) => document.id === "fresh-rodong-document"), true, "multi-source import should keep successful current source documents");
  assert.equal(preservedRows.some((document) => document.id === "existing-korean-books-document"), true, "multi-source import should preserve failed source documents from the previous output");
  assert.deepEqual(multiSourceReport.preservedSourceIds, ["korean-books"], "per-source preservation should be reported");

  const mergePath = path.join(tempDir, "merge.documents.jsonl");
  const mergeReportPath = path.join(tempDir, "merge.report.json");
  const refreshedKoreanBook = { ...preservedSourceDocument, id: "fresh-korean-books-document" };
  await fs.writeFile(mergePath, [freshSourceDocument, preservedSourceDocument].map((document) => JSON.stringify(document)).join("\n"), "utf8");
  process.argv.push("--merge-existing-output");
  try {
    await writeImportOutput({
      documents: [refreshedKoreanBook],
      sources: [],
      reports: [{ sourceId: "korean-books", indexed: 1, errors: [] }],
      outputPath: mergePath,
      reportPath: mergeReportPath,
    });
  } finally {
    process.argv.splice(process.argv.lastIndexOf("--merge-existing-output"), 1);
  }
  const mergedRows = parseJsonl(await fs.readFile(mergePath, "utf8"));
  assert.equal(mergedRows.some((document) => document.id === "fresh-rodong-document"), true, "targeted merge should retain documents for untouched sources");
  assert.equal(mergedRows.some((document) => document.id === "fresh-korean-books-document"), true, "targeted merge should replace the refreshed source with current documents");
  assert.equal(mergedRows.some((document) => document.id === "existing-korean-books-document"), false, "targeted merge should drop stale documents for the refreshed source");

  const shrinkPath = path.join(tempDir, "shrink.documents.jsonl");
  const shrinkReportPath = path.join(tempDir, "shrink.report.json");
  const existingSecondKoreanBook = { ...preservedSourceDocument, id: "existing-korean-books-document-2", url: "http://www.korean-books.com.kp/existing-2.pdf" };
  await fs.writeFile(shrinkPath, [freshSourceDocument, preservedSourceDocument, existingSecondKoreanBook].map((document) => JSON.stringify(document)).join("\n"), "utf8");
  process.argv.push("--merge-existing-output");
  try {
    await writeImportOutput({
      documents: [refreshedKoreanBook],
      sources: [],
      reports: [{ sourceId: "korean-books", indexed: 1, errors: [] }],
      outputPath: shrinkPath,
      reportPath: shrinkReportPath,
    });
  } finally {
    process.argv.splice(process.argv.lastIndexOf("--merge-existing-output"), 1);
  }
  const shrinkGuardRows = parseJsonl(await fs.readFile(shrinkPath, "utf8"));
  const shrinkGuardReport = JSON.parse(await fs.readFile(shrinkReportPath, "utf8"));
  assert.equal(shrinkGuardRows.some((document) => document.id === "existing-korean-books-document"), true, "targeted partial refresh should preserve existing source rows when the current import shrinks coverage");
  assert.equal(shrinkGuardRows.some((document) => document.id === "existing-korean-books-document-2"), true, "targeted partial refresh should keep all existing source rows by default");
  assert.equal(shrinkGuardRows.some((document) => document.id === "fresh-korean-books-document"), true, "targeted partial refresh should merge current source rows with preserved existing coverage by default");
  assert.deepEqual(shrinkGuardReport.preservedSourceIds, ["korean-books"], "coverage-shrink preservation should be reported per source");

  const kcnaMergePath = path.join(tempDir, "kcna-merge.documents.jsonl");
  const staleKcnaCategoryDocument = {
    ...existingDocument,
    id: "kcna-stale-category-document",
    title: "Top News",
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    url: "http://www.kcna.kp/en/category/articles/q/5394b80bdae203fadef02522cfb578c0.kcmsf",
  };
  const freshKcnaArticleDocument = {
    ...staleKcnaCategoryDocument,
    id: "kcna-fresh-article-document",
    title: "Fresh KCNA Article",
    url: "http://www.kcna.kp/en/article/q/real.kcmsf",
  };
  await fs.writeFile(kcnaMergePath, JSON.stringify(staleKcnaCategoryDocument), "utf8");
  process.argv.push("--merge-existing-output");
  try {
    await writeImportOutput({
      documents: [freshKcnaArticleDocument],
      sources: [],
      reports: [{ sourceId: "kcna", indexed: 1, errors: [] }],
      outputPath: kcnaMergePath,
      reportPath: path.join(tempDir, "kcna-merge.report.json"),
    });
  } finally {
    process.argv.splice(process.argv.lastIndexOf("--merge-existing-output"), 1);
  }
  const kcnaMergeRows = parseJsonl(await fs.readFile(kcnaMergePath, "utf8"));
  assert.equal(kcnaMergeRows.some((document) => document.id === "kcna-fresh-article-document"), true, "targeted merge should keep fresh KCNA article documents");
  assert.equal(kcnaMergeRows.some((document) => document.id === "kcna-stale-category-document"), false, "targeted merge should not preserve stale KCNA category listing documents");

  process.argv.push("--merge-existing-output", "--allow-shrink-source");
  try {
    await writeImportOutput({
      documents: [refreshedKoreanBook],
      sources: [],
      reports: [{ sourceId: "korean-books", indexed: 1, errors: [] }],
      outputPath: shrinkPath,
      reportPath: shrinkReportPath,
    });
  } finally {
    process.argv.splice(process.argv.lastIndexOf("--allow-shrink-source"), 1);
    process.argv.splice(process.argv.lastIndexOf("--merge-existing-output"), 1);
  }
  const allowedShrinkRows = parseJsonl(await fs.readFile(shrinkPath, "utf8"));
  assert.equal(allowedShrinkRows.some((document) => document.id === "fresh-korean-books-document"), true, "explicit shrink override should allow a smaller successful source refresh to replace old rows");
  assert.equal(allowedShrinkRows.some((document) => document.id === "existing-korean-books-document-2"), false, "explicit shrink override should remove old rows from the refreshed source");

  await fs.rm(tempDir, { recursive: true, force: true });
}

async function assertImportPipelineHasRuntimeGuards() {
  const [crawlerSource, importIndexSource, smokeCrawlerSource, preflightSource, packageJson, readme] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "scripts/search-crawler-utils.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/import-search-index.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/smoke-search-crawl.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/preflight-search-release.ts"), "utf8"),
    readJson(path.join(ROOT_DIR, "package.json")),
    fs.readFile(path.join(ROOT_DIR, "README.md"), "utf8"),
  ]);

  assert.equal(crawlerSource.includes("maxSourceMs"), true, "crawler should expose a per-source runtime budget for production workers and CI");
  assert.equal(crawlerSource.includes("source time budget exceeded"), true, "crawler should report when a source hits its runtime budget");
  assert.equal(crawlerSource.includes("withTimeout(fetch(url"), true, "network fetches should race an explicit timeout instead of trusting DNS/socket aborts");
  assert.equal(crawlerSource.includes("getReadableTimeoutMs"), true, "readable fallback fetches should respect shortened source-deadline timeouts");
  assert.equal(crawlerSource.includes("shouldBypassProxyForReadableUrl"), true, "readable fallback mirror requests should not burn DPRK proxy time when a proxy is configured");
  assert.equal(crawlerSource.includes("shouldAllowProxyDirectFallback"), true, "crawler should recover when the configured proxy itself is reachable but cannot reach a DPRK source host");
  assert.equal(crawlerSource.includes("--no-proxy-direct-fallback"), true, "crawler should expose an opt-out for proxy direct fallback in strictly proxied environments");
  assert.equal(crawlerSource.includes("detailSeedUrls"), true, "crawler should support source-visible priority detail URLs for high-value archive/original-source records");
  assert.equal(crawlerSource.includes("forceDetailFetch"), true, "priority detail URLs should be able to fetch details even on listing-first sources");
  assert.equal(crawlerSource.includes("enrichPdfDocumentWithReadableText"), true, "crawler should enrich source PDF records with readable text when configured");
  assert.equal(crawlerSource.includes("maxPdfTextFetchesPerSource"), true, "crawler should cap expensive source-readable PDF extraction separately from ordinary detail pages");
  assert.equal(crawlerSource.includes("pdfTextFetchLimitFallbacks"), true, "crawler should report metadata-preserved PDF records when readable PDF extraction is capped");
  assert.equal(crawlerSource.includes("inferKcnaWatchReadableDisplaySourceFields"), true, "KCNA Watch readable details should infer original-source provenance from Source metadata lines");
  assert.equal(importIndexSource.includes('"--max-source-ms"'), true, "top-level import pipeline should forward per-source runtime budgets to importers");
  assert.equal(importIndexSource.includes('getArgumentValue("--source")'), true, "top-level import pipeline should support targeted source refreshes");
  assert.equal(importIndexSource.includes('"--merge-existing-output"'), true, "top-level targeted official-site refreshes should preserve untouched official-site import rows");
  assert.equal(importIndexSource.includes('"--allow-shrink-source"'), true, "top-level targeted official-site refreshes should expose an explicit coverage-shrink override");
  assert.equal(importIndexSource.includes("timedOut"), true, "source health should preserve timed-out source status for operations");
  assert.equal(packageJson.scripts["preflight:search"], "node scripts/preflight-search-release.ts", "package scripts should expose the non-mutating search release preflight");
  assert.equal(packageJson.scripts["smoke:search-crawl"], "node scripts/smoke-search-crawl.ts", "package scripts should expose the non-mutating live crawler smoke check");
  assert.equal(preflightSource.includes("smoke:search-crawl"), true, "search release preflight should include a live crawler smoke gate by default");
  assert.equal(preflightSource.includes("--skip-smoke"), true, "search release preflight should allow offline CI to skip the live network smoke gate");
  assert.equal(preflightSource.includes("test:search"), true, "search release preflight should run correctness regression tests by default");
  assert.equal(preflightSource.includes("--skip-tests"), true, "search release preflight should allow explicit fast storage-only checks when needed");
  assert.equal(preflightSource.includes('DEFAULT_SMOKE_SOURCE_IDS = ["kcna", "rodong-sinmun", "voice-of-korea"]'), true, "search release preflight should smoke a representative official-source panel by default");
  assert.equal(preflightSource.includes("--all-official-sites"), true, "search release preflight should expose a full official-site importer smoke panel for production refreshes");
  assert.equal(preflightSource.includes('source.crawler?.importer === "official-sites"'), true, "search release preflight should derive full live-smoke panels from the source catalog instead of duplicating the list");
  assert.equal(preflightSource.includes('"--sources"'), true, "search release preflight should forward multi-source live smoke coverage");
  assert.equal(preflightSource.includes("validate:search"), true, "search release preflight should validate indexed storage");
  assert.equal(preflightSource.includes("seed:search"), true, "search release preflight should build the Meilisearch seed payload");
  assert.equal(preflightSource.includes("audit:search"), true, "search release preflight should run the production coverage audit");
  assert.equal(preflightSource.includes("sync:meilisearch"), true, "search release preflight should dry-run the Meilisearch sync payload");
  assert.equal(preflightSource.includes("--dry-run"), true, "search release preflight must not mutate Meilisearch");
  assert.equal(smokeCrawlerSource.includes("import:official-sites"), true, "crawler smoke check should exercise the real official-site importer");
  assert.equal(smokeCrawlerSource.includes("--min-documents"), true, "crawler smoke check should fail when a live source returns too few real documents");
  assert.equal(smokeCrawlerSource.includes('DEFAULT_SMOKE_SOURCE_IDS = ["kcna", "rodong-sinmun", "voice-of-korea"]'), true, "crawler smoke should cover multiple key official sources unless explicitly narrowed");
  assert.equal(smokeCrawlerSource.includes("--all-official-sites"), true, "crawler smoke should support a full official-site importer panel for production refreshes");
  assert.equal(smokeCrawlerSource.includes('source.crawler?.importer === "official-sites"'), true, "crawler smoke should derive full official-site panels from the source catalog");
  assert.equal(smokeCrawlerSource.includes('getArgumentValue("--source") || getArgumentValue("--sources")'), true, "crawler smoke should accept both --source and --sources source panels");
  assert.equal(smokeCrawlerSource.includes("for (const sourceId of sourceIds)"), true, "crawler smoke should validate every selected source independently");
  assert.equal(smokeCrawlerSource.includes("Source ${sourceId} expected at least"), true, "crawler smoke should fail when any selected source returns too few real records");
  assert.equal(smokeCrawlerSource.includes("isNonBlockingSmokeError"), true, "crawler smoke should keep planned source-budget limits as warnings once a source imports enough real records");
  assert.equal(smokeCrawlerSource.includes("source time budget exceeded"), true, "crawler smoke should classify source time-budget warnings consistently with production source health");
  assert.equal(smokeCrawlerSource.includes("--keep-output"), true, "crawler smoke check should keep temporary artifacts only when requested");
  assert.equal(smokeCrawlerSource.includes("--proxy"), true, "crawler smoke check should support the same proxy path as production imports");
  assert.equal(smokeCrawlerSource.includes("mkdtemp"), true, "crawler smoke check should use temporary output by default instead of mutating the checked-in index");
  assert.equal(crawlerSource.includes("--allow-shrink-source"), true, "targeted source refreshes should guard against accidental coverage shrinkage unless explicitly allowed");
  assert.equal(readme.includes("--max-source-ms"), true, "README should document the crawler runtime budget knob");
  assert.equal(readme.includes("preflight:search"), true, "README should document the search release preflight command");
  assert.equal(readme.includes("smoke:search-crawl"), true, "README should document the non-mutating crawler smoke check");
  assert.equal(readme.includes("--sources kcna,rodong-sinmun,voice-of-korea"), true, "README should document multi-source crawler smoke panels");
  assert.equal(readme.includes("--all-official-sites"), true, "README should document full official-site importer smoke panels");
  assert.equal(readme.includes("by default the live smoke checks KCNA, 로동신문, and 조선의 소리"), true, "README should explain the representative default preflight smoke panel");
  assert.equal(readme.includes("source-budget warnings"), true, "README should document that planned source-budget smoke warnings do not fail a live source check after successful indexing");
  assert.equal(readme.includes("--no-proxy-direct-fallback"), true, "README should document the proxy direct fallback knob");
  assert.equal(readme.includes("automatically passes `--merge-existing-output`"), true, "README should document safe top-level targeted source refresh behavior");
}

async function assertSourceCatalogMatchesGoal() {
  const expectedSourceIds = [
    "rodong-sinmun",
    "kcna",
    "voice-of-korea",
    "minju-choson",
    "ryugyong",
    "naenara",
    "choson-sinbo",
    "korean-books",
    "kcna-watch",
    "koryo-vod",
    "youtube",
  ];
  assert.deepEqual(SEARCH_SOURCES.map((source) => source.id), expectedSourceIds, "source catalog must match the requested portal scope");
  assert.equal(SEARCH_SOURCES.some((source) => source.id === "bboggugi-tv" || source.id === "kctv-archive"), false, "non-requested mock-era sources must not remain");
  const naenaraSource = SEARCH_SOURCES.find((source) => source.id === "naenara");
  assert.equal(naenaraSource?.languages.includes("ar"), true, "내나라 foreign-language scope should include Arabic");
  assert.equal(naenaraSource?.crawler?.seedUrls?.some((url) => url.includes("/main/index/ch/first")), true, "내나라 Chinese seed should use the current source-visible /ch/ path");
  assert.equal(naenaraSource?.crawler?.seedUrls?.some((url) => url.includes("/main/index/ge/first")), true, "내나라 German seed should use the current source-visible /ge/ path");
  assert.equal(naenaraSource?.crawler?.seedUrls?.some((url) => url.includes("/main/index/ar/first")), true, "내나라 Arabic seed should be crawled");
  assert.equal(naenaraSource?.crawler?.seedUrls?.some((url) => url.includes("/main/index/ko/tourism")), true, "내나라 Korean tourism rows should be crawled as source-visible topical coverage");
  assert.equal(naenaraSource?.crawler?.seedUrls?.some((url) => url.includes("/main/index/en/tourism")), true, "내나라 English tourism rows should be crawled as source-visible topical coverage");
  assert.equal((naenaraSource?.crawler?.maxDiscoveryPages || 0) <= 24, true, "내나라 should stay on seeded source-visible pages instead of crawling broad navigation pages that trigger rate limits");
  assert.equal(Array.isArray(naenaraSource?.crawler?.discoverUrlPatterns), true, "내나라 should restrict followed discovery links to seeded news/first/tourism sections");
  const minjuSource = SEARCH_SOURCES.find((source) => source.id === "minju-choson");
  assert.equal((minjuSource?.crawler?.maxDiscoveryPages || 0) >= 12, true, "민주조선 should crawl source-visible category pages, not only the front page");
  assert.equal(minjuSource?.crawler?.includeUrlPatterns?.some((pattern) => String(pattern).includes("uploads") && String(pattern).includes("photo")), true, "민주조선 should index source-hosted photo rows exposed on its media pages");
  const ryugyongSource = SEARCH_SOURCES.find((source) => source.id === "ryugyong");
  assert.equal((ryugyongSource?.crawler?.generatedListingPages || 0) >= 30, true, "류경 should generate enough photo/movie listing pages to approach the source-visible media catalog, not only the first screen");
  assert.deepEqual(ryugyongSource?.crawler?.listingSections || [], ["photo", "movie"], "류경 generated listing coverage should include both photo and movie pages");
  assert.deepEqual(ryugyongSource?.crawler?.listingLanguages || [], ["ko", "en"], "류경 generated listing coverage should include Korean and English source-visible pages");
  assert.deepEqual(ryugyongSource?.languages || [], ["ko", "en"], "류경 source metadata should declare every indexed language from generated listing pages");
  assert.equal((ryugyongSource?.crawler?.limitPerSource || 0) >= 300, true, "류경 production crawl should keep broad media coverage instead of capping near the first listing pages");
  assert.equal((ryugyongSource?.crawler?.maxDiscoveryPages || 0) >= 70, true, "류경 should have enough discovery-page budget for generated photo/movie listing pages");
  const rodongSource = SEARCH_SOURCES.find((source) => source.id === "rodong-sinmun");
  assert.equal(rodongSource?.crawler?.cacheFirstReadable, true, "로동신문 should reuse readable snapshots before slow source refreshes consume the crawl budget");
  assert.equal((rodongSource?.crawler?.requestDelayMs || 0) >= 1200, true, "로동신문 detail fetches should be paced enough for stable readable-body coverage");
  assert.equal((rodongSource?.crawler?.maxDetailFetchesPerSource || 0) >= 220, true, "로동신문 should fetch enough detail pages to avoid mostly title/date fallbacks");
  assert.equal(
    rodongSource?.crawler?.detailSeedUrls?.some((seed) => String(seed.url || seed).includes("OEAyMDI1LTA3LTAyLTAxOEAxOUBA7JuQ7IKw6rCI66eIQDExMDY==")),
    true,
    "로동신문 should promote source-visible Wonsan Kalma detail URLs before broad search-result fallback cards",
  );
  const vokSource = SEARCH_SOURCES.find((source) => source.id === "voice-of-korea");
  const kcnaSource = SEARCH_SOURCES.find((source) => source.id === "kcna");
  assert.equal((kcnaSource?.crawler?.limitPerSource || 0) >= 260, true, "조선중앙통신 should crawl beyond the old 180-document ceiling for KCNA Watch-level source breadth");
  assert.equal((kcnaSource?.crawler?.maxDetailFetchesPerSource || 0) >= 260, true, "조선중앙통신 should fetch enough article detail pages to keep broad official KCNA coverage");
  assert.equal((kcnaSource?.crawler?.maxLinksPerSource || 0) >= 420, true, "조선중앙통신 should discover enough category/article links before applying the detail fetch cap");
  assert.equal((kcnaSource?.crawler?.maxDiscoveryPages || 0) >= 30, true, "조선중앙통신 should follow enough source-visible category listing pages for broad coverage");
  assert.equal(vokSource?.baseUrl?.startsWith("http://www.vok.rep.kp/"), true, "조선의 소리 should prefer the faster source-visible http route for readable fallback snapshots");
  assert.equal(vokSource?.crawler?.preferListingDocuments, false, "조선의 소리 should attempt detail bodies and fall back to source-visible listing rows when detail pages are slow or empty");
  assert.equal(vokSource?.crawler?.cacheFirstReadable, true, "조선의 소리 should reuse readable snapshots before slow source refreshes consume the crawl budget");
  assert.equal(vokSource?.crawler?.detailSeedUrls?.some((seed) => String(seed.url || seed).includes("ikn250625008/ko")), true, "조선의 소리 should promote known official Wonsan Kalma ceremony detail URLs into source-visible priority seeds");
  assert.equal((vokSource?.crawler?.timeoutMs || 0) <= 11000, true, "조선의 소리 per-request timeout should keep one slow language listing from starving the crawl");
  assert.equal(vokSource?.crawler?.maxLinksPerDiscoveryPage, 220, "조선의 소리 discovery should read deep source-visible listing rows instead of only the newest screenful");
  assert.equal((vokSource?.crawler?.limitPerSource || 0) >= 320, true, "조선의 소리 production crawl should keep enough listing documents for topic coverage beyond same-day news");
  assert.equal((vokSource?.crawler?.maxDiscoveryPages || 0) >= 40, true, "조선의 소리 should crawl the configured culture/tourism/video listing pages, not only the first news queues");
  assert.equal(vokSource?.crawler?.seedUrls?.some((url) => url.includes("/Colist/newslist/18/en")), true, "조선의 소리 English coverage should use current source-visible Colist listings");
  assert.equal(vokSource?.crawler?.seedUrls?.some((url) => url.includes("/Colist/revolist/36/sp")), true, "조선의 소리 Spanish coverage should use current source-visible Colist listings");
  assert.equal(vokSource?.crawler?.seedUrls?.some((url) => url.includes("/Colist/revolist/36/ge")), true, "조선의 소리 German revolutionary-activity coverage should use current source-visible Colist listings");
  assert.equal(vokSource?.crawler?.seedUrls?.some((url) => url.includes("/Colist/plist/57/ko")), true, "조선의 소리 Korean society/culture listing pages should be crawled for topical coverage");
  assert.equal(vokSource?.crawler?.seedUrls?.some((url) => url.includes("/Colist/cscdlist/69/10/ko")), true, "조선의 소리 tourism/culture card listings should be crawled as source-visible records");
  assert.equal(vokSource?.crawler?.seedUrls?.some((url) => url.includes("/Colist/vscdlist/87/17/ko")), true, "조선의 소리 video subcategory listings should be crawled as source-visible records");
  assert.equal(vokSource?.crawler?.seedUrls?.some((url) => url.includes("/Colist/holist/94/ko")), true, "조선의 소리 guide listings should be crawled for non-news source breadth");
  assert.equal(vokSource?.crawler?.seedUrls?.some((url) => url.includes("/home/index/")), false, "조선의 소리 should avoid unstable home language seeds that produce crawler health errors");
  const koreanBooksSource = SEARCH_SOURCES.find((source) => source.id === "korean-books");
  assert.equal(koreanBooksSource?.crawler?.fetchPdfText, true, "조선의 출판물 should enrich PDF records with source-readable text, not only title/URL metadata");
  assert.equal(koreanBooksSource?.crawler?.maxPdfTextFetchesPerSource, 8, "조선의 출판물 should cap expensive readable PDF fetches while preserving broad PDF metadata coverage");
  assert.equal(koreanBooksSource?.crawler?.detailSeedUrls?.some((seed) => String(seed.url || seed).includes("20250703115805.pdf")), true, "조선의 출판물 should promote the Wonsan Kalma guide PDF into source-visible priority seeds");
  assert.equal(koreanBooksSource?.crawler?.detailSeedUrls?.some((seed) => String(seed.url || seed).includes("20260413105243.pdf")), true, "조선의 출판물 should promote the Wonsan Kalma coastal tourist area PDF into source-visible priority seeds");
  const configuredBackfillSourceIds = SEARCH_SOURCES
    .filter((source) => Array.isArray(source.crawler?.backfillDocuments) && source.crawler.backfillDocuments.length > 0)
    .map((source) => source.id);
  assert.deepEqual(configuredBackfillSourceIds, [], "production source catalog should not ship configured backfillDocuments; use crawler discovery and source-visible seed URLs instead");
  for (const seedUrl of KCNA_WONSAN_KALMA_CATEGORY_SEED_URLS) {
    assert.equal(kcnaSource?.crawler?.seedUrls?.includes(seedUrl), true, `KCNA should discover Wonsan Kalma ceremony coverage from source-visible paginated listings: ${seedUrl}`);
  }
  assert.equal(
    kcnaSource?.crawler?.detailSeedUrls?.some((seed) => String(seed.url || seed).includes("ae3d0eb9cfe8dcd1cfb706a70acfaa0f2a339be80aceaeaf7192c1713ecd8235")),
    true,
    "KCNA should promote source-visible Wonsan Kalma service-start detail URLs before broad category discovery",
  );
  const kcnaWatchSource = SEARCH_SOURCES.find((source) => source.id === "kcna-watch");
  assert.equal(
    kcnaWatchSource?.crawler?.detailSeedUrls?.some((seed) => String(seed?.url || seed || "").includes("tourist-attraction-on-east-coast")),
    true,
    "KCNA Watch should fetch source-visible Wonsan Kalma preserved detail pages before broad archive discovery",
  );

  const indexedSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));
  assert.deepEqual(indexedSources.map((source) => source.id), expectedSourceIds, "indexed source names must match the requested portal scope");
  for (const configuredSource of SEARCH_SOURCES) {
    const indexedSource = indexedSources.find((source) => source.id === configuredSource.id);
    assert.equal(indexedSource?.name, configuredSource.name, `${configuredSource.id} indexed source name should match sourceConfig`);
    assert.equal(indexedSource?.baseUrl, configuredSource.baseUrl, `${configuredSource.id} indexed source baseUrl should match sourceConfig`);
    assert.deepEqual(indexedSource?.languages || [], configuredSource.languages || [], `${configuredSource.id} indexed source languages should match sourceConfig`);
    assert.deepEqual(indexedSource?.mediaTypes, configuredSource.mediaTypes, `${configuredSource.id} indexed source mediaTypes should match sourceConfig`);
    assert.deepEqual(indexedSource?.aliases || [], configuredSource.aliases || [], `${configuredSource.id} indexed source aliases should match sourceConfig`);
    assert.equal(indexedSource?.crawler?.enabled, configuredSource.crawler?.enabled, `${configuredSource.id} indexed source should keep crawler enabled state`);
    assert.equal(indexedSource?.crawler?.strategy, configuredSource.crawler?.strategy, `${configuredSource.id} indexed source should keep crawler strategy`);
    assert.equal(indexedSource?.crawler?.schedule, configuredSource.crawler?.schedule, `${configuredSource.id} indexed source should keep crawler schedule`);
  }
}

async function assertYouTubeMetadataImporterIsScoped() {
  const packageJson = await readJson(path.join(ROOT_DIR, "package.json"));
  const [importer, importIndex, readme] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "scripts/import-youtube-metadata.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/import-search-index.ts"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "README.md"), "utf8"),
  ]);

  assert.equal(packageJson.scripts["import:youtube-metadata"], "node scripts/import-youtube-metadata.ts", "package scripts should expose the scoped YouTube metadata importer");
  assert.equal(importIndex.includes("import:youtube-metadata"), true, "production import pipeline should run the scoped YouTube metadata importer");
  assert.equal(SEARCH_SOURCE_TYPES.includes("youtube"), false, "schema validation must reject YouTube as an out-of-scope source type");
  assert.equal(importer.includes("feeds/videos.xml"), true, "YouTube importer should use public channel RSS metadata");
  assert.equal(importer.includes("source.crawler?.channels"), true, "YouTube importer should merge multiple channel feeds into one YouTube source");
  assert.equal(importer.includes("mediaType: \"video\""), true, "YouTube importer should add video-search records only");
  assert.equal(readme.includes("메아리/supersuhui"), true, "README should document the scoped YouTube channel source");
  assert.equal(readme.includes("all indexed video documents appear in both 전체 and 동영상"), true, "README should document that video records appear in 전체 and 동영상");
  assert.equal(readme.includes("YouTube metadata is intentionally not part"), false, "README must not contradict the production YouTube source scope");
}

async function assertProductionDocumentsStayInsideConfiguredSources(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const indexedSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));
  const validation = validateSearchIndex(productionDocuments, indexedSources);
  const sourceById = new Map(indexedSources.map((source) => [source.id, source]));

  assert.deepEqual(validation.errors, [], "production search index should pass source/domain/media validation");

  for (const document of productionDocuments) {
    const source = sourceById.get(document.sourceId);
    assert.notEqual(source, undefined, `${document.id} should use a configured source`);
    assert.equal(urlMatchesSourceHost(document.url, source), true, `${document.id} URL should stay inside ${source.baseUrl}`);
    if (document.archiveUrl) {
      assert.equal(urlMatchesSourceHost(document.archiveUrl, source), true, `${document.id} archiveUrl should stay inside ${source.baseUrl}`);
    }
  }

  const koreanBooksDocuments = productionDocuments.filter((document) => document.sourceId === "korean-books");
  assert.equal(koreanBooksDocuments.length >= 24, true, "조선의 출판물 should contribute broad indexed 문헌/PDF coverage");
  assert.equal(koreanBooksDocuments.every((document) => document.mediaType === "pdf"), true, "조선의 출판물 production records should be 문헌/PDF only");
  assert.equal(koreanBooksDocuments.every((document) => /\.pdf(?:$|[?#])/i.test(document.url)), true, "조선의 출판물 production records should link directly to PDF files");
  assert.equal(koreanBooksDocuments.some((document) => document.title.includes("룡문대굴")), true, "조선의 출판물 should index newly discovered tourist-publication PDFs");
  assert.equal(koreanBooksDocuments.some((document) => document.title.includes("원산갈마해안관광지구")), true, "조선의 출판물 should index Wonsan Kalma PDF publications");
  assert.equal(koreanBooksDocuments.some((document) => document.title.includes("원산갈마해안관광지구안내") && /Wonsan Kalma Tour Information Office|명사십리휴양구역/.test(document.body || "")), true, "조선의 출판물 Wonsan Kalma guide PDF should include extracted searchable PDF text");

  const invalidCrossSource = validateSearchIndex([
    {
      id: "fixture-cross-source-document",
      title: "Cross source document",
      snippet: "This intentionally points to the wrong host.",
      date: "2026-05-19",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      sourceType: "official_site",
      mediaType: "article",
      url: "https://example.com/not-kcna",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "en",
      aliases: [],
    },
  ], indexedSources);

  assert.equal(
    invalidCrossSource.errors.some((error) => error.includes("outside configured source domain")),
    true,
    "index validation should reject documents outside their configured source domain",
  );
}

async function assertSourceHealthCoversCatalog() {
  const healthPath = path.join(ROOT_DIR, "data/search/source-health.json");
  const health = await readJson(healthPath);
  const expectedSourceIds = SEARCH_SOURCES.map((source) => source.id);

  assert.deepEqual(health.sources.map((source) => source.sourceId), expectedSourceIds, "source health should cover every configured source in order");
  assert.equal(health.summary.totalSources, expectedSourceIds.length, "source health summary should report all configured sources");
  assert.equal(health.summary.searchableSources, health.sources.filter((source) => source.indexedDocuments > 0).length, "source health should distinguish searchable sources from clean healthy sources");
  assert.equal(health.summary.healthySources, health.sources.filter((source) => source.status === "indexed").length, "source health healthySources should only count clean indexed sources");
  assert.equal(health.summary.warningSources, health.sources.filter((source) => source.status === "indexed_with_warnings").length, "source health should count indexed sources with current import warnings");
  assert.equal(health.summary.unreachableSources, health.sources.filter((source) => source.status === "unreachable").length, "source health should count unreachable sources from status");
  assert.equal(Number.isInteger(health.summary.totalDocuments), true, "source health should include total document count");
  assert.equal("discoveryFetched" in health.sources[0], true, "source health should include discovery fetch counts");
  assert.equal("apiFetched" in health.sources[0], true, "source health should include API/list fetch diagnostics");
  assert.equal("sitemapFetched" in health.sources[0], true, "source health should include sitemap fetch diagnostics");
  assert.equal("searchFetched" in health.sources[0], true, "source health should include source-search fetch diagnostics");
  assert.equal("robotsDisallowed" in health.sources[0], true, "source health should include robots-disallowed diagnostics");
  assert.equal("robotsWarning" in health.sources[0], true, "source health should include robots warning diagnostics");
  assert.equal("warnings" in health.sources[0], true, "source health should include non-blocking warning diagnostics");
  assert.equal("maxDetailFetchesPerSource" in health.sources[0], true, "source health should include configured detail-fetch caps");
  assert.equal("maxPdfTextFetchesPerSource" in health.sources[0], true, "source health should include configured PDF text extraction caps");
  assert.equal("detailFetchLimitFallbacks" in health.sources[0], true, "source health should include listing fallback counts caused by detail-fetch caps");
  assert.equal("pdfTextFetchLimitFallbacks" in health.sources[0], true, "source health should include metadata fallback counts caused by PDF text extraction caps");

  const chosonSinbo = health.sources.find((source) => source.sourceId === "choson-sinbo");
  const kcnaWatch = health.sources.find((source) => source.sourceId === "kcna-watch");
  const koryoVod = health.sources.find((source) => source.sourceId === "koryo-vod");
  assert.equal(chosonSinbo?.status, "indexed", "조선신보 WordPress API imports should be clean when the live API is reachable");
  assert.deepEqual(chosonSinbo?.warnings || [], [], "조선신보 should not keep redundant feed/sitemap discovery failures once WordPress API content is available");
  assert.equal(kcnaWatch?.status, "indexed", "KCNA Watch should use reachable sitemap and detail-fetch settings cleanly enough to count as healthy");
  assert.equal((kcnaWatch?.warnings || []).some((warning) => warning.includes("sitemap")), false, "KCNA Watch should not keep dead sitemap URLs in the production crawl config");
  assert.equal((kcnaWatch?.warnings || []).some((warning) => warning.includes("detail fetch limit reached")), false, "KCNA Watch should fetch enough detail pages to avoid relying mostly on capped listing fallbacks");
  assert.equal(kcnaWatch?.timedOut, false, "KCNA Watch should finish through controlled detail-fetch fallback instead of timing out");
  assert.equal(koryoVod?.status, "indexed", "Koryo API imports should be clean when the live API is reachable");
  assert.equal(koryoVod?.preservedExistingDocuments, false, "Koryo API imports should not report preserved documents after a successful live import");
}

async function assertProductionAuditPasses() {
  const audit = await auditSearchProductionBundle();
  const packageJson = await readJson(path.join(ROOT_DIR, "package.json"));
  const readme = await fs.readFile(path.join(ROOT_DIR, "README.md"), "utf8");
  const tempDir = await fs.mkdtemp(path.join(ROOT_DIR, "tmp-search-audit-"));

  try {
    const seedFixture = await buildSearchSeed();
    const cloneSeedFixture = () => JSON.parse(JSON.stringify(seedFixture));
    const staleSeedPath = path.join(tempDir, "stale-seed.json");
    const seed = cloneSeedFixture();
    seed.documents = seed.documents.map((document, index) => index === 0
      ? { ...document, id: `${document.id}-stale`, visibleTabs: ["video"], integratedRank: 9 }
      : document);
    await fs.writeFile(staleSeedPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
    const staleAudit = await auditSearchProductionBundle({ seedPath: staleSeedPath });
    const staleSeedContentPath = path.join(tempDir, "stale-seed-content.json");
    const staleContentSeed = cloneSeedFixture();
    staleContentSeed.documents = staleContentSeed.documents.map((document, index) => index === 0
      ? { ...document, title: `${document.title} stale` }
      : document);
    await fs.writeFile(staleSeedContentPath, `${JSON.stringify(staleContentSeed, null, 2)}\n`, "utf8");
    const staleContentAudit = await auditSearchProductionBundle({ seedPath: staleSeedContentPath });
    const stalePreviewSeedPath = path.join(tempDir, "stale-preview-provenance-seed.json");
    const stalePreviewSeed = cloneSeedFixture();
    const previewDocumentIndex = stalePreviewSeed.documents.findIndex((document) => document.previewText);
    assert.equal(previewDocumentIndex >= 0, true, "fixture seed should include enriched preview text");
    stalePreviewSeed.documents = stalePreviewSeed.documents.map((document, index) => index === previewDocumentIndex
      ? { ...document, previewSourceName: "", previewDocumentId: "" }
      : document);
    await fs.writeFile(stalePreviewSeedPath, `${JSON.stringify(stalePreviewSeed, null, 2)}\n`, "utf8");
    const stalePreviewAudit = await auditSearchProductionBundle({ seedPath: stalePreviewSeedPath });
    const staleYoutubeSeedPath = path.join(tempDir, "stale-youtube-seed.json");
    const staleYoutubeSeed = cloneSeedFixture();
    staleYoutubeSeed.documents = staleYoutubeSeed.documents.map((document) => document.sourceId === "youtube"
      ? { ...document, visibleTabs: ["video"] }
      : document);
    await fs.writeFile(staleYoutubeSeedPath, `${JSON.stringify(staleYoutubeSeed, null, 2)}\n`, "utf8");
    const staleYoutubeAudit = await auditSearchProductionBundle({ seedPath: staleYoutubeSeedPath });
    const duplicateSettingsSeedPath = path.join(tempDir, "duplicate-settings-seed.json");
    const duplicateSettingsSeed = cloneSeedFixture();
    duplicateSettingsSeed.settings.documents.filterableAttributes = [
      ...duplicateSettingsSeed.settings.documents.filterableAttributes,
      "visibleTabs",
    ];
    await fs.writeFile(duplicateSettingsSeedPath, `${JSON.stringify(duplicateSettingsSeed, null, 2)}\n`, "utf8");
    const duplicateSettingsAudit = await auditSearchProductionBundle({ seedPath: duplicateSettingsSeedPath });
    const weakBackendFilterSeedPath = path.join(tempDir, "weak-backend-filter-seed.json");
    const weakBackendFilterSeed = cloneSeedFixture();
    weakBackendFilterSeed.settings.documents.filterableAttributes = weakBackendFilterSeed.settings.documents.filterableAttributes
      .filter((attribute) => !["sourceId", "language", "mediaType"].includes(attribute));
    weakBackendFilterSeed.settings.documents.displayedAttributes = weakBackendFilterSeed.settings.documents.displayedAttributes
      .filter((attribute) => !["sourceId", "displaySourceName"].includes(attribute));
    weakBackendFilterSeed.settings.documents.distinctAttribute = "";
    await fs.writeFile(weakBackendFilterSeedPath, `${JSON.stringify(weakBackendFilterSeed, null, 2)}\n`, "utf8");
    const weakBackendFilterAudit = await auditSearchProductionBundle({ seedPath: weakBackendFilterSeedPath });
    const staleHealthPath = path.join(tempDir, "stale-health.json");
    const health = await readJson(path.join(ROOT_DIR, "data/search/source-health.json"));
    health.sources[0].status = "indexed_with_warnings";
    delete health.sources[0].robotsDisallowed;
    delete health.sources[0].robotsWarning;
    delete health.sources[0].warnings;
    health.summary.healthySources = health.summary.totalSources;
    health.summary.warningSources = 0;
    await fs.writeFile(staleHealthPath, `${JSON.stringify(health, null, 2)}\n`, "utf8");
    const staleHealthAudit = await auditSearchProductionBundle({ healthPath: staleHealthPath });
    const missingSourceDocumentsPath = path.join(tempDir, "missing-source-documents.jsonl");
    const productionDocuments = parseJsonl(await fs.readFile(PRODUCTION_DOCUMENTS_PATH, "utf8"));
    const missingSourceDocuments = productionDocuments.filter((document) => document.sourceId !== "voice-of-korea");
    await fs.writeFile(missingSourceDocumentsPath, stringifyJsonl(missingSourceDocuments), "utf8");
    const missingSourceHealthPath = path.join(tempDir, "missing-source-health.json");
    const missingSourceHealth = await readJson(path.join(ROOT_DIR, "data/search/source-health.json"));
    const missingSourceHealthEntry = missingSourceHealth.sources.find((source) => source.sourceId === "voice-of-korea");
    missingSourceHealthEntry.indexedDocuments = 0;
    missingSourceHealthEntry.importedThisRun = 0;
    missingSourceHealthEntry.status = "empty";
    missingSourceHealth.summary.searchableSources -= 1;
    missingSourceHealth.summary.healthySources -= 1;
    missingSourceHealth.summary.totalDocuments = missingSourceDocuments.length;
    await fs.writeFile(missingSourceHealthPath, `${JSON.stringify(missingSourceHealth, null, 2)}\n`, "utf8");
    const missingSourceAudit = await auditSearchProductionBundle({
      documentsPath: missingSourceDocumentsPath,
      healthPath: missingSourceHealthPath,
    });
    const missingWonsanCoveragePath = path.join(tempDir, "missing-wonsan-coverage.jsonl");
    const missingWonsanCoverageDocuments = productionDocuments.filter((document) => (
      !/원산|Wonsan|Kalma/i.test(`${document.title || ""} ${document.snippet || ""} ${document.body || ""}`)
    ));
    await fs.writeFile(missingWonsanCoveragePath, stringifyJsonl(missingWonsanCoverageDocuments), "utf8");
    const missingWonsanCoverageAudit = await auditSearchProductionBundle({ documentsPath: missingWonsanCoveragePath });
    const shallowKcnaCoveragePath = path.join(tempDir, "shallow-kcna-coverage.jsonl");
    let keptKcnaDocuments = 0;
    const shallowKcnaCoverageDocuments = productionDocuments.filter((document) => (
      document.sourceId !== "kcna" || keptKcnaDocuments++ < 100
    ));
    await fs.writeFile(shallowKcnaCoveragePath, stringifyJsonl(shallowKcnaCoverageDocuments), "utf8");
    const shallowKcnaCoverageAudit = await auditSearchProductionBundle({ documentsPath: shallowKcnaCoveragePath });
    const mockDocumentsPath = path.join(tempDir, "mock-documents.jsonl");
    const mockBaseDocument = productionDocuments[0];
    const mockBaseSource = SEARCH_SOURCES.find((source) => source.id === mockBaseDocument.sourceId);
    const mockDocuments = [
      ...productionDocuments,
      {
        ...mockBaseDocument,
        id: "fixture-mock-result",
        title: "화성지구 4단계 거리 사진 모음",
        url: new URL("/fixture/mock-result", mockBaseSource.baseUrl).href,
      },
    ];
    await fs.writeFile(mockDocumentsPath, stringifyJsonl(mockDocuments), "utf8");
    const mockIndexAudit = await auditSearchProductionBundle({ documentsPath: mockDocumentsPath });
    const futureDocumentsPath = path.join(tempDir, "future-documents.jsonl");
    const futureDate = new Date();
    futureDate.setUTCDate(futureDate.getUTCDate() + 7);
    await fs.writeFile(futureDocumentsPath, stringifyJsonl([
      ...productionDocuments,
      {
        ...mockBaseDocument,
        id: `${mockBaseDocument.id}-future-date`,
        date: futureDate.toISOString().slice(0, 10),
      },
    ]), "utf8");
    const futureDateAudit = await auditSearchProductionBundle({ documentsPath: futureDocumentsPath });
    const staleRuntimeDir = path.join(tempDir, "runtime");
    await fs.mkdir(staleRuntimeDir, { recursive: true });
    await fs.writeFile(
      path.join(staleRuntimeDir, "entry.html"),
      '<script type="module" src="/search/searchPortal.js?v=search-20260519-44"></script>\n<script type="module" src="/search/provider.js?v=search-20260519-36"></script>\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(staleRuntimeDir, "module.js"),
      'import { searchProvider } from "./provider.js";\nconst logo = "/assets/search-rodong-logo.svg";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(staleRuntimeDir, "style.css"),
      ".broken { color: var(--undefined-search-token); }\n",
      "utf8",
    );
    const staleAssetAudit = await auditSearchProductionBundle({ runtimeDirs: [staleRuntimeDir] });
    const weakAssetProxyPath = path.join(tempDir, "weak-search-asset.js");
    await fs.writeFile(
      weakAssetProxyPath,
      "const ALLOWED_ASSET_HOSTS = new Set();\nfunction isDirectAssetUrl() { return true; }\nconst MAX_ASSET_BYTES = 1;\n",
      "utf8",
    );
    const weakAssetProxyAudit = await auditSearchProductionBundle({ assetProxyPath: weakAssetProxyPath });
    const failedAssetCacheReportPath = path.join(tempDir, "failed-asset-cache-report.json");
    await fs.writeFile(failedAssetCacheReportPath, `${JSON.stringify({
      generatedAt: "2026-05-22T00:00:00.000Z",
      dryRun: false,
      documents: productionDocuments.length,
      selectedDocuments: 40,
      attempted: 3,
      cached: 0,
      kept: 0,
      failed: 3,
      failures: [
        {
          sourceId: "korean-books",
          field: "url",
          url: "http://www.korean-books.com.kp/fixture.pdf",
          error: "This operation was aborted",
        },
      ],
    }, null, 2)}\n`, "utf8");
    const failedAssetCacheAudit = await auditSearchProductionBundle({ assetCacheReportPath: failedAssetCacheReportPath });
    const missingAssetCacheAudit = await auditSearchProductionBundle({ assetCacheReportPath: path.join(tempDir, "missing-asset-cache-report.json") });
    const missingCachedAssetDocumentsPath = path.join(tempDir, "missing-cached-asset-documents.jsonl");
    await fs.writeFile(missingCachedAssetDocumentsPath, stringifyJsonl(productionDocuments.map((document, index) => index === 0
      ? { ...document, cachedThumbnailUrl: "/data/search/assets/missing-fixture/thumb.jpg" }
      : document)), "utf8");
    const missingCachedAssetAudit = await auditSearchProductionBundle({ documentsPath: missingCachedAssetDocumentsPath });
    const escapingCachedAssetDocumentsPath = path.join(tempDir, "escaping-cached-asset-documents.jsonl");
    await fs.writeFile(escapingCachedAssetDocumentsPath, stringifyJsonl(productionDocuments.map((document, index) => index === 0
      ? { ...document, cachedUrl: "/data/search/assets/../secret.jpg" }
      : document)), "utf8");
    const escapingCachedAssetAudit = await auditSearchProductionBundle({ documentsPath: escapingCachedAssetDocumentsPath });
    const missingRouteShellAudit = await auditSearchProductionBundle({
      routeShells: [{ filePath: path.join(tempDir, "missing-document-route.html"), page: "document", route: "/search/document" }],
    });
    const weakRouteShellPath = path.join(tempDir, "weak-route.html");
    await fs.writeFile(
      weakRouteShellPath,
      '<!doctype html><html lang="ko"><head><base href="/" /></head><body data-search-page="document"><main data-search-root></main></body></html>',
      "utf8",
    );
    const weakRouteShellAudit = await auditSearchProductionBundle({
      routeShells: [{ filePath: weakRouteShellPath, page: "document", route: "/search/document" }],
    });
    const auditSource = await fs.readFile(path.join(ROOT_DIR, "scripts/audit-search-production.ts"), "utf8");

    assert.deepEqual(audit.errors, [], "production audit should pass for the deployable search bundle");
    assert.equal(audit.queryCoverage.some((coverage) => coverage.id === "wonsan" && coverage.sourceFacets.length >= 5), true, "production audit should expose broad 원산 query source coverage");
    assert.equal(audit.queryCoverage.some((coverage) => coverage.id === "wonsan-exclude-kcna" && !coverage.sourceFacets.some((facet) => facet.sourceId === "kcna")), true, "production audit should enforce Google-like -site: source exclusion coverage");
    assert.equal(audit.queryCoverage.some((coverage) => coverage.id === "wonsan-kalma" && coverage.sourceFacets.some((facet) => facet.sourceId === "choson-sinbo")), true, "production audit should expose 조선신보 Wonsan Kalma coverage");
    assert.equal(audit.queryCoverage.some((coverage) => (
      coverage.id === "source-only-rodong"
      && coverage.sourceFacets.length === 1
      && coverage.sourceFacets[0]?.sourceId === "rodong-sinmun"
    )), true, "production audit should keep site: source-only facet counts scoped to the requested source");
    assert.equal(audit.queryCoverage.some((coverage) => (
      coverage.id === "wonsan-kalma-ceremony"
      && coverage.sourceFacets.length >= 3
      && coverage.sourceFacets.some((facet) => facet.sourceId === "kcna-watch")
      && coverage.sourceFacets.some((facet) => facet.sourceId === "kcna")
      && coverage.sourceFacets.some((facet) => facet.sourceId === "choson-sinbo")
      && coverage.strictMultiTerm
    )), true, "production audit should expose exact Wonsan Kalma ceremony coverage across KCNA Watch and direct sources");
    assert.equal(audit.queryCoverage.some((coverage) => coverage.id === "kim-wonsan-kalma" && coverage.strictMultiTerm), true, "production audit should expose strict multi-term coverage checks");
    assert.equal(audit.queryCoverage.some((coverage) => coverage.id === "wonsan-english" && coverage.sourceFacets.length >= 5), true, "production audit should expose English Wonsan alias coverage");
    assert.equal(audit.queryCoverage.some((coverage) => coverage.id === "kim-wonsan-kalma-english" && coverage.strictMultiTerm), true, "production audit should expose English person/place strict multi-term coverage checks");
    assert.equal(audit.queryCoverage.some((coverage) => (
      coverage.id === "source-vok-wonsan-kalma-ceremony"
      && coverage.sourceFacets.length === 1
      && coverage.sourceFacets[0]?.sourceId === "voice-of-korea"
      && coverage.previewSourceNames.includes("로동신문")
      && coverage.minDisplaySnippetLength >= 180
    )), true, "production audit should prove source-scoped VOK ceremony results use rich same-story snippets instead of sparse source chrome");
    assert.equal(audit.queryCoverage.some((coverage) => (
      coverage.id === "site-korean-alias-kp-wonsan-kalma"
      && coverage.sourceFacets.length >= 5
      && !coverage.sourceFacets.some((facet) => facet.sourceId === "kcna-watch")
    )), true, "production audit should guard Korean 사이트: aliases over the real indexed source scope");
    assert.equal(audit.queryCoverage.some((coverage) => (
      coverage.id === "site-korean-alias-only-kp"
      && coverage.total >= 1000
      && coverage.effectiveQuery === ""
      && coverage.sourceFacets.length >= 6
      && !coverage.sourceFacets.some((facet) => facet.sourceId === "kcna-watch")
    )), true, "production audit should guard Korean 사이트: filter-only browsing over the real .kp source corpus");
    assert.equal(audit.queryCoverage.some((coverage) => (
      coverage.id === "source-korean-alias-rodong-wonsan-kalma"
      && coverage.sourceFacets.length === 1
      && coverage.sourceFacets[0]?.sourceId === "rodong-sinmun"
    )), true, "production audit should guard Korean 출처: aliases");
    assert.equal(audit.queryCoverage.some((coverage) => (
      coverage.id === "filetype-korean-alias-pdf"
      && coverage.sourceFacets.some((facet) => facet.sourceId === "korean-books")
    )), true, "production audit should guard Korean 파일형식: aliases");
    assert.equal(audit.queryCoverage.some((coverage) => (
      coverage.id === "date-korean-alias-wonsan-kalma-june-2025"
      && coverage.sourceFacets.length >= 3
    )), true, "production audit should guard Korean 이후:/이전: aliases");
    assert.equal(audit.sourceWarnings.length, audit.summary.warningSources, "production audit should expose details for each warning source");
    assert.equal(audit.sourceWarnings.some((source) => source.sourceId === "kcna-watch"), false, "production audit should not warn for KCNA Watch after reachable sitemap and detail-fetch settings are used");
    assert.equal(audit.sourceWarnings.some((source) => source.sourceId === "koryo-vod"), false, "production audit should not warn for Koryo VOD after a successful live API import");
    assert.equal(audit.assetCacheCoverage.after.selectedMissing, 0, "production audit should prove the latest selected asset mirror scope has no uncached candidates");
    assert.equal(audit.assetCacheCoverage.topMissingSources[0]?.sourceId, "ryugyong", "production audit should expose remaining uncached asset gaps by source instead of hiding them behind a passing report");
    assert.equal(auditSource.includes("asset cache:"), true, "production audit CLI output should print full-index asset cache coverage");
    assert.equal(auditSource.includes("selected asset cache:"), true, "production audit CLI output should print selected mirror-scope asset cache coverage");
    assert.equal(auditSource.includes("asset cache missing by source"), true, "production audit CLI output should print top sources with remaining uncached preview assets");
    assert.equal(staleAudit.errors.some((error) => error.includes("seed documents must match")), true, "production audit should reject stale Meilisearch seed document identities");
    assert.equal(staleAudit.errors.some((error) => error.includes("visibleTabs")), true, "production audit should reject stale Meilisearch visibleTabs values");
    assert.equal(staleAudit.errors.some((error) => error.includes("integratedRank")), true, "production audit should reject stale Meilisearch integratedRank values");
    assert.equal(staleContentAudit.errors.some((error) => error.includes("documents must match data/search/documents.jsonl content")), true, "production audit should reject stale Meilisearch seed document content even when ids are unchanged");
    assert.equal(stalePreviewAudit.errors.some((error) => error.includes("previewSourceName") && error.includes("previewDocumentId")), true, "production audit should reject enriched preview text without provenance");
    assert.equal(staleYoutubeAudit.errors.some((error) => error.includes("Every Meilisearch video document must appear")), true, "production audit should reject video documents missing the 전체 tab");
    assert.equal(duplicateSettingsAudit.errors.some((error) => error.includes("filterableAttributes") && error.includes("duplicate values")), true, "production audit should reject duplicate Meilisearch setting list values");
    assert.equal(weakBackendFilterAudit.errors.some((error) => error.includes("filter by sourceId")), true, "production audit should reject backend settings that break source filters and -site: exclusions");
    assert.equal(weakBackendFilterAudit.errors.some((error) => error.includes("filter by language")), true, "production audit should reject backend settings that break lang: operators");
    assert.equal(weakBackendFilterAudit.errors.some((error) => error.includes("filter by mediaType")), true, "production audit should reject backend settings that break media/filetype tabs");
    assert.equal(weakBackendFilterAudit.errors.some((error) => error.includes("display original source names")), true, "production audit should reject backend settings that hide KCNA Watch origin pills");
    assert.equal(weakBackendFilterAudit.errors.some((error) => error.includes("collapse duplicate article/story hits by storyKey")), true, "production audit should reject backend settings that disable story duplicate collapse");
    assert.equal(staleHealthAudit.errors.some((error) => error.includes("robotsDisallowed")), true, "production audit should reject source health without robots-disallowed diagnostics");
    assert.equal(staleHealthAudit.errors.some((error) => error.includes("robotsWarning")), true, "production audit should reject source health without robots warning diagnostics");
    assert.equal(staleHealthAudit.errors.some((error) => error.includes("non-blocking warning diagnostics")), true, "production audit should reject source health without non-blocking warning diagnostics");
    assert.equal(staleHealthAudit.errors.some((error) => error.includes("healthySources")), true, "production audit should reject source-health summaries that hide warning sources");
    assert.equal(missingSourceAudit.errors.some((error) => error.includes("every configured source must have at least one indexed real document")), true, "production audit should reject deploys that drop a requested source from the real index");
    assert.equal(missingSourceAudit.errors.some((error) => error.includes("searchableSources should cover every configured source")), true, "production audit should reject source-health summaries with incomplete source coverage");
    assert.equal(missingWonsanCoverageAudit.errors.some((error) => error.includes("[critical-query:wonsan]")), true, "production audit should reject deploys that lose broad 원산 query coverage");
    assert.equal(missingWonsanCoverageAudit.errors.some((error) => error.includes("[critical-query:wonsan-kalma]")), true, "production audit should reject deploys that lose 원산갈마 source coverage");
    assert.equal(missingWonsanCoverageAudit.errors.some((error) => error.includes("[critical-query:wonsan-kalma-ceremony]")), true, "production audit should reject deploys that lose exact 원산갈마 준공식 coverage");
    assert.equal(shallowKcnaCoverageAudit.errors.some((error) => error.includes("[source:kcna] production index should include at least 240")), true, "production audit should reject shallow KCNA crawls that fall back below the expanded official-source crawl depth");
    assert.equal(mockIndexAudit.errors.some((error) => error.includes("fixture/mock/placeholder document markers")), true, "production audit should reject test fixture or mock documents in the production index");
    assert.equal(mockIndexAudit.errors.some((error) => error.includes("old mock result titles")), true, "production audit should reject old mock result titles in the production index");
    assert.equal(futureDateAudit.errors.some((error) => error.includes("document.date must not be in the future")), true, "production audit should reject future-dated documents");
    assert.equal(staleAssetAudit.errors.some((error) => error.includes("cache key must be consistent")), true, "production audit should reject mixed search asset cache keys");
    assert.equal(staleAssetAudit.errors.some((error) => error.includes("relative runtime import must include")), true, "production audit should reject unversioned relative runtime imports");
    assert.equal(staleAssetAudit.errors.some((error) => error.includes("runtime asset URL must include") && error.includes("/assets/search-rodong-logo.svg")), true, "production audit should reject unversioned local Figma logo URLs");
    assert.equal(staleAssetAudit.errors.some((error) => error.includes("CSS custom properties must be defined before use")), true, "production audit should reject undefined CSS design tokens");
    assert.equal(weakAssetProxyAudit.errors.some((error) => error.includes("[asset-proxy]") && error.includes("security headers")), true, "production audit should reject an asset proxy without centralized security headers");
    assert.equal(weakAssetProxyAudit.errors.some((error) => error.includes("Content-Security-Policy")), true, "production audit should reject an asset proxy without CSP sandboxing");
    assert.equal(failedAssetCacheAudit.errors.some((error) => error.includes("[asset-cache]") && error.includes("korean-books/url")), true, "production audit should reject failed asset mirror reports instead of shipping broken cache state");
    assert.equal(failedAssetCacheAudit.errors.some((error) => error.includes("assetCoverage.after")), true, "production audit should reject old asset mirror reports that do not expose cached-asset coverage");
    assert.equal(missingAssetCacheAudit.errors.some((error) => error.includes("asset-cache-report.json is required")), true, "production audit should reject bundles without an asset cache report");
    assert.equal(missingCachedAssetAudit.errors.some((error) => error.includes("points to missing local asset")), true, "production audit should reject cachedUrl/cachedThumbnailUrl values whose local mirrored files are missing");
    assert.equal(escapingCachedAssetAudit.errors.some((error) => error.includes("must stay under /data/search/assets")), true, "production audit should reject cached asset paths that escape the mirrored asset directory");
    assert.equal(missingRouteShellAudit.errors.some((error) => error.includes("[route:/search/document]") && error.includes("route shell is missing")), true, "production audit should reject missing direct document route shells");
    assert.equal(weakRouteShellAudit.errors.some((error) => error.includes("[route:/search/document]") && error.includes("/search/search-config.js")), true, "production audit should reject route shells that do not load runtime search config");
    assert.equal(weakRouteShellAudit.errors.some((error) => error.includes("[route:/search/document]") && error.includes("/search/searchPortal.js")), true, "production audit should reject route shells that do not load the search portal runtime");
    assert.equal(packageJson.scripts["audit:search"], "node scripts/audit-search-production.ts", "package scripts should expose the production search audit");
    assert.equal(readme.includes("npm run audit:search"), true, "README should document the production search audit command");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function assertProductionVideoDocumentsAreVisibleInAll(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const videoDocuments = productionDocuments.filter((document) => document.mediaType === "video" || document.mediaType === "broadcast");

  assert.equal(videoDocuments.length > 0, true, "production index should include video documents");
  for (const document of videoDocuments) {
    assert.equal((document.searchTabs || []).includes("all"), true, `video document should be visible in 전체: ${document.id}`);
    assert.equal((document.searchTabs || []).includes("video"), true, `video document should be visible in 동영상: ${document.id}`);
  }
}

async function assertSearchSeedIsBackendReady() {
  const payload = await buildSearchSeed();
  const documentSettings = payload.settings.documents;
  const suggestionSettings = payload.settings.suggestions;

  assert.equal(payload.documentIndexName, "dprk_documents", "seed should name the document index");
  assert.equal(payload.suggestionIndexName, "dprk_suggestions", "seed should name the suggestion index");
  assert.equal(payload.documents.length > 0, true, "seed should include indexed documents");
  assert.equal(payload.suggestions.some((suggestion) => suggestion.label === "김정은"), true, "seed suggestions should include known entities");
  assert.equal(payload.suggestions.some((suggestion) => suggestion.label === "김정은 원산갈마해안관광지구" && suggestion.aliases.includes("Kim Jong Un Wonsan")), true, "seed suggestions should include composite English person/place entity aliases");
  assert.equal(payload.suggestions.some((suggestion) => suggestion.label === "민주조선"), true, "seed suggestions should include indexed source names");
  assert.equal(payload.suggestions.some((suggestion) => suggestion.sourceId === "minju-choson"), true, "seed suggestions should carry sourceIds when available");
  assert.equal(payload.suggestions.some((suggestion) => suggestion.type === "document_title" && suggestion.sourceName && suggestion.mediaType), true, "seed document-title suggestions should carry source and media provenance");
  assert.equal(payload.suggestions.some((suggestion) => suggestion.type === "source" && suggestion.description.includes("자료원")), true, "seed source suggestions should carry source-type provenance");
  assert.equal(payload.documents.every((document) => document.visibleTabs.includes("all")), true, "every document should be visible in 전체 in Meilisearch");
  assert.equal(payload.documents.some((document) => document.sourceId === "koryo-vod" && document.visibleTabs.includes("all") && document.visibleTabs.includes("video")), true, "고려TV video documents should be visible in both 전체 and 동영상");
  assert.equal(payload.documents.some((document) => document.sourceId === "youtube" && document.visibleTabs.includes("all") && document.visibleTabs.includes("video")), true, "YouTube video documents should be visible in both 전체 and 동영상");
  assert.equal(payload.documents.some((document) => document.title.includes("《최현》호") && document.aliases.includes("최현호")), true, "Meilisearch seed should add strict title-derived aliases for decorated source-visible names");
  assert.equal(payload.documents.some((document) => /[１２３４５６７８９０]/.test(document.title) && document.normalizedText && !/[１２３４５６７８９０]/.test(document.normalizedText)), true, "Meilisearch seed should include width-normalized text for full-width Korean source text");
  assert.equal(payload.documents.some((document) => {
    if (!/원산갈마해안관광지구/.test(`${document.title} ${document.snippet} ${document.body}`)) return false;
    const normalizedTokens = new Set(String(document.normalizedText || "").split(/\s+/));
    return normalizedTokens.has("원산") && normalizedTokens.has("갈마") && normalizedTokens.has("해안관광");
  }), true, "Meilisearch seed should include Hangul n-gram tokens so spaced Korean queries such as 원산 갈마 match 붙여쓰기 source titles");
  assert.equal(payload.documents.every((document) => typeof document.searchSnippet === "string"), true, "Meilisearch seed should include dateline-stripped search snippets");
  assert.equal(payload.documents.every((document) => typeof document.searchBody === "string"), true, "Meilisearch seed should include dateline-stripped search bodies");
  assert.equal(payload.documents.some((document) => /조선중앙통신/.test(document.body || "") && /평양\s*[\p{N}]{1,2}월\s*[\p{N}]{1,2}일발\s*조선중앙통신/u.test(document.body || "") && !/평양\s*[\p{N}]{1,2}월\s*[\p{N}]{1,2}일발\s*조선중앙통신/u.test(document.searchBody || "")), true, "Meilisearch seed searchBody should strip source datelines while preserving display body");
  assert.equal(payload.documents.some((document) => document.previewText && document.previewSourceName && document.previewDocumentId), true, "Meilisearch seed should include enriched preview text for weak indexed article snippets");
  assert.equal(payload.documents.some((document) => document.sourceId === "minju-choson" && document.previewSourceName && /조선로동당 총비서|국무위원장/.test(document.previewText)), true, "weak 민주조선 seed records should carry richer backend preview text from another indexed source");
  assert.equal(payload.documents.some((document) => (
    document.sourceId === "voice-of-korea"
    && /\/revo_de\/getDetail\/ikn250625008\/ko$/i.test(document.url)
    && document.previewSourceName === "로동신문"
    && /원산갈마해안관광지구 준공식/.test(document.previewText)
  )), true, "weak 조선의 소리 Korean Wonsan Kalma ceremony record should carry richer backend preview text from 로동신문");
  assert.equal(payload.documents.some((document) => (
    document.sourceId === "voice-of-korea"
    && /\/revo_de\/getDetail\/ien250625008\/en$/i.test(document.url)
    && document.previewSourceName
    && /Wonsan Kalma Coastal Tourist Area/i.test(document.previewText)
  )), true, "weak 조선의 소리 English Wonsan Kalma ceremony record should carry richer backend preview text");
  assert.equal(payload.documents.some((document) => (
    document.sourceId === "kcna-watch"
    && document.displaySourceId === "kcna"
    && document.date === "2025-07-02"
    && /원산갈마해안관광지구\s*봉사\s*시작/.test(document.title)
    && document.previewSourceName === "조선중앙통신"
    && /관광봉사가 시작되였다/.test(document.previewText)
  )), true, "KCNA Watch preserved service-start copies should stay in KCNA Watch while carrying richer official KCNA backend preview text");
  assert.equal(payload.documents.some((document) => (
    document.sourceId === "kcna-watch"
    && document.date === "2025-06-26"
    && /원산갈마해안관광지구\s*준공식/.test(document.title)
    && document.previewSourceName
    && /원산갈마해안관광지구 준공식/.test(document.previewText)
  )), true, "truncated KCNA Watch Wonsan Kalma ceremony copies should carry richer same-story backend preview text");
  assert.equal(documentSettings.filterableAttributes.includes("sourceId"), true, "document index should filter by sourceId");
  assert.equal(documentSettings.filterableAttributes.includes("mediaType"), true, "document index should filter by mediaType");
  assert.equal(documentSettings.filterableAttributes.includes("date"), true, "document index should filter by date for after:/before: operators");
  assert.equal(documentSettings.filterableAttributes.includes("visibleTabs"), true, "document index should filter by computed visibleTabs");
  assert.equal(documentSettings.searchableAttributes.includes("url"), true, "document index should search primary URLs for inurl: operators");
  assert.equal(documentSettings.searchableAttributes.includes("archiveUrl"), true, "document index should search archive URLs for inurl: operators");
  assert.equal(documentSettings.searchableAttributes.includes("cachedUrl"), true, "document index should search mirrored primary URLs for inurl: operators");
  assert.equal(documentSettings.displayedAttributes.includes("body"), true, "document index should display body so Meilisearch can return cropped formatted excerpts");
  assert.equal(documentSettings.displayedAttributes.includes("searchBody"), true, "document index should display dateline-stripped search body diagnostics");
  assert.equal(documentSettings.displayedAttributes.includes("normalizedText"), true, "document index should display width-normalized text for backend debugging");
  assert.equal(documentSettings.displayedAttributes.includes("previewText"), true, "document index should display enriched preview text for backend snippets");
  assert.equal(documentSettings.displayedAttributes.includes("previewSourceName"), true, "document index should display enriched preview provenance");
  assert.equal(documentSettings.displayedAttributes.includes("previewDocumentId"), true, "document index should display enriched preview document provenance");
  assert.equal(documentSettings.displayedAttributes.includes("sourceId"), true, "document index should display source ids for source facet diagnostics");
  assert.equal(documentSettings.displayedAttributes.includes("displaySourceName"), true, "document index should display original source names for KCNA Watch origin pills");
  assert.equal(documentSettings.displayedAttributes.includes("originalSourceUrl"), true, "document index should display original source URLs for linked KCNA Watch origin pills");
  assert.equal(documentSettings.displayedAttributes.includes("cachedUrl"), true, "document index should return mirrored primary asset URLs");
  assert.equal(documentSettings.displayedAttributes.includes("cachedThumbnailUrl"), true, "document index should return mirrored thumbnail asset URLs");
  assert.equal(documentSettings.displayedAttributes.includes("integratedRank"), true, "document index should expose integrated media rank for backend debugging");
  assert.equal(documentSettings.displayedAttributes.includes("storyKey"), true, "document index should expose story keys for duplicate-result diagnostics");
  assert.equal(documentSettings.distinctAttribute, "storyKey", "Meilisearch should collapse duplicate article/story hits by stable story key");
  assert.equal(documentSettings.sortableAttributes.includes("integratedRank"), true, "document index should sort 전체 results by web-result media priority");
  assert.equal(documentSettings.sortableAttributes.includes("date"), true, "document index should sort by date");
  assert.equal(suggestionSettings.filterableAttributes.includes("type"), true, "suggestion index should filter by suggestion type");
  assert.equal(suggestionSettings.displayedAttributes.includes("description"), true, "suggestion index should display provenance descriptions");
  assert.equal(suggestionSettings.displayedAttributes.includes("sourceName"), true, "suggestion index should display source names for autocomplete provenance");
  assert.equal(suggestionSettings.displayedAttributes.includes("mediaType"), true, "suggestion index should display media types for autocomplete provenance");
  assert.deepEqual(documentSettings.synonyms, {}, "document retrieval must not use broad known-entity synonyms");
  assert.equal(documentSettings.rankingRules.includes("typo"), false, "document retrieval must not use fuzzy typo ranking");
  assert.deepEqual(documentSettings.typoTolerance, { enabled: false }, "document retrieval typo tolerance should be disabled");
  assert.equal(suggestionSettings.rankingRules.includes("typo"), true, "suggestions may keep typo tolerance for autocomplete");
  assert.equal(Array.isArray(suggestionSettings.synonyms["김정은"]), true, "suggestion index should include known-entity synonyms");
  assert.equal(payload.documents.some((document) => "searchFields" in document), false, "seed documents must not upload local-only normalized searchFields to Meilisearch");
  assert.equal(payload.documents.every((document) => typeof document.normalizedText === "string"), true, "seed documents should upload backend-only width-normalized text");
  assert.equal(payload.documents.some((document) => document.mediaType === "article" && document.integratedRank === 0), true, "article documents should receive the strongest 전체 media rank");
  assert.equal(payload.documents.some((document) => document.mediaType === "image" && document.integratedRank > 0), true, "image documents should not outrank web/article results by default in 전체");
  assert.equal(payload.sources.some((source) => "searchFields" in source), false, "seed sources must not upload local-only normalized searchFields to Meilisearch");
  assert.equal(payload.documents.every((document) => typeof document.body === "string"), true, "seed documents should keep body available for backend snippets");
  assert.equal(payload.documents.every((document) => typeof document.storyKey === "string" && document.storyKey.length > 0), true, "seed documents should include a non-empty storyKey for duplicate collapsing");
}

async function assertMeilisearchSyncReplacesIndexesExactly() {
  const requests = [];
  let taskUid = 1;
  const payload = {
    documentIndexName: "dprk_documents",
    suggestionIndexName: "dprk_suggestions",
    settings: {
      documents: { filterableAttributes: ["sourceId"] },
      suggestions: { filterableAttributes: ["type"] },
    },
    documents: [{ id: "document-1", title: "Document" }],
    suggestions: [{ id: "suggestion-1", label: "Suggestion" }],
  };
  await syncMeilisearchPayload(payload, {
    host: "https://meili.example.test",
    apiKey: "test-key",
    wait: true,
    fetchImpl: async (url, options = {}) => {
      const request = {
        path: String(url).replace("https://meili.example.test", ""),
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : undefined,
      };
      requests.push(request);

      if (request.method === "GET" && request.path.startsWith("/tasks/")) {
        return { ok: true, json: async () => ({ status: "succeeded" }) };
      }
      if (request.method === "GET" && request.path.startsWith("/indexes/")) {
        return { ok: true, json: async () => ({ uid: request.path.split("/").pop() }) };
      }
      return { ok: true, json: async () => ({ taskUid: taskUid += 1 }) };
    },
  });

  const mutationOrder = requests
    .filter((request) => request.method !== "GET")
    .map((request) => `${request.method} ${request.path}`);

  assert.deepEqual(
    mutationOrder,
    [
      "PATCH /indexes/dprk_documents__next/settings",
      "DELETE /indexes/dprk_documents__next/documents",
      "PUT /indexes/dprk_documents__next/documents?primaryKey=id",
      "POST /swap-indexes",
      "DELETE /indexes/dprk_documents__next",
      "PATCH /indexes/dprk_suggestions__next/settings",
      "DELETE /indexes/dprk_suggestions__next/documents",
      "PUT /indexes/dprk_suggestions__next/documents?primaryKey=id",
      "POST /swap-indexes",
      "DELETE /indexes/dprk_suggestions__next",
    ],
    "Meilisearch sync should build staging indexes, swap atomically, and clean up stale staging indexes",
  );
  assert.deepEqual(
    requests.find((request) => request.path === "/indexes/dprk_documents__next/documents?primaryKey=id")?.body,
    payload.documents,
    "Meilisearch document upload should use the seed document payload on the staging index",
  );
  assert.deepEqual(
    requests
      .filter((request) => request.path === "/swap-indexes")
      .map((request) => request.body),
    [
      [{ indexes: ["dprk_documents", "dprk_documents__next"] }],
      [{ indexes: ["dprk_suggestions", "dprk_suggestions__next"] }],
    ],
    "Meilisearch sync should atomically swap staged indexes into the live names",
  );
  assert.equal(
    mutationOrder.includes("DELETE /indexes/dprk_documents/documents"),
    false,
    "Meilisearch sync must not clear the live document index before a replacement is ready",
  );
  assert.equal(
    requests.filter((request) => request.path.startsWith("/tasks/")).length,
    mutationOrder.length,
    "Meilisearch sync --wait should wait for every settings/delete/upload task",
  );
}

async function assertMeilisearchProviderUsesVisibleTabs() {
  const requests = [];
  const provider = new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      requests.push({ url, body });
      const isSourceFilteredFacetRequest = body.limit === 0 && !/sourceId/.test(String(body.filter || ""));
      const isSourceFilteredMainRequest = /sourceId/.test(String(body.filter || ""));
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: {
            sourceId: isSourceFilteredFacetRequest
              ? { kcna: 3, "minju-choson": 1 }
              : (isSourceFilteredMainRequest ? { kcna: 3 } : { kcna: 3, "minju-choson": 1 }),
          },
        }),
      };
    },
  });

  await provider.searchDocuments("Korean", { tab: "all" });
  await provider.searchDocuments("Korean", { tab: "video" });
  const sourceFiltered = await provider.searchDocuments("Korean", { tab: "all", sourceIds: ["kcna"] });
  await provider.searchDocuments("Korean", { tab: "all", sort: "latest" });
  await provider.searchDocuments("Korean", { tab: "all", dateFrom: "2026-05-01", dateTo: "2026-05-20" });

  assert.match(requests[0].body.filter, /visibleTabs = "all"/, "Meilisearch 전체 search should filter by visibleTabs=all");
  assert.match(requests[1].body.filter, /visibleTabs = "video"/, "Meilisearch video search should filter by visibleTabs=video");
  assert.match(requests[2].body.filter, /sourceId IN \["kcna"\]/, "Meilisearch source search should filter by sourceId");
  assert.match(requests[5].body.filter, /date >= "2026-05-01"/, "Meilisearch date range search should filter by lower document date");
  assert.match(requests[5].body.filter, /date <= "2026-05-20"/, "Meilisearch date range search should filter by upper document date");
  assert.deepEqual(requests[0].body.sort, ["integratedRank:asc", "date:desc"], "Meilisearch 전체 search should keep article/web-like results ahead of image/video results");
  assert.deepEqual(requests[1].body.sort, ["date:desc"], "Meilisearch media tabs should keep media-specific recency sorting");
  assert.deepEqual(requests[4].body.sort, ["date:desc", "integratedRank:asc", "displayOrder:asc"], "Meilisearch latest sort should order by date while keeping deterministic media/display tie breakers");
  assert.deepEqual(requests[0].body.attributesToCrop, ["previewText", "searchBody"], "Meilisearch search should request cropped enriched preview and dateline-stripped body snippets for backend-backed excerpts");
  assert.deepEqual(requests[0].body.attributesToSearchOn, ["title", "searchSnippet", "searchBody", "normalizedText", "url", "archiveUrl", "cachedUrl", "thumbnailUrl", "cachedThumbnailUrl", "aliases", "sourceName", "displaySourceName"], "Meilisearch document search should use dateline-stripped document fields, URL fields, and width-normalized text derived from them");
  assert.deepEqual(requests[0].body.facets, ["sourceId"], "Meilisearch search should request source facets for grouped result totals");
  assert.equal(requests[0].body.matchingStrategy, "all", "Meilisearch document search should require all query terms");
  assert.equal(requests[0].body.showRankingScore, true, "Meilisearch document search should request ranking scores for backend parity");
  assert.equal(requests[0].body.rankingScoreThreshold, 0.2, "Meilisearch document search should apply a minimum ranking score threshold");
  assert.equal(requests[0].body.highlightPreTag.includes("DPRK_SEARCH_HIGHLIGHT_START"), true, "Meilisearch search should use safe custom highlight markers");
  assert.equal(requests[3].body.limit, 0, "Meilisearch source-filtered pages should make a lightweight source-facet request");
  assert.equal(/sourceId/.test(String(requests[3].body.filter || "")), false, "Meilisearch source facet request should omit the active source filter so users can switch sources");
  assert.deepEqual(sourceFiltered.sourceFilters, [{ sourceId: "kcna", sourceName: "조선중앙통신" }], "Meilisearch source filters should expose canonical display names");
  assert.deepEqual(sourceFiltered.sourceFacets[0], { sourceId: "kcna", sourceName: "조선중앙통신", sourceType: "official_site", count: 3 }, "Meilisearch source facets should expose source names and counts");
  assert.deepEqual(
    sourceFiltered.sourceFacets.map(({ sourceId, count }) => ({ sourceId, count })),
    [{ sourceId: "kcna", count: 3 }, { sourceId: "minju-choson", count: 1 }],
    "Meilisearch source-filtered pages should keep full source facet counts for source switching",
  );

  const fallbackRequests = [];
  const fallbackProvider = new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      fallbackRequests.push({ url, body });
      if (body.limit === 0) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 3,
          processingTimeMs: 4,
          facetDistribution: { displaySourceId: { kcna: 3 } },
        }),
      };
    },
  });
  const fallbackResult = await fallbackProvider.searchDocuments("Korean", { tab: "all", sourceIds: ["kcna"] });
  assert.equal(fallbackRequests.length, 2, "Meilisearch source-filtered pages should still attempt the facet-only request");
  assert.deepEqual(
    fallbackResult.sourceFacets.map(({ sourceId, count }) => ({ sourceId, count })),
    [{ sourceId: "kcna", count: 3 }],
    "Meilisearch source-filtered pages should keep main results usable if the facet-only request fails",
  );

  const clientFilteredFacetRequests = [];
  const clientFilteredFacetProvider = new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      clientFilteredFacetRequests.push({ url, body });
      const isSourceFilteredMainRequest = /sourceId IN \["kcna"\]/.test(String(body.filter || ""));
      const hits = isSourceFilteredMainRequest
        ? [
            {
              id: "fixture-kcna-clean",
              title: "조선중앙통신 clean",
              snippet: "필터 뒤에도 남는 기사입니다.",
              date: "2026-05-20",
              sourceId: "kcna",
              sourceName: "조선중앙통신",
              sourceType: "official_site",
              displaySourceId: "kcna",
              displaySourceName: "조선중앙통신",
              displaySourceType: "official_site",
              mediaType: "article",
              url: "http://www.kcna.kp/clean",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              searchTabs: ["all"],
              visibleTabs: ["all"],
            },
            {
              id: "fixture-kcna-excluded",
              title: "원산 조선중앙통신",
              snippet: "제외어가 있는 기사입니다.",
              date: "2026-05-20",
              sourceId: "kcna",
              sourceName: "조선중앙통신",
              sourceType: "official_site",
              displaySourceId: "kcna",
              displaySourceName: "조선중앙통신",
              displaySourceType: "official_site",
              mediaType: "article",
              url: "http://www.kcna.kp/excluded",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              searchTabs: ["all"],
              visibleTabs: ["all"],
            },
          ]
        : [
            {
              id: "fixture-kcna-clean",
              title: "조선중앙통신 clean",
              snippet: "필터 뒤에도 남는 기사입니다.",
              date: "2026-05-20",
              sourceId: "kcna",
              sourceName: "조선중앙통신",
              sourceType: "official_site",
              displaySourceId: "kcna",
              displaySourceName: "조선중앙통신",
              displaySourceType: "official_site",
              mediaType: "article",
              url: "http://www.kcna.kp/clean",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              searchTabs: ["all"],
              visibleTabs: ["all"],
            },
            {
              id: "fixture-minju-clean",
              title: "민주조선 clean",
              snippet: "다른 자료원에도 남는 기사입니다.",
              date: "2026-05-20",
              sourceId: "minju-choson",
              sourceName: "민주조선",
              sourceType: "official_site",
              displaySourceId: "minju-choson",
              displaySourceName: "민주조선",
              displaySourceType: "official_site",
              mediaType: "article",
              url: "http://www.minju.rep.kp/clean",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              searchTabs: ["all"],
              visibleTabs: ["all"],
            },
            {
              id: "fixture-rodong-excluded",
              title: "원산 로동신문",
              snippet: "제외어가 있는 다른 자료원 기사입니다.",
              date: "2026-05-20",
              sourceId: "rodong-sinmun",
              sourceName: "로동신문",
              sourceType: "official_site",
              displaySourceId: "rodong-sinmun",
              displaySourceName: "로동신문",
              displaySourceType: "official_site",
              mediaType: "article",
              url: "http://www.rodong.rep.kp/excluded",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              searchTabs: ["all"],
              visibleTabs: ["all"],
            },
          ];
      return {
        ok: true,
        json: async () => ({
          hits,
          estimatedTotalHits: hits.length,
          processingTimeMs: 0,
          facetDistribution: { sourceId: isSourceFilteredMainRequest ? { kcna: 2 } : { kcna: 2, "minju-choson": 1, "rodong-sinmun": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  });
  const clientFilteredFacetResult = await clientFilteredFacetProvider.searchDocuments("-원산", { tab: "all", sourceIds: ["kcna"] });
  assert.equal(clientFilteredFacetRequests.length, 2, "Meilisearch source-filtered negative-only searches should fetch an unscoped candidate window for corrected source facets");
  assert.equal(clientFilteredFacetRequests[1]?.body.limit, 500, "Meilisearch corrected source facets should use the bounded client rewrite candidate window");
  assert.equal(/sourceId IN/.test(String(clientFilteredFacetRequests[1]?.body.filter || "")), false, "Meilisearch corrected source facets should omit the active source filter before applying client-side exclusions");
  assert.deepEqual(clientFilteredFacetResult.documents.map((document) => document.id), ["fixture-kcna-clean"], "Meilisearch source-filtered negative-only searches should still filter the active source's returned documents");
  assert.deepEqual(
    clientFilteredFacetResult.sourceFacets.map(({ sourceId, count }) => ({ sourceId, count })),
    [{ sourceId: "kcna", count: 1 }, { sourceId: "minju-choson", count: 1 }],
    "Meilisearch source-filtered negative-only searches should count source facets after client-side exclusions",
  );
}

async function assertMeilisearchProviderPromotesExactSourceNameQueries() {
  const requests = [];
  const provider = new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, body: JSON.parse(options.body || "{}") });
      return {
        ok: true,
        json: async () => ({
          hits: [
            {
              id: "choson-rodong-mention",
              title: "5월 20일 《로동신문》면소개",
              snippet: "다른 자료원이 로동신문을 언급한 기사입니다.",
              date: "2026-05-20",
              sourceId: "choson-sinbo",
              sourceName: "조선신보",
              sourceType: "archive",
              mediaType: "article",
              url: "https://chosonsinbo.com/2026/05/20sk-62/",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              _rankingScore: 0.99,
            },
            {
              id: "rodong-own-result",
              title: "경애하는 김정은동지께서 전군의 사,려단 지휘관회합을 소집하시고 그들을 만나시였다",
              snippet: "로동신문 자체 색인 기사입니다.",
              date: "2026-05-18",
              sourceId: "rodong-sinmun",
              sourceName: "로동신문",
              sourceType: "official_site",
              mediaType: "article",
              url: "http://www.rodong.rep.kp/index.php?fixture",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              _rankingScore: 0.41,
            },
          ],
          facetDistribution: {
            displaySourceId: {
              "choson-sinbo": 1,
              "rodong-sinmun": 12,
            },
          },
          estimatedTotalHits: 13,
          processingTimeMs: 2,
        }),
      };
    },
  });
  const result = await provider.searchDocuments("로동신문", { tab: "all", limit: 2 });

  assert.equal(requests[0].body.limit >= 100, true, "exact source-name backend searches should fetch a wider candidate window before client-side promotion");
  assert.equal(requests[0].body.offset, 0, "exact source-name backend searches should promote from the first backend candidate window");
  assert.equal(result.documents[0]?.sourceId, "rodong-sinmun", "Meilisearch exact source-name searches should prioritize the matching source's own documents");
  assert.equal(result.groupedSources[0]?.sourceId, "rodong-sinmun", "Meilisearch exact source-name searches should show the matching source group first");
  assert.equal(result.documents[0]?.backendScore, 0.41, "Meilisearch exact source promotion should preserve the raw backend score for diagnostics");
}

async function assertMeilisearchProviderKeepsFormattedSnippets() {
  const requests = [];
  const provider = new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      requests.push({ url, body });
      if (url.includes("dprk_suggestions")) {
        return {
          ok: true,
          json: async () => ({
            hits: [
              {
                id: "entity:hwaseong",
                label: "화성지구",
                aliases: ["화성"],
                type: "entity",
                description: "추천어",
                _rankingScore: 0.91,
                _formatted: {
                  label: "___DPRK_SEARCH_HIGHLIGHT_START___화성___DPRK_SEARCH_HIGHLIGHT_END___지구",
                },
              },
            ],
          }),
        };
      }
      if (body.q === "원산갈마해안관광지구") {
        return {
          ok: true,
          json: async () => ({
            hits: [
              {
                id: "meili-normalized-only-wonsan",
                title: "원산갈마해안관광지구 준공식 성대히 진행",
                snippet: "원산갈마해안관광지구 준공식 소식입니다.",
                date: "2026-05-17",
                sourceId: "kcna",
                sourceName: "조선중앙통신",
                sourceType: "official_site",
                mediaType: "article",
                url: "http://www.kcna.kp/kp/article/q/wonsan.kcmsf",
                archiveUrl: "",
                thumbnailUrl: "",
                language: "ko",
                aliases: [],
                _rankingScore: 0.66,
                _formatted: {
                  title: "원산갈마해안관광지구 준공식 성대히 진행",
                  snippet: "원산갈마해안관광지구 준공식 소식입니다.",
                  previewText: "",
                  searchSnippet: "",
                  searchBody: "",
                },
              },
            ],
            facetDistribution: {
              displaySourceId: {
                kcna: 1,
              },
            },
            estimatedTotalHits: 1,
            processingTimeMs: 2,
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          hits: [
            {
              id: "meili-hwaseong-body",
              title: "박태성 내각총리 여러 부문 사업 현지료해",
              snippet: "본문에서 매칭된 부분을 보여주어야 하는 결과입니다.",
              date: "2026-05-19",
              sourceId: "kcna",
              sourceName: "조선중앙통신",
              sourceType: "official_site",
              mediaType: "article",
              url: "http://www.kcna.kp/kp/article/q/example.kcmsf",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              previewText: "경애하는 김정은동지께서 화성지구 5단계 건설장에서 총리동지는 중요대상들의 시공정형을 구체적으로 료해하고",
              previewSourceName: "조선중앙통신",
              previewDocumentId: "preview-kcna",
              _rankingScore: 0.82,
              _formatted: {
                title: "박태성 내각총리 여러 부문 사업 현지료해",
                snippet: "본문에서 매칭된 부분을 보여주어야 하는 결과입니다.",
                previewText: "... 경애하는 김정은동지께서 ___DPRK_SEARCH_HIGHLIGHT_START___화성___DPRK_SEARCH_HIGHLIGHT_END___지구 5단계 건설장에서 총리동지는 중요대상들의 시공정형을 구체적으로 료해하고 ...",
                body: "... ___DPRK_SEARCH_HIGHLIGHT_START___화성___DPRK_SEARCH_HIGHLIGHT_END___지구 5단계 건설장에서 총리동지는 중요대상들의 시공정형을 구체적으로 료해하고 ...",
              },
            },
            {
              id: "meili-duplicated-kcna-watch-snippet",
              title: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행",
              snippet: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행 사회주의문명의 눈부신 개화를 우리 땅에서 펼치고있습니다. June 26, 2025 사회주의문명의 눈부신 개화를 우리 땅에서 펼치고있습니다.",
              date: "2026-05-18",
              sourceId: "kcna-watch",
              sourceName: "KCNA Watch",
              sourceType: "archive",
              mediaType: "article",
              url: "https://kcnawatch.org/newstream/meili-duplicated",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              _rankingScore: 0.51,
              _formatted: {
                title: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행",
                snippet: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행 ___DPRK_SEARCH_HIGHLIGHT_START___사회주의문명___DPRK_SEARCH_HIGHLIGHT_END___의 눈부신 개화를 우리 땅에서 펼치고있습니다. June 26, 2025 ___DPRK_SEARCH_HIGHLIGHT_START___사회주의문명___DPRK_SEARCH_HIGHLIGHT_END___의 눈부신 개화를 우리 땅에서 펼치고있습니다.",
                previewText: "",
                body: "",
              },
            },
          ],
          facetDistribution: {
            displaySourceId: {
              kcna: 9,
            },
          },
          estimatedTotalHits: 1,
          processingTimeMs: 3,
        }),
      };
    },
  });
  const result = await provider.searchDocuments("화성");
  const suggestions = await provider.getSuggestions("화성");
  const normalizedOnlyResult = await provider.searchDocuments("원산 갈마");

  assert.equal(result.documents[0]?.displaySnippet.includes("화성지구"), true, "Meilisearch provider should preserve cropped formatted body snippets");
  assert.equal(result.documents[0]?.displaySnippet.includes("경애하는 김정은동지"), true, "Meilisearch provider should prefer enriched previewText when the backend formats it");
  assert.equal(result.documents[1]?.displaySnippet.startsWith(result.documents[1]?.title || ""), false, "Meilisearch result snippets should not repeat the already visible result title");
  assert.equal(/June 26, 2025/.test(result.documents[1]?.displaySnippet || ""), false, "Meilisearch result snippets should hide KCNA Watch English date separators");
  assert.equal((result.documents[1]?.displaySnippet.match(/사회주의문명의 눈부신 개화/g) || []).length, 1, "Meilisearch result snippets should collapse date-separated duplicate text");
  assert.deepEqual(result.documents[1]?.highlightRanges.snippet, [{ start: 0, end: 6 }], "Meilisearch snippet cleanup should remap highlight ranges into the cleaned text");
  assert.equal(result.documents[0]?.previewSourceName, "조선중앙통신", "Meilisearch provider should expose enriched preview provenance");
  assert.equal(result.documents[0]?.previewDocumentId, "preview-kcna", "Meilisearch provider should expose the enriched preview source document id");
  assert.equal(result.groupedSources[0]?.total, 9, "Meilisearch grouped source totals should use backend source facets");
  assert.equal(result.groupedSources[0]?.results.length, 1, "Meilisearch grouped source previews should still contain returned hits only");
  assert.deepEqual(result.documents[0]?.highlightRanges.snippet, [{ start: 17, end: 19 }], "Meilisearch provider should convert custom formatted markers to snippet highlight ranges");
  assert.deepEqual(result.documents[0]?.highlightRanges.title, [], "Meilisearch provider should not invent title highlights");
  assert.equal(normalizedOnlyResult.documents[0]?.displaySnippet.includes("원산갈마해안관광지구"), true, "Meilisearch provider should recover a query-aware snippet when the backend matched normalizedText without formatted highlights");
  assert.equal(normalizedOnlyResult.documents[0]?.highlightRanges.title.length > 0, true, "Meilisearch provider should recover title highlights when normalizedText matches do not format title highlights");
  assert.equal(normalizedOnlyResult.documents[0]?.highlightRanges.snippet.length > 0, true, "Meilisearch provider should recover snippet highlights when normalizedText matches do not format snippet highlights");
  assert.deepEqual(suggestions[0]?.highlightRanges, [{ start: 0, end: 2 }], "Meilisearch suggestions should convert formatted labels into highlight ranges");
  assert.equal(result.documents[0]?.score, 0.82, "Meilisearch document results should expose backend ranking scores");
  assert.equal(suggestions[0]?.score, 0.91, "Meilisearch suggestions should expose backend ranking scores");
  assert.equal(suggestions[0]?.type, "entity", "Meilisearch suggestions should preserve suggestion types");
  assert.equal(suggestions[0]?.description, "추천어", "Meilisearch suggestions should preserve provenance descriptions");
  assert.equal(requests[0].body.attributesToHighlight.includes("previewText"), true, "Meilisearch documents should request enriched preview highlighting");
  assert.equal(requests[0].body.attributesToHighlight.includes("searchBody"), true, "Meilisearch documents should request dateline-stripped body highlighting");
  assert.equal(requests[0].body.cropLength, 36, "Meilisearch documents should request a compact body crop");
  assert.equal(requests[1].body.showRankingScore, true, "Meilisearch suggestions should request ranking scores");
}

async function assertMeilisearchProviderCompletesSearchOperators() {
  const requests = [];
  const provider = new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, body: JSON.parse(options.body || "{}") });
      return {
        ok: true,
        json: async () => ({ hits: [], estimatedTotalHits: 0, processingTimeMs: 0 }),
      };
    },
  });
  const suggestions = await provider.getSuggestions("사이트:kc");

  assert.equal(suggestions.some((suggestion) => suggestion.label === "사이트:kcna.kp"), true, "Meilisearch provider should complete structured operator prefixes before hitting the backend");
  assert.equal(suggestions.every((suggestion) => suggestion.type === "operator"), true, "Meilisearch operator completions should be marked as operator suggestions");
  assert.deepEqual(requests, [], "operator autocomplete should not spend a backend Meilisearch request");
}

async function assertMeilisearchProviderNormalizesQueries() {
  const requests = [];
  const provider = new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, body: JSON.parse(options.body || "{}") });
      return {
        ok: true,
        json: async () => ({ hits: [], estimatedTotalHits: 0, processingTimeMs: 0 }),
      };
    },
  });

  const consonantResults = await provider.searchDocuments("ㄱㅈㅇ");
  const consonantSuggestions = await provider.getSuggestions("ㄱㅈㅇ");
  await provider.searchDocuments("rla wjddms");
  await provider.getSuggestions("김정ㅇ");
  await provider.searchDocuments("Korean");
  await provider.searchDocuments("원산 갈마");
  await provider.searchDocuments("Wonsan");
  await provider.searchDocuments("Kim Jong Un Wonsan Kalma");
  await provider.searchDocuments("평양 야경");

  assert.equal(consonantResults.status, "empty_query", "Meilisearch provider should not search pure 초성 queries");
  assert.deepEqual(consonantResults.documents, [], "Meilisearch pure 초성 document search should stay empty");
  assert.deepEqual(consonantSuggestions, [], "Meilisearch pure 초성 suggestions should stay disabled");
  assert.deepEqual(requests.map((request) => request.body.q), ["김정은", "김정은", "Korean", "원산갈마해안관광지구", "원산갈마해안관광지구", "김정은 원산갈마해안관광지구", "평양 야경"], "Meilisearch query normalization should match local search policy while preserving strict arbitrary Korean multi-term queries and canonicalizing known entities");
}

async function assertGroupedResultsKeepSourceMetadata() {
  const grouped = groupResultsBySource([
    {
      id: "result-1",
      title: "첫 결과",
      sourceId: "minju-choson",
      sourceName: "민주조선",
      sourceType: "official_site",
    },
    {
      id: "result-2",
      title: "둘째 결과",
      sourceId: "minju-choson",
      sourceName: "민주조선",
      sourceType: "official_site",
    },
  ], ["민주조선"]);

  assert.equal(grouped[0].sourceId, "minju-choson", "grouped result should preserve sourceId for source filtering");
  assert.equal(grouped[0].total, 2, "grouped result should preserve source result count");

  const relevanceGrouped = groupResultsBySource([
    {
      id: "lower-score",
      title: "낮은 점수",
      sourceId: "ryugyong",
      sourceName: "류경",
      sourceType: "official_site",
      score: 780,
    },
    {
      id: "higher-score",
      title: "높은 점수",
      sourceId: "kcna-watch",
      sourceName: "KCNA Watch",
      sourceType: "archive",
      score: 1040,
    },
  ], ["류경", "KCNA Watch"]);
  assert.equal(relevanceGrouped[0].sourceId, "kcna-watch", "source groups should follow query relevance before static catalog order");

  const displayedArchiveGrouped = groupResultsBySource([
    {
      id: "kcna-watch-rodong",
      title: "보존본",
      sourceId: "kcna-watch",
      sourceName: "KCNA Watch",
      sourceType: "archive",
      displaySourceId: "rodong-sinmun",
      displaySourceName: "로동신문",
      displaySourceType: "official_site",
      score: 1040,
    },
  ], ["로동신문"]);
  assert.equal(displayedArchiveGrouped[0].sourceId, "kcna-watch", "grouped archive-origin results should stay under the archive source group");
  assert.equal(displayedArchiveGrouped[0].sourceName, "KCNA Watch", "grouped archive-origin results should display the physical archive source");

  const previewGrouped = groupResultsBySource([
    {
      id: "result-preview",
      title: "미리보기 결과",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      sourceType: "official_site",
    },
  ], ["조선중앙통신"], [
    {
      id: "result-preview",
      title: "미리보기 결과",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      sourceType: "official_site",
    },
    {
      id: "result-hidden",
      title: "다음 페이지 결과",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      sourceType: "official_site",
    },
  ]);

  assert.equal(previewGrouped[0].results.length, 1, "grouped previews should keep only the returned page slice");
  assert.equal(previewGrouped[0].total, 2, "grouped previews should expose the full source match total");
}

async function assertDuplicateStoryResultsAreCollapsed() {
  const duplicateResults = [
    {
      id: "kcna-watch-duplicate-1",
      title: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행",
      snippet: "첫번째 색인 경로입니다.",
      date: "2026-05-19",
      sourceId: "kcna-watch",
      sourceName: "KCNA Watch",
      sourceType: "archive",
      mediaType: "article",
    },
    {
      id: "kcna-watch-duplicate-2",
      title: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행",
      snippet: "두번째 색인 경로입니다.",
      date: "2026-05-20",
      sourceId: "kcna-watch",
      sourceName: "KCNA Watch",
      sourceType: "archive",
      mediaType: "article",
    },
    {
      id: "kcna-watch-image-1",
      title: "원산갈마해안관광지구",
      snippet: "이미지 1",
      date: "2026-05-19",
      sourceId: "kcna-watch",
      sourceName: "KCNA Watch",
      sourceType: "archive",
      mediaType: "image",
    },
    {
      id: "kcna-watch-image-2",
      title: "원산갈마해안관광지구",
      snippet: "이미지 2",
      date: "2026-05-19",
      sourceId: "kcna-watch",
      sourceName: "KCNA Watch",
      sourceType: "archive",
      mediaType: "image",
    },
  ];
  const collapsed = collapseDuplicateResults(duplicateResults);
  const dedupedForStorage = dedupeDocumentsByStory(duplicateResults);

  assert.deepEqual(
    collapsed.map((document) => document.id),
    ["kcna-watch-duplicate-1", "kcna-watch-image-1", "kcna-watch-image-2"],
    "duplicate article/story records should collapse while distinct image media remains visible",
  );
  assert.deepEqual(
    dedupedForStorage.map((document) => document.id),
    ["kcna-watch-duplicate-2", "kcna-watch-image-1", "kcna-watch-image-2"],
    "production import storage should dedupe collapsible story records before seeding backend search",
  );

  const productionDocuments = parseJsonl(await fs.readFile(PRODUCTION_DOCUMENTS_PATH, "utf8"));
  const storedStoryKeys = productionDocuments.map(createResultStoryKey).filter(Boolean);
  const productionSources = await readJson(path.join(ROOT_DIR, "data/search/sources.json"));
  const provider = new LocalJsonSearchProvider({ documents: productionDocuments, sources: productionSources });
  const result = await provider.searchDocuments("원산갈마", { tab: "all", limit: 100 });
  const kcnaWatchTitleKeys = result.documents
    .filter((document) => document.sourceId === "kcna-watch")
    .map((document) => `${document.displaySourceId || document.sourceId}:${document.title.replace(/\s+/g, "")}`);

  assert.equal(
    kcnaWatchTitleKeys.length,
    new Set(kcnaWatchTitleKeys).size,
    "local search results should not show repeated KCNA Watch article copies for the same visible source/story",
  );
  assert.equal(
    storedStoryKeys.length,
    new Set(storedStoryKeys).size,
    "production search storage should not ship duplicate collapsible article/story records",
  );
}

async function assertVoiceOfKoreaChromeDoesNotWinPreviewSelection() {
  const chromeText = "vok\n첫페지로\n어종선택\nDeutsch\nРусский\n汉 语\nFrançais\nالعربية\nEnglish\n日 本 語\nEspañol\n《조선의 소리》조선어방송편집부 www.vok.rep.kpE mail: vok@star co.net.kp";
  const baseDocument = {
    id: "voice-of-korea-chrome-fixture",
    title: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행",
    snippet: "원산갈마해안관광지구 준공식 소식",
    date: "2025-06-26",
    sourceId: "voice-of-korea",
    sourceName: "조선의 소리",
    sourceType: "official_site",
    mediaType: "article",
    url: "http://www.vok.rep.kp/index.php/revo_de/getDetail/ikn250625008/ko",
    archiveUrl: "",
    thumbnailUrl: "",
    language: "ko",
    aliases: [],
  };
  const chromeDocument = {
    ...baseDocument,
    body: chromeText,
    snippet: "《조선의 소리》조선어방송편집부 www.vok.rep.kpE mail: vok@star co.net.kp",
  };
  const fallbackDocument = {
    ...baseDocument,
    body: "",
  };
  const richDocument = {
    ...baseDocument,
    id: "voice-of-korea-rich-fixture",
    snippet: "원산갈마해안관광지구 준공식이 성대히 진행되였다.",
    body: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식이 성대히 진행되였다. 여러 나라 언론들도 이 소식을 보도하였다.",
  };

  assert.equal(isWeakDocumentPreview(chromeDocument), true, "조선의 소리 language-selector chrome should be treated as a weak article preview");
  assert.equal(cleanDisplaySnippetText(chromeText, baseDocument.title), "", "result snippets should suppress 조선의 소리 language-selector chrome");
  assert.equal(
    dedupeDocumentsByStory([chromeDocument, fallbackDocument])[0].body,
    "",
    "dedupe should prefer a clean source fallback over 조선의 소리 page chrome for the same document id",
  );
  assert.equal(
    dedupeDocumentsByStory([fallbackDocument, richDocument])[0].id,
    "voice-of-korea-rich-fixture",
    "dedupe should still prefer a real 조선의 소리 body over a title-only fallback",
  );
  assert.equal(
    findRicherPreviewRecord(chromeDocument, [chromeDocument, richDocument])?.id,
    richDocument.id,
    "preview enrichment should recover a richer same-story body when 조선의 소리 only has page chrome",
  );

  const enriched = enrichSearchResultPreviews([chromeDocument], [chromeDocument, richDocument], "원산갈마")[0];
  assert.equal(enriched.previewDocumentId, richDocument.id, "search results should disclose the richer record used for a weak 조선의 소리 preview");
  assert.equal(enriched.displaySnippet.includes("원산갈마해안관광지구"), true, "search results should show substantive same-story text instead of VOK chrome");
}

async function assertEquivalentSourceTitlesCanShareRicherPreviews() {
  const weakMinjuDocument = {
    id: "minju-equivalent-title-fixture",
    title: "２０２６년 아시아축구련맹 １７살미만 녀자아시아컵경기대회에서 우승한 우리 선수들 귀국",
    snippet: "２０２６년 아시아축구련맹 １７살미만 녀자아시아컵경기대회에서 우승한 우리 선수들 귀국 [2026-05-20]",
    body: "２０２６년 아시아축구련맹 １７살미만 녀자아시아컵경기대회에서 우승한 우리 선수들 귀국 [2026-05-20]",
    date: "2026-05-20",
    sourceId: "minju-choson",
    sourceName: "민주조선",
    sourceType: "official_site",
    mediaType: "article",
    url: "http://www.minju.rep.kp/Home/index/disp/8558/ko",
    archiveUrl: "",
    thumbnailUrl: "",
    language: "ko",
    aliases: [],
  };
  const richChosonSinboDocument = {
    ...weakMinjuDocument,
    id: "choson-sinbo-equivalent-title-fixture",
    title: "2026년 아시아축구련맹 17살이하 녀자아시아컵경기대회에서 우승한 조선선수들 귀국",
    snippet: "2026년 아시아축구련맹 17살이하 녀자아시아컵경기대회에서 우승한 조선선수들이 귀국하였다.",
    body: "2026년 아시아축구련맹 17살이하 녀자아시아컵경기대회에서 우승한 조선선수들이 귀국하였다. 선수들은 국제경기에서의 성과를 안고 평양에 도착하였으며 관계부문 일군들과 가족들의 따뜻한 환영을 받았다.",
    sourceId: "choson-sinbo",
    sourceName: "조선신보",
    sourceType: "archive",
    url: "https://chosonsinbo.com/ko/2026/05/example",
  };
  const unrelatedRichDocument = {
    ...weakMinjuDocument,
    id: "voice-of-korea-unrelated-title-fixture",
    title: "박태성동지가 벌가리아공화국 수상에게 축전을 보내였다",
    snippet: "박태성동지가 벌가리아공화국 수상에게 축전을 보내였다.",
    body: "박태성동지가 벌가리아공화국 수상에게 축전을 보내였다. 축전은 두 나라사이의 친선협조관계가 앞으로도 계속 발전하리라는 확신을 표명하였다. 정부 관계자들은 여러 분야에서의 교류와 협조를 확대해나갈 립장을 밝혔다.",
    sourceId: "voice-of-korea",
    sourceName: "조선의 소리",
    url: "http://www.vok.rep.kp/index.php/revo_de/getDetail/example/ko",
  };
  const weakKcnaWatchServiceDocument = {
    ...weakMinjuDocument,
    id: "kcna-watch-service-fixture",
    title: "원산갈마해안관광지구 봉사 시작",
    snippet: "(평양 7월 2일발 조선중앙통신)우리 당의 인민대중제일주의정치, 이민위천의 우리식 사회주의제도가 받들어올린 동해의 국보급관광명소 원",
    body: "원산갈마해안관광지구 봉사 시작 (평양 7월 2일발 조선중앙통신)우리 당의 인민대중제일주의정치, 이민위천의 우리식 사회주의제도가 받들어올린 동해의 국보급관광명소 원",
    date: "2025-07-02",
    sourceId: "kcna-watch",
    sourceName: "KCNA Watch",
    sourceType: "archive",
    url: "https://kcnawatch.org/newstream/example/wonsan-kalma-service-start",
  };
  const richKcnaServiceDocument = {
    ...weakKcnaWatchServiceDocument,
    id: "kcna-service-rich-fixture",
    title: "원산갈마해안관광지구에서 봉사 시작",
    snippet: "원산갈마해안관광지구에서 관광봉사가 시작되였다.",
    body: "원산갈마해안관광지구에서 관광봉사가 시작되였다. 우리 당의 인민대중제일주의정치, 이민위천의 우리식 사회주의제도가 받들어올린 동해의 국보급관광명소에서 인민들의 웃음소리가 높이 울려퍼졌다. 봉사망들과 해수욕봉사시설들, 상업 및 급양봉사시설들이 운영을 시작하였다.",
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    sourceType: "official_site",
    url: KCNA_WONSAN_KALMA_SERVICE_URL,
  };
  const weakKcnaWatchCeremonyDocument = {
    ...weakKcnaWatchServiceDocument,
    id: "kcna-watch-ceremony-fixture",
    title: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행",
    snippet: "사회주의문명의 눈부신 개화를 우리 땅에서 우리의 자원을 가지고 우리 식으로 안아오려는 조선로동당의 견결한 혁명의지에 의하여 전국각",
    body: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식 성대히 진행 사회주의문명의 눈부신 개화를 우리 땅에서 우리의 자원을 가지고 우리 식으로 안아오려는 조선로동당의 견결한 혁명의지에 의하여 전국각",
    date: "2025-06-26",
  };
  const richRodongCeremonyDocument = {
    ...weakKcnaWatchCeremonyDocument,
    id: "rodong-ceremony-rich-fixture",
    snippet: "원산갈마해안관광지구 준공식이 성대히 진행되였다.",
    body: "사회주의문명개화의 새 경관을 펼친 동해기슭의 관광명소 원산갈마해안관광지구 준공식이 성대히 진행되였다. 예로부터 뛰여난 경관으로 널리 알려진 해안지대의 풍치와 조화를 이루며 각양각태의 현대미를 발산하는 수백동의 건물들이 완벽한 예술적호환성과 련결성을 이루었다. 김정은동지께서 준공식에 참석하시였다.",
    sourceId: "rodong-sinmun",
    sourceName: "로동신문",
    sourceType: "official_site",
  };
  const abbreviatedKcnaWatchCeremonyDocument = {
    ...weakKcnaWatchCeremonyDocument,
    id: "kcna-watch-ceremony-abbreviated-fixture",
    title: "원산갈마해안관광지구 준공식 김정은총비서 참석",
    snippet: "원산갈마해안관광지구 준공식 김정은총비서 참석 (평양 6월 26일발 조선중앙통신)사회주의문명의 눈부신 개화를 우리 땅에서 우리의 자원을 가지고 우리 식으로",
    body: "원산갈마해안관광지구 준공식 김정은총비서 참석 (평양 6월 26일발 조선중앙통신)사회주의문명의 눈부신 개화를 우리 땅에서 우리의 자원을 가지고 우리 식으로",
  };
  const richChosonSinboCeremonyDocument = {
    ...richRodongCeremonyDocument,
    id: "choson-sinbo-ceremony-rich-fixture",
    title: "원산갈마해안관광지구 준공식 성대히 진행/김정은원수님께서 참석",
    sourceId: "choson-sinbo",
    sourceName: "조선신보",
    sourceType: "archive",
  };

  assert.equal(isWeakDocumentPreview(weakMinjuDocument), true, "민주조선 date/title-only listing entries should be weak previews");
  assert.equal(isWeakDocumentPreview(richChosonSinboDocument), false, "same-story 조선신보 article text should be rich enough for preview reuse");
  assert.equal(isWeakDocumentPreview(weakKcnaWatchCeremonyDocument), true, "truncated KCNA Watch preserved article excerpts should be treated as weak previews");
  assert.equal(
    findRicherPreviewRecord(weakMinjuDocument, [weakMinjuDocument, richChosonSinboDocument])?.id,
    richChosonSinboDocument.id,
    "preview enrichment should connect equivalent DPRK source titles despite width and wording differences",
  );
  assert.equal(
    findRicherPreviewRecord(weakMinjuDocument, [weakMinjuDocument, unrelatedRichDocument]),
    null,
    "preview enrichment should not attach a rich body from an unrelated same-date story",
  );
  assert.equal(
    findRicherPreviewRecord(weakKcnaWatchServiceDocument, [weakKcnaWatchServiceDocument, richKcnaServiceDocument])?.id,
    richKcnaServiceDocument.id,
    "preview enrichment should connect KCNA Watch preserved copies to richer official KCNA detail text when source titles only differ by particles",
  );
  assert.equal(
    findRicherPreviewRecord(weakKcnaWatchCeremonyDocument, [weakKcnaWatchCeremonyDocument, richRodongCeremonyDocument])?.id,
    richRodongCeremonyDocument.id,
    "preview enrichment should recover full same-title ceremony text for truncated KCNA Watch preserved copies",
  );
  assert.equal(
    findRicherPreviewRecord(abbreviatedKcnaWatchCeremonyDocument, [abbreviatedKcnaWatchCeremonyDocument, richChosonSinboCeremonyDocument])?.id,
    richChosonSinboCeremonyDocument.id,
    "preview enrichment should connect abbreviated KCNA Watch ceremony titles to richer same-day source titles with equivalent Kim Jong Un honorific wording",
  );
}

async function assertSourceFacetsExposeRealCounts() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "minju-choson",
        name: "민주조선",
        sourceType: "official_site",
        baseUrl: "http://www.minju.rep.kp/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: ["Minju Choson"],
      },
      {
        id: "kcna",
        name: "조선중앙통신",
        sourceType: "official_site",
        baseUrl: "http://www.kcna.kp/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: ["KCNA"],
      },
      {
        id: "rodong-sinmun",
        name: "로동신문",
        sourceType: "official_site",
        baseUrl: "http://www.rodong.rep.kp/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: ["Rodong Sinmun"],
      },
    ],
    documents: [
      {
        id: "fixture-minju-source-facet",
        title: "평양 소식",
        snippet: "평양 관련 민주조선 기사입니다.",
        date: "2026-05-19",
        sourceId: "minju-choson",
        sourceName: "민주조선",
        sourceType: "official_site",
        mediaType: "article",
        url: "http://www.minju.rep.kp/fixture",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-kcna-source-facet-1",
        title: "평양 보도",
        snippet: "평양 관련 조선중앙통신 기사입니다.",
        date: "2026-05-19",
        sourceId: "kcna",
        sourceName: "조선중앙통신",
        sourceType: "official_site",
        mediaType: "article",
        url: "http://www.kcna.kp/fixture-1",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-kcna-source-facet-2",
        title: "평양 새 소식",
        snippet: "평양 관련 조선중앙통신 추가 기사입니다.",
        date: "2026-05-18",
        sourceId: "kcna",
        sourceName: "조선중앙통신",
        sourceType: "official_site",
        mediaType: "article",
        url: "http://www.kcna.kp/fixture-2",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const result = await provider.searchDocuments("평양");
  const sourceFiltered = await provider.searchDocuments("평양", { sourceIds: ["minju-choson"] });
  const emptySourceFiltered = await provider.searchDocuments("평양", { sourceIds: ["rodong-sinmun"] });
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");
  const css = await fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8");

  assert.deepEqual(
    result.sourceFacets.map(({ sourceId, count }) => ({ sourceId, count })),
    [{ sourceId: "kcna", count: 2 }, { sourceId: "minju-choson", count: 1 }],
    "provider should expose source facet counts from the full matched result set",
  );
  assert.deepEqual(
    sourceFiltered.sourceFacets.map(({ sourceId, count }) => ({ sourceId, count })),
    [{ sourceId: "kcna", count: 2 }, { sourceId: "minju-choson", count: 1 }],
    "active source filtering should not erase the facet counts needed to switch source",
  );
  assert.deepEqual(emptySourceFiltered.documents, [], "source-filtered zero-result pages should be possible without losing the provider response");
  assert.deepEqual(
    emptySourceFiltered.sourceFacets.map(({ sourceId, count }) => ({ sourceId, count })),
    [{ sourceId: "kcna", count: 2 }, { sourceId: "minju-choson", count: 1 }],
    "zero-result source filters should still expose unscoped facet counts for recovery",
  );
  assert.equal(portalSource.includes("createSourceFacetFilters"), true, "results UI should render source facet filters");
  assert.equal(portalSource.includes("...(sourceFacets ? [sourceFacets] : []),\n      createNoResultsState"), true, "no-result source-filter pages should still render source facet recovery navigation");
  assert.equal(portalSource.includes("if (!visibleSourceIds.size) return sourceFilter.sourceId;"), true, "source-filtered no-result pages should not mark 전체 as the active facet");
  assert.equal(portalSource.includes('label: "전체"'), true, "source facets should include an all-sources reset chip");
  assert.equal(portalSource.includes("search-source-facet-all"), true, "all-sources facet should have a stable class");
  assert.equal(portalSource.includes("자료원 필터"), true, "source facets should have an accessible navigation label");
  assert.equal(portalSource.includes("createSourceFacetAccessibleLabel"), true, "source facet links should expose source names and counts as readable accessible labels");
  assert.equal(portalSource.includes('link.setAttribute("aria-label", createSourceFacetAccessibleLabel(label, count, isActive))'), true, "source facet accessible labels should not depend on adjacent inline text");
  assert.equal(portalSource.includes("countNode.textContent = formatCount(count)"), true, "source facet visible counts should use localized number formatting");
  assert.equal(portalSource.includes("visibleFacets.slice"), false, "results UI must not silently truncate configured source facets");
  assert.equal(css.includes(".search-source-facets"), true, "source facets should have scoped styling");
  assert.equal(css.includes(".search-source-facet-all"), true, "all-sources facet should have scoped styling");
}

async function assertLocalSourceFiltersUsePhysicalSourceIds() {
  const sources = [
    {
      id: "kcna-watch",
      name: "KCNA Watch",
      sourceType: "archive",
      baseUrl: "https://kcnawatch.org/",
      languages: ["ko"],
      mediaTypes: ["article"],
      aliases: ["KCNAWatch"],
    },
    {
      id: "rodong-sinmun",
      name: "로동신문",
      sourceType: "official_site",
      baseUrl: "http://www.rodong.rep.kp/",
      languages: ["ko"],
      mediaTypes: ["article"],
      aliases: ["Rodong Sinmun"],
    },
  ];
  const documents = [
    {
      id: "fixture-archive-rodong-visible",
      title: "원산갈마 준공식 로동신문",
      snippet: "원산갈마 준공식 보도입니다.",
      date: "2026-05-20",
      sourceId: "kcna-watch",
      sourceName: "KCNA Watch",
      sourceType: "archive",
      displaySourceId: "rodong-sinmun",
      displaySourceName: "로동신문",
      displaySourceType: "official_site",
      mediaType: "article",
      url: "https://kcnawatch.org/newstream/rodong",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-archive-kcna-watch-visible",
      title: "원산갈마 준공식 KCNA Watch",
      snippet: "원산갈마 준공식 보관 출처 미확인 보도입니다.",
      date: "2026-05-20",
      sourceId: "kcna-watch",
      sourceName: "KCNA Watch",
      sourceType: "archive",
      mediaType: "article",
      url: "https://kcnawatch.org/newstream/archive",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const rodongFiltered = await provider.searchDocuments("원산갈마", { sourceIds: ["rodong-sinmun"] });
  const kcnaWatchFiltered = await provider.searchDocuments("원산갈마", { sourceIds: ["kcna-watch"] });
  const [providerSource, cliSource] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/LocalJsonSearchProvider.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/search-local.ts"), "utf8"),
  ]);

  assert.deepEqual(
    rodongFiltered.documents.map((document) => document.id),
    [],
    "local source filters should not put KCNA Watch preserved copies under the original source facet",
  );
  assert.deepEqual(
    kcnaWatchFiltered.documents.map((document) => document.id),
    ["fixture-archive-rodong-visible", "fixture-archive-kcna-watch-visible"],
    "local source filters should keep KCNA Watch preserved copies under the KCNA Watch facet",
  );
  assert.equal(
    providerSource.includes("return sourceIds.includes(getResultDisplaySourceId(document));"),
    true,
    "LocalJsonSearchProvider source filters should match Meilisearch sourceId filter semantics",
  );
  assert.equal(cliSource.includes('getArgumentValue("--source")'), true, "local search CLI should expose the same source filter for debugging");
}

async function assertSearchOperatorsUseVisibleSourceFilters() {
  const sources = [
    {
      id: "rodong-sinmun",
      name: "로동신문",
      sourceType: "official_site",
      baseUrl: "http://www.rodong.rep.kp/",
      languages: ["ko"],
      mediaTypes: ["article", "pdf", "image"],
      aliases: ["Rodong Sinmun", "Rodong"],
    },
    {
      id: "kcna",
      name: "조선중앙통신",
      sourceType: "official_site",
      baseUrl: "http://www.kcna.kp/",
      languages: ["ko", "en"],
      mediaTypes: ["article"],
      aliases: ["KCNA"],
    },
    {
      id: "voice-of-korea",
      name: "조선의 소리",
      sourceType: "official_site",
      baseUrl: "http://www.vok.rep.kp/",
      languages: ["ko", "en"],
      mediaTypes: ["article", "broadcast"],
      aliases: ["Voice of Korea", "VOK"],
    },
  ];
  const documents = [
    {
      id: "fixture-site-rodong",
      title: "원산갈마 로동신문",
      snippet: "원산갈마 준공식 로동신문 보도이며 원산문헌 검색에서도 확인되는 기사입니다.",
      date: "2026-05-20",
      sourceId: "rodong-sinmun",
      sourceName: "로동신문",
      sourceType: "official_site",
      mediaType: "article",
      url: "http://www.rodong.rep.kp/fixture",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-site-kcna",
      title: "원산갈마 조선중앙통신",
      snippet: "원산갈마 준공식 조선중앙통신 보도입니다.",
      date: "2026-05-20",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      sourceType: "official_site",
      mediaType: "article",
      url: "http://www.kcna.kp/fixture",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-site-vok",
      title: "원산갈마 조선의 소리",
      snippet: "원산갈마 준공식 조선의 소리 보도입니다.",
      date: "2026-05-19",
      sourceId: "voice-of-korea",
      sourceName: "조선의 소리",
      sourceType: "official_site",
      mediaType: "article",
      url: "http://www.vok.rep.kp/index.php/revo_de/getDetail/fixture/ko",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-filetype-pdf",
      title: "원산문헌 PDF",
      snippet: "원산문헌 문헌 검색 자료입니다.",
      date: "2026-05-18",
      sourceId: "rodong-sinmun",
      sourceName: "로동신문",
      sourceType: "official_site",
      mediaType: "pdf",
      url: "http://www.rodong.rep.kp/fixture.pdf",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-site-rodong-image",
      title: "매체 순서 사진",
      snippet: "검색어 없는 출처 필터에서 이미지는 기사와 문헌 뒤에 놓여야 합니다.",
      date: "2026-12-31",
      sourceId: "rodong-sinmun",
      sourceName: "로동신문",
      sourceType: "official_site",
      mediaType: "image",
      url: "http://www.rodong.rep.kp/fixture.jpg",
      archiveUrl: "",
      thumbnailUrl: "http://www.rodong.rep.kp/fixture.jpg",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-date-new",
      title: "기간 검색 최신",
      snippet: "기간 검색 범위 안에 있는 기사입니다.",
      date: "2026-05-20",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      sourceType: "official_site",
      mediaType: "article",
      url: "http://www.kcna.kp/date-new",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-date-old",
      title: "기간 검색 과거",
      snippet: "기간 검색 범위 밖에 있는 기사입니다.",
      date: "2025-06-26",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      sourceType: "official_site",
      mediaType: "article",
      url: "http://www.kcna.kp/date-old",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    },
    {
      id: "fixture-language-en",
      title: "Wonsan Kalma report",
      snippet: "English Wonsan Kalma coverage.",
      date: "2026-05-19",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      sourceType: "official_site",
      mediaType: "article",
      url: "http://www.kcna.kp/language-en",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "en",
      aliases: [],
    },
  ];
  const provider = new LocalJsonSearchProvider({ sources, documents });
  const siteResult = await provider.searchDocuments("site:rodong.rep.kp 원산갈마");
  const siteCurlyQuotedResult = await provider.searchDocuments("site:“rodong.rep.kp” 원산갈마");
  const siteParenthesizedValueResult = await provider.searchDocuments("site:(rodong.rep.kp) 원산갈마");
  const siteParentDomainResult = await provider.searchDocuments("site:rep.kp 원산갈마");
  const siteWildcardParentDomainResult = await provider.searchDocuments("site:*.rep.kp 원산갈마");
  const siteTldResult = await provider.searchDocuments("site:kp 원산갈마");
  const siteKoreanAliasResult = await provider.searchDocuments("사이트:rep.kp 원산갈마");
  const siteDomainAliasResult = await provider.searchDocuments("domain:kp 원산갈마");
  const siteOrSourceResult = await provider.searchDocuments("site:rodong.rep.kp OR site:vok.rep.kp 원산갈마");
  const parenthesizedSiteOrSourceResult = await provider.searchDocuments("(site:rodong.rep.kp OR site:vok.rep.kp) 원산갈마");
  const siteOrSourceOnlyResult = await provider.searchDocuments("site:rodong.rep.kp OR site:vok.rep.kp");
  const siteAndSourceResult = await provider.searchDocuments("site:rodong.rep.kp AND 원산갈마");
  const parenthesizedSiteResult = await provider.searchDocuments("(site:rep.kp) 원산갈마");
  const siteOnlyResult = await provider.searchDocuments("site:rodong.rep.kp");
  const siteExcludedOnlyResult = await provider.searchDocuments("site:rodong.rep.kp -원산");
  const negativeSiteResult = await provider.searchDocuments("-site:kcna.kp 원산갈마");
  const parenthesizedNegativeSiteResult = await provider.searchDocuments("원산갈마 -(site:kcna.kp)");
  const negativeParentDomainSiteResult = await provider.searchDocuments("-site:rep.kp 원산갈마");
  const negativeWildcardParentDomainSiteResult = await provider.searchDocuments("-site:*.rep.kp 원산갈마");
  const negativeTldSiteResult = await provider.searchDocuments("-site:kp 원산갈마");
  const negativeParenthesizedValueSiteResult = await provider.searchDocuments("-site:(kcna.kp) 원산갈마");
  const notSiteResult = await provider.searchDocuments("원산갈마 NOT site:kcna.kp");
  const notParenthesizedSiteResult = await provider.searchDocuments("원산갈마 NOT (site:kcna.kp)");
  const notUppercaseSiteResult = await provider.searchDocuments("원산갈마 NOT SITE:kcna.kp");
  const sourceResult = await provider.searchDocuments('source:"조선중앙통신" 원산갈마');
  const sourceKoreanAliasResult = await provider.searchDocuments("출처:로동신문 원산갈마");
  const sourceCurlyQuotedResult = await provider.searchDocuments("source:“조선중앙통신” 원산갈마");
  const sourceCurlySingleQuotedResult = await provider.searchDocuments("source:‘로동신문’ 원산갈마");
  const sourceParenthesizedValueResult = await provider.searchDocuments("source:(로동신문) 원산갈마");
  const filetypeResult = await provider.searchDocuments("filetype:pdf 원산문헌");
  const filetypeKoreanAliasResult = await provider.searchDocuments("파일형식:pdf 원산문헌");
  const mediaKoreanAliasResult = await provider.searchDocuments("매체:문헌 원산문헌");
  const filetypeCurlyQuotedResult = await provider.searchDocuments("filetype:“pdf” 원산문헌");
  const filetypeParenthesizedValueResult = await provider.searchDocuments("filetype:(pdf) 원산문헌");
  const extensionResult = await provider.searchDocuments("ext:pdf 원산문헌");
  const filetypeOrSiteResult = await provider.searchDocuments("원산문헌 filetype:pdf OR site:rodong.rep.kp");
  const parenthesizedFiletypeResult = await provider.searchDocuments("원산문헌 (filetype:pdf)");
  const filetypeOnlyResult = await provider.searchDocuments("filetype:pdf");
  const negativeFiletypeResult = await provider.searchDocuments("원산문헌 -filetype:pdf");
  const negativeExtensionResult = await provider.searchDocuments("원산문헌 -extension:pdf");
  const negativeFiletypeOnlyResult = await provider.searchDocuments("-filetype:pdf");
  const notFiletypeResult = await provider.searchDocuments("원산문헌 NOT filetype:pdf");
  const dateResult = await provider.searchDocuments("after:2026-01-01 before:2026-12-31 기간");
  const dateKoreanAliasResult = await provider.searchDocuments("이후:2026-01-01 이전:2026-12-31 기간");
  const dateOnlyResult = await provider.searchDocuments("after:2026-01-01 before:2026-12-31");
  const dateRangeResult = await provider.searchDocuments("date:2026-01-01..2026-12-31 기간");
  const dateRangeCurlyQuotedResult = await provider.searchDocuments("date:“2026-01-01..2026-12-31” 기간");
  const dateRangeParenthesizedValueResult = await provider.searchDocuments("date:(2026-01-01..2026-12-31) 기간");
  const dateRangeOnlyResult = await provider.searchDocuments("daterange:2026..2026");
  const languageResult = await provider.searchDocuments("lang:en Wonsan");
  const languageCurlyQuotedResult = await provider.searchDocuments("lang:“english” Wonsan");
  const languageOnlyResult = await provider.searchDocuments("lang:en");
  const negativeLanguageResult = await provider.searchDocuments("원산갈마 -lang:en");
  const negativeLanguageOnlyResult = await provider.searchDocuments("-lang:en");
  const notLanguageResult = await provider.searchDocuments("원산갈마 NOT lang:en");
  const meiliNegativeSourceRequests = [];
  const meiliNegativeFiletypeRequests = [];
  const meiliNegativeFiletypeOnlyRequests = [];
  const meiliNegativeLanguageRequests = [];
  const meiliNegativeLanguageOnlyRequests = [];
  const meiliNotSourceRequests = [];
  const meiliNotFiletypeRequests = [];
  const meiliNotLanguageRequests = [];
  const meiliFilterOnlyRequests = [];
  const meiliFilterOnlyExcludeRequests = [];
  const [operatorSource, portalSource, providerSource, readmeSource, meiliResult, meiliFilterOnlyResult, meiliFilterOnlyExcludeResult, meiliNegativeSourceResult, meiliFiletypeResult, meiliNegativeFiletypeResult, meiliNegativeFiletypeOnlyResult, meiliDateResult, meiliDateRangeResult, meiliLanguageResult, meiliNegativeLanguageResult, meiliNegativeLanguageOnlyResult] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/queryOperators.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/LocalJsonSearchProvider.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "README.md"), "utf8"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => ({
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { displaySourceId: { "rodong-sinmun": 1 } },
          requestEcho: { url, body: JSON.parse(options.body || "{}") },
        }),
      }),
    }).searchDocuments("site:rodong.rep.kp 원산갈마"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        meiliFilterOnlyRequests.push({ url, body });
        return {
          ok: true,
          json: async () => ({
            hits: [{
              id: "fixture-site-rodong",
              title: "원산갈마 로동신문",
              snippet: "필터 전용 검색 결과입니다.",
              date: "2026-05-20",
              sourceId: "rodong-sinmun",
              sourceName: "로동신문",
              sourceType: "official_site",
              displaySourceId: "rodong-sinmun",
              displaySourceName: "로동신문",
              displaySourceType: "official_site",
              mediaType: "article",
              url: "http://www.rodong.rep.kp/fixture",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              searchTabs: ["all"],
              visibleTabs: ["all"],
            }],
            estimatedTotalHits: 1,
            processingTimeMs: 0,
            facetDistribution: { displaySourceId: { "rodong-sinmun": 1 } },
            requestEcho: { url, body },
          }),
        };
      },
    }).searchDocuments("site:rodong.rep.kp"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        meiliFilterOnlyExcludeRequests.push({ url, body });
        return {
          ok: true,
          json: async () => ({
            hits: [
              {
                id: "fixture-site-rodong",
                title: "원산갈마 로동신문",
                snippet: "원산갈마 준공식 로동신문 보도입니다.",
                date: "2026-05-20",
                sourceId: "rodong-sinmun",
                sourceName: "로동신문",
                sourceType: "official_site",
                displaySourceId: "rodong-sinmun",
                displaySourceName: "로동신문",
                displaySourceType: "official_site",
                mediaType: "article",
                url: "http://www.rodong.rep.kp/fixture",
                archiveUrl: "",
                thumbnailUrl: "",
                language: "ko",
                aliases: [],
                searchTabs: ["all"],
                visibleTabs: ["all"],
              },
              {
                id: "fixture-site-rodong-image",
                title: "매체 순서 사진",
                snippet: "검색어 없는 출처 필터에서 이미지는 기사와 문헌 뒤에 놓여야 합니다.",
                date: "2026-12-31",
                sourceId: "rodong-sinmun",
                sourceName: "로동신문",
                sourceType: "official_site",
                displaySourceId: "rodong-sinmun",
                displaySourceName: "로동신문",
                displaySourceType: "official_site",
                mediaType: "image",
                url: "http://www.rodong.rep.kp/fixture.jpg",
                archiveUrl: "",
                thumbnailUrl: "http://www.rodong.rep.kp/fixture.jpg",
                language: "ko",
                aliases: [],
                searchTabs: ["all", "image"],
                visibleTabs: ["all", "image"],
              },
            ],
            estimatedTotalHits: 2,
            processingTimeMs: 0,
            facetDistribution: { displaySourceId: { "rodong-sinmun": 2 } },
            requestEcho: { url, body },
          }),
        };
      },
    }).searchDocuments("site:rodong.rep.kp -원산"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        meiliNegativeSourceRequests.push({ url, body });
        return {
          ok: true,
          json: async () => ({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 0,
            facetDistribution: { displaySourceId: { "rodong-sinmun": 1 } },
            requestEcho: { url, body },
          }),
        };
      },
    }).searchDocuments("-site:kcna.kp 원산갈마"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => ({
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { displaySourceId: { "rodong-sinmun": 1 } },
          requestEcho: { url, body: JSON.parse(options.body || "{}") },
        }),
      }),
    }).searchDocuments("filetype:pdf 원산문헌"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        meiliNegativeFiletypeRequests.push({ url, body });
        return {
          ok: true,
          json: async () => ({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 0,
            facetDistribution: { displaySourceId: { "rodong-sinmun": 1 } },
            requestEcho: { url, body },
          }),
        };
      },
    }).searchDocuments("원산문헌 -filetype:pdf"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        meiliNegativeFiletypeOnlyRequests.push({ url, body });
        return {
          ok: true,
          json: async () => ({
            hits: [{
              id: "fixture-negative-filetype-only",
              title: "기사 검색",
              snippet: "PDF가 아닌 기사입니다.",
              date: "2026-05-20",
              sourceId: "rodong-sinmun",
              sourceName: "로동신문",
              sourceType: "official_site",
              displaySourceId: "rodong-sinmun",
              displaySourceName: "로동신문",
              displaySourceType: "official_site",
              mediaType: "article",
              url: "http://www.rodong.rep.kp/article",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              searchTabs: ["all"],
              visibleTabs: ["all"],
            }],
            estimatedTotalHits: 1,
            processingTimeMs: 0,
            facetDistribution: { displaySourceId: { "rodong-sinmun": 1 } },
            requestEcho: { url, body },
          }),
        };
      },
    }).searchDocuments("-filetype:pdf"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => ({
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { displaySourceId: { kcna: 1 } },
          requestEcho: { url, body: JSON.parse(options.body || "{}") },
        }),
      }),
    }).searchDocuments("after:2026-01-01 before:2026-12-31 기간"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => ({
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { displaySourceId: { kcna: 1 } },
          requestEcho: { url, body: JSON.parse(options.body || "{}") },
        }),
      }),
    }).searchDocuments("date:2026-01-01..2026-12-31 기간"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => ({
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { displaySourceId: { kcna: 1 } },
          requestEcho: { url, body: JSON.parse(options.body || "{}") },
        }),
      }),
    }).searchDocuments("language:english Wonsan"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        meiliNegativeLanguageRequests.push({ url, body });
        return {
          ok: true,
          json: async () => ({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 0,
            facetDistribution: { displaySourceId: { "rodong-sinmun": 1 } },
            requestEcho: { url, body },
          }),
        };
      },
    }).searchDocuments("원산갈마 -lang:en"),
    new MeilisearchSearchProvider({
      host: "https://meili.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        meiliNegativeLanguageOnlyRequests.push({ url, body });
        return {
          ok: true,
          json: async () => ({
            hits: [{
              id: "fixture-negative-language-only",
              title: "한국어 기사",
              snippet: "영어가 아닌 기사입니다.",
              date: "2026-05-20",
              sourceId: "rodong-sinmun",
              sourceName: "로동신문",
              sourceType: "official_site",
              displaySourceId: "rodong-sinmun",
              displaySourceName: "로동신문",
              displaySourceType: "official_site",
              mediaType: "article",
              url: "http://www.rodong.rep.kp/language",
              archiveUrl: "",
              thumbnailUrl: "",
              language: "ko",
              aliases: [],
              searchTabs: ["all"],
              visibleTabs: ["all"],
            }],
            estimatedTotalHits: 1,
            processingTimeMs: 0,
            facetDistribution: { displaySourceId: { "rodong-sinmun": 1 } },
            requestEcho: { url, body },
          }),
        };
      },
    }).searchDocuments("-lang:en"),
  ]);

  const meiliNotSourceResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliNotSourceRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: { "rodong-sinmun": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("원산갈마 NOT site:kcna.kp");

  const meiliNotFiletypeResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliNotFiletypeRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: { "rodong-sinmun": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("원산문헌 NOT filetype:pdf");

  const meiliNotLanguageResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliNotLanguageRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: { "rodong-sinmun": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("원산갈마 NOT lang:en");

  const meiliParentDomainRequests = [];
  const meiliParentDomainResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliParentDomainRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: { "rodong-sinmun": 1, "voice-of-korea": 1, "minju-choson": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("site:rep.kp 원산갈마");

  const meiliTldRequests = [];
  const meiliTldResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliTldRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: {
            "rodong-sinmun": 1,
            kcna: 1,
            "voice-of-korea": 1,
            "minju-choson": 1,
            ryugyong: 1,
            naenara: 1,
            "korean-books": 1,
          } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("site:kp 원산갈마");

  const meiliKoreanSiteAliasRequests = [];
  const meiliKoreanSiteAliasResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliKoreanSiteAliasRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: { "rodong-sinmun": 1, "voice-of-korea": 1, "minju-choson": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("사이트:rep.kp 원산갈마");

  const meiliParenthesizedValueRequests = [];
  const meiliParenthesizedValueResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliParenthesizedValueRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: { "rodong-sinmun": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("site:(rodong.rep.kp) 원산갈마");

  const meiliWildcardParentDomainRequests = [];
  const meiliWildcardParentDomainResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliWildcardParentDomainRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: { "rodong-sinmun": 1, "voice-of-korea": 1, "minju-choson": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("site:*.rep.kp 원산갈마");

  const meiliExtensionResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => ({
      ok: true,
      json: async () => ({
        hits: [],
        estimatedTotalHits: 0,
        processingTimeMs: 0,
        facetDistribution: { displaySourceId: { "rodong-sinmun": 1 } },
        requestEcho: { url, body: JSON.parse(options.body || "{}") },
      }),
    }),
  }).searchDocuments("ext:pdf 원산문헌");

  const meiliSourceOrRequests = [];
  const meiliSourceOrResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliSourceOrRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: { "rodong-sinmun": 1, "voice-of-korea": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("site:rodong.rep.kp OR site:vok.rep.kp 원산갈마");

  const meiliParenthesizedSourceOrRequests = [];
  const meiliParenthesizedSourceOrResult = await new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      meiliParenthesizedSourceOrRequests.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 0,
          facetDistribution: { sourceId: { "rodong-sinmun": 1, "voice-of-korea": 1 } },
          requestEcho: { url, body },
        }),
      };
    },
  }).searchDocuments("(site:rodong.rep.kp OR site:vok.rep.kp) 원산갈마");

  assert.deepEqual(siteResult.documents.map((document) => document.id), ["fixture-site-rodong"], "site: host operators should become source filters in local search");
  assert.deepEqual(siteCurlyQuotedResult.documents.map((document) => document.id), ["fixture-site-rodong"], "site:“host” operators should become source filters in local search");
  assert.deepEqual(siteParenthesizedValueResult.documents.map((document) => document.id), ["fixture-site-rodong"], "site:(host) operators should become source filters in local search");
  assert.deepEqual([...siteParentDomainResult.documents.map((document) => document.id)].sort(), ["fixture-site-rodong", "fixture-site-vok"], "site: parent-domain operators should search every configured source under that host suffix");
  assert.deepEqual([...siteWildcardParentDomainResult.documents.map((document) => document.id)].sort(), ["fixture-site-rodong", "fixture-site-vok"], "site: wildcard parent-domain operators should search every configured source under that host suffix");
  assert.deepEqual([...siteTldResult.documents.map((document) => document.id)].sort(), ["fixture-site-kcna", "fixture-site-rodong", "fixture-site-vok"], "site: bare TLD operators should search every configured source under that host suffix");
  assert.deepEqual([...siteKoreanAliasResult.documents.map((document) => document.id)].sort(), ["fixture-site-rodong", "fixture-site-vok"], "Korean 사이트: operators should behave like site: parent-domain filters");
  assert.deepEqual([...siteDomainAliasResult.documents.map((document) => document.id)].sort(), ["fixture-site-kcna", "fixture-site-rodong", "fixture-site-vok"], "domain: aliases should behave like site: host-suffix filters");
  assert.deepEqual([...siteOrSourceResult.documents.map((document) => document.id)].sort(), ["fixture-site-rodong", "fixture-site-vok"], "site: operators joined with OR should not leak OR into the local document query");
  assert.deepEqual([...parenthesizedSiteOrSourceResult.documents.map((document) => document.id)].sort(), ["fixture-site-rodong", "fixture-site-vok"], "parenthesized site: operators joined with OR should become local source filters");
  assert.equal(siteOrSourceOnlyResult.query, "", "filter-only source operators joined with OR should not leave OR as a literal query");
  assert.deepEqual(siteAndSourceResult.documents.map((document) => document.id), ["fixture-site-rodong"], "site: operators joined with AND should not leak AND into the local document query");
  assert.deepEqual([...parenthesizedSiteResult.documents.map((document) => document.id)].sort(), ["fixture-site-rodong", "fixture-site-vok"], "parenthesized site: operators should still resolve source filters");
  assert.deepEqual(siteOnlyResult.documents.map((document) => document.id), ["fixture-site-rodong", "fixture-filetype-pdf", "fixture-site-rodong-image"], "site: host-only searches should list indexed documents from the visible source using backend-like media/date ranking instead of returning an empty query");
  assert.deepEqual(siteExcludedOnlyResult.documents.map((document) => document.id), ["fixture-site-rodong-image"], "structured filter searches with only negative text terms should browse the filtered corpus and remove excluded matches");
  assert.deepEqual([...negativeSiteResult.documents.map((document) => document.id)].sort(), ["fixture-site-rodong", "fixture-site-vok"], "-site: host operators should exclude source filters in local search");
  assert.deepEqual([...parenthesizedNegativeSiteResult.documents.map((document) => document.id)].sort(), ["fixture-site-rodong", "fixture-site-vok"], "parenthesized negative site: operators should exclude source filters in local search");
  assert.deepEqual(negativeParentDomainSiteResult.documents.map((document) => document.id), ["fixture-site-kcna"], "-site: parent-domain operators should exclude every configured source under that host suffix");
  assert.deepEqual(negativeWildcardParentDomainSiteResult.documents.map((document) => document.id), ["fixture-site-kcna"], "-site: wildcard parent-domain operators should exclude every configured source under that host suffix");
  assert.deepEqual(negativeTldSiteResult.documents.map((document) => document.id), [], "-site: bare TLD operators should exclude every configured source under that host suffix");
  assert.deepEqual([...negativeParenthesizedValueSiteResult.documents.map((document) => document.id)].sort(), ["fixture-site-rodong", "fixture-site-vok"], "-site:(host) operators should exclude source filters in local search");
  assert.deepEqual([...notSiteResult.documents.map((document) => document.id)].sort(), [...negativeSiteResult.documents.map((document) => document.id)].sort(), "NOT site: host operators should behave like -site: source exclusions in local search");
  assert.deepEqual([...notParenthesizedSiteResult.documents.map((document) => document.id)].sort(), [...negativeSiteResult.documents.map((document) => document.id)].sort(), "NOT (site:) operators should behave like parenthesized negative source exclusions in local search");
  assert.deepEqual([...notUppercaseSiteResult.documents.map((document) => document.id)].sort(), [...negativeSiteResult.documents.map((document) => document.id)].sort(), "NOT before uppercase structured operators should still behave like negative source exclusions");
  assert.deepEqual(
    siteResult.sourceFacets.map(({ sourceId, count }) => ({ sourceId, count })),
    [{ sourceId: "rodong-sinmun", count: 1 }],
    "site: source operators should scope local source facets to the requested source",
  );
  assert.deepEqual(
    siteOnlyResult.sourceFacets.map(({ sourceId, count }) => ({ sourceId, count })),
    [{ sourceId: "rodong-sinmun", count: 3 }],
    "site: source-only searches should not report unrelated source facets",
  );
  assert.deepEqual(
    siteExcludedOnlyResult.sourceFacets.map(({ sourceId, count }) => ({ sourceId, count })),
    [{ sourceId: "rodong-sinmun", count: 1 }],
    "site: source filters with only negative text terms should count facets after excluded terms are applied",
  );
  assert.equal(
    negativeSiteResult.sourceFacets.some((facet) => facet.sourceId === "kcna"),
    false,
    "-site: source operators should remove excluded sources from local source facets",
  );
  assert.deepEqual(sourceResult.documents.map((document) => document.id), ["fixture-site-kcna"], "source: quoted source-name operators should become source filters in local search");
  assert.deepEqual(sourceKoreanAliasResult.documents.map((document) => document.id), ["fixture-site-rodong"], "Korean 출처: operators should become source filters in local search");
  assert.deepEqual(sourceCurlyQuotedResult.documents.map((document) => document.id), ["fixture-site-kcna"], "source:“name” operators should become source filters in local search");
  assert.deepEqual(sourceCurlySingleQuotedResult.documents.map((document) => document.id), ["fixture-site-rodong"], "source:‘name’ operators should become source filters in local search");
  assert.deepEqual(sourceParenthesizedValueResult.documents.map((document) => document.id), ["fixture-site-rodong"], "source:(name) operators should become source filters in local search");
  assert.deepEqual(filetypeResult.documents.map((document) => document.id), ["fixture-filetype-pdf"], "filetype: operators should become tab filters in local search");
  assert.deepEqual(filetypeKoreanAliasResult.documents.map((document) => document.id), ["fixture-filetype-pdf"], "Korean 파일형식: operators should become tab filters in local search");
  assert.deepEqual(mediaKoreanAliasResult.documents.map((document) => document.id), ["fixture-filetype-pdf"], "Korean 매체: operators should resolve Korean media labels");
  assert.deepEqual(filetypeCurlyQuotedResult.documents.map((document) => document.id), ["fixture-filetype-pdf"], "filetype:“value” operators should become tab filters in local search");
  assert.deepEqual(filetypeParenthesizedValueResult.documents.map((document) => document.id), ["fixture-filetype-pdf"], "filetype:(value) operators should become tab filters in local search");
  assert.deepEqual(extensionResult.documents.map((document) => document.id), ["fixture-filetype-pdf"], "ext: operators should behave like filetype: filters in local search");
  assert.deepEqual(filetypeOrSiteResult.documents.map((document) => document.id), ["fixture-filetype-pdf"], "mixed filetype:/site: operators joined with OR should keep the real media and source filters");
  assert.deepEqual(parenthesizedFiletypeResult.documents.map((document) => document.id), ["fixture-filetype-pdf"], "parenthesized filetype: operators should become tab filters in local search");
  assert.deepEqual(filetypeOnlyResult.documents.map((document) => document.id), ["fixture-filetype-pdf"], "filetype:-only searches should list indexed documents from the requested media tab");
  assert.deepEqual(negativeFiletypeResult.documents.map((document) => document.id), ["fixture-site-rodong"], "-filetype: operators should exclude the requested media type instead of searching for a literal token");
  assert.deepEqual(negativeExtensionResult.documents.map((document) => document.id), ["fixture-site-rodong"], "-extension: operators should exclude the requested media type instead of searching for a literal token");
  assert.deepEqual(notFiletypeResult.documents.map((document) => document.id), negativeFiletypeResult.documents.map((document) => document.id), "NOT filetype: operators should behave like -filetype: media exclusions in local search");
  assert.equal(negativeFiletypeOnlyResult.documents.some((document) => document.mediaType === "pdf"), false, "-filetype:-only searches should browse indexed documents while excluding the requested media type");
  assert.equal(negativeFiletypeOnlyResult.documents.length > 0, true, "-filetype:-only searches should be valid structured filter searches");
  assert.deepEqual(dateResult.documents.map((document) => document.id), ["fixture-date-new"], "after:/before: operators should become date range filters in local search");
  assert.deepEqual(dateKoreanAliasResult.documents.map((document) => document.id), ["fixture-date-new"], "Korean 이후:/이전: operators should become date range filters in local search");
  assert.equal(dateOnlyResult.documents.some((document) => document.id === "fixture-date-old"), false, "date-only searches should apply structured date filters without requiring a text query");
  assert.deepEqual(dateRangeResult.documents.map((document) => document.id), ["fixture-date-new"], "date: start..end operators should become date range filters in local search");
  assert.deepEqual(dateRangeCurlyQuotedResult.documents.map((document) => document.id), ["fixture-date-new"], "date:“start..end” operators should become date range filters in local search");
  assert.deepEqual(dateRangeParenthesizedValueResult.documents.map((document) => document.id), ["fixture-date-new"], "date:(start..end) operators should become date range filters in local search");
  assert.equal(dateRangeOnlyResult.documents.some((document) => document.id === "fixture-date-old"), false, "daterange:-only searches should apply structured date filters without requiring a text query");
  assert.deepEqual(languageResult.documents.map((document) => document.id), ["fixture-language-en"], "lang: operators should become language filters in local search");
  assert.deepEqual(languageCurlyQuotedResult.documents.map((document) => document.id), ["fixture-language-en"], "lang:“value” operators should become language filters in local search");
  assert.deepEqual(languageOnlyResult.documents.map((document) => document.id), ["fixture-language-en"], "lang:-only searches should list indexed documents for the requested language");
  assert.deepEqual([...negativeLanguageResult.documents.map((document) => document.id)].sort(), ["fixture-site-kcna", "fixture-site-rodong", "fixture-site-vok"], "-lang: operators should exclude the requested language instead of searching for a literal token");
  assert.deepEqual([...notLanguageResult.documents.map((document) => document.id)].sort(), [...negativeLanguageResult.documents.map((document) => document.id)].sort(), "NOT lang: operators should behave like -lang: language exclusions in local search");
  assert.equal(negativeLanguageOnlyResult.documents.some((document) => document.language === "en"), false, "-lang:-only searches should browse indexed documents while excluding the requested language");
  assert.equal(negativeLanguageOnlyResult.documents.length > 0, true, "-lang:-only searches should be valid structured filter searches");
  assert.equal(siteResult.query, "원산갈마", "local source operators should be stripped from the document query before retrieval");
  assert.equal(siteCurlyQuotedResult.query, "원산갈마", "local site:“host” operators should be stripped from the document query before retrieval");
  assert.equal(siteParenthesizedValueResult.query, "원산갈마", "local site:(host) operators should be stripped from the document query before retrieval");
  assert.equal(siteWildcardParentDomainResult.query, "원산갈마", "local wildcard parent-domain source operators should be stripped from the document query before retrieval");
  assert.equal(siteTldResult.query, "원산갈마", "local bare TLD source operators should be stripped from the document query before retrieval");
  assert.equal(siteKoreanAliasResult.query, "원산갈마", "local Korean site aliases should be stripped from the document query before retrieval");
  assert.equal(siteOrSourceResult.query, "원산갈마", "local source operators joined with OR should strip orphan boolean connectors from the document query");
  assert.equal(parenthesizedSiteOrSourceResult.query, "원산갈마", "parenthesized source operators joined with OR should strip orphan boolean connectors from the document query");
  assert.equal(siteAndSourceResult.query, "원산갈마", "local source operators joined with AND should strip orphan boolean connectors from the document query");
  assert.equal(parenthesizedSiteResult.query, "원산갈마", "parenthesized source operators should be stripped from the document query before retrieval");
  assert.equal(siteOnlyResult.query, "", "local filter-only source operators should strip to an empty backend text query");
  assert.equal(siteExcludedOnlyResult.query, "-원산", "local structured negative-only text searches should preserve the visible exclusion query while using filter-only retrieval");
  assert.equal(sourceParenthesizedValueResult.query, "원산갈마", "local source:(name) operators should be stripped from the document query before retrieval");
  assert.equal(sourceCurlyQuotedResult.query, "원산갈마", "local source:“name” operators should be stripped from the document query before retrieval");
  assert.equal(sourceCurlySingleQuotedResult.query, "원산갈마", "local source:‘name’ operators should be stripped from the document query before retrieval");
  assert.equal(negativeSiteResult.query, "원산갈마", "local negative source operators should be stripped from the document query before retrieval");
  assert.equal(parenthesizedNegativeSiteResult.query, "원산갈마", "parenthesized negative source operators should be stripped from the document query before retrieval");
  assert.equal(negativeWildcardParentDomainSiteResult.query, "원산갈마", "local negative wildcard source operators should be stripped from the document query before retrieval");
  assert.equal(negativeTldSiteResult.query, "원산갈마", "local negative bare TLD source operators should be stripped from the document query before retrieval");
  assert.equal(negativeParenthesizedValueSiteResult.query, "원산갈마", "local negative site:(host) operators should be stripped from the document query before retrieval");
  assert.equal(notSiteResult.query, "원산갈마", "local NOT site: operators should be stripped from the document query before retrieval");
  assert.equal(notParenthesizedSiteResult.query, "원산갈마", "local NOT (site:) operators should be stripped from the document query before retrieval");
  assert.equal(notUppercaseSiteResult.query, "원산갈마", "local NOT before uppercase source operators should be stripped from the document query before retrieval");
  assert.equal(filetypeResult.query, "원산문헌", "local media operators should be stripped from the document query before retrieval");
  assert.equal(filetypeCurlyQuotedResult.query, "원산문헌", "local filetype:“value” operators should be stripped from the document query before retrieval");
  assert.equal(filetypeParenthesizedValueResult.query, "원산문헌", "local filetype:(value) operators should be stripped from the document query before retrieval");
  assert.equal(extensionResult.query, "원산문헌", "local extension media operators should be stripped from the document query before retrieval");
  assert.equal(filetypeOrSiteResult.query, "원산문헌", "local mixed media/source operators should strip trailing orphan boolean connectors from the document query");
  assert.equal(parenthesizedFiletypeResult.query, "원산문헌", "parenthesized media operators should be stripped from the document query before retrieval");
  assert.equal(negativeFiletypeResult.query, "원산문헌", "local negative media operators should be stripped from the document query before retrieval");
  assert.equal(negativeExtensionResult.query, "원산문헌", "local negative extension media operators should be stripped from the document query before retrieval");
  assert.equal(notFiletypeResult.query, "원산문헌", "local NOT filetype: operators should be stripped from the document query before retrieval");
  assert.equal(negativeFiletypeOnlyResult.query, "", "local negative media-only searches should strip to an empty backend text query");
  assert.equal(dateResult.query, "기간", "local date operators should be stripped from the document query before retrieval");
  assert.equal(dateRangeResult.query, "기간", "local date-range operators should be stripped from the document query before retrieval");
  assert.equal(dateRangeCurlyQuotedResult.query, "기간", "local date:“range” operators should be stripped from the document query before retrieval");
  assert.equal(dateRangeParenthesizedValueResult.query, "기간", "local date:(range) operators should be stripped from the document query before retrieval");
  assert.equal(languageResult.query, "Wonsan", "local language operators should be stripped from the document query before retrieval");
  assert.equal(languageCurlyQuotedResult.query, "Wonsan", "local lang:“value” operators should be stripped from the document query before retrieval");
  assert.equal(negativeLanguageResult.query, "원산갈마", "local negative language operators should be stripped from the document query before retrieval");
  assert.equal(notLanguageResult.query, "원산갈마", "local NOT lang: operators should be stripped from the document query before retrieval");
  assert.equal(negativeLanguageOnlyResult.query, "", "local negative language-only searches should strip to an empty backend text query");
  assert.deepEqual(siteResult.filters.sourceIds, ["rodong-sinmun"], "local source operators should populate normalized source filters");
  assert.deepEqual(siteCurlyQuotedResult.filters.sourceIds, ["rodong-sinmun"], "local site:“host” operators should populate normalized source filters");
  assert.deepEqual(siteParenthesizedValueResult.filters.sourceIds, ["rodong-sinmun"], "local site:(host) operators should populate normalized source filters");
  assert.deepEqual(siteParentDomainResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea"], "local parent-domain site operators should populate every matching normalized source filter");
  assert.deepEqual(siteWildcardParentDomainResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea"], "local wildcard parent-domain site operators should populate every matching normalized source filter");
  assert.deepEqual(siteTldResult.filters.sourceIds, ["rodong-sinmun", "kcna", "voice-of-korea"], "local bare TLD site operators should populate every matching normalized source filter");
  assert.deepEqual(siteOrSourceResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea"], "local OR-joined source operators should populate every normalized source filter");
  assert.deepEqual(parenthesizedSiteOrSourceResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea"], "local parenthesized OR-joined source operators should populate every normalized source filter");
  assert.deepEqual(siteOrSourceOnlyResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea"], "local OR-joined filter-only source operators should preserve every normalized source filter");
  assert.deepEqual(parenthesizedSiteResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea"], "local parenthesized parent-domain site operators should populate every matching normalized source filter");
  assert.deepEqual(sourceParenthesizedValueResult.filters.sourceIds, ["rodong-sinmun"], "local source:(name) operators should populate normalized source filters");
  assert.deepEqual(sourceCurlyQuotedResult.filters.sourceIds, ["kcna"], "local source:“name” operators should populate normalized source filters");
  assert.deepEqual(sourceCurlySingleQuotedResult.filters.sourceIds, ["rodong-sinmun"], "local source:‘name’ operators should populate normalized source filters");
  assert.deepEqual(filetypeOrSiteResult.filters.sourceIds, ["rodong-sinmun"], "local mixed media/source operators should preserve normalized source filters");
  assert.deepEqual(negativeSiteResult.filters.excludedSourceIds, ["kcna"], "local negative source operators should populate normalized excluded source filters");
  assert.deepEqual(parenthesizedNegativeSiteResult.filters.excludedSourceIds, ["kcna"], "local parenthesized negative source operators should populate normalized excluded source filters");
  assert.deepEqual(negativeParenthesizedValueSiteResult.filters.excludedSourceIds, ["kcna"], "local negative site:(host) operators should populate normalized excluded source filters");
  assert.deepEqual(notSiteResult.filters.excludedSourceIds, ["kcna"], "local NOT site: operators should populate normalized excluded source filters");
  assert.deepEqual(notParenthesizedSiteResult.filters.excludedSourceIds, ["kcna"], "local NOT (site:) operators should populate normalized excluded source filters");
  assert.deepEqual(notUppercaseSiteResult.filters.excludedSourceIds, ["kcna"], "local NOT before uppercase source operators should populate normalized excluded source filters");
  assert.deepEqual(negativeParentDomainSiteResult.filters.excludedSourceIds, ["rodong-sinmun", "voice-of-korea"], "local negative parent-domain site operators should populate every matching excluded source filter");
  assert.deepEqual(negativeWildcardParentDomainSiteResult.filters.excludedSourceIds, ["rodong-sinmun", "voice-of-korea"], "local negative wildcard parent-domain site operators should populate every matching excluded source filter");
  assert.deepEqual(negativeTldSiteResult.filters.excludedSourceIds, ["rodong-sinmun", "kcna", "voice-of-korea"], "local negative bare TLD site operators should populate every matching excluded source filter");
  assert.equal(filetypeResult.filters.tab, "pdf", "local filetype operators should populate normalized tab filters");
  assert.equal(filetypeCurlyQuotedResult.filters.tab, "pdf", "local filetype:“value” operators should populate normalized tab filters");
  assert.equal(filetypeParenthesizedValueResult.filters.tab, "pdf", "local filetype:(value) operators should populate normalized tab filters");
  assert.equal(extensionResult.filters.tab, "pdf", "local ext operators should populate normalized tab filters");
  assert.equal(filetypeOrSiteResult.filters.tab, "pdf", "local mixed media/source operators should preserve normalized media filters");
  assert.equal(parenthesizedFiletypeResult.filters.tab, "pdf", "local parenthesized media operators should populate normalized tab filters");
  assert.deepEqual(negativeFiletypeResult.filters.excludedMediaTypes, ["pdf"], "local negative filetype operators should populate normalized excluded media filters");
  assert.deepEqual(negativeExtensionResult.filters.excludedMediaTypes, ["pdf"], "local negative extension operators should populate normalized excluded media filters");
  assert.deepEqual(notFiletypeResult.filters.excludedMediaTypes, ["pdf"], "local NOT filetype: operators should populate normalized excluded media filters");
  assert.equal(dateResult.filters.dateFrom, "2026-01-01", "local after: operators should populate normalized lower date bounds");
  assert.equal(dateResult.filters.dateTo, "2026-12-31", "local before: operators should populate normalized upper date bounds");
  assert.equal(dateRangeResult.filters.dateFrom, "2026-01-01", "local date: operators should populate normalized lower date bounds");
  assert.equal(dateRangeResult.filters.dateTo, "2026-12-31", "local date: operators should populate normalized upper date bounds");
  assert.equal(dateRangeCurlyQuotedResult.filters.dateFrom, "2026-01-01", "local date:“range” operators should populate normalized lower date bounds");
  assert.equal(dateRangeCurlyQuotedResult.filters.dateTo, "2026-12-31", "local date:“range” operators should populate normalized upper date bounds");
  assert.equal(dateRangeParenthesizedValueResult.filters.dateFrom, "2026-01-01", "local date:(range) operators should populate normalized lower date bounds");
  assert.equal(dateRangeParenthesizedValueResult.filters.dateTo, "2026-12-31", "local date:(range) operators should populate normalized upper date bounds");
  assert.deepEqual(languageResult.filters.languages, ["en"], "local lang: operators should populate normalized language filters");
  assert.deepEqual(languageCurlyQuotedResult.filters.languages, ["en"], "local lang:“value” operators should populate normalized language filters");
  assert.deepEqual(negativeLanguageResult.filters.excludedLanguages, ["en"], "local negative lang: operators should populate normalized excluded language filters");
  assert.deepEqual(notLanguageResult.filters.excludedLanguages, ["en"], "local NOT lang: operators should populate normalized excluded language filters");
  assert.equal(operatorSource.includes("parseSearchQueryOperators"), true, "source/site operator parsing should live in a shared runtime module");
  assert.equal(operatorSource.includes("hasStructuredSearchOperators"), true, "shared query parsing should expose whether a query has filter-only structured intent");
  assert.equal(providerSource.includes("hasPositiveDocumentQuery(parsedQuery.query)"), true, "local structured negative-only searches should not be mistaken for positive text queries");
  assert.equal(providerSource.includes("filters.excludedMediaTypes.includes(document.mediaType)"), true, "local structured filters should reject excluded media types");
  assert.equal(providerSource.includes("filters.excludedLanguages.includes(document.language)"), true, "local structured filters should reject excluded languages");
  assert.equal(operatorSource.includes("SITE_OPERATOR_NAMES"), true, "query operator parser should define source-host operator aliases centrally");
  assert.equal(operatorSource.includes("SOURCE_OPERATOR_NAMES"), true, "query operator parser should define source-name operator aliases centrally");
  assert.equal(operatorSource.includes("사이트"), true, "query operator parser should support Korean site: aliases");
  assert.equal(operatorSource.includes("출처"), true, "query operator parser should support Korean source: aliases");
  assert.equal(operatorSource.includes("\\(?"), true, "query operator parser should support parenthesized Google-like filter operators");
  assert.equal(operatorSource.includes("“([^”]+)”|‘([^’]+)’"), true, "query operator parser should support curly-quoted structured operator values pasted from rich text");
  assert.equal(operatorSource.includes("normalizeOperatorValue"), true, "query operator parser should support values wrapped in parentheses such as site:(host)");
  assert.equal(operatorSource.includes("resolveSourceOperatorValues"), true, "query operator parser should support Google-like parent-domain site: expansion");
  assert.equal(operatorSource.includes("sourceHostMatches"), true, "query operator parser should match source hosts by suffix for parent-domain site: searches");
  assert.equal(operatorSource.includes("getBareHostSuffixSelector"), true, "query operator parser should support Google-like bare TLD site: selectors such as site:kp");
  assert.equal(operatorSource.includes("wildcardHost"), true, "query operator parser should support Google-like site:*.host wildcard source selectors");
  assert.equal(operatorSource.includes("MEDIA_OPERATOR_NAMES"), true, "query operator parser should support Google-like media operator syntax and aliases for filetype:");
  assert.equal(operatorSource.includes("파일형식"), true, "query operator parser should support Korean media/filetype aliases");
  assert.equal(operatorSource.includes("LANGUAGE_OPERATOR_NAMES"), true, "query operator parser should support Google-like language operator syntax through shared aliases");
  assert.equal(operatorSource.includes("언어"), true, "query operator parser should support Korean language aliases");
  assert.equal(operatorSource.includes("DATE_START_OPERATOR_NAMES"), true, "query operator parser should support Google-like date-start operator syntax");
  assert.equal(operatorSource.includes("DATE_END_OPERATOR_NAMES"), true, "query operator parser should support Google-like date-end operator syntax");
  assert.equal(operatorSource.includes("이후"), true, "query operator parser should support Korean date-start aliases");
  assert.equal(operatorSource.includes("이전"), true, "query operator parser should support Korean date-end aliases");
  assert.equal(operatorSource.includes("date|daterange|기간|날짜") || operatorSource.includes("DATE_RANGE_OPERATOR_NAMES"), true, "query operator parser should support Google-like date-range operator syntax");
  assert.equal(operatorSource.includes("resolveMediaOperatorTab"), true, "media query operators should be resolved in the shared parser");
  assert.equal(operatorSource.includes("resolveMediaOperatorMediaTypes"), true, "negative media query operators should resolve to backend media-type exclusions");
  assert.equal(operatorSource.includes("resolveLanguageOperatorValue"), true, "language query operators should be resolved in the shared parser");
  assert.equal(operatorSource.includes("resolveDateOperatorValue"), true, "date query operators should be resolved in the shared parser");
  assert.equal(operatorSource.includes("resolveDateRangeOperatorValue"), true, "date-range query operators should be resolved in the shared parser");
  assert.equal(operatorSource.includes("normalizeStructuredNotOperators"), true, "shared query parsing should treat NOT before structured operators as the readable form of negative filters");
  assert.equal(operatorSource.includes("cleanStructuredOperatorQueryText"), true, "shared query parsing should clean orphan boolean connectors after stripping structured operators");
  assert.equal(portalSource.includes("parseSearchQueryOperators(rawQuery)"), true, "results pages should parse source operators from URL queries");
  assert.equal(portalSource.includes("const routeSourceId = getRouteSourceId(params, parsedQuery);"), true, "typed site:/source: operators should remain query operators instead of being promoted to source URL params");
  assert.equal(portalSource.includes("function hasPositiveSourceOperator"), true, "results routing should distinguish typed source operators from clickable source filters");
  assert.equal(portalSource.includes("function createSourceDrilldownParams"), true, "source facet drilldowns should have dedicated routing for typed site:/source: queries");
  assert.equal(portalSource.includes("function getSourceDrilldownQuery(query = \"\", sourceId = \"\")"), true, "source facet drilldowns should normalize conflicting source operators before adding source= filters");
  assert.equal(portalSource.includes("return hasPositiveSourceOperator(parsedQuery) ? getDisplayQuery(query, parsedQuery) : String(query || \"\").trim();"), true, "source facet drilldowns should strip typed source operators when a specific source= filter is selected");
  assert.equal(portalSource.includes("const params = createSourceDrilldownParams(query, activeTab, facet.sourceId, 1, filters.sort, filters);"), true, "source facet links should strip broad site:/source: operators before adding specific source filters");
  assert.equal(portalSource.includes("const params = createSourceDrilldownParams(query, activeTab, sourceId, 1, filters.sort, filters);"), true, "source card more links should strip broad site:/source: operators before adding specific source filters");
  assert.equal(portalSource.includes("hasPositiveSourceOperator(parsedQuery) && !getValidSourceId(params.get(\"source\"))"), true, "route canonicalization should preserve typed source operators only when no explicit source= filter is active");
  assert.equal(portalSource.includes("const query = getRouteQuery(rawQuery, parsedQuery, params);"), true, "result routes should canonicalize stale source-operator plus source= URLs through source-aware query parsing");
  assert.equal(portalSource.includes("const visibleSourceFilter = queryHasSourceOperator && !filters.sourceIds?.length ? null : sourceFilter;"), true, "typed site:/source: result pages should not render as removable UI source filters");
  assert.equal(portalSource.includes("showMore: !isSourceScopedResult"), true, "typed site:/source: result pages should paginate the scoped result set instead of showing a source-filter self link");
  assert.equal(readmeSource.includes("keeps the typed operator in `q` when no explicit `source=` filter is active"), true, "README should describe typed site:/source: operators as visible shareable query state");
  assert.equal(readmeSource.includes("Clicking a specific source facet or source-card drilldown then removes broad typed source operators"), true, "README should document source drilldown behavior for broad typed site:/source: queries");
  assert.equal(readmeSource.includes("`site:rodong.rep.kp 원산` becomes `q=원산&source=rodong-sinmun`"), false, "README must not claim typed source operators are immediately promoted into source= routes");
  assert.equal(portalSource.includes("getValidResultTab(parsedQuery.tab)"), true, "media operators should be promoted to canonical tab URL params");
  assert.equal(portalSource.includes("getActiveFilters(params, parsedQuery)"), true, "language operators should be promoted with canonical date/language filter URL params");
  assert.equal(portalSource.includes("getActiveDateRange(params, parsedQuery)"), true, "date operators should be promoted to canonical date URL params");
  assert.equal(portalSource.includes("canonicalParams.set(\"tab\", activeTab)"), true, "media operator URLs should canonicalize into the existing tab= route state");
  assert.equal(portalSource.includes("canonicalParams.set(\"lang\", normalizedLanguage)"), true, "language operator URLs should canonicalize into shareable lang= route state");
  assert.equal(portalSource.includes("canonicalParams.set(\"after\", normalizedDateFrom)"), true, "after: operator URLs should canonicalize into shareable date route state");
  assert.equal(portalSource.includes("canonicalParams.set(\"before\", normalizedDateTo)"), true, "before: operator URLs should canonicalize into shareable date route state");
  assert.equal(portalSource.includes("canonicalParams.set(\"source\", activeSourceId)"), true, "source operator URLs should canonicalize into the existing source= route state");
  assert.equal(portalSource.includes("exclude_source"), true, "negative source operator URLs should canonicalize into a shareable source-exclusion route state");
  assert.equal(portalSource.includes("exclude_type"), true, "negative media operator URLs should canonicalize into a shareable media-exclusion route state");
  assert.equal(portalSource.includes("exclude_lang"), true, "negative language operator URLs should canonicalize into a shareable language-exclusion route state");
  assert.equal(portalSource.includes("getActiveExcludedSourceIds(params, parsedQuery)"), true, "results pages should parse negative source operators from URL queries");
  assert.equal(portalSource.includes("getActiveExcludedMediaTypes(params, parsedQuery)"), true, "results pages should parse negative media operators from URL queries");
  assert.equal(portalSource.includes("getActiveExcludedLanguages(params, parsedQuery)"), true, "results pages should parse negative language operators from URL queries");
  assert.equal(portalSource.includes("hasResultRouteParams(params)"), true, "document back links should preserve filter-only result routes");
  assert.equal(providerSource.includes("getIntegratedRank(left) - getIntegratedRank(right)"), true, "local filter-only search should mirror backend integrated media rank ordering");
  assert.equal(portalSource.includes("const parsedQuery = parseSearchQueryOperators(rawQuery);"), true, "search submissions should parse source operators before navigating");
  assert.equal(meiliResult.query, "원산갈마", "Meilisearch source operators should be stripped from the backend document query");
  assert.deepEqual(meiliResult.filters.sourceIds, ["rodong-sinmun"], "Meilisearch source operators should populate normalized source filters");
  assert.equal(meiliParenthesizedValueResult.query, "원산갈마", "Meilisearch site:(host) operators should be stripped from the backend document query");
  assert.deepEqual(meiliParenthesizedValueResult.filters.sourceIds, ["rodong-sinmun"], "Meilisearch site:(host) operators should populate normalized source filters");
  assert.equal(meiliParenthesizedValueRequests[0]?.body.q, "원산갈마해안관광지구", "Meilisearch site:(host) searches should preserve the canonical backend search text");
  assert.equal(/sourceId IN \["rodong-sinmun"\]/.test(meiliParenthesizedValueRequests[0]?.body.filter || ""), true, "Meilisearch site:(host) searches should send a backend source filter");
  assert.equal(meiliFilterOnlyResult.query, "", "Meilisearch filter-only source operators should strip to an empty backend text query");
  assert.equal(meiliFilterOnlyRequests.length, 1, "Meilisearch site: source operators should not make an unscoped source-facet request");
  assert.equal(meiliFilterOnlyRequests[0]?.body.q, "", "Meilisearch filter-only searches should send an empty q with real backend filters");
  assert.equal(meiliFilterOnlyRequests[0]?.body.filter?.includes('sourceId IN ["rodong-sinmun"]'), true, "Meilisearch filter-only source searches should still use backend sourceId filters");
  assert.equal(meiliFilterOnlyExcludeResult.query, "-원산", "Meilisearch structured negative-only text searches should preserve the visible exclusion query");
  assert.equal(meiliFilterOnlyExcludeRequests[0]?.body.q, "", "Meilisearch structured negative-only text searches should fetch an empty-q candidate window before client-side exclusion");
  assert.deepEqual(meiliFilterOnlyExcludeResult.documents.map((document) => document.id), ["fixture-site-rodong-image"], "Meilisearch structured negative-only text searches should remove excluded matches from backend candidates");
  assert.equal(meiliNegativeSourceResult.query, "원산갈마", "Meilisearch negative source operators should be stripped from the backend document query");
  assert.deepEqual(meiliNegativeSourceResult.filters.excludedSourceIds, ["kcna"], "Meilisearch negative source operators should populate normalized excluded source filters");
  assert.equal(meiliNegativeSourceRequests[0]?.body.filter?.includes('sourceId NOT IN ["kcna"]'), true, "Meilisearch negative source filters should use backend filter expressions instead of fake client-only exclusion");
  assert.equal(meiliNotSourceResult.query, "원산갈마", "Meilisearch NOT site: operators should be stripped from the backend document query");
  assert.deepEqual(meiliNotSourceResult.filters.excludedSourceIds, ["kcna"], "Meilisearch NOT site: operators should populate normalized excluded source filters");
  assert.equal(meiliNotSourceRequests[0]?.body.filter?.includes('sourceId NOT IN ["kcna"]'), true, "Meilisearch NOT site: filters should use backend source exclusion expressions");
  assert.equal(meiliFiletypeResult.query, "원산문헌", "Meilisearch media operators should be stripped from the backend document query");
  assert.equal(meiliFiletypeResult.filters.tab, "pdf", "Meilisearch media operators should populate normalized tab filters");
  assert.equal(meiliExtensionResult.query, "원산문헌", "Meilisearch ext: operators should be stripped from the backend document query");
  assert.equal(meiliExtensionResult.filters.tab, "pdf", "Meilisearch ext: operators should populate normalized tab filters");
  assert.equal(meiliNegativeFiletypeResult.query, "원산문헌", "Meilisearch negative media operators should be stripped from the backend document query");
  assert.deepEqual(meiliNegativeFiletypeResult.filters.excludedMediaTypes, ["pdf"], "Meilisearch negative media operators should populate normalized excluded media filters");
  assert.equal(meiliNegativeFiletypeRequests[0]?.body.filter?.includes('mediaType NOT IN ["pdf"]'), true, "Meilisearch negative media filters should use backend filter expressions");
  assert.equal(meiliNotFiletypeResult.query, "원산문헌", "Meilisearch NOT filetype: operators should be stripped from the backend document query");
  assert.deepEqual(meiliNotFiletypeResult.filters.excludedMediaTypes, ["pdf"], "Meilisearch NOT filetype: operators should populate normalized excluded media filters");
  assert.equal(meiliNotFiletypeRequests[0]?.body.filter?.includes('mediaType NOT IN ["pdf"]'), true, "Meilisearch NOT filetype: filters should use backend media exclusion expressions");
  assert.equal(meiliNegativeFiletypeOnlyResult.query, "", "Meilisearch negative media-only searches should strip to an empty backend text query");
  assert.equal(meiliNegativeFiletypeOnlyRequests[0]?.body.q, "", "Meilisearch negative media-only searches should send an empty q with real backend filters");
  assert.equal(meiliNegativeFiletypeOnlyRequests[0]?.body.filter?.includes('mediaType NOT IN ["pdf"]'), true, "Meilisearch negative media-only filters should use backend filter expressions");
  assert.equal(meiliDateResult.query, "기간", "Meilisearch date operators should be stripped from the backend document query");
  assert.equal(meiliDateResult.filters.dateFrom, "2026-01-01", "Meilisearch after: operators should populate normalized lower date bounds");
  assert.equal(meiliDateResult.filters.dateTo, "2026-12-31", "Meilisearch before: operators should populate normalized upper date bounds");
  assert.equal(meiliDateRangeResult.query, "기간", "Meilisearch date-range operators should be stripped from the backend document query");
  assert.equal(meiliDateRangeResult.filters.dateFrom, "2026-01-01", "Meilisearch date: operators should populate normalized lower date bounds");
  assert.equal(meiliDateRangeResult.filters.dateTo, "2026-12-31", "Meilisearch date: operators should populate normalized upper date bounds");
  assert.deepEqual(meiliParentDomainResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea", "minju-choson"], "Meilisearch parent-domain site: operators should populate every configured backend source filter");
  assert.equal(meiliParentDomainRequests[0]?.body.q, "원산갈마해안관광지구", "Meilisearch parent-domain site: searches should strip the site operator while preserving resolved backend query text");
  assert.equal(/sourceId IN \["rodong-sinmun", "voice-of-korea", "minju-choson"\]/.test(meiliParentDomainRequests[0]?.body.filter || ""), true, "Meilisearch parent-domain site: searches should send a multi-source backend filter");
  assert.deepEqual(meiliTldResult.filters.sourceIds, ["rodong-sinmun", "kcna", "voice-of-korea", "minju-choson", "ryugyong", "naenara", "korean-books"], "Meilisearch bare TLD site: operators should populate every configured backend source filter under that host suffix");
  assert.equal(meiliTldRequests[0]?.body.q, "원산갈마해안관광지구", "Meilisearch bare TLD site: searches should strip the site operator while preserving resolved backend query text");
  assert.equal(/sourceId IN \["rodong-sinmun", "kcna", "voice-of-korea", "minju-choson", "ryugyong", "naenara", "korean-books"\]/.test(meiliTldRequests[0]?.body.filter || ""), true, "Meilisearch bare TLD site: searches should send a multi-source backend filter");
  assert.deepEqual(meiliKoreanSiteAliasResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea", "minju-choson"], "Meilisearch Korean 사이트: aliases should populate every configured backend source filter under that host suffix");
  assert.equal(meiliKoreanSiteAliasRequests[0]?.body.q, "원산갈마해안관광지구", "Meilisearch Korean 사이트: searches should strip the site operator while preserving resolved backend query text");
  assert.equal(/sourceId IN \["rodong-sinmun", "voice-of-korea", "minju-choson"\]/.test(meiliKoreanSiteAliasRequests[0]?.body.filter || ""), true, "Meilisearch Korean 사이트: searches should send a multi-source backend filter");
  assert.deepEqual(meiliWildcardParentDomainResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea", "minju-choson"], "Meilisearch wildcard parent-domain site: operators should populate every configured backend source filter");
  assert.equal(meiliWildcardParentDomainRequests[0]?.body.q, "원산갈마해안관광지구", "Meilisearch wildcard parent-domain site: searches should strip the site operator while preserving resolved backend query text");
  assert.equal(/sourceId IN \["rodong-sinmun", "voice-of-korea", "minju-choson"\]/.test(meiliWildcardParentDomainRequests[0]?.body.filter || ""), true, "Meilisearch wildcard parent-domain site: searches should send a multi-source backend filter");
  assert.equal(meiliSourceOrResult.query, "원산갈마", "Meilisearch OR-joined source operators should strip orphan boolean connectors from the backend query");
  assert.deepEqual(meiliSourceOrResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea"], "Meilisearch OR-joined source operators should populate every normalized source filter");
  assert.equal(meiliSourceOrRequests[0]?.body.q, "원산갈마해안관광지구", "Meilisearch OR-joined source operators should preserve the canonical backend search text without a literal OR token");
  assert.equal(/sourceId IN \["rodong-sinmun", "voice-of-korea"\]/.test(meiliSourceOrRequests[0]?.body.filter || ""), true, "Meilisearch OR-joined source operators should send a multi-source backend filter");
  assert.equal(meiliParenthesizedSourceOrResult.query, "원산갈마", "Meilisearch parenthesized OR-joined source operators should strip orphan boolean connectors from the backend query");
  assert.deepEqual(meiliParenthesizedSourceOrResult.filters.sourceIds, ["rodong-sinmun", "voice-of-korea"], "Meilisearch parenthesized OR-joined source operators should populate every normalized source filter");
  assert.equal(meiliParenthesizedSourceOrRequests[0]?.body.q, "원산갈마해안관광지구", "Meilisearch parenthesized source operators should preserve the canonical backend search text without literal parentheses");
  assert.equal(/sourceId IN \["rodong-sinmun", "voice-of-korea"\]/.test(meiliParenthesizedSourceOrRequests[0]?.body.filter || ""), true, "Meilisearch parenthesized OR-joined source operators should send a multi-source backend filter");
  assert.equal(meiliLanguageResult.query, "Wonsan", "Meilisearch language operators should be stripped from the backend document query");
  assert.deepEqual(meiliLanguageResult.filters.languages, ["en"], "Meilisearch language operators should populate normalized language filters");
  assert.equal(meiliNegativeLanguageResult.query, "원산갈마", "Meilisearch negative language operators should be stripped from the backend document query");
  assert.deepEqual(meiliNegativeLanguageResult.filters.excludedLanguages, ["en"], "Meilisearch negative language operators should populate normalized excluded language filters");
  assert.equal(meiliNegativeLanguageRequests[0]?.body.filter?.includes('language NOT IN ["en"]'), true, "Meilisearch negative language filters should use backend filter expressions");
  assert.equal(meiliNotLanguageResult.query, "원산갈마", "Meilisearch NOT lang: operators should be stripped from the backend document query");
  assert.deepEqual(meiliNotLanguageResult.filters.excludedLanguages, ["en"], "Meilisearch NOT lang: operators should populate normalized excluded language filters");
  assert.equal(meiliNotLanguageRequests[0]?.body.filter?.includes('language NOT IN ["en"]'), true, "Meilisearch NOT lang: filters should use backend language exclusion expressions");
  assert.equal(meiliNegativeLanguageOnlyResult.query, "", "Meilisearch negative language-only searches should strip to an empty backend text query");
  assert.equal(meiliNegativeLanguageOnlyRequests[0]?.body.q, "", "Meilisearch negative language-only searches should send an empty q with real backend filters");
  assert.equal(meiliNegativeLanguageOnlyRequests[0]?.body.filter?.includes('language NOT IN ["en"]'), true, "Meilisearch negative language-only filters should use backend filter expressions");
}

async function assertResultsShowProviderBackedSummary() {
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");
  const css = await fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8");
  const provider = new LocalJsonSearchProvider({
    sources: [{
      id: "kcna",
      name: "조선중앙통신",
      sourceType: "official_site",
      baseUrl: "http://www.kcna.kp/",
      languages: ["ko"],
      mediaTypes: ["article"],
      aliases: ["KCNA"],
    }],
    documents: [{
      id: "fixture-summary-timing",
      title: "요약 검색 결과",
      snippet: "검색 요약 처리시간 시험 문서입니다.",
      date: "2026-05-19",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      sourceType: "official_site",
      mediaType: "article",
      url: "http://www.kcna.kp/fixture-summary",
      archiveUrl: "",
      thumbnailUrl: "",
      language: "ko",
      aliases: [],
    }],
  });
  const localResult = await provider.searchDocuments("요약");
  const localEmptyResult = await provider.searchDocuments("없는검색어");

  assert.equal(Number.isFinite(localResult.processingTimeMs), true, "local JSON search should report processing time for Google-like result summaries");
  assert.equal(localResult.processingTimeMs >= 0, true, "local JSON processing time should never be negative");
  assert.equal(Number.isFinite(localEmptyResult.processingTimeMs), true, "local JSON empty results should still report processing time");
  assert.equal(portalSource.includes("createResultSummary"), true, "results UI should render provider-backed result counts");
  assert.equal(portalSource.includes("searchResult.total"), true, "result summary should use provider totals instead of counting rendered cards");
  assert.equal(portalSource.includes("searchResult.sourceFacets"), true, "result summary should use provider source facets for source count");
  assert.equal(portalSource.includes("const sourceFacetTotal = getSourceFacetTotal(searchResult.sourceFacets);"), true, "source-filtered summaries should compute the all-source total from provider facets");
  assert.equal(portalSource.includes('if (sourceFilter && sourceFacetTotal > total) parts.push(`전체 ${formatCount(sourceFacetTotal)}건`);'), true, "source-filtered summaries should expose the broader all-source result count");
  assert.equal(portalSource.includes("if (sourceCount > 1) parts.push(`${formatCount(sourceCount)}개 자료원`);"), true, "source-filtered summaries should still reveal how many source facets are available");
  assert.equal(portalSource.includes("processingTimeMs"), true, "result summary should expose backend processing time when available");
  assert.equal(portalSource.includes("formatSearchSeconds(processingTimeMs)"), true, "result summary should render provider processing time as localized seconds");
  assert.equal(portalSource.includes("formatCount"), true, "result summary should locale-format Korean counts");
  assert.equal(css.includes(".search-result-summary"), true, "result summary should have scoped styling");
}

async function assertResultsSupportShareableSortModes() {
  const provider = new LocalJsonSearchProvider({
    sources: [{
      id: "kcna",
      name: "조선중앙통신",
      sourceType: "official_site",
      baseUrl: "http://www.kcna.kp/",
      languages: ["ko"],
      mediaTypes: ["article"],
      aliases: ["KCNA"],
    }],
    documents: [
      {
        id: "fixture-sort-relevance",
        title: "정렬",
        snippet: "정렬 관련도 높은 오래된 문서입니다.",
        date: "2026-05-10",
        sourceId: "kcna",
        sourceName: "조선중앙통신",
        sourceType: "official_site",
        mediaType: "article",
        url: "http://www.kcna.kp/sort/relevance",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-sort-latest",
        title: "최신 보도",
        snippet: "정렬 시험을 위한 최신 문서입니다.",
        date: "2026-05-20",
        sourceId: "kcna",
        sourceName: "조선중앙통신",
        sourceType: "official_site",
        mediaType: "article",
        url: "http://www.kcna.kp/sort/latest",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const [relevanceResult, latestResult, portalSource, css, cliSource] = await Promise.all([
    provider.searchDocuments("정렬", { sort: "relevance" }),
    provider.searchDocuments("정렬", { sort: "latest" }),
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "scripts/search-local.ts"), "utf8"),
  ]);

  assert.equal(relevanceResult.filters.sort, "relevance", "local JSON search should normalize relevance as the default sort");
  assert.equal(latestResult.filters.sort, "latest", "local JSON search should expose latest sort in the provider result filters");
  assert.equal(relevanceResult.documents[0]?.id, "fixture-sort-relevance", "default relevance sort should keep strongest textual matches first");
  assert.equal(latestResult.documents[0]?.id, "fixture-sort-latest", "latest sort should order real indexed results by document date before score");
  assert.equal(portalSource.includes("SEARCH_SORTS"), true, "results UI should define stable shareable sort modes");
  assert.equal(portalSource.includes("createSortControls"), true, "results UI should render Google-like sort controls near result counts");
  assert.equal(portalSource.includes('nav.setAttribute("aria-label", "검색 결과 정렬")'), true, "sort controls should have an accessible navigation label");
  assert.equal(portalSource.includes('if (normalizedSort !== "relevance") params.set("sort", normalizedSort);'), true, "result URLs should include only non-default sort params");
  assert.equal(portalSource.includes("filters.sort"), true, "result links should preserve the active sort through facets, pagination, and document viewer links");
  assert.equal(portalSource.includes('sort: activeSort'), true, "provider searches should receive the URL-derived sort mode");
  assert.equal(portalSource.includes("sort: filters.sort,\n      languages: filters.languages || (filters.language ? [filters.language] : []),\n      excludedLanguages: filters.excludedLanguages || [],\n      dateFrom: filters.dateFrom,"), true, "provider searches should pass URL-derived structured filters instead of only decorating links");
  assert.equal(css.includes(".search-sort-controls"), true, "sort controls should have scoped styling");
  assert.equal(css.includes(".search-sort-link.active"), true, "active sort links should have scoped styling");
  assert.equal(cliSource.includes('getArgumentValue("--sort")'), true, "local search CLI should expose the same sort modes for debugging");
}

async function assertDateFiltersHaveVisibleClearState() {
  const [portalSource, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(portalSource.includes("createDateFilterState"), true, "results UI should render a visible date filter state for after:/before: searches");
  assert.equal(portalSource.includes("createAppliedFilterStates([filterState, excludedSourceFilterState, excludedMediaFilterState, languageFilterState, excludedLanguageFilterState, dateFilterState])"), true, "source, excluded-source, excluded-media, language, excluded-language, and date filters should share a compact applied-filter row");
  assert.equal(portalSource.includes("createLanguageFilterState"), true, "results UI should render a visible language filter state for lang: searches");
  assert.equal(portalSource.includes("createExcludedLanguageFilterState"), true, "results UI should render a visible excluded-language filter state for -lang: searches");
  assert.equal(portalSource.includes("createExcludedMediaFilterState"), true, "results UI should render a visible excluded-media filter state for -filetype: searches");
  assert.equal(portalSource.includes('badge.textContent = "언어 필터"'), true, "language filter state should label the active language restriction clearly");
  assert.equal(portalSource.includes('badge.textContent = "기간 필터"'), true, "date filter state should label the active date restriction clearly");
  assert.equal(portalSource.includes('clear.textContent = "기간 해제"'), true, "date filter state should include a clear/reset action");
  assert.equal(portalSource.includes('createResultParams(query, activeTab, filters.sourceIds?.[0] || "", 1, filters.sort, { ...filters, dateFrom: "", dateTo: "" })'), true, "date filter clear links should preserve query, tab, source, sort, language, and excluded-source filters while removing dates");
  assert.equal(portalSource.includes("createDateFilterClearAccessibleLabel"), true, "date filter clear links should expose which date filter they remove");
  assert.equal(portalSource.includes('state.setAttribute("aria-label", `${name} 기간 필터 적용됨`)'), true, "date filter state should announce active date bounds to assistive tech");
  assert.equal(css.includes(".search-filter-states"), true, "applied filter chips should have a scoped flex row");
  assert.equal(css.includes(".search-filter-state-date"), true, "date filter chips should expose a stable modifier class");
}

async function assertSourceFilteringHasClearState() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "minju-choson",
        name: "민주조선",
        sourceType: "official_site",
        baseUrl: "http://www.minju.rep.kp/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: ["Minju Choson"],
      },
      {
        id: "kcna",
        name: "조선중앙통신",
        sourceType: "official_site",
        baseUrl: "http://www.kcna.kp/",
        languages: ["ko"],
        mediaTypes: ["article"],
        aliases: ["KCNA"],
      },
    ],
    documents: [
      {
        id: "fixture-minju-source-filter",
        title: "평양 소식",
        snippet: "평양 관련 민주조선 기사입니다.",
        date: "2026-05-19",
        sourceId: "minju-choson",
        sourceName: "민주조선",
        sourceType: "official_site",
        mediaType: "article",
        url: "http://www.minju.rep.kp/fixture",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
      {
        id: "fixture-kcna-source-filter",
        title: "평양 보도",
        snippet: "평양 관련 조선중앙통신 기사입니다.",
        date: "2026-05-19",
        sourceId: "kcna",
        sourceName: "조선중앙통신",
        sourceType: "official_site",
        mediaType: "article",
        url: "http://www.kcna.kp/fixture",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
      },
    ],
  });
  const result = await provider.searchDocuments("평양", { sourceIds: ["minju-choson"] });
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");
  const css = await fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8");

  assert.deepEqual(result.documents.map((document) => document.sourceId), ["minju-choson"], "source filter should restrict document retrieval");
  assert.deepEqual(result.sourceFilters, [{ sourceId: "minju-choson", sourceName: "민주조선" }], "source filter should expose a display name for UI state");
  assert.equal(portalSource.includes("createSourceFilterState"), true, "results UI should render active source filter state");
  assert.equal(portalSource.includes("자료원 필터"), true, "source filter state should label the active source restriction clearly");
  assert.equal(portalSource.includes("search-filter-badge"), true, "source filter state should expose a stable badge class");
  assert.equal(portalSource.includes("search-filter-name"), true, "source filter state should expose a stable source-name class");
  assert.equal(portalSource.includes("전체 결과"), true, "source filter state should include a clear/reset action");
  assert.equal(portalSource.includes("createSourceFilterClearAccessibleLabel"), true, "source filter clear links should expose which source filter they remove");
  assert.equal(portalSource.includes('clear.setAttribute("aria-label", createSourceFilterClearAccessibleLabel(name))'), true, "source filter clear action should not rely on generic visible text alone");
  assert.equal(portalSource.includes("createSourceFacetFilters(\n    query,\n    activeTab,\n    searchResult.sourceFacets || [],\n    activeFacetSourceId,\n    filters,\n  )"), true, "source-filtered result pages should still render source facet navigation");
  assert.equal(portalSource.includes("createSourceFacetLink"), true, "source-filtered pages should share facet link behavior for clear/reset actions");
  assert.equal(portalSource.includes("function getActiveFacetSourceId"), true, "archive source filters should not masquerade as display-source facets");
  assert.equal(portalSource.includes('link.setAttribute("aria-current", "true")'), true, "active source facet should expose aria-current");
  assert.equal(portalSource.includes("createContextualSearchSubmit(activeTab, activeSourceId, activeSort, activeDateRange)"), true, "search boxes on filtered result views should preserve the active tab, source, sort, date, and language context");
  assert.equal(portalSource.includes("const submitInContext = createContextualSearchSubmit();"), true, "home autocomplete should use the contextual submit path so source suggestions can become source filters");
  assert.equal(portalSource.includes("const suggestionSourceId = suggestion?.type === \"source\" ? suggestion.sourceId : \"\";"), true, "source autocomplete selections should override the active source filter with the selected source");
  assert.equal(portalSource.includes("submitSearch(value, { activeTab, sourceId: suggestionSourceId || sourceId, sort: activeSort, ...dateRange });"), true, "contextual result searches should reuse the central submit path with explicit source, sort, date, and language context");
  assert.equal(portalSource.includes("const activeTab = operatorTab || getValidResultTab(context.activeTab) || \"all\";"), true, "contextual result searches should validate tab context before navigating");
  assert.equal(portalSource.includes("const sourceId = preserveSourceOperator ? \"\" : (operatorSourceId || getValidSourceId(context.sourceId));"), true, "contextual result searches should not turn typed site:/source: operators into broad source-filter pages");
  assert.equal(portalSource.includes("const params = createResultParams(query, activeTab, sourceId, 1, sort, { dateFrom, dateTo, language, excludedSourceIds, excludedMediaTypes, excludedLanguages });"), true, "contextual result searches should reset pagination while preserving tab/source/sort/date/language/excluded-source/excluded-media/excluded-language filters");
  assert.equal(portalSource.includes("onInput: (value) => refreshSuggestions(suggestions, value, submitInContext)"), true, "autocomplete refreshes should keep contextual submit behavior after suggestions update");
  assert.equal(portalSource.includes("const suggestions = createSearchSuggestions({ suggestions: [], onSelect: submitInContext });"), true, "initial autocomplete suggestions should submit within the active result context");
  assert.equal(portalSource.includes("connectSearchSuggestions(bar.input, suggestions, { onSelect: submitInContext })"), true, "keyboard autocomplete selection should submit within the active result context");
  assert.equal(portalSource.includes("async function refreshSuggestions(list, value, onSelect = submitSearch)"), true, "suggestion refresh should accept a contextual selection handler");
  assert.equal(portalSource.includes("updateSearchSuggestions(list, suggestions, onSelect)"), true, "suggestion refresh should not replace contextual selection with global search");
  assert.equal(css.includes(".search-filter-state"), true, "source filter state should have scoped styling");
  assert.equal(css.includes(".search-filter-badge"), true, "source filter badge should have scoped styling");
  assert.equal(css.includes(".search-filter-name"), true, "source filter name should have scoped styling");
  assert.equal(css.includes(".search-source-facet.active"), true, "active source facet should have scoped styling");
}

async function assertSourceFilteredCardsCanRenderFullResultPage() {
  const cardSource = await fs.readFile(path.join(ROOT_DIR, "components/SourceResultCard.js"), "utf8");
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");

  assert.equal(cardSource.includes("options.resultLimit"), true, "source result card should expose a configurable preview limit");
  assert.equal(cardSource.includes("getVideoResultLimit(resultLimit) : resultLimit"), true, "source result card should use the configured preview limit while keeping grouped video previews to the Figma size");
  assert.equal(cardSource.includes("return resultLimit > 5 ? resultLimit : 4;"), true, "video source-filtered pages should not be capped to the grouped four-card preview");
  assert.equal(portalSource.includes("resultLimit: isSourceScopedResult ? group.results.length : getSourcePreviewLimit(groupedCards, group)"), true, "source-filtered and typed site: pages should render all returned source results");
  assert.equal(portalSource.includes("function getSourcePreviewLimit"), true, "grouped source cards should use a contextual preview limit instead of a hard-coded cap");
}

async function assertResultsPaginationUsesProviderOffsets() {
  const documents = Array.from({ length: 12 }, (_, index) => ({
    id: `fixture-page-${index + 1}`,
    title: `페이지 검색 결과 ${index + 1}`,
    snippet: "페이지네이션 시험 문서입니다.",
    date: `2026-05-${String(12 - index).padStart(2, "0")}`,
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    sourceType: "official_site",
    mediaType: "article",
    url: `http://www.kcna.kp/fixture/${index + 1}`,
    archiveUrl: "",
    thumbnailUrl: "",
    language: "ko",
    aliases: [],
  }));
  const provider = new LocalJsonSearchProvider({
    sources: [{
      id: "kcna",
      name: "조선중앙통신",
      sourceType: "official_site",
      baseUrl: "http://www.kcna.kp/",
      languages: ["ko"],
      mediaTypes: ["article"],
      aliases: ["KCNA"],
    }],
    documents,
  });
  const pageTwo = await provider.searchDocuments("페이지", { limit: 5, offset: 5 });
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");
  const css = await fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8");

  assert.equal(pageTwo.total, 12, "provider should report the full match count while returning a page");
  assert.deepEqual(pageTwo.documents.map((document) => document.id), ["fixture-page-6", "fixture-page-7", "fixture-page-8", "fixture-page-9", "fixture-page-10"], "provider offset should return the requested page slice");
  assert.equal(pageTwo.groupedSources[0].total, 12, "source-group totals should count all source matches, not only the returned page slice");
  assert.equal(pageTwo.groupedSources[0].results.length, 5, "source-group results should remain the returned page slice");
  assert.equal(portalSource.includes("RESULTS_PAGE_SIZE"), true, "results UI should define a page size");
  assert.equal(portalSource.includes("createPaginationNodes"), true, "results UI should render pagination when total exceeds the current page");
  assert.equal(portalSource.includes("if (!Number.isFinite(total) || !Number.isFinite(limit) || total <= limit) return [];"), true, "pagination should work for whole-result and source-filtered views");
  assert.equal(portalSource.includes('count.textContent = `${formatCount(start)}-${formatCount(end)} / ${formatCount(total)}`'), true, "pagination range counts should use localized number formatting");
  assert.equal(portalSource.includes('link.removeAttribute("href")'), true, "disabled pagination controls should not ship dead href placeholders");
  assert.equal(portalSource.includes('link.href = enabled ?'), false, "pagination should avoid # href fallbacks for disabled controls");
  assert.equal(portalSource.includes("createPaginationAccessibleLabel"), true, "pagination controls should expose destination context beyond repeated previous/next text");
  assert.equal(portalSource.includes('link.setAttribute("aria-label", createPaginationAccessibleLabel(label, page, enabled))'), true, "pagination links should include their target page in accessible names");
  assert.equal(portalSource.includes("getPageOffset"), true, "results UI should convert page numbers to provider offsets");
  assert.equal(portalSource.includes("shouldRedirectOutOfRangePage"), true, "results UI should recover from stale source-page URLs beyond the last page");
  assert.equal(portalSource.includes("return page > 1\n    && total > 0"), true, "out-of-range recovery should apply to whole-result and source-filtered pagination");
  assert.equal(portalSource.includes("getLastResultPage"), true, "results UI should compute the last valid page from provider totals");
  assert.equal(portalSource.includes("replaceResults(createResultParams"), true, "out-of-range source-page recovery should canonicalize the URL without adding history noise");
  assert.equal(portalSource.includes('const page = normalizePage(params.get("page"))'), true, "document back links should preserve result pagination state");
  assert.equal(css.includes(".search-pagination"), true, "pagination should have scoped styling");
}

async function assertDocumentViewerUsesRicherIndexedPreview() {
  const [portalSource, css] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8"),
    fs.readFile(path.join(ROOT_DIR, "search/search.css"), "utf8"),
  ]);

  assert.equal(portalSource.includes("findRicherIndexedPreview"), true, "document viewer should try to recover richer article bodies from the indexed corpus");
  assert.equal(portalSource.includes("createEmbeddedPreviewRecord"), true, "document viewer should consume backend previewText from Meilisearch document lookups");
  assert.equal(portalSource.includes("isWeakArticlePreview"), true, "document viewer should detect title-only article previews");
  assert.equal(portalSource.includes("같은 기사로 색인된"), true, "document viewer should disclose when it shows a richer body from another indexed source");
  assert.equal(portalSource.includes("아직 이 자료의 본문이 충분히 색인되지 않았습니다."), true, "document viewer should not silently present title-only bodies as full article text");
  assert.equal(css.includes(".search-document-preview-notice"), true, "document viewer body-quality notices should have scoped styling");
}

async function assertBackendDocumentLookupsPreservePreviewFields() {
  const provider = new MeilisearchSearchProvider({
    host: "https://meili.example.test",
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "backend-preview-record",
        title: "전군의 사,려단 지휘관회합",
        snippet: "전군의 사,려단 지휘관회합",
        date: "2026-05-20",
        sourceId: "minju-choson",
        sourceName: "민주조선",
        sourceType: "official_site",
        mediaType: "article",
        url: "http://www.minju.rep.kp/fixture",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: [],
        previewText: "조선로동당 총비서이신 경애하는 김정은동지께서 회합 참가자들을 만나 뜻깊은 연설을 하시였다.",
        previewSourceName: "조선중앙통신",
        previewDocumentId: "kcna-rich-preview",
      }),
    }),
  });
  const document = await provider.getDocumentById("backend-preview-record");
  const schemasSource = await fs.readFile(path.join(ROOT_DIR, "search/schemas.js"), "utf8");
  const portalSource = await fs.readFile(path.join(ROOT_DIR, "search/searchPortal.js"), "utf8");

  assert.equal(document?.previewText.includes("조선로동당 총비서"), true, "Meilisearch document lookups should preserve enriched previewText");
  assert.equal(document?.previewSourceName, "조선중앙통신", "Meilisearch document lookups should preserve preview source provenance");
  assert.equal(document?.previewDocumentId, "kcna-rich-preview", "Meilisearch document lookups should preserve preview document provenance");
  assert.equal(schemasSource.includes("previewText: normalizeKoreanSourceBodySpacing"), true, "schema normalization should keep backend preview text fields");
  assert.equal(portalSource.includes("record.previewText"), true, "document viewer should read embedded previewText before issuing recovery searches");
}

async function assertWeakArticleResultsUseRicherIndexedPreview(productionDocumentsText) {
  const productionDocuments = parseJsonl(productionDocumentsText);
  const weakMinjuDocument = productionDocuments.find((document) => (
    document.sourceId === "minju-choson"
    && document.mediaType === "article"
    && /전군의 사/.test(document.title)
  ));
  assert.equal(Boolean(weakMinjuDocument), true, "production fixture should include a weak 민주조선 article preview to guard enrichment");

  const provider = new LocalJsonSearchProvider({
    documents: productionDocuments,
    sources: SEARCH_SOURCES,
  });
  const result = await provider.searchDocuments(weakMinjuDocument.title, {
    tab: "all",
    sourceIds: ["minju-choson"],
    limit: 10,
  });
  const enriched = result.documents.find((document) => document.id === weakMinjuDocument.id);

  assert.equal(Boolean(enriched), true, "weak source-filtered article should still be returned");
  assert.equal(Boolean(enriched.previewSourceName), true, "weak article result should disclose the indexed source used for richer preview text");
  assert.notEqual(enriched.displaySnippet, weakMinjuDocument.snippet, "weak article result should not render the title-only snippet");
  assert.equal(enriched.displaySnippet.length > weakMinjuDocument.snippet.length, true, "weak article result should show richer body text from the indexed corpus");
  assert.equal(/!?\[[^\]]*]\([^)]+\)|https?:\/\//.test(enriched.displaySnippet), false, "enriched article result snippets should not expose raw Markdown links");
}

async function assertVideosAppearInAll() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "koryo-vod",
        name: "고려TV VOD",
        sourceType: "video_archive",
        baseUrl: "https://vod.koryo.tv/",
        languages: ["ko"],
        mediaTypes: ["video"],
        searchTabs: ["all", "video"],
        aliases: ["고려TV"],
      },
    ],
    documents: [
      {
        id: "fixture-koryo-vod",
        title: "The Ripening Grains / 이삭은 여물어간다",
        snippet: "고려TV VOD 동영상 검색 전용 시험 문서입니다.",
        date: "2026-05-19",
        sourceId: "koryo-vod",
        sourceName: "고려TV VOD",
        sourceType: "video_archive",
        mediaType: "video",
        url: "https://vod.koryo.tv/fixture",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: ["평양", "The Ripening Grains", "이삭은 여물어간다"],
      },
    ],
  });
  const allResults = await provider.searchDocuments("평양", { tab: "all" });
  const videoResults = await provider.searchDocuments("평양", { tab: "video" });
  const englishVideoResults = await provider.searchDocuments("The Ripening Grains", { tab: "video" });
  assert.equal(allResults.documents[0]?.id, "fixture-koryo-vod", "동영상 결과는 전체에도 나타나야 합니다");
  assert.equal(videoResults.documents[0]?.id, "fixture-koryo-vod", "고려TV VOD records must appear in 동영상 search");
  assert.equal(englishVideoResults.documents[0]?.id, "fixture-koryo-vod", "natural English video titles should not be split through Hangul QWERTY normalization");
}

async function assertYouTubeVideosAppearInAll() {
  const provider = new LocalJsonSearchProvider({
    sources: [
      {
        id: "youtube",
        name: "YouTube",
        sourceType: "video_archive",
        baseUrl: "https://www.youtube.com/",
        languages: ["ko"],
        mediaTypes: ["video"],
        searchTabs: ["all", "video"],
        aliases: ["메아리", "supersuhui"],
      },
    ],
    documents: [
      {
        id: "fixture-youtube-video",
        title: "김정은동지께서 현지지도하시였다",
        snippet: "YouTube 메아리 동영상 검색 결과입니다.",
        date: "2026-05-19",
        sourceId: "youtube",
        sourceName: "YouTube",
        sourceType: "video_archive",
        mediaType: "video",
        url: "https://www.youtube.com/watch?v=fixture",
        archiveUrl: "",
        thumbnailUrl: "",
        language: "ko",
        aliases: ["메아리"],
        searchTabs: ["all", "video"],
      },
    ],
  });
  const allResults = await provider.searchDocuments("김정은", { tab: "all" });
  const videoResults = await provider.searchDocuments("김정은", { tab: "video" });

  assert.equal(allResults.documents[0]?.sourceId, "youtube", "YouTube records must appear in 전체 search");
  assert.equal(videoResults.documents[0]?.sourceId, "youtube", "YouTube records must appear in 동영상 search");
  assert.equal(allResults.groupedSources[0]?.sourceName, "YouTube", "YouTube channels should render as one source group");
}

async function readJsonl(filePath) {
  return parseJsonl(await fs.readFile(filePath, "utf8"));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function dispatchKeyboardEvent(element, key) {
  const event = {
    type: "keydown",
    key,
    isComposing: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  element.dispatchEvent(event);
  return event;
}

class TestDocument {
  createElement(tagName) {
    return new TestElement(tagName);
  }

  createTextNode(text) {
    return new TestTextNode(text);
  }
}

class TestClassList {
  constructor(element) {
    this.element = element;
  }

  add(...names) {
    const classes = this.getClasses();
    for (const name of names) {
      if (name) classes.add(name);
    }
    this.element.className = [...classes].join(" ");
  }

  toggle(name, enabled) {
    const classes = this.getClasses();
    if (enabled) {
      classes.add(name);
    } else {
      classes.delete(name);
    }
    this.element.className = [...classes].join(" ");
  }

  remove(name) {
    const classes = this.getClasses();
    classes.delete(name);
    this.element.className = [...classes].join(" ");
  }

  getClasses() {
    return new Set(String(this.element.className || "").split(/\s+/).filter(Boolean));
  }
}

class TestElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.classList = new TestClassList(this);
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.id = "";
    this.listeners = new Map();
    this.value = "";
    this.textValue = "";
  }

  set textContent(value) {
    this.textValue = String(value ?? "");
    this.children = [];
  }

  get textContent() {
    return `${this.textValue}${this.children.map((child) => child.textContent).join("")}`;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target = this;
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
  }

  querySelectorAll(selector) {
    if (!selector.startsWith(".")) return [];
    const className = selector.slice(1);
    const matches = [];
    const walk = (node) => {
      if (String(node.className || "").split(/\s+/).includes(className)) matches.push(node);
      for (const child of node.children || []) walk(child);
    };
    walk(this);
    return matches;
  }

  scrollIntoView() {}
}

class TestTextNode {
  constructor(text) {
    this.textValue = String(text ?? "");
  }

  get textContent() {
    return this.textValue;
  }
}

async function listRuntimeFiles(directories) {
  const files = [];
  for (const directory of directories) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await listRuntimeFiles([entryPath]));
      } else if (/\.(js|ts|tsx|html|json|jsonl|css)$/.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

async function invokeSearchAssetProxy({ method = "GET", assetUrl = "", headers = {}, fetchImpl }) {
  const originalFetch = globalThis.fetch;
  const responseHeaders = new Map();
  const response = {
    statusCode: 0,
    body: undefined,
    setHeader(name, value) {
      responseHeaders.set(String(name).toLocaleLowerCase("en-US"), String(value));
    },
    end(body) {
      this.body = body;
    },
    headers: responseHeaders,
  };

  globalThis.fetch = fetchImpl;
  try {
    await searchAssetHandler({
      method,
      headers,
      query: { url: assetUrl },
    }, response);
  } finally {
    globalThis.fetch = originalFetch;
  }

  return response;
}

function snapshotProxyEnv() {
  return Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function clearProxyEnv() {
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
}

function restoreProxyEnv(snapshot = {}) {
  clearProxyEnv();
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) process.env[key] = value;
  }
}

const PROXY_ENV_KEYS = [
  "DPRK_SEARCH_ASSET_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "DPRK_SEARCH_PROXY_DIRECT_FALLBACK",
  "NO_PROXY",
  "no_proxy",
];

function assertCssCustomPropertiesResolved(css = "", label = "css") {
  const definitions = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
  const references = [...new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]))];
  const missing = references.filter((name) => !definitions.has(name));
  assert.deepEqual(missing, [], `${label} should not reference undefined CSS custom properties`);
}

function urlMatchesSourceHost(value, source) {
  const sourceHost = canonicalHost(source?.baseUrl);
  const valueHost = canonicalHost(value);
  return Boolean(sourceHost && valueHost && (valueHost === sourceHost || valueHost.endsWith(`.${sourceHost}`)));
}

function canonicalHost(value = "") {
  try {
    return new URL(value).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractKcnaDatelineMonthDay(value = "") {
  const match = String(value || "").match(/[（(【]\s*[^）)】\n]{0,120}?(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*발\s*조선중앙통신[^）)】\n]{0,40}[）)】]/u)
    || String(value || "").match(/(?:평양|[가-힣]{2,12})\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*발\s*조선중앙통신/u);
  return match ? `${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : "";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
