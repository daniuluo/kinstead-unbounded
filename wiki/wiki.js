// The wiki: one page that shows one wiki page at a time. The address says
// which: #taxes is a page, #taxes/who a section of it, #homes/villa a
// building's entry and #research/carpentry a research project (a bare
// #villa or #carpentry finds its way too). The prose pages (pages.js) read
// the game's definitions and show at once; the building pages, research
// tree and starter towns (catalog.js) bring in more of the game's code, and
// building pictures are drawn by the game's own thumbnail renderer as they
// scroll into view.

import { BUILDINGS, TECHS, BRANCHES, MERGES, ESTATE_TYPES, TRADES, CATEGORIES } from '../src/defs.js';
import { PAGES, GROUPS, GEN, pageById } from './pages.js';
import { hrefOf, esc, ms } from './links.js';

const $ = (id) => document.getElementById(id);
const main = $('page'), side = $('side');
const groupName = (g) => (GROUPS.find(([id]) => id === g) || [g, g])[1];
let catalog = null;
const loadCatalog = () => (catalog ||= import('./catalog.js'));

// ------------------------------------------------------------- navigation
function renderNav() {
  let h = `<a href="#" data-page="home">${ms('home')}Wiki home</a>`;
  for (const [g, name] of GROUPS) {
    const ps = PAGES.filter(p => p.group === g);
    if (!ps.length) continue;
    h += `<h4>${esc(name)}</h4>` + ps.map(p => `<a href="#${p.id}" data-page="${p.id}">${ms(p.icon || 'article')}${esc(p.title)}</a>`).join('');
  }
  $('nav').innerHTML = h;
}
function markNav(pid) {
  for (const a of $('nav').querySelectorAll('a')) {
    if (a.dataset.page === pid) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}
$('navToggle').onclick = () => {
  const open = side.classList.toggle('open');
  $('navToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
};

// ----------------------------------------------------------------- search
const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
let INDEX = null;
function buildIndex() {
  const out = [];
  for (const p of PAGES) {
    out.push({ t: p.title, s: groupName(p.group), h: `#${p.id}`, w: 4, x: p.summary || '' });
    if (p.sections) for (const s of p.sections()) out.push({ t: s.title, s: p.title, h: `#${p.id}/${s.id}`, w: 1.5, x: strip(s.html) });
  }
  for (const [t, d] of Object.entries(BUILDINGS)) {
    const cat = CATEGORIES.find(c => c.id === d.cat);
    out.push({ t: d.name, s: `${cat.name} · ${d.levels.map(L => L.name).join(' › ')}`, h: hrefOf(t), w: 3, x: d.desc || '' });
    d.levels.forEach((L, i) => { if (L.name !== d.name) out.push({ t: L.name, s: `${d.name} · level ${i + 1}`, h: `${hrefOf(t)}.${i}`, w: 2.6, x: '' }); });
  }
  for (const [id, T] of Object.entries(TECHS)) {
    const br = BRANCHES.find(([b]) => b === T.branch);
    out.push({ t: T.name, s: `Research · ${br ? br[1] : ''} · ${T.cost} points`, h: `#research/${id}`, w: 2.4, x: T.desc });
  }
  for (const e of out) { e.tl = e.t.toLowerCase(); e.hay = `${e.t} ${e.s}`.toLowerCase(); e.xl = e.x.toLowerCase(); }
  return out;
}
function search(q) {
  INDEX ||= buildIndex();
  q = q.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const seen = new Set(), out = [];
  for (const e of INDEX) {
    let score = 0;
    if (words.every(w => e.hay.includes(w))) {
      score = e.w * 10 + (e.tl === q ? 40 : e.tl.startsWith(q) ? 25 : e.tl.includes(q) ? 10 : 0);
      if (words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(e.tl))) score += 6;
    } else if (q.length >= 3 && words.every(w => e.hay.includes(w) || e.xl.includes(w))) score = e.w * 2;
    if (score && !seen.has(e.h)) { seen.add(e.h); out.push({ e, score }); }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 14).map(r => r.e);
}
const box = $('q'), results = $('results');
let hits = [], sel = 0;
function showResults() {
  hits = search(box.value);
  sel = 0;
  if (!box.value.trim()) { results.classList.add('hidden'); return; }
  results.innerHTML = hits.length
    ? hits.map((e, i) => `<a href="${e.h}" role="option" class="${i === sel ? 'on' : ''}" id="hit${i}">${esc(e.t)}<small>${esc(e.s)}</small></a>`).join('')
    : '<div class="none">Nothing found. Try another word.</div>';
  results.classList.remove('hidden');
  box.setAttribute('aria-expanded', 'true');
}
function moveSel(d) {
  if (!hits.length) return;
  sel = (sel + d + hits.length) % hits.length;
  results.querySelectorAll('a').forEach((a, i) => a.classList.toggle('on', i === sel));
  $(`hit${sel}`)?.scrollIntoView({ block: 'nearest' });
  box.setAttribute('aria-activedescendant', `hit${sel}`);
}
const closeResults = () => { results.classList.add('hidden'); box.setAttribute('aria-expanded', 'false'); };
box.addEventListener('input', showResults);
box.addEventListener('focus', () => { if (box.value.trim()) showResults(); });
box.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Enter') { if (hits[sel]) { location.hash = hits[sel].h; closeResults(); box.blur(); } }
  else if (e.key === 'Escape') { box.value = ''; closeResults(); }
});
results.addEventListener('click', (e) => { if (e.target.closest('a')) { closeResults(); box.blur(); } });
document.addEventListener('click', (e) => { if (!e.target.closest('.wiki-search')) closeResults(); });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== box && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) { e.preventDefault(); box.focus(); }
});

