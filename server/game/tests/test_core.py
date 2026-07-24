"""test_core.py — core.py 単体テスト（core.test.js の全ベクタ移植 + クロス言語 + payload隠蔽）.

`python manage.py test game` で実行（Django標準テストランナー）。
"""
import json
import unittest

from game import core


class ScoreRowTest(unittest.TestCase):
    def test_1_2_2_3_4(self):
        self.assertEqual(core.score_row([1, 2, 2, 3, 4])["total"], 6)

    def test_1to5_dup5_78(self):
        self.assertEqual(core.score_row([1, 2, 3, 4, 5, 5, 7, 8, 8])["total"], 5)

    def test_no_start_one(self):
        r = core.score_row([2, 3, 4])
        self.assertEqual(r["total"], 0)
        self.assertEqual(r["n"], 0)

    def test_wangeki(self):
        r = core.score_row(list(range(1, 13)))
        self.assertTrue(r["wangeki"])
        self.assertEqual(r["n"], 12)

    def test_yancha(self):
        self.assertEqual(core.score_row([1, 2, 4, 5], {"type": "yancha"})["total"], 12)

    def test_amaenbo(self):
        self.assertEqual(core.score_row([1, 2, 4, 5], {"type": "amaenbo", "number": 3})["total"], 15)

    def test_ohirune(self):
        self.assertEqual(core.score_row([1, 2, 2, 3])["total"], 2)
        self.assertEqual(core.score_row([1, 2, 2, 3], {"type": "ohirune"})["total"], 6)

    def test_amaenbo_12_66(self):
        r = core.score_row(list(range(1, 12)), {"type": "amaenbo", "number": 12})
        self.assertEqual(r["total"], 66)
        self.assertFalse(r["wangeki"])

    def test_special_12_dup_62(self):
        # v0.2.0 厳密化: 基礎点66 + 重複ペナ通常適用（[1,2,2,3..11]+甘12 → 66-4=62）
        row = [1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
        r = core.score_row(row, {"type": "amaenbo", "number": 12})
        self.assertEqual(r["n"], 12)
        self.assertEqual(r["base"], 66)
        self.assertEqual(r["penalty"], 4)
        self.assertEqual(r["total"], 62)
        self.assertFalse(r["wangeki"])

    def test_settle_wan(self):
        d = core.settle_wan([{"player": 0, "value": 5}, {"player": 1, "value": 4}], 5)
        self.assertEqual(d[0], 5)
        self.assertEqual(d[1], -5)


class GameFlowTest(unittest.TestCase):
    def test_deterministic_deck(self):
        a = core.new_game(12345, 2)
        b = core.new_game(12345, 2)
        self.assertEqual(a["deck"], b["deck"])
        self.assertEqual(a["players"], b["players"])

    def test_move_token_zero(self):
        s = core.new_game(7, 2)
        play = next(a for a in core.legal_actions(s) if a["type"] == "play")
        s = core.apply_action(s, play)["state"]
        s["players"][s["current"]]["tokens"] = 0
        acts = core.legal_actions(s)
        self.assertTrue(len(s["row"]) >= 1)
        self.assertFalse(any(a["type"] == "move" for a in acts))
        s["players"][s["current"]]["tokens"] = 2
        self.assertTrue(any(a["type"] == "move" for a in core.legal_actions(s)))

    def test_forced_reveal(self):
        s = core.new_game(999, 2)
        s["row"] = [{"t": "butt", "v": (k % 12) + 1, "placedBy": 0, "id": k} for k in range(11)]
        s["cardSeq"] = 11
        s["players"][s["current"]]["hand"][0] = {"t": "butt", "v": 12}
        res = core.apply_action(s, {"type": "play", "cardIndex": 0})
        self.assertTrue(any(e["type"] == "forcedReveal" for e in res["events"]))
        self.assertTrue(any(e["type"] == "revealed" for e in res["events"]))

    def test_immutable(self):
        s = core.new_game(42, 3)
        before = json.loads(json.dumps(s))
        play = next(a for a in core.legal_actions(s) if a["type"] == "play")
        core.apply_action(s, play)
        self.assertEqual(s, before)


class ViewForTest(unittest.TestCase):
    def test_visibility(self):
        s = core.new_game(321, 2)
        play = next(a for a in core.legal_actions(s) if a["type"] == "play")
        played_v = s["players"][0]["hand"][play["cardIndex"]]["v"]
        s = core.apply_action(s, play)["state"]
        v0 = core.view_for(s, 0)
        v1 = core.view_for(s, 1)
        self.assertEqual(v0["row"][0]["v"], played_v)
        self.assertEqual(v0["row"][0]["placedBy"], 0)
        self.assertIsNone(v1["row"][0]["v"])
        self.assertEqual(v1["row"][0]["placedBy"], 0)
        self.assertNotIn("hand", v0["players"][1])
        self.assertIn("hand", v0["players"][0])
        self.assertIsInstance(v0["players"][1]["handCount"], int)

    def test_move_owner_visibility(self):
        s = core.new_game(654, 2)
        s = core.apply_action(s, next(a for a in core.legal_actions(s) if a["type"] == "play"))["state"]
        s = core.apply_action(s, next(a for a in core.legal_actions(s) if a["type"] == "play"))["state"]
        before_v = core.view_for(s, 0)["row"][0]["v"]
        self.assertIsInstance(before_v, int)
        s = core.apply_action(s, {"type": "move", "from": 0, "to": 1})["state"]
        mine = [c for c in core.view_for(s, 0)["row"] if c["placedBy"] == 0]
        self.assertTrue(any(c["v"] == before_v for c in mine))

    def test_history_no_leak(self):
        s = core.new_game(777, 2)
        s = core.apply_action(s, next(a for a in core.legal_actions(s) if a["type"] == "play"))["state"]
        play = next(h for h in s["history"] if h["type"] == "play")
        self.assertNotIn("v", play)
        self.assertNotIn("value", play)
        self.assertIn("pos", play)

    def test_payload_hides_others_values(self):
        # 権威サーバーの核: 配信payload(view_for JSON)に他人のカード値が載らない
        s = core.new_game(2024, 2)
        # P0 が butt を1枚プレイ
        play = next(a for a in core.legal_actions(s) if a["type"] == "play")
        s = core.apply_action(s, play)["state"]
        # P1視点のpayloadに P0の置いたカードの値が含まれないこと
        payload = json.dumps(core.view_for(s, 1), ensure_ascii=False)
        parsed = json.loads(payload)
        self.assertIsNone(parsed["row"][0]["v"])  # P0のカードは値null
        # P1のhand配列は含むが、P0のhandは含まない（枚数のみ）
        self.assertNotIn("hand", parsed["players"][0])


class CrossLanguageTest(unittest.TestCase):
    # JS版 node -e ダンプで得た seed 12345 の山札順（手札+deck・butt=数字/特殊=頭文字大文字）
    JS_DECK_12345 = "6,1,11,12,5,9,3,A,4,2,3,2,5,9,7,12,11,8,10,8,1,Y,6,10,7,4,O"

    def test_deck_matches_js(self):
        s = core.new_game(12345, 2)
        deck = [c for p in s["players"] for c in p["hand"]] + s["deck"]
        out = [str(c["v"]) if c["t"] == "butt" else c["s"][0].upper() for c in deck]
        self.assertEqual(",".join(out), self.JS_DECK_12345)


if __name__ == "__main__":
    unittest.main()
