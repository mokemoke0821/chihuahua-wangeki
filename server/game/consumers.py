"""consumers.py — WebSocket権威サーバー。全アクションをサーバー検証、各自に view_for のみ配信.

プロトコル(C→S): create_room / join / start / action(play|reveal|move) /
                 wan_declare(n|null) / special(card,number?) / rematch
        (S→C): room_state / view / wan_phase / special_phase / reveal_result /
               error / player_disconnected / player_reconnected / gameover
"""
import asyncio
import time

from channels.generic.websocket import AsyncJsonWebsocketConsumer
from channels.db import database_sync_to_async
from django.utils import timezone

from . import core
from .rooms import MANAGER, WAN_DEADLINE_SEC, SPECIAL_DEADLINE_SEC, RECONNECT_GRACE_SEC


def _group(code):
    return "room_" + code


class GameConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.code = self.scope["url_route"]["kwargs"]["code"].upper()
        self.token = None
        self.seat = None
        await self.accept()
        # 接続直後は匿名。create_room/join でトークンを得て以降のメッセージで名乗る。
        # クエリに token があれば再接続として復帰。
        qs = (self.scope.get("query_string") or b"").decode()
        token = None
        for part in qs.split("&"):
            if part.startswith("token="):
                token = part[6:]
        if token:
            await self._attach(token)

    async def disconnect(self, close_code):
        room = MANAGER.get(self.code)
        if not room or self.seat is None:
            return
        p = room.by_seat(self.seat)
        if p and p["token"] == self.token:
            p["connected"] = False
            p["disconnect_at"] = time.time()
            p["channel"] = None
        await self._broadcast(room, {"type": "player_disconnected", "seat": self.seat,
                                     "graceSec": RECONNECT_GRACE_SEC})
        if room.phase in ("lobby",):
            await self._push_lobby(room)
        # 60秒猶予後の退室処理
        asyncio.create_task(self._grace_check(self.code, self.seat, self.token))

    async def _grace_check(self, code, seat, token):
        await asyncio.sleep(RECONNECT_GRACE_SEC)
        room = MANAGER.get(code)
        if not room:
            return
        p = room.by_seat(seat)
        if p and p["token"] == token and not p["connected"]:
            # 猶予超過。ロビーなら削除、対戦中は残りメンバーで続行（2人未満なら流局）
            if room.phase == "lobby":
                MANAGER.remove_if_empty(code)
                r2 = MANAGER.get(code)
                if r2:
                    await self._push_lobby(r2)
            elif room.phase in ("play", "wan", "special"):
                if len(room.connected_seats()) < 2:
                    await self._end_abandoned(room)

    # ---- 受信ディスパッチ ----
    async def receive_json(self, data, **kwargs):
        t = data.get("type")
        room = MANAGER.get(self.code)
        try:
            if t == "create_room":
                await self._create(data)
            elif t == "join":
                await self._join(data)
            elif t == "start":
                await self._start(room)
            elif t == "action":
                await self._action(room, data.get("action") or {})
            elif t == "wan_declare":
                await self._wan_declare(room, data.get("value"))
            elif t == "special":
                await self._special(room, data.get("card"), data.get("number"))
            elif t == "rematch":
                await self._rematch(room)
            else:
                await self._err("bad_type", "unknown message type")
        except Exception as e:  # noqa: BLE001 — サーバー保護（クライアントにコードのみ返す）
            await self._err("server_error", str(e))

    async def _attach(self, token):
        room = MANAGER.get(self.code)
        if not room:
            await self._err("no_such_room", "room not found")
            return False
        p = room.by_token(token)
        if not p:
            await self._err("bad_token", "invalid token")
            return False
        reconn = not p["connected"]
        self.token = token
        self.seat = p["seat"]
        p["connected"] = True
        p["disconnect_at"] = None
        p["channel"] = self.channel_name
        await self.channel_layer.group_add(_group(self.code), self.channel_name)
        if reconn:
            await self._broadcast(room, {"type": "player_reconnected", "seat": self.seat})
        await self._push_lobby(room)
        if room.phase in ("play", "wan", "special"):
            await self._push_one_view(room, p)
        return True

    async def _create(self, data):
        room, seat, token = MANAGER.create(data.get("name") or "P1")
        # このConsumerのURL codeを新規roomのcodeへ揃える（クライアントはcode受領後に再接続でもよい）
        self.code = room.code
        self.token = token
        self.seat = seat
        room.by_seat(seat)["channel"] = self.channel_name
        await self.channel_layer.group_add(_group(self.code), self.channel_name)
        await self.send_json({"type": "created", "code": room.code, "seat": seat, "token": token})
        await self._push_lobby(room)

    async def _join(self, data):
        room, seat, token, err = MANAGER.join(self.code, data.get("name"))
        if err:
            await self._err(err, "join failed")
            return
        self.token = token
        self.seat = seat
        room.by_seat(seat)["channel"] = self.channel_name
        await self.channel_layer.group_add(_group(self.code), self.channel_name)
        await self.send_json({"type": "joined", "code": room.code, "seat": seat, "token": token})
        await self._push_lobby(room)

    async def _start(self, room):
        if not room or not room.is_host(self.token):
            await self._err("not_host", "only host can start")
            return
        seed = (int(time.time() * 1000) ^ (hash(room.code) & 0xFFFFFFFF)) & 0xFFFFFFFF or 1
        err = room.start(seed)
        if err:
            await self._err(err, "cannot start")
            return
        await self._broadcast(room, {"type": "started"})
        await self._push_views(room)

    async def _action(self, room, action):
        if not room or room.phase != "play":
            await self._err("bad_phase", "not in play phase")
            return
        if room.state["current"] != self.seat:
            await self._err("not_your_turn", "not your turn")
            return
        at = action.get("type")
        if at in ("play", "move"):
            # 12枚目(強制公開)になる play は reveal-intent へ
            if at == "play" and self._is_12th(room, action):
                await self._begin_reveal(room, action, forced=True)
                return
            res = core.apply_action(room.state, action)
            if any(e["type"] == "error" for e in res["events"]):
                await self._err("illegal", res["events"][0]["message"])
                return
            room.state = res["state"]
            await self._push_views(room)
        elif at == "reveal":
            await self._begin_reveal(room, {"type": "reveal"}, forced=False)
        else:
            await self._err("bad_action", "unknown action type")

    def _is_12th(self, room, action):
        ci = action.get("cardIndex")
        hand = room.state["players"][room.state["current"]]["hand"]
        return (room.state["row"] and len(room.state["row"]) == 11 and isinstance(ci, int)
                and 0 <= ci < len(hand) and hand[ci]["t"] == "butt")

    # ---- 公開シーケンス（ワン!同時宣言 → 特殊 → 採点） ----
    async def _begin_reveal(self, room, action, forced):
        revealer = room.state["current"]
        # 表示用state（12枚目込み）。実採点は room.state + action で行う。
        view_state = room.state
        if forced:
            view_state = core.clone(room.state)
            pc = room.state["players"][revealer]["hand"][action["cardIndex"]]
            view_state["row"].append({"t": "butt", "v": pc["v"], "placedBy": revealer,
                                      "id": view_state["cardSeq"], "faceDown": True})
            view_state["cardSeq"] += 1
        deadline = time.time() + WAN_DEADLINE_SEC
        room.phase = "wan"
        room.wan = {"deadline": deadline, "action": action, "revealer": revealer,
                    "declarations": {}, "responded": set(), "view_state": view_state, "forced": forced}
        await self._broadcast(room, {"type": "wan_phase", "revealer": revealer,
                                     "deadline": int(deadline * 1000),
                                     "seconds": WAN_DEADLINE_SEC})
        # ワン!フェーズ中も各自の view（自分の裏向きは見える）を配る
        await self._push_views(room, state=view_state)
        asyncio.create_task(self._wan_timer(room.code, deadline))

    async def _wan_timer(self, code, deadline):
        await asyncio.sleep(max(0, deadline - time.time()) + 0.05)
        room = MANAGER.get(code)
        if room and room.phase == "wan" and room.wan and room.wan["deadline"] == deadline:
            await self._to_special(room)

    async def _wan_declare(self, room, value):
        if not room or room.phase != "wan" or not room.wan:
            await self._err("bad_phase", "not wan phase")
            return
        # 権威: 実参加者(トークン保有)のみ。未認証接続(seat=None)や偽seatを拒否。
        if self.seat is None or room.by_seat(self.seat) is None \
                or room.by_seat(self.seat)["token"] != self.token:
            await self._err("not_participant", "not a participant")
            return
        if self.seat in room.wan["responded"]:
            return
        room.wan["responded"].add(self.seat)
        if isinstance(value, int) and 1 <= value <= 12:
            room.wan["declarations"][self.seat] = value
        # 他者の宣言内容は締切まで非公開。宣言済みかどうかのみ通知。
        await self._broadcast(room, {"type": "wan_progress",
                                     "responded": sorted(room.wan["responded"]),
                                     "total": len(room.connected_seats())})
        if room.wan["responded"] >= set(room.connected_seats()):
            await self._to_special(room)

    async def _to_special(self, room):
        if room.phase != "wan" or not room.wan:
            return
        w = room.wan
        declarations = [{"player": s, "value": v} for s, v in w["declarations"].items()]
        revealer = w["revealer"]
        rp = room.state["players"][revealer]
        has_special = any(c["t"] == "special" for c in rp["hand"])
        room.wan = None
        if not has_special:
            await self._resolve_reveal(room, w["action"], declarations, None)
            return
        deadline = time.time() + SPECIAL_DEADLINE_SEC
        room.phase = "special"
        room.special = {"deadline": deadline, "revealer": revealer, "action": w["action"],
                        "declarations": declarations, "view_state": w["view_state"]}
        # 【payload隠蔽】表向きの場(採点対象=全カード値)は公開者チャンネルにのみ送る。
        # 他プレイヤーには値を含まない待機通知のみ（group_send で全員に生rowCardsを送らない）。
        flip = [{"v": c["v"], "placedBy": c["placedBy"], "id": c["id"]} for c in w["view_state"]["row"]]
        held = [c["s"] for c in rp["hand"] if c["t"] == "special"]  # 公開者の保有特殊種
        for p in room.players:
            if not (p["connected"] and p["channel"]):
                continue
            payload = {"type": "special_phase", "revealer": revealer,
                       "deadline": int(deadline * 1000), "seconds": SPECIAL_DEADLINE_SEC}
            if p["seat"] == revealer:
                payload["rowCards"] = flip  # 公開者だけが採点対象の場を見て選ぶ
                payload["heldSpecials"] = held  # 保有分だけUIにボタンを出す
            await self.channel_layer.send(p["channel"], {"type": "room.broadcast", "payload": payload})
        asyncio.create_task(self._special_timer(room.code, deadline))

    async def _special_timer(self, code, deadline):
        await asyncio.sleep(max(0, deadline - time.time()) + 0.05)
        room = MANAGER.get(code)
        if room and room.phase == "special" and room.special and room.special["deadline"] == deadline:
            sp = room.special
            room.special = None
            await self._resolve_reveal(room, sp["action"], sp["declarations"], None)

    async def _special(self, room, card, number):
        if not room or room.phase != "special" or not room.special:
            await self._err("bad_phase", "not special phase")
            return
        if self.seat != room.special["revealer"]:
            await self._err("not_revealer", "only revealer chooses special")
            return
        sp = room.special
        room.special = None
        # 権威: 実際に保有する特殊カードのみ適用可（core.pyは保有検証しない設計＝ここで照合）
        held = [c["s"] for c in room.state["players"][self.seat]["hand"] if c["t"] == "special"]
        special = None
        if card in ("amaenbo", "yancha", "ohirune") and card in held:
            special = {"type": card}
            if card == "amaenbo" and isinstance(number, int):
                special["number"] = number
        await self._resolve_reveal(room, sp["action"], sp["declarations"], special)

    async def _resolve_reveal(self, room, action, declarations, special):
        act = dict(action)
        act["declarations"] = declarations
        act["special"] = special
        res = core.apply_action(room.state, act)
        if any(e["type"] == "error" for e in res["events"]):
            room.phase = "play"
            await self._err("illegal", res["events"][0]["message"])
            await self._push_views(room)
            return
        room.state = res["state"]
        revealed = next((e for e in res["events"] if e["type"] == "revealed"), None)
        score_ev = next((e for e in res["events"] if e["type"] == "score"), None)
        wans = [e for e in res["events"] if e["type"] == "wan"]
        room.phase = "over" if room.state["finished"] else "play"
        await self._broadcast(room, {
            "type": "reveal_result",
            "revealer": revealed["revealer"] if revealed else None,
            "rowCards": revealed["rowCards"] if revealed else [],
            "forced": revealed["forced"] if revealed else False,
            "result": score_ev["detail"] if score_ev else None,
            "wans": [{"seat": w["player"], "delta": w["delta"]} for w in wans],
        })
        await self._push_views(room)
        if room.state["finished"]:
            await self._save_match(room)

    async def _rematch(self, room):
        if not room or not room.is_host(self.token):
            await self._err("not_host", "only host can rematch")
            return
        if room.phase != "over":
            await self._err("bad_phase", "game not over")
            return
        room.phase = "lobby"
        room.state = None
        await self._push_lobby(room)

    async def _end_abandoned(self, room):
        if room.phase == "over":
            return
        room.phase = "over"
        await self._broadcast(room, {"type": "gameover", "reason": "abandoned"})
        # 流局は結果保存対象外（勝者なし）

    # ---- DB保存 ----
    async def _save_match(self, room):
        st = room.state
        winner = st.get("winner")
        reason = "wangeki"
        rev = st.get("lastReveal") or {}
        if isinstance(winner, int):
            r = (rev.get("result") or {})
            reason = "wangeki" if r.get("wangeki") else "150pts"
        elif winner == "draw":
            reason = "draw"
        names = [p["name"] for p in room.players]
        scores = [p["score"] for p in st["players"]]
        if isinstance(winner, int) and winner < len(names):
            wname = names[winner]
        else:
            wname = "引き分け" if winner == "draw" else ""
        await self._db_save(room.code, reason, wname, names, scores, winner)

    @database_sync_to_async
    def _db_save(self, code, reason, wname, names, scores, winner):
        from .models import Match, MatchPlayer
        m = Match.objects.create(room_code=code, ended_at=timezone.now(),
                                 end_reason=reason, winner_name=wname, player_count=len(names))
        for seat, (nm, sc) in enumerate(zip(names, scores)):
            MatchPlayer.objects.create(match=m, seat=seat, name=nm, final_score=sc,
                                       is_winner=(isinstance(winner, int) and seat == winner))

    # ---- 配信ヘルパ ----
    async def _push_lobby(self, room):
        await self._broadcast(room, {"type": "room_state", **room.lobby_view()})

    async def _push_views(self, room, state=None):
        st = state or room.state
        if not st:
            return
        for p in room.players:
            if p["connected"] and p["channel"]:
                await self.channel_layer.send(p["channel"], {
                    "type": "view.push",
                    "payload": {"type": "view", "phase": room.phase,
                                "view": core.view_for(st, p["seat"])},
                })

    async def _push_one_view(self, room, p):
        if room.state and p["channel"]:
            await self.channel_layer.send(p["channel"], {
                "type": "view.push",
                "payload": {"type": "view", "phase": room.phase,
                            "view": core.view_for(room.state, p["seat"])},
            })

    async def _broadcast(self, room, payload):
        await self.channel_layer.group_send(_group(room.code),
                                            {"type": "room.broadcast", "payload": payload})

    async def _err(self, code, msg):
        await self.send_json({"type": "error", "code": code, "message": msg})

    # ---- channel layer ハンドラ ----
    async def view_push(self, event):
        await self.send_json(event["payload"])

    async def room_broadcast(self, event):
        await self.send_json(event["payload"])
