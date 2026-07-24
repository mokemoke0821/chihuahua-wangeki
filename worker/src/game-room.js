// game-room.js — GameRoom Durable Object。1コード=1DO。ゲームstateを保持し core.js を
// 権威ロジックに流用。Hibernation API（acceptWebSocket + webSocketMessage/Close）で
// 待機課金回避、締切は DO Alarms（setTimeoutはハイバネーションで消えるため不可）。
// state は各遷移後に storage(SQLite) へ保存し、DO起床時に復元。
// 各クライアントへは view_for(state, i) のみ送信（値の隠蔽をサーバーで構造保証）。
import GameCore from "../../core.js";

const WAN_SEC = 15;
const SPECIAL_SEC = 15;
const GRACE_SEC = 60;

function tok() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, "").slice(0, 14);
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
  }

  async load() {
    if (this.room) return this.room;
    this.room =
      (await this.ctx.storage.get("room")) || {
        code: null, players: [], hostToken: null, gameState: null,
        phase: "lobby", wan: null, special: null, matchResult: null, alarms: [],
      };
    return this.room;
  }
  async save() { await this.ctx.storage.put("room", this.room); }

  // ---- WebSocket 受付（Hibernation） ----
  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    const mm = url.pathname.match(/room\/([A-Za-z0-9]{5})/);
    if (mm && !this.room.code) { this.room.code = mm[1].toUpperCase(); }
    const token = url.searchParams.get("token");
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    if (token) { await this.attach(server, token); await this.save(); }
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* closed */ } }
  broadcast(obj) { for (const ws of this.ctx.getWebSockets()) this.send(ws, obj); }
  att(ws) { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } }
  setAtt(ws, seat, token) { ws.serializeAttachment({ seat, token }); }
  sockOf(seat) { return this.ctx.getWebSockets().find((w) => this.att(w).seat === seat); }
  bySeat(seat) { return this.room.players.find((p) => p.seat === seat); }
  byToken(t) { return this.room.players.find((p) => p.token === t); }
  connectedSeats() { return this.room.players.filter((p) => p.connected).map((p) => p.seat); }
  isHost(t) { return t === this.room.hostToken; }

  lobbyView() {
    const host = this.byToken(this.room.hostToken);
    return {
      type: "room_state", code: this.room.code, phase: this.room.phase,
      players: this.room.players.map((p) => ({
        seat: p.seat, name: p.name, connected: p.connected, isHost: p.token === this.room.hostToken,
      })),
      hostSeat: host ? host.seat : null,
    };
  }

  async attach(ws, token) {
    const p = this.byToken(token);
    if (!p) { this.send(ws, { type: "error", code: "bad_token", message: "invalid token" }); return false; }
    const reconn = !p.connected;
    p.connected = true; p.disconnectAt = null;
    this.setAtt(ws, p.seat, token);
    if (reconn) this.broadcast({ type: "player_reconnected", seat: p.seat });
    this.send(ws, this.lobbyView());
    // 進行中の復帰: フェーズ別に正しい view と進行中フェーズ通知を再送（宣言/特殊UIを復元）。
    if (this.room.phase === "wan" && this.room.wan) {
      this.send(ws, { type: "view", phase: "wan", view: GameCore.viewFor(this.room.wan.viewState, p.seat) });
      this.send(ws, { type: "wan_phase", revealer: this.room.wan.revealer, deadline: this.room.wan.deadline, seconds: WAN_SEC });
    } else if (this.room.phase === "special" && this.room.special) {
      this.send(ws, { type: "view", phase: "special", view: GameCore.viewFor(this.room.special.viewState, p.seat) });
      const payload = { type: "special_phase", revealer: this.room.special.revealer, deadline: this.room.special.deadline, seconds: SPECIAL_SEC };
      if (p.seat === this.room.special.revealer) {
        payload.rowCards = this.room.special.viewState.row.map((c) => ({ v: c.v, placedBy: c.placedBy, id: c.id }));
        payload.heldSpecials = this.room.gameState.players[p.seat].hand.filter((c) => c.t === "special").map((c) => c.s);
      }
      this.send(ws, payload);
    } else if (["play", "over"].includes(this.room.phase) && this.room.gameState) {
      this.send(ws, { type: "view", phase: this.room.phase, view: GameCore.viewFor(this.room.gameState, p.seat) });
    }
    return true;
  }

  async webSocketMessage(ws, message) {
    await this.load();
    let m;
    try { m = JSON.parse(message); } catch (e) { return; }
    try {
      const t = m.type;
      if (t === "create_room") await this.create(ws, m);
      else if (t === "join") await this.join(ws, m);
      else if (t === "start") await this.start(ws);
      else if (t === "action") await this.action(ws, m.action || {});
      else if (t === "wan_declare") await this.wanDeclare(ws, m.value);
      else if (t === "special") await this.special(ws, m.card, m.number);
      else if (t === "rematch") await this.rematch(ws);
      else this.send(ws, { type: "error", code: "bad_type", message: "unknown type" });
    } catch (e) {
      this.send(ws, { type: "error", code: "server_error", message: String(e && e.message || e) });
    }
    await this.save();
  }

  async webSocketClose(ws) {
    await this.load();
    const a = this.att(ws);
    if (a.seat === undefined) return;
    const p = this.bySeat(a.seat);
    if (p && p.token === a.token) {
      p.connected = false; p.disconnectAt = Date.now();
      this.broadcast({ type: "player_disconnected", seat: p.seat, graceSec: GRACE_SEC });
      this.schedule(Date.now() + GRACE_SEC * 1000, { kind: "grace", seat: p.seat, token: p.token });
    }
    if (this.room.phase === "lobby") this.broadcast(this.lobbyView());
    await this.save();
  }

  // ---- ロビー ----
  async create(ws, m) {
    if (this.room.players.length > 0) { this.send(ws, { type: "error", code: "code_taken", message: "room code already in use" }); return; }
    const token = tok();
    this.room.players.push({ seat: 0, name: m.name || "P1", token, connected: true, disconnectAt: null });
    this.room.hostToken = token;
    this.setAtt(ws, 0, token);
    this.send(ws, { type: "created", code: this.room.code, seat: 0, token });
    this.broadcast(this.lobbyView());
  }
  async join(ws, m) {
    if (this.room.phase !== "lobby") { this.send(ws, { type: "error", code: "already_started", message: "started" }); return; }
    if (this.room.players.length >= 4) { this.send(ws, { type: "error", code: "room_full", message: "full" }); return; }
    const seat = this.room.players.length;
    const token = tok();
    this.room.players.push({ seat, name: m.name || ("P" + (seat + 1)), token, connected: true, disconnectAt: null });
    this.setAtt(ws, seat, token);
    this.send(ws, { type: "joined", code: this.room.code, seat, token });
    this.broadcast(this.lobbyView());
  }
  async start(ws) {
    const a = this.att(ws);
    if (!this.isHost(a.token)) { this.send(ws, { type: "error", code: "not_host", message: "host only" }); return; }
    if (this.room.players.length < 2) { this.send(ws, { type: "error", code: "need_2_players", message: "need 2" }); return; }
    const seed = ((Date.now() & 0xffffffff) ^ this.hashCode(this.room.code)) >>> 0 || 1;
    this.room.gameState = GameCore.newGame(seed, this.room.players.length);
    this.room.phase = "play";
    this.broadcast({ type: "started" });
    this.pushViews();
  }
  hashCode(s) { let h = 0; for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

  // ---- アクション（権威検証） ----
  async action(ws, action) {
    const a = this.att(ws);
    if (this.room.phase !== "play") { this.send(ws, { type: "error", code: "bad_phase", message: "not play" }); return; }
    if (a.seat === undefined || this.bySeat(a.seat) === undefined || this.bySeat(a.seat).token !== a.token) {
      this.send(ws, { type: "error", code: "not_participant", message: "not participant" }); return;
    }
    if (this.room.gameState.current !== a.seat) { this.send(ws, { type: "error", code: "not_your_turn", message: "not your turn" }); return; }
    const at = action.type;
    if (at === "play" || at === "move") {
      if (at === "play" && this.is12th(action)) { this.beginReveal(action, true); return; }
      const res = GameCore.applyAction(this.room.gameState, action);
      if (res.events.some((e) => e.type === "error")) { this.send(ws, { type: "error", code: "illegal", message: res.events[0].message }); return; }
      this.room.gameState = res.state;
      this.pushViews();
    } else if (at === "reveal") {
      this.beginReveal({ type: "reveal" }, false);
    } else {
      this.send(ws, { type: "error", code: "bad_action", message: "unknown action" });
    }
  }
  is12th(action) {
    const s = this.room.gameState;
    const ci = action.cardIndex;
    const hand = s.players[s.current].hand;
    return s.row.length === 11 && Number.isInteger(ci) && ci >= 0 && ci < hand.length && hand[ci].t === "butt";
  }

  // ---- 公開シーケンス（ワン!同時宣言 → 特殊 → 採点） ----
  beginReveal(action, forced) {
    const s = this.room.gameState;
    const revealer = s.current;
    let viewState = s;
    if (forced) {
      viewState = GameCore.viewFor ? JSON.parse(JSON.stringify(s)) : s;
      const pc = s.players[revealer].hand[action.cardIndex];
      viewState.row.push({ t: "butt", v: pc.v, placedBy: revealer, id: viewState.cardSeq, faceDown: true });
      viewState.cardSeq += 1;
    }
    const deadline = Date.now() + WAN_SEC * 1000;
    this.room.phase = "wan";
    this.room.wan = { deadline, action, revealer, declarations: {}, responded: [], viewState, forced };
    this.broadcast({ type: "wan_phase", revealer, deadline, seconds: WAN_SEC });
    this.pushViews(viewState);
    this.schedule(deadline, { kind: "wan" });
  }
  async wanDeclare(ws, value) {
    const a = this.att(ws);
    if (this.room.phase !== "wan" || !this.room.wan) { this.send(ws, { type: "error", code: "bad_phase", message: "not wan" }); return; }
    if (a.seat === undefined || this.bySeat(a.seat) === undefined || this.bySeat(a.seat).token !== a.token) {
      this.send(ws, { type: "error", code: "not_participant", message: "not participant" }); return;
    }
    if (this.room.wan.responded.includes(a.seat)) return;
    this.room.wan.responded.push(a.seat);
    if (Number.isInteger(value) && value >= 1 && value <= 12) this.room.wan.declarations[a.seat] = value;
    this.broadcast({ type: "wan_progress", responded: [...this.room.wan.responded].sort((x, y) => x - y), total: this.connectedSeats().length });
    if (this.connectedSeats().every((seat) => this.room.wan.responded.includes(seat))) this.toSpecial();
  }
  toSpecial() {
    const w = this.room.wan;
    if (!w) return;
    const declarations = Object.entries(w.declarations).map(([seat, v]) => ({ player: Number(seat), value: v }));
    const revealer = w.revealer;
    const rp = this.room.gameState.players[revealer];
    const hasSpecial = rp.hand.some((c) => c.t === "special");
    this.room.wan = null;
    if (!hasSpecial) { this.resolveReveal(w.action, declarations, null); return; }
    const deadline = Date.now() + SPECIAL_SEC * 1000;
    this.room.phase = "special";
    this.room.special = { deadline, revealer, action: w.action, declarations, viewState: w.viewState };
    // 【payload隠蔽】採点対象の場(値付きrowCards)＋保有特殊は公開者ソケットにのみ送信。
    // 他者は値なし待機通知。heldSpecialsで公開者UIは保有分だけボタンを出す（不正選択防止）。
    const flip = w.viewState.row.map((c) => ({ v: c.v, placedBy: c.placedBy, id: c.id }));
    const held = rp.hand.filter((c) => c.t === "special").map((c) => c.s);
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.att(ws).seat;
      const payload = { type: "special_phase", revealer, deadline, seconds: SPECIAL_SEC };
      if (seat === revealer) { payload.rowCards = flip; payload.heldSpecials = held; }
      this.send(ws, payload);
    }
    this.schedule(deadline, { kind: "special" });
  }
  async special(ws, card, number) {
    const a = this.att(ws);
    if (this.room.phase !== "special" || !this.room.special) { this.send(ws, { type: "error", code: "bad_phase", message: "not special" }); return; }
    if (a.seat !== this.room.special.revealer) { this.send(ws, { type: "error", code: "not_revealer", message: "revealer only" }); return; }
    const sp = this.room.special;
    this.room.special = null;
    // 権威: 実際に保有する特殊カードのみ適用可（core.jsは保有検証しない設計＝ここで照合）。
    // 未保有カードが送られたら効果を適用しない（不正なスコア改ざん・無消費使用を防止）。
    const held = this.room.gameState.players[a.seat].hand
      .filter((c) => c.t === "special").map((c) => c.s);
    let special = null;
    if (["amaenbo", "yancha", "ohirune"].includes(card) && held.includes(card)) {
      special = { type: card };
      if (card === "amaenbo" && Number.isInteger(number)) special.number = number;
    }
    this.resolveReveal(sp.action, sp.declarations, special);
  }
  resolveReveal(action, declarations, special) {
    const act = { ...action, declarations, special };
    const res = GameCore.applyAction(this.room.gameState, act);
    if (res.events.some((e) => e.type === "error")) {
      this.room.phase = "play";
      this.broadcast({ type: "error", code: "illegal", message: res.events[0].message });
      this.pushViews();
      return;
    }
    this.room.gameState = res.state;
    const revealed = res.events.find((e) => e.type === "revealed");
    const scoreEv = res.events.find((e) => e.type === "score");
    const wans = res.events.filter((e) => e.type === "wan");
    this.room.phase = this.room.gameState.finished ? "over" : "play";
    // reveal_result は公開後=公開情報なので全員へ（値付き）
    this.broadcast({
      type: "reveal_result",
      revealer: revealed ? revealed.revealer : null,
      rowCards: revealed ? revealed.rowCards : [],
      forced: revealed ? revealed.forced : false,
      result: scoreEv ? scoreEv.detail : null,
      wans: wans.map((w) => ({ seat: w.player, delta: w.delta })),
    });
    this.pushViews();
    if (this.room.gameState.finished) this.saveMatch();
  }

  async rematch(ws) {
    const a = this.att(ws);
    if (!this.isHost(a.token)) { this.send(ws, { type: "error", code: "not_host", message: "host only" }); return; }
    if (this.room.phase !== "over") { this.send(ws, { type: "error", code: "bad_phase", message: "not over" }); return; }
    this.room.phase = "lobby"; this.room.gameState = null; this.room.wan = null; this.room.special = null;
    this.broadcast(this.lobbyView());
  }

  saveMatch() {
    const st = this.room.gameState;
    const winner = st.winner;
    let reason = "150pts";
    const rev = st.lastReveal || {};
    if (Number.isInteger(winner) && (rev.result || {}).wangeki) reason = "wangeki";
    else if (winner === "draw") reason = "draw";
    // 対戦結果は部屋DO storageへ簡易保存（グローバルDB/D1は今回スコープ外）
    this.room.matchResult = {
      endedAt: Date.now(), reason,
      winnerName: Number.isInteger(winner) ? this.room.players[winner].name : (winner === "draw" ? "引き分け" : ""),
      players: this.room.players.map((p, i) => ({ seat: i, name: p.name, score: st.players[i].score, isWinner: Number.isInteger(winner) && i === winner })),
    };
  }

  // ---- view 配信（各自 view_for のみ） ----
  pushViews(state) {
    const st = state || this.room.gameState;
    if (!st) return;
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.att(ws).seat;
      if (seat === undefined) continue;
      this.send(ws, { type: "view", phase: this.room.phase, view: GameCore.viewFor(st, seat) });
    }
  }

  // ---- Alarm キュー（複数締切を最早でスケジュール） ----
  schedule(at, entry) {
    this.room.alarms = (this.room.alarms || []).filter((x) => x.kind !== entry.kind || entry.kind === "grace");
    this.room.alarms.push({ at, ...entry });
    this.armAlarm();
  }
  async armAlarm() {
    const next = (this.room.alarms || []).reduce((m, x) => Math.min(m, x.at), Infinity);
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }
  async alarm() {
    await this.load();
    const now = Date.now();
    const due = (this.room.alarms || []).filter((x) => x.at <= now);
    this.room.alarms = (this.room.alarms || []).filter((x) => x.at > now);
    for (const d of due) {
      if (d.kind === "wan" && this.room.phase === "wan" && this.room.wan && this.room.wan.deadline <= now) {
        this.toSpecial();
      } else if (d.kind === "special" && this.room.phase === "special" && this.room.special && this.room.special.deadline <= now) {
        const sp = this.room.special; this.room.special = null;
        this.resolveReveal(sp.action, sp.declarations, null);
      } else if (d.kind === "grace") {
        const p = this.bySeat(d.seat);
        if (p && p.token === d.token && !p.connected) {
          if (this.room.phase === "lobby") { /* ロビー放置は残す */ }
          else if (["play", "wan", "special"].includes(this.room.phase) && this.connectedSeats().length < 2) {
            this.room.phase = "over";
            this.broadcast({ type: "gameover", reason: "abandoned" });
          }
        }
      }
    }
    await this.armAlarm();
    await this.save();
  }
}
