// core.js — 「チワワでワン撃」ゲームロジック純関数群
// 【最重要制約】UI/DOM/React非依存のプレーンJS。stateは不変更新（直接改変禁止）。
// Phase 2(Django Channels)移植のため、状態遷移は必ずこのAPI経由。
// API: newGame / legalActions / applyAction / scoreRow
//
// カード表現:
//   おしりカード: { t: "butt", v: 1..12 }
//   特殊カード:   { t: "special", s: "amaenbo" | "yancha" | "ohirune" }
// 場(row)は裏向きに置かれた butt カードの配列。

// ---- 決定論PRNG（mulberry32・seed再現可能） ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// seed から山札をシャッフル。rngの呼び出し回数を state に持たず、seed+drawn数で再現。
// ここでは deck を生成→Fisher-Yates（mulberry32）で決定論シャッフル。
function buildDeck() {
  const deck = [];
  for (let v = 1; v <= 12; v++) {
    deck.push({ t: "butt", v: v });
    deck.push({ t: "butt", v: v });
  }
  deck.push({ t: "special", s: "amaenbo" });
  deck.push({ t: "special", s: "yancha" });
  deck.push({ t: "special", s: "ohirune" });
  return deck;
}

function shuffle(deck, rng) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function clone(state) {
  // 構造的ディープコピー（純JSON構造のみ・関数なし）
  return JSON.parse(JSON.stringify(state));
}

// ---- newGame(seed, playerCount) → state ----
function newGame(seed, playerCount) {
  const pc = Math.max(2, Math.min(4, playerCount | 0));
  const rng = mulberry32((seed >>> 0) || 1);
  let deck = shuffle(buildDeck(), rng);
  const players = [];
  for (let p = 0; p < pc; p++) {
    const hand = deck.slice(0, 4);
    deck = deck.slice(4);
    players.push({ hand: hand, tokens: 2, score: 0 });
  }
  return {
    seed: seed >>> 0,
    playerCount: pc,
    deck: deck,
    discard: [],
    players: players,
    row: [], // butt cards, face-down
    current: 0,
    starter: 0,
    phase: "play", // "play" | "gameover"
    finished: false,
    winner: null, // index | "draw" | null
    lastReveal: null, // 直近公開の結果（UI表示用）
  };
}

// ---- 山札補充（切れたら捨て札をシャッフルして再構築） ----
function refill(state) {
  const s = state;
  const hand = s.players[s.current].hand;
  while (hand.length < 4) {
    if (s.deck.length === 0) {
      if (s.discard.length === 0) break; // 引くカードが尽きた
      // 捨て札を rng で再シャッフル（seed + 現在の捨て札枚数で決定論に近似）
      const rng = mulberry32(((s.seed >>> 0) + s.discard.length * 2654435761) >>> 0);
      s.deck = shuffle(s.discard, rng);
      s.discard = [];
    }
    hand.push(s.deck.shift());
  }
}

// ---- legalActions(state) → action[] ----
function legalActions(state) {
  if (state.finished) return [];
  const s = state;
  const me = s.players[s.current];
  const actions = [];
  // プレイ: 手札の butt カード各1枚
  me.hand.forEach(function (c, i) {
    if (c.t === "butt") actions.push({ type: "play", cardIndex: i });
  });
  // 公開: 常に選択可
  actions.push({ type: "reveal" });
  // 移動: トークン>0 かつ 場に裏向きカードあり
  if (me.tokens > 0 && s.row.length >= 1) {
    actions.push({ type: "move" });
  }
  return actions;
}

