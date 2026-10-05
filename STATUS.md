# pmdred — Pokémon Mystery Dungeon: Red Rescue Team

**The decompilation builds byte-identical to the staged ROM.** The browser target
runs that ROM on an emscripten build of mGBA, from a ROM the user picks
themselves, behind a CSP that makes "it is never uploaded" something the browser
enforces rather than something the page promises.

The muted test plays past the opening personality quiz into Tiny Woods B1, walks
the party leader around the dungeon grid, fights, drives the in-game **Quicksave**,
reloads the page, and resumes from that save back into the dungeon.

---

## 1. The matching build

Upstream documents its expected hash in `red.sha1`. I checked that against the
staged ROM **before building anything**; they agree exactly, so there is no
mismatch to report.

| | sha1 | size |
|---|---|---|
| staged `roms/pmdred.gba` | `9f4cfc5b5f4859d17169a485462e977c7aac2b89` | 33 554 432 |
| upstream `red.sha1` | `9f4cfc5b5f4859d17169a485462e977c7aac2b89` | — |
| **built `pmd_red.gba`** | **`9f4cfc5b5f4859d17169a485462e977c7aac2b89`** | 33 554 432 |

Also, for the built image: md5 `2100cf6f17e12cd34f1513647dfa506b`,
sha256 `ad316814c77ed083734d816ebcde2ece390efae8d15bcb6c66d7c2862d82eb68`.

Verified two ways, not one: the build's own `sha1sum -c` (the `compare` target),
and an independent `cmp` of the built file against the staged ROM afterwards.
Then reproduced from a wiped tree (`make tidy`, rebuild) — same hash.

Cartridge header: title `POKE DUNGEON`, game code `B24E`, maker `01`,
**revision 0**. This is the (USA, Australia) 1.0 dump; upstream builds only this one.

### Pinned revision

```
pret/pmd-red  6bcbec4f906938c0243aa2026bcbd41b577bab85   (2026-10-02)
              "Merge pull request #490 from AnonymousRandomPerson/master"
```

Checked out at that exact commit (shallow clone of `master` at that sha), not a
moving branch. `web/test/gamestate.json` records the same sha, so the test's
symbol table and the build cannot silently drift apart.

### This build needs the user's ROM — and that is not optional

`INSTALL.md` says to put a `baserom.gba` in the repo root, and it means it:
**26 hand-written `data/*.s` files and the `data/kao/*.inc` portrait tables pull
745 byte ranges straight out of `baserom.gba` with `.incbin`, 1 423 317 bytes in
total — 4.24% of the finished 32 MB image.** Without the ROM the assembler fails
with `Error: file not found: baserom.gba` and the build stops. This is a stronger
fit for the fleet's ROM-required model than pokeruby or pokefirered, which need
no ROM at all.

I did **not** copy the ROM. `baserom.gba` is a symlink:

```sh
ln -sfn ~/decompfleet/roms/pmdred.gba baserom.gba
```

(Upstream also commits `baserom.xdelta`, a 10.8 MB delta against 32 MB of zeros
that reconstructs the whole retail ROM — that is what its CI uses. Do not use it
and do not redistribute it; the symlink is the honest path.)

### Toolchain

| component | version | where from |
|---|---|---|
| agbcc | `gcc 2.9-arm-000512` | `~/decompfleet/shared/agbcc-install`, prebuilt Linux x86-64 |
| | sha1 `2879a669…` (agbcc), `bf57ac04…` (agbcc_arm), `73d003e6…` (old_agbcc) | |
| arm-none-eabi binutils | 2.45.50.20251209 | Ubuntu `binutils-arm-none-eabi` deb |
| arm-none-eabi-gcc/cpp | 14.2.1 20241119 (`15:14.2.rel1-1`) | Ubuntu `gcc-arm-none-eabi` deb |
| host gcc/g++ | 15.2.0 (Ubuntu 26.04) | system |
| perl | 5.40.1 (for `calcrom.pl`) | system |
| emscripten | 4.0.10 (`b7dc6e57`) | `~/decompfleet/shared/emsdk` |
| mGBA | `68cf79fe55257b61efaeea87c83de69aab01f963` | shared with pokeruby, not rebuilt |
| node | 24.19.0 (from emsdk) | |
| Chrome | 151.0.7922.108, headless | |

