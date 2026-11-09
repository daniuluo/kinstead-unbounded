// The wiki's pages. Each page is a list of sections of markup, written as
// functions of the game's own data, so every figure comes from
// src/defs.js, src/config.js or a checked fact (facts.js) and changes when
// the game does. The building pages and the research tree are generated
// whole (catalog.js); the prose here explains how things work.
//
// Keep this in step with the game: a new mechanic, key or setting wants a
// line here too (scripts/site-check.js fails on a new building, research
// project, key, setting or happiness factor the wiki doesn't cover).

import {
  BUILDINGS, CATEGORIES, SERVICES, TRANSIT, RAIL_COST, TECHS, BRANCHES, MERGES, LARGE, ESTATE, ESTATE_TYPES, FARM_JOIN,
  PRODUCE, FRUIT, TRADES, CORNER_SHOPS, NEEDS, RESEARCH_SOURCES, STYLE_TECH, BURY_COST, CAPABILITIES, servicesOf, unlockOf, techForLevel, PLANTINGS, MONUMENTS, REKIND,
  SEAT_STYLES, SEAT_CHAIN, SEAT_RESTYLE, CIVIC_QUARTER, CIVIC_TYPES,
} from '../src/defs.js';
import {
  CONFIG, ROAD_LEVELS, BRIDGE_MULT, TREE_COST, CLEAR_COST, TERRAFORM_COST, ROAD_SALVAGE, DRESSINGS, BOULEVARD, TITLES, SEASONS,
  PERF_DEFAULTS, BATTERY_SAVER, TILT_SHIFT, TILT_BAND, SHADOW_SIZE,
} from '../src/config.js';
import { fact } from './facts.js';
import { bl, tl, pl, k, table, money, pct, esc, fmt, an, ms, CAT_PAGE, pic } from './links.js';

export const GROUPS = [
  ['start', 'Start here'], ['town', 'Running the town'], ['buildings', 'Buildings'], ['grow', 'Growing'],
  ['people', 'People'], ['together', 'Together'], ['options', 'Options'],
];


const minutes = (s) => (s % 60 ? `${fmt(s / 60)} minutes` : `${s / 60} minutes`);
const list = (items) => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
const types = () => Object.keys(BUILDINGS);
const name0 = (t) => BUILDINGS[t].levels[0].name;
const or = (arr) => (arr.length < 2 ? arr.join('') : `${arr.slice(0, -1).join(', ')} or ${arr[arr.length - 1]}`);
const and = (arr) => (arr.length < 2 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);
const providers = (s) => types().filter(t => servicesOf(BUILDINGS[t]).includes(s));
// street dressings or boulevard looks: price, upkeep, scenery and what each needs
const dressTable = (list, what) => table([what, '#Cost a tile', '#Upkeep', '#Scenery', 'Needs'], list.map(d => [
  `<b>${esc(d.name)}</b><br><span class="muted">${esc(d.desc)}</span>`, money(d.cost), money(d.upkeep), `+${fmt(d.appeal)}`,
  [d.unlock ? `${d.unlock} villagers` : '', d.minLevel ? esc(ROAD_LEVELS[d.minLevel].name) : '', d.tech ? tl(d.tech) : ''].filter(Boolean).join(', ') || '—',
]));

// ---------------------------------------------------------- keyboard keys
// Every key the game answers to (scripts/site-check.js compares this with
// src/ui/input.js). keys: what input.js sees (e.key, lower case).
export const KEYS = [
  { show: ['Space'], keys: [' '], what: 'Pause, or carry on at the speed you had' },
  { show: [','], keys: [','], what: 'Normal speed (1×)' },
  { show: ['.'], keys: ['.'], what: 'Fast (4×)' },
  { show: ['/'], keys: ['/'], what: 'Fastest (32×)' },
  { show: ['[', ']'], keys: ['[', ']'], what: 'One speed slower / faster' },
  { show: ['W', 'A', 'S', 'D'], keys: ['w', 'a', 's', 'd'], what: 'Pan the camera (the arrow keys too)' },
  { show: ['←', '↑', '→', '↓'], keys: ['arrowleft', 'arrowup', 'arrowright', 'arrowdown'], what: 'Pan the camera' },
  { show: ['+', '−'], keys: ['+', '=', '-', '_'], what: 'Zoom in / out (or the mouse wheel)' },
  { show: ['Shift', 'W', 'A', 'S', 'D'], keys: ['shift'], what: 'Hold Shift with W A S D (or the arrows) to turn the view (A / D) and tilt it (W lower, S higher)' },
  { show: ['Q', 'E'], keys: ['q', 'e'], what: 'Turn the view a quarter turn anticlockwise / clockwise (from a free angle, to the next quarter turn)' },
  { show: ['Home'], keys: ['home'], what: 'Back to the classic isometric view: the nearest of its four angles, its tilt and the flat isometric camera' },
  { show: ['T'], keys: ['t'], what: 'Switch between the isometric view and the 2D top-down map' },
  { show: ['V'], keys: ['v'], what: 'Hide the interface to see just the town (V or Esc brings it back)' },
  { show: ['1'], keys: ['1'], what: 'Select tool' },
  { show: ['R'], keys: ['r'], what: 'Roads menu' },
  ...CATEGORIES.map(c => ({ show: [c.key], keys: [c.key.toLowerCase()], what: `${esc(c.name)} menu` })),
  { show: ['8'], keys: ['8'], what: 'Terrain menu (raise, lower, level, plant trees)' },
  { show: ['X', 'Delete'], keys: ['x', 'delete'], what: 'Demolish' },
  { show: ['Tab'], keys: ['tab'], what: 'Line a building up along the street while placing or moving it, or place it freely again; with Select roads, switch between picking stretches and dragging a box' },
  { show: ['Z', 'C'], keys: ['z', 'c'], what: 'Turn a building while placing or moving it, any way round (Shift: in small steps; Alt or Ctrl and the mouse wheel too)' },
  { show: ['Enter'], keys: ['enter'], what: 'Finish the transit line you are drawing' },
  { show: ['Backspace'], keys: ['backspace'], what: 'Take back the last stop of a new line, or the last stretch of road picked' },
  { show: ['O'], keys: ['o'], what: 'Data overlays' },
  { show: ['B'], keys: ['b'], what: 'Budget and statistics' },
  { show: ['L'], keys: ['l'], what: 'Transit lines' },
  { show: ['P'], keys: ['p'], what: 'Villagers directory' },
  { show: ['K'], keys: ['k'], what: 'Research' },
  { show: ['I'], keys: ['i'], what: 'Show or hide the Issues panel' },
  { show: ['N'], keys: ['n'], what: 'Hide or show pop-ups' },
  { show: ['M'], keys: ['m'], what: 'Multiplayer: host this town or join one' },
  { show: ['H'], keys: ['h'], what: 'How to play' },
  { show: ['Ctrl', 'S'], keys: ['ctrl+s'], what: 'Quick save to this browser' },
  { show: ['Ctrl', 'Shift', 'S'], keys: ['ctrl+shift+s'], what: 'Download the save as a .json file' },
  { show: ['Esc'], keys: ['escape'], what: 'Close the front window, then cancel the tool, then clear the selection' },
];
const keyCell = (e) => e.show.map(k).join(' ');

// ------------------------------------------------------- the settings
// Every setting by the label the game gives it (scripts/site-check.js
// checks each label in the Settings window is here).
export const SETTINGS = [
  { group: 'Display', rows: [
    ['Pixel-art look', 'On / off', 'The town drawn small with outlines and scaled up crisply. Off is the smooth look: antialiased, with a light haze in the far distance.'],
    ['Pixel size', '1× Finest · 2× Classic · 3× Chunky · 4× Retro', 'How big each pixel of the art is on the screen (pixel-art look only).'],
    ['Soft contact shadows', 'On / off', 'Ambient occlusion: a soft shade where walls meet the ground and in corners.'],
    ['Tilt-shift', 'Off · Subtle · Strong', 'The model-village look (see below).'],
    ['Sharp band', 'Narrow · Normal · Wide', 'How much of the middle stays sharp with tilt-shift on.'],
    ['Always daytime', 'On / off', "The light never goes down: the sky keeps to the day's light (from 8:00 to 16:30, drifting gently back to morning over the night), while the clock, the villagers' days, the seasons and the weather all run on as usual. No lamps or lit windows, as it's never dark."],
  ] },
  { group: 'Camera', rows: [
    ['Projection', 'Isometric · Perspective', 'Isometric is the classic flat view: far things as big as near ones. Perspective sees the town like a real camera: near things bigger, far ones smaller, and a horizon when the view is tilted low. Home or the compass button goes back to isometric.'],
    ['Field of view', '30° · 45° · 60°', 'How wide the perspective camera sees: 30° is nearly flat, 60° has the most depth (perspective only).'],
  ] },
  { group: 'Performance', rows: [
    ['Presets', 'Battery saver · Best look', 'Battery saver sets every choice below to its lightest (and turns soft contact shadows and tilt-shift off); Best look puts them back as they were at first.'],
    ['Frame rate', 'Screen · 60 · 30', 'As fast as the screen refreshes, or capped at 60 or 30 frames a second.'],
    ['Resolution', '100% · 75% · 50%', "The share of the screen's resolution drawn (in pixel-art mode, chunkier pixels instead)."],
    ['Shadows', `High · Medium · Low · Off`, `The sharpness of the shadow map (${SHADOW_SIZE.high}, ${SHADOW_SIZE.medium} or ${SHADOW_SIZE.low} texels across), or no shadows.`],
    ['Smoke & dust', 'Full · Fewer · Off', 'Smoke, dust, sparks, fireworks, snow and rain.'],
    ['Villagers shown', 'Thinned · All · Half · Near view', 'Thinned (the default) draws every villager in a quiet street but only some of them where crowds gather, so the streets of a big town look busy rather than packed (the crowd fades in and out gently as it gathers and thins). All draws every villager, however crowded; Half about half of them; Near view only those near the middle of the view. Those not drawn still live their lives.'],
    ['Draw slowly while paused', 'On / off', 'Only a few frames a second while the game is paused and nothing moves.'],
  ] },
  { group: 'Sound', rows: [
    ['Sound effects', 'On / off', 'Clicks, building, coins and the hiss of rain.'],
    ['Music', 'On / off', 'The soundtrack (also the note button in the top bar).'],
    ['Music volume', 'A slider', 'How loud the soundtrack plays.'],
  ] },
  { group: 'Pop-ups', rows: [
    ['Coins over buildings as they earn', 'On / off', 'The little coins that rise from shops, works and homes.'],
    ['Notices', 'On / off', 'The messages in the corner (a building finished, a family arrived…).'],
    ['Tips when hovering', 'On / off', 'Hover tips over buildings and buttons.'],
    ['Name tag over the selected villager', 'On / off', 'The label over a villager you follow.'],
    ['Warnings over buildings', 'On / off', 'The badges over buildings with no power, water or workers.'],
  ] },
  { group: 'Game', rows: [
    ['Autosave every in-game day', 'On / off', `Saves the town to this browser every day (and every ${CONFIG.AUTOSAVE_SECONDS} seconds, and when you leave the tab).`],
  ] },
  { group: 'Sandbox · this town only', rows: [
    ['Unlimited money', 'On / off', 'Build anything without counting the cost.'],
    ['Every building unlocked', 'On / off', 'No waiting for villagers or research.'],
    ['Upgrades without their needs', 'On / off', 'Upgrade without the happiness, services or electricity a level asks for.'],
    ['Instant building', 'On / off', 'No builders needed: buildings appear at once.'],
  ] },
];