// ---- scoreRow(row, special?) → { n, base, penalty, total, wangeki } ----
// row: butt カード配列 または 数値配列。special: null | {type,number?}
function scoreRow(row, special) {
  special = special || null;
  const vals = row.map(function (c) {
    return typeof c === "number" ? c : c.v;
  });
  let expected = 1;
  let i = 0;
  const occ = {}; // 数字 -> 連番範囲内での連続出現枚数
  let amaeUsed = false;
  let yanchaUsed = false;
  let yanchaMissing = 0;

  function bump(v) {
    occ[v] = (occ[v] || 0) + 1;
  }

  while (i < vals.length) {
    const c = vals[i];
    if (c === expected) {
      bump(c);
      expected++;
      i++;
    } else if (c === expected - 1 && expected > 1) {
      // 直前に数えた数字の連続重複
      bump(c);
      i++;
    } else if (
      special &&
      special.type === "amaenbo" &&
      !amaeUsed &&
      special.number === expected
    ) {
      // 甘えん坊: 欠け数字を存在扱い（満額・iは進めない＝現カード再評価）
      bump(expected);
      amaeUsed = true;
      expected++;
    } else if (special && special.type === "yancha" && !yanchaUsed && c > expected) {
      // やんちゃ: 欠け数字を無視して接続（基礎点から欠け数字を減点）
      yanchaUsed = true;
      yanchaMissing = expected;
      expected++;
    } else {
      break;
    }
  }
  // 末端補完: 甘えん坊で連番末尾の次を埋める（例 1..11+甘えん坊12）
  if (special && special.type === "amaenbo" && !amaeUsed && special.number === expected) {
    bump(expected);
    amaeUsed = true;
    expected++;
  }

  let n = expected - 1;
  let base = (n * (n + 1)) / 2;
  if (yanchaUsed) base -= yanchaMissing;

  let penalty = 0;
  for (const k in occ) {
    if (occ[k] >= 2) penalty += Number(k) * occ[k];
  }
  if (special && special.type === "ohirune") penalty = 0; // お昼寝: 重複ペナ無効

  let total = base - penalty;
  let wangeki = false;
  if (n === 12) {
    if (!special) {
      wangeki = true; // 特殊不使用の12連番＝ワン撃（即勝利）
    } else {
      total = 66; // 特殊カードで n=12 到達は 66点固定（ワン撃不成立・仕様§特殊）
    }
  }
  return { n: n, base: base, penalty: penalty, total: total, wangeki: wangeki };
}

// ---- ワン！精算: 各宣言 value==n で+5 / 不一致で-5 ----
function settleWan(declarations, n) {
  const deltas = {}; // playerIndex -> ±5
  (declarations || []).forEach(function (d) {
    deltas[d.player] = (deltas[d.player] || 0) + (d.value === n ? 5 : -5);
  });
  return deltas;
}

// ---- applyAction(state, action) → { state, events } ----
// action:
//   {type:"play", cardIndex}
//   {type:"move", from, to}                       // トークン1消費
//   {type:"reveal", declarations?, special?}       // declarations=[{player,value}], special={type,number?}
function applyAction(state, action) {
  if (state.finished) {
    return { state: state, events: [{ type: "error", message: "game over" }] };
  }
  const legal = legalActions(state);
  const okType = legal.some(function (a) {
    return a.type === action.type;
  });
  if (!okType) {
    return { state: state, events: [{ type: "error", message: "illegal action: " + action.type }] };
  }

  const s = clone(state);
  const events = [];
  const cur = s.current;

  if (action.type === "play") {
    const me = s.players[cur];
    const card = me.hand[action.cardIndex];
    if (!card || card.t !== "butt") {
      return { state: state, events: [{ type: "error", message: "cannot play this card" }] };
    }
    me.hand.splice(action.cardIndex, 1);
    s.row.push({ t: "butt", v: card.v });
    events.push({ type: "played", player: cur, value: card.v });

    if (s.row.length >= 12) {
      // 12枚目を置いた→即時強制公開（このプレイヤーが公開者）
      events.push({ type: "forcedReveal", player: cur });
      return doReveal(s, cur, action.declarations || [], action.special || null, events, true);
    }
    refill(s);
    events.push({ type: "refilled", player: cur, handSize: me.hand.length });
    advance(s);
    return { state: s, events: events };
  }

  if (action.type === "move") {
    const me = s.players[cur];
    const from = action.from | 0;
    const to = action.to | 0;
    if (me.tokens <= 0) {
      return { state: state, events: [{ type: "error", message: "no move token" }] };
    }
    if (from < 0 || from >= s.row.length || to < 0 || to >= s.row.length) {
      return { state: state, events: [{ type: "error", message: "move index out of range" }] };
    }
    const card = s.row.splice(from, 1)[0];
    s.row.splice(to, 0, card);
    me.tokens -= 1;
    events.push({ type: "moved", player: cur, from: from, to: to, tokensLeft: me.tokens });
    refill(s);
    advance(s);
    return { state: s, events: events };
  }

  if (action.type === "reveal") {
    return doReveal(s, cur, action.declarations || [], action.special || null, events, false);
  }

  return { state: state, events: [{ type: "error", message: "unknown action" }] };
}

