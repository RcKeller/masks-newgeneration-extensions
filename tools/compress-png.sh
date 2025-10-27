#!/usr/bin/env bash
# compress_images.sh — compress PNG and JPG/JPEG files in-place (macOS-friendly).
# Idempotent: skips files already optimized with the same settings + same content
# (tracked via extended attributes and a SHA-256 hash).
#
# Usage:
#   ./compress_images.sh [DIR]
#   ./compress_images.sh -i DIR [-r]
#
# Options:
#   -i, --input DIR   Input directory (default: current directory)
#   -r, --recursive   Recurse into subdirectories (default: off)
#   -h, --help        Show help
#
# Env vars:
#   PNG_QUALITY      default: 65-80   (pngquant quality)
#   PNG_SPEED        default: 1       (pngquant 1..11; 1 = slower/smaller)
#   JPEG_QUALITY     default: 85      (jpegoptim --max=QUALITY)
#   JPEG_PROGRESSIVE default: 1       (1 = make progressive)
#   JPEG_STRIP       default: all     (all|none|com|exif|iptc)
#   RECURSIVE        default: 0       (set to 1 or use -r)

set -euo pipefail
IFS=$'\n\t'

# ------------------------------ Config ------------------------------

PNG_QUALITY="${PNG_QUALITY:-65-80}"
PNG_SPEED="${PNG_SPEED:-1}"

JPEG_QUALITY="${JPEG_QUALITY:-85}"
JPEG_PROGRESSIVE="${JPEG_PROGRESSIVE:-1}"
JPEG_STRIP="${JPEG_STRIP:-all}"

RECURSIVE="${RECURSIVE:-0}"

ATTR_SIG="com.imageoptimizer.signature"
ATTR_SHA="com.imageoptimizer.sha256"

PNG_SIG="png:v1;q=${PNG_QUALITY},s=${PNG_SPEED};post=oxipng-o4-stripall"
JPG_SIG="jpg:v1;max=${JPEG_QUALITY},prog=${JPEG_PROGRESSIVE},strip=${JPEG_STRIP}"

# ------------------------------ Helpers ------------------------------

usage() {
  cat <<EOF
compress_images.sh — compress PNG and JPG/JPEG files in-place.

Usage:
  ./compress_images.sh [DIR]
  ./compress_images.sh -i DIR [-r]

Options:
  -i, --input DIR   Input directory (default: current directory)
  -r, --recursive   Recurse into subdirectories (default: off)
  -h, --help        Show this help

Env vars:
  PNG_QUALITY=${PNG_QUALITY}  PNG_SPEED=${PNG_SPEED}
  JPEG_QUALITY=${JPEG_QUALITY}  JPEG_PROGRESSIVE=${JPEG_PROGRESSIVE}  JPEG_STRIP=${JPEG_STRIP}
  RECURSIVE=${RECURSIVE}
EOF
}

ensure_cmd() {
  local cmd="$1" pkg="${2:-$1}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "Error: '$cmd' not found and Homebrew isn't installed. Install Homebrew from https://brew.sh and rerun." >&2
      exit 1
    fi
    echo "→ Installing $pkg via Homebrew..."
    brew install "$pkg"
  fi
}

get_size() {
  local f="$1" sz
  if sz=$(stat -f%z "$f" 2>/dev/null); then printf '%s' "$sz"; return; fi
  if sz=$(stat -c%s "$f" 2>/dev/null); then printf '%s' "$sz"; return; fi
  wc -c < "$f" | tr -d '[:space:]'
}

get_hash() {
  local f="$1"
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$f" | awk '{print $1}'; return; fi
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f" | awk '{print $1}'; return; fi
  if command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$f" | sed 's/^.*= //'; return; fi
  if command -v md5 >/dev/null 2>&1; then md5 -q "$f"; return; fi
  echo "Error: no hashing tool available (need shasum/sha256sum/openssl/md5)." >&2
  exit 1
}

lower_ext() {
  local filename="$1"
  local ext="${filename##*.}"
  printf '%s' "$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
}

XATTR_AVAILABLE=1
if ! command -v xattr >/dev/null 2>&1; then
  XATTR_AVAILABLE=0
fi

already_optimized() {
  local file="$1" sig="$2" hash="$3"
  [[ "$XATTR_AVAILABLE" -eq 1 ]] || return 1
  local s h
  s=$(xattr -p "$ATTR_SIG" "$file" 2>/dev/null || true)
  h=$(xattr -p "$ATTR_SHA" "$file" 2>/dev/null || true)
  [[ "$s" == "$sig" && "$h" == "$hash" ]]
}

mark_optimized() {
  local file="$1" sig="$2" hash="$3"
  [[ "$XATTR_AVAILABLE" -eq 1 ]] || return 0
  xattr -w "$ATTR_SIG" "$sig" "$file" >/dev/null 2>&1 || true
  xattr -w "$ATTR_SHA" "$hash" "$file" >/dev/null 2>&1 || true
}

