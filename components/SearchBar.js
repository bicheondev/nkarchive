export function createSearchBar({ value = "", variant = "home", onInput, onSubmit } = {}) {
  const form = document.createElement("form");
  const field = document.createElement("label");
  const icon = document.createElement("span");
  const input = document.createElement("input");
  const shortcut = document.createElement("span");
  const button = document.createElement("button");

  form.className = `portal-search-form portal-search-form-${variant}`;
  form.setAttribute("role", "search");
  form.setAttribute("aria-label", "북한 공개자료 검색");
  field.className = "portal-search-field";
  icon.className = "portal-search-icon";
  icon.setAttribute("aria-hidden", "true");
  input.className = "portal-search-input";
  input.type = "search";
  input.name = "q";
  input.setAttribute("aria-label", "검색어");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "검색어를 입력하세요";
  input.value = value;
  shortcut.className = "portal-search-shortcut";
  shortcut.setAttribute("aria-hidden", "true");
  shortcut.textContent = "⌘K";
  button.className = "portal-search-submit";
  button.type = "submit";
  button.setAttribute("aria-label", "검색하기");
  button.textContent = "찾기";

  input.addEventListener("input", () => onInput?.(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    onSubmit?.(input.value);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSubmit?.(input.value);
  });

  field.append(icon, input, shortcut);
  form.append(field, button);

  return { element: form, input, field, submitButton: button };
}