// ---- 公開シーケンス実行（宣言→フリップ→特殊→得点→捨て札） ----
function doReveal(s, revealer, declarations, special, events, forced) {
  const rowVals = s.row.map(function (c) {
    return c.v;
  });
  const res = scoreRow(s.row, special);
  events.push({ type: "revealed", revealer: revealer, row: rowVals, forced: forced });

  // 特殊カードは公開者の手札から消費（使用時）
  if (special && special.type) {
    const rp = s.players[revealer];
    const idx = rp.hand.findIndex(function (c) {
      return c.t === "special" && c.s === special.type;
    });
    if (idx >= 0) {
      const used = rp.hand.splice(idx, 1)[0];
      s.discard.push(used);
      events.push({ type: "specialUsed", player: revealer, special: special.type });
    } else {
      events.push({ type: "warning", message: "revealer lacks special " + special.type + " (applied anyway per params)" });
    }
  }

  // 得点: 公開者に total、ワン！精算は各宣言者に ±5
  s.players[revealer].score += res.total;
  events.push({ type: "score", player: revealer, delta: res.total, detail: res });

  // 宣言の player は 0..playerCount-1 の整数のみ有効（Phase2でネット越し入力を受ける想定の防御）
  const validDecls = (declarations || []).filter(function (d) {
    return d && Number.isInteger(d.player) && d.player >= 0 && d.player < s.players.length &&
      Number.isInteger(d.value) && d.value >= 1 && d.value <= 12;
  });
  const wanDeltas = settleWan(validDecls, res.n);
  for (const pi in wanDeltas) {
    s.players[Number(pi)].score += wanDeltas[pi];
    events.push({ type: "wan", player: Number(pi), delta: wanDeltas[pi], declaredMatch: wanDeltas[pi] > 0 });
  }

  // 場を捨て札へ
  for (let k = 0; k < s.row.length; k++) s.discard.push(s.row[k]);
  s.row = [];
  s.lastReveal = { revealer: revealer, result: res, declarations: declarations || [] };

  // 公開者が次のスタート＆手番
  s.starter = revealer;
  s.current = revealer;
  refill(s);

  // 勝敗判定
  if (res.wangeki) {
    s.finished = true;
    s.winner = revealer;
    events.push({ type: "gameover", winner: revealer, reason: "wangeki" });
    return { state: s, events: events };
  }
  const winIdx = checkVictory(s);
  if (winIdx !== null) {
    s.finished = true;
    s.winner = winIdx;
    events.push({ type: "gameover", winner: winIdx, reason: "150pts" });
  }
  return { state: s, events: events };
}

// 150点以上で最高得点者勝利（同点は draw）
function checkVictory(s) {
  let max = -Infinity;
  s.players.forEach(function (p) {
    if (p.score > max) max = p.score;
  });
  if (max < 150) return null;
  const leaders = [];
  s.players.forEach(function (p, i) {
    if (p.score === max) leaders.push(i);
  });
  if (leaders.length === 1) return leaders[0];
  return "draw";
}

function advance(s) {
  s.current = (s.current + 1) % s.playerCount;
}

// ---- export（ブラウザ/node両対応） ----
const GameCore = {
  mulberry32: mulberry32,
  buildDeck: buildDeck,
  newGame: newGame,
  legalActions: legalActions,
  applyAction: applyAction,
  scoreRow: scoreRow,
  settleWan: settleWan,
  checkVictory: checkVictory,
};

if (typeof module !== "undefined") module.exports = GameCore;
if (typeof window !== "undefined") window.GameCore = GameCore;
