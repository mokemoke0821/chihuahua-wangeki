// ai.js — CPU AI（推論モデル・v0.2.0で記憶忘却モデルを廃止）
// 【設計】このゲームは記憶ゲームではなく推理・ブラフゲーム。AIは viewFor が返す
// 「見てよい情報」のみで推論する（state を直接参照しない＝カンニング構造防止）。
//   - 自分が置いたカードの値は既知（view.row[].placedBy===自分 なら v あり）
//   - 他者のカードは「未出現カードの残り分布」から一様確率で推定（捨て札は公開＝除外）
//   - 難易度 = 推論精度/リスク許容度（easy: 雑・ワン!ほぼ宣言しない / normal: 期待値 / hard: 分布+ブラフ移動）
// core API(scoreRow) は純関数計算にのみ使用（公開後=表向きの row 評価）。
// ブラウザ/node両対応。

(function () {
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

  function getCore() {
    if (typeof window !== "undefined" && window.GameCore) return window.GameCore;
    if (typeof require !== "undefined") return require("./core.js");
    throw new Error("GameCore not found");
  }

  // 難易度別のワン!宣言リスク許容（的中確率pの下限閾値）。easyは実質宣言しない。
  const DECL_THRESHOLD = { easy: 0.99, normal: 0.62, hard: 0.46 };

  // 未出現カードの残り分布（自分が見えている情報を全 butt 母数2から差し引く）。
  function unseenPool(view, aiIndex) {
    const cnt = {};
    for (let v = 1; v <= 12; v++) cnt[v] = 2;
    const me = view.players[aiIndex];
    (me && me.hand ? me.hand : []).forEach(function (c) {
      if (c.t === "butt") cnt[c.v]--;
    });
    view.row.forEach(function (c) {
      if (c.placedBy === aiIndex && c.v != null) cnt[c.v]--; // 自分が置いた既知
    });
    (view.discard || []).forEach(function (c) {
      if (c.t === "butt") cnt[c.v]--; // 捨て札は公開
    });
    let total = 0;
    for (let v = 1; v <= 12; v++) {
      if (cnt[v] < 0) cnt[v] = 0;
      total += cnt[v];
    }
    return { cnt: cnt, total: total };
  }

  // view から「連番の期待到達長(en・小数)」と「自分が置いた既知で確定している連番長(knownRun)」を推定。
  function estimate(view, aiIndex) {
    const pool = unseenPool(view, aiIndex);
    const cnt = Object.assign({}, pool.cnt);
    let poolTotal = pool.total;
    let expected = 1;
    let en = 0;
    let knownRun = 0;
    let knownBroken = false;
    for (let i = 0; i < view.row.length; i++) {
      const c = view.row[i];
      const known = c.placedBy === aiIndex && c.v != null;
      if (known) {
        if (c.v === expected) { en += 1; expected++; if (!knownBroken) knownRun++; }
        else if (c.v === expected - 1) { /* 重複・継続 */ }
        else { break; } // 既知で連番が切れた
      } else {
        knownBroken = true; // 未知が挟まると以降は確定扱いしない
        const p = poolTotal > 0 ? (cnt[expected] || 0) / poolTotal : 0;
        if (p <= 0) break;
        en += p;
        cnt[expected] = Math.max(0, (cnt[expected] || 0) - p);
        poolTotal -= p;
        expected++;
      }
    }
    return { en: en, knownRun: knownRun };
  }

  // 手番アクション選択（必ず legal を返す・view経由のみ参照）
  function chooseAction(view, aiIndex, difficulty, seed, legal) {
    const est = estimate(view, aiIndex);
    const rowLen = view.row.length;
    const me = view.players[aiIndex];
    const hand = (me && me.hand) ? me.hand : [];
    const plays = legal.filter(function (a) { return a.type === "play"; });
    const canReveal = legal.some(function (a) { return a.type === "reveal"; });
    const canMove = legal.some(function (a) { return a.type === "move"; });

    // 期待得点（連番期待長 en から近似）で公開判断。難易度で閾値。
    const en = est.en;
    const approxScore = (en * (en + 1)) / 2;
    const thr = difficulty === "hard" ? 10 : difficulty === "normal" ? 13 : 16;
    if (canReveal && approxScore >= thr && rowLen >= 3) return { type: "reveal" };
    if (canReveal && rowLen >= 11) return { type: "reveal" }; // 12強制公開前に確保

    // プレイ優先: 連番の続き(expected)になる自札があれば出す、なければ小さい順
    if (plays.length > 0) {
      const need = Math.floor(en) + 1; // 次に欲しい数字（近似）
      let best = plays[0];
      let bestScore = 1e9;
      plays.forEach(function (a) {
        const v = hand[a.cardIndex].v;
        // need に近い / 場が空なら1優先 / それ以外は小さいほど良い
        let sc;
        if (rowLen === 0) sc = Math.abs(v - 1);
        else if (v === need) sc = -100;
        else sc = v;
        if (sc < bestScore) { bestScore = sc; best = a; }
      });
      return best;
    }

    // 手札が全て特殊 → 移動(hardはブラフ的移動も) or 公開
    if (canMove && rowLen >= 2) {
      return { type: "move", from: rowLen - 1, to: 0 };
    }
    if (canReveal) return { type: "reveal" };
    return legal[0];
  }

  // ワン!宣言（公開前=裏向き。推定分布から的中確率pを計算し EV>0 かつ p>閾値 で宣言）
  function chooseDeclaration(view, aiIndex, difficulty) {
    const est = estimate(view, aiIndex);
    const declaredN = Math.round(est.en);
    if (declaredN < 1) return null;
    // 的中確率の近似: 自分が置いた確定連番の割合が高いほど確信（自作連番ほど当てやすい）
    const p = Math.min(1, est.knownRun / Math.max(1, declaredN));
    const ev = 5 * p - 5 * (1 - p); // = 10p - 5
    const threshold = DECL_THRESHOLD[difficulty] || 0.62;
    if (ev > 0 && p > threshold) {
      return { player: aiIndex, value: declaredN };
    }
    return null;
  }

  // 特殊カード選択（公開後=表向き＝全値が公開情報。rowVals(公開row値配列)とhandを明示受領）
  // ※ここは公開後の公開情報のみを使うため view でなく確定 rowVals を受ける（state直接参照はしない）
  function chooseSpecial(rowVals, hand, difficulty) {
    const GC = getCore();
    const has = function (name) {
      return (hand || []).some(function (c) { return c.t === "special" && c.s === name; });
    };
    const base = GC.scoreRow(rowVals);
    let best = null;
    let bestTotal = base.total;
    if (has("ohirune")) {
      const r = GC.scoreRow(rowVals, { type: "ohirune" });
      if (r.total > bestTotal) { bestTotal = r.total; best = { type: "ohirune" }; }
    }
    if (has("amaenbo")) {
      for (let num = 1; num <= 12; num++) {
        const r = GC.scoreRow(rowVals, { type: "amaenbo", number: num });
        if (r.total > bestTotal) { bestTotal = r.total; best = { type: "amaenbo", number: num }; }
      }
    }
    if (has("yancha")) {
      const r = GC.scoreRow(rowVals, { type: "yancha" });
      if (r.total > bestTotal) { bestTotal = r.total; best = { type: "yancha" }; }
    }
    return best;
  }

  const AI = {
    DECL_THRESHOLD: DECL_THRESHOLD,
    unseenPool: unseenPool,
    estimate: estimate,
    chooseAction: chooseAction,
    chooseDeclaration: chooseDeclaration,
    chooseSpecial: chooseSpecial,
    _mulberry32: mulberry32,
  };
  if (typeof module !== "undefined") module.exports = AI;
  if (typeof window !== "undefined") window.GameAI = AI;
})();
