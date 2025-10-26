#!/usr/bin/env bash
set -euo pipefail

# Where to put renamed copies
OUTDIR="renamed"
mkdir -p "$OUTDIR"

# Grab every PNG in the folder, we’ll filter by the pattern later.
shopt -s nullglob

# --- 1) Embed and parse the Table of Contents you pasted --------------------
# We parse NAME + PAGE pairs, ignore the section headers, and sort by page.
cat > /tmp/_toc_raw.txt <<'TOC'
TABLE OF CONTENTS ......................... 3 INTRODUCTION .................................. 4 VILLAIN DESCRIPTIONS..................... 5 THE VILLAINS ..................................... 6 ALCHEMICA...................................... 6 AMBUSH .......................................... 8 ANKYLOSAUR ................................. 11 ANUBIS .......................................... 13 ARACHNE....................................... 15 ARMADILLO ................................... 17 ARROWHEAD.................................. 21 AUTOMATON .................................. 23 THE BASILISK ................................. 24 BAYKOK ......................................... 27 BLACK FANG .................................. 28 BLACKGUARD................................. 30 BLACK HARLEQUIN ......................... 32 BLACK PALADIN ............................. 35 BLOODRAGE .................................. 40 BLOWTORCH.................................. 40 BRAINCHILD ................................... 43 JOSIAH BRIMSTONE ....................... 46 BROMION....................................... 52 BULLDOZER ................................... 56 BUZZSAW ...................................... 59 CADAVER ....................................... 61 CAIRNGORM................................... 63 CAPTAIN CHRONOS ........................ 66 CATERAN ....................................... 71 THE CURSE .................................... 73 CYBERMIND ................................... 75 DEADMAN WALKIN’ ........................ 78 DEVASTATOR.................................. 81 DOCTOR TENEBER .......................... 82 DOUBLE DEALER ............................ 87 DRAGONFLY ................................... 88 DREAMWITCH ................................ 90 ECLIPSAR....................................... 92 ECLIPSE ......................................... 94 THE ENGINEER ............................... 96 ENTROPY ..................................... 100 ESPER.......................................... 102 EVIL EYE....................................... 104 EXO ............................................. 107 FENRIS......................................... 109 FIREWING..................................... 111 FLESHTONE.................................. 115 FOXBAT........................................ 117
FRAG ........................................... 120 FREAKSHOW ................................ 122 GALAXIA ...................................... 124 GALEFORCE ................................. 126 GARGANTUA ................................ 128 GAUNTLET ................................... 130 GEOS ........................................... 132 GEOTHERMAL .............................. 135 GLACIER ...................................... 137 GREEN DRAGON ........................... 139 GRENADIER .................................. 142 GROND ........................................ 144 GROTESK ..................................... 146 HARPY ......................................... 147 HAZARD ....................................... 150 HELL RIDER.................................. 152 HERCULAN ................................... 155 HORNET ....................................... 158 HOWLER ...................................... 160 HURRICANE .................................. 162 INCUBUS ...................................... 164 JADE PHOENIX ............................. 167 KANROK THE ACQUISITIONER ........ 169 LADY BLUE................................... 171 LAMPLIGHTER .............................. 175 LASH ........................................... 176 LAZER.......................................... 179 LEECH.......................................... 180 LEVIATHAN ................................... 182 LI CHUN THE DESTROYER ............. 185 THE LIVING SPHINX....................... 188 LODESTONE ................................. 190 MANTARA .................................... 193 MANTISMAN ................................ 195 MASQUERADE .............................. 197 MECHASSASSIN ........................... 198 MEGAVOLT ................................... 201 MENAGERIE.................................. 203 MINDGAME .................................. 206 MIRAGE........................................ 208 THE MONSTER ............................. 210 MORNINGSTAR ............................. 212 MORPH ........................................ 214 MOTHER GOTHEL ......................... 216 NEBULA ....................................... 218 OGRE ........................................... 222 ONSLAUGHT................................. 224 PHOTON....................................... 226
PLAGUE ....................................... 228 PULSAR ....................................... 230 PYTHON ....................................... 233 REAPER ....................................... 235 RICOCHET .................................... 237 RIPTIDE ........................................ 239 EL SALTO ..................................... 241 SAMHAIN ..................................... 243 SARGON ...................................... 245 SCIMITAR ..................................... 247 SHADOWDRAGON ........................ 251 SHRINKER .................................... 252 SIGNAL GHOST............................. 255 SNOWBLIND................................. 257 SPEKTR........................................ 259 SPIRIT FIST................................... 261 STALKER ...................................... 263 STEEL COMMANDO ...................... 265 STILETTO ..................................... 268 STINGRAY..................................... 270 STORMFRONT .............................. 273 SUNSPOT ..................................... 276 SYZYGY........................................ 278 TACHYON ..................................... 281 TAIPAN ......................................... 283 TALISMAN .................................... 287 WAYLAND TALOS .......................... 289 TERRAYNE.................................... 291 THORN......................................... 294 THUNDERBIRD.............................. 296 THUNDERBOLT ............................. 299 TIMELAPSE .................................. 302 TURS AL-SH’AB ............................ 303 UTILITY ........................................ 305 VALAK THE WORLD-RAVAGER ....... 309 VECTOR ....................................... 311 VESPER........................................ 313 VIBRON ........................................ 315 VIXEN........................................... 317 WHITE RHINO ............................... 319 WILDEYE ...................................... 323 WITCHFINDER............................... 324 ZEPHYR........................................ 327 ZIGZAG ........................................ 329 ZORRAN THE ARTIFICER ................ 332
TOC

