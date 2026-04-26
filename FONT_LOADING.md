# Font Loading Architecture

## Startup Data

The site starts with metadata and the UI shell, not the full font archive.

- `font_order.md` is the catalog metadata source: order, series, group, file name, display name, and original archive path.
- `webfonts/font_manifest.json` describes prepared full browser-facing WOFF2/TTF files.
- `webfonts-preview/preview_manifest.json` describes content-hashed WOFF2 preview subsets.
- Original files under `fonts/` remain the archive/download source.

No global CSS file declares every archive font. `app.js` creates `FontFace` objects only for fonts that the scroll window needs.

## Lazy Preview Loading

`app.js` uses a scroll-to-load virtual grid.

- The first result window reveals 24 fonts.
- Scrolling near the current grid bottom reveals the next 24.
- Only visible rows plus a small overscan are mounted in the DOM.
- Each mounted card queues its preview font.
- The loader caps concurrent font fetches and caches queued/loading/loaded/failed state in memory.
- Failed loads stay on the UI fallback font and are not retried repeatedly.

Default catalog cards use the preview family, for example `ArchiveFont070Preview`. When the user enters a custom global phrase or types in a card, that visible card switches to the full family, for example `ArchiveFont070Full`.

## WOFF2 Preview Subsets

Preview subsets live in `webfonts-preview/`.

Generate them with:

```bash
python3 scripts/build-preview-subsets.py
```

Useful options:

```bash
python3 scripts/build-preview-subsets.py --force
python3 scripts/build-preview-subsets.py --from 56 --to 107
python3 scripts/build-preview-subsets.py --jobs 8
```

The script:

- reads `font_order.md`,
- includes common Korean preview text, English letters, numbers, punctuation, and each font's own catalog name/metadata,
- writes WOFF2 preview subsets with content-hashed filenames,
- writes `webfonts-preview/preview_manifest.json`,
- keeps original files and full prepared files untouched.

## Full Webfonts

Prepared full browser-facing fonts live in `webfonts/`.

Regenerate them after replacing source files or changing the catalog:

```bash
python3 scripts/build-webfonts.py
```

Useful options:

```bash
python3 scripts/build-webfonts.py --force
python3 scripts/build-webfonts.py --from 56 --to 107
python3 scripts/build-webfonts.py --only-needed
python3 scripts/build-webfonts.py --no-woff2
```

The full-font script removes browser-problematic legacy tables, repairs sfnt/cmap metadata that Chrome OTS rejects, writes atomically, emits WOFF2, and regenerates `webfonts/font_manifest.json`.

## Adding Fonts

1. Add original font files under `fonts/`.
2. Update source metadata if needed.
3. Regenerate `font_order.md` if the source order changed:

```bash
node scripts/generate-font-order.mjs
```

4. Rebuild full prepared fonts:

```bash
python3 scripts/build-webfonts.py
```

5. Rebuild preview subsets:

```bash
python3 scripts/build-preview-subsets.py
```

6. Keep download links pointed at original files. Preview and prepared files are runtime delivery assets.

## Cache Headers

Use long-lived immutable caching for font binaries. Keep metadata and app files revalidatable so deployments update quickly.

Nginx:

```nginx
location /webfonts-preview/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}

location /webfonts/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}

location /fonts/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}

location ~* \.(html|js|css|md|json)$ {
  add_header Cache-Control "public, max-age=0, must-revalidate";
}
```

Apache:

```apache
<FilesMatch "\.(woff2|woff|ttf|otf)$">
  Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>

<FilesMatch "\.(html|js|css|md|json)$">
  Header set Cache-Control "public, max-age=0, must-revalidate"
</FilesMatch>
```

Static hosting:

- `/webfonts-preview/**`, `/webfonts/**`, `/fonts/**`: `Cache-Control: public, max-age=31536000, immutable`
- `/app.js`, `/styles.css`, `/index.html`, `/font_order.md`, `/webfonts/font_manifest.json`, `/webfonts-preview/preview_manifest.json`: `Cache-Control: public, max-age=0, must-revalidate`
