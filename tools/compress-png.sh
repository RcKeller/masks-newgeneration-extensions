#!/usr/bin/env bash
# compress_pngs.sh — mass-compress PNGs in the current directory (macOS-compatible).
# Uses pngquant (lossy) and falls back to oxipng (lossless) if needed.
#
# Usage:
#   ./compress_pngs.sh
#
# Optional env vars:
#   PNG_QUALITY   default: 65-80   (pngquant quality range; lower = smaller)
#   PNG_SPEED     default: 1       (pngquant 1..11; 1 = slower/smaller)
#   SUBSTR        default: " Background Removed"
#   OVERWRITE     default: 0       (set to 1 to overwrite an existing destination)

set -euo pipefail
IFS=$'\n\t'

QUALITY=${PNG_QUALITY:-65-80}
SPEED=${PNG_SPEED:-1}
SUBSTR=${SUBSTR:-" Background Removed"}
OVERWRITE=${OVERWRITE:-0}

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

# Cross-platform file size:
# - macOS/BSD: stat -f%z
# - GNU coreutils: stat -c%s
# - Fallback: wc -c
get_size() {
  local f="$1" sz
  if sz=$(stat -f%z "$f" 2>/dev/null); then
    printf '%s' "$sz"
    return
  fi
  if sz=$(stat -c%s "$f" 2>/dev/null); then
    printf '%s' "$sz"
    return
  fi
  wc -c < "$f" | tr -d '[:space:]'
}

ensure_cmd pngquant pngquant

shopt -s nullglob nocaseglob
pngs=(./*.png)
shopt -u nocaseglob

if ((${#pngs[@]} == 0)); then
  echo "No PNG files found in $(pwd)."
  exit 0
fi

echo "Compressing ${#pngs[@]} PNG(s) in $(pwd)"
echo "Using pngquant quality=$QUALITY speed=$SPEED; removing substring: '$SUBSTR'"

total_before=0
total_after=0
processed=0
skipped=0

for src in "${pngs[@]}"; do
  filename="${src##*/}"
  dir="."
  ext="${filename##*.}"          # preserve original extension case
  base="${filename%.*}"

  out_base="${base//${SUBSTR}/}" # remove the exact substring if present
  out="${dir}/${out_base}.${ext}"

  before=$(get_size "$src")

  # Skip if destination (different name) exists and we weren't told to overwrite
  if [[ "$out" != "$src" && -e "$out" && "$OVERWRITE" -ne 1 ]]; then
    echo "⚠️  Skipping: '$filename' → '${out##*/}' (destination exists). Set OVERWRITE=1 to overwrite."
    ((skipped++))
    continue
  fi

  # Try pngquant first
  if [[ "$out" == "$src" ]]; then
    # In-place compression (same name)
    if ! pngquant --quality="$QUALITY" --speed "$SPEED" --strip --skip-if-larger \
                  --ext ".${ext}" --force -- "$src" >/dev/null; then
      # Fallback to lossless oxipng if pngquant can't/won't compress
      ensure_cmd oxipng oxipng
      oxipng -o 4 --strip all "$src" >/dev/null
    fi
  else
    # Output to new name (with substring removed)
    if ! pngquant --quality="$QUALITY" --speed "$SPEED" --strip --skip-if-larger \
                  --output "$out" -- "$src" >/dev/null; then
      ensure_cmd oxipng oxipng
      cp -f "$src" "$out"
      oxipng -o 4 --strip all "$out" >/dev/null
    fi
  fi

  after_target="$out"
  [[ "$out" == "$src" ]] && after_target="$src"
  after=$(get_size "$after_target")

  percent="0.0"
  if (( before > 0 )); then
    percent=$(awk -v b="$before" -v a="$after" 'BEGIN{printf "%.1f", (b-a)*100.0/b}')
  fi

  printf "✓ %s → %s  (%d → %d bytes, %s%% saved)\n" \
         "$filename" "${after_target##*/}" "$before" "$after" "$percent"

  ((processed++))
  ((total_before += before))
  ((total_after += after))
done

if (( processed > 0 )); then
  total_saved=$((total_before - total_after))
  total_percent="0.0"
  if (( total_before > 0 )); then
    total_percent=$(awk -v b="$total_before" -v a="$total_after" \
                    'BEGIN{printf "%.1f", (b-a)*100.0/b}')
  fi
  printf "\nDone. Processed %d file(s). Total: %d → %d bytes (%s%% saved). %d file(s) skipped.\n" \
         "$processed" "$total_before" "$total_after" "$total_percent" "$skipped"
fi
