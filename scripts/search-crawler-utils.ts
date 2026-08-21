#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { ProxyAgent } from "undici";
import { parseJsonl, stringifyJsonl } from "../search/localIndex.js";

export const DEFAULT_IMPORT_DIR = path.resolve("data/import");
export const DEFAULT_USER_AGENT = "DPRKArchiveSearchBot/0.1 (+https://nkarchive.vercel.app/search)";
export const READABLE_FETCH_PREFIX = "https://r.jina.ai/http://";
export const DEFAULT_FETCH_CACHE_DIR = path.join(DEFAULT_IMPORT_DIR, "fetch-cache");
const KCNA_GENERIC_TITLES = new Set([
  "최신소식",
  "대외관계",
  "혁명일화",
  "국내소식",
  "정치",
  "경제",
  "문화",
  "군사",
  "사회생활",
  "사회주의헌법",
  "미담",
  "력사",
  "world",
  "politics",
  "economy",
  "culture",
  "military",
  "society",
  "external relations",
  "revolutionary anecdotes",
  "最新ニュース",
  "국제新闻",
  "国内新闻",
  "政治",
  "经济",
  "军事",
  "社会生活",
]);
const FORBIDDEN_MANUAL_WONSAN_BACKFILL_IDS = new Set([
  "rodong-sinmun-wonsan-kalma-ceremony-2025-06-26",
  "voice-of-korea-wonsan-kalma-ceremony-2025-06-26",
  "kcna-wonsan-kalma-ceremony-2025-06-26",
  "kcna-wonsan-kalma-kim-jong-un-ceremony-2025-06-26",
]);
let fetchProxyAgent = null;
let fetchProxyAgentUrl = "";

export async function crawlSources(sources, {
  limitPerSource = 25,
  concurrency = 2,
  timeoutMs = 12000,
  maxSourceMs = 90000,
  timeoutMsExplicit = false,
  maxLinksPerSource = 80,
  maxDiscoveryPages = 8,
  maxDetailFetchesPerSource = 0,
  maxPdfTextFetchesPerSource = 0,
  requestDelayMs = 0,
  discoveryReserveMs = 0,
  limitPerSourceExplicit = false,
  maxSourceMsExplicit = false,
  maxLinksPerSourceExplicit = false,
  maxDiscoveryPagesExplicit = false,
  maxDetailFetchesPerSourceExplicit = false,
  maxPdfTextFetchesPerSourceExplicit = false,
  requestDelayMsExplicit = false,
  discoveryReserveMsExplicit = false,
  allowReadableFallback = true,
  useFetchCache = true,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  retries = 1,
  fetchHtmlImpl = fetchHtml,
  fetchTextResourceImpl = fetchTextResource,
  fetchReadableTextResourceImpl = fetchReadableTextResource,
} = {}) {
  const documents = [];
  const crawlReports = [];

  for (const source of sources) {
    const sourceOptions = getSourceCrawlOptions(source, {
      limitPerSource,
      timeoutMs,
      maxSourceMs,
      maxLinksPerSource,
      maxDiscoveryPages,
      maxDetailFetchesPerSource,
      maxPdfTextFetchesPerSource,
      requestDelayMs,
      discoveryReserveMs: getDefaultDiscoveryReserveMs({ maxSourceMs, limitPerSource, timeoutMs, concurrency }),
    }, {
      limitPerSource: limitPerSourceExplicit,
      timeoutMs: timeoutMsExplicit,
      maxSourceMs: maxSourceMsExplicit,
      maxLinksPerSource: maxLinksPerSourceExplicit,
      maxDiscoveryPages: maxDiscoveryPagesExplicit,
      maxDetailFetchesPerSource: maxDetailFetchesPerSourceExplicit,
      maxPdfTextFetchesPerSource: maxPdfTextFetchesPerSourceExplicit,
      requestDelayMs: requestDelayMsExplicit,
      discoveryReserveMs: discoveryReserveMsExplicit,
    });
    if (discoveryReserveMsExplicit) sourceOptions.discoveryReserveMs = getPositiveNumber(discoveryReserveMs, sourceOptions.discoveryReserveMs);
    const sourceDeadline = createDeadline(sourceOptions.maxSourceMs);
    const report = {
      sourceId: source.id,
      sourceName: source.name,
      discovered: 0,
      fetched: 0,
      indexed: 0,
      robotsDisallowed: 0,
      errors: [],
      preserveOnFailure: source.crawler?.preserveOnFailure !== false,
      maxSourceMs: sourceDeadline.maxMs || null,
      maxLinksPerSource: sourceOptions.maxLinksPerSource,
      maxDiscoveryPages: sourceOptions.maxDiscoveryPages,
      maxDetailFetchesPerSource: sourceOptions.maxDetailFetchesPerSource || null,
      maxPdfTextFetchesPerSource: sourceOptions.maxPdfTextFetchesPerSource || null,
      limitPerSource: sourceOptions.limitPerSource,
      timeoutMs: sourceOptions.timeoutMs,
      requestDelayMs: sourceOptions.requestDelayMs,
      discoveryReserveMs: sourceOptions.discoveryReserveMs,
      proxy: maskProxyUrl(getConfiguredProxyUrl()),
      timedOut: false,
    };
    const requestThrottle = createRequestThrottle(sourceOptions.requestDelayMs);
    if (sourceDeadline.expired()) {
      report.errors.push("source time budget exceeded before discovery");
      report.timedOut = true;
      crawlReports.push(report);
      continue;
    }
    const entries = await discoverSourceEntries(source, {
      timeoutMs: sourceDeadline.timeoutMs(sourceOptions.timeoutMs),
      maxLinks: sourceOptions.maxLinksPerSource,
      maxDiscoveryPages: sourceOptions.maxDiscoveryPages,
      discoveryReserveMs: sourceOptions.discoveryReserveMs,
      deadline: sourceDeadline,
      allowReadableFallback,
      useFetchCache,
      cacheDir,
      retries,
      report,
      requestThrottle,
      fetchHtmlImpl,
      fetchTextResourceImpl,
    });
    report.discovered = entries.length;
    let indexedForSource = 0;
    for (const entry of entries.filter((entry) => entry.embeddedDocument)) {
      if (indexedForSource >= sourceOptions.limitPerSource) break;
      documents.push(applyNewsCategoryMetadata(entry.embeddedDocument, entry));
      report.indexed += 1;
      indexedForSource += 1;
    }
    if (sourceDeadline.expired()) {
      report.errors.push("source time budget exceeded before fetching discovered documents");
      report.timedOut = true;
    }
    const remainingLimit = Math.max(0, sourceOptions.limitPerSource - indexedForSource);
    const fetchCandidates = entries
      .filter((entry) => !entry.embeddedDocument && shouldIndexCrawledUrl(entry.url, source))
      .slice(0, remainingLimit);
    if (sourceDeadline.expired() && (source.crawler?.preferListingDocuments || source.crawler?.indexListingFallbacks)) {
      drainQueueAsFallbackDocuments([...fetchCandidates], source, report, documents, sourceOptions.limitPerSource);
    }
    const queue = sourceDeadline.expired() ? [] : fetchCandidates;
    let detailFetchesStarted = 0;
    let pdfTextFetchesStarted = 0;
    const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
      while (queue.length) {
        if (sourceDeadline.expired()) {
          reportSourceTimeout(report, "source time budget exceeded while fetching documents");
          drainQueueAsFallbackDocuments(queue, source, report, documents, sourceOptions.limitPerSource);
          break;
        }
        const entry = queue.shift();
        const url = entry.url;
        try {
          if (entry.fromFeed && source.crawler?.indexFeedItems !== false) {
            const document = extractFeedDocumentFromEntry(entry, source);
            if (document) {
              documents.push(document);
              report.indexed += 1;
            }
            continue;
          }

          if (
            entry.fromSourceSearch
            && source.crawler?.indexSearchResults !== false
            && source.crawler?.fetchSearchResultPages !== true
          ) {
            const document = extractSourceSearchDocumentFromEntry(entry, source);
            if (document) {
              documents.push(document);
              report.indexed += 1;
            }
            continue;
          }

          if (isPdfUrl(url)) {
            let document = extractPdfDocumentFromLink(entry, source);
            if (document && shouldFetchPdfReadableText(source, entry) && !sourceDeadline.expired()) {
              const pdfTextLimit = Number(sourceOptions.maxPdfTextFetchesPerSource || 0);
              const overPdfTextLimit = !entry.forceDetailFetch && pdfTextLimit > 0 && pdfTextFetchesStarted >= pdfTextLimit;
              if (overPdfTextLimit) {
                report.pdfTextFetchLimitReached = true;
                report.pdfTextFetchLimitFallbacks = (report.pdfTextFetchLimitFallbacks || 0) + 1;
              } else {
                pdfTextFetchesStarted += 1;
                report.pdfTextFetchAttempts = pdfTextFetchesStarted;
                try {
                  await requestThrottle.wait();
                  const readableText = await fetchReadableTextResourceImpl(url, {
                    timeoutMs: sourceDeadline.timeoutMs(sourceOptions.timeoutMs),
                    useFetchCache,
                    cacheDir,
                    retries,
                    cacheFirst: source.crawler?.cacheFirstReadable !== false,
                  });
                  document = enrichPdfDocumentWithReadableText(document, readableText, source);
                  if (report) {
                    report.fetched += 1;
                    report.pdfTextFetched = (report.pdfTextFetched || 0) + 1;
                  }
                } catch {
                  if (report) report.pdfTextFallbacks = (report.pdfTextFallbacks || 0) + 1;
                }
              }
            }
            if (document) {
              documents.push(document);
              report.indexed += 1;
            }
            continue;
          }

          const mediaDocument = extractMediaDocumentFromLink(entry, source);
          if (mediaDocument) {
            documents.push(applyNewsCategoryMetadata(mediaDocument, entry));
            report.indexed += 1;
            continue;
          }

          if (source.crawler?.preferListingDocuments && !entry.forceDetailFetch) {
            const fallbackDocument = createFallbackDocumentForEntry(entry, source, report);
            if (fallbackDocument) {
              documents.push(applyNewsCategoryMetadata(fallbackDocument, entry));
              report.indexed += 1;
              continue;
            }
          }

          if (sourceOptions.maxDetailFetchesPerSource && detailFetchesStarted >= sourceOptions.maxDetailFetchesPerSource) {
            const fallbackDocument = createFallbackDocumentForEntry(entry, source, report);
            if (fallbackDocument) {
              documents.push(applyNewsCategoryMetadata(fallbackDocument, entry));
              report.indexed += 1;
              report.detailFetchLimitFallbacks = (report.detailFetchLimitFallbacks || 0) + 1;
              report.detailFetchLimitReached = true;
              continue;
            }
          }

          detailFetchesStarted += 1;
          report.detailFetchAttempts = detailFetchesStarted;
          await requestThrottle.wait();
          const html = await fetchHtmlImpl(url, {
            timeoutMs: sourceDeadline.timeoutMs(sourceOptions.timeoutMs),
            allowReadableFallback,
            useFetchCache,
            cacheDir,
            retries,
            preferReadable: shouldPreferReadableFetch(source, entry),
            cacheFirstReadable: Boolean(source.crawler?.cacheFirstReadable),
          });
          report.fetched += 1;
          const extractedDocument = extractDocumentFromHtml(html, url, source, entry);
          const fallbackDocument = entry.fallbackDocument
            || createFallbackDocumentForEntry(entry, source, null);
          const document = applyNewsCategoryMetadata(
            selectFetchedOrFallbackDocument(extractedDocument, fallbackDocument),
            entry,
          );
          if (document && fallbackDocument && document === fallbackDocument && !entry.fallbackDocument && report) {
            report.searchResultFallbacks = (report.searchResultFallbacks || 0) + 1;
          }
          if (document) {
            documents.push(document);
            report.indexed += 1;
            const imageDocuments = extractArticleImageDocumentsFromContent(html, url, source, document);
            for (const imageDocument of imageDocuments) {
              documents.push(imageDocument);
              report.indexed += 1;
            }
          }
        } catch (error) {
          const fallbackDocument = createFallbackDocumentForEntry(entry, source, report);
          if (fallbackDocument) {
            documents.push(applyNewsCategoryMetadata(fallbackDocument, entry));
            report.indexed += 1;
            continue;
          }
          report.errors.push(`${url}: ${error.message}`);
        }
      }
    });
    await Promise.all(workers);
    crawlReports.push(report);
  }

  return { documents: dedupeDocuments(documents), crawlReports };
}

function reportSourceTimeout(report, message) {
  if (!report) return;
  if (!Array.isArray(report.errors)) report.errors = [];
  if (!report.errors.includes(message)) report.errors.push(message);
  report.timedOut = true;
}

function drainQueueAsFallbackDocuments(queue, source, report, documents, limitPerSource) {
  if (report?.deadlineFallbacksDrained) return;
  if (report) report.deadlineFallbacksDrained = true;

  while (queue.length && Number(report?.indexed || 0) < Number(limitPerSource || Infinity)) {
    const entry = queue.shift();
    const fallbackDocument = createFallbackDocumentForEntry(entry, source, report);
    if (!fallbackDocument) continue;
    documents.push(applyNewsCategoryMetadata(fallbackDocument, entry));
    if (report) {
      report.indexed += 1;
      report.deadlineFallbacks = (report.deadlineFallbacks || 0) + 1;
    }
  }
}

function createFallbackDocumentForEntry(entry, source, report) {
  return entry?.fallbackDocument
    || createSourceSearchFallbackDocument(entry, source, report)
    || createListingFallbackDocument(entry, source, report);
}

function createDeadline(maxMs) {
  const parsed = Number(maxMs || 0);
  const max = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const startedAt = Date.now();
  return {
    maxMs: max,
    expired() {
      return max > 0 && Date.now() - startedAt >= max;
    },
    remainingMs() {
      if (!max) return Infinity;
      return Math.max(0, max - (Date.now() - startedAt));
    },
    timeoutMs(fallbackMs) {
      if (!max) return fallbackMs;
      const remaining = max - (Date.now() - startedAt);
      return Math.max(1, Math.min(Number(fallbackMs) || remaining, remaining));
    },
  };
}

function getSourceCrawlOptions(source = {}, defaults = {}, explicit = {}) {
  const crawler = source.crawler || {};
  return {
    limitPerSource: getScopedCrawlNumber(crawler.limitPerSource, defaults.limitPerSource, explicit.limitPerSource),
    timeoutMs: getScopedCrawlNumber(crawler.timeoutMs, defaults.timeoutMs, explicit.timeoutMs),
    maxSourceMs: getScopedCrawlNumber(crawler.maxSourceMs, defaults.maxSourceMs, explicit.maxSourceMs),
    maxLinksPerSource: getScopedCrawlNumber(crawler.maxLinksPerSource, defaults.maxLinksPerSource, explicit.maxLinksPerSource),
    maxDiscoveryPages: getScopedCrawlNumber(crawler.maxDiscoveryPages, defaults.maxDiscoveryPages, explicit.maxDiscoveryPages),
    maxDetailFetchesPerSource: getScopedCrawlNumber(crawler.maxDetailFetchesPerSource, defaults.maxDetailFetchesPerSource, explicit.maxDetailFetchesPerSource),
    maxPdfTextFetchesPerSource: getScopedCrawlNumber(crawler.maxPdfTextFetchesPerSource, defaults.maxPdfTextFetchesPerSource, explicit.maxPdfTextFetchesPerSource),
    requestDelayMs: getScopedCrawlNumber(crawler.requestDelayMs, defaults.requestDelayMs, explicit.requestDelayMs),
    discoveryReserveMs: getScopedCrawlNumber(crawler.discoveryReserveMs, defaults.discoveryReserveMs, explicit.discoveryReserveMs),
  };
}

function getDefaultDiscoveryReserveMs({
  maxSourceMs = 0,
  limitPerSource = 25,
  timeoutMs = 12000,
  concurrency = 2,
} = {}) {
  const sourceBudget = Number(maxSourceMs) || 0;
  if (!sourceBudget) return 0;
  const estimatedFetchWindow = Math.ceil((Number(limitPerSource) || 25) / Math.max(1, Number(concurrency) || 1))
    * Math.min(Number(timeoutMs) || 12000, 2500);
  return Math.max(20000, Math.min(Math.floor(sourceBudget * 0.45), estimatedFetchWindow, 90000));
}

function getScopedCrawlNumber(sourceValue, fallback, isExplicit) {
  return isExplicit
    ? getPositiveNumber(fallback, fallback)
    : getPositiveNumber(sourceValue, fallback);
}

function getPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Number(fallback) || 0;
}

export async function discoverSourceUrls(source, {
  timeoutMs = 12000,
  maxLinks = 80,
  maxDiscoveryPages = 8,
  allowReadableFallback = true,
  useFetchCache = true,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  retries = 1,
  report,
  deadline = null,
} = {}) {
  const entries = await discoverSourceEntries(source, {
    timeoutMs,
    maxLinks,
    maxDiscoveryPages,
    deadline,
    allowReadableFallback,
    useFetchCache,
    cacheDir,
    retries,
    report,
  });
  return entries.map((entry) => entry.url);
}

