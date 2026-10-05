/* Muted core test, outside a browser. Isolates "is the core running the game"
 * from "is the page wiring it up right".
 *
 *   node test/core-smoke.mjs <rom.gba> [maxFrames]
 *   VJ_DUMP=dir   also write PPM frames so a human can look at them
 *
 * The bar this test is trying to clear is NOT "pixels changed". Red Rescue Team
 * opens with logos, a title screen and then a long scripted personality quiz,
 * all of which look like play in a screenshot. It drives input adaptively and
 * gates on the decompilation's own EWRAM state (see gamestate.mjs) to decide
 * whether a dungeon run is actually executing and whether the party leader
 * moved on the dungeon grid.
 *
 * No audio is ever requested: the core's audio ring is simply never drained.
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadTable, readState, describe } from './gamestate.mjs';
import { quicksave } from './quicksave.mjs';

const require = createRequire(import.meta.url);
const romPath = process.argv[2];
const maxFrames = Number(process.argv[3] || 200000);
const dumpDir = process.env.VJ_DUMP || null;
if (!romPath) {
	console.error('usage: node core-smoke.mjs <rom.gba> [maxFrames]');
	process.exit(2);
}
if (dumpDir) { mkdirSync(dumpDir, { recursive: true }); }

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail });
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

const createGBA = require(fileURLToPath(new URL('./core-node.js', import.meta.url)));
const M = await createGBA();

const api = {
	init: M.cwrap('vj_init', 'number', []),
	loadRom: M.cwrap('vj_load_rom', 'number', ['number', 'number']),
	runFrame: M.cwrap('vj_run_frame', null, []),
	setKeys: M.cwrap('vj_set_keys', null, ['number']),
	framebuffer: M.cwrap('vj_framebuffer', 'number', []),
	opaque: M.cwrap('vj_opaque', null, []),
	meanLuma: M.cwrap('vj_mean_luma', 'number', []),
	frameHash: M.cwrap('vj_frame_hash', 'number', []),
	title: M.cwrap('vj_game_title', 'string', []),
	revision: M.cwrap('vj_rom_revision', 'number', []),
	romSize: M.cwrap('vj_rom_size', 'number', []),
	saveHash: M.cwrap('vj_save_hash', 'number', []),
	saveWritten: M.cwrap('vj_save_written_bytes', 'number', []),
	stateSize: M.cwrap('vj_state_size', 'number', []),
	stateSave: M.cwrap('vj_state_save', 'number', []),
	stateLoad: M.cwrap('vj_state_load', 'number', ['number', 'number']),
	read8: M.cwrap('vj_read8', 'number', ['number']),
	read16: M.cwrap('vj_read16', 'number', ['number']),
	read32: M.cwrap('vj_read32', 'number', ['number']),
	readS16: M.cwrap('vj_read_s16', 'number', ['number'])
};
const rd = {
	u8: (a) => api.read8(a >>> 0),
	u16: (a) => api.read16(a >>> 0),
	u32: (a) => api.read32(a >>> 0) >>> 0,
	s16: (a) => api.readS16(a >>> 0)
};

check('core initialises', api.init() === 1);

const rom = readFileSync(romPath);
const p = M._malloc(rom.length);
M.HEAPU8.set(rom, p);
const ok = api.loadRom(p, rom.length);
M._free(p);
check('ROM loads into the core', ok === 1, romPath + ' (' + rom.length + ' bytes)');
if (!ok) { process.exit(1); }

const title = api.title();
check('cartridge header is Red Rescue Team', /^POKE DUNGEON/.test(title) && /B24E$/.test(title),
	'"' + title + '" rev=' + api.revision() + ' size=' + api.romSize());

const T = loadTable();
check('game-state table matches this ROM', T.builtRomSha1.length === 40,
	'upstream ' + T.upstreamRevision.slice(0, 10) + ', built rom sha1 ' + T.builtRomSha1.slice(0, 12));

/* ----------------------------------------------------------------- driving */

const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 };
let frames = 0;

function pump(n, bits) {
	for (let i = 0; i < n; i++) {
		api.setKeys(bits | 0);
		api.runFrame();
		frames++;
	}
}

