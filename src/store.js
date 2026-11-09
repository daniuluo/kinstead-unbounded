// Where this copy keeps things in the browser: saves, settings, window
// places, the guide and the player's name. The gridless copy is put up beside
// the main game on the same site (daniuluo.github.io/kinstead-gridless next to
// daniuluo.github.io/kinstead), and every page of a site shares one browser
// storage, so this copy's names start with a word of its own. The main game's
// start 'hearthvale.' and stay the main game's: its towns would not load
// after this copy had saved over them, and this copy's would not load there.
export const STORE = 'kinstead-gridless.';

// The main game's saves in this browser, which this copy can open (each town
// made over from squares as it loads) but never writes.
export const MAIN_INDEX = 'hearthvale.saves.v1';
export const MAIN_SLOT = (id) => `hearthvale.slot.${id}`;

// The main game, for links and for the message to a player who tries to join
// a town of the other copy.
export const MAIN_SITE = 'https://daniuluo.github.io/kinstead/';
export const THIS_SITE = 'https://daniuluo.github.io/kinstead-gridless/';