export async function discoverSourceEntries(source, {
  timeoutMs = 12000,
  maxLinks = 80,
  maxDiscoveryPages = 8,
  discoveryReserveMs = 0,
  deadline = null,
  allowReadableFallback = true,
  useFetchCache = true,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  retries = 1,
  report,
  requestThrottle = null,
  fetchHtmlImpl = fetchHtml,
  fetchTextResourceImpl = fetchTextResource,
} = {}) {
  const getTimeoutMs = () => deadline?.timeoutMs ? deadline.timeoutMs(timeoutMs) : timeoutMs;
  const markDiscoveryTimeout = () => {
    report?.errors?.push("source time budget exceeded during discovery");
    if (report) report.timedOut = true;
  };
  const robotsRules = await loadRobotsRules(source, {
    timeoutMs: getTimeoutMs(),
    useFetchCache,
    cacheDir,
    retries,
    report,
    fetchTextResourceImpl,
  });
  const entries = new Map();
  const detailSeedEntries = createConfiguredDetailSeedEntries(source);
  addLinkEntries(entries, detailSeedEntries, maxLinks);
  if (detailSeedEntries.length && report) report.detailSeedIndexed = Math.min(detailSeedEntries.length, entries.size);
  const backfillEntries = createConfiguredBackfillEntries(source);
  addLinkEntries(entries, backfillEntries, maxLinks);
  if (backfillEntries.length && report) report.backfillIndexed = backfillEntries.length;
  if (entries.size >= maxLinks) return [...entries.values()];
  const shouldReserveTimeForFetches = (discoveredCount = 0) => (
    entries.size + Math.max(0, Number(discoveredCount) || 0) > 0
    && Number(discoveryReserveMs) > 0
    && Number.isFinite(deadline?.remainingMs?.())
    && deadline.remainingMs() <= Number(discoveryReserveMs)
  );
  const stopDiscoveryForFetchReserve = (discoveredCount = 0) => {
    if (!shouldReserveTimeForFetches(discoveredCount)) return false;
    if (report) report.discoveryStoppedForFetchReserve = true;
    return true;
  };

  if (source.crawler?.feedUrl) {
    try {
      if (deadline?.expired?.()) {
        markDiscoveryTimeout();
        return [...entries.values()];
      }
      if (!isRobotsAllowed(source.crawler.feedUrl, source, robotsRules)) {
        reportRobotsSkip(report, source.crawler.feedUrl);
      } else {
        const feedXml = await fetchTextResourceImpl(source.crawler.feedUrl, {
          timeoutMs: getTimeoutMs(),
          accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.8",
          useFetchCache,
          cacheDir,
          cacheNamespace: "feed",
          retries,
        });
        const feedEntries = discoverFeedEntries(feedXml, source.crawler.feedUrl, source)
          .filter((entry) => isRobotsAllowedWithReport(entry.url, source, robotsRules, report))
          .slice(0, maxLinks);
        addLinkEntries(entries, feedEntries, maxLinks);
      }
    } catch (error) {
      report?.errors?.push(`${source.crawler.feedUrl}: ${error.message}`);
    }
  }

  if (stopDiscoveryForFetchReserve()) {
    return [...entries.values()];
  }

  const wordpressEntries = await discoverWordPressConfiguredEntries(source, {
    timeoutMs: getTimeoutMs(),
    maxLinks: Math.max(0, maxLinks - entries.size),
    allowReadableFallback,
    useFetchCache,
    cacheDir,
    retries,
    robotsRules,
    report,
    shouldStopDiscovery: stopDiscoveryForFetchReserve,
    fetchTextResourceImpl,
  });
  addLinkEntries(entries, wordpressEntries, maxLinks);

  if (stopDiscoveryForFetchReserve()) {
    return [...entries.values()];
  }

  const sitemapEntries = await discoverSitemapConfiguredEntries(source, {
    timeoutMs: getTimeoutMs(),
    maxLinks: Math.max(0, maxLinks - entries.size),
    useFetchCache,
    cacheDir,
    retries,
    robotsRules,
    report,
    shouldStopDiscovery: stopDiscoveryForFetchReserve,
    fetchTextResourceImpl,
  });
  addLinkEntries(entries, sitemapEntries, maxLinks);

  if (stopDiscoveryForFetchReserve()) {
    return [...entries.values()];
  }

  const searchEntries = await discoverSearchConfiguredEntries(source, {
    timeoutMs: getTimeoutMs(),
    maxLinks: Math.max(0, maxLinks - entries.size),
    allowReadableFallback,
    useFetchCache,
    cacheDir,
    retries,
    robotsRules,
    report,
    shouldStopDiscovery: stopDiscoveryForFetchReserve,
    fetchHtmlImpl,
  });
  addLinkEntries(entries, searchEntries, maxLinks);

  if (source.crawler?.skipHtmlDiscovery) {
    return [...entries.values()];
  }

  const entryUrl = stripHash(source.crawler?.entryUrl || source.baseUrl);
  const seedUrls = source.crawler?.seedUrls || [];
  const generatedDiscoveryPageUrls = createGeneratedDiscoveryPageUrls(source, entryUrl);
  const configuredDiscoveryUrls = source.crawler?.preferSeedUrls
    ? [...seedUrls, entryUrl, ...generatedDiscoveryPageUrls]
    : [entryUrl, ...seedUrls, ...generatedDiscoveryPageUrls];
  const pageQueue = configuredDiscoveryUrls.map((url) => stripHash(resolveUrl(url, entryUrl) || url));
  const visitedPages = new Set();
  const pageLimit = Math.max(1, Number(maxDiscoveryPages) || 1);
  const maxLinksPerDiscoveryPage = getPositiveNumber(source.crawler?.maxLinksPerDiscoveryPage, 0);

  while (pageQueue.length && visitedPages.size < pageLimit && entries.size < maxLinks) {
    if (deadline?.expired?.()) {
      markDiscoveryTimeout();
      break;
    }
    if (stopDiscoveryForFetchReserve()) {
      break;
    }
    const pageUrl = pageQueue.shift();
    if (!pageUrl || visitedPages.has(pageUrl)) continue;
    visitedPages.add(pageUrl);
    if (!isRobotsAllowed(pageUrl, source, robotsRules)) {
      reportRobotsSkip(report, pageUrl);
      continue;
    }

    try {
      await requestThrottle?.wait?.();
      const html = await fetchHtmlImpl(pageUrl, {
        timeoutMs: getTimeoutMs(),
        allowReadableFallback,
        useFetchCache,
        cacheDir,
        retries,
        preferReadable: shouldPreferReadableFetch(source),
        cacheFirstReadable: false,
      });
      reportDiscoveryFetch(report);
      const pageNewsCategories = inferNewsCategoriesFromListingUrl(pageUrl, source);
      const discovered = discoverLinkEntries(html, pageUrl, source)
        .map((entry) => pageNewsCategories.length
          ? { ...entry, newsCategories: mergeStringLists(entry.newsCategories, pageNewsCategories) }
          : entry)
        .filter((entry) => isAllowedSourceUrl(entry.url, source))
        .filter((entry) => isRobotsAllowedWithReport(entry.url, source, robotsRules, report));

      for (const embeddedEntry of discoverEmbeddedDocumentEntries(html, pageUrl, source)) {
        if (!isRobotsAllowed(embeddedEntry.url, source, robotsRules)) {
          reportRobotsSkip(report, embeddedEntry.url);
          continue;
        }
        addLinkEntries(entries, [embeddedEntry], maxLinks);
        if (entries.size >= maxLinks) break;
      }

      let indexedLinksFromPage = 0;
      for (const entry of discovered) {
        if (shouldIndexCrawledUrl(entry.url, source) && !entries.has(entry.url) && entry.url !== entryUrl) {
          if (!maxLinksPerDiscoveryPage || indexedLinksFromPage < maxLinksPerDiscoveryPage) {
            const mediaDocument = extractMediaDocumentFromLink(entry, source);
            addLinkEntries(entries, [mediaDocument ? { ...entry, embeddedDocument: mediaDocument } : entry], maxLinks);
            indexedLinksFromPage += 1;
          }
        }
        if (entries.size >= maxLinks) break;
        if (shouldFollowDiscoveryPage(entry.url, source, entryUrl, visitedPages)) pageQueue.push(entry.url);
      }
    } catch (error) {
      report?.errors?.push(`${pageUrl}: ${error.message}`);
      if (pageUrl === entryUrl && entries.size === 0) return [];
      if (pageUrl === entryUrl) break;
    }
  }

  if (!isRobotsAllowed(entryUrl, source, robotsRules)) return [];
  return [
    { url: entryUrl, linkText: "", contextText: "", date: "", thumbnailUrl: "" },
    ...[...entries.values()].slice(0, Math.max(0, maxLinks - 1)),
  ];
}

function addLinkEntries(target, entries = [], maxLinks = Infinity) {
  for (const entry of entries) {
    if (!entry?.url) continue;
    if (target.has(entry.url)) {
      const existing = target.get(entry.url);
      const newsCategories = mergeStringLists(existing?.newsCategories, entry.newsCategories);
      const thumbnailUrl = String(existing?.thumbnailUrl || entry.thumbnailUrl || "").trim();
      if (newsCategories.length || thumbnailUrl !== String(existing?.thumbnailUrl || "")) {
        target.set(entry.url, {
          ...existing,
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
          ...(newsCategories.length ? { newsCategories } : {}),
        });
      }
      continue;
    }
    if (target.size >= maxLinks) break;
    target.set(entry.url, entry);
  }
}

function inferNewsCategoriesFromListingUrl(value = "", source = {}) {
  if (source.id !== "kcna") return [];
  const url = String(value || "");
  const mappings = [
    ["b0721b9f23054ddc7fe56c2811a12715", "leadership"],
    ["6a47505ba5268fd7749c0fe11e4b24b4", "important"],
    ["ecc14533d88be93068af4178946b1b05", "international"],
    ["6837a75abf5c6249d0e39ee758e763ea", /\/video\/list\//iu.test(url) ? "video" : "photo"],
    ["503e9b606704f9b1c625fa5755928cd3", "anecdote"],
    ["1afa96195f9b303902490a126ab7285f", "document"],
    ["e2f336db98b5e69c75e0da264e037e8d", "foreign"],
    ["7bc083f00425be6aadfb828fba1cb5a7", "memory"],
    ["2f7d854121ccbbfbe6feae9fdcc3556e", "domestic"],
    ["680e40b40899891bbe75a7072e3285e7", "social"],
  ];
  return mappings.filter(([token]) => url.includes(token)).map(([, category]) => category);
}

function mergeStringLists(...values) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : []).map(String).filter(Boolean))];
}

function applyNewsCategoryMetadata(document, entry) {
  if (!document) return document;
  const categories = mergeStringLists(entry?.newsCategories);
  if (!categories.length) return document;
  const aliases = mergeStringLists(document.aliases, categories.map((category) => `news-category:${category}`));
  return { ...document, aliases };
}

function createGeneratedDiscoveryPageUrls(source = {}, entryUrl = "") {
  const configuredUrls = createConfiguredListingPageUrls(source, entryUrl);
  if (source.id === "rodong-sinmun") {
    return [...configuredUrls, ...createRodongListingPageUrls(source, entryUrl)];
  }
  if (source.id === "ryugyong") {
    return [...configuredUrls, ...createRyugyongListingPageUrls(source, entryUrl)];
  }
  return configuredUrls;
}

function createConfiguredListingPageUrls(source = {}, entryUrl = "") {
  const templates = (source.crawler?.listingUrlTemplates || [])
    .map((template) => String(template || "").trim())
    .filter((template) => template.includes("{page}"));
  const pageCount = Math.max(0, Number(source.crawler?.generatedListingPages || 0));
  if (!templates.length || !pageCount) return [];

  const configuredStart = Number(source.crawler?.listingPageStart);
  const pageStart = Number.isInteger(configuredStart) && configuredStart >= 0 ? configuredStart : 1;
  const urls = [];
  for (let offset = 0; offset < pageCount; offset += 1) {
    const page = pageStart + offset;
    for (const template of templates) {
      const value = template.replaceAll("{page}", String(page));
      urls.push(stripHash(resolveUrl(value, entryUrl) || value));
    }
  }
  return [...new Set(urls.filter(Boolean))];
}

function createRodongListingPageUrls(source = {}, entryUrl = "") {
  const pageCount = Math.max(0, Number(source.crawler?.generatedListingPages || 0));
  if (!pageCount) return [];
  const sections = (source.crawler?.listingSections || [1, 2, 3, 4, 5, 6, 7, 8, 9])
    .map((section) => Number(section))
    .filter((section) => Number.isInteger(section) && section > 0);
  const urls = [];

  for (let page = 1; page <= pageCount; page += 1) {
    for (const section of sections) {
      const encoded = Buffer.from(`1@@${section}@${page}@`).toString("base64");
      urls.push(resolveUrl(`index.php?${encoded}`, entryUrl) || `${entryUrl}?${encoded}`);
    }
  }

  return urls;
}

function createRyugyongListingPageUrls(source = {}, entryUrl = "") {
  const pageCount = Math.max(0, Number(source.crawler?.generatedListingPages || 0));
  if (!pageCount) return [];
  const sections = (source.crawler?.listingSections || ["photo", "movie"])
    .map((section) => String(section || "").trim())
    .filter((section) => /^(?:photo|movie)$/i.test(section));
  const languages = (source.crawler?.listingLanguages || ["ko", "en"])
    .map((language) => String(language || "").trim())
    .filter((language) => /^(?:ko|en)$/i.test(language));
  const urls = [];

  for (let page = 1; page <= pageCount; page += 1) {
    for (const section of sections) {
      for (const language of languages) {
        urls.push(resolveUrl(`${section}?lang=${language}&page=${page}`, entryUrl) || `${entryUrl}${section}?lang=${language}&page=${page}`);
      }
    }
  }

  return urls;
}

function createConfiguredBackfillEntries(source = {}) {
  const documents = Array.isArray(source.crawler?.backfillDocuments)
    ? source.crawler.backfillDocuments
    : [];
  return documents
    .map((document) => createConfiguredBackfillEntry(document, source))
    .filter(Boolean);
}

function createConfiguredDetailSeedEntries(source = {}) {
  const seedUrls = Array.isArray(source.crawler?.detailSeedUrls)
    ? source.crawler.detailSeedUrls
    : [];
  return seedUrls
    .map((seed) => createConfiguredDetailSeedEntry(seed, source))
    .filter(Boolean);
}

function createConfiguredDetailSeedEntry(seed, source = {}) {
  const detailSeed = typeof seed === "string" ? { url: seed } : (seed || {});
  const url = stripHash(resolveUrl(detailSeed.url || "", source.baseUrl || source.crawler?.entryUrl || "") || "");
  if (!url || !isAllowedSourceUrl(url, source) || !shouldIndexCrawledUrl(url, source)) return null;
  return {
    url,
    linkText: cleanText(detailSeed.title || ""),
    contextText: cleanText(detailSeed.snippet || ""),
    date: detailSeed.date ? normalizeDate(detailSeed.date) : "",
    thumbnailUrl: detailSeed.thumbnailUrl || "",
    fromConfiguredDetailSeed: true,
    forceDetailFetch: true,
    readableSource: true,
    sourceId: source.id,
  };
}

function createConfiguredBackfillEntry(document = {}, source = {}) {
  const title = cleanText(document.title || "");
  const url = resolveUrl(document.url || source.baseUrl || source.crawler?.entryUrl || "", source.baseUrl || source.crawler?.entryUrl || "") || "";
  if (!title || !url) return null;
  const date = normalizeDate(document.date || "");
  const snippet = cleanText(document.snippet || document.body || title);
  const body = cleanText(document.body || snippet || title);
  const mediaType = document.mediaType || inferMediaType(url, body, source);
  const normalizedDocument = {
    id: document.id || `${source.id}-${hashUrl([url, title, date].join("|"))}`,
    title,
    snippet,
    body,
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    displaySourceId: source.id,
    displaySourceName: source.name,
    displaySourceType: source.sourceType,
    mediaType,
    url,
    archiveUrl: document.archiveUrl || "",
    thumbnailUrl: document.thumbnailUrl || "",
    language: document.language || inferDocumentLanguage([title, snippet, body].join(" "), url, source),
    aliases: Array.isArray(document.aliases) ? document.aliases : [],
    searchTabs: getMediaSearchTabs(source, mediaType),
  };

  return {
    url,
    linkText: title,
    contextText: snippet,
    date,
    thumbnailUrl: normalizedDocument.thumbnailUrl,
    embeddedDocument: normalizedDocument,
    fromBackfill: true,
  };
}

