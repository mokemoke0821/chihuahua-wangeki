// ai-strong.js — 不完全情報ゲーム向けの探索型CPU（hard / 鬼）。
// 【設計】決定化モンテカルロ(PIMC): view のみから隠れ情報を復元した「決定化世界」を K個サンプルし、
// 各候補アクションを深さDまで前進(自分以外は軽量rollout方策)して評価関数で採点、重み付き平均で最良手を選ぶ。
//   - 情報リーク厳禁: 真の state は一切参照しない。決定化は view から復元した情報集合のみ。
//   - 宣言/特殊は v0.6.0(ai.js)の EV基準ロジックへ委譲（既に的中65%前後で鬼の要件を満たす）。
//   - 決定論: PRNG seed は view から導出(hashView)。予算は「決定化数」で決めるため同一seed・同一budgetで同一手。
//   - ブラウザ: chooseActionAsync が決定化ごとに yield し UI をブロックしない。
// ブラウザ/node 両対応。ai.js / core.js に依存。
(function () {
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function getCore() {
    if (typeof window !== "undefined" && window.GameCore) return window.GameCore;
    if (typeof require !== "undefined") return require("./core.js");
    throw new Error("GameCore not found");
  }
  function getAI() {
    if (typeof window !== "undefined" && window.GameAI) return window.GameAI;
    if (typeof require !== "undefined") return require("./ai.js");
    throw new Error("GameAI not found");
  }

  // 難易度別の探索パラメータ。K=決定化数, D=rollout深さ, budgetMs=実機の時間上限(決定論は K で担保)。
  const PARAMS = {
    hard: { K: 12, D: 2, budgetMs: 300, weighted: false },
    oni: { K: 40, D: 2, budgetMs: 1000, weighted: true },
  };

  function hashView(view, aiIndex, salt) {
    let h = 2166136261 >>> 0;
    function mix(x) { h ^= x >>> 0; h = Math.imul(h, 16777619) >>> 0; }
    mix(aiIndex + 1); mix((salt || 0) + 7); mix(view.current + 3);
    view.row.forEach(function (c) { mix(c.id + 1); mix(c.placedBy + 1); mix((c.v != null ? c.v : 13) + 1); });
    view.players.forEach(function (p) { mix(p.score + 200); mix(p.handCount + 1); mix(p.tokens + 1); });
    mix(view.deckCount + 1); mix(view.discardCount + 1);
    return h >>> 0 || 1;
  }
  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---- 決定化: view と aiIndex のみから完全 state を1つ復元（隠れ値は unseen からランダム割当）----
  // weighted=true(鬼) のとき、他者の伏せ場札に「連番延長バイアス」を掛けて割り当てる。
  function determinize(view, aiIndex, rng, weighted) {
    const full = [];
    for (let v = 1; v <= 12; v++) { full.push({ t: "butt", v: v }); full.push({ t: "butt", v: v }); }
    full.push({ t: "special", s: "amaenbo" }); full.push({ t: "special", s: "yancha" }); full.push({ t: "special", s: "ohirune" });
    const me = view.players[aiIndex];
    const known = [];
    (me.hand || []).forEach(function (c) { known.push(c); });
    view.row.forEach(function (c) { if (c.placedBy === aiIndex && c.v != null) known.push({ t: "butt", v: c.v }); });
    (view.discard || []).forEach(function (c) { known.push(c); });
    function keyOf(c) { return c.t === "butt" ? "b" + c.v : "s" + c.s; }
    const cnt = {};
    full.forEach(function (c) { cnt[keyOf(c)] = (cnt[keyOf(c)] || 0) + 1; });
    known.forEach(function (c) { cnt[keyOf(c)] = (cnt[keyOf(c)] || 0) - 1; });
    const unseenButt = [], unseenSpecial = [];
    for (let v = 1; v <= 12; v++) { const n = cnt["b" + v] || 0; for (let k = 0; k < n; k++) unseenButt.push(v); }
    ["amaenbo", "yancha", "ohirune"].forEach(function (s) { const n = cnt["s" + s] || 0; for (let k = 0; k < n; k++) unseenSpecial.push(s); });

    // 他者の伏せ場札位置
    const hiddenRow = [];
    view.row.forEach(function (c, i) { if (!(c.placedBy === aiIndex && c.v != null)) hiddenRow.push(i); });

    let buttPool = shuffle(unseenButt, rng);
    const rowVals = new Array(view.row.length);
    view.row.forEach(function (c, i) { if (c.placedBy === aiIndex && c.v != null) rowVals[i] = c.v; });

    if (weighted && hiddenRow.length) {
      // 連番延長バイアス: 場を左→右に見て、既知/割当済みの連番が n まで来ている位置の伏せ札は
      // n+1 である確率を上げる（プレイヤーは自分の連番を伸ばしたい）。貪欲に割り当てる。
      // 期待値: expected(=次に欲しい数) が buttPool にあれば高確率で選ぶ。
      const bias = 3.0; // n+1 を選ぶ相対重み
      let expected = 1;
      // まず現時点の連番先頭(1)を探す: 左から最初の既知1 or 伏せ位置
      for (let i = 0; i < view.row.length; i++) {
        if (rowVals[i] != null) {
          if (rowVals[i] === expected) expected++;
          else if (rowVals[i] === expected - 1) { /* dup */ }
          // 連番外の既知は無視して継続（起点自由のため厳密でないが近似）
          continue;
        }
        // 伏せ位置: expected を優先的に割当
        let pick = -1;
        // 重み付き抽選
        let totW = 0; const ws = [];
        for (let j = 0; j < buttPool.length; j++) { const w = buttPool[j] === expected ? bias : 1; ws.push(w); totW += w; }
        let r = rng() * totW;
        for (let j = 0; j < buttPool.length; j++) { r -= ws[j]; if (r <= 0) { pick = j; break; } }
        if (pick < 0) pick = buttPool.length - 1;
        rowVals[i] = buttPool[pick];
        buttPool.splice(pick, 1);
        if (rowVals[i] === expected) expected++;
      }
    } else {
      // 一様割当
      let bi = 0;
      for (let k = 0; k < hiddenRow.length; k++) { rowVals[hiddenRow[k]] = buttPool[bi++]; }
      buttPool = buttPool.slice(bi);
    }

    const row = view.row.map(function (c, i) {
      return { t: "butt", v: rowVals[i], placedBy: c.placedBy, id: c.id, faceDown: true };
    });
    const restCards = [];
    buttPool.forEach(function (v) { restCards.push({ t: "butt", v: v }); });
    unseenSpecial.forEach(function (s) { restCards.push({ t: "special", s: s }); });
    const rest = shuffle(restCards, rng);
    let ri = 0;
    const players = view.players.map(function (p, i) {
      if (i === aiIndex) return { hand: (me.hand || []).map(function (c) { return Object.assign({}, c); }), tokens: p.tokens, score: p.score };
      const hand = []; for (let k = 0; k < p.handCount; k++) hand.push(rest[ri++]);
      return { hand: hand, tokens: p.tokens, score: p.score };
    });
    const deck = []; for (let k = 0; k < view.deckCount; k++) deck.push(rest[ri++]);
    let maxId = 0; view.row.forEach(function (c) { if (c.id >= maxId) maxId = c.id + 1; });
    return {
      seed: 1, playerCount: view.playerCount, deck: deck,
      discard: (view.discard || []).map(function (c) { return Object.assign({}, c); }),
      players: players, row: row, cardSeq: maxId, current: view.current, starter: view.starter,
      phase: "play", finished: !!view.finished, winner: view.winner != null ? view.winner : null,
      lastReveal: view.lastReveal || null, history: (view.history || []).slice(),
    };
  }

  // ---- 軽量 rollout 方策 ----
  // 【重要】rollout は「決定化した架空世界」の中なので、そこでは完全情報を使ってよい（真のstateではない=リーク非該当）。
  // viewFor/estimate/MC を使わず、架空worldの row 値で直接・安価に判断（性能のため）。
  function fastAction(state, seat, rng) {
    const GC = getCore();
    const me = state.players[seat];
    const hand = (me && me.hand) ? me.hand : [];
    const row = state.row;
    const rowLen = row.length;
    const rowVals = row.map(function (c) { return c.v; });
    const res = GC.scoreRow(rowVals); // 架空世界では完全情報
    const hasReveal = true; // reveal は常に legal（core.js）
    // 公開: 現在の見込み点が閾値以上、または場が満杯手前で確保
    if (rowLen >= 3 && (res.total >= 4 || rowLen >= 11)) return { type: "reveal" };
    // プレイ: 連番の続き(res.n+1)を優先、場が空なら1優先、他は小さい順
    let bestIdx = -1, bs = 1e9;
    for (let i = 0; i < hand.length; i++) {
      if (hand[i].t !== "butt") continue;
      const v = hand[i].v;
      const sc = rowLen === 0 ? Math.abs(v - 1) : (v === res.n + 1 ? -100 : v);
      if (sc < bs) { bs = sc; bestIdx = i; }
    }
    if (bestIdx >= 0) return { type: "play", cardIndex: bestIdx };
    if (me.tokens > 0 && rowLen >= 2) return { type: "move", from: rowLen - 1, to: 0 };
    return { type: "reveal" };
  }

  // world 内でアクションを完全適用（reveal は特殊のみ安価に選び applyAction）。
  // 【高速化】rollout 中の宣言は省略(declarations=[])。ワン!の±5は行動評価に対し二次的で、
  // MC宣言をrolloutで回すと予算内に収まらないため。特殊(chooseSpecial)は安価・決定的なので使う。
  function applyFull(state, action, seat, rng) {
    const GC = getCore(), AI = getAI();
    const willReveal = action.type === "reveal";
    const will12 = action.type === "play" && state.row.length === 11 &&
      state.players[seat].hand[action.cardIndex] && state.players[seat].hand[action.cardIndex].t === "butt";
    if (willReveal || will12) {
      let rs = state;
      if (will12) {
        rs = JSON.parse(JSON.stringify(state));
        const pc = state.players[seat].hand[action.cardIndex];
        rs.row.push({ t: "butt", v: pc.v, placedBy: seat, id: rs.cardSeq++, faceDown: true });
      }
      const rowVals = rs.row.map(function (c) { return c.v; });
      const sp = AI.chooseSpecial(rowVals, rs.players[seat].hand, "normal");
      return GC.applyAction(state, Object.assign({}, action, { declarations: [], special: sp })).state;
    }
    return GC.applyAction(state, action).state;
  }

  function rollout(state, depth, rng) {
    const GC = getCore();
    let s = state;
    for (let d = 0; d < depth && !s.finished; d++) {
      const seat = s.current;
      const a = fastAction(s, seat, rng);
      s = applyFull(s, a, seat, rng);
    }
    return s;
  }

  // ---- 評価関数（mySeat 視点）----
  // スコア差を主軸に、場の潜在(自分が今公開して得られる純益)と相手の脅威を加味。
  // 「公開すると手番が自分に戻る」ことによる過大評価を避けるため、潜在は "自分の潜在 − 相手の潜在" の
  // 純益で評価し、手番独占そのものは加点しない。
  function evaluate(state, mySeat) {
    const P = state.players;
    const my = P[mySeat].score;
    let maxOpp = -Infinity;
    for (let i = 0; i < P.length; i++) if (i !== mySeat && P[i].score > maxOpp) maxOpp = P[i].score;
    if (maxOpp === -Infinity) maxOpp = 0;
    if (state.finished) {
      const base = (my - maxOpp);
      if (state.winner === mySeat) return base + 1000;
      if (state.winner === "draw") return base;
      return base - 800;
    }
    // スコア差を主軸にしつつ、自分のスコア進捗を非対称に重視（150点への closeout を促し、
    // リード温存で試合が止まる=stall を防ぐ）。my を maxOpp より重く。
    let v = 3.4 * my - 2.6 * maxOpp;
    // 場の潜在: 現手番が自分なら「今公開で得られる純益」を加点、相手番なら相手に取られる分を減点。
    const rowVals = state.row.map(function (c) { return c.v; });
    const rowBest = bestRevealScore(rowVals, P[state.current] ? P[state.current].hand : []);
    if (state.current === mySeat) v += 0.8 * rowBest;
    else v -= 0.5 * rowBest;
    // 手札の質: 低い連番札を持つほど将来公開を作りやすい
    let low = 0;
    (P[mySeat].hand || []).forEach(function (c) { if (c.t === "butt" && c.v <= 6) low += (7 - c.v) * 0.1; });
    v += low;
    v += (P[mySeat].tokens || 0) * 0.3; // 移動トークンの余地
    return v;
  }
  function bestRevealScore(rowVals, hand) {
    const GC = getCore();
    let best = GC.scoreRow(rowVals).total;
    const has = function (n) { return (hand || []).some(function (c) { return c.t === "special" && c.s === n; }); };
    if (has("ohirune")) best = Math.max(best, GC.scoreRow(rowVals, { type: "ohirune" }).total);
    if (has("yancha")) best = Math.max(best, GC.scoreRow(rowVals, { type: "yancha" }).total);
    if (has("amaenbo")) for (let num = 1; num <= 12; num++) best = Math.max(best, GC.scoreRow(rowVals, { type: "amaenbo", number: num }).total);
    return best;
  }

  // 自分の候補アクション（プレイ全種＋移動repair・reveal含まず）。
  // 公開タイミングは v0.6.0 normal に委譲するため、PIMC は「公開しない時の最善手」を選ぶ。
  function myCandidates(view, aiIndex) {
    const AI = getAI();
    const cands = [];
    const hand = view.players[aiIndex].hand || [];
    hand.forEach(function (c, i) { if (c.t === "butt") cands.push({ type: "play", cardIndex: i }); });
    // 移動候補は v0.6.0 の repair 手を1つだけ足す（分岐を絞る）
    const est = AI.estimate(view, aiIndex);
    const me = view.players[aiIndex];
    if (me.tokens > 0 && view.row.length >= 2) {
      const myKnown = [];
      view.row.forEach(function (c, i) { if (c.placedBy === aiIndex && c.v != null) myKnown.push(i); });
      if (myKnown.length) {
        const targets = [0, Math.min(view.row.length - 1, Math.max(1, Math.round(est.en)))];
        let bestDelta = 0.3, bestMove = null;
        for (let a = 0; a < myKnown.length; a++) for (let t = 0; t < targets.length; t++) {
          const from = myKnown[a], to = targets[t]; if (to === from) continue;
          const r = view.row.slice(); const card = r.splice(from, 1)[0]; r.splice(to, 0, card);
          const e = AI.estimate(view, aiIndex, r).en;
          if (e - est.en > bestDelta) { bestDelta = e - est.en; bestMove = { type: "move", from: from, to: to }; }
        }
        if (bestMove) cands.push(bestMove);
      }
    }
    if (cands.length === 0) cands.push({ type: "reveal" }); // 安全網（手が無い時）
    return cands;
  }

  function key(a) { return a.type === "play" ? "p" + a.cardIndex : (a.type === "move" ? "m" + a.from + "_" + a.to : a.type); }

  // ---- PIMC 本体（同期・budgetは決定化数Kで決定論・deadlineMsで実機打ち切り）----
  // 公開/移動のタイミングは v0.6.0 normal(=よく調律され stall 2%) に委譲し、PIMC は
  // 「公開しない時にどの札を出す/どう動かすか」を決定化探索で最適化する（stall回避＋上積み）。
  // 公開/移動タイミングは hard/鬼 共通で ai.js "hard"(積極EV基準・0点回避・stall2%) に委譲。
  // reveal/move を返すならそれを踏襲、プレイなら null（PIMCで札選択へ）。sync/async 共通で使う。
  function deferRevealMove(view, aiIndex) {
    const GC = getCore(), AI = getAI();
    const legalMock = GC.legalActions({
      finished: false, current: aiIndex,
      players: view.players.map(function (p, i) { return { hand: i === aiIndex ? (p.hand || []) : new Array(p.handCount).fill({ t: "butt", v: 1 }), tokens: p.tokens }; }),
      row: view.row,
    });
    const nAct = AI.chooseAction(view, aiIndex, "hard", 0, legalMock);
    return (nAct.type === "reveal" || nAct.type === "move") ? nAct : null;
  }

  function pimcChoose(view, aiIndex, difficulty, opts) {
    const par = PARAMS[difficulty] || PARAMS.hard;
    const K = (opts && opts.K) || par.K;
    const D = (opts && opts.D != null) ? opts.D : par.D;
    const deadline = (opts && opts.deadlineMs != null) ? opts.deadlineMs : null; // null=時間無視(sim/決定論)
    const startMs = deadline != null && typeof Date !== "undefined" ? Date.now() : 0;
    const deferred = deferRevealMove(view, aiIndex);
    if (deferred) return deferred;
    const cands = myCandidates(view, aiIndex);
    if (cands.length === 1) return cands[0];
    const weighted = (opts && opts.weighted != null) ? opts.weighted : par.weighted;
    const rng = mulberry32(hashView(view, aiIndex, 303));
    const sum = {}, seen = {};
    cands.forEach(function (a) { sum[key(a)] = 0; seen[key(a)] = a; });
    let done = 0;
    for (let k = 0; k < K; k++) {
      const world = determinize(view, aiIndex, rng, weighted);
      // applyFull は入力stateを変更しない(applyActionが内部クローン)ため world を直接使い回せる。
      for (let c = 0; c < cands.length; c++) {
        const s1 = applyFull(world, cands[c], aiIndex, rng);
        const s2 = rollout(s1, D, rng);
        sum[key(cands[c])] += evaluate(s2, aiIndex);
      }
      done++;
      if (deadline != null && (Date.now() - startMs) > deadline) break;
    }
    let best = cands[0], bestV = -Infinity;
    cands.forEach(function (a) { const v = sum[key(a)] / Math.max(1, done); if (v > bestV) { bestV = v; best = a; } });
    return best;
  }

  // ---- 公開API（sim/ブラウザ共通）----
  // chooseAction: hard/鬼 は PIMC。宣言/特殊は v0.6.0(ai.js) に委譲。
  function chooseAction(view, aiIndex, difficulty, seed, legal, opts) {
    return pimcChoose(view, aiIndex, difficulty === "oni" ? "oni" : "hard", opts);
  }
  function chooseDeclaration(view, aiIndex, difficulty) {
    // 鬼は宣言もサンプル多めで精度UP（ai.js の hard 経路を使う）
    return getAI().chooseDeclaration(view, aiIndex, "hard");
  }
  function chooseSpecial(rowVals, hand, difficulty) {
    return getAI().chooseSpecial(rowVals, hand, "hard");
  }

  // ブラウザ用: 決定化ごとに yield して UI をブロックしない非同期版。
  // sync版(pimcChoose)と同じく、公開/移動は v0.6.0 に委譲してから PIMC で札選択する。
  async function chooseActionAsync(view, aiIndex, difficulty, opts) {
    const diff = difficulty === "oni" ? "oni" : "hard";
    const par = PARAMS[diff];
    const K = (opts && opts.K) || par.K, D = (opts && opts.D != null) ? opts.D : par.D;
    const budgetMs = (opts && opts.budgetMs) || par.budgetMs;
    const deferred = deferRevealMove(view, aiIndex);
    if (deferred) return deferred;
    const cands = myCandidates(view, aiIndex);
    if (cands.length === 1) return cands[0];
    const weighted = (opts && opts.weighted != null) ? opts.weighted : par.weighted;
    const rng = mulberry32(hashView(view, aiIndex, 303));
    const sum = {}; cands.forEach(function (a) { sum[key(a)] = 0; });
    const start = Date.now(); let done = 0;
    for (let k = 0; k < K; k++) {
      const world = determinize(view, aiIndex, rng, weighted);
      for (let c = 0; c < cands.length; c++) {
        const s1 = applyFull(world, cands[c], aiIndex, rng);
        const s2 = rollout(s1, D, rng);
        sum[key(cands[c])] += evaluate(s2, aiIndex);
      }
      done++;
      if (Date.now() - start > budgetMs) break;
      await new Promise(function (r) { setTimeout(r, 0); }); // yield（UIフリーズ防止）
    }
    let best = cands[0], bestV = -Infinity;
    cands.forEach(function (a) { const v = sum[key(a)] / Math.max(1, done); if (v > bestV) { bestV = v; best = a; } });
    return best;
  }

  const AIStrong = {
    determinize: determinize,
    evaluate: evaluate,
    chooseAction: chooseAction,
    chooseActionAsync: chooseActionAsync,
    chooseDeclaration: chooseDeclaration,
    chooseSpecial: chooseSpecial,
    PARAMS: PARAMS,
    _hashView: hashView,
  };
  if (typeof module !== "undefined") module.exports = AIStrong;
  if (typeof window !== "undefined") window.GameAIStrong = AIStrong;
})();