compress_png() {
  local file="$1"
  local ext_basename="${file##*.}"
  local before after

  before=$(get_size "$file")
  if ! pngquant --quality="$PNG_QUALITY" --speed "$PNG_SPEED" --strip \
                --skip-if-larger --force --ext ".${ext_basename}" -- "$file" >/dev/null 2>&1; then
    ensure_cmd oxipng oxipng
    oxipng -o 4 --strip all -- "$file" >/dev/null 2>&1 || true
  fi
  after=$(get_size "$file")
  printf '%s %d %d\n' "PNG" "$before" "$after"
}

compress_jpg() {
  local file="$1"
  local before after strip_flags prog_flags

  case "$JPEG_STRIP" in
    all)  strip_flags="--strip-all" ;;
    none) strip_flags="" ;;
    com)  strip_flags="--strip-com" ;;
    exif) strip_flags="--strip-exif" ;;
    iptc) strip_flags="--strip-iptc" ;;
    *)    strip_flags="--strip-all" ;;
  esac

  if [[ "$JPEG_PROGRESSIVE" == "1" ]]; then prog_flags="--all-progressive"; else prog_flags=""; fi

  before=$(get_size "$file")
  ensure_cmd jpegoptim jpegoptim
  jpegoptim --max="$JPEG_QUALITY" $prog_flags $strip_flags -p -q -- "$file" >/dev/null 2>&1 || true
  after=$(get_size "$file")

  printf '%s %d %d\n' "JPG" "$before" "$after"
}

# ------------------------------ Arg parsing ------------------------------

INPUT_DIR="."
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--input) INPUT_DIR="${2:-.}"; shift 2;;
    -r|--recursive) RECURSIVE=1; shift;;
    -h|--help) usage; exit 0;;
    *) if [[ -d "$1" ]]; then INPUT_DIR="$1"; shift; else echo "Unknown arg: $1" >&2; usage; exit 1; fi ;;
  esac
done

if [[ ! -d "$INPUT_DIR" ]]; then
  echo "Error: directory not found: $INPUT_DIR" >&2
  exit 1
fi

ensure_cmd pngquant pngquant

# ------------------------------ Collect files ------------------------------

FILES=()
if [[ "$RECURSIVE" == "1" ]]; then
  # Recursive: use find (null-delimited)
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$INPUT_DIR" -type f \( -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" \) -print0)
else
  # Non-recursive: BSD find lacks -maxdepth; use globs
  shopt -s nullglob
  for f in "$INPUT_DIR"/*.png "$INPUT_DIR"/*.PNG \
           "$INPUT_DIR"/*.jpg "$INPUT_DIR"/*.JPG \
           "$INPUT_DIR"/*.jpeg "$INPUT_DIR"/*.JPEG; do
    [[ -f "$f" ]] && FILES+=("$f")
  done
  shopt -u nullglob
fi

if ((${#FILES[@]} == 0)); then
  echo "No PNG/JPG files found in $(cd "$INPUT_DIR" && pwd)."
  exit 0
fi

echo "Compressing ${#FILES[@]} image(s) in $(cd "$INPUT_DIR" && pwd)"
echo "PNG: pngquant quality=$PNG_QUALITY speed=$PNG_SPEED (fallback: oxipng -o4)"
echo "JPG: jpegoptim max=$JPEG_QUALITY progressive=$JPEG_PROGRESSIVE strip=$JPEG_STRIP"
[[ "$XATTR_AVAILABLE" -eq 1 ]] || echo "⚠️  Note: xattr not available; idempotent skip disabled."

total_before=0
total_after=0
processed=0
skipped=0

for f in "${FILES[@]}"; do
  ext="$(lower_ext "$f")"
  hash_before="$(get_hash "$f")"
  if [[ "$ext" == "png" ]]; then sig="$PNG_SIG"; else sig="$JPG_SIG"; fi

  if already_optimized "$f" "$sig" "$hash_before"; then
    echo "⏭️  Skipping (already optimized w/ same settings): $f"
    ((skipped++))
    continue
  fi

  case "$ext" in
    png)      read -r kind before after < <(compress_png "$f") ;;
    jpg|jpeg) read -r kind before after < <(compress_jpg "$f") ;;
    *)        continue ;;
  esac

  saved=$(( before - after ))
  percent="0.0"
  if (( before > 0 )); then
    percent=$(awk -v b="$before" -v a="$after" 'BEGIN{printf "%.1f", (b-a)*100.0/b}')
  fi

  printf "✓ [%s] %s  (%d → %d bytes, %s%% saved)\n" "$kind" "$f" "$before" "$after" "$percent"

  hash_after="$(get_hash "$f")"
  mark_optimized "$f" "$sig" "$hash_after"

  ((processed++))
  ((total_before += before))
  ((total_after += after))
done

if (( processed > 0 )); then
  total_percent="0.0"
  if (( total_before > 0 )); then
    total_percent=$(awk -v b="$total_before" -v a="$total_after" 'BEGIN{printf "%.1f", (b-a)*100.0/b}')
  fi
  printf "\nDone. Processed %d file(s). Total: %d → %d bytes (%s%% saved). %d file(s) skipped.\n" \
         "$processed" "$total_before" "$total_after" "$total_percent" "$skipped"
else
  printf "\nNothing to do. %d file(s) skipped.\n" "$skipped"
fi