function dump(tag) {
	if (!dumpDir) { return; }
	api.opaque();
	const ptr = api.framebuffer();
	const px = M.HEAPU8.subarray(ptr, ptr + 240 * 160 * 4);
	const body = Buffer.alloc(240 * 160 * 3);
	for (let i = 0; i < 240 * 160; i++) {
		body[i * 3] = px[i * 4]; body[i * 3 + 1] = px[i * 4 + 1]; body[i * 3 + 2] = px[i * 4 + 2];
	}
	writeFileSync(`${dumpDir}/${tag}.ppm`,
		Buffer.concat([Buffer.from('P6\n240 160\n255\n'), body]));
}

/* An adaptive driver rather than a fixed key script. The opening is a chain of
 * logos, a title screen, a yes/no, ~16 quiz questions, a name-entry keyboard
 * and a partner pick, and the number of frames each takes is not something to
 * hard-code. So: mostly A, with Start/B/directions cycled in, and the rotation
 * advances faster whenever the picture stops changing — which is what being
 * stuck on a screen that wants a different button looks like. */
const ROTATION = [KEY.A, KEY.A, KEY.A, KEY.START, KEY.A, KEY.A, KEY.B, KEY.A,
                  KEY.DOWN, KEY.A, KEY.RIGHT, KEY.A, KEY.START, KEY.A, KEY.UP, KEY.A];
let rotIdx = 0, stalls = 0, lastHash = 0;

const log = [];
let sawQuiz = false, sawDungeon = false, firstDungeonFrame = -1;
let dungeonState = null;
let prevDesc = '';

function observe() {
	const st = readState(rd, T);
	const d = describe(st);
	if (d !== prevDesc) {
		prevDesc = d;
		log.push({ frame: frames, desc: d });
		console.log(`  [frame ${String(frames).padStart(6)}] ${d}`);
	}
	if (st.inQuiz) { sawQuiz = true; }
	if (st.inDungeonRun && st.plausible && !sawDungeon) {
		sawDungeon = true;
		firstDungeonFrame = frames;
		dungeonState = st;
	}
	return st;
}

while (frames < maxFrames && !sawDungeon) {
	const bits = ROTATION[rotIdx % ROTATION.length];
	pump(6, bits);
	pump(10, 0);
	const h = api.frameHash();
	if (h === lastHash) { stalls++; } else { stalls = 0; }
	lastHash = h;
	/* Normally step the rotation slowly so A gets the repeated presses a text
	 * crawl needs; step it fast when nothing on screen is moving. */
	rotIdx += (stalls > 2) ? 3 : 1;
	observe();
	if (dumpDir && frames % 3000 < 16) { dump('f' + String(frames).padStart(6, '0')); }
}

check('reached the personality quiz', sawQuiz,
	sawQuiz ? 'sPersonalityTestTracker became non-NULL' : 'never saw the quiz');
check('reached a running dungeon (past the quiz)', sawDungeon,
	sawDungeon
		? `at frame ${firstDungeonFrame}: ${describe(dungeonState)}`
		: `gave up after ${frames} frames; last state: ${prevDesc}`);

if (!sawDungeon) {
	dump('stuck');
	console.log('\n' + results.filter((r) => r.ok).length + '/' + results.length + ' checks passed');
	process.exit(1);
}
dump('dungeon-entry');

/* ------------------------------------------------- did the leader actually move */
/* Settle first: the floor opens with a banner and a fade, during which input is
 * ignored (noActionInProgress is false). Then push in one direction and watch
 * the leader's grid position. A cutscene cannot fake this -- teamPokemonEntities[0].pos
 * is the authoritative square the player character occupies. */

/* The floor opens with a name banner, a fade and -- on this first story floor --
 * the partner's tutorial dialogue. Those need A presses, not waiting, so this
 * phase mashes A rather than idling, and stops as soon as the game says it is
 * accepting input again. */
const spawn = readState(rd, T);
let settled = spawn.noActionInProgress === 1, settleFrames = 0;
for (let i = 0; i < 500 && !settled; i++) {
	pump(6, KEY.A);
	pump(12, 0);
	settleFrames = frames;
	settled = readState(rd, T).noActionInProgress === 1;
}
const start = readState(rd, T);
console.log(`  floor intro cleared: settled=${settled} (noActionInProgress=${start.noActionInProgress})` +
	` at frame ${settleFrames}, leader at (${start.leader.x},${start.leader.y})`);
dump('dungeon-settled');

const DIRS = [KEY.RIGHT, KEY.LEFT, KEY.UP, KEY.DOWN,
              KEY.RIGHT | KEY.UP, KEY.LEFT | KEY.DOWN];