Full recipe, start to finish:

```sh
export PATH="$HOME/decompfleet/shared/arm-bin/usr/bin:$PATH"
cd upstream/pmd-red
rm -rf tools/agbcc && cp -r ~/decompfleet/shared/agbcc-install tools/agbcc
ln -sfn ~/decompfleet/roms/pmdred.gba baserom.gba      # symlink, never a copy
make tools -j$(nproc)
make compare syms TOOLCHAIN="$HOME/decompfleet/shared/arm-bin/usr" -j$(nproc)
```

No sudo, no devkitARM, no patches to agbcc, no patches to the host tools, and
nothing had to be built from source that the fleet did not already have.
`make tools` is ~10 s; a clean `make compare` is ~70 s at `-j12`. `TOOLCHAIN` must
be the directory *containing* `bin`, so `.../usr`, not `.../usr/bin`.

Two things specific to this repo, versus the other pret GBA trees:

- The Makefile's preprocessor is `CPP := $(CC) -E` with `CC = arm-none-eabi-gcc`
  on Linux (it only uses `arm-none-eabi-cpp` on Darwin). So the **gcc** deb is
  needed, not just binutils — same conclusion as pokeruby, different line number.
- `make compare` is the entry point, not plain `make`. There is one build target
  (`red`); `compare` runs `sha1sum -c red.sha1`, so a clean exit already means
  "matched".

---

## 2. The real completion state (the census had no number; here is one)

The census graded this Medium "by proxy" and noted no published percentage.
There *is* a measure — upstream ships `.github/calcrom/calcrom.pl`, which its CI
runs on every push to `master` and posts to Discord, but nothing publishes the
output. So I ran it on my own matching build:

```
Code decompilation is 100% complete

248822 total symbols
226135 symbols documented (90.8822%)
82 symbols partially documented (0.0330%)
22605 symbols undocumented (9.0848%)

31607401 total bytes of data
26040491 bytes of data in src (82.3873%)
5566910 bytes of data in data (17.6127%)

1423317 bytes of data in 745 incbins (4.5031%)
```

And the same numbers read straight out of `pmd_red.map` myself:

| | bytes | share |
|---|---|---|
| `.text` from `src/` (C) | 724 072 | **100.0000%** |
| `.text` from `asm/` | 0 | 0% |
| `.rodata` from `src/` (C) | 26 040 491 | 82.39% |
| `.rodata` from `data/` (hand-written asm) | 5 566 910 | 17.61% |
| `.incbin` out of `baserom.gba` | 1 423 317 over 745 sites | 4.24% of the 32 MB image |

**Read it like this, because "code is 100%" is misleading on its own.** There is
no `asm/` directory at all, and 696 `.c` files cover every byte of executable
code — but this game is overwhelmingly *data*: of the 32.3 MB the map accounts
for, code is 724 KB, i.e. **2.2%**. The remaining 97.8% is data, and that is
where the open work is: 17.6% of it still lives in 26 hand-written `data/*.s`
files, and 745 ranges totalling 1.4 MB are still lifted verbatim out of the
player's own cartridge at build time.

Documentation is at 90.88% of 248 822 symbols, with 22 605 still named
`sub_<addr>` / `unknown_<addr>`.

Caveats on those figures, since they are upstream's own tool and not mine:
`calcrom.pl` counts whole-file `.incbin` sites by scanning every `.s`/`.inc`
under the ELF's directory, which includes the generated `build/` tree, so its 745
is a superset by construction; my independent count excluding `build/` agrees at
745 sites / 1 423 317 bytes, all of them from `baserom.gba`. Its symbol total
counts every label `nm` emits, including generated data labels, so 90.88% is a
label-naming metric rather than a measure of understood behaviour.

