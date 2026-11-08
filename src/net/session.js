// Multiplayer sessions. The host's game is the real town; each guest holds a
// copy that follows it (sync.js) and sends the host a command (../commands.js)
// for everything its player does. The host checks and applies those exactly
// as it does its own, then tells everyone what changed.
//
// Sessions talk over links: reliable, ordered message channels to one peer.
// peer.js makes them from WebRTC data channels; scripts/net-check.js joins
// two games in memory instead.
//
// The host decides who is in the town: by default it is asked about each
// newcomer before they get in, it can lock the town, remove a player (who is
// then turned away for the rest of the session), and make a player a visitor
// who can look around but not change anything.

import { BUILDINGS } from '../defs.js';
import { ROAD_LEVELS } from '../config.js';
import { runCommand, packResult, unpackResult, describeCommand, VISITOR_REASON } from '../commands.js';
import { PROTOCOL, Tracker, makeSnapshot, applyDelta } from './sync.js';
import { cleanColor } from '../util/text.js';

export const COLORS = ['#e8b830', '#3d8fe0', '#e0503f', '#4fb84a', '#a86ae0', '#f0862f', '#2fb8a8', '#e060a8'];
export const MAX_PLAYERS = 8;
export const ROLES = ['builder', 'visitor'];
export const APPROVE_WAIT = 120000;   // ms a newcomer waits for the host to let them in
const MAX_WAITING = 4;         // newcomers waiting for an answer at once
const TURNED_AWAY = 30000;     // ms before someone the host turned away can ask again
const LOCKED = 'The host has locked this town: nobody new can join right now.';
const FULL = `This town is full (${MAX_PLAYERS} players).`;
const TICK = 0.2;              // seconds between deltas
const KEYFRAME = 15;           // seconds between keyframes
const CURSOR = 0.1;            // seconds between cursor updates
const PING = 2000;             // ms between heartbeats
const HOST_SILENCE = 45000;    // ms of silence before the host gives up on a guest
const GUEST_SILENCE = 20000;   // ...and a guest on the host
const CHUNK = 15000;           // characters per data channel message
// Limits on what another player can send: a guest's messages are small (a
// command, a cursor); the host's can be a whole town. Anything bigger, or
// faster than a person could click, is dropped.
const MAX_FROM_GUEST = 256 * 1024, MAX_FROM_HOST = 64 * 1024 * 1024;
const RATES = { cmd: [15, 40], cur: [25, 50] };   // per second, burst
const HELLO_WAIT = 20000;      // ms a new connection has to say who it is

// ---------------------------------------------------------------- links

// Wrap a raw string channel { send(s), onData(fn), onClose(fn), close() } as a
// message link. Long messages (a town snapshot) go in pieces.
export function makeLink(raw) {
  const L = { onMessage: null, onClose: null, closed: false, sent: 0, received: 0, lastHeard: Date.now(), maxMessage: MAX_FROM_HOST,
    peer: typeof raw.peer === 'string' ? raw.peer.slice(0, 64) : null };
  let buf = null, need = 0, got = 0;
  const deliver = (s) => {
    let m;
    try { m = JSON.parse(s); } catch { return; }
    if (m && typeof m === 'object') L.onMessage?.(m);
  };
  raw.onData((s) => {
    if (typeof s !== 'string' || L.closed) return;
    L.lastHeard = Date.now();
    L.received += s.length;
    if (s[0] === '#') {
      const bar = s.indexOf('|'), n = Number(s.slice(1, bar));
      buf = null;
      if (bar < 0 || !Number.isInteger(n) || n <= 0 || n > L.maxMessage) return;
      need = n; buf = [s.slice(bar + 1)]; got = buf[0].length;
    } else if (s[0] === '+' && buf) {
      if (got + s.length - 1 > need) { buf = null; return; }
      buf.push(s.slice(1)); got += s.length - 1;
    } else { if (s.length <= L.maxMessage) deliver(s); return; }
    if (got >= need) { const all = buf.join(''); buf = null; deliver(all); }
  });
  raw.onClose(() => { if (L.closed) return; L.closed = true; L.onClose?.(); });
  L.sendText = (s) => {
    if (L.closed) return;
    L.sent += s.length;
    try {
      if (s.length <= CHUNK) { raw.send(s); return; }
      for (let i = 0; i < s.length;) {
        let end = Math.min(s.length, i + CHUNK);
        const c = s.charCodeAt(end - 1);
        if (end < s.length && c >= 0xd800 && c <= 0xdbff) end--;   // never split a character in two
        raw.send((i === 0 ? `#${s.length}|` : '+') + s.slice(i, end));
        i = end;
      }
    } catch (e) { console.warn('Multiplayer: send failed', e); }
  };
  L.send = (m) => L.sendText(JSON.stringify(m));
  L.close = () => { if (L.closed) return; L.closed = true; try { raw.close(); } catch {} };
  return L;
}

