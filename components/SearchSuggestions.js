let suggestionListId = 0;

export function createSearchSuggestions({ suggestions = [], onSelect } = {}) {
  const list = document.createElement("div");
  list.className = "portal-suggestions";
  list.id = `portalSuggestions${suggestionListId += 1}`;
  list.hidden = suggestions.length === 0;
  list.dataset.activeIndex = "-1";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "검색어 제안");

  suggestions.forEach((suggestion, index) => {
    const button = document.createElement("button");
    button.className = "portal-suggestion";
    button.type = "button";
    button.id = `${list.id}Option${index}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    button.setAttribute("aria-label", createSuggestionAccessibleLabel(suggestion));
    applySuggestionDataset(button, suggestion);
    button.append(createHighlightedLabel(suggestion.label, suggestion.highlightRanges));
    appendSuggestionMeta(button, suggestion);
    button.addEventListener("click", () => onSelect?.(getSuggestionValue(suggestion), suggestion));
    list.append(button);
  });

  return list;
}

export function updateSearchSuggestions(list, suggestions = [], onSelect) {
  if (!list) return;
  list.hidden = suggestions.length === 0;
  list.dataset.activeIndex = "-1";
  list.dispatchEvent(new CustomEvent("suggestions:update"));
  list.replaceChildren(
    ...suggestions.map((suggestion, index) => {
      const button = document.createElement("button");
      button.className = "portal-suggestion";
      button.type = "button";
      button.id = `${list.id}Option${index}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      button.setAttribute("aria-label", createSuggestionAccessibleLabel(suggestion));
      applySuggestionDataset(button, suggestion);
      button.append(createHighlightedLabel(suggestion.label, suggestion.highlightRanges));
      appendSuggestionMeta(button, suggestion);
      button.addEventListener("click", () => onSelect?.(getSuggestionValue(suggestion), suggestion));
      return button;
    }),
  );
}

export function connectSearchSuggestions(input, list, { onSelect } = {}) {
  if (!input || !list) return;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", String(!list.hidden));

  list.addEventListener("suggestions:update", () => {
    input.setAttribute("aria-expanded", String(!list.hidden));
    input.removeAttribute("aria-activedescendant");
    clearNavigationValue(list);
  });
  input.addEventListener("input", () => {
    clearNavigationValue(list);
    clearActiveSuggestion(input, list);
  });

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;

    const options = getSuggestionOptions(list);
    if (!options.length || list.hidden) {
      if (event.key === "Escape") input.setAttribute("aria-expanded", "false");
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      rememberNavigationValue(input, list);
      setActiveSuggestion(input, list, getNextIndex(list, options.length, 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      rememberNavigationValue(input, list);
      setActiveSuggestion(input, list, getNextIndex(list, options.length, -1));
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      restoreNavigationValue(input, list);
      clearActiveSuggestion(input, list);
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      return;
    }

    if (event.key === "Enter") {
      const active = getActiveSuggestion(list);
      if (!active) return;
      event.preventDefault();
      clearNavigationValue(list);
      onSelect?.(active.dataset.value || active.textContent.trim(), getSuggestionSelection(active));
    }
  }, { capture: true });
}

function applySuggestionDataset(button, suggestion = {}) {
  button.dataset.label = suggestion.label || "";
  button.dataset.value = getSuggestionValue(suggestion);
  button.dataset.suggestionType = suggestion.type || "";
  button.dataset.sourceId = suggestion.sourceId || "";
  button.dataset.sourceName = suggestion.sourceName || "";
}

function getSuggestionSelection(button) {
  return {
    label: button.dataset.label || button.dataset.value || button.textContent.trim(),
    value: button.dataset.value || button.textContent.trim(),
    type: button.dataset.suggestionType || "",
    sourceId: button.dataset.sourceId || "",
    sourceName: button.dataset.sourceName || "",
  };
}

function getSuggestionValue(suggestion = {}) {
  return String(suggestion.value || suggestion.label || "").trim();
}

function rememberNavigationValue(input, list) {
  if (list.dataset.navigationValue !== undefined) return;
  list.dataset.navigationValue = input.value;
}

function restoreNavigationValue(input, list) {
  if (list.dataset.navigationValue === undefined) return;
  input.value = list.dataset.navigationValue;
  clearNavigationValue(list);
}

function clearNavigationValue(list) {
  delete list.dataset.navigationValue;
}

function getSuggestionOptions(list) {
  return [...list.querySelectorAll(".portal-suggestion")];
}

function getNextIndex(list, count, direction) {
  const current = Number(list.dataset.activeIndex || "-1");
  if (current < 0) return direction > 0 ? 0 : count - 1;
  return (current + direction + count) % count;
}

function setActiveSuggestion(input, list, index) {
  const options = getSuggestionOptions(list);
  list.dataset.activeIndex = String(index);
  options.forEach((option, optionIndex) => {
    const isActive = optionIndex === index;
    option.classList.toggle("active", isActive);
    option.setAttribute("aria-selected", String(isActive));
    if (isActive) {
      input.value = option.dataset.value || option.textContent.trim();
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

function clearActiveSuggestion(input, list) {
  list.dataset.activeIndex = "-1";
  input.removeAttribute("aria-activedescendant");
  for (const option of getSuggestionOptions(list)) {
    option.classList.remove("active");
    option.setAttribute("aria-selected", "false");
  }
}

function getActiveSuggestion(list) {
  const index = Number(list.dataset.activeIndex || "-1");
  return index >= 0 ? getSuggestionOptions(list)[index] : null;
}

function createHighlightedLabel(label, ranges = []) {
  const labelNode = document.createElement("span");
  labelNode.className = "portal-suggestion-label";
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) labelNode.append(document.createTextNode(label.slice(cursor, range.start)));
    const mark = document.createElement("mark");
    mark.textContent = label.slice(range.start, range.end);
    labelNode.append(mark);
    cursor = range.end;
  }

  if (cursor < label.length) labelNode.append(document.createTextNode(label.slice(cursor)));
  return labelNode;
}

function appendSuggestionMeta(parent, suggestion = {}) {
  const description = String(suggestion.description || "").trim();
  if (!description) return;

  const meta = document.createElement("span");
  meta.className = "portal-suggestion-meta";
  meta.textContent = description;
  parent.append(meta);
}

function createSuggestionAccessibleLabel(suggestion = {}) {
  return [suggestion.label, suggestion.description].map((value) => String(value || "").trim()).filter(Boolean).join(", ");
}
