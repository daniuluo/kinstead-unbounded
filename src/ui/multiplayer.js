// The Multiplayer window: host the town you are playing and share its invite
// code, or join a friend's town with theirs. The players box in the top bar
// shows who is connected. A host also decides who gets in: it is asked about
// each newcomer (a prompt under the top bar), can lock the town, change the
// code, make a player a visitor, or remove them. How the town is kept in step
// is in src/net/.

import { listen, connect, cleanCode, formatCode } from '../net/peer.js';
import { HostSession, GuestSession, makeLink, MAX_PLAYERS } from '../net/session.js';
import { serialize, downloadJSON, saveFileName, LocalSaves } from '../save/saves.js';
import { STORE } from '../store.js';

const NAME_KEY = `${STORE}mp.name`;
const TITLE = 'Multiplayer';
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let attempt = null;      // { kind: 'host' | 'join', text, waiting, session } while connecting
let status = null;       // { text, bad } shown under the buttons
let codeDraft = '';
let renewing = false;    // the host is getting a new code

function loadName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } }
function storeName(n) { try { localStorage.setItem(NAME_KEY, n); } catch {} }
const nameOf = () => loadName().trim() || `Builder ${100 + ((Math.random() * 900) | 0)}`;
const isOpen = (game) => !!(game.ui.windows && game.ui.windows.has(TITLE));
const refresh = (game) => { if (isOpen(game)) showMultiplayer(game); };

function inviteLink(code) { return `${location.origin}${location.pathname}?join=${code}`; }

async function copy(game, text, what) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch {}
    t.remove();
  }
  game.ui.toast(`${what} copied`, 'good', '📋');
}

// Everyone in the town. The host gets buttons to make a guest a visitor (or a
// builder again) and to remove them.
function playersHTML(net) {
  return `<div class="mp-players">${net.players.map(p => {
    const tags = [p.host ? 'host' : p.role === 'visitor' ? 'visitor' : 'builder', p.id === net.me?.id ? 'you' : ''].filter(Boolean).join(' · ');
    const ctl = net.isHost && !p.host
      ? `<button class="btn small" data-role="${p.id}" title="${p.role === 'visitor' ? 'Let them build, demolish and change settings again' : 'They can still look around and point with their cursor, but not change anything'}">${p.role === 'visitor' ? 'Let them build' : 'Make visitor'}</button>`
        + `<button class="btn small" data-kick="${p.id}" title="Disconnect them and turn them away for the rest of this session">Remove</button>`
      : '';
    return `<div class="mp-player"><i style="background:${esc(p.color)}"></i><b>${esc(p.name)}</b><span>${tags}</span>${ctl}</div>`;
  }).join('')}</div>`;
}

function askHTML(a) {
  return `<span class="ms">person_add</span><span class="mp-ask-who"><b>${esc(a.name)}</b> wants to join</span>`
    + `<button class="btn small primary" data-in="${a.id}">Let in</button><button class="btn small" data-out="${a.id}">Turn away</button>`;
}

// The host's buttons, wherever they are (the window or the prompt). One
// handler per element, which stays the same when the window is redrawn.
function bindHostButtons(game, root) {
  root.onclick = (e) => {
    const b = e.target.closest('button');
    const net = game.net;
    if (!b || !net || !net.isHost) return;
    const d = b.dataset, id = (k) => Number(d[k]);
    if (d.in) net.letIn(id('in'));
    else if (d.out) net.turnAway(id('out'));
    else if (d.role) {
      const p = net.players.find(x => x.id === id('role'));
      if (p) net.setRole(p.id, p.role === 'visitor' ? 'builder' : 'visitor');
    } else if (d.kick) {
      if (!d.confirm) { d.confirm = '1'; b.textContent = 'Really remove?'; b.classList.add('danger'); return; }
      net.kick(id('kick'));
    } else if (d.forgive) net.forgive(id('forgive'));
  };
}