// ------------------------------------------------------------- cursors

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>"`]/g, '').trim().slice(0, 24);
// names compared for the removed list: case and spacing don't matter
const nameKey = (s) => cleanName(s).toLowerCase().replace(/\s+/g, ' ');
// a player record from the host, kept to what the game uses
const cleanPlayer = (p) => ({ id: Number.isInteger(p?.id) ? p.id : -1, name: cleanName(p?.name) || 'Player', color: cleanColor(p?.color, '#888888'), host: p?.host === true,
  role: p?.role === 'visitor' ? 'visitor' : 'builder' });
const cleanPlayers = (list) => (Array.isArray(list) ? list.slice(0, MAX_PLAYERS).map(cleanPlayer) : []);

// What a player's pointer is over, what they have selected and what tool they hold.
function cursorOf(game) {
  const h = game.input.hover, sel = game.ui.selection, t = game.input.tool;
  let act = '';
  if (t.kind === 'build') act = BUILDINGS[t.type]?.levels[0].name || '';
  else if (t.kind === 'road') act = ROAD_LEVELS[t.level]?.name || '';
  else if (t.kind === 'rail') act = 'Laying track';
  else if (t.kind === 'roadsel') act = 'Picking roads';
  else if (t.kind === 'bulldoze') act = 'Demolishing';
  else if (t.kind === 'terrain') act = t.mode === 'flatten' ? 'Levelling land' : t.mode === 'raise' ? 'Raising land' : 'Lowering land';
  else if (t.kind === 'trees') act = 'Planting trees';
  else if (t.kind === 'line') act = 'Planning a line';
  else if (t.kind === 'move') act = 'Moving a building';
  const r2 = (v) => Math.round(v * 100) / 100;
  return { x: h ? r2(h.x) : null, z: h ? r2(h.z) : null, sel: sel && sel.kind === 'building' ? sel.id : null, act };
}

function cleanCursor(c) {
  if (!c || typeof c !== 'object') return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 && v < 1e6 ? v : null), f = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e4 ? v : null);
  return { x: f(c.x), z: f(c.z), sel: n(c.sel), act: typeof c.act === 'string' ? c.act.slice(0, 32) : '' };
}

class Peerish {
  _sendCursor(dt, send) {
    this._curT = (this._curT || 0) + dt;
    if (this._curT < CURSOR || !this.game.world || !this.game.input) return;
    this._curT = 0;
    const c = cursorOf(this.game), key = JSON.stringify(c);
    if (key === this._curKey) return;
    this._curKey = key;
    send(c);
  }

  _showCursor(pid, c) {
    const cur = this.game.cursors;
    if (!cur || pid === this.me?.id) return;
    const p = this.players.find(x => x.id === pid);
    if (!c || !p) cur.remove(pid); else cur.set(pid, { ...c, name: p.name, color: p.color });
  }
}

// ---------------------------------------------------------------- host

