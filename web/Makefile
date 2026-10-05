# Browser target for pmd-red (Pokémon Mystery Dungeon: Red Rescue Team).
#
# Builds mGBA's mCore to wasm plus a small shim, and emits a static page that
# takes the user's own ROM from a file picker. No ROM, and no bytes extracted
# from one, are produced or consumed by this Makefile.
#
#   make              build dist/ (the shippable page)
#   make test         also build the node-side core harness
#   make selftest     run the muted core test against ~/decompfleet/roms
#   make browsercheck run the real page in headless Chrome, muted
#   make check        both
#   make gamestate    regenerate test/gamestate.json from the decomp build
#   make clean
#
# libmgba.a is shared with the pokeruby agent's checkout rather than rebuilt:
# the core is GBA-generic and a second mGBA tree would cost ~1 GB of disk on a
# box that does not have it. Override MGBA to point somewhere else.

MGBA      ?= $(HOME)/decompfleet/games/pokeruby/ref/mgba
MGBA_BUILD = $(MGBA)/build-wasm
LIBMGBA    = $(MGBA_BUILD)/libmgba.a
ROMS      ?= $(HOME)/decompfleet/roms
DECOMP    ?= $(CURDIR)/../upstream/pmd-red
SHOTS     ?=

# The shim reads struct mCore through mGBA's headers, so it MUST be compiled
# with the same -D set as libmgba.a, or the fields land at different offsets and
# every vtable entry reads back as NULL -- with no link error, just a "null
# function or function signature mismatch" trap at the first call. Deriving the
# list from the build rather than restating it is deliberate.
MGBA_DEFS = $(shell sed -n 's/^C_DEFINES = //p' $(MGBA_BUILD)/CMakeFiles/mgba.dir/flags.make)

CPPFLAGS = -I $(MGBA)/include -I $(MGBA)/src -I $(MGBA_BUILD)/include \
           -D_GNU_SOURCE -DPATH_MAX=4096 -DDISABLE_THREADING $(MGBA_DEFS)

# No audio device, no filesystem, no GL: the page owns the canvas and only
# creates an AudioContext if the user explicitly unmutes.
#
# SINGLE_FILE=1 embeds the wasm in the .js. That costs ~33% in transfer size and
# buys the page's security boundary: with no separate .wasm to fetch, the page
# never calls fetch() or XHR at all, so it can ship
# `connect-src 'none'` in its CSP. "The ROM is never uploaded" then stops being
# a promise about the code and becomes something the browser enforces.
EMFLAGS = -s MODULARIZE=1 -s EXPORT_NAME=createGBA -s SINGLE_FILE=1 \
          -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=96MB \
          -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPU8","HEAPU32","HEAP16"]' \
          -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
          -s FILESYSTEM=0

PAGE_FILES = dist/index.html dist/app.css dist/app.js

.PHONY: all test selftest browsercheck check clean checklib gamestate

all: dist/core.js $(PAGE_FILES)

checklib:
	@test -f $(LIBMGBA) || { \
	  echo "missing $(LIBMGBA)"; \
	  echo "build mGBA to wasm first -- the emcmake line is in ../STATUS.md"; exit 1; }
	@test -n "$(MGBA_DEFS)" || { \
	  echo "could not read C_DEFINES from the mgba build; refusing to build with"; \
	  echo "mismatched struct layouts (every mCore function pointer would be NULL)"; exit 1; }

dist/core.js: src/shim.c $(LIBMGBA) Makefile | checklib
	@mkdir -p dist
	emcc -O3 $< $(LIBMGBA) $(CPPFLAGS) -o $@ $(EMFLAGS) -s ENVIRONMENT=web

dist/%: src/%
	@mkdir -p dist
	cp $< $@

# Regenerate the symbol/offset table from the decomp checkout. Needs the
# checkout built (`make syms`) and arm-none-eabi-* on PATH.
gamestate:
	tools/gen-gamestate.sh $(DECOMP)

test: test/core-node.js

test/core-node.js: src/shim.c $(LIBMGBA) Makefile | checklib
	emcc -O2 $< $(LIBMGBA) $(CPPFLAGS) -o $@ \
	  -s MODULARIZE=1 -s EXPORT_NAME=createGBA \
	  -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=96MB \
	  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPU8","HEAPU32","HEAP16"]' \
	  -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
	  -s FILESYSTEM=0 -s ENVIRONMENT=node

# Core-level, outside a browser. Fast, and isolates core bugs from page bugs.
selftest: test/core-node.js
	node test/core-smoke.mjs $(ROMS)/pmdred.gba

# The real page in headless Chrome, ROM fed through the actual file picker.
browsercheck: all
	./test/run-browser-check.sh $(ROMS)/pmdred.gba $(SHOTS)

check: selftest browsercheck

clean:
	rm -rf dist test/core-node.js test/core-node.wasm
