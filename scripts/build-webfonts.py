#!/usr/bin/env python3
import argparse
import json
import math
import struct
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib import woff2
from fontTools.ttLib.woff2 import compress as compress_woff2


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

ORIGINAL_BROTLI_COMPRESS = woff2.brotli.compress
R2_ASSET_BASE_URL = "https://pub-a12b2bbd25db44479f7ca23251a65bef.r2.dev"


def local_asset_path(value):
    prefix = f"{R2_ASSET_BASE_URL}/"
    if value.startswith(prefix):
        value = value[len(prefix) :]
    return Path(value)


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
                "name": cells[4],
                "source": local_asset_path(cells[5]),
                "family": f"ArchiveFont{order:03d}",
            }
        )
    return rows


def should_prepare(font, all_fonts):
    if all_fonts:
        return True
    return any(tag in font for tag in DROP_TABLES)


def binary_search_values(count, unit_size):
    power = 1 << (count.bit_length() - 1) if count else 0
    search_range = power * unit_size
    entry_selector = int(math.log2(power)) if power else 0
    range_shift = count * unit_size - search_range
    return search_range, entry_selector, range_shift


def table_records(data):
    if len(data) < 12:
        return {}

    num_tables = struct.unpack_from(">H", data, 4)[0]
    records = {}
    for index in range(num_tables):
        record_offset = 12 + index * 16
        if record_offset + 16 > len(data):
            break
        tag = bytes(data[record_offset : record_offset + 4]).decode("latin1")
        table_offset, table_length = struct.unpack_from(">LL", data, record_offset + 8)
        records[tag] = (record_offset, table_offset, table_length)
    return records


def repair_sfnt_header(data):
    if len(data) < 12:
        return

    num_tables = struct.unpack_from(">H", data, 4)[0]
    search_range, entry_selector, range_shift = binary_search_values(num_tables, 16)
    struct.pack_into(">HHH", data, 6, search_range, entry_selector, range_shift)


def repair_cmap_table(data, records):
    cmap_record = records.get("cmap")
    if not cmap_record:
        return

    num_glyphs = read_num_glyphs(data, records)
    _, cmap_offset, cmap_length = cmap_record
    if cmap_offset + cmap_length > len(data) or cmap_length < 4:
        return

    subtable_count = struct.unpack_from(">H", data, cmap_offset + 2)[0]
    for index in range(subtable_count):
        encoding_record_offset = cmap_offset + 4 + index * 8
        if encoding_record_offset + 8 > cmap_offset + cmap_length:
            continue

        subtable_offset = struct.unpack_from(">L", data, encoding_record_offset + 4)[0]
        absolute_subtable_offset = cmap_offset + subtable_offset
        if absolute_subtable_offset + 14 > cmap_offset + cmap_length:
            continue

        subtable_format = struct.unpack_from(">H", data, absolute_subtable_offset)[0]
        if subtable_format != 4:
            continue

        segment_count_x2 = struct.unpack_from(">H", data, absolute_subtable_offset + 6)[0]
        segment_count = segment_count_x2 // 2
        search_range, entry_selector, range_shift = binary_search_values(segment_count, 2)
        struct.pack_into(">HHH", data, absolute_subtable_offset + 8, search_range, entry_selector, range_shift)
        repair_format4_glyph_references(data, absolute_subtable_offset, segment_count, num_glyphs)


def read_num_glyphs(data, records):
    maxp_record = records.get("maxp")
    if not maxp_record:
        return None

    _, maxp_offset, maxp_length = maxp_record
    if maxp_length < 6 or maxp_offset + 6 > len(data):
        return None
    return struct.unpack_from(">H", data, maxp_offset + 4)[0]


def repair_format4_glyph_references(data, subtable_offset, segment_count, num_glyphs):
    subtable_length = struct.unpack_from(">H", data, subtable_offset + 2)[0]
    end_codes_offset = subtable_offset + 14
    start_codes_offset = end_codes_offset + segment_count * 2 + 2
    id_deltas_offset = start_codes_offset + segment_count * 2
    id_range_offsets_offset = id_deltas_offset + segment_count * 2
    glyph_id_array_offset = id_range_offsets_offset + segment_count * 2

    for index in range(segment_count):
        end_code = struct.unpack_from(">H", data, end_codes_offset + index * 2)[0]
        start_code = struct.unpack_from(">H", data, start_codes_offset + index * 2)[0]
        id_range_offset = struct.unpack_from(">H", data, id_range_offsets_offset + index * 2)[0]
        if start_code == 0xFFFF and end_code == 0xFFFF and id_range_offset == 0:
            struct.pack_into(">H", data, id_deltas_offset + index * 2, 1)

    if num_glyphs is None:
        return

    glyph_id_count = (subtable_length - (glyph_id_array_offset - subtable_offset)) // 2
    for index in range(max(0, glyph_id_count)):
        glyph_id_offset = glyph_id_array_offset + index * 2
        glyph_id = struct.unpack_from(">H", data, glyph_id_offset)[0]
        if glyph_id >= num_glyphs:
            struct.pack_into(">H", data, glyph_id_offset, 0)


