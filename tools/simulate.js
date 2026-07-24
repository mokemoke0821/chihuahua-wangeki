// tools/simulate.js — チワワでワン撃 バランス計測シミュレータ（v0.5.0）
// CPU自己対戦をヘッドレスで回し、調整判断のための実測値を出す。依存パッケージなし。
// 【本番バンドル非対象】index.html からは読み込まない開発ツール。
//
// 使い方:
//   node tools/simulate.js --games=1000 --players=2 --difficulty=normal --seed=12345
//   node tools/simulate.js --all            # 全9条件(players2/3/4 × easy/normal/hard)を一括
//
// 原則:
//   - 手はすべて GameCore.applyAction 経由。AIの手が legalActions に含まれるか毎回検証し、
//     違法手が出たら即エラー停止（不正な計測を防ぐ）。
//   - 決定論: 同一 (seed, games, players, difficulty) は完全に同一出力（core.js/ai.js は非決定要素なし）。
//   - 1試合が MAX_ROUNDS を超えたら打ち切り stalled としてカウント。

const path = require("path");
const GC = require(path.join(__dirname, "..", "core.js"));
const AI = require(path.join(__dirname, "..", "ai.js"));

const DEFAULT_MAX_ROUNDS = 500; // 指示書規定の打ち切り。--maxRounds で診断用に上書き可。

function parseArgs(argv) {
  const a = { games: 1000, players: 2, difficulty: "normal", seed: 12345, all: false, json: false, maxRounds: DEFAULT_MAX_ROUNDS, sweep: false };
  const rules = defaultRules();
  argv.slice(2).forEach(function (s) {
    if (s === "--all") { a.all = true; return; }
    if (s === "--json") { a.json = true; return; }
    if (s === "--sweep") { a.sweep = true; return; }
    const m = s.match(/^--([a-zA-Z]+)=(.+)$/);
    if (!m) return;
    const k = m[1], v = m[2];
    if (k === "games" || k === "players" || k === "seed" || k === "maxRounds") a[k] = parseInt(v, 10);
    else if (k === "difficulty") a.difficulty = v;
    else if (k === "target" || k === "wanReward" || k === "wanPenalty" || k === "moveTokens") rules[k] = parseInt(v, 10);
    else if (k === "forbidZeroReveal" || k === "napBoost") rules[k] = (v === "true" || v === "1");
  });
  a.rules = rules;
  return a;
}

// 各試合の seed は base+index から決定論的に導出（再現性のため）。
function gameSeed(base, index) {
  return (((base >>> 0) + (index + 1) * 2654435761) >>> 0) || 1;
}

// ルール変数のデフォルト（= core.js の現行仕様）。sim側でのみ上書きし core.js は変更しない。
function defaultRules() {
  return { target: 150, wanReward: 5, wanPenalty: 5, forbidZeroReveal: false, moveTokens: 2, napBoost: false };
}

