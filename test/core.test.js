// test/core.test.js — 依存パッケージなし・assertのみ。 `node test/core.test.js` で実行。
const assert = require("assert");
const GC = require("../core.js");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + "  -> " + e.message);
  }
}

console.log("== scoreRow ==");

t("scoreRow([1,2,2,3,4]) total 6", function () {
  const r = GC.scoreRow([1, 2, 2, 3, 4]);
  assert.strictEqual(r.total, 6, "total=" + r.total + " n=" + r.n + " base=" + r.base + " pen=" + r.penalty);
});

t("scoreRow([1,2,3,4,5,5,7,8,8]) total 5", function () {
  const r = GC.scoreRow([1, 2, 3, 4, 5, 5, 7, 8, 8]);
  assert.strictEqual(r.total, 5, "total=" + r.total + " n=" + r.n);
});

t("scoreRow([2,3,4]) total 0", function () {
  const r = GC.scoreRow([2, 3, 4]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.n, 0);
});

t("scoreRow([1..12]) wangeki true", function () {
  const row = [];
  for (let v = 1; v <= 12; v++) row.push(v);
  const r = GC.scoreRow(row);
  assert.strictEqual(r.wangeki, true, "wangeki=" + r.wangeki + " n=" + r.n);
  assert.strictEqual(r.n, 12);
});

t("scoreRow([1,2,4,5], やんちゃ) total 12", function () {
  const r = GC.scoreRow([1, 2, 4, 5], { type: "yancha" });
  assert.strictEqual(r.total, 12, "total=" + r.total + " n=" + r.n + " base=" + r.base);
});

t("scoreRow([1,2,4,5], 甘えん坊=3) total 15", function () {
  const r = GC.scoreRow([1, 2, 4, 5], { type: "amaenbo", number: 3 });
  assert.strictEqual(r.total, 15, "total=" + r.total + " n=" + r.n);
});

t("scoreRow([1,2,2,3], お昼寝) total 6 (不使用時2)", function () {
  const noNap = GC.scoreRow([1, 2, 2, 3]);
  assert.strictEqual(noNap.total, 2, "noNap total=" + noNap.total);
  const nap = GC.scoreRow([1, 2, 2, 3], { type: "ohirune" });
  assert.strictEqual(nap.total, 6, "nap total=" + nap.total);
});

t("1..11 + 甘えん坊=12補完 → total 66 / wangeki false", function () {
  const row = [];
  for (let v = 1; v <= 11; v++) row.push(v);
  const r = GC.scoreRow(row, { type: "amaenbo", number: 12 });
  assert.strictEqual(r.total, 66, "total=" + r.total + " n=" + r.n);
  assert.strictEqual(r.wangeki, false);
});

t("ワン！精算: 宣言=最終n → +5 / 不一致 → -5", function () {
  const d = GC.settleWan([{ player: 0, value: 5 }, { player: 1, value: 4 }], 5);
  assert.strictEqual(d[0], 5, "p0 delta=" + d[0]);
  assert.strictEqual(d[1], -5, "p1 delta=" + d[1]);
});

console.log("== newGame / actions ==");

t("newGame(同一seed) 2回で山札順一致（決定性）", function () {
  const a = GC.newGame(12345, 2);
  const b = GC.newGame(12345, 2);
  assert.deepStrictEqual(a.deck, b.deck, "deck mismatch");
  assert.deepStrictEqual(a.players, b.players, "players mismatch");
});

t("移動トークン0で move が legalActions に含まれない", function () {
  const s = GC.newGame(7, 2);
  // 場に1枚置く（moveの前提row>=1を満たす）
  const play = GC.legalActions(s).find(function (a) {
    return a.type === "play";
  });
  const r1 = GC.applyAction(s, play);
  let st = r1.state;
  // 現プレイヤーのトークンを0に（テスト用に直接操作＝APIの境界確認）
  st = JSON.parse(JSON.stringify(st));
  st.players[st.current].tokens = 0;
  const acts = GC.legalActions(st);
  assert.ok(st.row.length >= 1, "row should have a card");
  assert.ok(!acts.some(function (a) { return a.type === "move"; }), "move must be absent when tokens=0");
  // トークンありなら含まれる（対照）
  st.players[st.current].tokens = 2;
  const acts2 = GC.legalActions(st);
  assert.ok(acts2.some(function (a) { return a.type === "move"; }), "move must be present when tokens>0 and row>=1");
});

t("12枚目プレイで forcedReveal event が発生する", function () {
  // 場を11枚まで butt で埋め、12枚目をプレイ
  let s = GC.newGame(999, 2);
  s = JSON.parse(JSON.stringify(s));
  s.row = [];
  for (let k = 0; k < 11; k++) s.row.push({ t: "butt", v: ((k % 12) + 1) });
  // 現プレイヤーの手札先頭を butt に保証
  s.players[s.current].hand[0] = { t: "butt", v: 12 };
  const res = GC.applyAction(s, { type: "play", cardIndex: 0 });
  assert.ok(res.events.some(function (e) { return e.type === "forcedReveal"; }), "forcedReveal expected");
  assert.ok(res.events.some(function (e) { return e.type === "revealed"; }), "revealed expected");
});

t("applyAction は state を不変更新（元stateを破壊しない）", function () {
  const s = GC.newGame(42, 3);
  const before = JSON.parse(JSON.stringify(s));
  const play = GC.legalActions(s).find(function (a) { return a.type === "play"; });
  GC.applyAction(s, play);
  assert.deepStrictEqual(s, before, "original state must be unchanged");
});

