#!/usr/bin/env bash
# Prints the Dungeon/Entity struct offsets the game-state gate needs, as JSON,
# derived from the decomp's own headers using *agbcc* -- see offsets.c for why
# arm-none-eabi-gcc gives the wrong answer here.
#
#   ./offsets.sh <path-to-pmd-red-checkout>
#
# Needs arm-none-eabi-gcc (preprocessor only) on PATH, and the checkout to have
# been built at least once so tools/preproc and tools/agbcc exist.
set -euo pipefail
REPO="$(cd "${1:?usage: offsets.sh <pmd-red checkout>}" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

for need in "$REPO/tools/preproc/preproc" "$REPO/tools/agbcc/bin/agbcc"; do
  [ -x "$need" ] || { echo "missing $need -- run 'make tools' in the checkout first" >&2; exit 1; }
done

cd "$REPO"
arm-none-eabi-gcc -E -iquote include -I tools/agbcc/include -nostdinc -undef -std=gnu89 \
  "$HERE/offsets.c" -o "$TMP/ofs.i"
tools/preproc/preproc "$TMP/ofs.i" charmap.txt \
  | tools/agbcc/bin/agbcc -mthumb-interwork -Wimplicit -Wparentheses -Wunused -O2 -fhex-asm \
      -o "$TMP/ofs.s"
arm-none-eabi-as -mcpu=arm7tdmi --defsym MODERN=0 -o "$TMP/ofs.o" "$TMP/ofs.s"
arm-none-eabi-objcopy -O binary --only-section=.rodata "$TMP/ofs.o" "$TMP/ofs.bin"

python3 - "$TMP/ofs.bin" <<'PY'
import json, struct, sys
NAMES = ['sizeofDungeon', 'noActionInProgress', 'location', 'teamPokemonPtrs',
         'teamPokemonEntities', 'cameraSub', 'cameraPos', 'sizeofEntity',
         'entityType', 'entityPos', 'entityPrevPos', 'entityVisible',
         'entityRoom', 'entitySpawnGenID', 'unk644', 'fractionalTurn',
         'numItems', 'tileset', 'tiles', 'sizeofEntityInfo', 'sizeofTile',
         'sizeofMenuInput', 'menuIndex', 'menuCurrPageEntries', 'menuTotalEntries']
# The header carries these as comments on the fields. Cross-checking against them
# is the whole point: a compiler with different struct packing produces plausible
# numbers that are quietly wrong.
EXPECT = {'sizeofDungeon': 0x1CEDC, 'noActionInProgress': 0xF, 'location': 0x1C570,
          'teamPokemonPtrs': 0x1357C, 'teamPokemonEntities': 0x1381C,
          'cameraSub': 0x181E8, 'numItems': 0x3904, 'tileset': 0x3A0E, 'tiles': 0x3A18,
          'sizeofMenuInput': 0x34, 'menuIndex': 0x18, 'menuCurrPageEntries': 0x1A,
          'menuTotalEntries': 0x22}
data = open(sys.argv[1], 'rb').read()
vals = struct.unpack('<%dI' % (len(data) // 4), data[:len(data) // 4 * 4])
if len(vals) != len(NAMES):
    sys.exit('expected %d offsets, .rodata holds %d' % (len(NAMES), len(vals)))
got = dict(zip(NAMES, vals))
bad = {k: (v, got[k]) for k, v in EXPECT.items() if got[k] != v}
if bad:
    for k, (want, have) in bad.items():
        print('MISMATCH %s: header says 0x%X, compiler says 0x%X' % (k, want, have),
              file=sys.stderr)
    sys.exit('struct layout does not match the headers -- wrong compiler?')
print(json.dumps(got, indent=2))
PY
