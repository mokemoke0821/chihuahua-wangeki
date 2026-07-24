"""core.py — 「チワワでワン撃」ゲームロジック（core.js の Python移植・権威サーバー用）.

core.js(v0.2.0) と挙動一致。state は不変更新（dict）。mulberry32 は 32bit演算を
bit完全一致で移植し、同一 seed で JS版と山札順が一致する（クロス言語決定論）。
API: new_game / legal_actions / apply_action / score_row / view_for
"""
from __future__ import annotations

import copy
import math
from typing import Any, Callable, Dict, List, Optional

U32 = 0xFFFFFFFF


def _imul(x: int, y: int) -> int:
    """Math.imul 相当: 32bit整数積の下位32bit（bitパターン）."""
    return ((x & U32) * (y & U32)) & U32


def mulberry32(seed: int) -> Callable[[], float]:
    """決定論PRNG（JS版とbit一致）。0..1 の float を返す."""
    a = seed & U32

    def rng() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & U32
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & U32) ^ t
        t &= U32
        return ((t ^ (t >> 14)) & U32) / 4294967296

    return rng


def build_deck() -> List[Dict[str, Any]]:
    deck: List[Dict[str, Any]] = []
    for v in range(1, 13):
        deck.append({"t": "butt", "v": v})
        deck.append({"t": "butt", "v": v})
    deck.append({"t": "special", "s": "amaenbo"})
    deck.append({"t": "special", "s": "yancha"})
    deck.append({"t": "special", "s": "ohirune"})
    return deck


def shuffle(deck: List[Dict[str, Any]], rng: Callable[[], float]) -> List[Dict[str, Any]]:
    a = list(deck)
    for i in range(len(a) - 1, 0, -1):
        j = math.floor(rng() * (i + 1))
        a[i], a[j] = a[j], a[i]
    return a


def clone(state: Dict[str, Any]) -> Dict[str, Any]:
    return copy.deepcopy(state)


def new_game(seed: int, player_count: int) -> Dict[str, Any]:
    pc = max(2, min(4, int(player_count)))
    rng = mulberry32((seed & U32) or 1)
    deck = shuffle(build_deck(), rng)
    players = []
    for _ in range(pc):
        hand = deck[:4]
        deck = deck[4:]
        players.append({"hand": hand, "tokens": 2, "score": 0})
    return {
        "seed": seed & U32,
        "playerCount": pc,
        "deck": deck,
        "discard": [],
        "players": players,
        "row": [],
        "cardSeq": 0,
        "current": 0,
        "starter": 0,
        "phase": "play",
        "finished": False,
        "winner": None,
        "lastReveal": None,
        "history": [],
    }


def _refill(s: Dict[str, Any]) -> None:
    hand = s["players"][s["current"]]["hand"]
    while len(hand) < 4:
        if not s["deck"]:
            if not s["discard"]:
                break
            rng = mulberry32(((s["seed"] & U32) + len(s["discard"]) * 2654435761) & U32)
            s["deck"] = shuffle(s["discard"], rng)
            s["discard"] = []
        hand.append(s["deck"].pop(0))