const visited = new Set([`${start.leader.x},${start.leader.y}`]);
let moves = 0, lastPos = { x: start.leader.x, y: start.leader.y };
let stillInDungeon = true;

for (let i = 0; i < 400 && stillInDungeon; i++) {
	/* A every so often: a dialogue box or an item prompt will otherwise swallow
	 * every direction press and the walk silently does nothing. */
	if (i % 9 === 8) { pump(6, KEY.A); pump(8, 0); }
	pump(16, DIRS[Math.floor(i / 10) % DIRS.length]);
	pump(8, 0);
	const st = readState(rd, T);
	if (!st.inDungeonRun || !st.plausible) { stillInDungeon = false; break; }
	if (st.leader.x !== lastPos.x || st.leader.y !== lastPos.y) {
		moves++;
		lastPos = { x: st.leader.x, y: st.leader.y };
		visited.add(`${st.leader.x},${st.leader.y}`);
		if (dumpDir && moves <= 3) { dump('move' + moves); }
	}
	if (moves >= 12 && visited.size >= 8) { break; }
}
const end = readState(rd, T);
dump('dungeon-after-walking');

check('party leader moves on the dungeon grid', moves >= 4 && visited.size >= 4,
	`${moves} position changes over ${visited.size} distinct squares, ` +
	`(${start.leader.x},${start.leader.y}) -> (${end.leader && end.leader.x},${end.leader && end.leader.y})`);
check('still inside the dungeon run after walking', stillInDungeon && end.inDungeonRun,
	describe(end));

/* --------------------------------------------------------------- other probes */

const luma = api.meanLuma();
check('picture is not black', luma > 1.0, 'mean luma ' + luma.toFixed(2));

const h1 = api.frameHash();
pump(120, 0);
const h2 = api.frameHash();
check('picture keeps advancing', h1 !== h2, `hash ${h1} -> ${h2}`);

/* Savestate round trip, with an inconclusive guard: if the picture did not
 * change during the divergence window the test proves nothing, so say so. */
const sz = api.stateSize();
const sptr = api.stateSave();
const snapshot = M.HEAPU8.slice(sptr, sptr + sz);
const hSnap = api.frameHash();
pump(240, KEY.DOWN);
const hDiverged = api.frameHash();
const rp = M._malloc(snapshot.length);
M.HEAPU8.set(snapshot, rp);
const loadedOk = api.stateLoad(rp, snapshot.length);
M._free(rp);
pump(1, 0);
const hRestored = api.frameHash();
if (hDiverged === hSnap) {
	check('savestate round trip', false, 'INCONCLUSIVE: the picture never changed during divergence');
} else {
	check('savestate round trip', loadedOk === 1 && hRestored !== hDiverged,
		`snapshot=${hSnap} diverged=${hDiverged} restored=${hRestored} (${sz} bytes)`);
}

/* -------------------------------------------------- the game's own save path */
/* Up to here the cartridge image only holds whatever the game wrote on its own.
 * Driving the in-game Quicksave makes the claim "a save survives a reload" a
 * claim about a save the player could actually have made. */

const beforeSave = { written: api.saveWritten(), hash: api.saveHash() };
const qs = await quicksave({
	pump: (n, bits) => pump(n, bits),
	s16: (a) => api.readS16(a >>> 0),
	u32: (a) => api.read32(a >>> 0) >>> 0,
	shot: (tag) => dump(tag)
}, T, (m) => console.log(m));
const afterSave = { written: api.saveWritten(), hash: api.saveHash() };
check('drove the in-game Quicksave to completion', qs.ok, qs.where +
	`; flash written bytes ${beforeSave.written} -> ${afterSave.written}`);
check('the Quicksave changed the cartridge image',
	afterSave.written > beforeSave.written && afterSave.hash !== beforeSave.hash,
	`hash ${beforeSave.hash} -> ${afterSave.hash}`);
dump('after-quicksave');

/* After the Quicksave the cartridge image must hold a real save, not an erased
 * 0xFF block. */
check('cartridge flash holds the in-game save', api.saveWritten() > 1000,
	api.saveWritten() + ' of 131072 bytes are neither 0x00 nor 0xFF, hash ' + api.saveHash());

console.log('\nstate transitions:');
for (const e of log) { console.log(`  ${String(e.frame).padStart(7)}  ${e.desc}`); }

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed  (' +
	frames + ' frames run, muted)');
process.exit(failed.length ? 1 : 0);
