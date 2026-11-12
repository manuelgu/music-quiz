import { DurableObject } from 'cloudflare:workers';

// Room codes avoid look-alike letters (I, O) so they're easy to read off a TV.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_TTL = 24 * 3600e3;          // a room is forgotten 24h after its last activity
const MAX_TEAMS = 40;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const token = (n = 24) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const scoreOf = marks => Object.values(marks || {}).reduce((s, m) => s + (m.t ? 1 : 0) + (m.a ? 1 : 0), 0);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/api/rooms' && req.method === 'POST') {
      for (let i = 0; i < 10; i++) {
        const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
        if (code === 'PLAY') continue;              // /PLAY is the join page, not a short link
        const res = await env.ROOMS.get(env.ROOMS.idFromName(code)).create(code);
        if (res) return json({ code, hostToken: res.hostToken, joinOrigin: env.JOIN_ORIGIN || url.origin });
      }
      return json({ error: 'Could not create a room, try again' }, 503);
    }

    const ws = url.pathname.match(/^\/api\/rooms\/([A-Z]{4})\/ws$/);
    if (ws) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(ws[1])).fetch(req);
    }

    // Short join link: quiz.example.com/ABCD -> /play?c=ABCD
    const short = url.pathname.match(/^\/([A-Za-z]{4})\/?$/);
    if (short && short[1].toLowerCase() !== 'play') {
      return Response.redirect(`${url.origin}/play?c=${short[1].toUpperCase()}`, 302);
    }

    return env.ASSETS.fetch(req);
  }
};

