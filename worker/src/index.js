// index.js — Worker入口。/ws/room/<code> を GameRoom DO へルーティング。
// Origin検査: Pages本番 と localhost のみ許可（不許可は403）。
export { GameRoom } from "./game-room.js";

const ALLOWED = [
  /^https:\/\/mokemoke0821\.github\.io$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function originOk(origin) {
  // Origin ヘッダが無い接続（curl/Node WS等・ブラウザCORS対象外）は許可。
  if (!origin) return true;
  return ALLOWED.some((re) => re.test(origin));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/room\/([A-Za-z0-9]{5})\/?$/);
    if (!m) {
      return new Response("chihuahua-wangeki worker (Durable Objects)", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const origin = request.headers.get("Origin");
    if (!originOk(origin)) {
      return new Response("forbidden origin", { status: 403 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const code = m[1].toUpperCase();
    const id = env.GAME_ROOM.idFromName(code);
    const stub = env.GAME_ROOM.get(id);
    return stub.fetch(request);
  },
};