t("legalActions: 手番プレイヤーの butt 枚数ぶん play がある", function () {
  const s = GC.newGame(5, 2);
  const buttCount = s.players[s.current].hand.filter(function (c) { return c.t === "butt"; }).length;
  const playCount = GC.legalActions(s).filter(function (a) { return a.type === "play"; }).length;
  assert.strictEqual(playCount, buttCount);
});

console.log("== v0.2.0 viewFor / history / n=12厳密化 ==");

t("特殊n=12+重複 → 66-ペナルティ ([1,2,2,3..11]+甘えん坊12 → 62)", function () {
  // 1公開1枚のため甘えん坊とお昼寝は同時使用不可＝お昼寝でのペナ消しは対象外
  const row = [1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const r = GC.scoreRow(row, { type: "amaenbo", number: 12 });
  assert.strictEqual(r.n, 12, "n=" + r.n);
  assert.strictEqual(r.base, 66, "base=" + r.base);
  assert.strictEqual(r.penalty, 4, "penalty=" + r.penalty); // 数字2が2枚 → 2×2=4
  assert.strictEqual(r.total, 62, "total=" + r.total);
  assert.strictEqual(r.wangeki, false);
});

t("viewFor: 自分の置いたカードは値可視 / 他人は値null / 他人手札は枚数のみ", function () {
  let s = GC.newGame(321, 2);
  // P0(current) が butt を1枚プレイ
  const play = GC.legalActions(s).find(function (a) { return a.type === "play"; });
  const playedV = s.players[0].hand[play.cardIndex].v;
  s = GC.applyAction(s, play).state; // 場に1枚（placedBy=0）
  const v0 = GC.viewFor(s, 0);
  const v1 = GC.viewFor(s, 1);
  assert.strictEqual(v0.row[0].v, playedV, "配置者P0には値が見える");
  assert.strictEqual(v0.row[0].placedBy, 0);
  assert.strictEqual(v1.row[0].v, null, "非配置者P1には値null");
  assert.strictEqual(v1.row[0].placedBy, 0, "配置者情報は公開");
  // 他人の手札は枚数のみ（hand配列なし）
  assert.ok(v0.players[1].hand === undefined, "他人のhand配列は見えない");
  assert.strictEqual(typeof v0.players[1].handCount, "number");
  assert.ok(Array.isArray(v0.players[0].hand), "自分のhandは見える");
});

t("移動後も配置者の値可視が維持される", function () {
  let s = GC.newGame(654, 2);
  // P0 が1枚プレイ → P1 が1枚プレイ → P0手番で移動
  s = GC.applyAction(s, GC.legalActions(s).find(function (a) { return a.type === "play"; })).state;
  s = GC.applyAction(s, GC.legalActions(s).find(function (a) { return a.type === "play"; })).state;
  // 現在 P0手番。P0が置いたカード(pos0, placedBy0)の値を控える
  const beforeV = GC.viewFor(s, 0).row[0].v;
  assert.strictEqual(typeof beforeV, "number", "移動前 配置者に値可視");
  // pos0 を pos1 へ移動
  const r = GC.applyAction(s, { type: "move", from: 0, to: 1 });
  s = r.state;
  const view = GC.viewFor(s, 0);
  // 移動先で自分の配置カードを探す（placedBy===0 の値が取れる）
  const mine = view.row.filter(function (c) { return c.placedBy === 0; });
  assert.ok(mine.some(function (c) { return c.v === beforeV; }), "移動後も配置者に同じ値が可視");
});

t("history: プレイ/移動が公開情報のみ（裏向きの値が漏れない）", function () {
  let s = GC.newGame(777, 2);
  s = GC.applyAction(s, GC.legalActions(s).find(function (a) { return a.type === "play"; })).state;
  const hist = s.history;
  assert.ok(hist.length >= 1, "history記録あり");
  const play = hist.find(function (h) { return h.type === "play"; });
  assert.ok(play, "playエントリ");
  assert.ok(!("v" in play) && !("value" in play), "playの値は履歴に漏れない");
  assert.ok(typeof play.pos === "number" && typeof play.player === "number", "位置と配置者は公開");
});

t("history: 公開後は値が公開情報として記録される", function () {
  let s = GC.newGame(888, 2);
  s = GC.applyAction(s, GC.legalActions(s).find(function (a) { return a.type === "play"; })).state;
  const r = GC.applyAction(s, { type: "reveal", declarations: [], special: null });
  s = r.state;
  const rev = s.history.find(function (h) { return h.type === "reveal"; });
  assert.ok(rev, "revealエントリ");
  assert.ok(Array.isArray(rev.rowCards) && typeof rev.rowCards[0].v === "number", "公開後は値が公開情報");
  assert.ok(typeof rev.result.total === "number", "得点結果も記録");
});

t("state永続化: JSON round-trip後もapplyAction/viewFor継続可能（DO storage前提）", function () {
  let s = GC.newGame(2024, 2);
  s = GC.applyAction(s, GC.legalActions(s).find((a) => a.type === "play")).state;
  s = GC.applyAction(s, GC.legalActions(s).find((a) => a.type === "play")).state;
  const restored = JSON.parse(JSON.stringify(s)); // 保存→復元相当
  const legal = GC.legalActions(restored);
  assert.ok(legal.length > 0, "復元後にlegalActions");
  const res = GC.applyAction(restored, legal.find((a) => a.type === "play") || legal[0]);
  assert.ok(!res.events.some((e) => e.type === "error"), "復元後applyActionがエラーなく進行");
  const v = GC.viewFor(res.state, 0);
  assert.ok(Array.isArray(v.row) && Array.isArray(v.players), "復元後viewForが機能");
  // 元stateが破壊されていない（不変更新の保持）
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), restored, "元stateは不変");
});

console.log("\n== 結果: " + pass + " PASS / " + fail + " FAIL ==");
process.exit(fail === 0 ? 0 : 1);
