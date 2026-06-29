export function createSearchTabs({ tabs: tabItems = [], activeTab = "all", controlsId = "", onChange } = {}) {
  const tabs = document.createElement("nav");
  const buttons = [];
  tabs.className = "portal-tabs";
  tabs.setAttribute("aria-label", "검색 결과 유형");
  tabs.setAttribute("role", "tablist");

  for (const tab of tabItems) {
    const isActive = tab.id === activeTab;
    const button = document.createElement("button");
    button.className = "portal-tab";
    button.type = "button";
    button.dataset.tab = tab.id;
    button.id = createSearchTabId(tab.id);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(isActive));
    if (controlsId) button.setAttribute("aria-controls", controlsId);
    button.textContent = tab.label;
    button.tabIndex = isActive ? 0 : -1;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
    button.addEventListener("click", () => {
      if (isActive) return;
      onChange?.(tab.id);
    });
    buttons.push(button);
    tabs.append(button);
  }

  tabs.addEventListener("keydown", (event) => {
    const currentIndex = buttons.indexOf(document.activeElement);
    if (currentIndex < 0) return;

    const nextIndex = getKeyboardTabIndex(event.key, currentIndex, buttons.length);
    if (nextIndex === currentIndex) return;

    event.preventDefault();
    buttons[nextIndex].focus();
    onChange?.(buttons[nextIndex].dataset.tab);
  });

  return tabs;
}

export function createSearchTabId(tabId = "all") {
  return `portalTab${tabId}`;
}

function getKeyboardTabIndex(key, currentIndex, tabCount) {
  if (!tabCount) return currentIndex;
  if (key === "ArrowRight") return (currentIndex + 1) % tabCount;
  if (key === "ArrowLeft") return (currentIndex - 1 + tabCount) % tabCount;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  return currentIndex;
}
