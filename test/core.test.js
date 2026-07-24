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

console.log("\n== 結果: " + pass + " PASS / " + fail + " FAIL ==");
process.exit(fail === 0 ? 0 : 1);
