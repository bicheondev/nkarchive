window.DPRK_SEARCH_CONFIG = window.DPRK_SEARCH_CONFIG || globalThis.DPRK_SEARCH_CONFIG || {
  assetProxy: {
    baseUrl: "",
    urlParam: "url",
  },
};
window.DPRK_SEARCH_CONFIG.liveSearch = {
  endpoint: "/api/search-live",
  minimumResults: 12,
  ...window.DPRK_SEARCH_CONFIG.liveSearch,
  enabled: window.DPRK_SEARCH_CONFIG.liveSearch?.enabled !== false,
};
globalThis.DPRK_SEARCH_CONFIG = window.DPRK_SEARCH_CONFIG;
document.documentElement.dataset.searchConfigLoaded = "true";