---

## 3. What I shipped for the browser, and why

**Shipped: the decomp's ROM on an emscripten build of mGBA's `mCore`.** Not a
native wasm port of the decomp, and not EmulatorJS.

I did not re-litigate the native-port question: two sessions on this fleet have
already measured and rejected it for pret GBA targets, for two reasons that both
apply here unchanged — there is no PPU, so a native port means writing most of a
GBA emulator; and `preproc` bakes the committed art and music into the binary,
which would mean redistributing the game. This target is 32 MB rather than 16,
so the second reason is if anything worse here.

I took the pokeruby agent's stack directly: `GBACoreCreate()` plus a ~400-line C
shim, and **linked its already-built `libmgba.a` rather than building a second
mGBA tree** (the core is GBA-generic; a second tree would have cost about a
gigabyte on a box that did not have it). `MGBA=` overrides the path.

```
dist/core.js     903 KB   (shim + mGBA + the wasm, base64-inlined)
dist/app.js       18 KB
dist/index.html  3.7 KB
dist/app.css     3.1 KB
```

### The CSP is the boundary, not the README

The page ships:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' data:; connect-src 'none'; media-src 'none'; font-src 'none';
object-src 'none'; form-action 'none'; base-uri 'none'
```

`connect-src 'none'` means the browser refuses `fetch`, `XMLHttpRequest`,
`WebSocket`, `EventSource` and `navigator.sendBeacon` outright. A 32 MB ROM
cannot leave the device even if this page's own JavaScript — or anything injected
into it — tried to send it.

That is only possible because the wasm is **inlined into `core.js`**
(`-s SINGLE_FILE=1`): emscripten emits `findWasmBinary(){return base64Decode("AGFzbQ…")}`
and never fetches it, so nothing needs `connect-src 'self'`. It costs ~33% in
transfer size and is worth it. For the same reason the page script and stylesheet
are separate files instead of inline blocks (no `'unsafe-inline'`), and the
favicon is an inline `data:` SVG (otherwise Chrome requests `/favicon.ico`, which
404s on a static host and shows up as a console error in any honest check).

The harness proves this as **enforcement, not absence**: it makes the page attempt
a cross-origin `fetch`, `XHR`, `WebSocket` and `sendBeacon`, and requires that
none succeed, that the browser raise a `securitypolicyviolation` for each, and
that the DevTools network layer report the requests blocked with
`blockedReason: csp`. Note that `navigator.sendBeacon` **returns `true` for a
beacon the CSP layer then refuses** — its return value is not a usable signal,
which is why the violation events and the network log are the evidence.

`frame-ancestors` is absent because a `<meta>` CSP cannot carry it; a host that
can set response headers should add it. The page is otherwise pure static files.

### The rest of the page

- **The user supplies the ROM**: a real `<input type=file>` plus drag-and-drop,
  read with the File API into wasm linear memory. The ROM is cached in IndexedDB
  so a reload doesn't re-prompt; there is a **"forget ROM"** button.
- **Saves**: cartridge flash is 128 KiB **FLASH1M** — confirmed, not assumed: the
  ROM carries the `FLASH1M_V` library-ID string mGBA sniffs for (at offset
  2 555 092), and the decomp builds `src/agb_flash_1m.c`. The buffer is mirrored
  to IndexedDB when its hash changes and flushed on `pagehide`/`visibilitychange`,
  keyed per cartridge game code (`save:B24E`). Savestates work the same way.
- **Muted by default, and genuinely silent**: no `AudioContext` is constructed at
  all until the user clicks unmute. Muting is the absence of an audio graph, not
  a gain node at zero — which is what makes it assertable.

Build: `cd web && make`. Tests: `make selftest` (core, in node) and
`make browsercheck` (the real page in headless Chrome). `make gamestate`
regenerates the symbol/offset table from the decomp checkout.

---

## 4. Gating "played" on the game, not on a screenshot

Red Rescue Team opens with logos, a title screen, a yes/no, a ~16-question
personality quiz, a name-entry keyboard and a partner pick before any real play.
**All of that is screenshot-identical to playing**: a dialogue box, a cursor, a
text crawl, pixels changing every frame. So neither test believes a picture.

Both harnesses read the decompilation's own EWRAM state through the emulated bus
(`mCore->busRead*`, exposed as `vj_read8/16/32`). Everything they read is
generated from this build — nothing is from a wiki and nothing is hand-typed:

- **Addresses** come from `pmd_red.sym`, produced by `make syms` on the matching
  build (`web/tools/gen-gamestate.sh`).
- **Struct offsets** come from compiling the decomp's own headers with
  `offsetof`-style expressions (`web/tools/offsets.c`, `offsets.sh`).

The gate is `gDungeon` (`0x0203B418`), which `src/run_dungeon.c` sets at the top
of `RunDungeon_Async` and clears at the bottom — so it is non-NULL **exactly**
while a dungeon run is executing — cross-checked against
`sPersonalityTestTracker` (non-NULL only during the quiz), and then against
`gDungeon->teamPokemonEntities[0]`: entity type must be `ENTITY_MONSTER`, the
grid position must be inside the 56×32 dungeon, the spawn-index counter must be
past its base of 10, `teamPokemon[0]` must point at that inline entity, and the
floor must be 1..99. Movement is `pos.x/pos.y` changing across turns.

### The trap that cost the most time, and would catch anyone

**You cannot derive these struct offsets with `arm-none-eabi-gcc`.** I did, and
got numbers that looked entirely plausible and were wrong by kilobytes: modern
gcc lays `EntityInfo` out as 472 bytes where agbcc makes it 520, which drags
every later field of `struct Dungeon` out of place — `teamPokemonEntities` came
out at `0x115C0` instead of `0x1381C`, and `sizeof(Dungeon)` at `0x1AC6C` instead
of `0x1CEDC`. Pointer width is not the issue; both are 32-bit. It is gcc 2.9
versus gcc 14 struct packing.

`offsets.sh` therefore drives the Makefile's real pipeline
(`arm-none-eabi-gcc -E` → `tools/preproc` → **`tools/agbcc`**) and then
cross-checks every result against the offsets the headers carry as comments,
refusing to emit anything if they disagree. With agbcc, all nine cross-checked
offsets match the headers exactly.

---

## 5. What I actually tested

All runs **muted**. Chrome additionally got `--mute-audio` as a second line of
defence, and the harness asserts no `AudioContext` object exists.

### The build — verified
- Byte-identical to the staged ROM, by `sha1sum -c` **and** independent `cmp`.
- Reproduced from a wiped build directory; same hash.
- Header asserted from the built image: `POKE DUNGEON` / `B24E` / rev 0.

### Core, in node (`web/test/core-smoke.mjs`), muted — 14/14
~12 400 frames with adaptive input. State transitions logged as they happened:

```
   frame     16   title / menu
   frame   3024   in the personality quiz
   frame   4576   past the quiz (ground scene)
   frame   9232   gDungeon allocated, floor still generating
   frame   9296   in dungeon id=0 (Tiny Woods) B1, leader at (17,24), room 3
