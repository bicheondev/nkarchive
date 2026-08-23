(function initializeNewsHeader() {
  const navigation = document.querySelector(".news-navigation");
  const toggle = document.querySelector("#newsMenuToggle");
  const toggleIcon = toggle?.querySelector(".news-menu-toggle-icon");
  const navigationLinks = document.querySelector("#newsNavigationLinks");
  const searchInput = document.querySelector("[data-news-global-search]");
  if (!navigation || !toggle || !navigationLinks) return;

  const mobileMenuQuery = window.matchMedia?.("(max-width: 1100px)");

  toggle.addEventListener("click", () => {
    setMenuOpen(!document.body.classList.contains("news-menu-open"));
  });
  navigationLinks.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenuOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (!document.body.classList.contains("news-menu-open")) return;
    if (navigation.contains(event.target)) return;
    setMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (document.body.classList.contains("news-menu-open")) {
        setMenuOpen(false);
        toggle.focus({ preventScroll: true });
        return;
      }
      if (document.activeElement === searchInput || searchInput?.value) {
        searchInput.value = "";
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.blur();
      }
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase("en-US") === "k") {
      event.preventDefault();
      if (searchInput && isVisible(searchInput)) {
        searchInput.focus();
        searchInput.select();
      } else {
        window.location.assign("/news/search#search");
      }
    }
  });
  mobileMenuQuery?.addEventListener?.("change", (event) => {
    if (!event.matches) setMenuOpen(false);
  });

  function setMenuOpen(open) {
    const shouldOpen = Boolean(open) && (mobileMenuQuery?.matches ?? window.innerWidth <= 1100);
    document.body.classList.toggle("news-menu-open", shouldOpen);
    toggle.classList.toggle("active", shouldOpen);
    toggle.setAttribute("aria-expanded", String(shouldOpen));
    toggle.setAttribute("aria-label", shouldOpen ? "메뉴 닫기" : "메뉴 열기");
    if (toggleIcon) toggleIcon.textContent = shouldOpen ? "close" : "drag_handle";
  }

  function isVisible(element) {
    return !element.hidden && element.getClientRects().length > 0;
  }
})();
