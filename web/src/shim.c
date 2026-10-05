/* Pokémon Mystery Dungeon: Red Rescue Team — browser target, mGBA mCore shim.
 *
 * Exposes a small C surface to JS. Deliberately has no SDL, no filesystem and
 * no audio device: the page owns the canvas and (only if the user asks for it)
 * the AudioContext. The ROM arrives as bytes from an <input type=file> and is
 * never written anywhere but linear memory.
 *
 * Derived from the pokeruby agent's shim (see ~/decompfleet/games/pokeruby),
 * with cartridge-bus reads added so a test can gate "did it reach dungeon
 * play" on the game's own EWRAM state instead of on a screenshot.
 */

#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba/gba/core.h>
#include <mgba-util/vfs.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/image.h>

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define VID_W 240
#define VID_H 160

/* Red Rescue Team is FLASH1M (1 Mbit = 128 KiB): the ROM carries the
 * `FLASH1M_V` library-ID string mGBA sniffs for, and the decomp builds
 * src/agb_flash_1m.c. Size this exactly — oversizing makes mGBA pick the wrong
 * save media. */
#define SAVE_BYTES (128 * 1024)

static struct mCore* core = NULL;
static mColor* vbuf = NULL;

/* The core keeps referencing the ROM VFile for the whole session, so this copy
 * has to outlive vj_load_rom(). Same for the save buffer. */
static uint8_t* rom = NULL;
static size_t romLen = 0;
static struct VFile* romVf = NULL;

static uint8_t* save = NULL;
static struct VFile* saveVf = NULL;

static int16_t* abuf = NULL;   /* interleaved stereo, drained by JS */
static size_t abufFrames = 0;
static unsigned sampleRate = 0;

static uint8_t* state = NULL;
static size_t stateLen = 0;

static int loaded = 0;

/* ---------------------------------------------------------------- lifecycle */

/* mGBA's default logger prints every BIOS SWI and DMA. In a browser that is
 * thousands of console lines a second and a visible framerate cost. Swallow
 * everything; the vj_* return values are the diagnostic surface. */
static void _quietLog(struct mLogger* logger, int category, enum mLogLevel level,
                      const char* format, va_list args) {
	UNUSED(logger);
	UNUSED(category);
	UNUSED(level);
	UNUSED(format);
	UNUSED(args);
}

static struct mLogger quietLogger = { .log = _quietLog, .filter = NULL };

EMSCRIPTEN_KEEPALIVE
int vj_init(void) {
	if (core) {
		return 1;
	}
	mLogSetDefaultLogger(&quietLogger);
	core = GBACoreCreate();
	if (!core) {
		return 0;
	}
	if (!core->init(core)) {
		core->deinit(core);
		core = NULL;
		return 0;
	}
	/* core->config holds hash tables that mCore reads during reset()
	 * (_GBACoreReset -> mCoreConfigGetBoolValue). GBACoreCreate does not
	 * initialise them, so without this, reset() walks a garbage table and traps
	 * on an out-of-bounds read. Nothing is loaded from or written to disk --
	 * mCoreConfigLoad is deliberately not called. */
	mCoreConfigInit(&core->config, "pmdred-web");
	core->loadConfig(core, &core->config);

	vbuf = calloc(VID_W * VID_H, sizeof(mColor));
	core->setVideoBuffer(core, vbuf, VID_W);
	core->setAudioBufferSize(core, 1024);
	sampleRate = core->audioSampleRate(core);
	abufFrames = 4096;
	abuf = calloc(abufFrames * 2, sizeof(int16_t));
	return 1;
}

/* Copies, so JS may free its own view. */
EMSCRIPTEN_KEEPALIVE
int vj_load_rom(const uint8_t* data, int size) {
	if (!core || size <= 0) {
		return 0;
	}
	if (loaded) {
		core->unloadROM(core);
		loaded = 0;
	}
	free(rom);
	rom = malloc((size_t) size);
	if (!rom) {
		return 0;
	}
	memcpy(rom, data, (size_t) size);
	romLen = (size_t) size;

	romVf = VFileFromMemory(rom, romLen);
	if (!romVf || !core->loadROM(core, romVf)) {
		return 0;
	}

	if (!save) {
		save = calloc(SAVE_BYTES, 1);
	}
	saveVf = VFileFromMemory(save, SAVE_BYTES);
	core->loadSave(core, saveVf);

	core->reset(core);
	loaded = 1;
	return 1;
}