// ------------------------------------------------------------------ pages
export const PAGES = [
  // ======================================================= start here
  {
    id: 'start', title: 'Getting started', icon: 'flag', group: 'start',
    summary: 'Kinstead is a cozy isometric village builder that runs in your browser. Here is how a village begins.',
    sections: () => [
      { id: 'about', title: 'What Kinstead is', html: `
        <p>You lay out a village in a green valley: streets, cottages, a market, a well. Families move in from the edge of the map, find work and school places, and go about their day. As the village grows you upgrade its buildings, research new ones, join neighbours into bigger buildings, and keep everyone housed, employed, supplied and happy, until the hamlet is a market town or a cathedral city.</p>
        <p>The whole town is drawn in real 3D and shown as crisp pixel art, from a classic 2:1 isometric angle that you can turn a quarter at a time, or turn and tilt freely, down to the rooftops or straight overhead, through a flat isometric or a perspective lens. Everything in it, every house, villager and tree, is made in code from a seed, so no two buildings look the same: two family houses side by side differ in their plan, their roofs and their porches, not just their colours (see ${pl('styles/forms', 'shapes')}).</p>
        <p>Kinstead is free and runs in any modern browser with WebGL: there's nothing to install, and your towns are saved in your browser (or to a file).</p>
        <p><b>Kinstead Unbounded has no grid.</b> A building stands wherever you put it, at any angle, turning by itself to face the street; roads are drawn as curves along the stroke of the road tool, meeting in rounded junctions at whatever angle; fields are squares of farmland at the farm's angle. Where these pages say <i>tiles</i>, read <i>units</i>: a unit is the width of a cottage's plot. There are no diagonal streets or boulevards here (a curve already runs any way), and a building turns rather than being nudged on a square plot. Towns saved by the main game load here, each plot standing where it stood; towns saved here are of a newer kind that the main game can't load. See ${pl('roads/curves', 'curving roads')} and ${pl('construction/turn', 'turning buildings')}.</p>` },
      { id: 'title', title: 'The title screen', html: `
        <p>Behind the title card a little demo village goes about its evening. The buttons:</p>
        ${list([
          '<b>Continue</b> loads the town you saved last (it only shows when there is one).',
          '<b>New village</b> starts a town: pick a name, a seed, a valley size and how high the land round it stands, or a ready-made ' + pl('starters', 'starter town') + '.',
          '<b>Load a save…</b> lists the towns saved in this browser, and loads a <code>.json</code> save file. Towns the main game saved in this browser are listed too, under <b>From the main game</b>: one opens here without the grid, and its save in the main game stays as it was.',
          '<b>Multiplayer…</b> hosts a town for friends or joins theirs with an invite code (' + pl('multiplayer', 'Multiplayer') + ').',
          '<b>Merge villages…</b> joins two saved towns into one valley (' + pl('merging', 'Merging villages') + ').',
        ])}
        <p>The first time you visit, the game goes straight to the new-village window.</p>` },
      { id: 'new', title: 'Starting a village', html: `
        <p>In the new-village window you can name the town (or take a suggested name), type or roll a seed, and pick a valley size: <b>Small ${fact('sizes', 0)}×${fact('sizes', 0)}</b>, <b>Medium ${fact('sizes', 1)}×${fact('sizes', 1)}</b>, <b>Large ${fact('sizes', 2)}×${fact('sizes', 2)}</b> or <b>Huge ${fact('sizes', 3)}×${fact('sizes', 3)}</b> tiles. Every seed grows a different valley of rivers, lakes, hills, woods and rocky slopes. <b>The land round it</b> sets how high it stands: <b>Gentle</b>, a valley with a hill or two; <b>Hilly</b> (the default), the valley floor ringed by highland behind steep escarpments, broken by a few broad slopes where a road can climb, rivers cutting gorges through it; or <b>Mountains</b>, higher still, with a second tier further out and peaks on it. The village is always founded on the valley floor. Climbing takes time (see ${pl('transport/trips', 'getting about')}), so on high ground a gondola up the escarpment can beat any road. The starter towns keep their own valleys.</p>
        <p><b>Start from</b> chooses an empty valley or one of the ${pl('starters', 'starter towns')}. An empty valley comes with a road in from the edge of the map, a ${bl('townhall')}, a ${bl('well')}, a ${bl('market')} and two ${bl('house', 0, 'cottages')} with their founding families, and ${money(CONFIG.START_MONEY)} in the treasury.</p>
        <p>Four ${pl('settings/sandbox', 'sandbox switches')} can be ticked for a new game: unlimited money, every building unlocked, upgrades without their needs, and instant building.</p>` },
      { id: 'first', title: 'Your first days', html: `
        <ol>
          <li><b>Homes.</b> Build ${bl('house', 0, 'cottages')} along the road (Homes menu, ${k('2')}). Builders from the ${bl('builder')} walk out and put them up; then families move in from the edge of the map.</li>
          <li><b>Work.</b> Give the grown-ups jobs: ${bl('market', 0, 'market stalls')}, ${bl('farm', 0, 'farms')}, ${bl('lumber', 0, 'woodcutters')}, ${bl('fishery', 0, 'fishing huts')}. The <b>RCI</b> bars in the top bar show whether homes, shops or industry are wanted most.</li>
          <li><b>Services.</b> Wells give every home on the roads running water through the mains. Cover the homes with health care, schooling and safety (Services, ${k('5')}), and add gardens and greens (Parks, ${k('6')}). ${pl('coverage', 'Services and coverage')} explains reach.</li>
          <li><b>Upgrades.</b> Happy, well-served homes can be upgraded: a Cottage becomes a Family House, then a grand ${bl('villa')} or a block of ${bl('flats', 0, 'Townhouse Flats')}. Select a building to see its upgrades and what they need.</li>
          <li><b>Research.</b> Press ${k('K')} and pick a project: new buildings, upgrade levels, styles and abilities such as ${pl('joins', 'joining neighbours')}. The town hall, schools and chapels earn the points.</li>
          <li><b>Power and water.</b> Bigger works and the grandest homes need ${pl('power-water', 'electricity and running water')}. A badge over a building shows what it lacks, and its panel says what to do.</li>
          <li><b>Transport.</b> As the town spreads, link ${bl('coachstop', 0, 'coach stops')} into lines, and later lay ${pl('transport/rail', 'railway track')} between stations.</li>
        </ol>
        <p>Press ${k('H')} in the game at any time for a short guide.</p>` },
      { id: 'titles', title: 'From hamlet to market town', html: `
        <p>The town's title, under its name in the top bar, grows with its population:</p>
        ${table(['Title', '#Villagers'], TITLES.map(t => [esc(t.name), t.pop ? `${fmt(t.pop)}+` : 'from the start']))}
        <p>Each new title is celebrated with fireworks. Many buildings and upgrade levels also wait for a number of villagers: the building pages list them as "Unlocks at".</p>` },
      { id: 'saving', title: 'Saving and loading', html: `
        ${list([
          `<b>Autosave.</b> The town is saved to this browser every in-game day (Settings → Game), every ${CONFIG.AUTOSAVE_SECONDS} seconds whatever the speed, and whenever you switch away from or close the tab. When a different town takes the autosave (say you start a new village), the last one is kept as <b>Previous town</b>.`,
          `<b>Save slots.</b> ${k('Ctrl')} ${k('S')} saves at once; the 💾 button opens the Save window with every slot, each with a download button.`,
          `<b>Files.</b> <b>Download save (.json)</b> at the top of the Save window, or ${k('Ctrl')} ${k('Shift')} ${k('S')}. Drop a <code>.json</code> save onto the game to load it.`,
        ])}
        <p>Saves are kept per website, not per page, so a town saved anywhere on this site can be continued from the home page's <b>Continue</b> button too. What's kept in the browser is packed to about a third of its size, so even the Metropolis fits; downloaded files are plain JSON.</p>` },
    ],
    see: ['controls', 'starters', 'construction'],
  },
  {
    id: 'controls', title: 'Controls and keys', icon: 'keyboard', group: 'start',
    summary: 'Mouse, touch and every keyboard shortcut.',
    sections: () => [
      { id: 'mouse', title: 'Mouse and touch', html: `
        ${table(['Do this', 'To'], [
          ['Left-click', 'Select a building, villager or road; place what you are holding'],
          ['Left-drag (Select tool)', 'Pan: the ground under the pointer stays under it, at any angle'],
          ['Right-drag', 'Pan, whatever tool you hold'],
          ['Middle-drag, or Shift + right-drag', 'Turn the view (drag across) and tilt it (drag down to look from higher, up to look out toward the horizon)'],
          ['Drag with a road, track, field or demolish tool', 'Lay a line of road or track, or sweep a box'],
          ['Mouse wheel', 'Zoom, towards the pointer'],
          ['Right-click', 'Drop the tool you are holding, or clear a road pick'],
          ['Shift-click (Select roads)', 'Add another stretch of road to the pick'],
          ['One finger (touch)', 'Tap to select or place; drag to pan'],
          ['Two fingers (touch)', 'Pinch to zoom, drag to pan, twist to turn the view round the point between them'],
          ['Two fingers side by side, dragged up or down together (touch)', 'Tilt the view: up toward the horizon, down to look from above'],
        ])}
        <p>On a phone the windows open across the middle at full width, the building panel sits along the bottom and the toolbar scrolls sideways.</p>` },
      { id: 'keys', title: 'Keyboard shortcuts', html: table(['Key', 'Does'], KEYS.map(e => [keyCell(e), e.what])) +
        `<p>With the interface hidden (${k('V')}) only the camera and speed keys answer, and ${k('V')} or ${k('Esc')} brings it back. Shortcuts don't fire while you type in a box.</p>` },
      { id: 'views', title: 'Turning the view and the 2D map', html: `
        <p>${k('Q')} and ${k('E')} (or the turn buttons beside <b>2D</b> in the top bar) swing the camera a quarter turn around the ground at the middle of the screen, so you can see the town from all four sides. The sun stays where it is in the sky, so the shadows keep falling the same way and the far side of the town is the shaded side.</p>
        <p>${k('T')} or the <b>2D</b> button swings the camera straight down for a grid-aligned map, which turns too. Zoom with the wheel or the <b>+</b>/<b>−</b> buttons, from the whole valley right down to a single villager, near enough to see their goggles.</p>` },
      { id: 'free', title: 'Turning and tilting freely', html: `
        <p>The camera turns to any angle and tilts anywhere from just above the horizon (8°) to straight down. Drag with the middle mouse button, or hold ${k('Shift')} and drag with the right one: across turns the town with the pointer, down tilts the view to look from higher, up lowers it toward the horizon. On the keyboard hold ${k('Shift')} with ${k('A')} ${k('D')} to turn and ${k('W')} ${k('S')} to tilt (the arrow keys too). On a touch screen, twist two fingers to turn the town round the point between them, or drag two fingers held side by side up or down together to tilt it.</p>
        <p>From a free angle ${k('Q')} and ${k('E')} turn to the next quarter turn that way. The 2D map (${k('T')}) remembers the angle and tilt you had and goes back to them; tilting the map down by hand leaves it where you are.</p>
        <p>The compass button beside the turn buttons turns with the view and is faint while the view is the classic one. It, or ${k('Home')}, brings the classic view back: the nearest of the four classic angles, the 2:1 isometric tilt (26.6°), and the flat isometric camera if you were using the perspective one.</p>
        <p>${pl('settings/camera', 'Settings → Camera')} switches to a <b>perspective</b> camera, which sees the town like a real one: near things bigger, far ones smaller, and the valley running off to a horizon when it is tilted low. Zoomed right in and tilted low it looks down the streets among the houses. The middle of the screen keeps the scale the isometric view has at the same zoom, so switching keeps what you were looking at.</p>
        <p>Everything works at any angle: picking buildings, villagers and tiles under the pointer, zooming toward it, shadows, the haze, tilt-shift and the pixel art, which snaps to whole pixels whenever the camera stops.</p>` },
      { id: 'hide', title: 'Hiding the interface', html: `
        <p>The eye button in the top bar, or ${k('V')}, hides every panel, button and pop-up to leave just the town, for a picture or to take it in. The camera, zoom, turning and game speed still work, while clicks on the town do nothing. ${k('V')}, ${k('Esc')} or the faint <b>Show interface</b> button in the corner brings it all back.</p>` },
      { id: 'windows', title: 'Windows, overlays and the Issues panel', html: `
        <p>Drag a window by its title bar and keep several open at once; ${k('Esc')} closes the front one. Windows stay on screen when the browser shrinks or a phone turns.</p>
        <p><b>Overlays</b> (${k('O')}) colour the map by happiness, water, health, education, safety, culture, power, scenery or pollution, or show the transit routes.</p>
        <p>The <b>Issues</b> panel in the lower left (${k('I')}) lists the town's bottlenecks: homes out of reach of health care, schools or safety, school places short, power or water short, workplaces stopped or slowed for want of power, water or workers, sites waiting for builders, skilled jobs nobody can fill. Click an entry to jump to the buildings involved, one after another.</p>
        <p>The <b>building guide</b> shows every level of a building and the paths it can take: hover a card in a build menu for a summary, pick it for the full guide, and press <b>All paths</b> (or <b>Paths</b> in a building's panel) for a tree of everything it can become.</p>` },
    ],
    see: ['start', 'settings'],
  },

  // ===================================================== running the town
  {
    id: 'economy', title: 'Money and the budget', icon: 'payments', group: 'town',
    summary: 'Where the coins come from, where they go, and what things cost.',
    sections: () => [
      { id: 'income', title: 'Where money comes from', html: `
        ${list([
          `<b>Taxes</b> from every grown-up and pensioner, more from those in work and from grander homes (${pl('taxes', 'Taxes')}).`,
          `<b>Commerce</b>: shops, taverns and offices earn their <i>earnings</i> (coins a worker a day) for every job that is filled, and markets, shops and pubs a little more on every visit. Powered businesses earn ${pct(fact('poweredIncome') - 1)} more.`,
          '<b>Industry</b>: farms, woodcutters, fisheries, workshops and the rest earn per worker too, farms by what they grow and woodcutters by the trees around them.',
          '<b>Fares</b> from villagers riding the coaches and trains.',
        ])}
        <p>A workplace earns in proportion to how well it works: a half-staffed shop earns half, and one short of power or water earns less (see ${pl('power-water/needs', 'What needs power or water')}).</p>` },
      { id: 'spending', title: 'Where it goes', html: `
        ${list([
          '<b>Upkeep</b> of buildings: most services, utilities and transit stops cost coins every day (each building page lists its upkeep).',
          `<b>Roads</b>: ${and(ROAD_LEVELS.filter(Boolean).map(r => `${esc(r.name.toLowerCase())} ${money(r.upkeep)}`))} a tile a day, plus any ${pl('roads/dress', 'street dressing')} or ${pl('roads/boulevards', 'boulevard look')}, and railway track.`,
          `<b>Transit</b>: every coach, train or gondola cabin on a line costs its upkeep each day (${money(TRANSIT.coach.upkeep)} a coach, ${money(TRANSIT.rail.upkeep)} a train, ${money(TRANSIT.gondola.upkeep)} a cabin).`,
          '<b>Building work</b>: building, upgrading, joining, moving and restyling are paid for when you order them.',
        ])}` },
      { id: 'costs', title: 'What things cost', html: table(['Thing', '#Price'], [
        ...ROAD_LEVELS.filter(Boolean).map(r => [`${esc(r.name)} (a tile)${r.unlock ? ` · from ${r.unlock} villagers` : ''}`, money(r.cost)]),
        [`A bridge tile`, `× ${BRIDGE_MULT}`],
        ['Railway track (a tile)', money(RAIL_COST)],
        ['Planting a tree', money(TREE_COST)],
        ['Clearing a tree', money(CLEAR_COST)],
        ['Raising, lowering or levelling a tile', money(TERRAFORM_COST)],
        ['A neighbouring plot of land', money(CONFIG.PLOT_PRICE)],
        ['A field of farmland', money(CONFIG.FIELD_COST)],
        ['Burying the power lines (a road tile)', money(BURY_COST)],
        ['A coach / a train / a gondola cabin', `${money(TRANSIT.coach.vehicleCost)} / ${money(TRANSIT.rail.vehicleCost)} / ${money(TRANSIT.gondola.vehicleCost)}`],
        ['Joining two buildings', `${money(fact('joinCost', 0))} + ${pct(fact('joinCost', 1))} of the new level`],
        ['Moving a building', `${money(fact('moveCost', 0))} + ${pct(fact('moveCost', 1))} of its worth`],
        ['Restyling', `${pct(fact('restyle', 0))} of its worth (at least ${money(fact('restyle', 1))})`],
      ]) + '<p>A building is "worth" what its levels cost to build, together (and more on a bigger plot).</p>' },
      { id: 'refunds', title: 'Money back', html: `
        ${list([
          `Demolishing a building pays back ${pct(fact('demolishRefund'))} of what it is worth.`,
          `Taking up a road, or downgrading it, pays back ${pct(ROAD_SALVAGE)} of the difference in price; the same goes for a street dressing.`,
          `Taking a field out pays back ${pct(0.25)} of its price.`,
        ])}` },
      { id: 'demand', title: 'Demand: the RCI bars', html: `
        <p>The three bars at the end of the top bar show what the town wants most: <b style="color:#00a000">R</b>esidential (homes: more jobs than free homes, and a happy town), <b style="color:#0050d0">C</b>ommercial (shops and pubs for a growing population) and <b style="color:#b08000">I</b>ndustrial (work for the grown-ups). A full bar means build more of that kind.</p>` },
      { id: 'budget', title: 'The budget window', html: `
        <p>Press ${k('B')}, or click the coins in the top bar, for the budget: today's income by source (taxes, commerce, industry) and spending (services, buildings, roads, transit), charts of the town's history, and the tax slider.</p>` },
    ],
    see: ['taxes', 'happiness', 'construction'],
  },
  {
    id: 'taxes', title: 'Taxes', icon: 'account_balance', group: 'town',
    summary: 'The tax rate, who pays it, and what it does to happiness.',
    sections: () => {
      const homeRows = [];
      for (const t of types()) {
        const d = BUILDINGS[t];
        if (d.cat !== 'residential' && !d.levels.some(L => L.housing)) continue;
        d.levels.forEach((L, i) => { if (L.housing) homeRows.push([bl(t, i), d.cat === 'residential' ? esc(d.name) : `${esc(d.name)} (with homes)`, `× ${fmt(L.tax ?? 1 + 0.25 * i)}`]); });
      }
      const effect = (rate) => (rate > fact('happyTax', 0) ? -(rate - fact('happyTax', 0)) * fact('happyTax', 1) : (fact('happyTax', 0) - rate) * fact('happyTax', 2));
      return [
        { id: 'rate', title: 'The tax rate', html: `
          <p>The tax rate is set in the budget window (${k('B')}), from ${fact('taxRange', 0)}% to ${fact('taxRange', 1)}%. A new town starts at ${fact('taxDefault')}%. Higher taxes bring in more but make every home less happy; lower taxes cheer them up:</p>
          ${table(['Rate', '#Happiness of every home'], [0, 5, 10, 12, 15, 20].filter(r => r <= fact('taxRange', 1)).map(r => [`${r}%`, `${effect(r) > 0 ? '+' : ''}${fmt(effect(r))}`]))}` },
        { id: 'who', title: 'Who pays', html: `
          <p>Each day, at the standard ${fact('happyTax', 0)}% rate:</p>
          ${list([
            `a grown-up in work pays ${money(fact('taxWorker', 0))}, times their home's tax factor (below);`,
            `a grown-up without work pays ${money(fact('taxWorker', 1))};`,
            `a pensioner pays ${money(fact('taxElder'))};`,
            'children pay nothing.',
          ])}
          <p>All of it scales with the rate (at 20% twice as much) and with the town hall's bonus. So a town of grand homes full of working families pays far more than one of crowded flats.</p>` },
        { id: 'homes', title: 'Tax factors of homes', html: table(['Home', 'Kind', '#Tax factor'], homeRows) },
        { id: 'townhall', title: 'The town hall', html: `
          <p>Each level of the ${bl('townhall', 0, 'town hall')}, and of the Capitol and the Parliament it can grow into, raises taxes across the whole town:</p>
          ${table(['Level', '#Town tax', '#Research a day'], SEAT_CHAIN.flatMap(t => BUILDINGS[t].levels.map((L, i) => [bl(t, i), L.taxBonus ? `+${pct(L.taxBonus)}` : '—', `${RESEARCH_SOURCES[t][Math.min(i, RESEARCH_SOURCES[t].length - 1)]}`])))}
          <p>There is only one in a town. Law courts, a museum, an opera house and a library near it make a civic quarter, which adds ${pct(CIVIC_QUARTER.tax)} more for each kind (${pl('civic', 'The seat of government')}).</p>` },
      ];
    },
    see: ['economy', 'happiness'],
  },
  {
    id: 'happiness', title: 'Happiness', icon: 'sentiment_satisfied', group: 'town',
    summary: 'What makes a home happy, and why it matters: newcomers, leavers and upgrades.',
    sections: () => [
      { id: 'factors', title: 'What feeds it', html: `
        <p>Every home has a happiness from 0 to 100, the sum of these, and the town's figure in the top bar is the average over every villager:</p>
        ${table(['Factor', '#Points', 'How to get it'], [
          ['Everyday life', `${fact('happyBase')}`, 'Every home starts here'],
          ['Water', `+${fact('happyWater')}`, 'Running water: road-connected to a well, pump or water tower, with enough to go round'],
          ['Health care', `+${fact('happyHealth')}`, `A clinic or hospital in reach (${pl('coverage', 'coverage')})`],
          ['Schooling', `+${fact('happyEducation')}`, 'A school in reach'],
          ['Safety', `+${fact('happySafety')}`, 'A watch post or fire station in reach'],
          ['Culture', `+${fact('happyCulture')}`, 'A chapel, hall or theatre in reach'],
          ['Electricity', `+${fact('happyPower')}`, 'The home is powered'],
          ['Scenery', `up to +${fact('happyAppeal', 0)}`, 'Trees, water, gardens and parks, grand homes, dressed streets, boulevards and buried power lines nearby'],
          ['Shops nearby', `+${fact('happyShops', 1)}`, `A shop, café or tavern within ${fact('happyShops', 0)} tiles`],
          ['Play', `+${fact('happyPlay')}`, 'For homes with children: a play area or playing field whose reach takes the home in'],
          ['Allotment', `+${fact('happyPotter')}`, 'For homes with elders: allotments whose reach takes the home in (the elders go and dig there in the mornings)'],
          ['Transport', `+${fact('happyTransit', 1)}`, `A coach stop or station within ${fact('happyTransit', 0)} tiles`],
          ['Garden deal', `+${fact('happyLand', 0)} / +${fact('happyLand', 1)}`, 'A home that bought a garden strip from a neighbour (or sold one)'],
          ['Taxes', `${fmt(-(fact('taxRange', 1) - fact('happyTax', 0)) * fact('happyTax', 1))} to +${fmt(fact('happyTax', 0) * fact('happyTax', 2))}`, `Below ${fact('happyTax', 0)}% cheers them, above it costs ${fact('happyTax', 1)} a point (${pl('taxes', 'Taxes')})`],
          ['Smoke', `down to −${fact('happySmoke')}`, 'Works too close: the building pages list how far each one smokes'],
          ['Crowding', `−${fact('happyCrowded')}`, 'More people than rooms'],
          ['Work', `down to −${fact('happyJobs')}`, 'Grown-ups in the home looking for work (all of them: the full amount)'],
          ['Road', `−${fact('happyRoad')}`, "Not connected to the town's roads"],
        ])}
        <p>The best a home can do is ${fact('happyBase') + fact('happyWater') + fact('happyHealth') + fact('happyEducation') + fact('happySafety') + fact('happyCulture') + fact('happyPower') + fact('happyAppeal', 0) + fact('happyShops', 1) + fact('happyPlay') + fact('happyPotter') + fact('happyTransit', 1) + fact('happyLand', 0) + fact('happyTax', 0) * fact('happyTax', 2)} before the cap of 100.</p>` },
      { id: 'see', title: 'Seeing what is missing', html: `
        <p>Click the happiness figure in the top bar for the whole town: how many points each factor adds now, how many the average villager could gain, how many homes miss out, and a button that takes you to the fix. A home's panel lists its own gaps first, with what to do, and each villager's page shows their mood and what would make them happier. The Happiness overlay (${k('O')}) colours the map.</p>` },
      { id: 'arrive', title: 'Newcomers and leavers', html: `
        <p>New households arrive from the edge of the map each day and take up empty homes, but only homes with a happiness of at least ${fact('arriveHappy')}. More come when the town is happy and has free jobs (at most ${CONFIG.ARRIVE_MAX} a day). A home below ${fact('leaveHappy', 0)} is in trouble: each day there is a ${pct(fact('leaveHappy', 1))} chance that half its people pack up and leave.</p>` },
      { id: 'mood', title: "A villager's mood", html: `
        <p>Each villager's mood is their home's happiness, ${fact('moodWork', 0)} points more for a grown-up in work and ${fact('moodWork', 1)} less for one looking for work (students are neither).</p>` },
      { id: 'upgrades', title: 'Happiness and upgrades', html: `
        <p>Most home upgrades need the home itself to be happy enough, as well as services in reach: a Family House needs ${BUILDINGS.house.levels[1].req.happiness}% and water, a ${BUILDINGS.villa.levels[0].name} ${BUILDINGS.villa.levels[0].req.happiness}%, water and health care. The building pages list every level's needs.</p>` },
    ],
    see: ['coverage', 'taxes', 'people'],
  },
  {
    id: 'coverage', title: 'Services and coverage', icon: 'medical_services', group: 'town',
    summary: 'How clinics, schools, watch posts and chapels reach the homes around them.',
    sections: () => {
      const svc = Object.entries(SERVICES).filter(([s]) => s !== 'water' && s !== 'power');
      return [
        { id: 'reach', title: 'How reach works', html: `
          <p>A service building covers every tile within its <b>reach</b> (its radius in tiles, from the middle of its plot), as long as it stands on the town's roads. A home inside the reach has that service, for its happiness and for upgrades. The overlays (${k('O')}) show each service's reach on the map.</p>
          <p>Reach depends on staff: a service with every job filled reaches its full radius, one half staffed reaches ${pct(fact('reachStaff') + (1 - fact('reachStaff')) / 2)} of it, and one with nobody in it reaches nothing. Water and electricity are different: they come through the mains and the wires (${pl('power-water', 'Power and water')}).</p>` },
        { id: 'kinds', title: 'The services', html: table(['Service', 'Buildings that give it'], svc.map(([s, S]) => [`${S.icon} ${esc(S.name)}`, providers(s).map(t => bl(t, 'type')).join(', ')])) },
        { id: 'schools', title: 'School places', html: `
          <p>A school has a fixed number of <b>places</b> (its seats), and only as many as its teachers can manage. Children go to the nearest school with room that teaches their stage. ${pl('people/school', 'Schooling')} explains the stages.</p>` },
        { id: 'crowds', title: 'Crowds and visitors', html: `
          <p>Every place villagers visit holds only so many at once: shops, pubs and theatres, chapels, clinics (the old see the doctor most often) and parks. A full place sends people on to the nearest one of the same kind with room, or they stay home. The building pages give each one's "Visitors at once"; hover over a building or open it to see its visitors now.</p>
          <p>Out on the streets villagers keep out of each other's way: they step to one side to pass, queue behind someone slower, take turns in a doorway (those going in wait for those coming out) and wait at the kerb for a coach or a cart. Strollers in a park pick a spot nobody stands on.</p>` },
        { id: 'working', title: 'Staff, power and water', html: `
          <p>Services, schools and utilities only work as well as they are staffed: a clinic with nobody in it cares for nobody. Some also need power or running water past their first levels. ${pl('power-water/needs', 'What needs power or water')} lists every one.</p>` },
      ];
    },
    see: ['services', 'happiness', 'power-water'],
  },
  {
    id: 'power-water', title: 'Power and water', icon: 'bolt', group: 'town',
    summary: 'Wells and pumps, generators and wires, and what stops without them.',
    sections: () => {
      const util = (key) => types().flatMap(t => BUILDINGS[t].levels.map((L, i) => (L[key] ? [bl(t, i), `${fmt(L[key])}${key === 'kw' ? ' kW' : ''}`, L.jobs ? `${L.jobs}` : '—', money(L.cost), unlockOf(t, i) ? `${unlockOf(t, i)}` : '—', techForLevel(t, i) ? tl(techForLevel(t, i)) : '—'] : null)).filter(Boolean));
      const needRows = [];
      for (const [t, n] of Object.entries(NEEDS)) {
        if (!BUILDINGS[t]) continue;
        for (const kind of ['power', 'water']) {
          const x = n[kind];
          if (!x) continue;
          needRows.push([bl(t, x.from), kind === 'power' ? (x.use === 'machines' ? 'Power (machines)' : 'Power (light)') : 'Running water', esc(x.what), x.without ? `${pct(x.without)}` : '<b>stops</b>']);
        }
      }
      return [
        { id: 'water', title: 'Water', html: `
          <p>Wells, pumps and water towers draw water for a number of people each (Utilities menu, ${k('U')}). The water flows through mains under the streets to <b>every road-connected building</b>, so it doesn't matter where on the roads a well stands. The town needs as much as it has villagers; when demand outstrips supply, some homes go dry. A well or pump short of hands draws less (with nobody there, ${pct(fact('waterUnstaffed'))}).</p>
          ${table(['Building', '#Water for', '#Jobs', '#Cost', '#Unlocks at', 'Research'], util('supply'))}
          <p>A home without running water can't upgrade, expand or grow its family, and loses ${fact('happyWater')} happiness.</p>` },
        { id: 'power', title: 'Electricity', html: `
          <p>Water wheels (on a river bank), wind generators and coal power stations make electricity, which runs along the streets on poles and wires to every road-connected building. Each building takes ${fact('powerDemand', 0)} kW, plus ${fact('powerDemand', 1)} kW for every resident it houses and ${fact('powerDemand', 2)} kW for every job. When the town is short, some buildings go dark. A generator short of hands makes less.</p>
          ${table(['Building', '#Power', '#Jobs', '#Cost', '#Unlocks at', 'Research'], util('kw'))}
          <p>Powered homes are happier (+${fact('happyPower')}) and their windows light properly instead of by candle; powered businesses earn ${pct(fact('poweredIncome') - 1)} more; street lamps light up at night; and the grandest upgrades need electricity. ${tl('electricity')} unlocks the first generators.</p>` },
        { id: 'needs', title: 'What needs power or water', html: `
          <p>Early buildings (cottages, wells, farms, woodcutters, builders) need none of this. From the level shown, these need power or water to work fully; without it they do only the share given (and stopped works go dark, their chimneys cold):</p>
          ${table(['From', 'Needs', 'For', '#Without it'], needRows)}
          <p>Small badges over a building show everything it is missing (red for what stops it, amber for what holds it back), the building panel says what to do, and the Issues panel groups them. The town hall and railway stations work without staff.</p>` },
        { id: 'cables', title: 'Underground cables', html: `
          <p>With ${tl('cables')} researched, the power lines can be buried, one street at a time from a road's panel (${money(BURY_COST)} a tile) or the whole town at once from a generator's. The poles and wires come down, and the street is a little nicer to live on.</p>` },
      ];
    },
    see: ['utilities', 'coverage'],
  },
  {
    id: 'transport', title: 'Transit', icon: 'directions_bus', group: 'town',
    summary: 'Horse-drawn coach lines, steam railways and gondolas on a cable over the rooftops.',
    sections: () => {
      const T = (m) => TRANSIT[m];
      const row = (m) => [esc(T(m).name), money(T(m).vehicleCost), money(T(m).upkeep), money(T(m).fare), `${T(m).capacity}`, `${fmt(T(m).speed)}`, `${T(m).maxVehicles}`, bl(T(m).stopType)];
      return [
        { id: 'modes', title: 'Coaches, trains and gondolas', html: table(['Mode', '#Each vehicle', '#Upkeep a day', '#Fare', '#Seats', '#Speed (tiles/s)', '#Most on a line', 'Stops'], [row('coach'), row('rail'), row('gondola')]) +
          `<p>Villagers on long trips walk to a stop, wait there, ride, and pay the fare. A home within ${fact('happyTransit', 0)} tiles of a stop is happier (+${fact('happyTransit', 1)}).</p>` },
        { id: 'trips', title: 'Getting about', html: `
          <p>Hills take climbing. On foot, each step up is slower by Naismith's rule: every unit of height climbed takes as long as ${CONFIG.CLIMB} tiles along the flat, and a steep way down is a little slower too. Coach and cart horses slow on a hill as well, half as much. A gondola climbs for its riders.</p>
          <p>Before a long trip a villager weighs it up and takes whatever gets them there soonest: the walk all the way, climbing counted, or a ride. A ride counts the walk to the stop and from the last one (climbing counted), a gondola station's stairs up and down, the wait (half the time between cabins, so more cabins mean shorter waits) and the ride itself. They will take two lines if that is quicker, changing where both call, at a shared coach stop or a ${bl('gondolahub', 0, 'Gondola Interchange')} (stepping out of one cabin and across the deck to the other line's berth). Each ride pays its own fare.</p>
          <p>The lines window shows, for each line, how many trips chose it this session and about how much quicker than walking each was, how many of them changed lines, and how far a gondola line climbs.</p>` },
        { id: 'coach', title: 'Coach lines', html: `
          <p>Build ${bl('coachstop', 0, 'coach stops')} beside the road (Transit menu, ${k('7')}), then make a line: pick the stops in order, press ${k('Enter')} to finish (${k('Backspace')} takes back the last stop). The coaches loop between the stops along the roads. Coaches and goods carts keep to their side of the road, clear of the pavements, follow its curve round a bend and keep their distance behind the one ahead. Each makes sure of its whole way through a junction before it goes in, and doesn't go in without room on the far side; those whose ways don't cross go through together, and whoever has waited longest to cross goes next. They stop for villagers in the way, and villagers wait at the kerb for a coach coming. Those waiting for one sit on the stop's bench while there's room, and stand about by it when it's full. The lines window (${k('L')}) lists every line, with its riders, vehicles and colour.</p>` },
        { id: 'rail', title: 'Railways', html: `
          <p>${tl('railways')} unlocks track (${money(RAIL_COST)} a tile, with curves) and ${bl('station', 0, 'stations')}, which need a road on one side and track on another. Trains never reverse, so a rail line needs a <b>loop</b> of track through its stations: the trains drive forward around it, ease in and out of the stations and stop centred on each platform. A loop takes up to three trains; a dead-end line is refused.</p>` },
        { id: 'gondola', title: 'Gondolas', html: `
          <p>Gondolas here follow La Paz's <b>Mi Teleférico</b>, the city's cable cars between the valley and the high plain above it. ${tl('cablecars')} unlocks ${bl('gondola', 0, 'gondola stations')}: a concrete deck on piers under a broad modern roof, with stairs up from the street, so a station needs a road beside it like a coach stop. The stairs are built to the villagers' own scale, a step a fifth of a villager high, and climb round the outside of the deck in flights with a landing at each corner, on whichever side keeps them out from under the cabins. Pick two or more stations in order and press ${k('Enter')}. The line needs no road or track between its stations: the cable runs <b>straight</b> from each station to the next, over streets, roofs, fields, the river or a hill, whatever lies between.</p>
          <p>Each line has two cables side by side, one out and one back. Lines open in Mi Teleférico's colours and are named for them: the <b>Red Line</b> first, then Yellow, Green, Blue, Orange, White, Sky Blue, Purple, Brown and Silver (after ten, Gondola Line 11 and on). Its cabins wear the colour: a rounded body to the sills with a pale band along them, big windows all round between posts in the colour, a door in one side and a fan cowl on the roof, hung on a hanger about as long as the cabin is tall that sweeps up to the grip on the cable, so however steeply the cable climbs it passes over the roof. At night each is lit inside, its floor warm through the glass, with a white lamp ahead and a red one behind. The station wears it too, round the edge of its deck, on the band over its booking office and round the white hood of the drive over its bullwheel. The cabins hang from the cables and run out along the stations and back again, turning round a bullwheel under the roof of each end station. Riders climb the stairs (or take the lift) and wait on the deck. It is made for waiting: railings round its edge, benches along its quiet sides facing in (at the Gondola Terminal with arms and a glazed screen behind them, and a board of the times by the stairs), flower boxes on the rails, lamps in its corners and a clock on the drive overhead, all clear of the cabins' way through. Those waiting take a free seat on a bench, or stand facing the way the cabins come in. When a cabin comes in it lets go of the cable and stands on the deck while those getting off step out and those waiting walk across and get in (it waits for them), then swings a little on its arm once it is off again. A cabin holds six standing, two across and three deep, and is glazed all round, so you can see its riders through the glass on the way, lit up at night. Those getting off cross the deck and go down the stairs to the street. A station in the middle of a line is called at both ways, and riders take the cabin going their way. A line runs up to ${T('gondola').maxVehicles} cabins, evenly spaced. Villagers take the gondola when it beats walking. They reckon on waiting half the time between cabins, so more cabins bring more riders, and a line pays best where the road goes the long way round: over the river, up a hill or across a crowded town.</p>
          <p>Towers carry the cable about every six tiles: pale steel tubes tapering up from round concrete footings, a band of the line's colour near the top, a crossarm with a walkway just under the ropes, a train of four sheaves under each rope, and a red lamp on top, lit at night. Each stands wherever there is room along that stretch: best on open ground, otherwise in a field or a park, or on the verge at the edge of a road, but never on a building, in the middle of a road, on track or in water. Each is just tall enough for the cabins to clear the roofs and the ground beneath them, up to six tiles high, and the cable sags a little between them. No stretch of it is steeper than one in one: where one would be, the tower at its lower end rises (or the station, if it may), so a cabin hanging straight down never meets the cable climbing past it. Through a station the cable runs level, on its sheaves. Where a tall neighbour stands close by, a station rises on longer piers, braced in steel, so the cable leaves it high enough, up to three and a half tiles taller. From half a tile up, a glass lift beside the deck takes the place of its stairs, a long shaft along the deck's edge: villagers wait at its door for the car, step in together, up to four, each to a spot of their own in a row along it, ride up or down in sight through the glass and step out on the deck or at the street, and an empty car comes to whoever is waiting at the other end. When something taller goes up under the line, the pylons and stations rise to clear it. Where a line crosses an older line's cable it keeps clear of it, a cabin and its hanger and more between them: well under it, or over it, its towers rising if need be, however the town changes round them.</p>
          <p>If the cable still can't clear something, such as a great building right beside a station, the line can't be made, and the game says what is in the way. Nor can one whose cable would run alongside another line's, near enough for their cabins to meet, or cross one (or itself) with no room for a cabin to pass over, or pass over another line's station, or turn back on itself at a station on the way by more than a third of a turn (its cabins coming in would meet those going out: change lines at an interchange instead). A line that something is later built under stops, marked <b>Cable blocked</b> in the lines window with what blocks it, until that is gone or a station moves. The Gondola Terminal has a glazed hall under the deck and a wider roof.</p>
          <p>A station is lit all night: its booking office, its name board and roundel, strips of light under the roof over the cabins, light on the deck where they come in, and the edge of its roof glowing in its line's colour. Like every building it needs power for its full lights (without, they burn low, like candles), and a station off the road stands dark.</p>
          <p>A gondola station takes <b>one line</b>. Where lines meet, build a ${bl('gondolahub', 0, 'Gondola Interchange')} (${money(BUILDINGS.gondolahub.levels[0].cost)}, on a 2×2 plot): the station four times over, a deck on piers with a <b>berth</b> in each quarter of it under one roof, a drive over each in its line's colour and a glazed booking hall underneath, lit as a station is. Up to four lines call there, each at a berth of its own, the one facing most the way that line goes on, so their cabins never cross on the deck. Riders wait by their own line's berth, on a bench near it or standing round it.</p>` },
      ];
    },
    see: ['transit', 'roads'],
  },
  {
    id: 'roads', title: 'Roads and streets', icon: 'add_road', group: 'town',
    summary: 'Paths, cobbles and paved streets drawn as curves; bridges; picking whole stretches; and dressing a street with trees, hedges or lamps.',
    sections: () => [
      { id: 'kinds', title: 'Kinds of road', html: table(['Road', '#Cost a unit', '#Upkeep a day', '#Unlocks at'], ROAD_LEVELS.filter(Boolean).map(r => [esc(r.name), money(r.cost), money(r.upkeep), r.unlock ? `${r.unlock} villagers` : 'from the start'])) +
        `<p>Drag with the road tool (${k('R')}) to draw a road (see ${pl('roads/curves', 'curving roads')}); it costs its price for every unit of its length. To make a stretch a better road, pick it and upgrade it (see ${pl('roads/select', 'whole stretches')}). Over water a road becomes a wooden bridge (${BRIDGE_MULT}× the price) with sloped approaches. Every building needs a road within reach of its front, and the road out of the valley can't be taken up.</p>
        <p>Junctions are rounded and kerbed whatever the angle the roads meet at; kerbs, door paths and power poles follow along, and villagers keep to their side round every bend. Buildings come forward into the verge of the street in front of them. A building with a street along its side or its back, on a corner or backing onto a lane, has windows on every floor of that wall and a door on its ground floor, never a blank wall; a corner shop carries its shopfront round too.</p>` },
      { id: 'curves', title: 'Curving roads', html: `
        <p>A road follows the stroke you draw with the road tool, smoothed into a curve; hold Shift for a straight one from where the stroke began. It can run any way across the valley.</p>
        ${list([
          '<b>Joining</b>: drawn across a road it makes a crossroads there; begun or ended on one, a junction; begun at the end of a road, it carries the road on.',
          '<b>Refused</b>: a bend too tight to drive round, a road run too close alongside another, one meeting another at too shallow an angle, and anything over a building, fields, deep water or too steep a slope; the tool says why.',
          '<b>Stretches</b>: the roads are a network of stretches, each running from a junction or an end to the next. A click picks one; its panel upgrades or downgrades it, dresses it, buries its power lines or takes it up, all priced by its length.',
          '<b>Buildings</b>: a building put down near a road turns to face it, square to it wherever it runs (see ${pl(\'construction/turn\', \'turning buildings\')}); past the end of a road it faces the end.',
          '<b>Getting about</b>: villagers, coaches and carts follow the curves on their own side of the road, through the junctions; trains follow curving track the same way.',
        ])}` },
      { id: 'diagonals', title: 'Diagonal streets (not in this copy)', html: `
        <p>In the main game, which keeps to a grid of squares, a road dragged at 45 degrees runs diagonally across it. Here a road already runs any way you draw it (see ${pl('roads/curves', 'curving roads')}), so there are no diagonal streets; a town saved by the main game with some loads with them as curves. What follows is how they work in the main game.</p>
        <p>Drag the road tool at about 45 degrees and the road runs <b>diagonally</b>, from tile centre to tile centre across the corner the two tiles share, as far as the drag goes that way, then straight on along the grid for the rest. A drag nearer the grid turns one corner as before; ${k('Tab')} keeps the road tool to the grid altogether (and back). Any kind of road can run diagonally, and a better road drawn along one upgrades it as usual.</p>
        ${list([
          '<b>Joining</b>: drawn into a street (or out of one), a diagonal makes a junction there, its corners rounded and kerbed like any other. A diagonal crossing a street or another diagonal on a tile makes a crossroads; one that turns, back the other way or onto the grid, turns in a curve.',
          '<b>Passing by</b>: a diagonal only brushes the corners of the tiles beside it, so it doesn\'t join a road it merely passes. To join one, draw a street from the diagonal into it.',
          '<b>Buildings</b>: a one-tile building beside a diagonal turns 45 degrees on its plot to face it, its door on the corner the street passes, a little smaller than usual to fit between the street and the plots behind. While it faces the diagonal it neither grows onto the plot next door, joins its neighbour nor deals in garden land; take the diagonal up and it faces the grid again. Nothing bigger than one tile may stand where a diagonal passes its corner, and a diagonal can\'t be laid past the corner of anything bigger, or of farm fields.',
          '<b>Getting about</b>: a step across a corner is only about 1.4 tiles, so villagers, carts and coaches take a diagonal when it saves going round, and it carries the water mains and joins buildings to the town like any street.',
          '<b>On the grid only</b>: bridges, boulevards and street dressings keep to the grid. A diagonal can\'t cross water, two diagonals side by side stay two streets, and a diagonal has its plain street lamps and power poles but no trees, hedges or median.',
        ])}` },
      { id: 'select', title: 'Whole stretches at once', html: `
        <p><b>Select roads</b> in the Roads menu (or <b>Select stretch</b> in a road's panel) picks the stretch of road between two junctions (or a junction and an end) with a click, more runs with Shift-click, or every road in a dragged box (${k('Tab')} switches). The panel shows what upgrading every stretch one level, downgrading it or taking it all up costs or pays back (by length), what can't change and why, and who would be cut off: buildings left without a road, coach lines without a route, buildings that step back from the street. Anything cut off takes a second click. ${k('Backspace')} steps back through your picks; right-click clears them.</p>` },
      { id: 'dress', title: 'Dressing a street', html: `
        <p>A picked stretch can be dressed. Each has a price per unit of length and a little upkeep, and makes the homes and shops beside it nicer to live by (scenery):</p>
        ${dressTable(DRESSINGS.filter(d => d && !d.blvd), 'Dressing')}
        <p>Trees and hedges stand on the verges: they leave gaps at junctions, bends, driveways, lamps and poles, and buildings that stood forward into the street step back behind them. Lamps are lit at night only as far as the town has power. Swapping or removing a dressing, or taking up its road, pays back ${pct(ROAD_SALVAGE)} of its price.</p>` },
      { id: 'boulevards', title: 'Boulevards (not in this copy)', html: `
        <p>There are no boulevards here: two roads can't be laid side by side, so a boulevard look offered to a street is refused. What follows is how they work in the main game, on its grid of squares.</p>
        <p>Roads laid directly side by side make a <b>boulevard</b>, not a wide slab of road: a lane each way with a grass median between them, kerbed on both sides, and on cobbled and paved lanes a band of setts along the median. It comes from the way the roads lie, so it changes as roads are laid or taken up, and loaded, shared and merged towns work it out for themselves.</p>
        ${list([
          '<b>Junctions</b>: where a street crosses or meets it, the lanes join and the median stops in a rounded nose.',
          '<b>Ends</b>: where both roads stop, the lanes join in a turning loop round the nose; where one road carries on, the other merges into it.',
          '<b>Corners</b>: a two-lane boulevard turns a corner with its median.',
          '<b>Wider</b>: three or more roads side by side get a median between each.',
          '<b>Track and water</b>: a level crossing breaks the median for the track, and over water the lanes cross on twin bridges.',
        ])}
        <p>A boulevard is a little nicer to live by than a plain street (+${fmt(BOULEVARD.appeal)} scenery a lane tile). Pick it with <b>Select roads</b> (a click picks every lane of it between its junctions) and choose a <b>Boulevard look</b> in the panel, or use the look buttons in a lane's own panel, which dress the whole boulevard. Without one it is a grass median.</p>
        ${dressTable(DRESSINGS.filter(d => d && d.blvd), 'Look')}
        <p>Flower beds follow the seasons: bulbs in spring, summer bedding, autumn colours, and bare soil under the snow in winter; a promenade's fountains freeze over. A street dressing on a boulevard goes alongside its look and keeps to the lanes' outer verges (avenue trees along the verges and a promenade down the middle, say), as do their street lamps and power poles, and buildings fronting a boulevard come forward to the verge as on any street. A look goes again, with ${pct(ROAD_SALVAGE)} of its price back, when its tile stops being a boulevard: when the other road is taken up (the panel warns first) or a street is laid across it. Villagers and coaches keep to their side: each lane runs one way, everyone keeps right, and they cross the median only where that saves going round.</p>` },
      { id: 'land', title: 'Shaping the land', html: `
        <p>The Terrain menu (${k('8')}) raises, lowers and levels the ground (${money(TERRAFORM_COST)} a tile) and plants trees (${money(TREE_COST)} each). Building over trees clears them for ${money(CLEAR_COST)} a tree. On a slope a building stands on the highest ground under its walls, so none of it is buried in the hill, with a stone lower floor where the ground falls away; its door stays at street level.</p>` },
    ],
    see: ['economy', 'transport'],
  },
  {
    id: 'research', title: 'Research tree', icon: 'science', group: 'town', generated: 'research',
    summary: 'Every research project, what it needs and what it unlocks.',
  },
  {
    id: 'seasons', title: 'Time, seasons and weather', icon: 'partly_cloudy_day', group: 'town',
    summary: 'Days, nights, the four seasons, rain and snow, and the soundtrack.',
    sections: () => [
      { id: 'day', title: 'Days and nights', html: `
        <p>A day lasts ${minutes(CONFIG.DAY_SECONDS)} at normal speed. The sun rises and sets, windows light up in the evening, street lamps come on once the town has power, villagers carry lanterns home and fireflies come out in summer.</p>
        <p>Pause with ${k('Space')}, or run at ${speedsText()} (${k('[')} and ${k(']')} step through them). The game plays on in a background tab in bigger, undrawn steps.</p>` },
      { id: 'seasons', title: 'Seasons', html: `
        <p>Each season lasts ${CONFIG.DAYS_PER_SEASON} days, ${and(SEASONS.map(s => `${s.icon} ${esc(s.name.toLowerCase())}`))}, and a villager's year passes every two days. The seasons turn gradually: each holds for the first half of its days, then shades into the next, the grass changing colour, the trees turning one by one, the wildflowers coming and going and the crops ripening or going back to bare earth. Snow settles over the first two days of winter and melts over the last day and a half.</p>` },
      { id: 'weather', title: 'Weather', html: `
        <p>Most days are fair, but now and then clouds roll in for a few hours and the heaviest spells bring rain (snow in winter), with a soft hiss of rain. In winter snow lies on the roofs as well as the fields, and a fall leaves fresh snow on the roofs and a trodden layer on the streets that melts away over the next few hours. The weather follows the town's seed and clock, so everyone in a multiplayer town sees the same sky.</p>` },
      { id: 'music', title: 'Music and sound', html: `
        <p>A gentle folk soundtrack is made up as it plays: a lute picking out chords, a flute or bells on top and a warm pad underneath. It slows into a minor key at night and plays quieter in the rain. It is synthesised in the browser, so there are no music files. Turn it off with the note button in the top bar, or set its volume in ${pl('settings/sound', 'Settings')}.</p>` },
    ],
    see: ['farms', 'settings'],
  },

  // ================================================================ buildings
  ...CATEGORIES.map(c => ({
    id: CAT_PAGE[c.id], title: c.name, icon: { residential: 'cottage', commercial: 'storefront', industry: 'factory', services: 'local_hospital', utilities: 'bolt', parks: 'park', transit: 'train' }[c.id],
    group: 'buildings', generated: 'catalog', cat: c.id,
    summary: {
      residential: 'Cottages, family houses, grand homes and flats, terraces and the 2×2 estates.',
      commercial: 'Markets, the high street of shops for every trade, pubs, offices, and the buildings joined from them.',
      industry: 'Farms, woodcutters, fisheries, workshops and builders, and the mills and works they grow into.',
      services: 'Schools, clinics, watch posts, chapels and the town hall, and the colleges, hospitals and cathedral they lead to.',
      utilities: 'Wells, pumps and water towers; water wheels, wind generators and power stations.',
      parks: 'Gardens, greens, squares and statues, places to play and games lawns.',
      transit: 'Coach stops and railway stations.',
    }[c.id],
  })),
  {
    id: 'construction', title: 'Building and upgrading', icon: 'construction', group: 'buildings',
    summary: 'Placing buildings (turned to any angle if you like), the builders, upgrades, demolishing and moving.',
    sections: () => [
      { id: 'place', title: 'Placing a building', html: `
        <p>Pick a building from a menu in the toolbar and move it over the ground beside a road: it turns by itself to face the nearest street, square to it, and a green ghost means it fits. Click to build it there. ${k('Z')} / ${k('C')} turn it further, and ${k('Tab')} lines it up along the street at the right distance from the road (see ${pl('construction/turn', 'turning')}). It needs its front within reach of a road and its plot clear of other plots, roads, track, fields and water. Most buildings take a unit square; double-plot and 2×2 buildings come from ${pl('joins', 'joins')}, ${pl('plots', 'grown plots')} and ${pl('estates', 'estates')}. Some need water beside them (fisheries, pumps, water wheels), track (stations) or trees around them (woodcutters earn more in the woods), and a town has only one town hall.</p>` },
      { id: 'turn', title: 'Turning', html: `
        <p>In this copy a building's plot turns with it, to any angle. While placing or moving it, ${k('Z')} and ${k('C')} turn it from facing its street, 15° at a time (5° with Shift), or Alt or Ctrl and the mouse wheel a degree or five at a time; it can face any way that keeps the middle of its front within reach of a street (a park, any way at all). A building already standing turns the same way from its panel, as far as it fits among its neighbours. Two buildings join, or deal in garden land, only standing square to each other and side by side, as the town's own builders lay them out along a street.</p>
        <p>The rest of this section is how the main game turns a building on its square plot. A building stands on its plot facing its street, but it needn't stand square. While placing it, ${k('Z')} and ${k('C')} turn it, in steps of 15° (with Shift, 5°), up to 45° either way; the ghost shows how it will stand. A building already standing can be turned the same way, and nudged across its plot or towards and away from the street, with the buttons under <b>On its plot</b> in its panel; <b>Square up</b> sets it straight again.</p>
        <p>However it is turned or nudged it keeps to its own plot (and the verge in front of it, if it comes forward into the street): a building turned well round is drawn a little smaller so its corners stay clear of the road and the neighbours. Its door turns with it, and villagers walk in and out through it. The town still counts it on its plot, so its homes, jobs, reach and way to the street are as they were. A building turned and nudged keeps its pose when it is moved, saved, shared with other players or merged into another village; one that grows onto the plot next door is squared up on its bigger plot.</p>
        <p>Some turn themselves. A one-tile building facing the outside of a bend in the street turns to sit square to the curve, and one beside a ${pl('roads/diagonals', 'diagonal street')} turns 45° to face it.</p>` },
      { id: 'builders', title: 'Builders and building sites', html: `
        <p>Nothing appears at once. Builders from the ${bl('builder')} walk to each site and work round the scaffolding, and a building goes up in stages: a pegged-out plot and materials, foundations, walls rising, roof. It only progresses while someone is working on it. Hired hands from the village start every site straight away and keep at it until the town's builders arrive; with no builders in town, they do all of it. Bigger buildings take many builder-hours, which the building pages list.</p>
        <p>Tick <b>Priority</b> on a site's panel to send the builders there first; a flag marks it until it's finished. The ${bl('contractor', 0)} builds faster with more builders. The <b>Instant building</b> sandbox switch skips the builders.</p>` },
      { id: 'upgrade', title: 'Upgrading', html: `
        <p>Select a building to see its upgrades. Each option shows what changes (homes, jobs, earnings, reach, upkeep…) and what it needs: villagers, research, happiness, services in reach, electricity, and the money. Homes and shops can pick a ${pl('styles', 'style')} as they upgrade, and <b>Preview in town</b> shows it in place before you build. Some buildings branch: a Family House becomes a grand ${bl('villa')} or ${bl('flats', 0, 'flats')}, a tavern can turn into a ${bl('musichall')}, a farm into an ${bl('orchard')}.</p>` },
      { id: 'demolish', title: 'Demolishing', html: `
        <p>The bulldozer (${k('X')}) sends a crew to pull a building down over time; the people inside move out first. It pays back ${pct(fact('demolishRefund'))} of what the building was worth. Drag a box to clear trees and roads too.</p>` },
      { id: 'move', title: 'Moving', html: `
        <p>With ${tl('relocation')} researched, <b>Move</b> takes any building somewhere else, at an angle of its own if you turn it, for ${money(fact('moveCost', 0))} plus ${pct(fact('moveCost', 1))} of its worth: builders take it down, a cart hauls the materials, and it goes back up on the new plot with its people.</p>` },
    ],
    see: ['joins', 'plots', 'styles', 'kinds'],
  },
  {
    id: 'kinds', title: 'Plantings and monuments', icon: 'local_florist', group: 'buildings',
    summary: 'The kinds of planting and monument to choose from, and how they grow by level.',
    sections: () => [
      { id: 'choose', title: 'Choosing a kind', html: `
        <p>A ${bl('flowers')} and a ${bl('statue')} each come in kinds. While you build one, a bar above the build menu picks its kind; <b>By its seed</b> lets each one choose for itself from the kinds that need no research, so no two side by side look alike. Some kinds need research first.</p>
        <p>Later, its panel lists every kind: builders rework it as another for ${pct(REKIND)} of what it is worth, keeping its level. Every kind follows the seasons in its own way and goes up through the same levels: ${BUILDINGS.flowers.levels.map((L, i) => bl('flowers', i)).join(' › ')}, and ${BUILDINGS.statue.levels.map((L, i) => bl('statue', i)).join(' › ')}.</p>` },
      { id: 'plantings', title: 'Plantings', html: `
        <p>A Flower Bed is the kind at its simplest; an Ornamental Garden lays it out more richly; a Show Garden is the grandest of its kind (carpet bedding, a rose pergola, a rock garden with a cascade, four herb knots round a sundial…).</p>
        ${table(['Kind', 'Research', 'What it is'], Object.values(PLANTINGS).map(x => [esc(x.name), x.tech ? tl(x.tech) : '—', esc(x.desc)]))}` },
      { id: 'monuments', title: 'Monuments', html: `
        <p>A Monument stands on its plinth in the grass; a Civic Monument on paving inside railings, with beds and lamps; a Grand Monument is a bigger work on steps, floodlit at night, and brings culture to the streets within ${BUILDINGS.statue.levels[2].culture} tiles.</p>
        ${table(['Kind', 'Research', 'What it is'], Object.values(MONUMENTS).map(x => [esc(x.name), x.tech ? tl(x.tech) : '—', esc(x.desc)]))}` },
    ],
    see: ['construction', 'research'],
  },

  // =================================================================== growing
  {
    id: 'joins', title: 'Joining buildings', icon: 'join_inner', group: 'grow',
    summary: 'Two neighbouring buildings knocked into one on a double plot.',
    sections: () => {
      const rows = MERGES.map(m => [bl(m.to), or(m.a.map(t => bl(t))), or(m.b.map(t => bl(t))), techForLevel(m.to, 0) ? tl(techForLevel(m.to, 0)) : '—']);
      return [
        { id: 'how', title: 'How to join', html: `
          <p>Once ${tl('joining')} is researched, select a building next to another: if the pair makes something, the panel offers <b>Join</b>. The two become one building on a double plot, built by the builders like any other job, for ${money(fact('joinCost', 0))} plus ${pct(fact('joinCost', 1))} of the new building's level. Either order works.</p>
          <p>A joined building takes the higher of the two levels, but never one the town hasn't researched or grown into yet, and the join button warns when the new building has room for fewer people than live in the two. The join keeps the look of the leading building: a shophouse is built in its shop's trade and style, a villa keeps its grand look when it takes in a cottage.</p>` },
        { id: 'all', title: 'Every join', html: table(['Makes', 'From', 'Joined with', 'Research'], rows) +
          `<p>A farm joined with a ${bl('house', 0, 'cottage or family house')} beside it becomes a ${bl(FARM_JOIN.to)}: a farmhouse goes up in the yard and the family moves in, and the farm keeps its level, fields and produce.</p>` },
        { id: 'grown', title: 'Without a neighbour', html: `
          <p>Many of these can also be had without a neighbour: a building on a ${pl('plots', 'grown double plot')} can be rebuilt as them.</p>` },
      ];
    },
    see: ['plots', 'estates', 'commerce'],
  },
  {
    id: 'plots', title: 'Plots and extending', icon: 'open_in_full', group: 'grow',
    summary: 'Taking the land next door, then building across the bigger plot.',
    sections: () => [
      { id: 'land', title: 'Taking land', html: `
        <p>With ${tl('surveying')} researched, a building's panel can take the land beside or behind it. That can be an empty plot (${money(CONFIG.PLOT_PRICE)} of land, plus clearing any trees), a strip of a cottage's garden, or a small neighbour bought out at what its building is worth and demolished (it asks twice, and shows the plot it would take). Taking land is instant, and the building stays exactly where it stood, with the new land as its garden. Land is only offered where the bigger plot opens up something bigger to build.</p>
        <p>Big homes can also buy a strip of a neighbouring cottage's garden: their owners pay the cottage's owners, both plots change size together, and both homes are a little happier for the deal.</p>` },
      { id: 'build', title: 'Building across the bigger plot', html: `
        <p>Then, under <b>Upgrade</b>, choose what to build across the bigger plot: one of the bigger buildings it opens up, or <b>Extend</b> the building as it is to hold 50% more, for what that extra half is worth. A home, shop or service is built on to, the house carrying on along the same front, or a back wing a storey lower behind it; works get a work shed and yard, utilities a tank or transformer house, parks more garden.</p>
        ${table(['Building', 'On a double plot can become'], Object.entries(LARGE).map(([t, to]) => [bl(t, 'type'), to.map(x => bl(x)).join(', ')]))}
        <p>The later stages of schooling need a double plot too: a middle school must grow before it can become a ${bl('highschool')}.</p>` },
    ],
    see: ['estates', 'joins'],
  },
  {
    id: 'estates', title: '2×2 estates', icon: 'grid_view', group: 'grow',
    summary: 'Double plots grown onto the two plots beside them, and rebuilt as estates.',
    sections: () => [
      { id: 'how', title: 'Growing an estate', html: `
        <p>With ${tl('bigplots')} researched, a double-plot building can take the two plots beside it (${money(2 * CONFIG.PLOT_PRICE)} of land) for a 2×2 estate, and then be rebuilt as its estate counterpart at the level it had reached, or extended. Each estate has its own model over the whole plot, and each is a step up from its double-plot building, priced in line with the rest. Estates don't grow any further.</p>` },
      { id: 'all', title: 'Every estate', html: table(['Double-plot building', 'Grown to 2×2 becomes', 'Levels'], Object.entries(ESTATE).flatMap(([from, to]) => to.map(t => [bl(from), bl(t), BUILDINGS[t].levels.map(L => esc(L.name)).join(' › ')]))) +
        `<p>${ESTATE_TYPES.length} estates in all. The building pages show each one's levels, and the research tree lists them under ${tl('bigplots')}.</p>` },
    ],
    see: ['plots', 'joins'],
  },
  {
    id: 'civic', title: 'The seat of government', icon: 'location_city', group: 'grow',
    summary: 'The town hall in its styles, grown into a Capitol and a Parliament, and the civic quarter of law courts, museum, opera house and library round it.',
    sections: () => {
      const levels = SEAT_CHAIN.flatMap(t => BUILDINGS[t].levels.map((L, i) => [bl(t, i), `${BUILDINGS[t].size}×${BUILDINGS[t].size}`, L.taxBonus ? `+${pct(L.taxBonus)}` : '—',
        `${RESEARCH_SOURCES[t][Math.min(i, RESEARCH_SOURCES[t].length - 1)]}`, L.culture ? `${L.culture} tiles` : '—', unlockOf(t, i) ? fmt(unlockOf(t, i)) : '—', techForLevel(t, i) ? tl(techForLevel(t, i)) : '—']));
      const civic = CIVIC_TYPES.map(t => [bl(t, 'type'), BUILDINGS[t].levels.map((L, i) => bl(t, i)).join(' › '), and(servicesOf(BUILDINGS[t]).map(s => `${SERVICES[s].icon} ${esc(SERVICES[s].name)}`)),
        BUILDINGS[t].merged ? `joined from ${or(MERGES.filter(m => m.to === t).flatMap(m => [...m.a, ...m.b]).filter((x, i, a) => a.indexOf(x) === i).map(x => bl(x)))}` : techForLevel(t, 0) ? tl(techForLevel(t, 0)) : '—']);
      return [
        { id: 'levels', title: 'From Town Hall to Parliament', html: `
          <p>Every town has one seat of government. It starts as the ${bl('townhall', 0, 'Town Hall')} and each level raises every tax in town, gives more research and, from the City Hall, lifts the streets round it. The Capitol and the Parliament also bring culture to the streets within their reach:</p>
          ${table(['Level', 'Grounds', '#Town tax', '#Research a day', '#Culture reach', '#Villagers', 'Research'], levels)}
          <p>A town never has a second: two merged towns keep the grander seat, and the other becomes a park on the same ground (${pl('merging', 'Merging villages')}).</p>` },
        { id: 'styles', title: 'Its style', html: `
          <p>The seat is built in one of ${Object.keys(SEAT_STYLES).length} styles. The style decides what crowns it and how its front is dressed, at every level from the little Town Hall to the Houses of Parliament. Until one is chosen it has a clock tower, and a dome from the Civic Palace up. Its panel's <b>Its style</b> section lists them all, and builders rebuild it in another style for ${pct(SEAT_RESTYLE)} of everything the seat has cost so far, keeping its level:</p>
          <div class="style-grid">${Object.entries(SEAT_STYLES).map(([id, x]) => `<figure>${pic('townhall', 3, { variant: 4242, flavor: id, alt: `A City Hall with ${x.name.toLowerCase()}` })}<figcaption><b>${esc(x.name)}</b>${esc(x.desc)} <span class="muted">Research: ${x.tech ? tl(x.tech) : '—'}</span></figcaption></figure>`).join('')}</div>` },
        { id: 'grow', title: 'Growing the seat', html: `
          <p>With ${tl('capital')} researched, the ${bl('townhall', BUILDINGS.townhall.levels.length - 1)} can take the land round one of its corners, five plots in an L (${money(5 * CONFIG.PLOT_PRICE)} of land), for 3×3 grounds. Little parks in the way (a flower bed, a monument) become part of the grounds; buildings and roads block that corner. The palace stays where it stood, its new land a garden, until it is rebuilt across the grounds as the ${bl('capitol', 0)}: the hall raised behind a forecourt between two long wings, with a fountain, lawns, flags, lamp standards and railings along the street. Then it can be upgraded to the ${bl('capitol', 1)}.</p>
          <p>The Capitol in turn takes seven more plots for 4×4 grounds, and is rebuilt as the ${bl('parliament', 0)}: a long range with a chamber at each end and a great square before it, then the ${bl('parliament', 1)} with a tower at each end. Each grows only from its top level and is never simply extended; each is its style's grandest building, a dome on a colonnaded drum, a spired Gothic tower or a temple front with a chariot on it.</p>
          <div class="style-grid">${['capitol', 'parliament'].map(t => `<figure>${pic(t, 1, { variant: 4242, flavor: t === 'capitol' ? 'dome' : 'gothic', alt: BUILDINGS[t].levels[1].name })}<figcaption><b>${esc(BUILDINGS[t].levels[1].name)}</b>${esc(BUILDINGS[t].desc)}</figcaption></figure>`).join('')}</div>` },
        { id: 'quarter', title: 'The civic quarter', html: `
          <p>Law courts, a museum, assembly rooms (later an opera house) and a library standing near the seat make a civic quarter. Each kind with its middle within ${CIVIC_QUARTER.reach} tiles of the seat's adds ${pct(CIVIC_QUARTER.tax)} to the town's taxes, on top of the seat's own bonus: ${pct(CIVIC_TYPES.length * CIVIC_QUARTER.tax)} with all ${CIVIC_TYPES.length}. A second building of the same kind adds nothing more. The seat's panel lists each kind and the one that counts for it, and a civic building's panel says whether it is part of the quarter.</p>
          ${table(['Building', 'Levels', 'Gives', 'Needs'], civic)}
          <p>${tl('civicpride')} unlocks the law courts, the museum and the assembly rooms; the library is joined from a stationer and a school or chapel.</p>` },
      ];
    },
    see: ['taxes', 'plots', 'styles', 'kinds'],
  },
  {
    id: 'styles', title: 'Styles, shapes and restyling', icon: 'palette', group: 'grow',
    summary: 'Timber frame, limewash, painted, brick, stone or clapboard, chosen as a home or shop is upgraded or restyled; and the shape every building takes of its own.',
    sections: () => {
      const STY = [
        ['timber', 'Timber frame', 'Steep roofs, a jettied upper floor and a central stack.'],
        ['plaster', 'Limewash', 'Thatch or half-hipped roofs, a chimney up the outside wall and a deep front garden.'],
        ['painted', 'Painted', 'A symmetrical Georgian front with a hipped roof, a centred door and a chimney at each end.'],
        ['brick', 'Brick', 'Gables, bay windows, round-topped windows and paired stacks.'],
        ['stone', 'Stone', 'Low slate or saltbox roofs, deep-set round-topped windows and an outside stack.'],
        ['clapboard', 'Clapboard', 'A saltbox roof, dormers, shutters and a deep porch.'],
      ];
      return [
        { id: 'styles', title: 'The six styles', html: `
          <p>Pick a <b>style</b> for any home or shop upgrade. Each builds differently, not just in different colours. A style needs its research first:</p>
          <div class="style-grid">${STY.map(([id, n, d]) => `<figure>${pic('house', 1, { variant: 4242, look: id, alt: `A family house in the ${n.toLowerCase()} style` })}<figcaption><b>${esc(n)}</b>${esc(d)} <span class="muted">Research: ${STYLE_TECH[id] ? tl(STYLE_TECH[id]) : '—'}</span></figcaption></figure>`).join('')}</div>
          <p>Tick <b>Preview in town</b> to see the style in place before building.</p>` },
        { id: 'forms', title: 'Every building its own shape', html: `
          <p>Buildings with the same name don't share a shape. Each one's seed gives it a form of its own, which it keeps as it is upgraded, on every load and for every player in a multiplayer town:</p>
          ${list([
            '<b>Its plan.</b> A family house can be a double pile with a lean-to, an L with a cross wing coming forward, narrow and deep with its gable to the street, a gabled bay in the middle of its front, a square house with a veranda, or a house with a low wing at the side. A cottage can be a plain block, a long house with its byre, an L, a dormered cottage, an outshut under a catslide roof, or a square cottage under a pyramid roof.',
            '<b>Its roofs.</b> Gable, hip, half-hip, saltbox, cross gable, mansard, gambrel or a flat roof behind a parapet, and a gable to the street finished plain, crow-stepped, curved or Dutch, as its style allows.',
            '<b>Its features.</b> Dormers (gabled, hipped or flat), a porch or door case (a canopy, a gabled porch, a hood, a pediment, a fanlight, a portico, a stoop or a veranda), a bay window, an oriel, a balcony, a turret on a corner, and a cupola, finials or a weather vane on the ridge.',
            '<b>Its storeys.</b> Some shops stand a storey taller than others of their level, with their own kind of shopfront (plain, pilastered, with transom lights, or with the door set back) and a second sign (a blade sign, a painted band or a board along the eaves).',
            '<b>Everything else has plans too.</b> Flats, terraces, mansions and apartments, the market hall, banks and offices, chapels and schools (their towers at the front, beside them or over the middle, crowned with a spire, a pyramid, battlements, a belfry or a lantern), fire stations and watch posts, farms (a gable barn, a Dutch barn or a long barn, an oast house, a silo of concrete, timber or brick, a tower mill or a post mill), works and yards (laid out either way round), coach stops, stations, water towers, wind generators, tennis courts and bowling greens, and the town hall within its style.',
          ])}
          <div class="style-grid">${[
            [3, 'An L', 'A cross wing comes forward with its gable to the street.'],
            [139, 'Gable to the street', 'Narrow and deep, its gable a Dutch one.'],
            [279, 'A gabled bay', 'The door in a gabled bay in the middle of the front.'],
            [22, 'A square house', 'A hipped roof, a dormer and a veranda.'],
            [20, 'A side wing', 'A low wing set back at one side.'],
            [55, 'A gambrel', 'Two slopes a side, a stack up the gable.'],
            [160, 'A mansard', 'Steep slopes with dormers, a low top.'],
            [378, 'A turret', 'A round turret on a front corner.'],
          ].map(([v, n, d]) => `<figure>${pic('house', 1, { variant: v, alt: `A family house: ${n.toLowerCase()}` })}<figcaption><b>${esc(n)}</b>${esc(d)}</figcaption></figure>`).join('')}</div>
          <p>A style a player picks keeps to its own kinds of roof and porch (limewash keeps its thatch and half-hips, clapboard its saltboxes, gambrels and verandas), so a style changes the shape too, while each building still keeps its own plan.</p>` },
        { id: 'restyle', title: 'Restyling', html: `
          <p>A home or shop can change style without being upgraded: its panel's <b>Restyle</b> section lists every style you have researched, and builders rebuild its fronts and roof in the one you pick, for ${pct(fact('restyle', 0))} of what the building is worth (at least ${money(fact('restyle', 1))}). Changing style during an upgrade adds the same ${pct(fact('restyle', 0))} to the upgrade's price.</p>` },
      ];
    },
    see: ['construction', 'homes'],
  },
  {
    id: 'farms', title: 'Farms and fields', icon: 'agriculture', group: 'grow',
    summary: 'Ploughing fields, choosing what a farm grows, orchards and homesteads.',
    sections: () => {
      const farm = BUILDINGS.farm;
      return [
        { id: 'fields', title: 'Fields', html: `
          <p>A ${bl('farm')}'s barn, cart shed and yard stand at the front of its plot by the road, with its home field behind. Pick <b>Add fields</b> in its panel and drag a box over open land to plough <b>farmland</b> beyond its plot. Fields go behind and beside the farm (never between it and the road), must touch it or its other fields, and cost ${money(CONFIG.FIELD_COST)} each (plus clearing any trees). Each field gives work to about ${CONFIG.FIELD_JOBS} more farmhands.</p>
          ${table(['Farm level', '#Fields it can work'], farm.levels.map((L, i) => [bl('farm', i), `${CONFIG.FIELD_MAX[Math.min(i, CONFIG.FIELD_MAX.length - 1)]}`]))}
          <p>The fields are one farmland with the farm's own: the furrows run on from one to the next, and a single post-and-rail fence goes round the outside. Fields change with the seasons (green shoots, golden wheat, stubble, snow) and block building and roads. <b>Take fields out</b> (or the bulldozer) gives a quarter of the price back, and a farm that is demolished or moved loses them.</p>` },
        { id: 'produce', title: 'What a farm grows', html: `
          <p>A farm chooses its <b>produce</b> in its panel. Crops need hands; livestock needs far fewer but earns much more per worker:</p>
          ${table(['Produce', 'Kind', '#Hands', '#Earnings per hand', 'About it'], Object.values(PRODUCE).map(p => [`${p.icon} ${esc(p.name)}`, p.kind === 'livestock' ? 'Livestock' : 'Crops', `× ${fmt(p.jobs)}`, `× ${fmt(p.income)}`, esc(p.desc)]))}
          <p>Livestock farms turn their fields to fenced pasture with a field shelter and trough, or a hen house, and their herds grow with the farm and its fields.</p>` },
        { id: 'orchard', title: 'Orchards', html: `
          <p>With ${tl('horticulture')}, a farm can become an ${bl('orchard')}: it keeps its fields, planted with rows of fruit trees (blossom in spring, fruit in summer and autumn), and works as many as the farm did. ${FRUIT.icon} ${esc(FRUIT.desc)} An orchard can't change what it grows.</p>` },
        { id: 'homestead', title: 'Homesteads', html: `
          <p>A farm has no farmhouse to begin with. Join a cottage or family house beside it and it becomes a ${bl('homestead')}: a farmhouse goes up in the yard, the family moves in, and the farm keeps its level, fields and produce (${BUILDINGS.homestead.levels.map(L => esc(L.name)).join(' › ')}).</p>` },
        { id: 'animals', title: 'Animals', html: `
          <p>Sheep, cows and chickens graze on the farms and out across their fields; how many depends on what the farm keeps, its level and how many fields it works. In the wild, deer and foxes roam the woods, rabbits the meadows, and mallards paddle on the lakes and river. They wander, steer round buildings, rarely cross roads, and bolt from villagers who get too close.</p>` },
      ];
    },
    see: ['industry', 'seasons'],
  },
  {
    id: 'highstreet', title: 'The high street', icon: 'storefront', group: 'grow',
    summary: 'Shops for every trade, how villagers shop, corner shopfronts and the backs of shops.',
    sections: () => {
      const sellers = (tr) => types().filter(t => { const d = BUILDINGS[t]; if (!d.shop) return false; const x = d.trade; return x === 'all' ? tr !== 'banking' && tr !== 'post' : Array.isArray(x) ? x.includes(tr) : x === tr; });
      return [
        { id: 'trades', title: 'Trades', html: `
          <p>Every shop sells a trade. A villager out shopping goes for one trade the town has (everyday food most often, clothes, boots, hardware, remedies, books, the post and the bank less), to one of the nearer shops selling it: a street of bakeries doesn't draw every errand, and the town's only draper still gets the clothes shopping. A trade sold only far from home is shopped for less.</p>
          ${table(['Trade', '#How often', 'Sold at'], Object.entries(TRADES).map(([id, T]) => [esc(T.name[0].toUpperCase() + T.name.slice(1)), `× ${fmt(T.often)}`, sellers(id).map(t => bl(t, 'type')).join(', ')]))}
          <p>A ${bl('shophouse')} sells what the shop it was joined from sold, and a department store a bit of everything but banking and the post.</p>` },
        { id: 'shops', title: 'Opening shops', html: `
          <p>The Commerce menu (${k('3')}) has a shop for each trade, unlocked from the first villagers to the late game; each shop's entry says what it needs. Offices have no counter but pay well, for villagers with some schooling. Shops, cafés and taverns within ${fact('happyShops', 0)} tiles make homes happier (+${fact('happyShops', 1)}).</p>` },
        { id: 'corners', title: 'Corner shopfronts', html: `
          <p>On a street corner (a side street running down one side of it) a shop carries its shopfront round the corner: windows with its goods, the fascia and its awning down the side street too, a pilaster where the two fronts meet, and some of its goods on the side pavement. The town works this out from the roads, so laying or taking up a side street changes it. These turn the corner: ${and([...CORNER_SHOPS].filter(t => BUILDINGS[t]).map(t => bl(t, 'type')))}.</p>` },
        { id: 'backs', title: 'The backs of shops', html: `
          <p>From behind each shop still shows its trade: the back door at one end, its name on a board across the back, loading doors with a hoist at the bigger shops, and the trade's own things by the door: crates of greens, the butcher's smoke-house flue, the cobbler's lit workshop window, bales at the draper's, drums of paraffin at the ironmonger's, the chemist's green dispensary window, skylights in the stationer's roof, mail sacks at the post office, the bank's barred windows, the bakery's bread oven, and a fire escape down the back of the tall offices.</p>` },
      ];
    },
    see: ['commerce', 'joins'],
  },

  // ==================================================================== people
  {
    id: 'people', title: 'People', icon: 'groups', group: 'people',
    summary: 'Who your villagers are: ages, families, schooling, jobs, education and money.',
    sections: () => [
      { id: 'who', title: 'Who they are', html: `
        <p>Every resident has a name (families share a surname, and names rarely repeat), an age, an education, a home, maybe a job, a wage, savings, living costs, a family and friends (workmates, neighbours, classmates). Press ${k('P')} for the <b>Villagers</b> directory: search, filter and sort everyone in town, then click a name to follow them.</p>
        <p>They are little minions, drawn to scale with the buildings: a yellow capsule of a body in blue dungarees, on short legs, with one big goggle or two on a strap round the head. Some are short and round, some tall and thin, children small; some have a few hairs on top. Their work shows as small touches over the dungarees (a farmhand's neckerchief and straw hat, a builder's tool belt and hard hat, a shopkeeper's apron, a clerk's tie and bowler, the watch's cross-belt) and the well-off wear a bow tie. They waddle about: builders swing their hammers round the scaffolding, shoppers carry home a basket, children take a satchel to school, and in winter most wear a scarf and a bobble hat. Each keeps their own look for life, and the panels show each one as their own little minion.</p>
        <p>They go in and out of every building through its front door, hopping up the doorstep or climbing the flight of steps in front of a grand one (to a door down the side of a long building on a deep plot they go round by the side path, up between a portico's columns), and in a park, a farmyard, a yard or a market square they find their way round the statues, stalls, sheds and pavilions rather than walking through them. In a big town the busiest streets thin out on screen (Settings → Performance → Villagers shown) so they look lively rather than packed; everyone still goes about their day.</p>` },
      { id: 'traits', title: 'Traits', html: `<p>Each villager has one or two traits that shape their daily routine:</p>` + '<div id="people-traits" data-gen="traits"></div>' },
      { id: 'ages', title: 'Ages and families', html: `
        <p>A year passes every two in-game days. Babies are born, children grow up, young adults move out of their parents' home, older villagers retire (with a pension of ${money(fact('pension'))} a day) and eventually die.</p>
        <p>A cottage, family house or villa holds one household; a Manor House or Country Mansion two, the 2×2 estates four or five, a terrace one per house in the row. Newcomers to a single-family home come as one big family that all but fills it, children, grown-up sons and daughters and grandparents among them. Flats, apartments and shophouses take any number of households. A home short of water can't grow its family.</p>` },
      { id: 'school', title: 'Schooling', html: `
        <p>Children go to the school that fits their age: <b>elementary</b> from ${fact('schoolAges', 0)}, <b>middle school</b> from ${fact('schoolAges', 1)} and <b>high school</b> from ${fact('schoolAges', 2)}, at the nearest school with a place. Some young adults go on to <b>college</b> or <b>university</b> instead of working. Each school has a fixed number of places; the Issues panel shows when they run short.</p>
        <p>A school upgrades two ways: <b>larger</b> (more places at the same stage) or the <b>next stage</b> (${bl('school', 'type', 'School')} → ${bl('middleschool')} → ${bl('highschool')} → ${bl('college')} → ${bl('university')}); the later stages need a bigger plot.</p>` },
      { id: 'edu', title: 'Education, jobs and pay', html: `
        <p>Better-educated workers earn more, and skilled jobs need them: the building pages give each workplace's schooling. Grown-ups who arrive bring their education with them, and better schools in town attract better-educated families.</p>
        <div id="people-edu" data-gen="edu"></div>
        <p>Villagers pay their living costs from their wages (grander homes cost more to keep), and keep the rest as savings. Hard-working villagers earn a little more.</p>` },
      { id: 'jobs', title: 'Finding work', html: `
        <p>Grown-ups look for work at the nearest workplace with a free job they are schooled for. Builders are hired first (nothing gets built without them), then places with nobody at all, so as few as possible stand idle. A household with grown-ups looking for work is unhappy (${pl('happiness', 'Happiness')}).</p>` },
    ],
    see: ['happiness', 'services'],
  },

  // ================================================================= together
  {
    id: 'multiplayer', title: 'Multiplayer', icon: 'group_add', group: 'together',
    summary: `Build one town together, live, with up to ${fact('maxPlayers')} players.`,
    sections: () => [
      { id: 'host', title: 'Hosting', html: `
        <p>Open the town you want to share and press ${k('M')} (or the people button in the top bar), then <b>Host this town</b>. On the title screen, <b>Multiplayer…</b> offers <i>New village and host</i> or <i>Continue and host</i>. You get a six-character invite code such as <code>K7Q-M2P</code>. Send it to your friends, or use <b>Copy invite link</b> for a link that opens the game with the code filled in. Keep your tab open: your computer runs the town for everyone.</p>` },
      { id: 'join', title: 'Joining', html: `
        <p>Open the game, choose <b>Multiplayer…</b> on the title screen (or press ${k('M')} in a town of your own, which is autosaved first), type your name and the code, and press <b>Join</b>. You wait until the host lets you in; then the host's town loads and follows the host's live. Everything you do (building, roads, terrain, upgrades, joins, research, taxes, transit lines, the town's name and the game speed) is sent to the host and applied for everyone. An invite link only fills in the code: joining is always your click.</p>` },
      { id: 'who', title: "Who's in", html: `
        <p>The host decides. <i>Ask me before anyone joins</i> is on by default: the host sees <i>Mallory wants to join</i> under the top bar, with <b>Let in</b> and <b>Turn away</b>. The Multiplayer window lists the players, with buttons to make one a <b>visitor</b> (who can look and point but not build) or <b>remove</b> them, and has switches for asking, <b>locking the town</b> and what newcomers join as, plus <b>New code</b>, which stops the old code working at once. The sandbox switches stay with the host.</p>
        <p>Each player's cursor shows in the others' towns as a ring in their colour with their name and what they are holding. If a guest leaves, everyone else carries on. If the host stops or closes the tab, the guests can keep playing the town on their own, save it or download it.</p>` },
      { id: 'how', title: 'How it works', html: `
        <p>Only the host runs the town (the clock, money, construction, homes and jobs, arrivals, transit, research); guests send the host their actions, which it checks by the same rules as its own. A guest joins with a snapshot of the town, then gets only what changed five times a second, and everything in full every 15 seconds so nothing drifts. Villagers on a guest's screen walk about by themselves, so one may be in a different spot on each screen.</p>
        <p>Players find each other through the free PeerJS service; the town itself goes directly between the browsers (or through a relay when no direct route exists). As in any peer-to-peer game, players you connect with can see your internet address, so share codes with people you trust.</p>` },
    ],
    see: ['merging', 'start/saving'],
  },
  {
    id: 'merging', title: 'Merging villages', icon: 'add_location_alt', group: 'together',
    summary: 'Join two towns into one valley.',
    sections: () => [
      { id: 'how', title: 'Merging two towns', html: `
        <p><b>Save → Merge villages…</b> (or <b>Merge villages…</b> on the title menu) joins two towns into a new one; neither save is changed. While playing, the map-pin button in the top bar (<b>Merge a village into this town</b>) opens it with your town as town A.</p>
        <ol>
          <li><b>Pick town A and town B.</b> Each can be a save in this browser, the town you are playing, a <code>.json</code> save, or a brand-new village (an empty valley or a ${pl('starters', 'starter town')}). Town A keeps its name, its place and its road out of the valley; town B joins it.</li>
          <li><b>Arrange them.</b> <i>Place it in the town</i> pauses the game and sets the incoming village down beside your town: drag it with the mouse, ${k('R')} turns it, ${k('Enter')} merges and ${k('Esc')} cancels. Or <i>Arrange on a map</i>: set B beside A, drag it anywhere, turn it, and see the merged valley a moment after you stop. A merged map can be up to ${fact('mergeMax')}×${fact('mergeMax')} tiles.</li>
          <li><b>Merge.</b> The merged town loads with a report of what was moved, refunded, changed or dropped. It is autosaved straight away.</li>
        </ol>` },
      { id: 'join', title: 'How the join is made', html: list([
        "<b>Ground</b>: each town keeps the land round its own buildings and streets; the heights are blended smoothly across a band at the join, and rivers and lakes that reach the join are carried across or run on to the map edge.",
        '<b>Buildings</b>: where two plots overlap, the more valuable one stays and the other moves to the nearest free plot with a road, or is refunded. There is one town hall: the second becomes a Plaza of the same level.',
        "<b>Roads</b>: every piece of road is joined to the network that leads out of the valley, along the cheapest route.",
        "<b>People</b>: villagers whose home vanished move into homes with room, households together; nobody shares a whole name.",
        '<b>Town</b>: research is everything either town discovered, the money is both treasuries plus refunds, and the day is the later town\'s.',
      ]) },
    ],
    see: ['multiplayer', 'starters'],
  },
  {
    id: 'starters', title: 'Starter towns', icon: 'holiday_village', group: 'together', generated: 'starters',
    summary: 'Ready-made towns to take over, from a riverside hamlet to the Cathedral city.',
    sections: () => [
      { id: 'about', title: 'Taking over a town', html: `
        <p>In the new-village window, <b>Start from</b> offers an empty valley or a starter town a few weeks along, each with its own streets, buildings, families and research. Each card shows a little map of the town, its size, villagers and money, and picking one shows it behind the window.</p>
        <p>A starter town is <b>grown when you pick it</b>, by the game's own rules: its founders build street by street, families move in, find work and school places and have children, and its research carries on with the next projects on its list. So a starter always follows the current version of the game.</p>` },
    ],
    see: ['start', 'merging'],
  },

  // ================================================================== options
  {
    id: 'settings', title: 'Settings', icon: 'settings', group: 'options',
    summary: 'Display, the camera, performance, sound, pop-ups, the game and sandbox switches.',
    sections: () => {
      const preset = (p) => [`${p.fps ? `${p.fps} fps` : 'screen rate'}`, pct(p.resScale), p.shadows ? `${p.shadowQuality} shadows` : 'no shadows', `effects ${p.effects}`, `villagers ${p.villagers}`, p.pausedSlow ? 'slow when paused' : ''].filter(Boolean).join(' · ');
      const groupTable = (g) => table(['Setting', 'Choices', 'What it does'], g.rows.map(([a, b, c]) => [`<b>${esc(a)}</b>`, esc(b), esc(c)]));
      const sec = (g, id, extra = '') => ({ id, title: g.group.replace(' · this town only', ''), html: groupTable(g) + extra });
      const G = (name) => SETTINGS.find(s => s.group === name);
      return [
        { id: 'window', title: 'The Settings window', html: `<p>The ⚙ button in the top bar opens Settings, in group boxes (two columns, one on a phone). Every change applies as it's made; <b>Close</b> just closes the window, and <b>Quit to title</b> goes back to the title screen.</p>` },
        sec(G('Display'), 'display', `
          <h3 id="settings/tilt-shift">Tilt-shift</h3>
          <p>Tilt-shift makes the town look like a tabletop model. The middle of the screen stays sharp (always the middle, wherever the camera goes) and the view goes soft by degrees out to every edge: a wide oval, the blur easing in with no line where it starts, growing faster up and down than across and slower below the middle than above, so the sharp area reaches further down the screen. The colours get a little lift. <b>Subtle</b> blurs up to ${fmt(TILT_SHIFT.subtle.blur * 100)}% of the screen's height, <b>Strong</b> ${fmt(TILT_SHIFT.strong.blur * 100)}%; the sharp band reaches ${pct(TILT_BAND.narrow)}, ${pct(TILT_BAND.normal)} or ${pct(TILT_BAND.wide)} of the height above and below the middle. It works in both looks, costs a fraction of a millisecond a frame, and is off by default.</p>`),
        sec(G('Camera'), 'camera', `<p>How to turn and tilt the camera, and what the perspective camera is like: ${pl('controls/free', 'Turning and tilting freely')}.</p>`),
        sec(G('Performance'), 'performance', `
          <p>If the game runs slowly or keeps a laptop's fan going, lower these. The defaults draw as well as the game can: ${esc(preset(PERF_DEFAULTS))}. <b>Battery saver</b> sets ${esc(preset(BATTERY_SAVER))}, and turns off soft contact shadows${BATTERY_SAVER.tiltShift === 'off' ? ' and tilt-shift' : ''}. They're saved with the other settings.</p>`),
        sec(G('Sound'), 'sound'),
        sec(G('Pop-ups'), 'popups', `<p>All of them at once: the bell button in the top bar, or ${k('N')}.</p>`),
        sec(G('Game'), 'game'),
        sec(G('Sandbox · this town only'), 'sandbox', '<p>The sandbox switches belong to the town and are saved with it. In multiplayer only the host can change them.</p>'),
      ];
    },
    see: ['controls', 'start/saving'],
  },
];

// The speeds, from the game's own buttons.
function speedsText() {
  const v = [1, 2, 3, 4, 5].map(i => fact('speeds', i));
  return `${and(['normal speed (1×)', ...v.map(s => `${s}×`)])}`;
}

// Generated bits of the prose pages (they need modules beyond the
// definitions; wiki.js fills them in).
export const GEN = {
  async traits(root) {
    const { TRAITS } = await import('../src/sim/people.js');
    root.innerHTML = table(['Trait', 'What it means'], Object.values(TRAITS).map(t => [`<b>${esc(t.name)}</b>`, esc(t.desc)]));
  },
  async edu(root) {
    const { EDU } = await import('../src/sim/people.js');
    root.innerHTML = table(['Education', '#Pay'], EDU.map((e, i) => [esc(e), `× ${fmt(fact('eduPay', i))}`]));
  },
};

// A page by id.
export const pageById = (id) => PAGES.find(p => p.id === id) || null;