def repair_font_file(path):
    data = bytearray(path.read_bytes())
    repair_sfnt_header(data)
    records = table_records(data)
    repair_cmap_table(data, records)
    repair_checksums(data, records)
    path.write_bytes(data)


def table_checksum(data):
    padded_length = (len(data) + 3) & ~3
    padded = data + b"\0" * (padded_length - len(data))
    total = 0
    for offset in range(0, padded_length, 4):
        total = (total + struct.unpack_from(">L", padded, offset)[0]) & 0xFFFFFFFF
    return total


def repair_checksums(data, records):
    head_record = records.get("head")
    if head_record:
        _, head_offset, head_length = head_record
        if head_length >= 12 and head_offset + 12 <= len(data):
            struct.pack_into(">L", data, head_offset + 8, 0)

    for tag, (record_offset, table_offset, table_length) in records.items():
        if table_offset + table_length > len(data):
            continue
        checksum = table_checksum(bytes(data[table_offset : table_offset + table_length]))
        struct.pack_into(">L", data, record_offset + 4, checksum)

    if head_record:
        _, head_offset, head_length = head_record
        if head_length >= 12 and head_offset + 12 <= len(data):
            adjustment = (0xB1B0AFBA - table_checksum(bytes(data))) & 0xFFFFFFFF
            struct.pack_into(">L", data, head_offset + 8, adjustment)


def write_atomic(path, writer):
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    if temporary_path.exists():
        temporary_path.unlink()
    writer(temporary_path)
    temporary_path.replace(path)


def compress_woff2_fast(source, destination, quality):
    original_compress = woff2.brotli.compress

    def fast_compress(data, mode=woff2.brotli.MODE_GENERIC):
        return ORIGINAL_BROTLI_COMPRESS(data, mode=mode, quality=quality)

    woff2.brotli.compress = fast_compress
    try:
        compress_woff2(source, destination, transform_tables=set())
    finally:
        woff2.brotli.compress = original_compress


def prepare_font(row, output_dir, force, all_fonts, build_woff2, woff2_quality):
    ttf_destination = output_dir / f"{row['family']}.ttf"
    woff2_destination = output_dir / f"{row['family']}.woff2"
    if ttf_destination.exists() and (not build_woff2 or woff2_destination.exists()) and not force:
        return False, row["family"]

    font = TTFont(row["source"], recalcBBoxes=False, recalcTimestamp=False)
    if not should_prepare(font, all_fonts):
        return False, None

    for tag in DROP_TABLES:
        if tag in font:
            del font[tag]

    def write_ttf(path):
        font.save(path)
        repair_font_file(path)

    write_atomic(ttf_destination, write_ttf)
    if build_woff2:
        write_atomic(
            woff2_destination,
            lambda path: compress_woff2_fast(ttf_destination, path, woff2_quality),
        )
    return True, row["family"]


def write_manifest(output_dir):
    families = sorted({path.stem for path in output_dir.glob("ArchiveFont*.*") if path.suffix in {".ttf", ".woff2"}})
    formats = {}
    for family in families:
        family_formats = []
        if (output_dir / f"{family}.woff2").exists():
            family_formats.append("woff2")
        if (output_dir / f"{family}.ttf").exists():
            family_formats.append("ttf")
        formats[family] = family_formats

    manifest = {
        "version": 2,
        "fonts": families,
        "formats": formats,
    }
    (output_dir / "font_manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    return len(families)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--font-order", default="font_order.md")
    parser.add_argument("--output-dir", default="webfonts")
    parser.add_argument("--from", dest="start", type=int, default=1)
    parser.add_argument("--to", dest="end", type=int)
    parser.add_argument("--all", action="store_true", help="prepare every font in the selected range")
    parser.add_argument("--only-needed", action="store_true", help="only prepare fonts with legacy compatibility tables")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-woff2", action="store_true", help="skip WOFF2 generation")
    parser.add_argument("--woff2-quality", type=int, default=3)
    args = parser.parse_args()

    root = Path.cwd()
    rows = parse_font_order(root / args.font_order)
    end = args.end or len(rows)
    selected_rows = [row for row in rows if args.start <= row["order"] <= end]

    output_dir = root / args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    built_count = 0
    skipped_count = 0
    errors = []

    for row in selected_rows:
        try:
            prepare_all = args.all or not args.only_needed
            built, family = prepare_font(
                row,
                output_dir,
                args.force,
                prepare_all,
                not args.no_woff2,
                args.woff2_quality,
            )
            if built:
                built_count += 1
                print(f"built {family} {row['source']}")
            elif family:
                skipped_count += 1
            else:
                skipped_count += 1
        except Exception as error:
            errors.append(f"{row['family']} {row['source']}: {error}")
            print(errors[-1], file=sys.stderr)

    manifest_count = write_manifest(output_dir)
    print(f"manifest fonts: {manifest_count}")
    print(f"built: {built_count}")
    print(f"skipped: {skipped_count}")

    if errors:
        print(f"errors: {len(errors)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