EMSCRIPTEN_KEEPALIVE
int vj_loaded(void) {
	return loaded;
}

EMSCRIPTEN_KEEPALIVE
void vj_reset(void) {
	if (core && loaded) {
		core->reset(core);
	}
}

/* ------------------------------------------------------------------- frames */

EMSCRIPTEN_KEEPALIVE
void vj_run_frame(void) {
	if (core && loaded) {
		core->runFrame(core);
	}
}

EMSCRIPTEN_KEEPALIVE
mColor* vj_framebuffer(void) {
	return vbuf;
}

EMSCRIPTEN_KEEPALIVE
int vj_width(void) { return VID_W; }

EMSCRIPTEN_KEEPALIVE
int vj_height(void) { return VID_H; }

EMSCRIPTEN_KEEPALIVE
int vj_frame_counter(void) {
	return (core && loaded) ? (int) core->frameCounter(core) : -1;
}

/* mGBA leaves alpha at 0 in some paths; ImageData needs it opaque. Done here
 * rather than in JS so the page can hand the buffer straight to putImageData. */
EMSCRIPTEN_KEEPALIVE
void vj_opaque(void) {
	uint32_t* p = (uint32_t*) vbuf;
	for (int i = 0; i < VID_W * VID_H; ++i) {
		p[i] |= 0xFF000000u;
	}
}

/* -------------------------------------------------------------------- input */

EMSCRIPTEN_KEEPALIVE
void vj_set_keys(int keys) {
	if (core && loaded) {
		core->setKeys(core, (uint32_t) keys);
	}
}

/* -------------------------------------------------------------------- audio */

EMSCRIPTEN_KEEPALIVE
int vj_sample_rate(void) { return (int) sampleRate; }

EMSCRIPTEN_KEEPALIVE
int16_t* vj_audio_buffer(void) { return abuf; }

/* Returns frames (sample pairs) written into vj_audio_buffer(). JS only calls
 * this once the user has unmuted; otherwise the buffer is never drained and
 * mGBA's ring overwrites itself, which costs nothing. */
EMSCRIPTEN_KEEPALIVE
int vj_drain_audio(int maxFrames) {
	if (!core || !loaded) {
		return 0;
	}
	if (maxFrames > (int) abufFrames) {
		maxFrames = (int) abufFrames;
	}
	struct mAudioBuffer* ab = core->getAudioBuffer(core);
	if (!ab) {
		return 0;
	}
	size_t got = mAudioBufferRead(ab, abuf, (size_t) maxFrames);
	return (int) got;
}

/* --------------------------------------------------------- in-game save RAM */

EMSCRIPTEN_KEEPALIVE
uint8_t* vj_save_buffer(void) { return save; }

EMSCRIPTEN_KEEPALIVE
int vj_save_size(void) { return SAVE_BYTES; }

/* Cheap change detector so the page can persist only when the cartridge save
 * actually moved, instead of writing 128 KiB to IndexedDB on a timer. */
EMSCRIPTEN_KEEPALIVE
unsigned vj_save_hash(void) {
	if (!save) {
		return 0;
	}
	unsigned h = 2166136261u;
	for (int i = 0; i < SAVE_BYTES; ++i) {
		h = (h ^ save[i]) * 16777619u;
	}
	return h;
}

/* How much of the save image is non-0xFF/non-zero, i.e. has actually been
 * written by the game. An all-0xFF 128 KiB block is an erased flash chip, not a
 * save file, and the two are easy to confuse when only hashing. */
EMSCRIPTEN_KEEPALIVE
int vj_save_written_bytes(void) {
	if (!save) {
		return 0;
	}
	int n = 0;
	for (int i = 0; i < SAVE_BYTES; ++i) {
		if (save[i] != 0xFF && save[i] != 0x00) {
			++n;
		}
	}
	return n;
}

/* Must be called before vj_load_rom(): mGBA reads the buffer when it attaches
 * the save media. */
EMSCRIPTEN_KEEPALIVE
int vj_save_restore(const uint8_t* data, int size) {
	if (!save) {
		save = calloc(SAVE_BYTES, 1);
	}
	if (!data || size <= 0) {
		return 0;
	}
	if (size > SAVE_BYTES) {
		size = SAVE_BYTES;
	}
	memcpy(save, data, (size_t) size);
	return size;
}