# Normalize dots to spaces, compress whitespace, then pull NAME + PAGE pairs.
# We also drop non-villain headings.
sed -E 's/[.]+/ /g' /tmp/_toc_raw.txt \
| tr '\n' ' ' \
| sed -E 's/[[:space:]]+/ /g' \
| awk '
  BEGIN { IGNORECASE=0 }
  {
    n = split($0, t, " ");
    name="";
    for (i=1; i<=n; i++) {
      if (t[i] ~ /^[0-9]+$/) {
        page = t[i] + 0;
        gsub(/^ +| +$/, "", name);
        if (name != "" &&
            name != "TABLE OF CONTENTS" &&
            name != "INTRODUCTION" &&
            name != "VILLAIN DESCRIPTIONS" &&
            name != "THE VILLAINS") {
          print page "\t" name;
        }
        name="";
      } else {
        name = (name=="" ? t[i] : name " " t[i]);
      }
    }
  }' \
| sort -n -k1,1 > /tmp/_villains.tsv

# --- 2) Build the (page, file) list from your images ------------------------
# Accept only files that follow the " - pg <num> - img 1.png" convention.
: > /tmp/_photos.tsv
for f in *.png; do
  [[ -f "$f" ]] || continue
  # extract page number
  page="$(echo "$f" | sed -nE 's/.* - pg ([0-9]+) - img 1\.png$/\1/p')"
  if [[ -n "${page:-}" ]]; then
    printf "%d\t%s\n" "$page" "$f" >> /tmp/_photos.tsv
  fi
done

# Abort if we didn’t find any matches
if [[ ! -s /tmp/_photos.tsv ]]; then
  echo "No files matching \"* - pg <n> - img 1.png\" found. Nothing to do." >&2
  exit 1
fi

sort -n -k1,1 /tmp/_photos.tsv -o /tmp/_photos.tsv

# --- 3) Greedy mapper with course-correction --------------------------------
# Strategy:
#  - Walk photos in ascending page order.
#  - Keep a current villain index i determined by the first photo’s position.
#  - Assign at least one photo per villain.
#  - If we already assigned one for villain i AND the next villain’s page is reached
#    (image page >= next_start - 1), advance to villain i+1 (handles the "one page early" quirk).
#  - If we haven’t assigned for villain i but we are clearly past the next villain
#    (image page >= next_start + 2), force-advance to catch up (course-correct on divergence).
#
# This is robust to occasional off-by-one and small gaps, and it will not skip a villain
# unless the pages have clearly moved on for multiple pages.

awk -F'\t' -v OUTDIR="$OUTDIR" '
  BEGIN {
    OFS="\t";
    # Read villains
  }
  NR==FNR {
    vcount++;
    vpage[vcount] = $1 + 0;
    vname[vcount] = $2;
    vgot[vcount]  = 0;  # assignment count per villain
    next;
  }
  # Now reading photos
  NR!=FNR {
    pcount++;
    ppage[pcount]  = $1 + 0;
    pfile[pcount]  = $2;
    next;
  }
  END {
    if (vcount == 0 || pcount == 0) { exit 1 }

    # Find initial villain index based on first photo page: largest vpage <= ppage[1]
    cur = 1;
    for (k=1; k<=vcount; k++) {
      if (vpage[k] <= ppage[1]) cur = k;
      else break;
    }

    # Map and emit a plan
    for (j=1; j<=pcount; j++) {
      pj = ppage[j];

      # forward advance rules (may advance multiple times if we are far ahead)
      advanced = 0;
      while (cur < vcount) {
        next_start = vpage[cur+1];
        if (vgot[cur] >= 1 && pj >= next_start - 1) { cur++; advanced=1; continue; }
        if (vgot[cur] == 0  && pj >= next_start + 2) { cur++; advanced=1; continue; }
        break;
      }

      # assign
      nm = vname[cur];

      # lower-case file name, collapse spaces
      lnm = nm;
      # tolower is POSIX awk; works for A-Z (non-ASCII punctuation like ’ remains intact)
      lnm = tolower(lnm);
      gsub(/[ ]+/, " ", lnm);
      gsub(/^ +| +$/, "", lnm);

      # ensure unique target (very unlikely collisions, but safe)
      base = lnm ".png";
      out  = OUTDIR "/" base;
      dup  = 2;
      while ( ( (cmd = "test -e \"" out "\"; echo $?") | getline rc ) > 0 ) {
        close(cmd);
        if (rc == 1) break;  # does not exist
        base = lnm " (" dup ").png";
        out = OUTDIR "/" base;
        dup++;
        if (dup > 99) break;
      }

      # Print a mapping line: src<TAB>dest<TAB>photo_page<TAB>villain_page<TAB>villain_name
      print pfile[j], out, pj, vpage[cur], nm;
      vgot[cur]++;
    }
  }
' /tmp/_villains.tsv /tmp/_photos.tsv > /tmp/_plan.tsv

# --- 4) Execute the plan: copy files and write a readable report -------------
# Do the copies
while IFS=$'\t' read -r SRC DEST PPHOTO PTOC NAME; do
  # shellcheck disable=SC2086
  cp -p -- "$SRC" "$DEST"
done < /tmp/_plan.tsv

# Save mapping report for you to audit quickly
{
  echo -e "source\t=>\tdest\tphoto_page\ttoc_page\tvillain"
  cat /tmp/_plan.tsv
} > "$OUTDIR/_predicted-mapping.tsv"

echo "Done. Renamed copies in: $OUTDIR"
echo "Preview mapping: $OUTDIR/_predicted-mapping.tsv"