// --------------------------------------------------------------- pictures
// Building pictures, drawn by the game's thumbnail renderer (three.js and
// the building models) one at a time as they come into view.
let thumbs = null, busy = false, noGL = false;
const queue = [];
const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); queue.push(e.target); }
  pump();
}, { rootMargin: '600px 0px' }) : null;
const idle = () => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 100 }) : setTimeout(r, 16)));
async function pump() {
  if (busy || noGL) return;
  busy = true;
  try {
    thumbs ||= await import('../src/ui/thumbs.js');
    while (queue.length) {
      const img = queue.shift();
      if (!img.isConnected || !img.dataset.thumb) continue;
      const [t, l, v, f, look] = img.dataset.thumb.split('|');
      try {
        img.src = thumbs.thumb(t, +l, +v, f || null, look || null);
        img.classList.remove('ph');
      } catch (e) {
        console.warn('Kinstead wiki: no picture for', t, e);
        if (/WebGL|context/i.test(String(e && e.message))) { noGL = true; break; }
      }
      await idle();
    }
  } catch (e) {
    console.warn('Kinstead wiki: building pictures need WebGL and the game\'s code', e);
    noGL = true;
  }
  busy = false;
}
function watchPictures(root) {
  for (const img of root.querySelectorAll('img[data-thumb]')) { if (io) io.observe(img); else queue.push(img); }
  if (!io) pump();
}

// ------------------------------------------------------------------ pages
function homeHTML() {
  const types = Object.keys(BUILDINGS), levels = types.reduce((n, t) => n + BUILDINGS[t].levels.length, 0);
  const statBox = (n, label) => `<div><b>${n}</b>${esc(label)}</div>`;
  let h = `<div class="crumbs">Kinstead Unbounded wiki</div><h1>The Kinstead Unbounded wiki</h1>
    <p class="summary">How everything in <a href="../">Kinstead Unbounded</a> works, from the first cottage to the Civic Palace. The building pages, the research tree and many of the figures are read straight from the game's own code, so they always match the game you play.</p>
    <div class="stats-row">${statBox(types.length, 'kinds of building')}${statBox(levels, 'building levels')}${statBox(Object.keys(TECHS).length, 'research projects')}${statBox(MERGES.length, 'ways to join')}${statBox(ESTATE_TYPES.length, '2×2 estates')}${statBox(Object.keys(TRADES).length, 'trades')}</div>
    <p><a class="btn primary" href="../play/">${ms('play_arrow')}Play Kinstead</a> <span class="muted" style="margin-left:8px">Press <span class="kbd">/</span> to search.</span></p>
    <div class="wiki-home-grid">`;
  for (const [g, name] of GROUPS) {
    const ps = PAGES.filter(p => p.group === g);
    h += `<section><h3>${esc(name)}</h3><ul>${ps.map(p => `<li><a href="#${p.id}">${esc(p.title)}</a></li>`).join('')}</ul></section>`;
  }
  return h + '</div>';
}