def legal_actions(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    if state["finished"]:
        return []
    me = state["players"][state["current"]]
    actions: List[Dict[str, Any]] = []
    for i, c in enumerate(me["hand"]):
        if c["t"] == "butt":
            actions.append({"type": "play", "cardIndex": i})
    actions.append({"type": "reveal"})
    if me["tokens"] > 0 and len(state["row"]) >= 1:
        actions.append({"type": "move"})
    return actions


def score_row(row: List[Any], special: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    # ルール(v0.4.1): 連番は「値1のカードを起点」として右へ 1,2,3,... と続く分のみ得点対象。
    # 1の位置は場のどこでもよく、起点より左は無視。1が無ければ0点。1が複数なら total 最大の起点を採用。
    # JS版 core.js scoreRow とクロス言語一致（同一ロジック）。
    special = special or None
    vals = [c if isinstance(c, int) else c["v"] for c in row]

    def scan_from(start: int) -> Dict[str, Any]:
        expected = 1
        i = start
        occ: Dict[int, int] = {}
        consumed: List[int] = []  # 得点対象になった実カードの元インデックス（UIハイライト用）
        amae_used = False
        yancha_used = False
        yancha_missing = 0

        def bump(v: int) -> None:
            occ[v] = occ.get(v, 0) + 1

        while i < len(vals):
            c = vals[i]
            if c == expected:
                bump(c)
                consumed.append(i)
                expected += 1
                i += 1
            elif c == expected - 1 and expected > 1:
                bump(c)
                consumed.append(i)
                i += 1
            elif (special and special.get("type") == "amaenbo" and not amae_used
                  and special.get("number") == expected):
                bump(expected)
                amae_used = True
                expected += 1
            elif (special and special.get("type") == "yancha" and not yancha_used
                  and c > expected):
                yancha_used = True
                yancha_missing = expected
                expected += 1
            else:
                break

        # 末端補完（甘えん坊で連番末尾の次を埋める）
        if (special and special.get("type") == "amaenbo" and not amae_used
                and special.get("number") == expected):
            bump(expected)
            amae_used = True
            expected += 1

        n = expected - 1
        base = (n * (n + 1)) // 2
        if yancha_used:
            base -= yancha_missing

        wangeki = False
        if n == 12:
            if not special:
                wangeki = True
            else:
                base = 66  # 特殊到達の12は基礎点66（ワン撃不成立）・重複ペナ通常適用

        penalty = 0
        for k, cnt in occ.items():
            if cnt >= 2:
                penalty += k * cnt
        if special and special.get("type") == "ohirune":
            penalty = 0

        total = base - penalty
        return {
            "n": n, "base": base, "penalty": penalty, "total": total, "wangeki": wangeki,
            "startIndex": consumed[0] if consumed else -1,
            "scoredIndices": consumed,
        }

    # 起点候補: 値1の位置。特殊使用時は任意位置も候補（甘えん坊/やんちゃが1を補いうる現行as-built維持）。
    starts: List[int] = [j for j, v in enumerate(vals) if v == 1]
    if special:
        starts += list(range(len(vals)))
        if len(vals) == 0:
            starts.append(0)
    if not starts:
        return {"n": 0, "base": 0, "penalty": 0, "total": 0, "wangeki": False,
                "startIndex": -1, "scoredIndices": []}

    best: Optional[Dict[str, Any]] = None
    for st in starts:
        r = scan_from(st)
        if best is None or r["total"] > best["total"] or (r["total"] == best["total"] and r["n"] > best["n"]):
            best = r
    return best


def settle_wan(declarations: Optional[List[Dict[str, Any]]], n: int) -> Dict[int, int]:
    deltas: Dict[int, int] = {}
    for d in (declarations or []):
        deltas[d["player"]] = deltas.get(d["player"], 0) + (5 if d["value"] == n else -5)
    return deltas


def _advance(s: Dict[str, Any]) -> None:
    s["current"] = (s["current"] + 1) % s["playerCount"]


def check_victory(s: Dict[str, Any]):
    mx = max((p["score"] for p in s["players"]), default=-1)
    if mx < 150:
        return None
    leaders = [i for i, p in enumerate(s["players"]) if p["score"] == mx]
    return leaders[0] if len(leaders) == 1 else "draw"


def _do_reveal(s, revealer, declarations, special, events, forced):
    row_vals = [c["v"] for c in s["row"]]
    row_cards = [{"v": c["v"], "placedBy": c["placedBy"], "id": c["id"]} for c in s["row"]]
    res = score_row(s["row"], special)
    events.append({"type": "revealed", "revealer": revealer, "row": row_vals,
                   "rowCards": row_cards, "forced": forced})
    s["history"].append({
        "type": "reveal", "revealer": revealer, "rowCards": row_cards, "forced": forced,
        "result": {"n": res["n"], "base": res["base"], "penalty": res["penalty"],
                   "total": res["total"], "wangeki": res["wangeki"]},
        "special": special["type"] if special else None,
    })

    if special and special.get("type"):
        rp = s["players"][revealer]
        idx = next((k for k, c in enumerate(rp["hand"])
                    if c["t"] == "special" and c["s"] == special["type"]), -1)
        if idx >= 0:
            used = rp["hand"].pop(idx)
            s["discard"].append(used)
            events.append({"type": "specialUsed", "player": revealer, "special": special["type"]})
        else:
            events.append({"type": "warning",
                           "message": "revealer lacks special " + special["type"]})

    s["players"][revealer]["score"] += res["total"]
    events.append({"type": "score", "player": revealer, "delta": res["total"], "detail": res})

    valid = [d for d in (declarations or [])
             if isinstance(d.get("player"), int) and 0 <= d["player"] < len(s["players"])
             and isinstance(d.get("value"), int) and 1 <= d["value"] <= 12]
    for pi, delta in settle_wan(valid, res["n"]).items():
        s["players"][pi]["score"] += delta
        events.append({"type": "wan", "player": pi, "delta": delta, "declaredMatch": delta > 0})

    for c in s["row"]:
        s["discard"].append(c)
    s["row"] = []
    s["lastReveal"] = {"revealer": revealer, "result": res, "declarations": declarations or []}
    s["starter"] = revealer
    s["current"] = revealer
    _refill(s)

    if res["wangeki"]:
        s["finished"] = True
        s["winner"] = revealer
        events.append({"type": "gameover", "winner": revealer, "reason": "wangeki"})
        return {"state": s, "events": events}
    win = check_victory(s)
    if win is not None:
        s["finished"] = True
        s["winner"] = win
        events.append({"type": "gameover", "winner": win, "reason": "150pts"})
    return {"state": s, "events": events}


def apply_action(state: Dict[str, Any], action: Dict[str, Any]) -> Dict[str, Any]:
    if state["finished"]:
        return {"state": state, "events": [{"type": "error", "message": "game over"}]}
    legal = legal_actions(state)
    if not any(a["type"] == action.get("type") for a in legal):
        return {"state": state,
                "events": [{"type": "error", "message": "illegal action: " + str(action.get("type"))}]}

    s = clone(state)
    events: List[Dict[str, Any]] = []
    cur = s["current"]

    if action["type"] == "play":
        me = s["players"][cur]
        ci = action.get("cardIndex")
        card = me["hand"][ci] if isinstance(ci, int) and 0 <= ci < len(me["hand"]) else None
        if not card or card["t"] != "butt":
            return {"state": state, "events": [{"type": "error", "message": "cannot play this card"}]}
        me["hand"].pop(ci)
        cid = s["cardSeq"]
        s["cardSeq"] += 1
        s["row"].append({"t": "butt", "v": card["v"], "placedBy": cur, "id": cid, "faceDown": True})
        pos = len(s["row"]) - 1
        s["history"].append({"type": "play", "player": cur, "pos": pos, "id": cid})
        events.append({"type": "played", "player": cur, "pos": pos, "id": cid})
        if len(s["row"]) >= 12:
            events.append({"type": "forcedReveal", "player": cur})
            return _do_reveal(s, cur, action.get("declarations") or [],
                              action.get("special"), events, True)
        _refill(s)
        events.append({"type": "refilled", "player": cur, "handSize": len(me["hand"])})
        _advance(s)
        return {"state": s, "events": events}

    if action["type"] == "move":
        me = s["players"][cur]
        frm = int(action.get("from", 0))
        to = int(action.get("to", 0))
        if me["tokens"] <= 0:
            return {"state": state, "events": [{"type": "error", "message": "no move token"}]}
        if frm < 0 or frm >= len(s["row"]) or to < 0 or to >= len(s["row"]):
            return {"state": state, "events": [{"type": "error", "message": "move index out of range"}]}
        card = s["row"].pop(frm)
        s["row"].insert(to, card)
        me["tokens"] -= 1
        s["history"].append({"type": "move", "player": cur, "from": frm, "to": to, "id": card["id"]})
        events.append({"type": "moved", "player": cur, "from": frm, "to": to,
                       "id": card["id"], "tokensLeft": me["tokens"]})
        _refill(s)
        _advance(s)
        return {"state": s, "events": events}

    if action["type"] == "reveal":
        return _do_reveal(s, cur, action.get("declarations") or [], action.get("special"), events, False)

    return {"state": state, "events": [{"type": "error", "message": "unknown action"}]}


def view_for(state: Dict[str, Any], player_index: int) -> Dict[str, Any]:
    """視点別ビュー: 自分が置いたカードの値のみ可視。他人は placedBy+位置のみ(v=None)。
    他人の手札は枚数のみ。捨て札・履歴・得点は公開。値の隠蔽をサーバーで構造保証する."""
    s = state

    def disc(c):
        return {"t": "butt", "v": c["v"]} if c["t"] == "butt" else {"t": "special", "s": c["s"]}

    row = []
    for i, c in enumerate(s["row"]):
        own = c["placedBy"] == player_index
        row.append({"pos": i, "placedBy": c["placedBy"], "id": c["id"],
                    "faceDown": True, "v": c["v"] if own else None})
    players = []
    for i, p in enumerate(s["players"]):
        if i == player_index:
            players.append({"index": i, "score": p["score"], "tokens": p["tokens"],
                            "hand": list(p["hand"]), "handCount": len(p["hand"]), "you": True})
        else:
            players.append({"index": i, "score": p["score"], "tokens": p["tokens"],
                            "handCount": len(p["hand"]), "you": False})
    return {
        "playerCount": s["playerCount"],
        "current": s["current"],
        "starter": s["starter"],
        "finished": s["finished"],
        "winner": s["winner"],
        "deckCount": len(s["deck"]),
        "discardCount": len(s["discard"]),
        "discard": [disc(c) for c in s["discard"]],
        "row": row,
        "players": players,
        "history": list(s["history"]),
        "lastReveal": s["lastReveal"],
        "viewer": player_index,
    }