async function discoverWordPressConfiguredEntries(source, {
  timeoutMs = 12000,
  maxLinks = 80,
  allowReadableFallback = true,
  useFetchCache = true,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  retries = 1,
  robotsRules = null,
  report,
  shouldStopDiscovery = null,
  fetchTextResourceImpl = fetchTextResource,
} = {}) {
  const apiUrls = createWordPressApiUrls(source);
  if (!apiUrls.length || maxLinks <= 0) return [];
  const preferReadable = Boolean(source.crawler?.wordpressPreferReadable);
  const entries = new Map();
  const fetchDetailPages = Boolean(source.crawler?.wordpressFetchDetailPages);

  for (const apiUrl of apiUrls) {
    if (entries.size >= maxLinks) break;
    if (shouldStopDiscovery?.(entries.size)) break;
    if (!isRobotsAllowedWithReport(apiUrl, source, robotsRules, report)) continue;

    const candidateUrls = preferReadable && allowReadableFallback
      ? [toReadableFetchUrl(apiUrl), apiUrl]
      : [apiUrl, ...(allowReadableFallback ? [toReadableFetchUrl(apiUrl)] : [])];
    let lastError;

    for (const candidateUrl of candidateUrls) {
      try {
        const isReadableUrl = candidateUrl.startsWith(READABLE_FETCH_PREFIX);
        const text = await fetchTextResourceImpl(candidateUrl, {
          timeoutMs: isReadableUrl ? getReadableTimeoutMs(timeoutMs) : timeoutMs,
          accept: isReadableUrl ? "text/plain,*/*;q=0.8" : "application/json,text/plain,*/*;q=0.8",
          useFetchCache,
          cacheDir,
          cacheNamespace: isReadableUrl ? "readable-api" : "api",
          retries,
        });
        reportApiFetch(report);

        const documents = parseWordPressPostsPayload(text)
          .flatMap((post) => createWordPressPostDocuments(post, source))
          .filter(Boolean)
          .filter((document) => document.mediaType === "image" || shouldIndexCrawledUrl(document.url, source));

        for (const document of documents) {
          addLinkEntries(entries, [{
            url: document.url,
            linkText: document.title,
            contextText: document.snippet,
            date: document.date,
            thumbnailUrl: document.thumbnailUrl || "",
            embeddedDocument: document.mediaType === "image" || !fetchDetailPages ? document : null,
            fallbackDocument: document.mediaType === "image" || !fetchDetailPages ? null : document,
            fromWordPressApi: true,
            readableSource: document.mediaType !== "image" && fetchDetailPages && preferReadable,
          }], maxLinks);
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) report?.errors?.push(`${apiUrl}: ${lastError.message}`);
  }

  return [...entries.values()];
}

function createWordPressApiUrls(source) {
  const urls = [];
  const template = source.crawler?.wordpressSearchUrlTemplate;
  const queries = (source.crawler?.wordpressSearchQueries || [])
    .map((query) => cleanText(query))
    .filter(Boolean);
  if (template && queries.length) {
    for (const query of queries) {
      const url = String(template).includes("{query}")
        ? String(template).replaceAll("{query}", encodeURIComponent(query))
        : appendSearchParam(template, "search", query);
      const resolved = stripHash(resolveUrl(url, source.baseUrl) || url);
      if (resolved) urls.push(resolved);
    }
  }

  const postsUrl = stripHash(resolveUrl(source.crawler?.wordpressPostsUrl, source.baseUrl) || source.crawler?.wordpressPostsUrl);
  if (postsUrl) urls.push(postsUrl);

  return [...new Set(urls)];
}

async function discoverSitemapConfiguredEntries(source, {
  timeoutMs = 12000,
  maxLinks = 80,
  useFetchCache = true,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  retries = 1,
  robotsRules = null,
  report,
  shouldStopDiscovery = null,
  fetchTextResourceImpl = fetchTextResource,
} = {}) {
  const sitemapUrls = (source.crawler?.sitemapUrls || [])
    .map((url) => resolveUrl(url, source.baseUrl) || url)
    .filter(Boolean);
  if (!sitemapUrls.length || maxLinks <= 0) return [];

  const entries = new Map();
  const queue = [...sitemapUrls];
  const visited = new Set();
  const sitemapLimit = Math.max(1, Number(source.crawler?.maxSitemaps || 8));

  while (queue.length && visited.size < sitemapLimit && entries.size < maxLinks) {
    if (shouldStopDiscovery?.(entries.size)) break;
    const sitemapUrl = stripHash(queue.shift());
    if (!sitemapUrl || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    if (!isRobotsAllowedWithReport(sitemapUrl, source, robotsRules, report)) continue;

    try {
      const xml = await fetchTextResourceImpl(sitemapUrl, {
        timeoutMs,
        accept: "application/xml,text/xml,*/*;q=0.8",
        useFetchCache,
        cacheDir,
        cacheNamespace: "sitemap",
        retries,
      });
      reportSitemapFetch(report);
      const parsed = discoverSitemapEntries(xml, sitemapUrl, source);
      for (const nested of parsed.sitemaps) {
        if (visited.size + queue.length >= sitemapLimit) break;
        if (isRobotsAllowedWithReport(nested, source, robotsRules, report)) queue.push(nested);
      }
      const allowedEntries = parsed.entries
        .filter((entry) => shouldIndexCrawledUrl(entry.url, source))
        .filter((entry) => isRobotsAllowedWithReport(entry.url, source, robotsRules, report));
      addLinkEntries(entries, allowedEntries, maxLinks);
    } catch (error) {
      report?.errors?.push(`${sitemapUrl}: ${error.message}`);
    }
  }

  return [...entries.values()];
}

async function discoverSearchConfiguredEntries(source, {
  timeoutMs = 12000,
  maxLinks = 80,
  allowReadableFallback = true,
  useFetchCache = true,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  retries = 1,
  robotsRules = null,
  report,
  shouldStopDiscovery = null,
  fetchHtmlImpl = fetchHtml,
} = {}) {
  const searchUrls = createConfiguredSearchUrls(source);
  if (!searchUrls.length || maxLinks <= 0) return [];

  const entries = new Map();
  for (const searchUrl of searchUrls) {
    if (entries.size >= maxLinks) break;
    if (shouldStopDiscovery?.(entries.size)) break;
    if (!isRobotsAllowedWithReport(searchUrl, source, robotsRules, report)) continue;

    try {
      const html = await fetchHtmlImpl(searchUrl, {
        timeoutMs,
        allowReadableFallback,
        useFetchCache,
        cacheDir,
        retries,
        preferReadable: Boolean(source.crawler?.searchPreferReadable) || shouldPreferReadableFetch(source),
        cacheFirstReadable: false,
      });
      reportSearchFetch(report);
      const discovered = discoverLinkEntries(html, searchUrl, source)
        .filter((entry) => shouldIndexCrawledUrl(entry.url, source))
        .filter((entry) => isRobotsAllowedWithReport(entry.url, source, robotsRules, report))
        .map((entry) => ({
          ...entry,
          fromSourceSearch: true,
          searchUrl,
        }));
      addLinkEntries(entries, discovered, maxLinks);
    } catch (error) {
      report?.errors?.push(`${searchUrl}: ${error.message}`);
    }
  }

  return [...entries.values()];
}

export function createConfiguredSearchUrls(source) {
  const templates = (source.crawler?.searchUrlTemplates || [])
    .map(String)
    .filter(Boolean);
  const queries = (source.crawler?.searchQueries || [])
    .map((query) => cleanText(query))
    .filter(Boolean);
  if (!templates.length || !queries.length) return [];

  const urls = [];
  for (const template of templates) {
    for (const query of queries) {
      const encodedQuery = encodeURIComponent(createConfiguredSearchQuery(query, source));
      const url = template.includes("{query}")
        ? template.replaceAll("{query}", encodedQuery)
        : appendSearchParam(template, "s", query);
      const resolved = stripHash(resolveUrl(url, source.baseUrl) || url);
      if (resolved) urls.push(resolved);
    }
  }
  return [...new Set(urls)];
}

function createConfiguredSearchQuery(query, source = {}) {
  if (source.crawler?.searchQueryEncoding === "rodong-search-base64") {
    return Buffer.from(`19@@19@@${query}@1`).toString("base64");
  }
  return query;
}

export async function loadRobotsRules(source, {
  timeoutMs = 12000,
  useFetchCache = true,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  retries = 1,
  report,
  fetchTextResourceImpl = fetchTextResource,
} = {}) {
  if (source.crawler?.robotsPolicy !== "respect") return null;
  const robotsUrl = getRobotsUrl(source.baseUrl);
  if (!robotsUrl) return null;
  const configuredTimeoutMs = Number(source.crawler?.robotsTimeoutMs || 0);
  const robotsTimeoutMs = configuredTimeoutMs > 0
    ? Math.max(1, Math.min(timeoutMs, configuredTimeoutMs))
    : timeoutMs;

  try {
    const robotsText = await fetchTextResourceImpl(robotsUrl, {
      timeoutMs: robotsTimeoutMs,
      accept: "text/plain,*/*;q=0.8",
      useFetchCache,
      cacheDir,
      cacheNamespace: "robots",
      retries,
    });
    return parseRobotsTxt(robotsText, DEFAULT_USER_AGENT);
  } catch (error) {
    if (report) report.robotsWarning = `${robotsUrl}: ${error.message}`;
    return null;
  }
}

export function parseRobotsTxt(text = "", userAgent = DEFAULT_USER_AGENT) {
  const groups = [];
  let currentGroup = null;
  let seenDirective = false;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;

    const field = match[1].toLocaleLowerCase("en-US");
    const value = match[2].trim();
    if (field === "user-agent") {
      if (!currentGroup || seenDirective) {
        currentGroup = { agents: [], rules: [] };
        groups.push(currentGroup);
        seenDirective = false;
      }
      currentGroup.agents.push(value.toLocaleLowerCase("en-US"));
      continue;
    }

    if (!currentGroup) continue;
    if (field !== "allow" && field !== "disallow") continue;
    seenDirective = true;
    if (field === "disallow" && !value) continue;
    currentGroup.rules.push({ type: field, path: value });
  }

  const product = getRobotsProductToken(userAgent);
  const matchingGroups = groups
    .map((group) => ({
      ...group,
      specificity: Math.max(...group.agents.map((agent) => getRobotsAgentSpecificity(agent, product))),
    }))
    .filter((group) => group.specificity >= 0);
  if (!matchingGroups.length) return [];

  const bestSpecificity = Math.max(...matchingGroups.map((group) => group.specificity));
  return matchingGroups
    .filter((group) => group.specificity === bestSpecificity)
    .flatMap((group) => group.rules);
}

export function isRobotsAllowed(url, source, rules = null) {
  if (source.crawler?.robotsPolicy !== "respect" || !Array.isArray(rules) || !rules.length) return true;

  const pathAndQuery = getRobotsPath(url);
  if (!pathAndQuery) return true;

  const matchingRules = rules
    .filter((rule) => robotsRuleMatches(pathAndQuery, rule.path))
    .sort((left, right) => right.path.length - left.path.length || (left.type === "allow" ? -1 : 1));
  if (!matchingRules.length) return true;
  return matchingRules[0].type === "allow";
}

function isRobotsAllowedWithReport(url, source, rules, report) {
  const allowed = isRobotsAllowed(url, source, rules);
  if (!allowed) reportRobotsSkip(report, url);
  return allowed;
}

function reportRobotsSkip(report, url) {
  if (!report) return;
  report.robotsDisallowed = (report.robotsDisallowed || 0) + 1;
  if (!Array.isArray(report.robotsSkippedUrls)) report.robotsSkippedUrls = [];
  if (report.robotsSkippedUrls.length < 12) report.robotsSkippedUrls.push(url);
}

function getRobotsUrl(baseUrl = "") {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.origin}/robots.txt`;
  } catch {
    return "";
  }
}

function getRobotsProductToken(userAgent = "") {
  return String(userAgent || "")
    .split(/[(/;\s]/)[0]
    .trim()
    .toLocaleLowerCase("en-US");
}

function getRobotsAgentSpecificity(agent = "", product = "") {
  const normalized = String(agent || "").trim().toLocaleLowerCase("en-US");
  if (normalized === "*") return 0;
  if (product && (product === normalized || product.includes(normalized) || normalized.includes(product))) {
    return normalized.length;
  }
  return -1;
}

function getRobotsPath(url = "") {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname || "/"}${parsed.search || ""}`;
  } catch {
    return "";
  }
}

function robotsRuleMatches(pathAndQuery = "", rulePath = "") {
  const pattern = String(rulePath || "").trim();
  if (!pattern) return false;
  const regex = new RegExp(`^${escapeRobotsPattern(pattern)}`);
  return regex.test(pathAndQuery);
}

function escapeRobotsPattern(pattern = "") {
  return String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\\\$$/, "$");
}

export async function fetchHtml(url, {
  timeoutMs = 12000,
  allowReadableFallback = true,
  useFetchCache = true,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  retries = 1,
  preferReadable = false,
  cacheFirstReadable = false,
} = {}) {
  if (preferReadable && allowReadableFallback) {
    const readable = await fetchReadableTextResource(url, {
      timeoutMs,
      useFetchCache,
      cacheDir,
      retries,
      cacheFirst: cacheFirstReadable,
    });
    if (isBlockedHtml(readable)) throw new Error("blocked readable fallback page");
    return readable;
  }

  try {
    const html = await fetchTextResource(url, {
      timeoutMs,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      useFetchCache,
      cacheDir,
      cacheNamespace: "html",
      retries,
    });
    if (isBlockedHtml(html)) throw new Error("blocked or non-indexable access page");
    return html;
  } catch (primaryError) {
    if (!allowReadableFallback) throw primaryError;
    try {
      const readable = await fetchReadableTextResource(url, {
        timeoutMs,
        useFetchCache,
        cacheDir,
        retries,
        cacheFirst: cacheFirstReadable,
      });
      if (isBlockedHtml(readable)) throw new Error("blocked readable fallback page");
      return readable;
    } catch (fallbackError) {
      throw new Error(`${primaryError.message}; readable fallback failed: ${fallbackError.message}`);
    }
  }
}

export async function fetchReadableTextResource(url, {
  timeoutMs = 12000,
  useFetchCache = true,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  retries = 1,
  cacheFirst = false,
} = {}) {
  return fetchTextResource(toReadableFetchUrl(url), {
    timeoutMs: getReadableTimeoutMs(timeoutMs),
    accept: "text/plain,*/*;q=0.8",
    useFetchCache,
    cacheDir,
    cacheNamespace: "readable",
    retries,
    cacheFirst,
  });
}

function getReadableTimeoutMs(timeoutMs) {
  const parsed = Number(timeoutMs) || 12000;
  return parsed >= 12000 ? Math.max(parsed, 20000) : parsed;
}

export async function fetchTextResource(url, {
  timeoutMs = 12000,
  accept = "*/*",
  useFetchCache = false,
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  cacheNamespace = "http",
  retries = 0,
  cacheFirst = false,
  allowProxyDirectFallback = shouldAllowProxyDirectFallback(),
} = {}) {
  if (useFetchCache && cacheFirst) {
    const cached = await readCachedTextResource(url, { cacheDir, cacheNamespace });
    if (cached) return cached;
  }

  let lastError;
  const attempts = Math.max(1, Number(retries || 0) + 1);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const text = await fetchTextResourceFromNetwork(url, { timeoutMs, accept, allowProxyDirectFallback });
      if (useFetchCache && text) {
        await writeCachedTextResource(url, text, { cacheDir, cacheNamespace, accept });
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isRetryableFetchError(error)) break;
      await sleep(getRetryDelayMs(attempt));
    }
  }

  if (useFetchCache) {
    const cached = await readCachedTextResource(url, { cacheDir, cacheNamespace });
    if (cached) return cached;
  }

  throw lastError;
}

async function fetchTextResourceFromNetwork(url, {
  timeoutMs = 12000,
  accept = "*/*",
  allowProxyDirectFallback = shouldAllowProxyDirectFallback(),
} = {}) {
  const dispatcher = getFetchProxyDispatcher(url);
  try {
    return await fetchTextResourceWithDispatcher(url, { timeoutMs, accept, dispatcher });
  } catch (error) {
    if (!dispatcher || !allowProxyDirectFallback || !isRetryableProxyRouteError(error)) throw error;
    try {
      return await fetchTextResourceWithDispatcher(url, {
        timeoutMs: getProxyDirectFallbackTimeoutMs(timeoutMs),
        accept,
        dispatcher: null,
      });
    } catch (fallbackError) {
      throw new Error(`${error.message}; direct retry without proxy failed: ${fallbackError.message}`);
    }
  }
}

async function fetchTextResourceWithDispatcher(url, {
  timeoutMs = 12000,
  accept = "*/*",
  dispatcher = null,
} = {}) {
  const controller = new AbortController();
  const timeout = Number(timeoutMs) || 12000;
  const response = await withTimeout(fetch(url, {
    signal: controller.signal,
    headers: {
      "Accept": accept,
      "Accept-Encoding": "identity",
      "User-Agent": DEFAULT_USER_AGENT,
      ...(isReadableWordPressApiUrl(url) ? { "X-Return-Format": "text" } : {}),
    },
    ...(dispatcher ? { dispatcher } : {}),
  }), timeout, controller);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await withTimeout(response.arrayBuffer(), timeout, controller));
  return decodeHtmlResponse(bytes, response.headers.get("content-type") || "");
}

function isReadableWordPressApiUrl(value = "") {
  return /^https:\/\/r\.jina\.ai\/http:\/\/[^/?#]+\/wp-json\/wp\/v2\/posts(?:[/?#]|$)/i.test(String(value || ""));
}

function getProxyDirectFallbackTimeoutMs(timeoutMs) {
  const timeout = Number(timeoutMs) || 12000;
  return Math.max(3000, Math.min(timeout, Math.ceil(timeout * 0.5)));
}

function isRetryableProxyRouteError(error) {
  const message = String(error?.message || error || "");
  if (/HTTP \d{3}\b/.test(message)) return false;
  return isRetryableFetchError(error);
}

function getFetchProxyDispatcher(requestUrl = "") {
  const proxyUrl = getConfiguredProxyUrl(requestUrl);
  if (!proxyUrl) return null;
  if (fetchProxyAgent && fetchProxyAgentUrl === proxyUrl) return fetchProxyAgent;
  fetchProxyAgent = new ProxyAgent(proxyUrl);
  fetchProxyAgentUrl = proxyUrl;
  return fetchProxyAgent;
}

function shouldPreferReadableFetch(source = {}, entry = {}) {
  return Boolean(entry?.readableSource)
    || Boolean(entry?.fromSourceSearch && source.crawler?.searchPreferReadable)
    || Boolean(source.crawler?.preferReadable);
}

function getConfiguredProxyUrl(requestUrl = "") {
  if (shouldBypassProxyForReadableUrl(requestUrl)) return "";
  if (hasFlag("--no-proxy")) return "";
  if (shouldBypassConfiguredProxyForUrl(requestUrl)) return "";
  return getArgumentValue("--proxy")
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || "";
}

function shouldAllowProxyDirectFallback() {
  if (hasFlag("--no-proxy-direct-fallback")) return false;
  const configured = String(process.env.DPRK_SEARCH_PROXY_DIRECT_FALLBACK || "").trim();
  return !/^(0|false|no|off)$/i.test(configured);
}

function shouldBypassProxyForReadableUrl(requestUrl = "") {
  return String(requestUrl || "").startsWith("https://r.jina.ai/");
}

function shouldBypassConfiguredProxyForUrl(requestUrl = "") {
  const rules = String(process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (!rules.length) return false;
  const { hostname, port } = getUrlHostAndPort(requestUrl);
  if (!hostname) return false;
  return rules.some((rule) => proxyBypassRuleMatches(rule, hostname, port));
}

function getUrlHostAndPort(value = "") {
  try {
    const url = new URL(value);
    return {
      hostname: url.hostname.toLocaleLowerCase("en-US").replace(/\.$/, ""),
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return { hostname: "", port: "" };
  }
}

function proxyBypassRuleMatches(rule = "", hostname = "", port = "") {
  if (rule === "*") return true;
  const [rawHost, rulePort = ""] = rule.toLocaleLowerCase("en-US").split(":");
  if (rulePort && rulePort !== port) return false;
  const hostRule = rawHost.replace(/^\*\./, ".").replace(/\.$/, "");
  if (!hostRule) return false;
  if (hostRule.startsWith(".")) {
    const suffix = hostRule.slice(1);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === hostRule || hostname.endsWith(`.${hostRule}`);
}

function maskProxyUrl(proxyUrl = "") {
  if (!proxyUrl) return "";
  try {
    const url = new URL(proxyUrl);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "configured";
  }
}

function withTimeout(promise, timeoutMs, controller) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller?.abort();
      reject(new Error("network timeout"));
    }, timeoutMs);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export function discoverLinks(html, baseUrl, source) {
  return discoverLinkEntries(html, baseUrl, source).map((entry) => entry.url);
}

export function discoverFeedEntries(xml, feedUrl, source) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries = [];

  $("item").each((_, item) => {
    entries.push(createFeedEntry($, item, feedUrl, source, "rss"));
  });
  $("entry").each((_, item) => {
    entries.push(createFeedEntry($, item, feedUrl, source, "atom"));
  });

  return dedupeLinkEntries(entries.filter((entry) => entry.url && isAllowedSourceUrl(entry.url, source)));
}

export function discoverSitemapEntries(xml, sitemapUrl, source) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const sitemaps = [];
  const entries = [];

  $("sitemap > loc").each((_, element) => {
    const url = stripHash(resolveUrl($(element).text(), sitemapUrl));
    if (url && isAllowedSourceUrl(url, source)) sitemaps.push(url);
  });

  $("url").each((_, element) => {
    const node = $(element);
    const url = stripHash(resolveUrl(node.children("loc").first().text(), sitemapUrl));
    if (!url || !isAllowedSourceUrl(url, source)) return;
    const lastModified = node.children("lastmod").first().text();
    const imageTitle = cleanText(node.find("image\\:title").first().text() || "");
    const imageCaption = cleanText(node.find("image\\:caption").first().text() || "");
    entries.push({
      url,
      linkText: imageTitle || cleanSitemapTitle(url),
      contextText: imageCaption || imageTitle || "",
      date: normalizeDate(lastModified),
      thumbnailUrl: resolveUrl(node.find("image\\:loc").first().text(), sitemapUrl) || "",
      fromSitemap: true,
      sourceId: source.id,
    });
  });

  return {
    sitemaps: [...new Set(sitemaps)],
    entries: dedupeLinkEntries(entries),
  };
}

export function discoverLinkEntries(html, baseUrl, source) {
  const $ = cheerio.load(html);
  const links = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || !isAllowedSourceUrl(resolved, source)) return;
    if (!looksIndexableUrl(resolved) && !isIndexableMediaAssetUrl(resolved, source)) return;
    const image = $(element).find("img[src]").first();
    const imageAltText = cleanText(image.attr("alt") || image.attr("title") || "");
    const thumbnailUrl = resolveUrl(image.attr("src"), baseUrl) || "";
    const linkText = cleanText($(element).text()) || imageAltText;
    const contextText = cleanText(preserveHtmlBlockText($(element).closest("article, li, tr, .card, .entry, .item, div").first())) || imageAltText;
    links.push({
      url: stripHash(resolved),
      linkText,
      contextText,
      date: extractDateText(preserveHtmlBlockText($(element).closest("article, li, tr, .card, .entry, .item, div").first())),
      thumbnailUrl,
      ...inferDisplaySourceFields(source, { thumbnailUrl, contextText }),
    });
  });
  links.push(...discoverMarkdownLinkEntries(html, baseUrl, source));
  return dedupeLinkEntries(links);
}

export function discoverMarkdownLinkEntries(markdown, baseUrl, source) {
  const links = [];
  const linkPattern = /!?\[(.*?)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
  const lines = String(markdown || "").split(/\r?\n/);
  const readableSource = isReadableCrawlerText(markdown);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let match;
    linkPattern.lastIndex = 0;
    while ((match = linkPattern.exec(line))) {
      const resolved = resolveUrl(match[2], baseUrl);
      if (!resolved || !isAllowedSourceUrl(resolved, source)) continue;
      if (!looksIndexableUrl(resolved) && !isIndexableMediaAssetUrl(resolved, source)) continue;
      const markdownTitle = cleanReadableText(match[3] || "");
      const linkText = cleanReadableText(match[1] || markdownTitle);
      const contextText = source.id === "korean-books" && isPdfUrl(resolved)
        ? collectKoreanBooksMarkdownPdfContext(line, match)
        : collectMarkdownLinkContext(lines, lineIndex, linkText || markdownTitle);
      const thumbnailCandidate = source.id === "korean-books" && isPdfUrl(resolved)
        ? extractNearestPreviousMarkdownImageUrl(line, match.index) || findPreviousMarkdownImageUrl(lines, lineIndex) || ""
        : extractMarkdownImageUrl(line) || findPreviousMarkdownImageUrl(lines, lineIndex) || "";
      const thumbnailUrl = stripHash(resolveUrl(thumbnailCandidate, baseUrl) || thumbnailCandidate);
      links.push({
        url: stripHash(resolved),
        linkText,
        contextText,
        date: extractDateText(line.slice(match.index + match[0].length))
          || findAdjacentMarkdownLinkDate(lines, lineIndex, resolved, baseUrl)
          || extractDateText(contextText),
        thumbnailUrl,
        ...inferDisplaySourceFields(source, { thumbnailUrl, contextText }),
        readableSource,
      });
    }
  }

  return dedupeLinkEntries(links);
}