// 1試合をCPU自己対戦で実行し、計測イベントを返す。
// diffs: 各座席の難易度配列（例 ["hard","normal"]）。全席同一なら同じ値を並べる。
// rules: ルール変数（sim側上書き・スイープ用）。省略時は現行ルール。
function playGame(seed, players, diffs, maxRounds, rules) {
  rules = rules || defaultRules();
  const rulesDefault = (rules.target === 150 && rules.wanReward === 5 && rules.wanPenalty === 5 &&
    !rules.forbidZeroReveal && rules.moveTokens === 2 && !rules.napBoost);
  let state = GC.newGame(seed, players);
  // moveTokens 上書き（core.js は 2 固定）
  if (rules.moveTokens !== 2) state.players.forEach(function (p) { p.tokens = rules.moveTokens; });
  let rounds = 0;   // ラウンド（現手番がstarterに戻るたび=1周）
  let turns = 0;    // 個々の手番（play/move/reveal 各1）
  const rec = {
    reveals: [],        // {total, n, wangeki, forced, revealer, special, movedThisRow, decls, hits, wanDeltaSum}
    moves: 0,           // move 実行回数
    stalled: false,
    outcome: null,      // "150pts" | "wangeki" | "stalled"
    winner: null,
    winnerScore: null,
  };
  let movedThisRow = false; // 現在の場（次の公開まで）に move が使われたか

  while (!state.finished) {
    if (state.current === state.starter) {
      rounds += 1;
      if (rounds > maxRounds) { rec.stalled = true; rec.outcome = "stalled"; break; }
    }
    const cur = state.current;
    let legal = GC.legalActions(state);
    // forbidZeroReveal: 場に1が無い自発公開を禁止（代替手がある時のみ剥奪・強制公開は別枠で許容）
    if (rules.forbidZeroReveal && state.row.length >= 1 && GC.scoreRow(state.row).n === 0) {
      const hasAlt = legal.some(function (a) { return a.type === "play" || a.type === "move"; });
      if (hasAlt) legal = legal.filter(function (a) { return a.type !== "reveal"; });
    }
    const action = AI.chooseAction(GC.viewFor(state, cur), cur, diffs[cur], seed, legal);

    // 違法手検証（型が legal に含まれるか）
    if (!action || !legal.some(function (a) { return a.type === action.type; })) {
      throw new Error("ILLEGAL ACTION: seed=" + seed + " players=" + players + " diff=" + diffs[cur] +
        " turn=" + turns + " action=" + JSON.stringify(action) + " legal=" + JSON.stringify(legal.map(function (a) { return a.type; })));
    }

    // 公開判定（明示reveal or 12枚目play=強制公開）
    const willReveal = action.type === "reveal";
    const willBe12th = action.type === "play" && state.row.length === 11 &&
      state.players[cur].hand[action.cardIndex] && state.players[cur].hand[action.cardIndex].t === "butt";

    let res;
    if (willReveal || willBe12th) {
      // 採点対象の場（12枚目込み）で宣言・特殊を判断（index.html の doAction と同一手順）
      let revealState = state;
      if (willBe12th) {
        revealState = JSON.parse(JSON.stringify(state));
        const pc = state.players[cur].hand[action.cardIndex];
        revealState.row.push({ t: "butt", v: pc.v, placedBy: cur, id: revealState.cardSeq++, faceDown: true });
      }
      // 全員のワン！宣言（各自 viewFor 経由の推論のみ）
      const decls = [];
      for (let i = 0; i < players; i++) {
        const d = AI.chooseDeclaration(GC.viewFor(revealState, i), i, diffs[i]);
        if (d) decls.push(d);
      }
      // 公開者の特殊カード（公開後=表向きの確定row値で最善選択）
      const rowVals = revealState.row.map(function (c) { return c.v; });
      const special = AI.chooseSpecial(rowVals, revealState.players[cur].hand, diffs[cur]);

      res = GC.applyAction(state, Object.assign({}, action, { declarations: decls, special: special }));

      const revealed = res.events.find(function (e) { return e.type === "revealed"; });
      const sc = res.events.find(function (e) { return e.type === "score"; });
      const wans = res.events.filter(function (e) { return e.type === "wan"; });
      const specialUsed = res.events.find(function (e) { return e.type === "specialUsed"; });
      if (revealed && sc) {
        rec.reveals.push({
          total: sc.detail.total,
          n: sc.detail.n,
          wangeki: sc.detail.wangeki,
          forced: revealed.forced,
          revealer: revealed.revealer,
          special: specialUsed ? specialUsed.special : null,
          specialIncrement: specialUsed ? (sc.detail.total - GC.scoreRow(revealed.row).total) : 0,
          movedThisRow: movedThisRow,
          decls: decls.length,
          hits: wans.filter(function (w) { return w.delta > 0; }).length,
          wanDeltaSum: wans.reduce(function (a, w) { return a + w.delta; }, 0),
        });
      }
      movedThisRow = false; // 公開で場がリセット

      // ルール変数の適用（非デフォルト時のみ・core が付けた ±5 を望む値に補正）
      if (!rulesDefault && revealed && sc) {
        const spOhirune = specialUsed && specialUsed.special === "ohirune";
        wans.forEach(function (w) {
          const core = w.delta; // ±5
          let desired = core > 0 ? rules.wanReward : -rules.wanPenalty;
          // napBoost: お昼寝使用者(公開者)のワン!外れ −を無効化
          if (rules.napBoost && spOhirune && w.player === revealed.revealer && core < 0) desired = 0;
          res.state.players[w.player].score += (desired - core);
        });
      }
    } else {
      res = GC.applyAction(state, action);
      if (action.type === "move") { rec.moves += 1; movedThisRow = true; }
    }

    // applyAction がエラーイベントを返した場合も停止（想定外）
    if (res.events.some(function (e) { return e.type === "error"; })) {
      throw new Error("APPLY ERROR: " + JSON.stringify(res.events.find(function (e) { return e.type === "error"; })) +
        " seed=" + seed + " action=" + JSON.stringify(action));
    }

    state = res.state;
    turns += 1;

    // カスタム target 勝利判定（非デフォルト時のみ。wangeki即勝ちは core が finished 済み→尊重）。
    // core の 150 判定はスコア調整前の値なので、非デフォルトでは rule 側で上書きする。
    if (!rulesDefault) {
      const wangekiWin = res.events.some(function (e) { return e.type === "gameover" && e.reason === "wangeki"; });
      if (!wangekiWin) {
        state.finished = false; state.winner = null; // core の 150 判定を無効化し rule で再判定
        let max = -Infinity;
        state.players.forEach(function (p) { if (p.score > max) max = p.score; });
        if (max >= rules.target) {
          const leaders = [];
          state.players.forEach(function (p, i) { if (p.score === max) leaders.push(i); });
          state.finished = true;
          state.winner = leaders.length === 1 ? leaders[0] : "draw";
        }
      }
    }
  }

  if (!rec.stalled) {
    rec.winner = state.winner;
    rec.outcome = state.winner !== null && state.finished
      ? (state.lastReveal && state.lastReveal.result && state.lastReveal.result.wangeki ? "wangeki" : "150pts")
      : rec.outcome;
    if (typeof state.winner === "number") rec.winnerScore = state.players[state.winner].score;
  }
  rec.rounds = rounds;
  rec.turns = turns;
  // 各プレイヤーの残トークン（使い切り判定用）
  rec.tokensLeft = state.players.map(function (p) { return p.tokens; });
  return rec;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort(function (a, b) { return a - b; });
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0; }
function r2(x) { return Math.round(x * 100) / 100; }
function pct(n, d) { return d ? r2((n / d) * 100) : 0; }

