// The landing page's live parts: a Continue button for the town saved in
// this browser, and figures read from the game's own definitions (so they
// change with the game), plus the latest changes from GitHub.

import { STORE } from '../src/store.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('en-US');

// The town saved most recently in this browser (the game's save index; saves
// belong to the site, not the page, so the game in play/ finds them too).
function continueButton() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(`${STORE}saves`) || '[]'); } catch {}
  const latest = list.filter(e => e && e.savedAt).sort((a, b) => (b.savedAt > a.savedAt ? 1 : -1))[0];
  if (!latest) return;
  const a = $('cont');
  const img = latest.thumb && /^data:image\/(png|jpeg|webp);base64,/.test(latest.thumb) ? `<img src="${latest.thumb}" alt="">` : '<img alt="">';
  const sub = [latest.title, latest.pop != null ? `${fmt(latest.pop)} villagers` : '', latest.day ? `day ${fmt(latest.day)}` : ''].filter(Boolean).join(' · ');
  a.innerHTML = `${img}<span>Continue ${esc(latest.name || 'your town')}<small>${esc(sub)}</small></span>`;
  a.classList.remove('hidden');
}

async function fromDefs() {
  const [{ BUILDINGS, TECHS, BRANCHES, MERGES, ESTATE_TYPES, TRADES, SEAT_STYLES, SEAT_CHAIN, CIVIC_QUARTER }, { BATTERY_SAVER }] = await Promise.all([import('../src/defs.js'), import('../src/config.js')]);
  const types = Object.keys(BUILDINGS), levels = types.reduce((n, t) => n + BUILDINGS[t].levels.length, 0);
  const techs = Object.values(TECHS);
  $('facts').innerHTML = `<b>${types.length}</b> kinds of building in <b>${levels}</b> levels · <b>${techs.length}</b> research projects<br>Free · no download, no sign-up · saves in your browser`;
  // the research tree, one bar per project in each branch
  $('treeMini').innerHTML = BRANCHES.map(([id, name]) => {
    const n = techs.filter(t => t.branch === id).length;
    return `<div class="r"><b>${esc(name)}</b><span>${'<i></i>'.repeat(n)}</span></div>`;
  }).join('');
  $('treeText').textContent = `${techs.length} projects in ${BRANCHES.length} branches, from building works to transport, unlock buildings, upgrade paths, building styles and new abilities: joining neighbours, buying land, moving houses, 2×2 estates, grand parks, a Capitol and a Parliament, and burying the power lines.`;
  const shops = types.filter(t => BUILDINGS[t].shop && !BUILDINGS[t].hidden).length;
  $('shopText').textContent = `${shops} kinds of shop selling ${Object.keys(TRADES).length} trades, from the greengrocer to the bank. Shopfronts turn the corner, the backs show the trade, and shoppers go to the nearer shops that sell what they're after.`;
  $('joinText').textContent = `Knock two neighbours into one, in ${MERGES.length} ways: two cottages make a terrace, a home and a shop a shophouse, a tavern and a workshop a brewhouse. Grow a double plot onto the two beside it and rebuild it as one of ${ESTATE_TYPES.length} estates, from a manor estate to a cathedral close.`;
  const last = BUILDINGS[SEAT_CHAIN[SEAT_CHAIN.length - 1]].levels, pct = (v) => `${Math.round(v * 100)}%`;
  $('civicText').textContent = `Build the town hall in one of ${Object.keys(SEAT_STYLES).length} styles, from a clock tower to a temple front, then grow it across bigger grounds into a Capitol and the ${last[last.length - 1].name}, up to +${pct(last[last.length - 1].taxBonus)} on every tax. Law courts, a museum, an opera house and a library beside it make a civic quarter: +${pct(CIVIC_QUARTER.tax)} more for each kind.`;
  const b = BATTERY_SAVER, shadows = { high: 'High', medium: 'Medium', low: 'Low' };
  const fx = { full: 'Full', reduced: 'Fewer', off: 'Off' }, people = { all: 'All', some: 'About half', near: 'Near the view' };
  $('saver').innerHTML = [
    ['Frame rate', b.fps ? `${b.fps} a second` : 'As fast as the screen'],
    ['Resolution', `${Math.round(b.resScale * 100)}%`],
    ['Shadows', b.shadows ? shadows[b.shadowQuality] || b.shadowQuality : 'Off'],
    ['Smoke & dust', fx[b.effects] || b.effects],
    ['Villagers shown', people[b.villagers] || b.villagers],
    ['While paused', b.pausedSlow ? 'A few frames a second' : 'As usual'],
    ['Tilt-shift', b.tiltShift === 'off' ? 'Off' : b.tiltShift],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

// this copy's own repository (the main game's is daniuluo/kinstead)
const REPO = 'daniuluo/kinstead-gridless', BRANCH = 'gridless';

// The latest commits to the game, from GitHub (kept for an hour, so a
// visitor doesn't use up GitHub's allowance for unsigned requests).
async function news() {
  const box = $('news'), KEY = `${STORE}site.news`;
  let items = null;
  try { const c = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (c && Date.now() - c.at < 3600e3) items = c.items; } catch {}
  if (!items) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/commits?sha=${BRANCH}&per_page=20`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(r.status);
      const list = await r.json();
      items = list.filter(c => c.parents && c.parents.length < 2)
        .map(c => ({ msg: (c.commit.message || '').split('\n')[0].trim(), date: c.commit.committer?.date || c.commit.author?.date, url: /^https:\/\/github\.com\//.test(c.html_url) ? c.html_url : `https://github.com/${REPO}/commits/${BRANCH}` }))
        .filter(c => c.msg && !/^(merge|wip)\b/i.test(c.msg)).slice(0, 8);
      try { sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), items })); } catch {}
    } catch {
      box.innerHTML = `<p class="empty">The latest changes are on <a href="https://github.com/${REPO}/commits/${BRANCH}">GitHub</a>.</p>`;
      return;
    }
  }
  const day = (d) => { try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; } };
  box.innerHTML = `<ol>${items.map(c => `<li><time datetime="${esc(c.date)}">${esc(day(c.date))}</time><a href="${esc(c.url)}">${esc(c.msg)}</a></li>`).join('')}</ol>`
    + `<p style="margin:8px 0 0;font-size:13px"><a href="https://github.com/${REPO}/commits/${BRANCH}">Every change on GitHub →</a></p>`;
}

continueButton();
fromDefs().catch((e) => console.warn('Kinstead: could not read the game data', e));
news();
