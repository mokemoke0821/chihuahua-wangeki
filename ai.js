// ai.js — CPU AI（core.js とは分離・純ロジックには入れない）
// 記憶モデル: 自分が置いたカードは完全記憶。他者のカードは精度pで記憶。
// core API(legalActions/applyAction/scoreRow) のみ経由で行動。
// ブラウザ/node両対応。

(function () {
  const DIFF_P = { easy: 0.4, normal: 0.7, hard: 0.9 };

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

  // メモリ: 各行位置の推定値。owner=自分なら確定、他者は精度pで確定/未知。
  // memory[playerIndex] = { known: {rowKey: value|null} } を簡易化し、
  // 実装では「AIが知る row 推定値配列」を都度構築する。
  function estimateRow(state, aiIndex, memory) {
    // memory.reveal[k] = value(確定) or null(未知)
    const est = [];
    for (let k = 0; k < state.row.length; k++) {
      const m = memory && memory.cells && memory.cells[k];
      est.push(m && typeof m.value === "number" ? m.value : null);
    }
    return est;
  }

  // 既知セルだけで暫定 scoreRow（未知は連番を切る=控えめ推定）
  function estimateScore(est) {
    const vals = [];
    for (let i = 0; i < est.length; i++) {
      if (est[i] === null) break; // 未知で連番推定を打ち切り（保守的）
      vals.push(est[i]);
    }
    // GameCore.scoreRow を使う
    const GC = getCore();
    return GC.scoreRow(vals);
  }

  function getCore() {
    if (typeof window !== "undefined" && window.GameCore) return window.GameCore;
    if (typeof require !== "undefined") return require("./core.js");
    throw new Error("GameCore not found");
  }

  // 記憶を更新（イベントから）: 自分の played は確定、他者は精度pで確定/未知
  function updateMemory(memory, events, aiIndex, difficulty, rng) {
    const p = DIFF_P[difficulty] || 0.7;
    if (!memory.cells) memory.cells = {};
    events.forEach(function (e) {
      if (e.type === "played") {
        const k = memory._rowLen || 0;
        memory._rowLen = k + 1;
        if (e.player === aiIndex) {
          memory.cells[k] = { value: e.value };
        } else {
          const ok = rng() < p;
          memory.cells[k] = ok ? { value: e.value } : { value: null };
        }
      } else if (e.type === "revealed" || e.type === "score") {
        // 公開で場がリセット→記憶クリア
        memory.cells = {};
        memory._rowLen = 0;
      } else if (e.type === "moved") {
        // 移動で位置がずれる→簡易化: 記憶を1手ぶん曖昧化（クリアはしない）
        // from を抜いて to へ挿入
        const cells = memory.cells || {};
        const arr = [];
        const len = memory._rowLen || 0;
        for (let k = 0; k < len; k++) arr.push(cells[k] || { value: null });
        if (e.from >= 0 && e.from < arr.length) {
          const c = arr.splice(e.from, 1)[0];
          arr.splice(e.to, 0, c);
        }
        memory.cells = {};
        arr.forEach(function (c, k) { memory.cells[k] = c; });
      }
    });
    return memory;
  }

  // 手番アクション選択（必ず legal な action を返す）
  function chooseAction(state, aiIndex, memory, difficulty, seed) {
    const GC = getCore();
    const legal = GC.legalActions(state);
    const rng = mulberry32(((seed >>> 0) + state.row.length * 97 + aiIndex * 13) >>> 0);
    const me = state.players[aiIndex];
    const est = estimateRow(state, aiIndex, memory);
    const score = estimateScore(est);

    const plays = legal.filter(function (a) { return a.type === "play"; });
    const canReveal = legal.some(function (a) { return a.type === "reveal"; });
    const canMove = legal.some(function (a) { return a.type === "move"; });

    // 公開閾値（難易度で調整）: 推定得点が閾値超なら公開
    const thr = difficulty === "hard" ? 10 : difficulty === "normal" ? 13 : 16;
    if (canReveal && score.total >= thr && state.row.length >= 3) {
      return withReveal(state, aiIndex, memory, difficulty);
    }
    // 場が長い(11)なら公開寄り（12で強制公開回避＝先に公開して得点確保）
    if (canReveal && state.row.length >= 11) {
      return withReveal(state, aiIndex, memory, difficulty);
    }

    // プレイ優先: 1が場に無ければ低い数字を置く（連番の起点作り）
    if (plays.length > 0) {
      const hand = me.hand;
      // 場が空 or 直近推定の続きになる butt を優先、なければ最小値
      let best = plays[0];
      let bestScore = 999;
      plays.forEach(function (a) {
        const v = hand[a.cardIndex].v;
        // ヒューリスティック: 場が空なら1を最優先、それ以外は小さいほど良い
        const s = state.row.length === 0 ? Math.abs(v - 1) : v;
        if (s < bestScore) { bestScore = s; best = a; }
      });
      return best;
    }

    // 手札が全て特殊 → 移動 or 公開
    if (canMove && state.row.length >= 2) {
      // 連番修復に使えそうなら移動（簡易: 末尾を先頭付近へ）
      return { type: "move", from: state.row.length - 1, to: 0 };
    }
    if (canReveal) return withReveal(state, aiIndex, memory, difficulty);
    // フォールバック（必ず legal を返す）
    return legal[0];
  }

  // 特殊カード選択（公開後＝表向きなので真値で最善手を評価。core.js準拠）
  // 甘えん坊/やんちゃ/お昼寝を全て試し total 最大の1枚を返す（base超のみ）。
  function chooseSpecial(state, revealer) {
    const GC = getCore();
    const me = state.players[revealer];
    const has = function (name) {
      return me.hand.some(function (c) { return c.t === "special" && c.s === name; });
    };
    const base = GC.scoreRow(state.row);
    let best = null;
    let bestTotal = base.total;
    if (has("ohirune")) {
      const r = GC.scoreRow(state.row, { type: "ohirune" });
      if (r.total > bestTotal) { bestTotal = r.total; best = { type: "ohirune" }; }
    }
    if (has("amaenbo")) {
      for (let num = 1; num <= 12; num++) {
        const r = GC.scoreRow(state.row, { type: "amaenbo", number: num });
        if (r.total > bestTotal) { bestTotal = r.total; best = { type: "amaenbo", number: num }; }
      }
    }
    if (has("yancha")) {
      const r = GC.scoreRow(state.row, { type: "yancha" });
      if (r.total > bestTotal) { bestTotal = r.total; best = { type: "yancha" }; }
    }
    return best;
  }

  // 公開アクション（宣言＝公開前=裏向きなので記憶推定 / 特殊＝公開後=真値）
  function withReveal(state, aiIndex, memory, difficulty) {
    const special = chooseSpecial(state, aiIndex);
    // 宣言: 記憶推定に基づく（真値カンニング禁止）。hardのみ・控えめ
    const declarations = [];
    if (difficulty === "hard") {
      const est = estimateScore(estimateRow(state, aiIndex, memory));
      if (est.n >= 3) declarations.push({ player: aiIndex, value: est.n });
    }
    return { type: "reveal", declarations: declarations, special: special };
  }

  // 他プレイヤーの公開への自分のワン！宣言（記憶推定ベース・真値参照禁止）
  function chooseDeclaration(state, aiIndex, memory, difficulty) {
    if (difficulty !== "hard") return null;
    const est = estimateScore(estimateRow(state, aiIndex, memory));
    if (est.n >= 4) return { player: aiIndex, value: est.n };
    return null;
  }

  const AI = {
    DIFF_P: DIFF_P,
    updateMemory: updateMemory,
    chooseAction: chooseAction,
    chooseDeclaration: chooseDeclaration,
    chooseSpecial: chooseSpecial,
  };
  if (typeof module !== "undefined") module.exports = AI;
  if (typeof window !== "undefined") window.GameAI = AI;
})();