export function showMultiplayer(game, { code = null } = {}) {
  const ui = game.ui, net = game.net;
  if (code != null) codeDraft = code;
  const inTown = !!(game.world && !game.demo);
  let h = `<h2>${TITLE}</h2>`;
  if (net && net.isHost) {
    const waiting = [...net.waiting.values()];
    h += `<p class="lead">You're hosting <b>${esc(game.world.townName)}</b>. Send this code to the people you'd like to build with:</p>
      <div class="mp-code${net.locked ? ' locked' : ''}">${formatCode(net.code)}</div>
      ${net.locked ? '<div class="mp-flag"><span class="ms">lock</span>Locked: nobody new can join until you unlock the town. Everyone here carries on.</div>' : ''}
      <div class="actions"><button class="btn primary" id="mpCopy">📋 Copy code</button><button class="btn" id="mpLink">🔗 Copy invite link</button>
        <button class="btn" id="mpRenew" ${renewing ? 'disabled' : ''} title="Get a different code. The old one stops working; everyone here stays.">${renewing ? 'Getting a new code…' : '🔄 New code'}</button></div>
      ${waiting.length ? `<h5>Waiting to join · ${waiting.length}</h5><div class="mp-players">${waiting.map(a => `<div class="mp-player mp-ask">${askHTML(a)}</div>`).join('')}</div>` : ''}
      <h5>Players · ${net.players.length} of ${MAX_PLAYERS}</h5>${playersHTML(net)}
      ${net.removed.length ? `<h5>Removed this session</h5><div class="mp-players">${net.removed.map(r => `<div class="mp-player"><b>${esc(r.name)}</b><span>turned away if they come back</span><button class="btn small" data-forgive="${r.id}">Allow back</button></div>`).join('')}</div>
        <p class="mp-p mp-small">They're recognised by their browser tab and their name. Someone determined could still come back from a new tab under another name, so keep <i>Ask me before anyone joins</i> on, or get a new code.</p>` : ''}
      <h5>Who can join</h5>
      <label class="mp-opt"><input type="checkbox" id="mpAsk" ${net.approve ? 'checked' : ''}> Ask me before anyone joins</label>
      <label class="mp-opt"><input type="checkbox" id="mpLock" ${net.locked ? 'checked' : ''}> Lock the town: nobody new can join</label>
      <label class="mp-opt">New players join as <select id="mpRole"><option value="builder" ${net.joinRole === 'builder' ? 'selected' : ''}>builders, who can do everything</option><option value="visitor" ${net.joinRole === 'visitor' ? 'selected' : ''}>visitors, who can only look</option></select></label>
      <div class="note">Your computer runs the town for everyone, so keep this tab open. Everything the others do comes to you and is checked against the same rules as your own building.</div>
      <div class="actions"><button class="btn danger" id="mpStop">Stop hosting</button></div>`;
  } else if (net && net.isGuest) {
    const host = net.host;
    h += `<p class="lead">You're in ${host ? `<b>${esc(host.name)}</b>'s` : 'a shared'} town, <b>${esc(game.world.townName)}</b>. Everything you do goes to the host, whose computer runs the town.</p>
      ${net.me?.role === 'visitor' ? `<div class="mp-flag"><span class="ms">visibility</span>You're a visitor: you can look around and point things out with your cursor, but only builders can change the town.</div>` : ''}
      <h5>Players · ${net.players.length}</h5>${playersHTML(net)}
      <div class="actions"><button class="btn" id="mpSave">💾 Save a copy here</button><button class="btn danger" id="mpLeave">Leave the town</button></div>`;
  } else if (attempt && attempt.waiting) {
    h += `<div class="mp-wait"><span class="ms spin">progress_activity</span><div><b>Waiting for the host to let you in…</b>
      <p class="mp-p">The host of <b>${esc(formatCode(attempt.code))}</b> has been asked whether to let <b>${esc(attempt.name)}</b> in. The town loads as soon as they say yes. If nobody answers within two minutes, you'll be told.</p></div></div>
      <div class="actions"><button class="btn" id="mpCancel">Stop waiting</button></div>`;
  } else {
    h += `<p class="lead">Build a town together, live. One player hosts: their computer runs the town, and the others join with its invite code. Only share codes with people you trust: as in any peer-to-peer game, the players you connect with can see your internet address.</p>
      <div class="field"><label>Your name</label><input id="mpName" maxlength="24" placeholder="Builder" value="${esc(loadName())}"></div>
      <div class="grid2 mp-cols">
        <div><h5>Host</h5>${inTown
          ? `<p class="mp-p">Open <b>${esc(game.world.townName)}</b> to other players and get a code to send them.</p><button class="btn primary" id="mpHost" ${attempt ? 'disabled' : ''}>🏡 Host this town</button>`
          : `<p class="mp-p">Start a village or continue your latest save, then share its code.</p><button class="btn primary" id="mpHostNew" ${attempt ? 'disabled' : ''}>🏡 New village and host</button>${LocalSaves.list().length ? `<button class="btn" id="mpHostLast" ${attempt ? 'disabled' : ''}>Continue and host</button>` : ''}`}</div>
        <div><h5>Join</h5><p class="mp-p">Enter the code from the host.${inTown ? ' Your own town is saved first.' : ''}</p>
          <div class="inline"><input id="mpCode" class="mp-code-in" maxlength="9" placeholder="ABC-DEF" value="${esc(codeDraft)}" autocomplete="off" spellcheck="false"><button class="btn primary" id="mpJoin" ${attempt ? 'disabled' : ''}>Join</button></div></div>
      </div>`;
    if (attempt) h += `<div class="mp-status"><span class="ms spin">progress_activity</span>${esc(attempt.text)}${attempt.loading ? '' : ' <button class="btn small" id="mpCancel">Cancel</button>'}</div>`;
    else if (status) h += `<div class="mp-status ${status.bad ? 'bad' : ''}">${esc(status.text)}</div>`;
    h += `<div class="note">Players find each other through the free PeerJS server; the town itself then travels directly between your browsers. When the host leaves, everyone else can keep a copy of the town.</div>`;
  }
  ui.openModal(h, (c) => {
    c.classList.add('mp-win');
    const $ = (id) => c.querySelector('#' + id);
    const name = $('mpName');
    if (name) name.oninput = () => storeName(name.value.trim());
    const code = $('mpCode');
    if (code) {
      code.oninput = () => { codeDraft = code.value; };
      code.onkeydown = (e) => { if (e.key === 'Enter') $('mpJoin')?.click(); };
      if (!attempt && !net) code.focus();
    }
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('mpHost', () => startHosting(game));
    on('mpHostNew', () => ui.showNewGame((o) => { game.newGame(o); startHosting(game); }));
    on('mpHostLast', () => {
      const latest = [...LocalSaves.list()].sort((a, b) => (b.savedAt > a.savedAt ? 1 : -1))[0];
      if (!latest) return;
      try { game.loadData(LocalSaves.load(latest.id)); startHosting(game); } catch (e) { ui.toast(e.message, 'bad'); }
    });
    on('mpJoin', () => startJoining(game, codeDraft));
    on('mpCancel', () => { attempt?.session?.close(); attempt = null; status = null; refresh(game); });
    if (net && net.isHost) {
      bindHostButtons(game, c);
      on('mpCopy', () => copy(game, formatCode(net.code), 'Invite code'));
      on('mpLink', () => copy(game, inviteLink(net.code), 'Invite link'));
      on('mpRenew', () => renewCode(game));
      $('mpAsk').onchange = (e) => net.setApprove(e.target.checked);
      $('mpLock').onchange = (e) => {
        net.setLocked(e.target.checked);
        ui.toast(net.locked ? 'Town locked: nobody new can join' : 'Town unlocked: people with the code can join again', 'info', net.locked ? '🔒' : '🔓');
      };
      $('mpRole').onchange = (e) => net.setJoinRole(e.target.value);
    }
    on('mpStop', () => {
      const b = $('mpStop');
      if (!b.dataset.confirm && net.players.length > 1) { b.dataset.confirm = '1'; b.textContent = 'Stop? Everyone else is disconnected'; return; }
      game.endNet();
      ui.toast('Stopped hosting. The town is yours alone again.', 'info', '🏡');
      refresh(game);
    });
    on('mpSave', () => { if (game.saveLocal('s' + Date.now().toString(36))) ui.toast(`Saved a copy of ${game.world.townName} in this browser`, 'good', '💾'); });
    on('mpLeave', () => {
      const s = game.net;
      if (!s) return;
      game.net = null;
      s.close();
      showNetEnded(game, 'left');
    });
  });
}

async function renewCode(game) {
  const net = game.net;
  if (renewing || !net || !net.isHost) return;
  renewing = true;
  refresh(game);
  try {
    const c = await net.newCode();
    if (c) game.ui.toast(`New invite code ${formatCode(c)}. The old one no longer works; everyone here stays.`, 'good', '🔄');
  } catch (e) { game.ui.toast(e.message || "Couldn't get a new code. Try again in a moment.", 'bad'); }
  renewing = false;
  renderNetBox(game);
  refresh(game);
}

async function startHosting(game) {
  if (attempt || game.net || !game.world || game.demo) return;
  const ui = game.ui, w = game.world, me = { kind: 'host', text: 'Connecting to the PeerJS server…' };
  attempt = me; status = null;
  showMultiplayer(game);
  const session = new HostSession(game, { name: nameOf() });
  try {
    const t = await listen({ onLink: (raw) => session.addLink(makeLink(raw)), onTrouble: (msg) => ui.toast(msg, 'bad') });
    if (attempt !== me || game.world !== w || game.demo || game.net) { t.close(); session.close(); return; }
    session.code = t.code;
    session.transport = t;
    session.onChange = () => { renderNetBox(game); refresh(game); };
    game.net = session;
    attempt = null;
    ui.toast(`Hosting ${w.townName}: invite code ${formatCode(t.code)}`, 'good', '🏡');
    game.sfx('upgrade');
  } catch (e) {
    session.close();
    if (attempt === me) { attempt = null; status = { text: e.message, bad: true }; }
  }
  renderNetBox(game);
  refresh(game);
}

async function startJoining(game, input) {
  if (attempt || game.net) return;
  const code = cleanCode(input);
  if (!code) {
    status = { text: "That isn't an invite code. Codes are six letters and numbers, like K7Q-M2P (there's no O, 0, I, 1 or L).", bad: true };
    refresh(game);
    return;
  }
  const ui = game.ui, me = { kind: 'join', text: `Looking for the town ${formatCode(code)}…`, code, name: nameOf() };
  attempt = me; status = null;
  refresh(game);
  let t = null;
  try {
    t = await connect(code);
    if (attempt !== me) { t.channel.close(); return; }
    me.text = 'Connected. Loading the town…';
    me.loading = true;
    refresh(game);
    const session = new GuestSession(game, makeLink(t.channel), {
      name: me.name, transport: t,
      onEnd: (why) => showNetEnded(game, why),
      onChange: () => { renderNetBox(game); refresh(game); },
      // the host is being asked: show the waiting screen, even if the window was closed
      onWait: () => { if (attempt !== me) return; me.waiting = true; me.loading = false; showMultiplayer(game); },
    });
    me.session = session;
    await session.join();
    attempt = null;
    const host = session.host;
    ui.toast(`Welcome to ${game.world.townName}${host ? `, ${host.name}'s town` : ''}!`, 'big', '👪');
    if (session.me?.role === 'visitor') ui.toast("You're a visitor: you can look around and point things out, but only builders can change the town", 'info', '👀');
    game.sfx('upgrade');
  } catch (e) {
    if (t) t.channel.close();
    if (attempt === me) { attempt = null; status = { text: e.message, bad: true }; }
  }
  renderNetBox(game);
  // a refusal after a long wait is worth bringing back into view
  if (status && status.bad && !game.net && !isOpen(game)) showMultiplayer(game); else refresh(game);
}

// The host closed the town, the connection dropped, we left or were removed: keep a copy?
export function showNetEnded(game, why) {
  const ui = game.ui, town = game.world ? game.world.townName : 'the town';
  if (game.net && game.net.closed) game.net = null;
  game.cursors.clear();
  game.applySpeed(0);
  renderNetBox(game);
  const win = ui.windows && ui.windows.get(TITLE);
  if (win) ui.closeWindow(win);
  const head = why === 'ended' ? 'Town closed' : why === 'left' ? 'You left the town' : why === 'kicked' ? 'Removed from the town' : 'Connection lost';
  const msg = why === 'ended' ? `The host has closed <b>${esc(town)}</b>.` : why === 'left' ? `You left <b>${esc(town)}</b>.`
    : why === 'kicked' ? `The host removed you from <b>${esc(town)}</b>.` : `The connection to the host of <b>${esc(town)}</b> was lost.`;
  ui.openModal(`<h2>${head}</h2><p class="lead">${msg} The town as it was is still here on your screen. Would you like to keep it as your own copy?</p>
    <div class="actions col">
      <button class="btn primary" id="neKeep">🏡 Keep playing it on my own</button>
      <button class="btn" id="neSave">💾 Save a copy in this browser</button>
      <button class="btn" id="neDl">⬇ Download a copy (.json)</button>
      <button class="btn" id="neTitle">Back to the title screen</button>
    </div>`, (c) => {
    c.querySelector('#neKeep').onclick = () => {
      const data = serialize(game.world);
      ui.closeModal();
      game.loadData(data);
      ui.toast(`${town} is yours now: it carries on here on its own.`, 'good', '🏡');
    };
    c.querySelector('#neSave').onclick = (e) => { if (game.saveLocal('s' + Date.now().toString(36), true)) { e.target.textContent = '✓ Saved in this browser'; e.target.disabled = true; } };
    c.querySelector('#neDl').onclick = () => downloadJSON(serialize(game.world), saveFileName(game.world));
    c.querySelector('#neTitle').onclick = () => { ui.closeModal(); game.toTitle(); };
  }, true);
}

// A prompt under the top bar for each newcomer the host hasn't answered yet,
// so it can be answered without opening the window.
function renderNetAsk(game) {
  const n = game.net;
  const list = n && n.isHost && !n.closed ? [...n.waiting.values()] : [];
  let el = document.getElementById('netAsk');
  if (!list.length) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'netAsk';
    el.className = 'mp-asks';
    (document.getElementById('hud') || document.body).appendChild(el);
    bindHostButtons(game, el);
  }
  el.innerHTML = list.map(a => `<div class="panel mp-ask">${askHTML(a)}</div>`).join('');
  // just under the top bar, which takes two rows on a narrow screen
  const bar = document.querySelector('#hud .topbar');
  if (bar) el.style.top = `${Math.round(bar.getBoundingClientRect().bottom) + 6}px`;
}

// The players box in the top bar.
export function renderNetBox(game) {
  renderNetAsk(game);
  const el = document.getElementById('netBox');
  if (!el) return;
  const n = game.net;
  if (!n || !n.players || (n.isGuest && !n.me)) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const dots = n.players.map(p => `<i style="background:${esc(p.color)}" title="${esc(p.name)}${p.host ? ' (host)' : p.role === 'visitor' ? ' (visitor)' : ''}">${esc((p.name[0] || '?').toUpperCase())}</i>`).join('');
  const locked = n.isHost && n.locked;
  el.innerHTML = `<span class="ms">${n.isHost ? 'podcasts' : 'group'}</span><span class="mp-dots">${dots}</span>${n.isHost && n.code ? `<b>${formatCode(n.code)}</b>` : ''}${locked ? '<span class="ms mp-lock">lock</span>' : ''}`;
  el.title = `${n.isHost ? `Hosting · code ${formatCode(n.code)}${locked ? ' · locked' : ''}` : 'In a shared town'} · ${n.players.map(p => p.name).join(', ')} (M)`;
}