function findAdjacentMarkdownLinkDate(lines = [], lineIndex = 0, targetUrl = "", baseUrl = "") {
  const normalizedTargetUrl = stripHash(resolveUrl(targetUrl, baseUrl) || targetUrl);
  for (let index = lineIndex - 1; index >= 0 && index >= lineIndex - 3; index -= 1) {
    const line = String(lines[index] || "");
    if (!cleanReadableText(line)) continue;
    const date = extractDateText(line);
    if (date && markdownLineLinksToUrl(line, normalizedTargetUrl, baseUrl)) return date;
    if (/\[[^\]]+\]\([^)]+\)/.test(line)) break;
  }

  for (let index = lineIndex + 1; index < lines.length && index <= lineIndex + 2; index += 1) {
    const line = String(lines[index] || "");
    if (!cleanReadableText(line)) continue;
    const date = extractDateText(line);
    const hasMarkdownLink = /\[[^\]]+\]\([^)]+\)/.test(line);
    if (date && (!hasMarkdownLink || markdownLineLinksToUrl(line, normalizedTargetUrl, baseUrl))) return date;
    if (hasMarkdownLink) break;
  }
  return "";
}

function markdownLineLinksToUrl(line = "", targetUrl = "", baseUrl = "") {
  const linkPattern = /!?\[(.*?)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = linkPattern.exec(String(line || "")))) {
    const url = stripHash(resolveUrl(match[2], baseUrl) || "");
    if (url && url === targetUrl) return true;
  }
  return false;
}

export function discoverEmbeddedDocumentEntries(content, pageUrl, source) {
  if (source.id === "rodong-sinmun") return discoverRodongEmbeddedDocumentEntries(content, pageUrl, source);
  if (source.id === "voice-of-korea") return discoverVoiceOfKoreaEmbeddedDocumentEntries(content, pageUrl, source);
  if (source.id === "naenara") return discoverNaenaraEmbeddedDocumentEntries(content, pageUrl, source);
  return [];
}

function discoverRodongEmbeddedDocumentEntries(content, pageUrl, source) {
  if (!isReadableCrawlerText(content)) return [];
  const markdown = getReadableMarkdownContent(content);
  const documents = extractRodongListingDocuments(markdown, pageUrl, source);
  return documents.map((document) => ({
    url: document.url,
    linkText: document.title,
    contextText: document.snippet,
    date: document.date,
    thumbnailUrl: document.thumbnailUrl || "",
    readableSource: true,
    fallbackDocument: document,
  }));
}

function extractRodongListingDocuments(markdown, pageUrl, source) {
  const documentsByUrl = new Map();
  const lines = String(markdown || "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = String(lines[index] || "");
    const link = extractFirstMarkdownLink(rawLine, pageUrl, source);
    if (!link || !shouldIndexCrawledUrl(link.url, source)) continue;

    const title = cleanDocumentTitle(cleanReadableTitle(link.label));
    if (!title || isGenericTitle(title, source) || isRodongListingChromeTitle(title)) continue;

    const dateText =
      extractDateText(rawLine)
      || extractDateText(lines[index + 1] || "")
      || extractDateFromUrl(link.url);
    const date = dateText ? normalizeDate(dateText) : "";
    const snippet = [title, date ? formatCompactDate(date) : ""].filter(Boolean).join(" ");
    const document = {
      id: `${source.id}-${hashUrl(link.url)}`,
      title,
      snippet,
      body: snippet,
      date,
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.sourceType,
      mediaType: "article",
      url: link.url,
      archiveUrl: stripHash(pageUrl),
      thumbnailUrl: "",
      language: inferDocumentLanguage([title, snippet].join(" "), link.url, source),
      aliases: [],
      searchTabs: source.searchTabs || [],
    };
    const existing = documentsByUrl.get(link.url);
    if (!existing || getRodongListingDocumentScore(document) > getRodongListingDocumentScore(existing)) {
      documentsByUrl.set(link.url, document);
    }
  }

  return [...documentsByUrl.values()]
    .sort((left, right) => right.date.localeCompare(left.date) || left.title.localeCompare(right.title, "ko-KR"))
    .slice(0, 40);
}

function extractFirstMarkdownLink(line = "", pageUrl = "", source = {}) {
  const linkPattern = /\[(.*?)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = linkPattern.exec(String(line || "")))) {
    const label = cleanReadableText(match[1]);
    const url = stripHash(resolveUrl(match[2], pageUrl));
    if (!url || !isAllowedSourceUrl(url, source)) continue;
    return { label, url };
  }
  return null;
}

function isRodongListingChromeTitle(title = "") {
  return /^(＞＞＞|조선어|English|中 文|검색|오늘호 기사|혁명활동소식|인민을 위한 정치|전진하는 조선|사회문화생활|유구한 력사,찬란한 문화|사진|동영상)$/i.test(title);
}

function getRodongListingDocumentScore(document = {}) {
  return (document.date ? 100 : 0) + Math.min(String(document.title || "").length, 120);
}

function formatCompactDate(date = "") {
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}.${Number(match[2])}.${Number(match[3])}.` : "";
}

function discoverVoiceOfKoreaEmbeddedDocumentEntries(content, pageUrl, source) {
  if (!isReadableCrawlerText(content)) return [];
  if (!/\/index\.php\/Colist\//i.test(pageUrl)) return [];

  const markdown = getReadableMarkdownContent(content);
  const entriesByUrl = new Map();
  const lines = String(markdown || "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = String(lines[index] || "");
    for (const entry of extractVoiceOfKoreaImageCardEntries(rawLine, pageUrl, source)) {
      addVoiceOfKoreaListingEntry(entriesByUrl, entry);
    }
    if (rawLine.includes("[![")) continue;

    const link = extractFirstMarkdownLink(rawLine, pageUrl, source);
    if (!link || !shouldIndexCrawledUrl(link.url, source)) continue;

    const title = cleanVoiceOfKoreaListingTitle(link.label);
    if (!isIndexableVoiceOfKoreaListingTitle(title, source)) continue;

    const dateText =
      extractDateText(rawLine)
      || extractDateText(lines[index + 1] || "")
      || extractDateFromUrl(link.url);
    addVoiceOfKoreaListingEntry(entriesByUrl, createVoiceOfKoreaListingEntry({
      title,
      url: link.url,
      date: dateText ? normalizeDate(dateText) : "",
      pageUrl,
      source,
    }));
  }

  return [...entriesByUrl.values()];
}

function extractVoiceOfKoreaImageCardEntries(line = "", pageUrl = "", source = {}) {
  const entries = [];
  const cardPattern = /\[!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*([^\]]*?)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;

  while ((match = cardPattern.exec(String(line || "")))) {
    const url = normalizeVoiceOfKoreaUrl(stripHash(resolveUrl(match[4], pageUrl)));
    if (!url || !shouldIndexCrawledUrl(url, source)) continue;

    const caption = cleanReadableText(match[3] || "");
    const altText = cleanReadableText(match[1] || "");
    const title = cleanVoiceOfKoreaListingTitle(caption || altText);
    if (!isIndexableVoiceOfKoreaListingTitle(title, source)) continue;

    const dateText = extractDateText(caption) || extractDateText(altText) || extractDateFromUrl(url);
    const thumbnailUrl = stripHash(resolveUrl(match[2], pageUrl));
    entries.push(createVoiceOfKoreaListingEntry({
      title,
      url,
      date: dateText ? normalizeDate(dateText) : "",
      pageUrl,
      source,
      thumbnailUrl,
    }));
  }

  return entries;
}

function createVoiceOfKoreaListingEntry({
  title,
  url,
  date = "",
  pageUrl = "",
  source = {},
  thumbnailUrl = "",
}) {
  const normalizedUrl = normalizeVoiceOfKoreaUrl(url);
  const mediaType = inferMediaType(normalizedUrl, "", source);
  const snippet = [
    title,
    mediaType === "broadcast" ? "방송" : "",
    date ? formatCompactDate(date) : "",
  ].filter(Boolean).join(" ");
  return {
    url: normalizedUrl,
    linkText: title,
    contextText: snippet,
    date,
    thumbnailUrl,
    archiveUrl: stripHash(pageUrl),
    readableSource: true,
  };
}

function addVoiceOfKoreaListingEntry(entriesByUrl, entry) {
  if (!entry?.url || !entry.linkText) return;
  const existing = entriesByUrl.get(entry.url);
  if (!existing || getLinkEntryQualityScore(entry) > getLinkEntryQualityScore(existing)) {
    entriesByUrl.set(entry.url, entry);
  }
}

function cleanVoiceOfKoreaListingTitle(value = "") {
  const dateText = extractDateText(value);
  const withoutDate = dateText ? String(value || "").replace(dateText, " ") : value;
  return cleanDocumentTitle(cleanReadableTitle(withoutDate));
}

function isIndexableVoiceOfKoreaListingTitle(title = "", source = {}) {
  const text = cleanReadableTitle(title);
  if (text.length < 3 || isGenericTitle(text, source)) return false;
  return !/^(vok|첫페지로|어종선택|오늘의 방송|조선어|English|Deutsch|Русский|汉\s*语|Français|العربية|日\s*本\s*語|Español)$/i.test(text);
}

function normalizeVoiceOfKoreaUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (normalizeHostname(parsed.hostname) === "vok.rep.kp") {
      parsed.protocol = "http:";
      parsed.hostname = "www.vok.rep.kp";
    }
    return parsed.href;
  } catch {
    return url;
  }
}

function discoverNaenaraEmbeddedDocumentEntries(content, pageUrl, source) {
  if (!isReadableCrawlerText(content)) return [];
  if (!/\/main\/index\/(?:ko|en|fr|sp|ge|ru|ch|ja|ar)\/(?:first|news|tourism)(?:$|[?#])/i.test(pageUrl)) return [];
  const documents = [
    ...extractNaenaraNewsTableDocuments(content, pageUrl, source),
    ...extractNaenaraHomeFeatureDocuments(content, pageUrl, source),
  ];
  return documents.map((document) => ({
    url: document.url,
    linkText: document.title,
    contextText: document.snippet,
    date: document.date,
    thumbnailUrl: document.thumbnailUrl || "",
    embeddedDocument: document,
  }));
}

function extractNaenaraNewsTableDocuments(content, pageUrl, source) {
  const markdown = getReadableMarkdownContent(content);
  const documents = [];
  const rowPattern = /^\|\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\[\s*(\d{4}-\d{2}-\d{2})\s*\]\s*\|(?:\s*\|\s*)*$/gm;
  let match;

  while ((match = rowPattern.exec(markdown)) && documents.length < 30) {
    const order = Number(match[1]);
    const title = cleanReadableTitle(match[2]);
    const date = normalizeDate(match[3]);
    if (!isIndexableNaenaraTitle(title)) continue;

    documents.push(createNaenaraEmbeddedDocument({
      title,
      date,
      source,
      pageUrl,
      order,
      snippet: createNaenaraRowSnippet(title, date, pageUrl),
    }));
  }

  return documents;
}

function createNaenaraRowSnippet(title, date, pageUrl = "") {
  const section = /\/tourism(?:$|[?#])/i.test(pageUrl)
    ? (/\/ko\/tourism(?:$|[?#])/i.test(pageUrl) ? "관광소식" : "Tourism News")
    : "";
  return [section, `${title} [${date}]`].filter(Boolean).join(": ");
}

function extractNaenaraHomeFeatureDocuments(content, pageUrl, source) {
  const markdown = getReadableMarkdownContent(content);
  const documents = [];
  const lines = markdown.split(/\r?\n/);
  let section = "";
  let thumbnailUrl = "";
  let featureBodyLines = [];
  const titleDatePattern = /^(.+?)\s*\[\s*(\d{4}[-.\s년]+\d{1,2}[-.\s월]+\d{1,2})\s*\]\s*$/;

  for (const line of lines) {
    const text = cleanReadableText(line);
    if (!text) continue;
    const heading = text.replace(/\s+/g, "");
    if (heading.includes("경애하는김정은동지의혁명활동소식")) {
      section = "revolution";
      continue;
    }
    if (heading.includes("소식,기사")) {
      section = "news";
      thumbnailUrl = "";
      continue;
    }

    const imageUrl = extractMarkdownImageUrl(line);
    if (imageUrl && /\/images\/periodic\//i.test(imageUrl)) {
      thumbnailUrl = imageUrl;
      featureBodyLines = [];
      continue;
    }

    const titleMatch = text.match(titleDatePattern);
    if (!titleMatch) {
      if (thumbnailUrl && isNaenaraFeatureBodyLine(text)) featureBodyLines.push(text);
      continue;
    }
    if (!isIndexableNaenaraTitle(titleMatch[1])) continue;
    const title = cleanReadableTitle(titleMatch[1]);
    const date = normalizeDate(titleMatch[2]);
    const featureBody = createNaenaraFeatureBody(title, featureBodyLines);
    documents.push(createNaenaraEmbeddedDocument({
      title,
      date,
      source,
      pageUrl,
      order: documents.length + 1,
      snippet: featureBody ? featureBody.slice(0, 280) : `${title} [${date}]`,
      body: featureBody,
      thumbnailUrl: section === "revolution" || section === "news" ? thumbnailUrl : "",
    }));
    featureBodyLines = [];
    thumbnailUrl = "";
  }

  return documents.slice(0, 20);
}

function isNaenaraFeatureBodyLine(text = "") {
  const cleaned = cleanReadableText(text);
  if (cleaned.length < 24) return false;
  if (/^(NAENARA\.COM\.KP|조선민주주의인민공화국|조선어|English|Français|Español|Deutsch|Русский|汉语|日本語|العربية)$/i.test(cleaned)) return false;
  if (/^(첫페지|소식,\s*기사|조선개관|경제,\s*무역|사회문화|력사|관광|사\s*진|동영상|음\s*악|우표|선전화|미술)$/i.test(cleaned)) return false;
  if (/^(경애하는.*명언|Respected.*Aphorism|Citation|Quote)$/i.test(cleaned)) return false;
  if (/^《.+》$/.test(cleaned) && cleaned.length < 120) return false;
  if (/^\*+\s*$/.test(cleaned)) return false;
  return true;
}

function createNaenaraFeatureBody(title = "", lines = []) {
  const normalizedTitle = normalizeComparableTitle(title);
  const cleanedLines = [];
  const seen = new Set();

  for (const line of lines) {
    const cleaned = cleanReadableText(line);
    if (!cleaned || !isNaenaraFeatureBodyLine(cleaned)) continue;
    if (normalizeComparableTitle(cleaned) === normalizedTitle) continue;
    const key = normalizeComparableTitle(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    cleanedLines.push(cleaned);
  }

  if (!cleanedLines.length) return "";
  return cleanText([title, ...cleanedLines].join("\n")).slice(0, 2200);
}

function createNaenaraEmbeddedDocument({
  title,
  date,
  source,
  pageUrl,
  order = 0,
  snippet = "",
  body = "",
  thumbnailUrl = "",
}) {
  const url = `${stripHash(pageUrl)}#${slugText(title)}-${date}`;
  const documentBody = body || [title, snippet].filter(Boolean).join(" ");
  return {
    id: `${source.id}-${hashUrl(`${title}-${date}`)}`,
    title,
    snippet: cleanText(snippet || title).slice(0, 280),
    body: documentBody,
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType: "article",
    url,
    archiveUrl: stripHash(pageUrl),
    thumbnailUrl,
    language: inferDocumentLanguage([title, snippet, documentBody].filter(Boolean).join(" "), url, source),
    aliases: [],
    searchTabs: source.searchTabs || [],
  };
}

export function extractFeedDocumentFromEntry(entry, source) {
  const title = cleanText(entry?.linkText);
  const url = entry?.url;
  if (!title || !url) return null;

  const snippet = cleanText(stripHtml(entry.feedSummary || entry.contextText)) || `${source.name} 기사`;
  const date = normalizeDate(entry.date);
  const mediaType = isPdfUrl(url) ? "pdf" : inferMediaType(url, "", source);
  const body = [title, snippet].filter(Boolean).join(" ");

  return {
    id: `${source.id}-${hashUrl(url)}`,
    title,
    snippet,
    body,
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType,
    url,
    archiveUrl: "",
    thumbnailUrl: entry.thumbnailUrl || "",
    ...getDocumentDisplaySourceFields(entry),
    language: inferDocumentLanguage([title, snippet, body].filter(Boolean).join(" "), url, source),
    aliases: [],
    searchTabs: source.searchTabs || [],
  };
}

export function extractSourceSearchDocumentFromEntry(entry, source) {
  const title = cleanReadableTitle(entry?.linkText);
  const url = entry?.url;
  if (!title || !url || isGenericTitle(title, source)) return null;

  const rawContextText = entry?.contextText || "";
  const contextText = cleanSourceSearchContextText(title, rawContextText);
  const date = normalizeDate(entry?.date || rawContextText || contextText);
  const documentContextText = source.id === "rodong-sinmun"
    ? (date ? formatCompactDate(date) : "")
    : contextText;
  const snippet = documentContextText && documentContextText !== title
    ? documentContextText.slice(0, 320)
    : `${source.name} 검색 결과`;
  const mediaType = isPdfUrl(url) ? "pdf" : inferMediaType(url, documentContextText, source);
  const body = [title, documentContextText].filter(Boolean).join(" ");

  return {
    id: `${source.id}-${hashUrl(url)}`,
    title,
    snippet,
    body,
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType,
    url,
    archiveUrl: "",
    thumbnailUrl: entry.thumbnailUrl || "",
    ...getDocumentDisplaySourceFields(entry),
    language: inferDocumentLanguage([title, snippet, body].filter(Boolean).join(" "), url, source),
    aliases: [],
    searchTabs: source.searchTabs || [],
  };
}

export function cleanSourceSearchContextText(title = "", value = "") {
  const cleanedTitle = cleanReadableTitle(title);
  let text = cleanReadableText(value)
    .replace(/\bKCNA Watch Logo\b/gi, " ")
    .replace(/\bBrowse\b/gi, " ")
    .replace(/\s*\.\.\.\s*Upgrade to NK PRO today.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const beforeRepeatedDate = trimAtRepeatedEnglishDate(text);
  if (beforeRepeatedDate) text = beforeRepeatedDate;
  text = removeLeadingRepeatedTitle(text, cleanedTitle);
  return cleanReadableText(text);
}

const KCNA_WATCH_DISPLAY_SOURCE_PATTERNS = [
  {
    pattern: /(?:^|[/_-])(?:kcna(?:[-_]?korean|[-_]?english)?|kcnakorean|kcnaenglish|kcna_kp)(?:[/.?_-]|$)/i,
    id: "kcna",
    name: "조선중앙통신",
    sourceType: "official_site",
  },
  {
    pattern: /(?:^|[/_-])rodong(?:[-_]?korean|[-_]?english)?(?:[/.?_-]|$)/i,
    id: "rodong-sinmun",
    name: "로동신문",
    sourceType: "official_site",
  },
  {
    pattern: /voice[-_]?of[-_]?korea/i,
    id: "voice-of-korea",
    name: "조선의 소리",
    sourceType: "official_site",
  },
  {
    pattern: /minju[_-]?choson/i,
    id: "minju-choson",
    name: "민주조선",
    sourceType: "official_site",
  },
  {
    pattern: /naenara/i,
    id: "naenara",
    name: "내나라",
    sourceType: "official_site",
  },
  {
    pattern: /ryugyong/i,
    id: "ryugyong",
    name: "류경",
    sourceType: "official_site",
  },
];

function inferDisplaySourceFields(source = {}, context = {}) {
  if (source.id !== "kcna-watch") return {};
  const haystack = [
    context.thumbnailUrl,
    context.contextText,
    context.linkText,
  ].map((value) => String(value || "")).join(" ");
  if (!haystack) return {};

  const match = KCNA_WATCH_DISPLAY_SOURCE_PATTERNS.find((candidate) => candidate.pattern.test(haystack));
  if (!match) return {};
  return {
    displaySourceId: match.id,
    displaySourceName: match.name,
    displaySourceType: match.sourceType,
  };
}

function getDocumentDisplaySourceFields(context = {}) {
  return context?.displaySourceId
    ? {
        displaySourceId: context.displaySourceId,
        displaySourceName: context.displaySourceName || context.displaySourceId,
        displaySourceType: context.displaySourceType || "archive",
      }
    : {};
}

function trimAtRepeatedEnglishDate(text = "") {
  const match = String(text || "").match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);
  if (!match || !Number.isFinite(match.index) || match.index < 24) return "";
  return text.slice(0, match.index).trim();
}