```

- reached the quiz; reached a running dungeon past it
- party leader moved **12 times over 9 distinct squares**, (17,24) → (19,22)
- picture not black (mean luma 182.6) and the frame hash keeps changing
- savestate round trip, with an explicit "INCONCLUSIVE" branch if the picture did
  not change during the divergence window, so a frozen core cannot fake a pass
- **drove the in-game Quicksave**: cartridge flash went from 50 written bytes to
  1 950, and `gDungeon` was released (the game returned to the title screen)

**I looked at the frames**, not just the numbers. Dumped PPMs show Tiny Woods B1
with the HP/level HUD, the player and partner sprites, a Pidgey attacking
("Pidgey used Tackle! … took 3 damage!"), that Pidgey being defeated
("Pidgey was defeated! … gained 12 Exp. Points!"), the dungeon main menu
(Moves/Items/Team/Others/Ground with "Tiny Woods" and the team's HP/Belly/Play
time), the Others menu, the Quicksave/Give Up submenu, and the
"Your adventure to this point will be saved" prompt.

### The real page, headless Chrome (`web/test/run-browser-check.sh`), muted — 26/26
The ROM is fed to the genuine file input over `DOM.setFileInputFiles`, so the
picker, the File API path, the IndexedDB cache and the boot sequence under test
are the ones a user gets.

- core initialises; page echoes back a per-navigation URL nonce
- CSP present with `default-src 'none'` and `connect-src 'none'`
- **no outbound channel succeeds**: `fetch` rejects, XHR fires an error event,
  WebSocket errors; 4 `securitypolicyviolation` events; the network layer reports
  the probes blocked with `blockedReason: csp` and zero responses
- ROM accepted through the picker, header `POKE DUNGEONB24E`, 33 554 432 bytes
- CDP network log: 5 requests total, the only cross-origin one being the
  deliberate probe; the page's own are `/index.html /app.css /core.js /app.js`
- no `.wasm` is ever fetched (it is inlined)
- reached the quiz, then Tiny Woods B1 at frame 10 625
- leader moved **13 times over 8 distinct squares** (the exact figure varies run to
  run: the quiz answers, and therefore the starter and the generated floor, depend
  on when the adaptive driver happens to press A)
- canvas not black (mean luma 190.9 after 11 397 frames); frame hash keeps changing
- **no `AudioContext` object exists**
- savestate round trip, in-dungeon
- **in-game Quicksave driven through four nested menus** by cursor index
- the Quicksave took cartridge flash from 50 to 1 779 written bytes
- the save reaches IndexedDB: full 131 072 bytes under `save:B24E`
- **dispatch method** (from `pokefirered/tools/save_mechanism.py`): `pagehide` and
  `visibilitychange(hidden)` fired by hand on the live page, store read back from
  that same page — intact both times, keys `["rom","romName","save:B24E","state:B24E"]`
- **a real reload**: ROM resumes from cache with no re-pick, and the Quicksave
  survives — all 131 072 bytes hash-identical, 1 779 written bytes restored
- **and the restored save is usable**: driving the opening again resumes straight
  into Tiny Woods B1 **without the personality quiz ever reappearing**, which a
  save-less boot could not do. Screenshot shows the "Tiny Woods B1F" floor banner.
- no uncaught page errors, no console errors

Screenshots confirm the page renders the game full-size with the control bar
below it and the status line reading `POKE DUNGEON · B24E · rev 0`.

Notes on two things the brief flagged:
- **The EmulatorJS `beforeunload` → `exit` save destruction does not apply here**:
  there is no EmulatorJS. This page's unload path only ever *writes*. The dispatch
  method is still used, because it is the right way to test the mechanism without
  racing the page's death — and it would catch that class of bug if it existed.
- **"The per-core save subdirectory is never created" also does not apply**: that
  is EmulatorJS's `/data/saves/<core>/` on IDBFS. Saves here go into a plain
  IndexedDB object store keyed by cartridge game code.

### What I did NOT test — be clear about this
- **No long-form play.** The run reaches Tiny Woods B1, wins one fight and
  quicksaves. Nothing past the first floor of the first dungeon is play-tested:
  not the stairs, not the second floor, not Pokémon Square, not the rescue
  missions, not recruiting, not evolution, not the end of the game.
- **The Quicksave is not the full save.** Quicksave is the in-dungeon suspend; I
  never reached a normal save (sleeping in the team base). The adventure-log,
  friend-rescue and Wonder Mail paths are untouched.
- **The quiz answers are whatever adaptive mashing produced.** Different runs gave
  different starters (Squirtle/Charmander one run, Pikachu/Charmander another) and
  a nonsense name. I never chose anything deliberately.
- **Only headless Chrome 151.** No Firefox, no Safari, no real mobile browser, no
  real GPU — `--disable-gpu` throughout.
- **No touch controls.** Keyboard and gamepad only. The gamepad path is written
  against the Standard Gamepad mapping but is **unverified** — no controller was
  attached.
- **Audio is unverified.** The ScriptProcessor path exists and is wired to the
  unmute button, but every test ran muted by rule, so I have never heard it.
- **`make modern` was not built**, and would not match anyway.
- **Link / Friend Rescue / Wonder Mail** features are not available in the browser
  and were not attempted.
- **`calcrom.pl`'s own numbers are upstream's metric, reproduced, not audited.**
  The caveats are in section 2.
- The quicksave route was driven by cursor index on **this** revision's menus; if
  upstream changes the dungeon menus, `web/test/quicksave.mjs` will need updating
  (it fails loudly rather than silently, reporting which menu it got stuck on).

---

## 6. Proposed catalog fragment

Do not merge mechanically — `source`, `embedUrl`, `image` and `verification.date`
are placeholders until this is actually published.

```json
{
  "id": "pokemon-mystery-dungeon-red-rescue-team",
  "title": "Pokémon Mystery Dungeon: Red Rescue Team",
  "aliases": ["pmd-red", "pmdred", "red rescue team", "mystery dungeon red", "pmd rrt"],
  "year": 2005,
  "genre": "Roguelike RPG",
  "kind": "Decompilation",
  "mode": "files",
  "engine": "the pret/pmd-red decompilation, built to a matching ROM and run on a WebAssembly build of mGBA's core",
  "description": "Wake up as a Pokémon and run randomly generated dungeons with your partner.",
  "overview": "Pokémon Mystery Dungeon: Red Rescue Team built from the pret/pmd-red decompilation, pinned at 6bcbec4f. The build is byte-identical to a retail (USA, Australia) cartridge dump, sha1 9f4cfc5b5f4859d17169a485462e977c7aac2b89, and the decompilation genuinely needs your cartridge: 745 byte ranges of the 32 MB image are still read straight out of it at build time. The page runs the game on a direct WebAssembly build of mGBA's core with the wasm inlined, so it never makes a network request at all — its Content-Security-Policy sets connect-src 'none', which means the browser itself refuses every outbound channel. You supply your own ROM; it is read in your browser with the File API straight into the emulator's memory.",
  "source": "https://github.com/andrewnakas/pmdred-web",
  "engineLicense": "pret/pmd-red (no licence file upstream); mGBA core MPL-2.0",
  "assetLicense": "None distributed — the player supplies their own ROM",
  "assetRequirements": "Your own Pokémon Mystery Dungeon: Red Rescue Team ROM, (USA, Australia), 32 MB, sha1 9f4cfc5b5f4859d17169a485462e977c7aac2b89. It is read in the browser and never uploaded.",
  "controls": [
    "Arrow keys — move",
    "X — A",
    "Z — B (also opens the dungeon menu)",
    "A / S — L / R",
    "Enter — Start",
    "Shift — Select",
    "Gamepad — any standard controller (untested)"
  ],
  "saveInstructions": "Save in a dungeon with the Others → Quicksave menu. The cartridge save is mirrored into this browser's storage and restored automatically on reload, so a Quicksave resumes you back into the dungeon. There are also save-state buttons. Clearing site data removes everything, including the cached ROM.",
  "limitations": [
    "You must supply your own ROM; none is distributed.",
    "Verified only as far as the first floor of the first dungeon: the opening quiz, Tiny Woods B1, one fight won, and an in-game Quicksave that survives a reload. Nothing past that floor has been play-tested.",
    "The normal (non-Quicksave) save, rescue missions, recruiting and the adventure log were not tested.",
    "Sound is implemented but has never been listened to — all testing was muted.",
    "Keyboard and gamepad only; no on-screen touch controls. The gamepad mapping is untested.",
    "Tested in headless Chrome only; no Firefox, Safari or mobile browser.",
    "Link play, Friend Rescue and Wonder Mail are not available in the browser.",
    "The 32 MB ROM is cached in browser storage, which some browsers may evict under quota pressure."
  ],
  "inputs": ["Keyboard", "Gamepad"],
  "downloadMB": 1,
  "complete": false,
  "color": "#e04a4a",
  "shelf": "decomp",
  "platform": "Game Boy Advance",
  "launch": "embed",
  "touch": false,
  "embedUrl": "https://andrewnakas.github.io/pmdred-web/",
  "verification": {
    "status": "smoke-tested",
    "date": null,
    "browsers": ["Chrome (headless)"],
    "scope": "Muted headless run: boot through the personality quiz into Tiny Woods B1, party leader walked 12 squares, one wild Pokémon defeated, in-game Quicksave driven through the dungeon menus, cartridge save and savestate persistence across a real page reload, and the save resumed back into the dungeon without the quiz reappearing. No play beyond the first dungeon floor.",
    "playthrough": false
  },
  "image": "/images/pokemon-mystery-dungeon-red-rescue-team.png"
}
```

---

## 7. Layout

```
games/pmdred/
  STATUS.md                     this file
  .gitignore                    no ROMs, no extracted assets, no build output
  upstream/pmd-red/             pret/pmd-red @ 6bcbec4f, not vendored (gitignored)
  build-artifacts/              pmd_red.sym / .map kept from the matching build
  web/
    Makefile                    all / test / selftest / browsercheck / check / gamestate
    src/shim.c                  mCore -> JS surface, incl. bus reads for the state gate
    src/index.html              the page (CSP, no inline script or style)
    src/app.js                  page logic
    src/app.css                 page styles
    tools/offsets.c             struct offsets, compiled BY AGBCC (see section 4)
    tools/offsets.sh            ... and cross-checked against the header comments
    tools/gen-gamestate.sh      symbol addresses from pmd_red.sym + those offsets
    test/gamestate.json         generated; the only game-specific data in the tests
    test/gamestate.mjs          reads the game's state through the emulated bus
    test/quicksave.mjs          drives the in-game Quicksave by menu cursor index
    test/core-smoke.mjs         core test in node (VJ_DUMP=dir for PPM frames)
    test/browser-check.mjs      CDP harness: CSP enforcement, play, saves, reload
    test/run-browser-check.sh   serves dist/, runs headless Chrome, tears down
    dist/                       build output (gitignored)
