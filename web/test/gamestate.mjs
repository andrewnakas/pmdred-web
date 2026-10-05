/* Reads the game's own state out of emulated EWRAM.
 *
 * Why this exists: Red Rescue Team opens with a long scripted personality quiz
 * — a questionnaire with a cursor, a dialogue box and a text crawl. On a
 * screenshot it is indistinguishable from real menu interaction, and mashing A
 * through it looks exactly like "playing". A picture cannot settle whether the
 * game is being played; the game can.
 *
 * Every address and offset comes from test/gamestate.json, which
 * tools/gen-gamestate.sh generates from the matching build: addresses from
 * pmd_red.sym, struct offsets by compiling the decomp's headers with agbcc.
 * Nothing here is from a wiki, and nothing is hand-typed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadTable(path) {
	const p = path || fileURLToPath(new URL('./gamestate.json', import.meta.url));
	return JSON.parse(readFileSync(p, 'utf8'));
}

/* `rd` is { u8, u16, u32, s16 } over the emulated bus. */
export function readState(rd, T) {
	const S = T.symbols, O = T.offsets, C = T.constants;

	const dungeonPtr = rd.u32(S.gDungeon) >>> 0;
	const quizPtr = rd.u32(S.sPersonalityTestTracker) >>> 0;
	const dungeonFrames = rd.u32(S.gDungeonFramesCounter) >>> 0;

	const out = {
		dungeonPtr,
		quizPtr,
		dungeonFrames,
		inQuiz: quizPtr !== 0,
		/* gDungeon is NULL except between the two assignments at the top and
		 * bottom of RunDungeon_Async (src/run_dungeon.c), i.e. exactly while a
		 * dungeon run is executing. */
		inDungeonRun: dungeonPtr !== 0,
		leader: null,
		floor: null,
		dungeonId: null,
		plausible: false
	};
	if (!out.inDungeonRun) {
		return out;
	}
	/* A pointer into EWRAM, and far enough below the top that the whole
	 * 0x1CEDC-byte struct fits. If this fails the offsets are being read
	 * against something that is not a Dungeon. */
	const ewram = C.EWRAM_BASE;
	if (dungeonPtr < ewram || dungeonPtr > ewram + 0x40000) {
		out.note = 'gDungeon is non-NULL but not an EWRAM pointer: 0x' + dungeonPtr.toString(16);
		return out;
	}

	const loc = dungeonPtr + O.location;
	out.dungeonId = rd.u8(loc);
	out.floor = rd.u8(loc + 1);

	const e = dungeonPtr + O.teamPokemonEntities;   /* teamPokemonEntities[0] */
	out.leader = {
		type: rd.u32(e + O.entityType) >>> 0,
		x: rd.s16(e + O.entityPos),
		y: rd.s16(e + O.entityPos + 2),
		prevX: rd.s16(e + O.entityPrevPos),
		prevY: rd.s16(e + O.entityPrevPos + 2),
		visible: rd.u8(e + O.entityVisible),
		room: rd.u8(e + O.entityRoom),
		spawnGenID: rd.u16(e + O.entitySpawnGenID)
	};
	out.leaderPtr = rd.u32(dungeonPtr + O.teamPokemonPtrs) >>> 0;
	out.noActionInProgress = rd.u8(dungeonPtr + O.noActionInProgress);
	out.fractionalTurn = rd.s16(dungeonPtr + O.unk644 + O.fractionalTurn);

	/* Sanity gate: the struct must read back as a real dungeon, not as
	 * plausible-looking garbage. The leader must be a monster entity, standing
	 * inside the dungeon grid, with the spawn-index counter past its base of 10
	 * (set in dungeon generation), and teamPokemon[0] must point at the inline
	 * entity we just read. */
	const L = out.leader;
	out.plausible =
		L.type === C.ENTITY_MONSTER &&
		L.x >= 0 && L.x < C.DUNGEON_MAX_SIZE_X &&
		L.y >= 0 && L.y < C.DUNGEON_MAX_SIZE_Y &&
		L.spawnGenID >= 10 &&
		out.leaderPtr === e &&
		out.floor >= 1 && out.floor <= 99;
	return out;
}

export function describe(st) {
	if (st.inDungeonRun && st.plausible) {
		return `in dungeon id=${st.dungeonId} B${st.floor} leader at (${st.leader.x},${st.leader.y})` +
			` room=${st.leader.room} spawnGenID=${st.leader.spawnGenID}`;
	}
	if (st.inDungeonRun) {
		return `gDungeon=0x${st.dungeonPtr.toString(16)} but state not yet plausible` +
			(st.leader ? ` (type=${st.leader.type} pos=${st.leader.x},${st.leader.y})` : '') +
			(st.note ? ` — ${st.note}` : '');
	}
	if (st.inQuiz) {
		return `in the personality quiz (sPersonalityTestTracker=0x${st.quizPtr.toString(16)})`;
	}
	return 'not in a dungeon and not in the quiz (title/menu/ground scene)';
}