function removeLeadingRepeatedTitle(text = "", title = "") {
  const comparableTitle = normalizeComparableTitle(title);
  if (!comparableTitle) return text;

  let next = String(text || "").trim();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const comparableText = normalizeComparableTitle(next.slice(0, Math.max(title.length * 2, 160)));
    if (!comparableText.startsWith(comparableTitle)) break;
    next = next.slice(findLeadingTitleEnd(next, title)).trim();
  }
  return next;
}

function findLeadingTitleEnd(text = "", title = "") {
  const chars = Array.from(String(text || ""));
  const target = normalizeComparableTitle(title);
  let comparable = "";
  let offset = 0;

  for (const char of chars) {
    offset += char.length;
    comparable += normalizeComparableTitle(char);
    if (comparable.length >= target.length) return offset;
  }
  return 0;
}

function createSourceSearchFallbackDocument(entry, source, report) {
  if (!entry?.fromSourceSearch) return null;
  if (source.crawler?.indexSearchResults === false) return null;
  if (source.crawler?.fetchSearchResultPages !== true) return null;

  const document = extractSourceSearchDocumentFromEntry(entry, source);
  if (!document) return null;
  if (report) report.searchResultFallbacks = (report.searchResultFallbacks || 0) + 1;
  return {
    ...document,
    snippet: document.snippet || "검색 결과에서 확보한 색인 후보입니다.",
    body: document.body || [document.title, document.snippet].filter(Boolean).join(" "),
  };
}

function createListingFallbackDocument(entry, source, report) {
  if (!source.crawler?.indexListingFallbacks) return null;
  if (entry?.fromSourceSearch || entry?.fromFeed || entry?.embeddedDocument) return null;
  const title = cleanReadableTitle(entry?.linkText || "");
  const url = entry?.url || "";
  if (!title || !url || isGenericTitle(title, source) || !shouldIndexCrawledUrl(url, source)) return null;

  const date = normalizeDate(
    entry?.date
    || extractDateText(entry?.linkText || "")
    || extractDateText(entry?.contextText || ""),
  );
  const mediaType = inferMediaType(url, entry?.contextText || "", source);
  const snippet = [title, date ? `[${date}]` : ""].filter(Boolean).join(" ");
  if (report) report.listingFallbacks = (report.listingFallbacks || 0) + 1;

  return {
    id: `${source.id}-${hashUrl(url)}`,
    title,
    snippet,
    body: snippet,
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType,
    url,
    archiveUrl: entry?.archiveUrl || "",
    thumbnailUrl: entry?.thumbnailUrl || "",
    language: inferDocumentLanguage([title, snippet].filter(Boolean).join(" "), url, source),
    aliases: [],
    searchTabs: getMediaSearchTabs(source, mediaType),
  };
}

export function parseWordPressPostsPayload(text = "") {
  const candidates = [
    getReadableMarkdownContent(text),
    String(text || ""),
  ].map((candidate) => candidate.trim()).filter(Boolean);

  for (const candidate of candidates) {
    const jsonText = extractJsonArrayText(candidate);
    if (!jsonText) continue;
    const parsed = parseJsonArrayCandidate(jsonText);
    return Array.isArray(parsed) ? parsed : [];
  }

  return [];
}

export function createWordPressPostDocument(post, source) {
  const url = stripHash(resolveUrl(getWordPressFieldValue(post?.link), source.baseUrl) || getWordPressFieldValue(post?.link));
  const title = cleanReadableTitle(stripHtml(getWordPressFieldValue(post?.title)));
  if (!url || !title || isGenericTitle(title, source)) return null;

  const excerpt = cleanReadableText(stripHtml(getWordPressFieldValue(post?.excerpt)));
  const content = cleanReadableBodyText(stripHtml(getWordPressFieldValue(post?.content)));
  const body = content || excerpt || title;
  if (body.length < getMinimumDocumentBodyLength(source, 20)) return null;

  const snippet = cleanReadableText(excerpt || content || title).slice(0, 320);
  const date = normalizeDate(post?.date || post?.modified || "");
  const thumbnailUrl = extractWordPressFeaturedImageUrl(post);

  return {
    id: `${source.id}-${hashUrl(url)}`,
    title,
    snippet,
    body: [title, body].filter(Boolean).join("\n\n"),
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType: "article",
    url,
    archiveUrl: "",
    thumbnailUrl,
    language: inferDocumentLanguage([title, snippet, body].filter(Boolean).join(" "), url, source),
    aliases: [],
    searchTabs: source.searchTabs || [],
  };
}

function createWordPressPostDocuments(post, source) {
  const articleDocument = createWordPressPostDocument(post, source);
  if (!articleDocument) return [];
  const contentHtml = getWordPressFieldValue(post?.content);
  return [
    articleDocument,
    ...extractArticleImageDocumentsFromContent(contentHtml, articleDocument.url, source, articleDocument),
  ];
}

export function extractDocumentFromHtml(html, url, source, context = {}) {
  if (isBlockedHtml(html) || !shouldIndexCrawledUrl(url, source)) return null;
  if (isReadableCrawlerText(html)) return extractDocumentFromReadableText(html, url, source, context);

  const $ = cheerio.load(html);
  removeNoise($);
  const sourceSpecific = extractSourceSpecificDocument($, url, source);

  const title = normalizeReadableMetadataTitle(cleanDocumentTitle(cleanText(
    sourceSpecific.title
    || selectFirstText($, source.crawler?.selectors?.title)
    || $("meta[property='og:title']").attr("content")
    || $("meta[name='twitter:title']").attr("content")
    || $("title").text(),
  )), source);
  const body = limitDocumentBodyLength(
    cleanBodyText(sourceSpecific.body || selectFirstBodyText($, source.crawler?.selectors?.body) || preserveHtmlBlockText($("body"))),
    source,
  );
  const snippet = normalizeReadableMetadataSnippet(cleanText(
    sourceSpecific.snippet
    || $("meta[name='description']").attr("content")
    || $("meta[property='og:description']").attr("content")
    || body.slice(0, 280),
  ), source);
  const pageDate = sourceSpecific.date
    || $(source.crawler?.selectors?.date || "time").first().attr("datetime")
    || selectFirstText($, source.crawler?.selectors?.date)
    || $("meta[property='article:published_time']").attr("content")
    || context?.date
    || context?.fallbackDocument?.date
    || extractDateFromUrl(url);
  const date = normalizeCrawledDate(
    source.id === "kcna"
      ? extractKoreanDatelineDate(body, pageDate) || pageDate
      : pageDate,
    source,
  );
  const mediaType = inferMediaType(url, html, source);
  const pageThumbnailUrl = resolveUrl($("meta[property='og:image']").attr("content") || $("img[src]").first().attr("src"), url) || "";
  const listingThumbnailUrl = String(context?.thumbnailUrl || "").trim();
  const thumbnailUrl = source.id === "kcna"
    && mediaType === "video"
    && /^data:(?:image\/[^;,]+)?;base64,/iu.test(listingThumbnailUrl)
    ? listingThumbnailUrl
    : pageThumbnailUrl;

  if (!title || !snippet || title.length < 2 || body.length < getMinimumDocumentBodyLength(source, 20)) return null;
  if (!sourceSpecific.title && isGenericTitle(title, source)) return null;

  return {
    id: `${source.id}-${hashUrl(url)}`,
    title,
    snippet,
    body,
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType,
    url,
    archiveUrl: "",
    thumbnailUrl,
    language: inferDocumentLanguage([title, snippet, body].filter(Boolean).join(" "), url, source),
    aliases: sourceSpecific.aliases || [],
    searchTabs: source.searchTabs || [],
  };
}

export function extractDocumentFromReadableText(text, url, source, context = {}) {
  const titleHint = cleanReadableTitle(context?.linkText || "");
  const rawReadableTitle = String(text).match(/^Title:\s*(.+)$/m)?.[1]
    || String(text).match(/^#\s+(.+)$/m)?.[1]
    || "";
  const markdownHeadingTitle = cleanReadableTitle(String(text).match(/^##\s+(.+)$/m)?.[1] || "");
  const readableTitle = cleanReadableTitle(
    normalizeReadableMetadataTitle(rawReadableTitle, source),
  );
  const markdown = String(text).split(/Markdown Content:\s*/).slice(1).join("Markdown Content:") || text;
  const readableTitleCandidate = isGenericTitle(readableTitle, source) && markdownHeadingTitle
    ? markdownHeadingTitle
    : readableTitle;
  let title = cleanDocumentTitle(titleHint && !isGenericTitle(titleHint, source) ? titleHint : readableTitleCandidate);
  const readableDisplaySourceFields = inferKcnaWatchReadableDisplaySourceFields(markdown, source);
  const contextText = cleanReadableBodyText(context?.contextText || "");
  const articleBody = extractReadableArticleBody(markdown, title);
  const fullBody = articleBody || cleanReadableBodyText(markdown);
  const hasSubstantialReadableBody = fullBody.length >= Math.max(420, contextText.length * 2);
  const listingReadableBody = shouldUseReadableContextAsBody(readableTitle, source, contextText)
    && isReadableListingMarkdown(markdown);
  const useContextBody = listingReadableBody
    && (!hasSubstantialReadableBody || (context?.fromSourceSearch && !articleBody));
  const body = limitDocumentBodyLength(useContextBody ? contextText : fullBody, source);
  title = selectSourceSpecificReadableTitle(title, body, source);
  const snippet = cleanReadableText(useContextBody ? contextText : (articleBody || createReadableSnippet(markdown, title))).slice(0, 280);
  const publishedTime = String(text).match(/^Published Time:\s*(.+)$/m)?.[1] || "";
  const markdownDateText = extractDateText(markdown);
  const datelineDate = extractKoreanDatelineDate(`${articleBody}\n${markdown}`, context?.date || publishedTime || markdownDateText);
  const date = normalizeCrawledDate(datelineDate || context?.date || publishedTime || markdownDateText, source);
  const mediaType = inferMediaType(url, text, source);

  if (!title || !snippet || title.length < 2 || body.length < getMinimumDocumentBodyLength(source, 20)) return null;
  if (isGenericTitle(title, source)) return null;

  return {
    id: `${source.id}-${hashUrl(url)}`,
    title,
    snippet,
    body,
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType,
    url,
    archiveUrl: "",
    originalSourceUrl: extractOriginalSourceUrlFromReadableText(markdown, source),
    thumbnailUrl: context?.thumbnailUrl || "",
    ...readableDisplaySourceFields,
    ...getDocumentDisplaySourceFields(context),
    language: inferDocumentLanguage([title, snippet, body].filter(Boolean).join(" "), url, source),
    aliases: [],
    searchTabs: source.searchTabs || [],
  };
}

function inferKcnaWatchReadableDisplaySourceFields(markdown = "", source = {}) {
  if (source.id !== "kcna-watch") return {};
  const sourceLabel = String(markdown || "").match(/^Date:\s*.+?\|\s*Source:\s*([^|\n]+?)(?:\s*\||$)/im)?.[1] || "";
  return inferKcnaWatchDisplaySourceFromLabel(sourceLabel);
}

function inferKcnaWatchDisplaySourceFromLabel(label = "") {
  const cleaned = cleanText(label)
    .replace(/\([^)]*\)/g, " ")
    .trim();
  if (!cleaned) return {};
  const candidates = [
    [/^(?:KCNA|Korean Central News Agency|조선중앙통신)/i, "kcna", "조선중앙통신"],
    [/^(?:Rodong Sinmun|로동신문|노동신문)/i, "rodong-sinmun", "로동신문"],
    [/^(?:Voice of Korea|조선의 소리)/i, "voice-of-korea", "조선의 소리"],
    [/^(?:Minju Choson|민주조선)/i, "minju-choson", "민주조선"],
    [/^(?:Naenara|내나라)/i, "naenara", "내나라"],
    [/^(?:Ryugyong|류경)/i, "ryugyong", "류경"],
  ];
  const match = candidates.find(([pattern]) => pattern.test(cleaned));
  if (!match) return {};
  return {
    displaySourceId: match[1],
    displaySourceName: match[2],
    displaySourceType: "official_site",
  };
}

function extractOriginalSourceUrlFromReadableText(markdown = "", source = {}) {
  if (source.id !== "kcna-watch") return "";
  const sourceLinkMatch = String(markdown || "").match(/\[Read original version at source\]\((https?:\/\/[^)\s]+)\)/i);
  if (sourceLinkMatch?.[1]) return stripHash(sourceLinkMatch[1]);
  const sourceLineMatch = String(markdown || "").match(/^Date:\s*.+?\|\s*Source:\s*.+?\|\s*(https?:\/\/\S+)/im);
  return sourceLineMatch?.[1] ? stripHash(sourceLineMatch[1]) : "";
}

function normalizeReadableMetadataTitle(title, source) {
  const value = cleanText(title);
  if (source.id !== "kcna") return value;
  const kcnaArticleTitle = value.match(
    /^(?:조선중앙통신|KCNA|Korean Central News Agency)\s*\|\s*(?:(?:기사|Article|사진|Photo|동화상|Video)\s*\|\s*)?(.+)$/iu,
  );
  return kcnaArticleTitle ? kcnaArticleTitle[1] : value;
}

function normalizeReadableMetadataSnippet(snippet, source) {
  const value = cleanText(snippet);
  if (source.id !== "kcna") return value;
  return value.replace(
    /^(?:조선중앙통신|KCNA|Korean Central News Agency)\s*,\s*(?:KCNA\s*,\s*)?(?:(?:기사|Article|사진|Photo|동화상|Video)\s*,\s*)?/iu,
    "",
  ).trim();
}

export function extractPdfDocumentFromLink(entry, source) {
  const url = typeof entry === "string" ? entry : entry?.url;
  if (!url || !isPdfUrl(url)) return null;

  const title = cleanDocumentTitle(cleanText(entry?.linkText) || cleanFileTitle(url) || "PDF 문헌");
  const contextText = cleanText(entry?.contextText);
  const snippet = contextText && contextText !== title
    ? contextText.slice(0, 280)
    : `${source.name} PDF 문헌`;
  const date = normalizeDate(
    extractDateText(contextText)
    || extractMediaDateFromUrl(url)
    || entry?.date
    || extractDateFromUrl(url)
    || contextText,
  );
  const body = [title, contextText].filter(Boolean).join(" ");

  return {
    id: `${source.id}-${hashUrl(url)}`,
    title,
    snippet,
    body,
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType: "pdf",
    url,
    archiveUrl: "",
    thumbnailUrl: entry?.thumbnailUrl || "",
    language: inferDocumentLanguage([title, snippet, body].filter(Boolean).join(" "), url, source),
    aliases: [cleanFileTitle(url)].filter((alias) => alias && alias !== title),
    searchTabs: source.searchTabs || [],
  };
}

export function enrichPdfDocumentWithReadableText(document, readableText, source = {}) {
  if (!document || !readableText) return document;
  const markdown = String(readableText).split(/Markdown Content:\s*/).slice(1).join("Markdown Content:") || readableText;
  const body = limitPdfBodyLength(cleanReadablePdfBodyText(markdown), source);
  if (body.length < 80) return document;
  const snippet = createPdfReadableSnippet(body, document.title) || document.snippet;
  return {
    ...document,
    snippet,
    body,
    language: inferDocumentLanguage([document.title, snippet, body].filter(Boolean).join(" "), document.url, source),
  };
}

function shouldFetchPdfReadableText(source = {}, entry = {}) {
  if (entry?.skipPdfTextFetch) return false;
  return source.crawler?.fetchPdfText === true;
}

function cleanReadablePdfBodyText(value = "") {
  return cleanReadableBodyText(value)
    .split(/\r?\n/)
    .map(cleanText)
    .filter(isUsefulPdfTextLine)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isUsefulPdfTextLine(line = "") {
  const text = cleanText(line);
  if (!text) return false;
  if (/^(?:Title|URL Source|Published Time|Number of Pages|Markdown Content):/i.test(text)) return false;
  if (/^[\d\s.,:;·∙-]+$/.test(text)) return false;
  const letters = (text.match(/[\p{L}가-힣]/gu) || []).length;
  const numbers = (text.match(/\p{N}/gu) || []).length;
  if (letters < 3 && text.length < 18) return false;
  if (numbers > letters * 2 && letters < 8) return false;
  return true;
}

function createPdfReadableSnippet(body = "", title = "") {
  const comparableTitle = normalizeComparableTitle(title);
  const lines = String(body || "")
    .split(/\r?\n/)
    .map(cleanText)
    .filter((line) => line.length >= 30 && normalizeComparableTitle(line) !== comparableTitle);
  return (lines[0] || cleanText(body)).slice(0, 280);
}

function limitPdfBodyLength(value = "", source = {}) {
  const configured = Number(source?.crawler?.maxPdfTextLength || source?.crawler?.maxBodyLength || 0);
  const text = String(value || "");
  if (!Number.isFinite(configured) || configured <= 0) return text;
  return text.length > configured ? text.slice(0, configured).trimEnd() : text;
}

export function extractMediaDocumentFromLink(entry, source) {
  const url = typeof entry === "string" ? entry : entry?.url;
  const mediaType = inferMediaAssetType(url, source);
  if (!url || !mediaType) return null;

  const rawContextText = cleanReadableText(entry?.contextText || "");
  const title = selectMediaDocumentTitle(entry, source, rawContextText, url);
  if (!title || isGenericTitle(title, source)) return null;

  const contextText = cleanMediaContextText(rawContextText);
  const snippet = contextText && contextText !== title
    ? contextText.slice(0, 280)
    : `${source.name} ${mediaType === "video" ? "동영상" : "이미지"} 자료`;
  const date = normalizeDate(
    extractMediaDateFromUrl(url)
    || entry?.date
    || extractDateText(contextText)
    || contextText,
  );
  const body = [title, contextText].filter(Boolean).join(" ");

  return {
    id: `${source.id}-${hashUrl(url)}`,
    title,
    snippet,
    body,
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType,
    url,
    archiveUrl: "",
    thumbnailUrl: url,
    language: inferDocumentLanguage([title, snippet, body].filter(Boolean).join(" "), url, source),
    aliases: createMediaDocumentAliases(title, contextText),
    searchTabs: getMediaSearchTabs(source, mediaType),
  };
}

export function extractArticleImageDocumentsFromContent(content, articleUrl, source, articleDocument) {
  if (!articleDocument || articleDocument.mediaType !== "article") return [];
  if (!Array.isArray(source.mediaTypes) || !source.mediaTypes.includes("image")) return [];

  const imageUrls = collectArticleImageUrls(content, articleUrl, source, articleDocument);
  if (!imageUrls.length) return [];

  const articleText = cleanReadableBodyText([
    articleDocument.title,
    articleDocument.snippet,
    articleDocument.body,
    "사진 이미지",
  ].filter(Boolean).join("\n"));
  const aliases = [
    ...(Array.isArray(articleDocument.aliases) ? articleDocument.aliases : []),
    ...createMediaDocumentAliases(articleDocument.title, articleDocument.body),
  ];

  return imageUrls.map((imageUrl, index) => {
    const title = imageUrls.length > 1
      ? `${articleDocument.title} (${index + 1}/${imageUrls.length})`
      : articleDocument.title;
    return {
      id: `${source.id}-${hashUrl(`${articleDocument.id || articleUrl}|image|${imageUrl}`)}`,
      title,
      snippet: articleDocument.snippet || articleDocument.title,
      body: articleText,
      date: articleDocument.date || normalizeDate(""),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.sourceType,
      mediaType: "image",
      url: imageUrl,
      archiveUrl: articleUrl,
      thumbnailUrl: imageUrl,
      language: articleDocument.language || inferDocumentLanguage(articleText, articleUrl, source),
      aliases: [...new Set(aliases.filter(Boolean))],
      searchTabs: getMediaSearchTabs(source, "image"),
    };
  });
}

function collectArticleImageUrls(content = "", articleUrl = "", source = {}, articleDocument = {}) {
  const candidates = [];
  if (articleDocument.thumbnailUrl) candidates.push(articleDocument.thumbnailUrl);

  if (isReadableCrawlerText(content)) {
    const markdown = getReadableMarkdownContent(content);
    candidates.push(...extractMarkdownImageUrls(markdown));
  } else {
    const $ = cheerio.load(String(content || ""));
    $("img").each((_, element) => {
      candidates.push(
        $(element).attr("src")
        || $(element).attr("data-src")
        || $(element).attr("data-lazy-src")
        || $(element).attr("data-original")
        || "",
      );
    });
    $("source[srcset]").each((_, element) => {
      candidates.push(extractPreferredSrcsetUrl($(element).attr("srcset") || ""));
    });
    $("meta[property='og:image'], meta[name='twitter:image']").each((_, element) => {
      candidates.push($(element).attr("content") || "");
    });
  }

  return [...new Set(candidates
    .map((url) => cleanImageUrlCandidate(url))
    .map((url) => stripHash(resolveUrl(url, articleUrl) || url))
    .filter((url) => isArticleImageAssetUrl(url, source)))];
}

function extractMarkdownImageUrls(markdown = "") {
  const urls = [];
  const pattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(String(markdown || "")))) {
    urls.push(match[1]);
  }
  return urls;
}

