/* Derives the struct offsets the game-state gate needs from the decomp's OWN
 * headers.
 *
 * MUST be compiled by agbcc, via the same preprocess pipeline the Makefile
 * uses -- not by arm-none-eabi-gcc. agbcc is gcc 2.9 and lays these structs out
 * differently: modern gcc makes `EntityInfo` 472 bytes where agbcc makes it
 * 520, which drags every later field of `Dungeon` about 6 KB out of place and
 * silently turns the game-state gate into a garbage read. offsets.sh checks the
 * results against the header comments for exactly that reason.
 *
 * Emits a .rodata array of u32 which offsets.sh turns into JSON.
 */
#include "structs/str_dungeon.h"
#include "structs/dungeon_entity.h"
#include "structs/menu.h"

#define OFS(t, f) ((unsigned long)&(((t *)0)->f))

const unsigned long gVjOffsets[] = {
	sizeof(Dungeon),
	OFS(Dungeon, noActionInProgress),
	OFS(Dungeon, unk1C570),                /* DungeonLocation {u8 id, u8 floor} */
	OFS(Dungeon, teamPokemon),             /* Entity *[MAX_TEAM_MEMBERS] */
	OFS(Dungeon, teamPokemonEntities),     /* Entity  [MAX_TEAM_MEMBERS] */
	OFS(Dungeon, unk181e8),
	OFS(UnkDungeonGlobal_unk181E8_sub, cameraPos),
	sizeof(Entity),
	OFS(Entity, type),
	OFS(Entity, pos),
	OFS(Entity, prevPos),
	OFS(Entity, isVisible),
	OFS(Entity, room),
	OFS(Entity, spawnGenID),
	OFS(Dungeon, unk644),
	OFS(unkDungeon644, fractionalTurn),
	OFS(Dungeon, numItems),
	OFS(Dungeon, tileset),
	OFS(Dungeon, tiles),
	sizeof(EntityInfo),
	sizeof(Tile),
	/* The dungeon menus, so a test can drive them by cursor index rather than
	 * by blind button mashing. */
	sizeof(MenuInputStruct),
	OFS(MenuInputStruct, menuIndex),
	OFS(MenuInputStruct, currPageEntries),
	OFS(MenuInputStruct, totalEntriesCount),
};