/* --------------------------------------------------------------- savestates */

EMSCRIPTEN_KEEPALIVE
int vj_state_size(void) {
	return (core && loaded) ? (int) core->stateSize(core) : 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* vj_state_save(void) {
	if (!core || !loaded) {
		return NULL;
	}
	size_t n = core->stateSize(core);
	if (n != stateLen) {
		free(state);
		state = malloc(n);
		stateLen = n;
	}
	if (!core->saveState(core, state)) {
		return NULL;
	}
	return state;
}

EMSCRIPTEN_KEEPALIVE
int vj_state_load(const uint8_t* data, int size) {
	if (!core || !loaded || !data) {
		return 0;
	}
	if ((size_t) size != core->stateSize(core)) {
		return 0;
	}
	return core->loadState(core, data) ? 1 : 0;
}

/* -------------------------------------------------------- game-state reads */
/* The whole point of these: "it looks like the game is being played" is not
 * evidence, and this game opens with a long scripted questionnaire that is
 * screenshot-indistinguishable from real menu interaction. The test reads the
 * decompilation's own EWRAM globals -- addresses taken from the .sym of the
 * matching build -- and asks the game directly whether a dungeon run is
 * executing and where the party leader is standing. */

EMSCRIPTEN_KEEPALIVE
int vj_read8(unsigned addr) {
	return (core && loaded) ? (int) core->busRead8(core, addr) : -1;
}

EMSCRIPTEN_KEEPALIVE
int vj_read16(unsigned addr) {
	return (core && loaded) ? (int) core->busRead16(core, addr) : -1;
}

EMSCRIPTEN_KEEPALIVE
unsigned vj_read32(unsigned addr) {
	return (core && loaded) ? core->busRead32(core, addr) : 0u;
}

/* Signed 16-bit, for the s16 x/y of DungeonPos. */
EMSCRIPTEN_KEEPALIVE
int vj_read_s16(unsigned addr) {
	if (!core || !loaded) {
		return -1;
	}
	return (int) (int16_t) (uint16_t) core->busRead16(core, addr);
}

/* ------------------------------------------------------------------ probes */

/* Mean luma over the frame. The page's self-test uses this to tell "the core is
 * running" from "the core is running and something is actually on screen" --
 * a black frame compiles and ticks just fine. */
EMSCRIPTEN_KEEPALIVE
double vj_mean_luma(void) {
	if (!vbuf) {
		return -1.0;
	}
	const uint8_t* p = (const uint8_t*) vbuf;
	double acc = 0.0;
	for (int i = 0; i < VID_W * VID_H; ++i) {
		acc += 0.2126 * p[i * 4 + 0] + 0.7152 * p[i * 4 + 1] + 0.0722 * p[i * 4 + 2];
	}
	return acc / (VID_W * VID_H);
}

/* FNV-1a of the visible frame, for comparing two frames exactly (savestate
 * round-trip checks). */
EMSCRIPTEN_KEEPALIVE
unsigned vj_frame_hash(void) {
	if (!vbuf) {
		return 0;
	}
	const uint8_t* p = (const uint8_t*) vbuf;
	unsigned h = 2166136261u;
	for (int i = 0; i < VID_W * VID_H * 4; ++i) {
		h = (h ^ p[i]) * 16777619u;
	}
	return h;
}

/* Game title from the cartridge header, so the page can say which ROM it got
 * (and refuse a non-PMD one) without JS parsing the header itself. */
EMSCRIPTEN_KEEPALIVE
const char* vj_game_title(void) {
	static char title[17];
	memset(title, 0, sizeof(title));
	if (rom && romLen >= 0xB0) {
		memcpy(title, rom + 0xA0, 12);
		memcpy(title + 12, rom + 0xAC, 4);
	}
	return title;
}

EMSCRIPTEN_KEEPALIVE
int vj_rom_revision(void) {
	/* Header byte 0xBC is the version/revision number. Red Rescue Team (USA,
	 * Australia) is revision 0. */
	return (rom && romLen > 0xBC) ? rom[0xBC] : -1;
}

EMSCRIPTEN_KEEPALIVE
int vj_rom_size(void) {
	return (int) romLen;
}