export class HostSession extends Peerish {
  constructor(game, { name, code = null, transport = null, onChange = null, approve = true }) {
    super();
    this.game = game;
    this.isHost = true;
    this.isGuest = false;
    this.code = code;
    this.transport = transport;
    this.onChange = onChange;
    this.me = { id: 0, name: cleanName(name) || 'Host', color: COLORS[0], host: true, role: 'builder' };
    this.players = [this.me];
    // who may come in
    this.approve = approve;      // ask the host about each newcomer
    this.locked = false;         // nobody new at all
    this.joinRole = 'builder';   // what newcomers start as
    this.approveWait = APPROVE_WAIT;
    this.waiting = new Map();    // link → { id, name, at, timer }: newcomers the host hasn't answered yet
    this.removed = [];           // { id, name, key, peer }: players removed this session
    this.turnedAway = new Map(); // peer id or name key → time they may ask again
    this._ask = 0;
    this.guests = new Map();     // link → player
    this.buckets = new Map();    // link → message allowances
    this.cursors = new Map();    // player id → last cursor
    this.events = [];
    this.notes = new Map();
    this.tracker = new Tracker(game);
    this._t = 0; this._k = 0; this._next = 1;
    this.closed = false;
    const ev = (...a) => { if (!this.closed && this.guests.size) this.events.push(a); };
    this._handlers = [
      ['arrived', ({ building, family }) => ev('arrive', building.id, family.map(r => r.id))],
      ['died', (gone) => { for (const r of gone) this.tracker.died.add(r.id); ev('died', gone.map(r => ({ first: r.first, last: r.last, years: r.years }))); }],
      ['born', (babies) => ev('born', babies.map(r => ({ first: r.first, last: r.last })))],
      ['graduated', ({ r, st }) => ev('graduated', { r: { first: r.first, last: r.last }, st })],
      ['season', (s) => ev('season', s)],
      ['milestone', (t) => ev('milestone', { pop: t.pop, name: t.name })],
      ['departed', ({ count }) => ev('departed', { count })],
      ['command', (e) => this._note(e)],
    ];
    for (const [e, fn] of this._handlers) game.on(e, fn);
    game.world.on('land:sold', (e) => ev('land', e.buyer.id, e.seller.id, e.price));
    this._ping = setInterval(() => this._heartbeat(), PING);
  }

  get playerCount() { return this.players.length; }

  // A guest's link is open: they say hello first.
  addLink(link) {
    if (this.closed) { link.close(); return; }
    link.maxMessage = MAX_FROM_GUEST;
    // a connection that never says who it is doesn't get to linger
    setTimeout(() => { if (!this.guests.has(link) && !this.waiting.has(link) && !link.closed) link.close(); }, HELLO_WAIT);
    link.onMessage = (m) => this._onMessage(link, m);
    link.onClose = () => this._drop(link, 'left');
  }

  _onMessage(link, m) {
    if (this.closed) return;
    if (m.t === 'hello') { this._hello(link, m); return; }
    if (m.t === 'bye' && this.waiting.has(link)) { this._drop(link, 'left'); link.close(); return; }
    const p = this.guests.get(link);
    if (!p) return;
    if ((m.t === 'cmd' || m.t === 'cur') && !this._allow(link, m.t)) {
      if (m.t === 'cmd') link.send({ t: 'res', id: Number.isInteger(m.id) ? m.id : 0, r: { ok: false, reason: 'Too many actions at once: slow down a little' } });
      return;
    }
    switch (m.t) {
      case 'cmd': {
        let r;
        try { r = runCommand(this.game, m.c, p); } catch (e) { console.error('Multiplayer: command failed', m.c, e); r = { ok: false, reason: 'Something went wrong on the host' }; }
        // everyone gets the change first, so the result finds it already in place
        this.flush();
        link.send({ t: 'res', id: Number.isInteger(m.id) ? m.id : 0, r: packResult(r) });
        break;
      }
      case 'cur': {
        const c = cleanCursor(m.c);
        this.cursors.set(p.id, c);
        this._showCursor(p.id, c);
        this._broadcast({ t: 'cur', p: p.id, c }, link);
        break;
      }
      case 'bye': this._drop(link, 'left'); link.close(); break;
    }
  }

  // A guest may only send so many commands and cursor moves a second.
  _allow(link, kind) {
    const [rate, burst] = RATES[kind], now = performance.now();
    let b = this.buckets.get(link);
    if (!b) this.buckets.set(link, b = {});
    const k = b[kind] || (b[kind] = { n: burst, t: now });
    k.n = Math.min(burst, k.n + ((now - k.t) / 1000) * rate);
    k.t = now;
    if (k.n < 1) return false;
    k.n -= 1;
    return true;
  }