function runCondition(games, players, difficulty, seed, maxRounds, rules) {
  const roundsArr = [], turnsArr = [], winnerScores = [];
  let stalled = 0, win150 = 0, winWangeki = 0, draws = 0, starterWins = 0;
  let totalReveals = 0, zeroReveals = 0, revealScoreSum = 0, wangekiReveals = 0;
  const nDist = {}; for (let k = 0; k <= 12; k++) nDist[k] = 0;
  let declSum = 0, hitSum = 0, wanNet = 0;
  let movedReveals = 0, movedRevealScore = 0, unmovedReveals = 0, unmovedRevealScore = 0;
  const spUse = { amaenbo: 0, yancha: 0, ohirune: 0 };
  const spInc = { amaenbo: 0, yancha: 0, ohirune: 0 };
  let totalMoves = 0, tokenExhaustedPlayers = 0, totalPlayerSlots = 0;

  const diffs = [];
  for (let i = 0; i < players; i++) diffs.push(difficulty);
  for (let g = 0; g < games; g++) {
    const rec = playGame(gameSeed(seed, g), players, diffs, maxRounds, rules);
    if (rec.stalled) { stalled += 1; }
    else {
      roundsArr.push(rec.rounds); turnsArr.push(rec.turns);
      if (rec.outcome === "wangeki") winWangeki += 1;
      else if (rec.winner === "draw") draws += 1;
      else win150 += 1;
      if (rec.winner === 0) starterWins += 1; // seat0=初期starter=先手
      if (typeof rec.winnerScore === "number") winnerScores.push(rec.winnerScore);
    }
    totalMoves += rec.moves;
    (rec.tokensLeft || []).forEach(function (t) { totalPlayerSlots += 1; if (t === 0) tokenExhaustedPlayers += 1; });

    rec.reveals.forEach(function (rv) {
      totalReveals += 1;
      revealScoreSum += rv.total;
      if (rv.total <= 0) zeroReveals += 1;
      if (rv.wangeki) wangekiReveals += 1;
      nDist[Math.max(0, Math.min(12, rv.n))] += 1;
      declSum += rv.decls; hitSum += rv.hits; wanNet += rv.wanDeltaSum;
      if (rv.movedThisRow) { movedReveals += 1; movedRevealScore += rv.total; }
      else { unmovedReveals += 1; unmovedRevealScore += rv.total; }
      if (rv.special && spUse.hasOwnProperty(rv.special)) { spUse[rv.special] += 1; spInc[rv.special] += rv.specialIncrement; }
    });
  }

  const decided = win150 + winWangeki + draws;
  return {
    cond: "players=" + players + " " + difficulty,
    games: games, stalled: stalled,
    // 試合長
    roundsMean: r2(mean(roundsArr)), roundsMedian: median(roundsArr), roundsMax: roundsArr.length ? Math.max.apply(null, roundsArr) : 0,
    turnsMean: r2(mean(turnsArr)), stalledRate: pct(stalled, games),
    // 決着
    win150Rate: pct(win150, games), wangekiRate: pct(winWangeki, games), drawRate: pct(draws, games),
    winnerScoreMean: r2(mean(winnerScores)), winnerScoreMedian: median(winnerScores),
    winnerScoreMax: winnerScores.length ? Math.max.apply(null, winnerScores) : 0,
    // 公開
    revealsPerGame: r2(totalReveals / Math.max(1, games)), avgRevealScore: r2(revealScoreSum / Math.max(1, totalReveals)),
    zeroRevealRate: pct(zeroReveals, totalReveals), nDist: nDist, totalReveals: totalReveals, wangekiReveals: wangekiReveals,
    // ワン！
    declRate: pct(declSum, totalReveals), hitRate: pct(hitSum, declSum), wanNet: wanNet,
    // 移動
    moveTokenUseRate: pct(tokenExhaustedPlayers, totalPlayerSlots), // トークン使い切ったプレイヤー割合
    totalMoves: totalMoves,
    movedRevealAvg: r2(movedRevealScore / Math.max(1, movedReveals)),
    unmovedRevealAvg: r2(unmovedRevealScore / Math.max(1, unmovedReveals)),
    movedReveals: movedReveals, unmovedReveals: unmovedReveals,
    // 特殊
    spUseRate: {
      amaenbo: pct(spUse.amaenbo, totalReveals), yancha: pct(spUse.yancha, totalReveals), ohirune: pct(spUse.ohirune, totalReveals),
    },
    spAvgInc: {
      amaenbo: r2(spInc.amaenbo / Math.max(1, spUse.amaenbo)), yancha: r2(spInc.yancha / Math.max(1, spUse.yancha)), ohirune: r2(spInc.ohirune / Math.max(1, spUse.ohirune)),
    },
    // 手番順
    starterWinRate: pct(starterWins, decided),
  };
}