function seeHTML(list) {
  const links = (list || []).map(ref => {
    const [pid, sid] = ref.split('/'), p = pageById(pid);
    if (!p) return '';
    const s = sid && p.sections ? p.sections().find(x => x.id === sid) : null;
    return `<a href="#${ref}">${esc(s ? `${p.title}: ${s.title}` : p.title)}</a>`;
  }).filter(Boolean);
  return links.length ? `<div class="see"><b>See also:</b> ${links.join(' ')}</div>` : '';
}

function sectionHTML(p, s) {
  if (s.raw) return s.html;
  return `<h2 id="${p.id}/${s.id}">${esc(s.title)}<a class="anchor" href="#${p.id}/${s.id}" aria-label="Link to this section">#</a></h2>${s.html}`;
}

let current = null, renderId = 0;
async function renderPage(pid) {
  const my = ++renderId;
  if (pid === 'home') {
    main.innerHTML = homeHTML();
    document.title = 'Kinstead Unbounded wiki';
    return true;
  }
  const p = pageById(pid);
  let sections = p.sections ? p.sections() : [];
  if (p.generated) {
    main.innerHTML = `<div class="crumbs">${esc(groupName(p.group))}</div><h1>${esc(p.title)}</h1><p class="summary">${esc(p.summary || '')}</p><p class="wiki-loading">Reading the game's ${p.generated === 'catalog' ? 'buildings' : p.generated === 'research' ? 'research tree' : 'starter towns'}…</p>`;
    try {
      const c = await loadCatalog();
      sections = [...sections, ...await c.generate(p.generated, p.id)];
    } catch (e) {
      console.error(e);
      if (my !== renderId) return false;
      main.querySelector('.wiki-loading').innerHTML = `This page is made from the game's own code, which could not be loaded here (${esc(e.message || e)}). <a href="">Try again</a>.`;
      return false;
    }
  }
  if (my !== renderId) return false;
  const tocList = sections.filter(s => !s.raw);
  const toc = !p.generated && tocList.length > 2
    ? `<nav class="toc" aria-label="On this page"><b>On this page</b><ol>${tocList.map(s => `<li><a href="#${p.id}/${s.id}">${esc(s.title)}</a></li>`).join('')}</ol></nav>` : '';
  main.innerHTML = `<div class="crumbs"><a href="#">Wiki</a> › ${esc(groupName(p.group))}</div><h1>${esc(p.title)}</h1><p class="summary">${esc(p.summary || '')}</p>${toc}`
    + sections.map(s => sectionHTML(p, s)).join('') + seeHTML(p.see);
  document.title = `${p.title} — Kinstead Unbounded wiki`;
  for (const el of main.querySelectorAll('[data-gen]')) GEN[el.dataset.gen]?.(el).catch(e => console.warn(e));
  if (p.generated === 'starters') loadCatalog().then(c => c.growStarters(main)).catch(e => console.warn(e));
  watchPictures(main);
  return true;
}

function notFound(raw) {
  main.innerHTML = `<h1>Not here</h1><p class="summary">There is no wiki page called <b>${esc(raw)}</b>. Try the search, or start from the <a href="#">wiki home</a>.</p>`;
  document.title = 'Not found — Kinstead Unbounded wiki';
  current = null;
}

function flash(el) {
  el.classList.remove('hl');
  void el.offsetWidth;
  el.classList.add('hl');
}

async function route() {
  let raw = '';
  try { raw = decodeURIComponent(location.hash.slice(1)); } catch { raw = location.hash.slice(1); }
  const [first, ...rest] = raw.split('/');
  const pid = first || 'home', anchor = rest.join('/');
  if (pid !== 'home' && !pageById(pid)) {
    // a bare building or research project
    const to = BUILDINGS[raw] ? hrefOf(raw) : TECHS[raw] ? `#research/${raw}` : null;
    if (to) { location.replace(to); return; }
    notFound(raw);
    return;
  }
  if (pid !== current) {
    current = pid;
    markNav(pid);
    side.classList.remove('open');
    if (!(await renderPage(pid))) return;
    if (!anchor) window.scrollTo(0, 0);
  }
  if (anchor) {
    const el = document.getElementById(`${pid}/${anchor}`);
    if (el) { el.scrollIntoView({ block: 'start' }); flash(el); }
  }
}

renderNav();
window.addEventListener('hashchange', route);
route();
