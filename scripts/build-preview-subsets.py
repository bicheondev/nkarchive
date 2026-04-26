#!/usr/bin/env python3
import argparse
import hashlib
import json
import logging
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib import woff2


DROP_TABLES = (
    "DSIG",
    "EBDT",
    "EBLC",
    "EBSC",
    "CBDT",
    "CBLC",
    "sbix",
    "bdat",
    "bloc",
    "mort",
    "morx",
    "feat",
    "prop",
    "trak",
    "just",
    "kerx",
    "opbd",
    "gasp",
    "vhea",
    "vmtx",
)

BASE_PREVIEW_TEXT = (
    "가나다라마바사아자차카타파하"
    "동해 물과 백두산이 마르고 닳도록"
    "조선글 한국어 문화어"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    " ,.:;-_/()[]'\"!?·"
)

ORIGINAL_BROTLI_COMPRESS = woff2.brotli.compress


def parse_font_order(path):
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|") or "---" in line:
            continue

        cells = [cell.strip().replace("\\|", "|") for cell in line.strip()[1:-1].split("|")]
        if len(cells) != 6:
            continue

        try:
            order = int(cells[0])
        except ValueError:
            continue

        rows.append(
            {
                "order": order,
                "series": cells[1],
                "group": cells[2],
                "fileName": cells[3],
                "name": cells[4],
                "source": Path(cells[5]),
                "family": f"ArchiveFont{order:03d}",
            }
        )
    return rows


def compact_text(value):
    return "".join(dict.fromkeys(value))


def build_base_preview_text():
    return compact_text(BASE_PREVIEW_TEXT)


def build_font_preview_text(base_preview_text, row):
    return compact_text(f"{base_preview_text}{row['name']} {row['series']} {row['group']} {row['fileName']}")


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_atomic(path, writer):
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    if temporary_path.exists():
        temporary_path.unlink()
    writer(temporary_path)
    temporary_path.replace(path)


def load_existing_manifest(path):
    if not path.exists():
        return {}
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    previews = manifest.get("previews")
    return previews if isinstance(previews, dict) else {}


def preview_file_path(existing, root):
    raw_path = Path(existing.get("url", ""))
    return raw_path if raw_path.is_absolute() else root / raw_path


def output_url_dir(root, output_dir):
    try:
        return output_dir.relative_to(root).as_posix()
    except ValueError:
        return output_dir.name


def normalize_preview(existing, root, output_dir, row, source):
    path = preview_file_path(existing, root)
    source_stat = source.stat()
    preview = dict(existing)
    preview.update(
        {
            "url": f"{output_url_dir(root, output_dir)}/{path.name}",
            "fullUrl": f"webfonts/{row['family']}.woff2",
            "bytes": path.stat().st_size if path.exists() else existing.get("bytes", 0),
            "source": row["source"].as_posix(),
            "sourceMtimeNs": source_stat.st_mtime_ns,
            "sourceSize": source_stat.st_size,
        }
    )
    return preview


def is_current(existing, root, source, glyph_text_hash):
    if not existing:
        return False
    preview_path = preview_file_path(existing, root)
    if not preview_path.exists():
        return False
    try:
        source_stat = source.stat()
    except OSError:
        return False
    return (
        existing.get("glyphTextSha256") == glyph_text_hash
        and existing.get("sourceMtimeNs") == source_stat.st_mtime_ns
        and existing.get("sourceSize") == source_stat.st_size
    )


def subset_options():
    options = subset.Options()
    options.flavor = "woff2"
    options.hinting = False
    options.layout_features = ["*"]
    options.drop_tables += DROP_TABLES
    return options


def save_subset(source, destination, preview_text, woff2_quality):
    options = subset_options()
    font = subset.load_font(str(source), options, lazy=True)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=preview_text)
    subsetter.subset(font)
    font.flavor = "woff2"

    original_compress = woff2.brotli.compress

    def fast_compress(data, mode=woff2.brotli.MODE_GENERIC):
        return ORIGINAL_BROTLI_COMPRESS(data, mode=mode, quality=woff2_quality)

    woff2.brotli.compress = fast_compress
    try:
        subset.save_font(font, str(destination), options)
    finally:
        woff2.brotli.compress = original_compress

    TTFont(destination)


def remove_stale_family_files(output_dir, family, keep_name):
    for path in output_dir.glob(f"{family}.*.woff2"):
        if path.name != keep_name:
            path.unlink()


