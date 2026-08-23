import { MeilisearchSearchProvider } from "./MeilisearchSearchProvider.js?v=search-20260823-8";
import { LocalJsonSearchProvider } from "./LocalJsonSearchProvider.js?v=search-20260823-8";
import { LiveSearchFallbackProvider } from "./LiveSearchFallbackProvider.js?v=search-20260823-8";

export function createSearchProvider(config = getRuntimeSearchConfig()) {
  const environment = getSearchEnvironment();
  const meilisearch = {
    ...(config.meilisearch || {}),
    host: environment.MEILISEARCH_HOST || config.meilisearch?.host || "",
    apiKey: environment.MEILISEARCH_KEY || config.meilisearch?.apiKey || "",
  };
  const localProvider = new LocalJsonSearchProvider(config.local || {});

  const indexedProvider = meilisearch.host && meilisearch.apiKey
    ? new ResilientSearchProvider(new MeilisearchSearchProvider(meilisearch), localProvider)
    : localProvider;

  return config.liveSearch?.enabled
    ? new LiveSearchFallbackProvider(indexedProvider, config.liveSearch)
    : indexedProvider;
}

export const searchProvider = createSearchProvider();

export class ResilientSearchProvider {
  constructor(primary, fallback) {
    this.primary = primary;
    this.fallback = fallback;
    this.host = primary?.host || "";
    this.apiKey = primary?.apiKey || "";
    this.lastFallback = null;
  }

  async searchDocuments(query, filters = {}) {
    return this.tryPrimary("searchDocuments", [query, filters]);
  }

  async getSuggestions(query) {
    return this.tryPrimary("getSuggestions", [query]);
  }

  async getDocumentById(id) {
    try {
      const record = await this.primary.getDocumentById(id);
      return record || this.fallback.getDocumentById(id);
    } catch (error) {
      this.lastFallback = createFallbackDiagnostic("getDocumentById", error);
      return this.fallback.getDocumentById(id);
    }
  }

  async tryPrimary(method, args) {
    try {
      return await this.primary[method](...args);
    } catch (error) {
      this.lastFallback = createFallbackDiagnostic(method, error);
      return this.fallback[method](...args);
    }
  }
}

function createFallbackDiagnostic(method, error) {
  return {
    method,
    message: error?.message || String(error || "Unknown search backend error"),
  };
}

function getSearchEnvironment() {
  try {
    if (typeof process !== "undefined" && process.env) return process.env;
  } catch {
    // Browser runtime.
  }
  return {};
}

function getRuntimeSearchConfig() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.DPRK_SEARCH_CONFIG) {
      return globalThis.DPRK_SEARCH_CONFIG;
    }
  } catch {
    // Continue to browser window fallback.
  }
  try {
    if (typeof window !== "undefined" && window.DPRK_SEARCH_CONFIG) {
      return window.DPRK_SEARCH_CONFIG;
    }
  } catch {
    // Non-browser runtime.
  }
  return {};
}