  // A newcomer says who they are. They come straight in, wait for the host to
  // answer, or are turned away.
  _hello(link, m) {
    if (this.guests.has(link) || this.waiting.has(link)) return;
    if (m.proto !== PROTOCOL) { this._refuse(link, 'This town is running a different version of Kinstead. Reload both pages and try again.'); return; }
    const name = cleanName(m.name), key = nameKey(name);
    if (this.locked) { this._refuse(link, LOCKED); return; }
    if (this.players.length >= MAX_PLAYERS) { this._refuse(link, FULL); return; }
    if (this.removed.some(r => (link.peer && r.peer === link.peer) || (key && r.key === key))) {
      this._refuse(link, 'The host removed you from this town earlier, so you can\'t join it again this session.');
      this.game.ui?.toast(`Turned away ${name || 'a player'}: you removed them earlier`, 'info', '🚪');
      return;
    }
    const now = Date.now();
    if ([link.peer, key].some(k => k && this.turnedAway.get(k) > now)) { this._refuse(link, 'The host said no a moment ago. Try again later.'); return; }
    if (!this.approve) { this._admit(link, name); return; }
    if (this.waiting.size >= MAX_WAITING) { this._refuse(link, 'Several people are already waiting for the host to answer. Try again in a minute.'); return; }
    const ask = { id: ++this._ask, name: name || 'Someone', given: name, at: now };
    ask.timer = setTimeout(() => this.turnAway(ask.id, 'timeout'), this.approveWait);
    this.waiting.set(link, ask);
    link.send({ t: 'wait', ms: this.approveWait });
    this.game.ui?.toast(`${ask.name} wants to join ${this.game.world.townName}`, 'big', '🚪');
    this.game.sfx?.('coin');
    this.onChange?.();
  }

  // Turn a connection down. Nothing more it sends counts, even another hello.
  _refuse(link, reason) {
    link.onMessage = null;
    link.send({ t: 'refuse', reason });
    setTimeout(() => link.close(), 1500);
  }

  _waitingLink(id) {
    for (const [link, ask] of this.waiting) if (ask.id === id) return link;
    return null;
  }

  _linkOf(pid) {
    for (const [link, p] of this.guests) if (p.id === pid) return link;
    return null;
  }

  // The host lets a waiting newcomer in.
  letIn(id) {
    const link = this._waitingLink(id);
    if (!link || this.closed) return false;
    const ask = this.waiting.get(link);
    clearTimeout(ask.timer);
    this.waiting.delete(link);
    if (this.players.length >= MAX_PLAYERS) { this._refuse(link, FULL); this.onChange?.(); return false; }
    this._admit(link, ask.given);
    return true;
  }

  // ...or turns them away ('no'), or nobody answered in time ('timeout'), or
  // the town was locked while they waited ('locked').
  turnAway(id, why = 'no') {
    const link = this._waitingLink(id);
    if (!link) return false;
    const ask = this.waiting.get(link);
    clearTimeout(ask.timer);
    this.waiting.delete(link);
    if (why === 'no') {
      const until = Date.now() + TURNED_AWAY;
      for (const k of [link.peer, nameKey(ask.given)]) if (k) this.turnedAway.set(k, until);
    }
    this._refuse(link, why === 'timeout' ? "The host didn't answer within two minutes. Try again, or let them know you're waiting."
      : why === 'locked' ? LOCKED : 'The host turned down your request to join.');
    if (why === 'timeout' && !this.closed) this.game.ui?.toast(`${ask.name} gave up waiting to join`, 'info', '🚪');
    this.onChange?.();
    return true;
  }

  // Remove a player. They're told, and turned away if they come back this
  // session from the same browser tab or under the same name.
  kick(pid) {
    const link = this._linkOf(pid);
    if (!link) return false;
    const p = this.guests.get(link);
    this.removed.push({ id: ++this._ask, name: p.name, key: nameKey(link.given), peer: link.peer });
    link.onMessage = null;
    link.send({ t: 'kick' });
    this._drop(link, 'kicked');
    setTimeout(() => link.close(), 400);
    return true;
  }