```

The build tree is left `make tidy`-ed to return disk to the fleet; `make compare`
rebuilds it in about 70 seconds given the toolchain above and the baserom symlink.

### Traps worth knowing about

**agbcc and modern gcc disagree about struct layout.** Section 4. This is the one
that will bite anyone reading PMD state out of memory, and it fails silently.

**In a dungeon, the menu button is a short press of B, not Start.** The branch is
`gRealInputs.shortPress & B_BUTTON` in `DungeonHandlePlayerInput`
(`src/dungeon_main.c`). Start does nothing. Worse, mashing A to "get through"
anything is actively wrong on the dungeon field — A is *attack*, so it starts
fights and buries the screen in battle messages, and Start is then ignored
because a message box is waiting. A screenshot was the only thing that said so.

**The Quicksave prompt's cursor starts on "No".** `AskToQuickSave` calls
`DisplayDungeonYesNoMessage_Async(..., FALSE)`. Tapping A on it answers No and
drops you back to the menu, which looks exactly like the menu never opened. Also,
tapping A quickly just restarts the text crawl: let the text finish, press UP,
then A.

**`sendBeacon` returns `true` for a request CSP then blocks.** Do not use its
return value as evidence that an exfiltration channel is open or closed; use the
`securitypolicyviolation` event and the DevTools network log.

**The shim must be compiled with libmgba's exact `-D` set** (inherited from
pokeruby, still true): `struct mCore`'s layout depends on `ENABLE_DEBUGGERS`,
`ENABLE_VFS`, `ENABLE_DIRECTORIES` and friends, and getting it wrong makes every
vtable entry read back NULL with no link error. The Makefile derives the list
from the mGBA build's own `flags.make` and refuses to build if it cannot read it.
