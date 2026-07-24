"""rooms.py — 部屋・トークン・ゲームstateのメモリ保持（単一ASGIプロセス前提）.

権威サーバーの状態管理。ゲーム進行stateはメモリ（DBに置かない）。ワン!同時宣言・
特殊フェーズの締切はConsumer側でasyncioタイマー駆動、ここは状態遷移の純ロジック。
"""
import secrets
import string

from . import core

WAN_DEADLINE_SEC = 15
SPECIAL_DEADLINE_SEC = 15
RECONNECT_GRACE_SEC = 60


class Room:
    def __init__(self, code):
        self.code = code
        self.players = []  # [{seat,name,token,channel,connected,disconnect_at}]
        self.host_token = None
        self.state = None            # core game state（play中）
        self.phase = "lobby"         # lobby | play | wan | special | over
        self.match_id = None
        # ワン!フェーズ: {deadline, declarations:{seat:value}, responded:set, action, revealer}
        self.wan = None
        # 特殊フェーズ: {deadline, revealer, action, declarations}
        self.special = None

    # --- ロビー ---
    def add_player(self, name):
        if self.phase != "lobby":
            return None, None, "already_started"
        if len(self.players) >= 4:
            return None, None, "room_full"
        seat = len(self.players)
        token = secrets.token_urlsafe(9)
        self.players.append({"seat": seat, "name": name or ("P" + str(seat + 1)),
                             "token": token, "channel": None, "connected": True,
                             "disconnect_at": None})
        if self.host_token is None:
            self.host_token = token
        return seat, token, None

    def by_token(self, token):
        return next((p for p in self.players if p["token"] == token), None)

    def by_seat(self, seat):
        return next((p for p in self.players if p["seat"] == seat), None)

    def connected_seats(self):
        return [p["seat"] for p in self.players if p["connected"]]

    def lobby_view(self):
        return {
            "code": self.code,
            "phase": self.phase,
            "players": [{"seat": p["seat"], "name": p["name"], "connected": p["connected"],
                         "isHost": p["token"] == self.host_token} for p in self.players],
            "hostSeat": (self.by_token(self.host_token) or {}).get("seat"),
        }

    def is_host(self, token):
        return token == self.host_token

    # --- 開始 ---
    def start(self, seed):
        n = len(self.players)
        if n < 2:
            return "need_2_players"
        self.state = core.new_game(seed, n)
        self.phase = "play"
        return None


class RoomManager:
    def __init__(self):
        self.rooms = {}

    def _gen_code(self):
        while True:
            code = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(5))
            if code not in self.rooms:
                return code

    def create(self, host_name):
        code = self._gen_code()
        r = Room(code)
        seat, token, _ = r.add_player(host_name)
        self.rooms[code] = r
        return r, seat, token

    def get(self, code):
        return self.rooms.get(code)

    def join(self, code, name):
        r = self.rooms.get(code)
        if not r:
            return None, None, None, "no_such_room"
        seat, token, err = r.add_player(name)
        if err:
            return r, None, None, err
        return r, seat, token, None

    def remove_if_empty(self, code):
        r = self.rooms.get(code)
        if r and (not r.players or all(not p["connected"] for p in r.players)):
            # 全員切断かつゲーム終了なら破棄（猶予はConsumer側で管理）
            if r.phase in ("lobby", "over"):
                self.rooms.pop(code, None)


# プロセス内シングルトン（単一ASGIプロセス前提。Phase2bでRedis/共有ストアへ）
MANAGER = RoomManager()