function printReport(r) {
  const L = console.log;
  L("=== " + r.cond + " (games=" + r.games + ") ===");
  L("[試合長] rounds mean/median/max = " + r.roundsMean + " / " + r.roundsMedian + " / " + r.roundsMax +
    " | turns mean = " + r.turnsMean + " | stalled = " + r.stalledRate + "%");
  L("[決着] 150pts " + r.win150Rate + "% / wangeki " + r.wangekiRate + "% / draw " + r.drawRate + "% / stalled " + r.stalledRate +
    "% | 勝者得点 mean/median/max = " + r.winnerScoreMean + " / " + r.winnerScoreMedian + " / " + r.winnerScoreMax);
  L("[公開] /game " + r.revealsPerGame + " | 平均得点 " + r.avgRevealScore + " | 0点以下率 " + r.zeroRevealRate + "% (計" + r.totalReveals + "公開)");
  L("       n分布(0..12): " + Array.from({ length: 13 }, function (_, k) { return r.nDist[k]; }).join(","));
  L("[ワン!] 宣言率 " + r.declRate + "%/公開 | 的中率 " + r.hitRate + "% | 純増減 " + r.wanNet);
  L("[移動] トークン使い切り率 " + r.moveTokenUseRate + "% | 総移動 " + r.totalMoves +
    " | move有公開avg " + r.movedRevealAvg + "(" + r.movedReveals + ") vs move無 " + r.unmovedRevealAvg + "(" + r.unmovedReveals + ")");
  L("[特殊] 使用率 甘" + r.spUseRate.amaenbo + "%/や" + r.spUseRate.yancha + "%/昼" + r.spUseRate.ohirune + "% | " +
    "得点増分 甘" + r.spAvgInc.amaenbo + "/や" + r.spAvgInc.yancha + "/昼" + r.spAvgInc.ohirune);
  L("[手番順] 先手(seat0)勝率 " + r.starterWinRate + "%");
  L("");
}

