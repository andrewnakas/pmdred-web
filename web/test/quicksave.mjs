/* Drives the in-game Quicksave, so "the save survives a reload" can be a claim
 * about a save the GAME wrote through its own menu, not only about bytes a test
 * poked into the flash buffer.
 *
 * Menu navigation is by cursor index, not by counting button presses: it reads
 * `gDungeonMenu.menuIndex` (MenuInputStruct, src/dungeon_engine.h) out of EWRAM
 * and steps the cursor until it is on the row it wants. Blind mashing through
 * four nested menus is exactly the kind of test that passes by accident.
 *
 * Route, all from the decompilation's own enums:
 *   Start -> MAIN_MENU_OTHERS (3)  -> OTHERS_QUICKSAVE_GIVEUP (1) -> Quicksave (0) -> confirm
 *
 * `io` is { pump(frames, keyBits), s16(addr), u32(addr) }, all possibly async,
 * so the same routine drives the core in node and the page over CDP.
 */

export const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 };

export async function quicksave(io, T, log = () => {}) {
	const menu = T.symbols.gDungeonMenu;
	const O = T.offsets, C = T.constants;
	const idx = async () => await io.s16(menu + O.menuIndex);
	/* src/dungeon_submenu.c sets currPageEntries/entriesPerPage from
	 * gDungeonSubMenuItemsCount when it opens a menu; totalEntriesCount stays 0
	 * for these, so that is the wrong field to look at. */
	const entries = async () => await io.u32(T.symbols.gDungeonSubMenuItemsCount) | 0;
	const inDungeon = async () => ((await io.u32(T.symbols.gDungeon)) >>> 0) !== 0;

	async function tap(bits, hold = 5, rest = 14) {
		await io.pump(hold, bits);
		await io.pump(rest, 0);
	}
	const snap = io.shot || (async () => {});

	/* Step the cursor to `want`, pressing DOWN (menus wrap). Gives up rather
	 * than looping forever if the cursor will not move. */
	async function cursorTo(want, limit = 14) {
		for (let i = 0; i < limit; i++) {
			if (await idx() === want) { return true; }
			const before = await idx();
			await tap(KEY.DOWN, 4, 10);
			if (await idx() === before) { await tap(KEY.UP, 4, 10); }
		}
		return await idx() === want;
	}

	/* 1. Open the dungeon main menu.
	 *
	 * With GBA controls that is a SHORT PRESS OF B, not Start:
	 * `gRealInputs.shortPress & B_BUTTON` is the branch in DungeonHandlePlayerInput
	 * (src/dungeon_main.c) that sets the flags ShowMainMenu is called with. Start
	 * does nothing here, and mashing A is actively wrong -- A on the field is
	 * "attack", so it starts fights and buries the screen in battle messages.
	 * A screenshot was the only thing that said so.
	 *
	 * B also dismisses a pending message box, which is convenient: the same taps
	 * clear the message queue and then open the menu. */
	let opened = false;
	for (let i = 0; i < 24 && !opened; i++) {
		await tap(KEY.B, 4, 18);
		/* The menu is open iff the cursor responds to DOWN. None of the counters in
		 * MenuInputStruct is maintained consistently across these menus; menuIndex is. */
		const before = await idx();
		await tap(KEY.DOWN, 4, 12);
		const after = await idx();
		opened = after !== before;
		if (opened || i % 6 === 5) {
			await snap('qs-open' + i);
			log(`  B attempt ${i}: menuIndex ${before} -> ${after} after DOWN` +
				` (submenuCount=${await entries()})`);
		}
	}
	if (!opened) { return { ok: false, where: 'the dungeon main menu never opened (short-press B)' }; }

	/* 2. "Others". */
	if (!await cursorTo(C.MAIN_MENU_OTHERS)) {
		return { ok: false, where: 'could not put the cursor on Others' };
	}
	log(`  main menu cursor on Others (${C.MAIN_MENU_OTHERS})`);
	await snap('qs-main-others');
	await tap(KEY.A, 6, 24);

	/* 3. "Quicksave or Give Up". The Others menu has 5 or 6 rows depending on
	 *    whether recruiting is allowed on this floor. */
	const othersEntries = await entries();
	log(`  others menu entries=${othersEntries} index=${await idx()}`);
	if (!await cursorTo(C.OTHERS_QUICKSAVE_GIVEUP)) {
		await snap('qs-others-stuck');
		return { ok: false, where: 'could not put the cursor on Quicksave or Give Up' };
	}
	await snap('qs-others');
	await tap(KEY.A, 6, 24);

	/* 4. "Quicksave" is the first row of that submenu. */
	log(`  quicksave/giveup menu entries=${await entries()} index=${await idx()}`);
	if (!await cursorTo(0)) {
		await snap('qs-giveup-stuck');
		return { ok: false, where: 'could not put the cursor on Quicksave' };
	}
	await snap('qs-giveup-menu');
	await tap(KEY.A, 6, 30);

	/* 5. The confirmation prompt, then the save itself, then the game drops back
	 *    to the title screen -- which is what makes gDungeon go NULL. That
	 *    transition is the signal the save actually happened, rather than the
	 *    menu having been cancelled. */
	log(`  confirm prompt entries=${await entries()} index=${await idx()}`);
	await snap('qs-confirm');
	/* "Your adventure to this point will be saved. Is that OK?" crawls in one
	 * character at a time and then waits on a Yes/No whose cursor starts on NO
	 * (AskToQuickSave -> DisplayDungeonYesNoMessage_Async(..., FALSE)). So: let the
	 * text finish, move the cursor UP to Yes, then confirm. Tapping A quickly just
	 * restarts the crawl, and tapping A on the prompt answers No and drops you
	 * back into the menu -- which is exactly what the first attempt did. */
	for (let i = 0; i < 24; i++) {
		await tap(KEY.A, 4, 80);     /* finish the text crawl */
		await tap(KEY.UP, 4, 16);    /* No -> Yes */
		await tap(KEY.A, 4, 40);     /* confirm */
		if (i % 4 === 3) { await snap('qs-confirm' + i); }
		if (!await inDungeon()) {
			/* The dungeon run ends and the game returns to the title screen: that
			 * transition is what distinguishes a real Quicksave from a cancelled
			 * prompt. Let the save actually land in flash before returning. */
			await io.pump(600, 0);
			return { ok: true, where: 'quicksaved; gDungeon released after ' + (i + 1) + ' prompts' };
		}
	}
	return { ok: false, where: 'pressed A through the confirmation but stayed in the dungeon' };
}