def build_preview(row, root, output_dir, base_preview_text, existing, force, woff2_quality):
    source = root / row["source"]
    if not source.exists():
        raise FileNotFoundError(source)

    preview_text = build_font_preview_text(base_preview_text, row)
    glyph_text_hash = sha256_text(preview_text)

    if not force and is_current(existing, root, source, glyph_text_hash):
        return normalize_preview(existing, root, output_dir, row, source), False

    temporary_subset = output_dir / f"{row['family']}.preview.tmp.woff2"
    if temporary_subset.exists():
        temporary_subset.unlink()

    save_subset(source, temporary_subset, preview_text, woff2_quality)
    content_hash = sha256_file(temporary_subset)[:12]
    file_name = f"{row['family']}.{content_hash}.woff2"
    destination = output_dir / file_name
    temporary_subset.replace(destination)
    remove_stale_family_files(output_dir, row["family"], file_name)

    source_stat = source.stat()
    return (
        {
            "url": f"{output_url_dir(root, output_dir)}/{file_name}",
            "fullUrl": f"webfonts/{row['family']}.woff2",
            "bytes": destination.stat().st_size,
            "source": row["source"].as_posix(),
            "sourceMtimeNs": source_stat.st_mtime_ns,
            "sourceSize": source_stat.st_size,
            "glyphTextSha256": glyph_text_hash,
        },
        True,
    )


def build_preview_worker(payload):
    row, root, output_dir, base_preview_text, existing, force, woff2_quality = payload
    try:
        preview, built = build_preview(
            row,
            Path(root),
            Path(output_dir),
            base_preview_text,
            existing,
            force,
            woff2_quality,
        )
        return row["family"], preview, built, None
    except Exception as error:
        return row["family"], None, False, f"{row['family']} {row['source']}: {error}"


def write_manifest(path, rows, previews, base_preview_text_hash):
    manifest = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "baseGlyphTextSha256": base_preview_text_hash,
        "fonts": [row["family"] for row in rows if row["family"] in previews],
        "previews": previews,
    }
    write_atomic(
        path,
        lambda temporary_path: temporary_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        ),
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--font-order", default="font_order.md")
    parser.add_argument("--output-dir", default="webfonts-preview")
    parser.add_argument("--from", dest="start", type=int, default=1)
    parser.add_argument("--to", dest="end", type=int)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 8))
    parser.add_argument("--woff2-quality", type=int, default=1)
    args = parser.parse_args()

    logging.getLogger("fontTools.subset").setLevel(logging.ERROR)

    root = Path.cwd()
    all_rows = parse_font_order(root / args.font_order)
    end = args.end or len(all_rows)
    selected_rows = [row for row in all_rows if args.start <= row["order"] <= end]
    output_dir = root / args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    base_preview_text = build_base_preview_text()
    base_preview_text_hash = sha256_text(base_preview_text)
    manifest_path = output_dir / "preview_manifest.json"
    existing_previews = load_existing_manifest(manifest_path)
    previews = dict(existing_previews)
    built_count = 0
    skipped_count = 0
    errors = []

    tasks = [
        (
            row,
            str(root),
            str(output_dir),
            base_preview_text,
            existing_previews.get(row["family"]),
            args.force,
            args.woff2_quality,
        )
        for row in selected_rows
    ]

    if args.jobs > 1 and len(tasks) > 1:
        with ProcessPoolExecutor(max_workers=args.jobs) as executor:
            futures = [executor.submit(build_preview_worker, task) for task in tasks]
            for future in as_completed(futures):
                family, preview, built, error = future.result()
                if error:
                    previews.pop(family, None)
                    errors.append(error)
                    print(error, file=sys.stderr, flush=True)
                else:
                    previews[family] = preview
                    if built:
                        built_count += 1
                        print(f"built {family} {preview['bytes']} bytes", flush=True)
                    else:
                        skipped_count += 1
    else:
        for task in tasks:
            family, preview, built, error = build_preview_worker(task)
            if error:
                previews.pop(family, None)
                errors.append(error)
                print(error, file=sys.stderr, flush=True)
            else:
                previews[family] = preview
                if built:
                    built_count += 1
                    print(f"built {family} {preview['bytes']} bytes", flush=True)
                else:
                    skipped_count += 1

    valid_families = {row["family"] for row in all_rows}
    previews = {
        family: preview
        for family, preview in sorted(previews.items())
        if family in valid_families and Path(preview.get("url", "")).exists()
    }
    write_manifest(manifest_path, all_rows, previews, base_preview_text_hash)

    print(f"manifest fonts: {len(previews)}")
    print(f"built: {built_count}")
    print(f"skipped: {skipped_count}")
    if errors:
        print(f"errors: {len(errors)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
