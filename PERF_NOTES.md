# Performance Notes

## Audit Findings

The original bottleneck was font delivery, not layout styling.

- Catalog metadata is small, but the archive contains 682 catalog entries and hundreds of large TTF/OTF-derived files.
- A global `@font-face` strategy would make the browser consider every archive font during startup.
- Direct TTF/OTF delivery triggered Chrome OTS decode failures for several legacy fonts.
- Rendering every card at once would create unnecessary DOM work and would also trigger unnecessary font requests.
- Search/filter changes should only recompute metadata results and should not request offscreen fonts.

The current runtime keeps startup metadata-first and uses scroll-to-load rendering.

## Implemented Architecture

- Startup loads `index.html`, `styles.css`, `app.js`, `font_order.md`, and the two manifests.
- `app.js` does not inject thousands of `@font-face` rules.
- Cards are mounted through a fixed-size virtual grid, with 24 results revealed initially and more revealed only near the current scroll bottom.
- Only mounted cards queue font loads.
- Font requests are deduplicated through an in-memory registry.
- The loader uses the CSS Font Loading API with `font-display: swap`.
- Preview cards prefer WOFF2 subset files from `webfonts-preview/`.
- Custom global text or per-card text upgrades only visible affected cards to the full WOFF2 file from `webfonts/`.
- Failed fonts keep rendering in the UI fallback and are marked failed for the current session.

## Preview Subsets

Build preview WOFF2 files:

```bash
python3 scripts/build-preview-subsets.py
```

The generated manifest is `webfonts-preview/preview_manifest.json`. Filenames include a content hash so immutable caching is safe.

The subset text includes common Korean sample text, common Latin letters/numbers/punctuation, and each font's own catalog metadata. This is intentionally non-destructive: original fonts remain under `fonts/`, and full prepared WOFF2 files remain under `webfonts/`.

## Measurement

Use Chrome DevTools with cache disabled for a first-load comparison.

1. Open Network and filter by `font`.
2. Reload the page.
3. Confirm startup does not request every file in `webfonts/` or `fonts/`.
4. Confirm only visible or near-visible preview files from `webfonts-preview/` are requested.
5. Scroll down and confirm additional font requests happen in small batches.
6. Type a custom preview phrase and confirm only visible cards switch to full `webfonts/ArchiveFontNNN.woff2` requests.
7. Check Performance or Lighthouse for FCP/LCP and scroll responsiveness.

Enable console diagnostics:

```js
localStorage.setItem("fontArchiveDebug", "1")
location.reload()
```

Then call:

```js
fontArchiveDebug()
```

The debug summary reports total catalog fonts, filtered fonts, revealed results, mounted cards, created `FontFace` objects, preview/full requested/loaded/failed counts, and observed font resource transfer sizes from the Performance API.

## Cache Policy

Recommended font cache headers:

```http
Cache-Control: public, max-age=31536000, immutable
```

Use that for `/webfonts-preview/`, `/webfonts/`, and `/fonts/`. Keep app files and manifests revalidatable:

```http
Cache-Control: public, max-age=0, must-revalidate
```

## References

- Google Fonts CSS2 API: https://developers.google.com/fonts/docs/css2
- Google Fonts Developer API metadata: https://developers.google.com/fonts/docs/developer_api
- web.dev font loading: https://web.dev/articles/optimize-webfont-loading
- web.dev font best practices: https://web.dev/articles/font-best-practices
- MDN `font-display`: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40font-face/font-display
- MDN `unicode-range`: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40font-face/unicode-range