  // Let a removed player back in (they still have to ask, if asking is on).
  forgive(id) {
    const n = this.removed.length;
    this.removed = this.removed.filter(r => r.id !== id);
    if (this.removed.length !== n) this.onChange?.();
    return this.removed.length !== n;
  }

  // Builders can do everything; visitors can look and point but not change the town.
  setRole(pid, role) {
    const link = this._linkOf(pid);
    if (!link || !ROLES.includes(role)) return false;
    const p = this.guests.get(link);
    if (p.role === role) return true;
    p.role = role;
    this._broadcast({ t: 'players', list: this.players });
    this.onChange?.();
    return true;
  }

  setLocked(on) {
    this.locked = !!on;
    if (this.locked) for (const ask of [...this.waiting.values()]) this.turnAway(ask.id, 'locked');
    this.onChange?.();
  }

  setApprove(on) { this.approve = !!on; this.onChange?.(); }

  setJoinRole(role) { if (ROLES.includes(role)) { this.joinRole = role; this.onChange?.(); } }

  // A new invite code: the old one stops working, everyone here stays.
  async newCode() {
    if (!this.transport?.renew || this.closed) throw new Error("This town's code can't be changed.");
    const code = await this.transport.renew();
    if (this.closed) return null;
    this.code = code;
    this.onChange?.();
    return code;
  }

  _admit(link, given) {
    const id = this._next++;
    const used = new Set(this.players.map(p => p.color));
    link.given = given;
    const player = { id, name: given || `Guest ${id}`, color: COLORS.find(c => !used.has(c)) || COLORS[id % COLORS.length], role: this.joinRole };
    // bring everyone else up to date, then hand the newcomer the town as it is now
    if (this.guests.size) this.flush(); else { this.tracker.reset(); this.events.length = 0; }
    this.guests.set(link, player);
    this.players.push(player);
    const cursors = [[0, this._myCursor || null], ...[...this.cursors].filter(([pid]) => pid !== id)];
    link.send({ t: 'welcome', you: player, players: this.players, snap: makeSnapshot(this.game), cursors });
    this._broadcast({ t: 'players', list: this.players }, link);
    this.game.ui?.toast(`${player.name} joined ${this.game.world.townName}${player.role === 'visitor' ? ' as a visitor' : ''}`, 'good', '👪');
    this.game.sfx?.('click');
    this.onChange?.();
  }

  // A player (or a newcomer still waiting) is gone: they left, went quiet or were removed.
  _drop(link, why) {
    const ask = this.waiting.get(link);
    if (ask) {
      clearTimeout(ask.timer);
      this.waiting.delete(link);
      if (!this.closed) this.game.ui?.toast(`${ask.name} stopped waiting to join`, 'info', '🚪');
      this.onChange?.();
      return;
    }
    const p = this.guests.get(link);
    if (!p) return;
    this.guests.delete(link);
    this.buckets.delete(link);
    this.cursors.delete(p.id);
    this.players = this.players.filter(x => x !== p);
    this.game.cursors?.remove(p.id);
    this._broadcast({ t: 'players', list: this.players });
    if (!this.closed) {
      this.game.ui?.toast(why === 'timeout' ? `Lost touch with ${p.name}` : why === 'kicked' ? `Removed ${p.name} from the town` : `${p.name} left the town`,
        'info', why === 'kicked' ? '🚪' : '🧳');
    }
    this.onChange?.();
  }

  update(dt) {
    if (this.closed) return;
    this._t += dt; this._k += dt;
    if (this._t >= TICK) {
      this._t = 0;
      const full = this._k >= KEYFRAME;
      if (full) this._k = 0;
      this.flush(full);
    }
    this._sendCursor(dt, (c) => { this._myCursor = c; this._broadcast({ t: 'cur', p: 0, c }); });
    this._flushNotes();
  }

  // Send everyone what changed since last time.
  flush(full = false) {
    if (!this.guests.size) { this.events.length = 0; return; }
    const d = this.tracker.diff({ full, events: this.events.splice(0) });
    if (d) this._broadcast({ t: 'delta', d });
  }