// 難易度混在マッチアップ: diffs 配列で各席の難易度を指定し、勝率を難易度別に集計。
// 席順バイアスを打ち消すため、各試合で難易度割り当てを座席方向へローテーションする。
function runMatchup(games, diffs, seed, maxRounds) {
  const players = diffs.length;
  const winsByDiff = {}, gamesByDiff = {};
  diffs.forEach(function (d) { winsByDiff[d] = winsByDiff[d] || 0; gamesByDiff[d] = gamesByDiff[d] || 0; });
  let decided = 0, stalled = 0;
  for (let g = 0; g < games; g++) {
    const rot = g % players; // 席ローテーション
    const seatDiff = [];
    for (let s = 0; s < players; s++) seatDiff.push(diffs[(s + rot) % players]);
    const rec = playGame(gameSeed(seed, g), players, seatDiff, maxRounds);
    for (let s = 0; s < players; s++) gamesByDiff[seatDiff[s]] += 1;
    if (rec.stalled) { stalled += 1; continue; }
    if (typeof rec.winner === "number") { decided += 1; winsByDiff[seatDiff[rec.winner]] += 1; }
    else if (rec.winner === "draw") { decided += 1; }
  }
  // 各難易度の勝率（= wins / (そのdiffが割り当てられた延べ試合数/1席あたり)）
  // 2者対戦なら gamesByDiff[d] = games（毎試合1席）なので winsByDiff/games が素直な勝率。
  const out = { players: players, games: games, stalled: stalled, decided: decided, byDiff: {} };
  Object.keys(winsByDiff).forEach(function (d) {
    const gd = gamesByDiff[d];
    out.byDiff[d] = { wins: winsByDiff[d], games: gd, winRate: pct(winsByDiff[d], gd) };
  });
  return out;
}

function main() {
  const a = parseArgs(process.argv);
  // マッチアップモード: --matchup=hard,normal（各席の難易度・カンマ区切り）
  const mArg = process.argv.slice(2).find(function (s) { return s.indexOf("--matchup=") === 0; });
  if (mArg) {
    const diffs = mArg.split("=")[1].split(",").map(function (s) { return s.trim(); });
    const r = runMatchup(a.games, diffs, a.seed, a.maxRounds);
    if (a.json) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log("=== matchup [" + diffs.join(" vs ") + "] " + r.players + "人 games=" + r.games +
      " (stalled " + r.stalled + " / decided " + r.decided + ") ===");
    Object.keys(r.byDiff).forEach(function (d) {
      console.log("  " + d + ": 勝率 " + r.byDiff[d].winRate + "% (" + r.byDiff[d].wins + "/" + r.byDiff[d].games + ")");
    });
    return;
  }
  // スイープモード: normal AI・2人と4人で 8条件（ベースライン + 個別ルール変更）を計測
  if (a.sweep) {
    const D = defaultRules;
    const specs = [
      { tag: "0 baseline", rules: D() },
      { tag: "1 target=100", rules: Object.assign(D(), { target: 100 }) },
      { tag: "2 target=75", rules: Object.assign(D(), { target: 75 }) },
      { tag: "3 target=50", rules: Object.assign(D(), { target: 50 }) },
      { tag: "4 forbidZeroReveal", rules: Object.assign(D(), { forbidZeroReveal: true }) },
      { tag: "5 moveTokens=3", rules: Object.assign(D(), { moveTokens: 3 }) },
      { tag: "6 napBoost", rules: Object.assign(D(), { napBoost: true }) },
      { tag: "7 wanReward=8", rules: Object.assign(D(), { wanReward: 8, wanPenalty: 5 }) },
    ];
    const players = [2, 4];
    const out = [];
    specs.forEach(function (sp) {
      players.forEach(function (pc) {
        const r = runCondition(a.games, pc, "normal", a.seed, a.maxRounds, sp.rules);
        r.sweepTag = sp.tag; r.players = pc;
        out.push(r);
        if (!a.json) { console.log("### sweep " + sp.tag + " / " + pc + "人 ###"); printReport(r); }
      });
    });
    if (a.json) console.log(JSON.stringify(out, null, 2));
    return;
  }
  const conds = a.all
    ? [2, 3, 4].reduce(function (acc, p) { return acc.concat(["easy", "normal", "hard"].map(function (d) { return { p: p, d: d }; })); }, [])
    : [{ p: a.players, d: a.difficulty }];
  const results = [];
  conds.forEach(function (c) {
    const r = runCondition(a.games, c.p, c.d, a.seed, a.maxRounds, a.rules);
    results.push(r);
    if (!a.json) printReport(r);
  });
  if (a.json) console.log(JSON.stringify(results, null, 2));
}

main();
