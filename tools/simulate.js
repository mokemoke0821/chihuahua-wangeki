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
  const a = { games: 1000, players: 2, difficulty: "normal", seed: 12345, all: false, json: false, maxRounds: DEFAULT_MAX_ROUNDS };
  argv.slice(2).forEach(function (s) {
    if (s === "--all") { a.all = true; return; }
    if (s === "--json") { a.json = true; return; }
    const m = s.match(/^--([a-zA-Z]+)=(.+)$/);
    if (!m) return;
    const k = m[1], v = m[2];
    if (k === "games" || k === "players" || k === "seed" || k === "maxRounds") a[k] = parseInt(v, 10);
    else if (k === "difficulty") a.difficulty = v;
  });
  return a;
}

// 各試合の seed は base+index から決定論的に導出（再現性のため）。
function gameSeed(base, index) {
  return (((base >>> 0) + (index + 1) * 2654435761) >>> 0) || 1;
}

// 1試合をCPU自己対戦で実行し、計測イベントを返す。
function playGame(seed, players, difficulty, maxRounds) {
  let state = GC.newGame(seed, players);
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
    const legal = GC.legalActions(state);
    const action = AI.chooseAction(GC.viewFor(state, cur), cur, difficulty, seed, legal);

    // 違法手検証（型が legal に含まれるか）
    if (!action || !legal.some(function (a) { return a.type === action.type; })) {
      throw new Error("ILLEGAL ACTION: seed=" + seed + " players=" + players + " diff=" + difficulty +
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
        const d = AI.chooseDeclaration(GC.viewFor(revealState, i), i, difficulty);
        if (d) decls.push(d);
      }
      // 公開者の特殊カード（公開後=表向きの確定row値で最善選択）
      const rowVals = revealState.row.map(function (c) { return c.v; });
      const special = AI.chooseSpecial(rowVals, revealState.players[cur].hand, difficulty);

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

function runCondition(games, players, difficulty, seed, maxRounds) {
  const roundsArr = [], turnsArr = [], winnerScores = [];
  let stalled = 0, win150 = 0, winWangeki = 0, draws = 0, starterWins = 0;
  let totalReveals = 0, zeroReveals = 0, revealScoreSum = 0, wangekiReveals = 0;
  const nDist = {}; for (let k = 0; k <= 12; k++) nDist[k] = 0;
  let declSum = 0, hitSum = 0, wanNet = 0;
  let movedReveals = 0, movedRevealScore = 0, unmovedReveals = 0, unmovedRevealScore = 0;
  const spUse = { amaenbo: 0, yancha: 0, ohirune: 0 };
  const spInc = { amaenbo: 0, yancha: 0, ohirune: 0 };
  let totalMoves = 0, tokenExhaustedPlayers = 0, totalPlayerSlots = 0;

  for (let g = 0; g < games; g++) {
    const rec = playGame(gameSeed(seed, g), players, difficulty, maxRounds);
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

function main() {
  const a = parseArgs(process.argv);
  const conds = a.all
    ? [2, 3, 4].reduce(function (acc, p) { return acc.concat(["easy", "normal", "hard"].map(function (d) { return { p: p, d: d }; })); }, [])
    : [{ p: a.players, d: a.difficulty }];
  const results = [];
  conds.forEach(function (c) {
    const r = runCondition(a.games, c.p, c.d, a.seed, a.maxRounds);
    results.push(r);
    if (!a.json) printReport(r);
  });
  if (a.json) console.log(JSON.stringify(results, null, 2));
}

main();