  _broadcast(m, except = null) {
    if (!this.guests.size) return;
    const s = JSON.stringify(m);
    for (const link of this.guests.keys()) if (link !== except) link.sendText(s);
  }

  // Tell the other players about the actions worth knowing about (the last
  // of a run of tax changes, not each step of the slider).
  _note({ cmd, r, from }) {
    if (!this.guests.size) return;
    const text = describeCommand(cmd, r, this.game.world);
    if (!text) return;
    const who = from || this.me;
    this.notes.set(`${who.id}:${cmd.t}`, { who, text: `${who.name} ${text}`, at: performance.now() + (cmd.t === 'tax' ? 900 : 0) });
  }

  _flushNotes() {
    const now = performance.now();
    for (const [k, n] of this.notes) {
      if (now < n.at) continue;
      this.notes.delete(k);
      if (n.who !== this.me) this.game.ui?.toast(n.text, 'info', '👪');
      this._broadcast({ t: 'note', text: n.text, by: n.who.id });
    }
  }

  _heartbeat() {
    const now = Date.now();
    for (const link of [...this.guests.keys(), ...this.waiting.keys()]) {
      if (now - link.lastHeard > HOST_SILENCE) { this._drop(link, 'timeout'); link.close(); }
      else link.send({ t: 'ping' });
    }
  }

  // Stop hosting: guests are told the town has closed, and anyone still
  // waiting to come in is turned away.
  close(reason = 'ended') {
    if (this.closed) return;
    this._broadcast({ t: 'end', reason });
    this.closed = true;
    clearInterval(this._ping);
    for (const [e, fn] of this._handlers) this.game.off(e, fn);
    for (const [link, ask] of this.waiting) { clearTimeout(ask.timer); this._refuse(link, 'The host closed the town.'); }
    this.waiting.clear();
    const links = [...this.guests.keys()];
    this.guests.clear();
    this.players = [this.me];
    this.game.cursors?.clear();
    // give the goodbye a moment to go out
    setTimeout(() => { for (const l of links) l.close(); this.transport?.close(); }, 400);
  }
}

// --------------------------------------------------------------- guest

export class GuestSession extends Peerish {
  constructor(game, link, { name, onEnd = null, onChange = null, onWait = null, transport = null }) {
    super();
    this.game = game;
    this.link = link;
    this.isHost = false;
    this.isGuest = true;
    this.name = cleanName(name) || 'Guest';
    this.onEnd = onEnd;
    this.onChange = onChange;
    this.onWait = onWait;        // the host is being asked whether to let us in
    this.transport = transport;
    this.waiting = false;
    this.pending = new Map();
    this._rid = 0;
    this.players = [];
    this.me = null;
    this.closed = false;
    link.onMessage = (m) => this._onMessage(m);
    link.onClose = () => this._ended('lost');
    this._ping = setInterval(() => this._heartbeat(), PING);
  }

  get host() { return this.players.find(p => p.host) || null; }
  get playerCount() { return this.players.length; }

  // Say hello and wait for the town; resolves once it is loaded here, which
  // may be after the host has been asked whether to let us in.
  join() {
    return new Promise((resolve, reject) => {
      this._join = { resolve, reject };
      this.link.send({ t: 'hello', proto: PROTOCOL, name: this.name });
    });
  }

  // Ask the host to do something; done(result) runs when it answers.
  request(c, done) {
    if (this.closed || !this.me) { done?.({ ok: false, reason: 'Not connected to the host' }); return; }
    // the host would refuse it anyway; say why straight away
    if (this.me.role === 'visitor') {
      const now = performance.now();
      if (now - (this._visitorNote || -1e9) > 2500) { this._visitorNote = now; this.game.ui?.toast(VISITOR_REASON, 'bad', '👀'); }
      done?.({ ok: false, reason: VISITOR_REASON, failed: VISITOR_REASON });
      return;
    }
    const id = ++this._rid;
    if (done) this.pending.set(id, done);
    this.link.send({ t: 'cmd', id, c });
  }