/*
 * One Durable Object per room. The host screen drives the game (song number, phase, which
 * song is being reviewed); team phones submit guesses; the host awards points by hand.
 * State (all small) lives in one storage key.
 *
 * s = {
 *   code, hostToken, touched,
 *   teams:   { [teamId]: { id, name, token } },
 *   game:    { gameId, phase: lobby|play|revealed|intermission|review|done, answers: end|each,
 *              song, total, open, review, reviewShown },
 *   guesses: { gameId, bySong: { [song]: { [teamId]: { title, artist } } } },
 *   marks:   { [teamId]: { "<gameId>-<song>": { t, a } } }
 * }
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get('s')) || null; });
  }

  async create(code) {
    if (this.s && Date.now() - this.s.touched < ROOM_TTL) return null; // code in use
    // Reusing an expired code: sockets from the old session must not control (or see) the new room.
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.serializeAttachment({ role: 'dead' }); ws.send(JSON.stringify({ type: 'error', code: 'no_room', message: 'This game has ended.' })); ws.close(4004, 'expired'); } catch {}
    }
    this.alarmAt = 0;
    this.s = {
      code, hostToken: token(), touched: Date.now(),
      teams: {}, game: { phase: 'lobby' }, guesses: { gameId: null, bySong: {} }, marks: {}
    };
    await this.save();
    return { hostToken: this.s.hostToken };
  }

  async save() {
    const now = Date.now();
    this.s.touched = now;
    await this.ctx.storage.put('s', this.s);
    // Push the expiry forward at most every 10 minutes instead of on every guess.
    if (!this.alarmAt || now - (this.alarmAt - ROOM_TTL) > 10 * 60e3) {
      this.alarmAt = now + ROOM_TTL;
      await this.ctx.storage.setAlarm(this.alarmAt);
    }
  }

  async alarm() {
    // The alarm is only moved forward every few minutes; re-check real inactivity before deleting.
    if (this.s && Date.now() - this.s.touched < ROOM_TTL) {
      this.alarmAt = this.s.touched + ROOM_TTL;
      await this.ctx.storage.setAlarm(this.alarmAt);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.s = null;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: 'error', code: 'no_room', message: 'This game has ended.' })); ws.close(4004, 'expired'); } catch {}
    }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const fail = (code, message) => {
      server.serializeAttachment({ role: 'dead' });
      server.send(JSON.stringify({ type: 'error', code, message }));
      server.close(4000 + (code === 'no_room' ? 4 : 1), code);
    };
    const role = url.searchParams.get('role');

    if (!this.s) fail('no_room', 'No game with that code. Check the code on the TV.');
    else if (role === 'host') {
      if (url.searchParams.get('token') !== this.s.hostToken) fail('bad_token', 'Not the host of this room.');
      else { server.serializeAttachment({ role: 'host' }); this.sendHost(server); }
    } else if (role === 'team') {
      const id = url.searchParams.get('id'), t = this.s.teams[id];
      if (id && t && url.searchParams.get('token') === t.token) {
        server.serializeAttachment({ role: 'team', teamId: id });
        this.sendTeam(server, id);
        this.broadcastHost();                      // online status changed
      } else if (id) {
        fail('bad_team', 'Your team is no longer in this game. Join again.');
      } else {
        server.serializeAttachment({ role: 'team' }); // not joined yet: waits for a "join" message
        server.send(JSON.stringify({ type: 'hello', code: this.s.code }));
      }
    } else fail('bad_role', 'Bad request');

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (!this.s || typeof raw !== 'string') return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const at = ws.deserializeAttachment() || {};
    if (at.role === 'host') return this.onHost(msg);
    if (at.role === 'team') return this.onTeam(ws, at, msg);
  }

  async webSocketClose(ws, code, reason) {
    // Complete the close handshake; otherwise the client's socket hangs in CLOSING and never reconnects.
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch {}
    const at = ws.deserializeAttachment() || {};
    if (at.role === 'team' && at.teamId && this.s) this.broadcastHost(ws);
  }

  // ---------------- host ----------------
  async onHost(msg) {
    const s = this.s;
    if (msg.type === 'game') {
      const g = {
        gameId: msg.gameId ? clip(msg.gameId, 40) : null,
        phase: clip(msg.phase, 20) || 'lobby', answers: msg.answers === 'each' ? 'each' : 'end',
        song: +msg.song || 0, total: +msg.total || 0, open: !!msg.open,
        review: +msg.review || 0, reviewShown: !!msg.reviewShown
      };
      if (g.gameId !== s.guesses.gameId) s.guesses = { gameId: g.gameId, bySong: {} };
      s.game = g;
      await this.save();
      this.broadcastTeams();
      this.broadcastHost();
    } else if (msg.type === 'mark') {
      const t = s.teams[msg.teamId]; if (!t) return;
      const key = clip(msg.key, 60);
      (s.marks[t.id] ||= {})[key] = { t: !!msg.t, a: !!msg.a };
      await this.save();
      if (s.game.phase === 'done') this.broadcastTeams();
      else for (const ws of this.sockets('team', t.id)) this.sendTeam(ws, t.id);
      this.broadcastHost();
    } else if (msg.type === 'resetScores') {
      s.marks = {};
      await this.save();
      this.broadcastTeams();
      this.broadcastHost();
    } else if (msg.type === 'kick') {
      const t = s.teams[msg.teamId]; if (!t) return;
      delete s.teams[t.id]; delete s.marks[t.id];
      for (const g of Object.values(s.guesses.bySong)) delete g[t.id];
      await this.save();
      for (const ws of this.sockets('team', t.id)) {
        try { ws.send(JSON.stringify({ type: 'kicked' })); ws.close(4003, 'removed'); } catch {}
      }
      if (s.game.phase === 'done') this.broadcastTeams();   // final ranking changed
      this.broadcastHost();
    }
  }

  // ---------------- teams ----------------
  async onTeam(ws, at, msg) {
    const s = this.s;
    if (msg.type === 'join') {
      if (at.teamId) return;
      const name = clip(msg.name, 24);
      if (!name) return this.err(ws, 'bad_name', 'Enter a team name.');
      // Names are unique and never hand over an existing team to someone else. The only exception is
      // a retry from the same phone (same secret join key), e.g. when the "joined" reply was lost.
      const key = clip(msg.key, 64);
      const same = Object.values(s.teams).find(t => t.name.toLowerCase() === name.toLowerCase());
      let team;
      if (same) {
        if (!key || same.joinKey !== key)
          return this.err(ws, 'name_taken', 'That name is taken. Pick another one (or ask the host to remove your old team).');
        team = same;
      } else {
        if (Object.keys(s.teams).length >= MAX_TEAMS) return this.err(ws, 'full', 'This game is full.');
        team = { id: token(6), name, token: token(), joinKey: key || null };
        s.teams[team.id] = team;
        await this.save();
      }
      ws.serializeAttachment({ role: 'team', teamId: team.id });
      ws.send(JSON.stringify({ type: 'joined', teamId: team.id, token: team.token, name: team.name }));
      this.sendTeam(ws, team.id);
      this.broadcastHost();
    } else if (msg.type === 'guess') {
      const team = s.teams[at.teamId];
      if (!team) return this.err(ws, 'not_joined', 'Your team isn’t in this game anymore. Join again.');
      const g = s.game;
      if (!g.open || msg.gameId !== g.gameId || +msg.song !== g.song)
        return ws.send(JSON.stringify({ type: 'error', code: 'closed', message: 'Answers for this song are closed.', gameId: msg.gameId, song: +msg.song, seq: msg.seq }));
      ((s.guesses.bySong[g.song] ||= {}))[team.id] = { title: clip(msg.title, 120), artist: clip(msg.artist, 120) };
      await this.save();
      ws.send(JSON.stringify({ type: 'saved', song: g.song, seq: msg.seq }));
      this.broadcastHost();
    }
  }

  // ---------------- outgoing ----------------
  sockets(role, teamId) {
    return this.ctx.getWebSockets().filter(ws => {
      const at = ws.deserializeAttachment() || {};
      return at.role === role && (teamId === undefined || at.teamId === teamId);
    });
  }
  err(ws, code, message) { ws.send(JSON.stringify({ type: 'error', code, message })); }

  hostView(closing) {
    const s = this.s;
    const online = new Set(this.sockets('team').filter(ws => ws !== closing).map(ws => ws.deserializeAttachment().teamId));
    return {
      type: 'sync', code: s.code, game: s.game,
      teams: Object.values(s.teams).map(t => ({ id: t.id, name: t.name, online: online.has(t.id) })),
      guesses: s.guesses, marks: s.marks
    };
  }
  sendHost(ws, closing) { try { ws.send(JSON.stringify(this.hostView(closing))); } catch {} }
  broadcastHost(closing) { for (const ws of this.sockets('host')) this.sendHost(ws, closing); }

  teamView(teamId) {
    const s = this.s, g = s.game, team = s.teams[teamId];
    const marks = s.marks[teamId] || {};
    const key = n => `${g.gameId}-${n}`;
    const guessFor = n => s.guesses.bySong[n]?.[teamId] || null;
    // Which songs' results this team may see: during review, up to the song on screen; in
    // reveal-after-each mode, every song whose answer has been revealed; at the end, all.
    let upTo = 0;
    if (g.phase === 'review') upTo = g.review;
    else if (g.phase === 'done') upTo = g.total || g.song;
    else if (g.answers === 'each') upTo = g.phase === 'revealed' ? g.song : g.song - 1;
    const results = [];
    for (let n = 1; n <= upTo; n++) results.push({ song: n, guess: guessFor(n), t: !!marks[key(n)]?.t, a: !!marks[key(n)]?.a });
    const ranking = Object.values(s.teams)
      .map(t => ({ name: t.name, score: scoreOf(s.marks[t.id]), me: t.id === teamId }))
      .sort((a, b) => b.score - a.score);
    return {
      type: 'view', team: { id: team.id, name: team.name },
      game: { gameId: g.gameId, phase: g.phase, answers: g.answers, song: g.song, total: g.total, open: g.open, review: g.review },
      myGuess: guessFor(g.song), score: scoreOf(marks), results,
      ranking: g.phase === 'done' ? ranking : null
    };
  }
  sendTeam(ws, teamId) { try { if (this.s.teams[teamId]) ws.send(JSON.stringify(this.teamView(teamId))); } catch {} }
  broadcastTeams() {
    for (const ws of this.sockets('team')) {
      const id = ws.deserializeAttachment().teamId;
      if (id) this.sendTeam(ws, id);
    }
  }
}