function extractPreferredSrcsetUrl(srcset = "") {
  return String(srcset || "")
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] || "")
    .find(Boolean) || "";
}

function cleanImageUrlCandidate(value = "") {
  const raw = cleanText(value).replace(/&amp;/g, "&").replace(/^["']+|["']+$/g, "");
  const variants = [];
  try {
    variants.push(decodeURIComponent(raw));
  } catch {
    variants.push(raw);
  }
  variants.push(raw);

  for (const variant of variants) {
    const urls = String(variant || "").match(/https?:\/{2,}[^"')\s]+/gi) || [];
    for (const url of urls) {
      const image = cleanAbsoluteImageUrl(url);
      if (image) return image;
    }
  }

  return raw;
}

function cleanAbsoluteImageUrl(url = "") {
  const imageMatch = String(url || "").match(/^(https?:\/{2,}.+?\.(?:png|jpe?g|webp))(?:[?#][^"')\s]*)?/i);
  if (!imageMatch) return "";
  const normalized = imageMatch[1].replace(/^(https?:)\/+/i, "$1//");
  try {
    const parsed = new URL(normalized);
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
    return parsed.href;
  } catch {
    return normalized;
  }
}

function isArticleImageAssetUrl(url, source) {
  if (!url || /^(?:blob|data|javascript):/i.test(String(url))) return false;
  if (isDecorativeImageAssetUrl(url)) return false;
  if ((source.crawler?.articleImageExcludeUrlPatterns || []).some((pattern) => urlMatchesPattern(url, pattern))) return false;
  return inferMediaAssetType(url, source) === "image";
}

function isDecorativeImageAssetUrl(url = "") {
  try {
    const fileName = path.basename(new URL(url).pathname).toLocaleLowerCase("en-US");
    return /^(?:back|prev|next|spacer|blank|loading|loader)(?:[-_](?:btn|button|icon))?\.(?:png|jpe?g|webp|gif)$/i.test(fileName);
  } catch {
    return false;
  }
}

function createMediaDocumentAliases(title = "", contextText = "") {
  const text = [title, contextText].filter(Boolean).join(" ");
  const aliases = [];
  if (/원산\s*갈마|원산갈마|Wonsan\s+Kalma/i.test(text)) {
    aliases.push("원산갈마해안관광지구", "Wonsan", "Kalma", "Wonsan Kalma", "Wonsan Kalma Coastal Tourist Area");
  }
  return [...new Set(aliases)];
}

function selectMediaDocumentTitle(entry = {}, source = {}, contextText = "", url = "") {
  const linkTitle = cleanDocumentTitle(cleanReadableTitle(entry?.linkText || ""));
  if (linkTitle && !isGenericMediaLinkTitle(linkTitle)) return linkTitle;

  const contextTitle = extractMediaTitleFromContext(contextText);
  if (contextTitle) return contextTitle;

  const fileTitle = cleanDocumentTitle(cleanReadableTitle(cleanFileTitle(url)));
  return isGenericMediaLinkTitle(fileTitle) ? "" : fileTitle;
}

function extractMediaTitleFromContext(contextText = "") {
  const text = cleanReadableText(contextText)
    .replace(/!?\[?\s*image(?:\s*\d+)?(?:\s*:\s*image)?\s*\]?/ig, " ")
    .trim();
  const datedTitle = text.match(/^(.+?)\s*\[\s*\d{4}[./-]\d{1,2}[./-]\d{1,2}\.?\s*\]/);
  return stripMediaSequenceSuffix(cleanDocumentTitle(cleanReadableTitle(datedTitle?.[1] || text)));
}

function cleanMediaContextText(contextText = "") {
  return cleanText(cleanReadableText(contextText)
    .replace(/!\[\s*/g, " ")
    .replace(/!?\[?\s*image(?:\s*\d+)?(?:\s*:\s*image)?\s*\]?/ig, " ")
    .replace(/\s*"+\s*$/g, " ")
    .trim());
}

function extractMediaDateFromUrl(url = "") {
  const filenameDate = String(url || "").match(/(?:^|\/)(20\d{2})[-_](\d{2})[-_](\d{2})[-_]\d+\.(?:png|jpe?g|webp)(?:$|[?#])/i);
  if (filenameDate) return `${filenameDate[1]}-${filenameDate[2]}-${filenameDate[3]}`;
  return extractDateFromUrl(url);
}

function stripMediaSequenceSuffix(title = "") {
  return cleanText(String(title || "").replace(/\s*\(\s*\d+\s*\/\s*\d+\s*\)\s*$/g, ""));
}

function isGenericMediaLinkTitle(title = "") {
  const normalized = cleanText(title).toLocaleLowerCase("en-US");
  const compact = normalized.replace(/^[![\]\s]+|[\]\s]+$/g, "");
  return !normalized
    || /^image(?:\s*\d+)?(?:\s*:\s*image)?$/.test(compact);
}

function getMediaSearchTabs(source = {}, mediaType = "") {
  if (Array.isArray(source.searchTabs) && source.searchTabs.length) return source.searchTabs;
  if (mediaType === "video" || mediaType === "broadcast") return ["all", "video"];
  if (mediaType === "image") return ["all", "image"];
  if (mediaType === "pdf") return ["all", "pdf"];
  return [];
}

export async function writeImportOutput({ documents, sources, reports, outputPath, sourcesPath, reportPath }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const merged = await mergeExistingOutputDocuments(documents, reports, outputPath);
  const preserved = await preserveFailedSourceDocuments(merged.documents, reports, outputPath);
  const shouldPreserveExistingDocuments = documents.length === 0
    && reportsHaveErrors(reports)
    && !hasFlag("--allow-empty-overwrite")
    && !hasFlag("--merge-existing-output")
    && await fileHasContent(outputPath);

  if (!shouldPreserveExistingDocuments) {
    const normalizedDocuments = dedupeDocuments(preserved.documents
      .map(normalizeCrawlerDocumentForStorage)
      .filter((document) => !isInvalidPreservedDocument(document)));
    await fs.writeFile(outputPath, stringifyJsonl(normalizedDocuments), "utf8");
  }
  if (sourcesPath) {
    await fs.mkdir(path.dirname(sourcesPath), { recursive: true });
    await fs.writeFile(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`, "utf8");
  }
  if (reportPath) {
    const mergedReports = await mergeExistingReportEntries(reports, reportPath);
    const preservedSourceIds = [...new Set([...merged.sourceIds, ...preserved.sourceIds])];
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify({
      preservedExistingDocuments: shouldPreserveExistingDocuments,
      preservedSourceIds: shouldPreserveExistingDocuments ? [] : preservedSourceIds,
      reports: mergedReports,
    }, null, 2)}\n`, "utf8");
  }
}

async function mergeExistingOutputDocuments(documents, reports = [], outputPath) {
  if (!hasFlag("--merge-existing-output") || !await fileHasContent(outputPath)) {
    return { documents, sourceIds: [] };
  }

  const refreshedSourceIds = new Set(reports.map((report) => report.sourceId).filter(Boolean));
  if (!refreshedSourceIds.size) return { documents, sourceIds: [] };

  const existingDocuments = parseJsonl(await fs.readFile(outputPath, "utf8"));
  const existingBySourceId = groupDocumentsBySourceId(existingDocuments);
  const incomingBySourceId = groupDocumentsBySourceId(documents);
  const mergedDocuments = existingDocuments.filter((document) => !refreshedSourceIds.has(document.sourceId));
  const preservedShrinkSourceIds = [];

  for (const sourceId of refreshedSourceIds) {
    const existingForSource = filterInvalidPreservedDocuments(existingBySourceId.get(sourceId) || []);
    const incomingForSource = filterInvalidPreservedDocuments(incomingBySourceId.get(sourceId) || []);
    const shouldPreserveExisting = !hasFlag("--allow-shrink-source")
      && incomingForSource.length > 0
      && existingForSource.length > incomingForSource.length;

    if (shouldPreserveExisting) {
      mergedDocuments.push(...incomingForSource, ...existingForSource);
      preservedShrinkSourceIds.push(sourceId);
    } else {
      mergedDocuments.push(...incomingForSource);
    }
  }

  return {
    documents: dedupeDocuments(mergedDocuments),
    sourceIds: preservedShrinkSourceIds,
  };
}

function groupDocumentsBySourceId(documents = []) {
  const grouped = new Map();
  for (const document of documents) {
    const sourceId = document.sourceId || "";
    if (!sourceId) continue;
    if (!grouped.has(sourceId)) grouped.set(sourceId, []);
    grouped.get(sourceId).push(document);
  }
  return grouped;
}

function filterInvalidPreservedDocuments(documents = []) {
  return documents.filter((document) => !isInvalidPreservedDocument(document));
}

function isInvalidPreservedDocument(document = {}) {
  if (FORBIDDEN_MANUAL_WONSAN_BACKFILL_IDS.has(document.id)) return true;
  if (document.mediaType === "image" && isDecorativeImageAssetUrl(document.url)) return true;
  if (document.sourceId === "kim-il-sung-university" && /\/univ\/images\/home\//i.test(String(document.url || ""))) return true;
  if (
    document.sourceId === "korean-stamp"
    && /^details?(?:\s|\[|$)/i.test(cleanText(document.title || ""))
    && /^details?(?:\s|\[|$)/i.test(selectSourceSpecificReadableTitle(document.title, document.body, { id: "korean-stamp" }))
  ) return true;
  return document.sourceId === "kcna"
    && (isGenericKcnaTitle(document.title) || isKcnaCategoryListingDocument(document));
}

function isKcnaCategoryListingDocument(document = {}) {
  const url = String(document.url || "");
  if (!/\/(?:kp|en|jp|cn|ru|sp|es)\/category\/articles\/q\//i.test(url)) return false;
  return !/^kcna-wonsan-kalma/i.test(String(document.id || ""));
}

async function mergeExistingReportEntries(reports = [], reportPath) {
  if (!hasFlag("--merge-existing-output") || !reportPath || !await fileHasContent(reportPath)) return reports;

  let existingReports = [];
  try {
    const parsed = JSON.parse(await fs.readFile(reportPath, "utf8"));
    existingReports = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.reports) ? parsed.reports : []);
  } catch {
    return reports;
  }

  const refreshedSourceIds = new Set(reports.map((report) => report.sourceId).filter(Boolean));
  return [
    ...existingReports.filter((report) => !refreshedSourceIds.has(report.sourceId)),
    ...reports,
  ];
}

export function stripRuntimeSourceConfig(source) {
  return {
    id: source.id,
    name: source.name,
    sourceType: source.sourceType,
    baseUrl: source.baseUrl,
    languages: source.languages || [],
    mediaTypes: source.mediaTypes || [],
    searchTabs: source.searchTabs || [],
    aliases: source.aliases || [],
  };
}

export function parseImporterOptions(defaultOutputName) {
  const defaultReportName = defaultOutputName
    .replace(/\.documents\.jsonl$/i, ".report.json")
    .replace(/\.jsonl$/i, ".report.json");
  const maxLinksArgument = getArgumentValue("--max-links-per-source") || getArgumentValue("--max-links");
  return {
    limitPerSource: Number(getArgumentValue("--limit") || 80),
    concurrency: Number(getArgumentValue("--concurrency") || 4),
    timeoutMs: Number(getArgumentValue("--timeout-ms") || 15000),
    maxSourceMs: Number(getArgumentValue("--max-source-ms") || 180000),
    maxLinksPerSource: Number(maxLinksArgument || 400),
    maxDiscoveryPages: Number(getArgumentValue("--max-discovery-pages") || 60),
    maxDetailFetchesPerSource: Number(getArgumentValue("--max-detail-fetches-per-source") || 0),
    maxPdfTextFetchesPerSource: Number(getArgumentValue("--max-pdf-text-fetches-per-source") || 0),
    requestDelayMs: Number(getArgumentValue("--request-delay-ms") || 0),
    discoveryReserveMs: Number(getArgumentValue("--discovery-reserve-ms") || 0),
    limitPerSourceExplicit: hasArgument("--limit"),
    timeoutMsExplicit: hasArgument("--timeout-ms"),
    maxSourceMsExplicit: hasArgument("--max-source-ms"),
    maxLinksPerSourceExplicit: hasArgument("--max-links-per-source") || hasArgument("--max-links"),
    maxDiscoveryPagesExplicit: hasArgument("--max-discovery-pages"),
    maxDetailFetchesPerSourceExplicit: hasArgument("--max-detail-fetches-per-source"),
    maxPdfTextFetchesPerSourceExplicit: hasArgument("--max-pdf-text-fetches-per-source"),
    requestDelayMsExplicit: hasArgument("--request-delay-ms"),
    discoveryReserveMsExplicit: hasArgument("--discovery-reserve-ms"),
    allowReadableFallback: !hasFlag("--no-readable-fallback"),
    useFetchCache: !hasFlag("--no-fetch-cache"),
    cacheDir: path.resolve(getArgumentValue("--cache-dir") || DEFAULT_FETCH_CACHE_DIR),
    retries: Number(getArgumentValue("--retries") || 1),
    proxyUrl: getConfiguredProxyUrl(),
    sourceIds: getArgumentValue("--source") || getArgumentValue("--sources"),
    outputPath: path.resolve(getArgumentValue("--out") || path.join(DEFAULT_IMPORT_DIR, defaultOutputName)),
    sourcesPath: getArgumentValue("--sources-out") ? path.resolve(getArgumentValue("--sources-out")) : "",
    reportPath: path.resolve(getArgumentValue("--report") || path.join(DEFAULT_IMPORT_DIR, defaultReportName)),
  };
}

export function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function fileHasContent(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.size > 0;
  } catch {
    return false;
  }
}

function reportsHaveErrors(reports = []) {
  return reports.some((report) => Array.isArray(report.errors) && report.errors.length > 0);
}

async function readCachedTextResource(url, { cacheDir = DEFAULT_FETCH_CACHE_DIR, cacheNamespace = "http" } = {}) {
  try {
    const { textPath } = getCachePaths(url, { cacheDir, cacheNamespace });
    const text = await fs.readFile(textPath, "utf8");
    return text || "";
  } catch {
    return "";
  }
}

async function writeCachedTextResource(url, text, {
  cacheDir = DEFAULT_FETCH_CACHE_DIR,
  cacheNamespace = "http",
  accept = "*/*",
} = {}) {
  try {
    const { directory, textPath, metaPath } = getCachePaths(url, { cacheDir, cacheNamespace });
    await fs.mkdir(directory, { recursive: true });
    await Promise.all([
      fs.writeFile(textPath, text, "utf8"),
      fs.writeFile(metaPath, `${JSON.stringify({
        url,
        accept,
        fetchedAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8"),
    ]);
  } catch {
    // Cache writes are best effort; a failed cache must never block indexing.
  }
}

function getCachePaths(url, { cacheDir = DEFAULT_FETCH_CACHE_DIR, cacheNamespace = "http" } = {}) {
  const safeNamespace = String(cacheNamespace || "http").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "http";
  const key = hashUrl(url);
  const directory = path.join(cacheDir, safeNamespace);
  return {
    directory,
    textPath: path.join(directory, `${key}.txt`),
    metaPath: path.join(directory, `${key}.json`),
  };
}

function isRetryableFetchError(error) {
  const message = String(error?.message || error || "");
  return /HTTP (429|5\d\d)\b/.test(message)
    || /fetch failed|aborted|timeout|network/i.test(message)
    || error?.name === "AbortError";
}

function getRetryDelayMs(attempt) {
  return 350 * (attempt + 1);
}

function createRequestThrottle(delayMs = 0) {
  const delay = Math.max(0, Number(delayMs) || 0);
  let chain = Promise.resolve();
  let lastRequestAt = 0;

  return {
    wait() {
      if (!delay) return Promise.resolve();
      const waitPromise = chain.then(async () => {
        const elapsed = Date.now() - lastRequestAt;
        const waitMs = Math.max(0, delay - elapsed);
        if (waitMs) await sleep(waitMs);
        lastRequestAt = Date.now();
      });
      chain = waitPromise.catch(() => {});
      return waitPromise;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function preserveFailedSourceDocuments(documents, reports = [], outputPath) {
  if (hasFlag("--allow-empty-overwrite") || !await fileHasContent(outputPath)) {
    return { documents, sourceIds: [] };
  }

  const currentDocumentsBySourceId = groupDocumentsBySourceId(documents);
  const existingDocumentsBySourceId = groupDocumentsBySourceId(parseJsonl(await fs.readFile(outputPath, "utf8")));
  const shouldAllowShrink = hasFlag("--allow-shrink-source");
  const failedSourceIds = reports
    .filter((report) => report?.preserveOnFailure !== false)
    .filter((report) => Boolean(report?.timedOut) || (Array.isArray(report?.errors) && report.errors.length > 0))
    .map((report) => report.sourceId)
    .filter((sourceId) => {
      if (!sourceId) return false;
      const existingCount = (existingDocumentsBySourceId.get(sourceId) || []).length;
      if (!existingCount) return false;
      const currentCount = (currentDocumentsBySourceId.get(sourceId) || []).length;
      return currentCount === 0 || (!shouldAllowShrink && currentCount < existingCount);
    });

  if (!failedSourceIds.length) return { documents, sourceIds: [] };

  const failedSourceIdSet = new Set(failedSourceIds);
  const existingDocuments = [...existingDocumentsBySourceId.values()]
    .flat()
    .filter((document) => failedSourceIdSet.has(document.sourceId));
  if (!existingDocuments.length) return { documents, sourceIds: [] };

  return {
    documents: dedupeDocuments([...documents, ...existingDocuments]),
    sourceIds: [...new Set(existingDocuments.map((document) => document.sourceId))],
  };
}

function reportDiscoveryFetch(report) {
  if (!report) return;
  report.discoveryFetched = (report.discoveryFetched || 0) + 1;
}

function reportSitemapFetch(report) {
  if (!report) return;
  report.sitemapFetched = (report.sitemapFetched || 0) + 1;
}

function reportSearchFetch(report) {
  if (!report) return;
  report.searchFetched = (report.searchFetched || 0) + 1;
}

function reportApiFetch(report) {
  if (!report) return;
  report.apiFetched = (report.apiFetched || 0) + 1;
}

function selectFetchedOrFallbackDocument(document, fallbackDocument) {
  if (!fallbackDocument) return document;
  if (!document) return fallbackDocument;

  const body = cleanText(document.body || "");
  const fallbackBody = cleanText(fallbackDocument.body || "");
  const paywallPattern = /この記事の続きを読む|有料プラン|로그인 폼|신규회원등록|パスワードをお忘れですか|Login/;
  const rodongChromePattern = /(?:^|\n)(?:오늘호 기사|검색 혁명활동소식|인민을 위한 정치|전진하는 조선|사회문화생활|유구한 력사)(?:\n|$)/;
  if (paywallPattern.test(body) && fallbackBody.length > 40) return fallbackDocument;
  if (rodongChromePattern.test(body) && fallbackBody.length > 20) return fallbackDocument;
  if (isVoiceOfKoreaChromeText(body)) return fallbackDocument;
  if (body.length < Math.max(80, fallbackBody.length * 0.8) && fallbackBody.length > body.length) {
    return fallbackDocument;
  }
  return document;
}

function selectFirstText($, selector) {
  if (!selector) return "";
  return $(selector).first().text();
}

function selectFirstBodyText($, selector) {
  if (!selector) return "";
  return preserveHtmlBlockText($(selector).first());
}

function preserveHtmlBlockText(selection) {
  if (!selection?.length) return "";
  const html = String(selection.html() || "");
  if (!html) return selection.text();
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|article|section|li|tr|h[1-6]|blockquote)>/gi, "\n\n");
  return cheerio.load(`<body>${withBreaks}</body>`).text();
}

function removeNoise($) {
  $("script, style, noscript, svg, iframe, nav, footer, header").remove();
}

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function cleanDocumentTitle(value = "") {
  return cleanText(value)
    .replace(/^!\[\s*/, "")
    .replace(/\]\s*$/, "")
    .replace(/\s*[\[(（]\s*\d{4}\s*[./년-]\s*\d{1,2}\s*[./월-]\s*\d{1,2}\s*일?\s*[\])）]\s*$/u, "")
    .trim();
}

function selectSourceSpecificReadableTitle(title = "", body = "", source = {}) {
  if (source.id !== "korean-stamp" || !/^details?(?:\s|\[|$)/i.test(cleanText(title))) return title;
  const candidate = String(body || "")
    .split(/\r?\n/)
    .map(cleanReadableText)
    .find((line) => line.length >= 8
      && !/^\d+\s*\/\s*\d+$/.test(line)
      && !/^(?:poster|songs?|stamp|postal stationery)$/i.test(line)
      && !/^details?(?:\s|\[|$)/i.test(line)
      && !/\.(?:png|jpe?g|webp)$/i.test(line)
      && !/^(?:date of issue|stock no|size|denomination|sheet composition|copyright)\b/i.test(line)
      && !/copyright\s*[©(]/i.test(line));
  return cleanDocumentTitle(candidate || title);
}

function cleanBodyText(value = "") {
  return truncateAtArticleAccessBoundary(String(value || ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map(cleanText)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanReadableText(value = "") {
  return cleanText(String(value)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\bKCNA Watch Logo\b/gi, " ")
    .replace(/\bBrowse\b/gi, " ")
    .replace(/(^|\s)\/\s*(?=(?:혁명활동소식|분야별기사|정치|경제|문화|국제|기사)(?:\s|$))/g, " ")
    .replace(/[*_`>#-]+/g, " ")
    .replace(/\bImage\s+\d+:\s*/gi, "")
    .replace(/\bImage\s+\d+\s*/gi, ""));
}

function cleanReadableBodyText(value = "") {
  return truncateAtArticleAccessBoundary(String(value || ""))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanReadableText)
    .filter((line) => line && !isReadableArticleNoiseLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateAtArticleAccessBoundary(value = "") {
  const marker = String(value || "").search(/この記事の続きを読むには|有料プラン|로그인 폼|パスワードをお忘れですか|신규회원등록/);
  return marker >= 0 ? String(value || "").slice(0, marker) : String(value || "");
}

function getMinimumDocumentBodyLength(source = {}, fallback = 20) {
  const configured = Number(source?.crawler?.minBodyLength || 0);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

function limitDocumentBodyLength(value = "", source = {}) {
  const configured = Number(source?.crawler?.maxBodyLength || 0);
  if (!Number.isFinite(configured) || configured <= 0) return value;
  const text = String(value || "");
  return text.length > configured ? text.slice(0, configured).trimEnd() : text;
}

function inferDocumentLanguage(text = "", url = "", source = {}) {
  const urlLanguage = inferLanguageFromUrl(url);
  if (urlLanguage) return urlLanguage;

  const value = String(text || "");
  const hasHangul = /[가-힣]/.test(value);
  const hasKana = /[\u3040-\u30ff]/.test(value);
  const hasHan = /[\u3400-\u9fff]/.test(value);
  const hasCyrillic = /[\u0400-\u04ff]/.test(value);
  const hasArabic = /[\u0600-\u06ff]/.test(value);
  const hasLatin = /[a-z]/i.test(value);

  const detected = [];
  if (hasHangul) detected.push("ko");
  if (hasKana) detected.push("ja");
  if (hasHan && !hasHangul && !hasKana) detected.push("zh");
  if (hasCyrillic) detected.push("ru");
  if (hasArabic) detected.push("ar");
  if (hasLatin) detected.push("en");
  if (detected.length === 1) return detected[0];
  if (detected.length > 1) return "multi";
  return source.languages?.[0] || "unknown";
}

function inferLanguageFromUrl(value = "") {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").map((segment) => segment.toLocaleLowerCase("en-US")).filter(Boolean);
    const languageSegment = segments.find((segment) => LANGUAGE_PATH_MAP[segment]);
    return languageSegment ? LANGUAGE_PATH_MAP[languageSegment] : "";
  } catch {
    return "";
  }
}

const LANGUAGE_PATH_MAP = Object.freeze({
  ko: "ko",
  kp: "ko",
  kr: "ko",
  en: "en",
  eng: "en",
  ja: "ja",
  jp: "ja",
  jpn: "ja",
  zh: "zh",
  ch: "zh",
  cn: "zh",
  chi: "zh",
  ru: "ru",
  rus: "ru",
  es: "es",
  sp: "es",
  spa: "es",
  fr: "fr",
  fra: "fr",
  de: "de",
  ge: "de",
  ger: "de",
  ar: "ar",
});

function cleanReadableTitle(value = "") {
  return cleanReadableText(value)
    .replace(/\s*\|\s*[^|]+$/g, "")
    .replace(/\s+\d{1,2}월\s*\d{1,2}일\s*\d{1,2}:\d{2}$/g, "")
    .replace(/\s+\d{4}[./-]\d{1,2}[./-]\d{1,2}\.?\s*$/g, "")
    .trim();
}

function getReadableMarkdownContent(text = "") {
  return String(text).split(/Markdown Content:\s*/).slice(1).join("Markdown Content:") || String(text || "");
}

function extractJsonArrayText(value = "") {
  const text = String(value || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (text.startsWith("[")) return text;

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

function parseJsonArrayCandidate(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch {
    return JSON.parse(escapeControlCharactersInJsonStrings(jsonText));
  }
}

function escapeControlCharactersInJsonStrings(jsonText = "") {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (const char of String(jsonText || "")) {
    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      repaired += char;
      continue;
    }
    if (inString && char === "\n") {
      repaired += "\\n";
      continue;
    }
    if (inString && char === "\r") {
      repaired += "\\r";
      continue;
    }
    if (inString && char === "\t") {
      repaired += "\\t";
      continue;
    }
    repaired += char;
  }

  return repaired;
}

function getWordPressFieldValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.rendered === "string") return value.rendered;
  if (typeof value.raw === "string") return value.raw;
  return "";
}

function extractWordPressFeaturedImageUrl(post) {
  const media = post?._embedded?.["wp:featuredmedia"]?.[0];
  const sourceUrl = media?.source_url
    || media?.media_details?.sizes?.large?.source_url
    || media?.media_details?.sizes?.medium?.source_url
    || media?.media_details?.sizes?.thumbnail?.source_url
    || "";
  return sourceUrl ? stripHash(resolveUrl(sourceUrl, post?.link || "") || sourceUrl) : "";
}

function extractMarkdownImageUrl(line = "") {
  const match = String(line || "").match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
  return match ? match[1] : "";
}

function extractNearestPreviousMarkdownImageUrl(line = "", offset = 0) {
  const imagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const text = String(line || "").slice(0, Math.max(0, Number(offset) || 0));
  let imageUrl = "";
  let match;
  while ((match = imagePattern.exec(text))) {
    if (isDecorativeKoreanBooksImageUrl(match[1])) continue;
    imageUrl = match[1];
  }
  return imageUrl;
}

function isDecorativeKoreanBooksImageUrl(url = "") {
  return /\/assets\/images\/(?:download|memoirs|contact|portal|korea|kumsu|trade|computer|first|btn|logo)[^/]*\.(?:gif|png|jpe?g|webp)$/i.test(String(url || ""));
}

function findPreviousMarkdownImageUrl(lines = [], startIndex = 0) {
  for (let index = startIndex - 1; index >= 0 && index >= startIndex - 3; index -= 1) {
    const imageUrl = extractMarkdownImageUrl(lines[index] || "");
    if (imageUrl) return imageUrl;
    if (cleanReadableText(lines[index] || "")) break;
  }
  return "";
}

function appendSearchParam(template, key, value) {
  try {
    const url = new URL(template);
    url.searchParams.set(key, value);
    return url.href;
  } catch {
    const separator = String(template || "").includes("?") ? "&" : "?";
    return `${template}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

function isIndexableNaenaraTitle(title = "") {
  const text = cleanReadableTitle(title);
  if (text.length < 4) return false;
  if (/^(전체보기|목소리|정치|경제|교육|보건|문학예술|과학|자연환경|체육|생활\/음식문화|력사|관광|국제|해외동포|적십자|Search|번호|기사제목)$/i.test(text)) {
    return false;
  }
  if (/^(첫페지|소식, 기사|조선개관|사회문화|사 진|동영상|음 악|우표|선전화|미술)$/.test(text)) {
    return false;
  }
  return true;
}

function collectMarkdownLinkContext(lines, startIndex, linkText = "") {
  const parts = [];
  const title = cleanReadableText(linkText);
  if (title) parts.push(title);

  for (let index = startIndex + 1; index < lines.length && index <= startIndex + 8; index += 1) {
    const rawLine = String(lines[index] || "");
    if (isMarkdownCardBoundary(rawLine)) break;
    const text = cleanReadableText(rawLine);
    if (!text) continue;
    parts.push(text);
    if (parts.length >= 5) break;
  }

  return cleanText(parts.join(" "));
}

function collectKoreanBooksMarkdownPdfContext(line = "", match = null) {
  const title = cleanReadableText(match?.[1] || "");
  const afterStart = Number(match?.index || 0) + String(match?.[0] || "").length;
  const afterText = String(line || "").slice(afterStart);
  const nextImageIndex = afterText.search(/!\[[^\]]*\]\(/);
  const nextPdfIndex = afterText.search(/\[[^\]]+\]\([^)]*\.pdf(?:[?#][^)]*)?\)/i);
  const boundaryIndexes = [nextImageIndex, nextPdfIndex].filter((index) => index >= 0);
  const boundaryIndex = boundaryIndexes.length ? Math.min(...boundaryIndexes) : afterText.length;
  const metadata = cleanReadableText(afterText.slice(0, boundaryIndex));
  return cleanText([title, metadata].filter(Boolean).join(" "));
}

function isMarkdownCardBoundary(line = "") {
  const text = String(line || "").trim();
  if (!text) return false;
  return /^#{1,6}\s+\[/.test(text)
    || /^\[!\[/.test(text)
    || /^!\[/.test(text)
    || /^-{3,}$/.test(text);
}

function shouldUseReadableContextAsBody(readableTitle, source, contextText) {
  if (!contextText || contextText.length < 20) return false;
  const title = cleanText(readableTitle);
  return isGenericTitle(title, source) || isListingReadableTitle(title, source);
}

function isListingReadableTitle(title, source) {
  const normalized = cleanText(title).toLocaleLowerCase("en-US");
  return normalized.includes("newstream")
    || normalized.includes("archive")
    || normalized.includes("category")
    || normalized.includes("latest")
    || normalized.includes("feed");
}

function isReadableListingMarkdown(markdown = "") {
  const text = String(markdown || "");
  if (/^#{2,6}\s+\[[^\]]+\]\([^)]+\)/m.test(text)) return true;
  const links = text.match(/\[[^\]]+\]\([^)]+\)/g) || [];
  return links.length >= 3;
}

function extractReadableArticleBody(markdown, title) {
  const normalizedTitle = normalizeComparableTitle(title);
  if (!normalizedTitle) return "";

  const lines = String(markdown || "").split(/\r?\n/);
  let headingIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^#{1,6}\s+/.test(String(line || "").trim())) continue;
    const comparable = normalizeComparableTitle(cleanReadableText(line));
    if (comparable.includes(normalizedTitle) || normalizedTitle.includes(comparable)) {
      headingIndex = index;
    }
  }
  if (headingIndex < 0) return "";

  const parts = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const rawLine = String(lines[index] || "");
    if (isReadableArticleEndBoundary(rawLine, parts.length)) break;
    if (!rawLine.trim()) {
      if (parts.length && parts[parts.length - 1] !== "") parts.push("");
      continue;
    }
    const text = cleanReadableText(rawLine);
    if (!text || isReadableArticleNoiseLine(text)) continue;
    parts.push(text);
  }

  const body = cleanBodyText(parts.join("\n"));
  return body.length >= 20 ? body : "";
}

function normalizeComparableTitle(value = "") {
  return cleanReadableText(value)
    .replace(/\s*\|\s*[^|]+$/g, "")
    .replace(/\d{1,2}월\s*\d{1,2}일\s*\d{1,2}:\d{2}/g, "")
    .replace(/\d{4}[./-]\d{1,2}[./-]\d{1,2}\.?/g, "")
    .replace(/\s+/g, "")
    .toLocaleLowerCase("ko-KR");
}

function isReadableArticleEndBoundary(line = "", collectedCount = 0) {
  const text = String(line || "").trim();
  if (!text) return false;
  if (collectedCount === 0) return false;
  return /^#{2,6}\s+/.test(text)
    || /^(많이 본 기사|관련기사|関連記事|최근 기사|최신 기사|공유|태그)\b/i.test(cleanReadableText(text));
}

function isReadableArticleNoiseLine(text = "") {
  return /^(메뉴|공식아카운트|검색|Today|[0-9]{4}年\s*\d{2}月\d{2}日)/i.test(text)
    || /^Copyright @ \d{4} by The Rodong Sinmun/i.test(text)
    || /^All rights reserved\.?$/i.test(text)
    || /^(첫페지|총련|오피니온|사회|민족교육|문화・력사|체육|동영상|日本語|조선어|혁명활동소식|분야별기사|정치|경제|문화|국제|기사)$/.test(text);
}

function createReadableSnippet(markdown, title) {
  const comparableTitle = normalizeComparableTitle(title);
  const lines = String(markdown || "")
    .split(/\r?\n/)
    .map(cleanReadableText)
    .filter((line) => line
      && normalizeComparableTitle(line) !== comparableTitle
      && !isReadableArticleNoiseLine(line)
      && !/^URL Source:/i.test(line));
  return cleanText(lines.find((line) => line.length >= 30) || lines[0] || "").slice(0, 280);
}

function stripHtml(value = "") {
  return preserveHtmlBlockText(cheerio.load(`<body>${value}</body>`)("body"));
}

function normalizeDate(value = "") {
  const text = String(value || "");
  const iso = text.match(/(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/);
  if (iso) {
    const date = formatValidDateParts(iso[1], iso[2], iso[3]);
    if (date) return date;
  }

  const koreanYear = text.match(/\(?(\d{4})\)?\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (koreanYear) {
    const date = formatValidDateParts(koreanYear[1], koreanYear[2], koreanYear[3]);
    if (date) return date;
  }

  const englishMonth = parseEnglishMonthDate(text);
  if (englishMonth) return englishMonth;

  const monthDayYear = text.match(/\b(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*((?:19|20)\d{2})\b/);
  if (monthDayYear) {
    const date = formatValidDateParts(monthDayYear[3], monthDayYear[1], monthDayYear[2]);
    if (date) return date;
  }

  const dayMonthYear = text.match(/\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/);
  if (dayMonthYear) {
    const date = formatValidDateParts(dayMonthYear[3], dayMonthYear[2], dayMonthYear[1]);
    if (date) return date;
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function normalizeCrawledDate(value = "", source = {}) {
  if (["kcna", "rodong-sinmun"].includes(source.id) && !extractDateText(value)) return "";
  const date = normalizeDate(value);
  const today = new Date().toISOString().slice(0, 10);
  if (source.crawler?.futureDatePolicy === "crawl-date" && date > today) return today;
  return date;
}

function formatValidDateParts(year, month, day) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  const parsedDay = Number(day);
  if (!Number.isInteger(parsedYear) || parsedYear < 1900 || parsedYear > 2100) return "";
  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) return "";
  const daysInMonth = new Date(Date.UTC(parsedYear, parsedMonth, 0)).getUTCDate();
  if (!Number.isInteger(parsedDay) || parsedDay < 1 || parsedDay > daysInMonth) return "";
  return `${String(parsedYear).padStart(4, "0")}-${String(parsedMonth).padStart(2, "0")}-${String(parsedDay).padStart(2, "0")}`;
}

function extractDateText(value = "") {
  const text = String(value || "");
  return text.match(/\d{4}[-./년\s]+\d{1,2}[-./월\s]+\d{1,2}(?!\d)/)?.[0]
    || text.match(/\(?\d{4}\)?\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/)?.[0]
    || text.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember|t)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i)?.[0]
    || text.match(/\b\d{1,2}\s*\.\s*\d{1,2}\s*\.\s*(?:19|20)\d{2}\b/)?.[0]
    || text.match(/\b\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\b/)?.[0]
    || text.match(/\b[A-Z][a-z]{2},\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\b/)?.[0]
    || "";
}

function extractKoreanDatelineDate(value = "", fallbackValue = "") {
  const text = String(value || "");
  const dateline = text.match(/[（(【]\s*[^）)】\n]{0,120}?(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*발\s*조선중앙통신[^）)】\n]{0,40}[）)】]/u)
    || text.match(/(?:평양|[가-힣]{2,12})\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*발\s*조선중앙통신/u);
  if (!dateline) return "";

  const year = extractYearText(fallbackValue) || extractYearText(text) || String(new Date().getFullYear());
  return `${year}-${dateline[1].padStart(2, "0")}-${dateline[2].padStart(2, "0")}`;
}

function extractYearText(value = "") {
  return String(value || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
}

function parseEnglishMonthDate(text = "") {
  const monthNames = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const monthFirst = String(text || "").match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember|t)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s+(\d{4})\b/i);
  if (monthFirst) {
    const month = monthNames[monthFirst[1].toLocaleLowerCase("en-US")];
    if (month) return formatValidDateParts(monthFirst[3], month, monthFirst[2]);
  }

  const dayFirst = String(text || "").match(/\b(?:[A-Z][a-z]{2},\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})\b/i);
  if (dayFirst) {
    const month = monthNames[dayFirst[2].toLocaleLowerCase("en-US")];
    if (month) return formatValidDateParts(dayFirst[3], month, dayFirst[1]);
  }

  return "";
}

function extractDateFromUrl(url = "") {
  const match = String(url || "").match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const filenameTimestamp = String(url || "").match(/\/(20\d{2})(\d{2})(\d{2})\d{4,8}\.pdf(?:$|[?#])/i);
  if (filenameTimestamp) return `${filenameTimestamp[1]}-${filenameTimestamp[2]}-${filenameTimestamp[3]}`;
  try {
    const encoded = new URL(url).search.slice(1);
    const decoded = Buffer.from(encoded, "base64").toString();
    const rodongDate = decoded.match(/(20\d{2})-(\d{2})-(\d{2})-\d{3}/);
    return rodongDate ? `${rodongDate[1]}-${rodongDate[2]}-${rodongDate[3]}` : "";
  } catch {
    return "";
  }
}

function decodeHtmlResponse(bytes, contentType = "") {
  const encoding = detectHtmlEncoding(bytes, contentType);
  return decodeBytes(bytes, encoding).replace(/\u0000/g, "");
}

function detectHtmlEncoding(bytes, contentType = "") {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (looksLikeUtf16Le(bytes)) return "utf-16le";

  const contentTypeCharset = extractCharset(contentType);
  if (contentTypeCharset) return contentTypeCharset;

  const utf8Head = decodeBytes(bytes.slice(0, 4096), "utf-8");
  const metaCharset = extractCharset(utf8Head);
  return metaCharset || "utf-8";
}

function decodeBytes(bytes, encoding) {
  try {
    return new TextDecoder(normalizeEncoding(encoding), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function extractCharset(text = "") {
  const match = String(text).match(/charset=["']?\s*([^"'>;\s]+)/i);
  return match ? normalizeEncoding(match[1]) : "";
}

function normalizeEncoding(encoding = "") {
  const normalized = String(encoding).trim().toLocaleLowerCase("en-US");
  if (!normalized) return "";
  if (normalized === "utf8") return "utf-8";
  if (normalized === "ks_c_5601-1987" || normalized === "ks_c_5601" || normalized === "cp949") return "windows-949";
  if (normalized === "x-windows-949") return "windows-949";
  return normalized;
}

function looksLikeUtf16Le(bytes) {
  const sampleLength = Math.min(bytes.length, 1200);
  if (sampleLength < 16) return false;
  let oddNulls = 0;
  let evenNulls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
  }
  return oddNulls / sampleLength > 0.2 && oddNulls > evenNulls * 3;
}

function isBlockedHtml(html = "") {
  const text = cleanText(html).toLocaleLowerCase("en-US");
  if (!text) return true;
  return text.includes('name="kcsc" content="blocking"')
    || text.includes("kcsc blocking")
    || text.includes("access denied")
    || text.includes("checking your browser")
    || text.includes("enable javascript and cookies")
    || text.includes("403 forbidden");
}

function isReadableCrawlerText(text = "") {
  const value = String(text || "");
  return /^Title:\s+/m.test(value) && /^URL Source:\s+/m.test(value) && /Markdown Content:/m.test(value);
}

function extractSourceSpecificDocument($, url, source) {
  if (source.id === "rodong-sinmun") return extractRodongDocument($, url, source);
  if (source.id === "minju-choson") return extractMinjuDocument($, url);
  return {};
}

function extractRodongDocument($, url, source) {
  let title = cleanText(
    $(".TitleP").first().text()
    || $("meta[property='og:title']").attr("content")
    || $("h1, h2, h3").first().text()
    || $("title").text(),
  );
  title = cleanReadableTitle(title.replace(/\s*-\s*로동신문.*$/i, ""));
  const paragraphs = $(".TextP")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean);
  const writer = cleanText($(".WriterP").first().text());
  const structuredBody = [...paragraphs, writer].filter(Boolean).join("\n\n");
  const pageText = cleanText($("body").text());
  const explicitDateText = extractDateText($("#article-homepage").first().text() || pageText)
    || extractDateFromUrl(url);
  const date = explicitDateText ? normalizeDate(explicitDateText) : "";
  const titleIndex = title ? pageText.indexOf(title) : -1;
  const focusedText = titleIndex >= 0
    ? pageText.slice(
      titleIndex,
      findRodongBodyBoundary(pageText, titleIndex + title.length, source.crawler?.maxBodyLength),
    )
    : title;
  const body = structuredBody || cleanText(focusedText);
  const snippet = [title, date ? `[${date}]` : ""].filter(Boolean).join(" ");

  if (!title || isGenericTitle(title, source)) return {};
  return {
    title,
    snippet: snippet || body,
    date,
    body: body || [title, snippet].filter(Boolean).join(" "),
  };
}

function findRodongBodyBoundary(text = "", startIndex = 0, maxBodyLength = 14000) {
  const boundaries = [
    "오늘호 기사",
    "인민을 위한 정치",
    "전진하는 조선",
    "사회문화생활",
    "유구한 력사",
    "Copyright @",
  ]
    .map((boundary) => text.indexOf(boundary, startIndex))
    .filter((index) => index > startIndex);
  const configuredLimit = Number(maxBodyLength);
  const safeLimit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 14000;
  return boundaries.length ? Math.min(...boundaries) : Math.min(text.length, startIndex + safeLimit);
}

function extractMinjuDocument($, url) {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return {};
  }
  if (!/\/Home\/index\/disp\/\d+\/ko/i.test(pathname)) return {};

  const candidates = [
    pathname,
    pathname.toLocaleLowerCase("en-US"),
    pathname.replace(/^\/Home/i, "/home"),
  ];
  let anchor = null;
  for (const href of candidates) {
    anchor = $(`a[href="${href}"]`).first();
    if (anchor.length) break;
  }
  if (!anchor?.length) return {};

  const title = cleanText(anchor.text());
  const rowText = cleanText(anchor.closest("tr, article, li, .card, .row, .col-md-12, .col-sm-12, div").first().text());
  const date = rowText.match(/\[(\d{4}[./-]\d{1,2}[./-]\d{1,2})\.?\]/)?.[1] || "";
  const rowSummary = cleanText(rowText.replace(title, "").replace(/\[\d{4}[./-]\d{1,2}[./-]\d{1,2}\.?\]/, ""));
  const snippet = rowSummary.length >= 20 ? rowSummary : [title, date ? `[${date}]` : ""].filter(Boolean).join(" ");
  const focusedBody = [title, rowSummary, date ? `[${date}]` : ""].filter(Boolean).join(" ");

  return {
    title,
    snippet,
    date,
    body: focusedBody,
  };
}

function isGenericTitle(title, source) {
  const normalized = cleanText(title).toLocaleLowerCase("ko-KR");
  const sourceName = cleanText(source.name).toLocaleLowerCase("ko-KR");
  const siteTitle = cleanText(source.crawler?.siteTitle || "").toLocaleLowerCase("ko-KR");
  return normalized === sourceName
    || (siteTitle && normalized === siteTitle)
    || (source.id === "kcna" && isGenericKcnaTitle(title))
    || (source.id === "kcna-watch" && /^(?:newstream|newstream\s*\|\s*kcna watch)$/i.test(normalized))
    || normalized.includes("조선민주주의인민공화국 최고인민회의 상임위원회 및 내각기관지");
}

function isGenericKcnaTitle(title) {
  const normalized = cleanText(title).toLocaleLowerCase("ko-KR");
  return KCNA_GENERIC_TITLES.has(normalized)
    || /^(?:조선중앙통신|kcna|korean central news agency)\s*\|\s*(?:기사|article)$/i.test(normalized);
}

function inferMediaType(url, html, source) {
  if (isPdfUrl(url)) return "pdf";
  const mediaAssetType = inferMediaAssetType(url, source);
  if (mediaAssetType) return mediaAssetType;
  if (source.id === "kcna" && /\/(?:kp|en|jp|cn|ru|sp|es)\/gallery\/detail\//iu.test(String(url || ""))) {
    return "image";
  }
  if (source.id === "kcna" && /\/(?:kp|en|jp|cn|ru|sp|es)\/video\/detail\//iu.test(String(url || ""))) {
    return "video";
  }
  if (source.id === "voice-of-korea" && /\/detail_com\/vi_(?:audio|video)(?:\/|$)/i.test(String(url || ""))) {
    return "broadcast";
  }
  if (source.mediaTypes?.length === 1) return source.mediaTypes[0];
  if (/\/video|\/vod|vod\./i.test(url)) return "video";
  if (/<meta[^>]+property=["']og:type["'][^>]+content=["']video/i.test(html)) return "video";
  return "article";
}

function createFeedEntry($, item, feedUrl, source, type) {
  const node = $(item);
  const title = cleanText(node.children("title").first().text());
  const rawLink = type === "atom"
    ? node.children("link[rel='alternate']").attr("href") || node.children("link").first().attr("href")
    : node.children("link").first().text();
  const url = stripHash(resolveUrl(rawLink || node.children("guid").first().text(), feedUrl));
  const description = node.children("description").first().text()
    || node.children("summary").first().text()
    || node.children("content\\:encoded").first().text()
    || node.children("content").first().text();
  const date = node.children("pubDate").first().text()
    || node.children("published").first().text()
    || node.children("updated").first().text();
  const thumbnailUrl = resolveUrl(
    node.children("media\\:thumbnail").first().attr("url")
    || node.children("media\\:content").first().attr("url")
    || "",
    feedUrl,
  );

  return {
    url,
    linkText: title,
    contextText: cleanText(stripHtml(description)),
    feedSummary: description,
    date,
    thumbnailUrl,
    fromFeed: true,
    sourceId: source.id,
  };
}

function isPdfUrl(url) {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return /\.pdf($|\?)/i.test(String(url || ""));
  }
}

function looksIndexableUrl(url) {
  if (/\.(css|js|json|xml|ico|png|jpe?g|gif|webp|svg|woff2?|ttf|zip|rar)($|\?)/i.test(url)) return false;
  if (/mailto:|tel:|javascript:/i.test(url)) return false;
  return true;
}

function shouldIndexCrawledUrl(url, source) {
  if ((!looksIndexableUrl(url) && !isIndexableMediaAssetUrl(url, source)) || !isAllowedSourceUrl(url, source)) return false;
  if (isSourceEntryUrl(url, source) && source.crawler?.indexEntryUrl !== true) return false;

  const includePatterns = source.crawler?.includeUrlPatterns || [];
  if (includePatterns.length && !includePatterns.some((pattern) => urlMatchesPattern(url, pattern))) return false;

  const excludePatterns = source.crawler?.excludeUrlPatterns || [];
  if (excludePatterns.some((pattern) => urlMatchesPattern(url, pattern))) return false;

  return true;
}

function shouldFollowDiscoveryPage(url, source, entryUrl, visitedPages) {
  if (!url || visitedPages.has(url)) return false;
  if (!looksIndexableUrl(url) || isPdfUrl(url) || isIndexableMediaAssetUrl(url, source) || !isAllowedSourceUrl(url, source)) return false;
  if (isSourceEntryUrl(url, source)) return false;
  if (shouldIndexCrawledUrl(url, source)) return false;

  const discoverPatterns = source.crawler?.discoverUrlPatterns || [];
  if (discoverPatterns.length) {
    return discoverPatterns.some((pattern) => urlMatchesPattern(url, pattern));
  }

  try {
    const target = new URL(url);
    const entry = new URL(entryUrl);
    if (target.origin !== entry.origin) return false;
    const pathname = target.pathname.toLocaleLowerCase("en-US");
    return /\/(archive|category|tag|page|list|news|articles?|all_view|index)\b/.test(pathname)
      || /\/page\/\d+\/?$/.test(pathname);
  } catch {
    return false;
  }
}

function isIndexableMediaAssetUrl(url, source) {
  return Boolean(inferMediaAssetType(url, source));
}

function inferMediaAssetType(url, source) {
  if (!url || !Array.isArray(source.mediaTypes)) return "";
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLocaleLowerCase("en-US");
  } catch {
    pathname = String(url || "").toLocaleLowerCase("en-US");
  }

  const hasImageExtension = /\.(png|jpe?g|webp)($|\?)/i.test(pathname);
  const isKcnaImageEndpoint = source.id === "kcna" && /\/image\/q\/.+\.kcmsf$/i.test(pathname);
  if (!hasImageExtension && !isKcnaImageEndpoint) return "";
  if (/\/(static|assets|themes?)\//i.test(pathname) || /(logo|mark|icon|share|btn-|banner|application\d*)/i.test(pathname)) return "";
  if (isKcnaImageEndpoint && source.mediaTypes.includes("image")) return "image";
  if (source.id === "rodong-sinmun") {
    if (/(?:page_bottom_mark|rodong_view_mark|rodong_title|arrow|button|banner)/i.test(pathname)) return "";
    if (source.mediaTypes.includes("image")) return "image";
  }
  if (source.id === "ryugyong") {
    if (source.mediaTypes.includes("video") && /\/contents\/video\//i.test(pathname)) return "video";
    if (source.mediaTypes.includes("image") && /\/contents\/photo\//i.test(pathname)) return "image";
  }
  if (source.id === "minju-choson" && source.mediaTypes.includes("image") && /\/uploads\/photo\//i.test(pathname)) {
    return "image";
  }
  if (source.mediaTypes.includes("image") && hasImageExtension && isAllowedSourceUrl(url, source)) return "image";
  return "";
}

function isSourceEntryUrl(url, source) {
  const entryUrl = source.crawler?.entryUrl || source.baseUrl;
  try {
    const target = new URL(stripHash(url));
    const entry = new URL(stripHash(entryUrl));
    return target.href.replace(/\/$/, "") === entry.href.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function urlMatchesPattern(url, pattern) {
  if (!pattern) return false;
  if (pattern instanceof RegExp) return pattern.test(url);
  return String(url).includes(String(pattern));
}

function isAllowedSourceUrl(url, source) {
  try {
    const target = new URL(url);
    const base = new URL(source.baseUrl);
    const targetHost = normalizeHostname(target.hostname);
    const baseHost = normalizeHostname(base.hostname);
    return targetHost === baseHost || targetHost.endsWith(`.${baseHost}`);
  } catch {
    return false;
  }
}

function normalizeHostname(hostname = "") {
  return String(hostname || "").toLocaleLowerCase("en-US").replace(/^www\./, "");
}

function resolveUrl(href, baseUrl) {
  if (!href) return "";
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return "";
  }
}

function toReadableFetchUrl(url) {
  return `${READABLE_FETCH_PREFIX}${String(url || "").replace(/^https?:\/\//i, "")}`;
}

function stripHash(url) {
  if (!url) return "";
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

function hashUrl(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
}

function slugText(value = "") {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("ko-KR")
    .replace(/[^0-9a-z가-힣]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function cleanFileTitle(url) {
  try {
    const pathname = new URL(url).pathname;
    const fileName = decodeURIComponent(path.basename(pathname)).replace(/\.(?:pdf|png|jpe?g|webp|gif|mp4|webm|m3u8)$/i, "");
    return cleanText(fileName.replace(/[-_]+/g, " "));
  } catch {
    return "";
  }
}

function cleanSitemapTitle(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);
    return cleanReadableTitle(segments.at(-1)?.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ") || parsed.hostname);
  } catch {
    return "";
  }
}

function dedupeLinkEntries(entries) {
  const bestByUrl = new Map();
  for (const entry of entries) {
    if (!entry?.url) continue;
    const existing = bestByUrl.get(entry.url);
    if (!existing) {
      bestByUrl.set(entry.url, entry);
      continue;
    }
    const preferred = getLinkEntryQualityScore(entry) > getLinkEntryQualityScore(existing)
      ? entry
      : existing;
    const alternate = preferred === entry ? existing : entry;
    const newsCategories = mergeStringLists(preferred.newsCategories, alternate.newsCategories);
    bestByUrl.set(entry.url, {
      ...preferred,
      thumbnailUrl: preferred.thumbnailUrl || alternate.thumbnailUrl || "",
      ...(newsCategories.length ? { newsCategories } : {}),
    });
  }
  return [...bestByUrl.values()];
}

function getLinkEntryQualityScore(entry = {}) {
  const linkText = cleanText(entry.linkText || "");
  const contextText = cleanText(entry.contextText || "");
  const descriptiveLinkText = linkText && !isDateOnlyLinkText(linkText);
  return (descriptiveLinkText ? 1000 : 0)
    + Math.min(linkText.length, 240)
    + (entry.date ? 120 : 0)
    + (entry.thumbnailUrl ? 40 : 0)
    + Math.min(contextText.length, 500) / 10
    + (entry.displaySourceId ? 20 : 0)
    + (entry.embeddedDocument ? 2000 : 0);
}

function isDateOnlyLinkText(value = "") {
  const text = cleanText(value);
  const date = extractDateText(text);
  if (!date) return false;
  return cleanText(text.replace(date, "").replace(/[.()\[\]{}\s-]+/g, "")) === "";
}

function dedupeDocuments(documents) {
  const idIndex = new Map();
  const deduped = [];

  for (const document of documents) {
    const id = String(document?.id || "");
    if (id && idIndex.has(id)) {
      const index = idIndex.get(id);
      const existing = deduped[index];
      const preferred = getCrawlerDocumentQualityScore(document) > getCrawlerDocumentQualityScore(existing)
        ? document
        : existing;
      deduped[index] = mergeDuplicateCrawlerDocumentMetadata(preferred, existing, document);
      continue;
    }
    if (id) idIndex.set(id, deduped.length);
    deduped.push(document);
  }

  return deduped;
}

function mergeDuplicateCrawlerDocumentMetadata(preferred = {}, left = {}, right = {}) {
  if (!isFutureDocumentDate(preferred.date)) return preferred;
  const replacementDate = [left.date, right.date]
    .filter((date) => date && !isFutureDocumentDate(date))
    .sort()
    .at(-1);
  return replacementDate ? { ...preferred, date: replacementDate } : preferred;
}

function isFutureDocumentDate(value = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
    && String(value) > new Date().toISOString().slice(0, 10);
}

function getCrawlerDocumentQualityScore(document = {}) {
  const title = cleanText(document.title || "");
  const snippet = cleanText(document.snippet || "");
  const body = cleanText(document.body || "");
  const chromePenalty = isVoiceOfKoreaChromeText(`${snippet} ${body}`) ? 2000 : 0;
  const weakTitlePenalty = /^(?:!\[|details?$)/i.test(title) ? 1000 : 0;
  return Math.min(body.length, 1800)
    + Math.min(snippet.length, 420)
    + (title.length >= 8 ? 40 : 0)
    + (document.date ? 40 : 0)
    - chromePenalty
    - weakTitlePenalty;
}

function normalizeCrawlerDocumentForStorage(document = {}) {
  let title = String(document.title || "");
  let snippet = String(document.snippet || "");
  let body = String(document.body || "");
  let date = String(document.date || "");

  if (/^!\[/.test(title)) {
    title = cleanDocumentTitle(title);
    snippet = snippet.replace(/!\[\s*/g, "");
    body = body.replace(/!\[\s*/g, "");
  }
  if (!title && document.mediaType === "image") {
    title = cleanFileTitle(document.url) || `${document.sourceName || "출처"} 이미지 자료`;
  }
  if (document.mediaType === "image" && /\.(?:png|jpe?g|webp|gif)$/i.test(title)) {
    title = cleanFileTitle(document.url) || title.replace(/\.(?:png|jpe?g|webp|gif)$/i, "");
  }
  if (document.sourceId === "korean-stamp") {
    title = selectSourceSpecificReadableTitle(title, body, { id: "korean-stamp" });
    if (isFutureDocumentDate(date)) date = new Date().toISOString().slice(0, 10);
  }

  return { ...document, title, snippet, body, date };
}

function isVoiceOfKoreaChromeText(text = "") {
  const normalized = cleanText(text);
  if (!normalized) return false;
  return /vok\s+첫페지로\s+어종선택/i.test(normalized)
    || /어종선택\s+Deutsch\s+Русский/i.test(normalized)
    || /《조선의 소리》조선어방송편집부\s+www\.vok\.rep\.kp\s*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /(?:Voice of Korea|English Language Service).*Languages.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /Languages.*English Language Service.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized);
}