  _onMessage(m) {
    if (this.closed) return;
    switch (m.t) {
      case 'wait': {
        if (!this._join || this.me) break;
        this.waiting = true;
        const ms = Number.isFinite(m.ms) ? Math.min(Math.max(m.ms, 5000), 600000) : APPROVE_WAIT;
        clearTimeout(this._waitT);
        // the host should answer or say no in time; if it doesn't, stop waiting anyway
        this._waitT = setTimeout(() => this._fail("The host didn't let you in within two minutes. Try again, or let them know you're waiting."), ms + 10000);
        this.onWait?.();
        break;
      }
      case 'welcome': {
        if (this.me) break;
        clearTimeout(this._waitT);
        this.waiting = false;
        this.me = cleanPlayer(m.you);
        this.players = cleanPlayers(m.players);
        try { this.game.joinTown(m.snap, this); } catch (e) {
          console.error('Multiplayer: could not load the town', e);
          this._join?.reject(new Error("The host's town couldn't be loaded here."));
          this._join = null;
          this.close();
          return;
        }
        for (const [pid, c] of m.cursors || []) this._showCursor(pid, c);
        this._join?.resolve();
        this._join = null;
        this.onChange?.();
        break;
      }
      case 'refuse':
        this._fail(typeof m.reason === 'string' && m.reason ? m.reason.slice(0, 200) : 'The host turned the connection down.');
        break;
      case 'kick': this._ended('kicked'); break;
      case 'delta': {
        if (!this.me) break;
        const out = applyDelta(this.game, m.d);
        if (out.sandbox) this.game.ui?.refreshAfterSandbox?.();
        break;
      }
      case 'res': {
        const cb = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (cb) cb(unpackResult(m.r, this.game.world));
        break;
      }
      case 'players': {
        this.players = cleanPlayers(m.list);
        const mine = this.me && this.players.find(p => p.id === this.me.id);
        if (mine) {
          if (mine.role !== this.me.role) {
            this.game.ui?.toast(mine.role === 'visitor' ? 'The host made you a visitor: you can look around, but not change the town'
              : 'The host made you a builder: you can build again', 'big', mine.role === 'visitor' ? '👀' : '🔨');
          }
          this.me = mine;
        }
        const ids = new Set(this.players.map(p => p.id));
        for (const pid of [...(this.game.cursors?.list.keys() || [])]) if (!ids.has(pid)) this.game.cursors.remove(pid);
        this.onChange?.();
        break;
      }
      case 'cur': this._showCursor(m.p, cleanCursor(m.c)); break;
      case 'note': if (m.by !== this.me?.id && typeof m.text === 'string') this.game.ui?.toast(m.text.slice(0, 200), 'info', '👪'); break;
      case 'end': this._ended(m.reason || 'ended'); break;
    }
  }

  update(dt) {
    if (this.closed || !this.me) return;
    this._sendCursor(dt, (c) => this.link.send({ t: 'cur', c }));
  }

  _heartbeat() {
    if (this.closed) return;
    if (Date.now() - this.link.lastHeard > GUEST_SILENCE) { this._ended('lost'); return; }
    this.link.send({ t: 'ping' });
  }

  _stop() {
    this.closed = true;
    this.waiting = false;
    clearInterval(this._ping);
    clearTimeout(this._waitT);
    const pend = [...this.pending.values()];
    this.pending.clear();
    for (const cb of pend) cb({ ok: false, reason: 'Not connected to the host any more' });
    this.game.cursors?.clear();
  }

  // The host closed the town, or the connection dropped.
  _ended(why) {
    if (this.closed) return;
    const joining = this._join;
    this._join = null;
    this._stop();
    this.link.close();
    this.transport?.close();
    if (joining) joining.reject(new Error('The connection to the host closed before the town arrived.'));
    else this.onEnd?.(why);
  }

  // Joining didn't work out: the host said no, or never answered.
  _fail(message) {
    const joining = this._join;
    this._join = null;
    this.close();
    joining?.reject(new Error(message));
  }

  // Leave of our own accord (or stop waiting to be let in).
  close() {
    if (this.closed) return;
    const joining = this._join;
    this._join = null;
    this.link.send({ t: 'bye' });
    this._stop();
    joining?.reject(new Error('You stopped waiting.'));
    setTimeout(() => { this.link.close(); this.transport?.close(); }, 300);
  }
}
