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

  // 難易度別のワン!宣言 的中確率p の下限閾値（EV=5(2p-1)>0 ⇔ p>0.5）。easyは宣言しない。
  const WAN_P = { normal: 0.6, hard: 0.5 };

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

  // ---- 信念推定（belief）: view のみから隠れ場札の値をサンプリングし終端nの分布を出す ----
  // v0.6.0: ワン!宣言を「真の的中確率」で判断するための中核。決定論のため view から
  // 導出した seed で mulberry32 を回す（同一 state → 同一サンプル → 同一決定＝再現性）。
  function hashView(view, aiIndex, salt) {
    let h = 2166136261 >>> 0;
    function mix(x) { h ^= x >>> 0; h = Math.imul(h, 16777619) >>> 0; }
    mix(aiIndex + 1); mix((salt || 0) + 7); mix(view.current + 3);
    view.row.forEach(function (c) {
      mix(c.id + 1); mix(c.placedBy + 1); mix((c.v != null ? c.v : 13) + 1);
    });
    view.players.forEach(function (p) { mix((p.score + 200)); mix(p.handCount + 1); mix(p.tokens + 1); });
    mix(view.deckCount + 1); mix(view.discardCount + 1);
    return h >>> 0 || 1;
  }

  // 未知プールを値の配列に展開（各値は残枚数ぶん）。
  function poolArray(pool) {
    const arr = [];
    for (let v = 1; v <= 12; v++) for (let k = 0; k < (pool.cnt[v] || 0); k++) arr.push(v);
    return arr;
  }

  // 未知の特殊カード（自分の手札にも捨て札にも無い＝他者手札/山札に潜在）を返す。
  function unseenSpecials(view, aiIndex) {
    const all = { amaenbo: 1, yancha: 1, ohirune: 1 };
    const me = view.players[aiIndex];
    (me && me.hand ? me.hand : []).forEach(function (c) { if (c.t === "special") all[c.s] = 0; });
    (view.discard || []).forEach(function (c) { if (c.t === "special") all[c.s] = 0; });
    return Object.keys(all).filter(function (s) { return all[s] > 0; });
  }

  // 場札のうち自分の既知値はそのまま、他者の伏せ札は未知プールから重複なし抽出で埋め、終端nの
  // 分布を Monte Carlo で推定。ワン!は「特殊適用後のn」で精算されるため、公開者(view.current)が
  // ギャップ埋め特殊(甘えん坊/やんちゃ)を保有する確率 q を推定し、延長後nを重み q で混ぜる。
  function terminalNDist(view, aiIndex, rng, samples, modelSpecial) {
    const GC = getCore();
    const pool = unseenPool(view, aiIndex);
    const knownVals = view.row.map(function (c) {
      return (c.placedBy === aiIndex && c.v != null) ? c.v : null;
    });
    const hiddenPos = [];
    knownVals.forEach(function (v, i) { if (v === null) hiddenPos.push(i); });
    const basePool = poolArray(pool);
    const S = samples || 160;

    // 公開者がギャップ埋め特殊を保有・使用する確率 q（延長後nに重み付け）
    let q = 0;
    let fillers = [];
    if (modelSpecial) {
      const unseenSp = unseenSpecials(view, aiIndex).filter(function (s) { return s === "amaenbo" || s === "yancha"; });
      const revealer = view.current;
      let unseenSlots = 0;
      view.players.forEach(function (p, i) { if (i !== aiIndex) unseenSlots += p.handCount; });
      unseenSlots += (view.deckCount || 0);
      const rHC = (view.players[revealer] && revealer !== aiIndex) ? view.players[revealer].handCount : 0;
      const rPer = unseenSlots > 0 ? Math.min(1, rHC / unseenSlots) : 0;
      // 少なくとも1枚のギャップ埋め特殊を公開者が持つ確率
      let none = 1;
      for (let i = 0; i < unseenSp.length; i++) none *= (1 - rPer);
      q = 1 - none;
      fillers = unseenSp;
      // 公開者が自分自身なら手札から確定的に判定
      if (revealer === aiIndex) {
        const myFill = (view.players[aiIndex].hand || []).filter(function (c) { return c.t === "special" && (c.s === "amaenbo" || c.s === "yancha"); }).map(function (c) { return c.s; });
        fillers = myFill; q = myFill.length ? 1 : 0;
      }
    }

    const dist = {};
    let sum = 0;
    function add(n, w) { dist[n] = (dist[n] || 0) + w; sum += n * w; }
    for (let s = 0; s < S; s++) {
      const arr = basePool.slice();
      const need = Math.min(hiddenPos.length, arr.length);
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rng() * (arr.length - i));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      const rowVals = knownVals.slice();
      for (let k = 0; k < hiddenPos.length; k++) rowVals[hiddenPos[k]] = (k < need ? arr[k] : 1);
      const plainN = GC.scoreRow(rowVals).n;
      if (q > 0 && fillers.length) {
        // 公開者が最適な特殊で連番を延長した場合のn（即時ギャップ n+1 を埋める近似）
        let extN = plainN;
        for (let f = 0; f < fillers.length; f++) {
          const r = fillers[f] === "amaenbo"
            ? GC.scoreRow(rowVals, { type: "amaenbo", number: plainN + 1 })
            : GC.scoreRow(rowVals, { type: "yancha" });
          if (r.n > extN) extN = r.n;
        }
        add(plainN, 1 - q);
        add(extN, q);
      } else {
        add(plainN, 1);
      }
    }
    let nStar = 0, best = -1;
    for (const k in dist) { if (dist[k] > best) { best = dist[k]; nStar = Number(k); } }
    return { nStar: nStar, p: best / S, dist: dist, mean: sum / S, samples: S };
  }

  // view から「連番の期待到達長(en・小数)」と「自分が置いた既知で確定している連番長(knownRun)」を推定。
  // v0.4.1: 連番は場のどこかにある1を起点にする（起点より左は無視）。起点 start を全位置で試し、
  // en が最大になる起点を採用（core.js scoreRow の最大起点方式に整合）。起点が確定できない
  // 未知カードには残り分布から1である確率を織り込む（scoreRowと違い推定なので確率で評価）。
  function estimate(view, aiIndex, rowOverride) {
    const pool = unseenPool(view, aiIndex);
    const row = rowOverride || view.row;

    // 起点 start（=連番の"1"の位置）から走査した期待長と既知連番長を返す。
    function scanFrom(start) {
      const cnt = Object.assign({}, pool.cnt);
      let poolTotal = pool.total;
      let expected = 1;
      let en = 0;
      let knownRun = 0;
      let knownBroken = false;
      for (let i = start; i < row.length; i++) {
        const c = row[i];
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

    // 起点候補: 自分が置いた既知の1の位置＋未知カードの位置（未知は1でありうる）。
    // 空なら空列扱い。全候補の最大 en を採用。
    let best = { en: 0, knownRun: 0 };
    for (let s = 0; s < row.length; s++) {
      const c = row[s];
      const knownNonOne = c.placedBy === aiIndex && c.v != null && c.v !== 1;
      if (knownNonOne) continue; // 既知で1でない位置は起点になれない
      const r = scanFrom(s);
      if (r.en > best.en || (r.en === best.en && r.knownRun > best.knownRun)) best = r;
    }
    return best;
  }

  // 移動アクション選択（v0.6.0）。自分が値を知る場札のみ対象＝leak無し。
  //  - repair: 自分の既知札を動かして推定連番長 en が明確に伸びるなら動かす（normal/hard）
  //  - disrupt: 相手が直後に高得点公開しそうな時、自分の既知札を末尾へ動かして連番を崩す（hard）
  function chooseMove(view, aiIndex, difficulty, baseEn) {
    if (difficulty === "easy") return null;
    const me = view.players[aiIndex];
    if (!me || me.tokens <= 0) return null;
    const row = view.row;
    if (row.length < 2) return null;
    const myKnown = [];
    row.forEach(function (c, i) { if (c.placedBy === aiIndex && c.v != null) myKnown.push(i); });
    if (!myKnown.length) return null;

    function withMoved(from, to) {
      const r = row.slice();
      const card = r.splice(from, 1)[0];
      r.splice(to, 0, card);
      return r;
    }
    // repair: 各既知札を「先頭」「推定連番末尾の直後」へ動かす候補のみ試す（浅い探索・cheap）
    const targets = [0, Math.min(row.length - 1, Math.max(1, Math.round(baseEn)))];
    let bestDelta = 0.4; // 無駄打ち防止マージン
    let bestMove = null;
    for (let a = 0; a < myKnown.length; a++) {
      for (let t = 0; t < targets.length; t++) {
        const from = myKnown[a], to = targets[t];
        if (to === from) continue;
        const e = estimate(view, aiIndex, withMoved(from, to)).en;
        if (e - baseEn > bestDelta) { bestDelta = e - baseEn; bestMove = { type: "move", from: from, to: to }; }
      }
    }
    if (bestMove) return bestMove;

    // disrupt(hard): 場が育ち相手の公開が近い時、自分の連番寄与札を末尾へ退避して崩す
    if (difficulty === "hard" && baseEn >= 4 && row.length >= 4) {
      const from = myKnown[0];
      const to = row.length - 1;
      if (from !== to) {
        const e = estimate(view, aiIndex, withMoved(from, to)).en;
        // 崩して自分の推定が下がる=相手の見た目も崩れる（相手も同じ場を見る）→ 妨害成立
        if (baseEn - e > 0.6) return { type: "move", from: from, to: to };
      }
    }
    return null;
  }

  // 手番アクション選択（必ず legal を返す・view経由のみ参照）
  function chooseAction(view, aiIndex, difficulty, seed, legal) {
    const est = estimate(view, aiIndex);
    const en = est.en;
    const rowLen = view.row.length;
    const me = view.players[aiIndex];
    const hand = (me && me.hand) ? me.hand : [];
    const plays = legal.filter(function (a) { return a.type === "play"; });
    const canReveal = legal.some(function (a) { return a.type === "reveal"; });
    const canMove = legal.some(function (a) { return a.type === "move"; });

    // 0点公開回避: 場に1が有り得ない（既知1なし かつ 伏せ札0 or 未知プールに1が0）なら自発公開しない
    const knownOne = view.row.some(function (c) { return c.placedBy === aiIndex && c.v === 1; });
    const pool = unseenPool(view, aiIndex);
    const hiddenCount = view.row.filter(function (c) { return !(c.placedBy === aiIndex && c.v != null); }).length;
    const oneImpossible = !knownOne && (hiddenCount === 0 || (pool.cnt[1] || 0) === 0);

    // 移動（repair/disrupt）を先に検討（プレイ可能でも改善が大きければ移動）
    if (canMove) {
      const mv = chooseMove(view, aiIndex, difficulty, en);
      if (mv) return mv;
    }

    // 公開判断: まず安価な en で足切り（en<pre なら公開検討しない）。有望なら信念MCで厳密判定。
    // en は「1がある確率」を過大評価しうるため、belief の mean n と P(n=0) で 0点公開を排除する。
    const enPre = difficulty === "hard" ? 2.4 : difficulty === "normal" ? 3.0 : 4.0;
    if (canReveal && !oneImpossible && rowLen >= 3 && en >= enPre) {
      const rng = mulberry32(hashView(view, aiIndex, 202));
      const d = terminalNDist(view, aiIndex, rng, 90, true); // 公開者=自分→自分の特殊込みで評価
      const pZero = (d.dist[0] || 0) / d.samples;
      const meanThr = difficulty === "hard" ? 2.7 : difficulty === "normal" ? 3.2 : 4.2;
      // pZero を厳しめ（0.10）にして自発0点公開を明確に抑制（試合長とのバランスは計測で確認）
      if (d.mean >= meanThr && pZero < 0.10) return { type: "reveal" };
    }

    // プレイ: 連番の続き(need)になる自札を優先、場が空なら1優先、他は小さい順
    if (plays.length > 0) {
      const need = Math.floor(en) + 1;
      let best = plays[0], bestScore = 1e9;
      plays.forEach(function (a) {
        const v = hand[a.cardIndex].v;
        let sc;
        if (rowLen === 0) sc = Math.abs(v - 1);
        else if (v === need) sc = -100;
        else sc = v;
        if (sc < bestScore) { bestScore = sc; best = a; }
      });
      return best;
    }

    // 手札が全て特殊 → 移動 or 公開（0点でも強制的な選択肢しかなければ公開）
    if (canMove && rowLen >= 2) return { type: "move", from: rowLen - 1, to: 0 };
    if (canReveal) return { type: "reveal" };
    return legal[0];
  }

  // ワン!宣言（v0.6.0: 信念分布から終端nの最尤値n*と的中確率pを算出し、EV=5(2p-1)>0 で宣言）
  // EV基準ちょうどは p>0.5。難易度で閾値を変える: easy=宣言せず / normal=p>0.6(安全側) / hard=p>0.5。
  // p は「真の的中確率」なので、的中率≈pの平均に収束する（旧実装の代理pと違い実効的）。
  function chooseDeclaration(view, aiIndex, difficulty) {
    if (difficulty === "easy") return null; // easyはワン!をほぼ使わない
    const rng = mulberry32(hashView(view, aiIndex, 101));
    const dist = terminalNDist(view, aiIndex, rng, difficulty === "hard" ? 200 : 160, true);
    if (dist.nStar < 1) return null; // n*=0（=1が場に無い最尤）は宣言しても得しない
    const thr = difficulty === "hard" ? WAN_P.hard : WAN_P.normal;
    if (dist.p > thr) return { player: aiIndex, value: dist.nStar };
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
    WAN_P: WAN_P,
    terminalNDist: terminalNDist,
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
