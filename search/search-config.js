window.DPRK_SEARCH_CONFIG = window.DPRK_SEARCH_CONFIG || globalThis.DPRK_SEARCH_CONFIG || {
  assetProxy: {
    baseUrl: "",
    urlParam: "url",
  },
};
globalThis.DPRK_SEARCH_CONFIG = window.DPRK_SEARCH_CONFIG;
document.documentElement.dataset.searchConfigLoaded = "true";
