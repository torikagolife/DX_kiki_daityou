/*** 医療機器DX台帳 ─ 点検画面（Cloudflare Workers・1ファイル）**********
 *  worker.js
 *
 *  Workers は画面を返して、GASへ取り次ぐだけ。
 *  データもファイルも、今までどおりスプレッドシートとGoogleドライブに入ります。
 *  Cloudflare側のストレージ（D1・R2・KV）は使いません。支払い情報も要りません。
 *
 *      ブラウザ ──→ Workers ──→ GAS ──→ スプレッドシート / Googleドライブ
 *                  画面・ログイン・中継      今までどおり
 *
 *  これで何が変わるか
 *    1. GASのウェブアプリを開いたときに上に出る「このアプリケーションは…」の帯が
 *       出なくなる。画面を返しているのはWorkersなので、そもそもiframeではない。
 *    2. iframeの外なので、画面からカメラを直接開ける。
 *       QRのスキャンに GitHub Pages へ出る回避策が要らない。
 *    3. URLが自分のドメインになる。
 *
 *  速くはなりません。GASへの往復が1つ増えるぶん、むしろ少し遅いです。
 *
 *  ───────────────────────────────────────────────
 *  ダッシュボードの Settings → Variables and Secrets に入れるもの（全部 Secret）
 *
 *    GAS_URL      GASウェブアプリのURL（…/exec まで）
 *    GAS_SECRET   GAS側のスクリプトプロパティ CF_SECRET と同じ文字列
 *    INSPECT_PW   点検画面のパスワード。現場共通
 *    TOKEN_SECRET ログインの署名鍵。長い文字列なら何でもよい
 *
 *  任意（Type は Text でよい）
 *    APP_NAME     画面の見出し。省略すると「医療機器DX台帳」
 *    GAS_LINKS    "1" にすると、画面の下に台帳・履歴・マスタ管理へのリンクを出す
 **********************************************************************/

const TOKEN_DAYS = 30;
const COOKIE = 'mkdx_tk';
const enc = new TextEncoder();

/* =====================================================================
 *  小物
 * ===================================================================== */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
function err(message, status = 400) {
  return json({ error: message }, status);
}

// GASが返してきたエラー。画面にそのまま出してよいもの
class GasError extends Error {}

function b64url(buf) {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign_(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
}

// 長さを揃えてから全桁を比べる。途中で返らないように
function sameSecret(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function issueToken(env) {
  const exp = Date.now() + TOKEN_DAYS * 86400 * 1000;
  const body = 'inspect.' + exp;
  return body + '.' + await sign_(env.TOKEN_SECRET, body);
}

async function loggedIn(env, request) {
  let raw = '';
  const m = (request.headers.get('cookie') || '').match(
    new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (m) raw = decodeURIComponent(m[1]);
  if (!raw) return false;

  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [scope, exp, sig] = parts;
  if (scope !== 'inspect') return false;
  if (Number(exp) < Date.now()) return false;
  return sameSecret(await sign_(env.TOKEN_SECRET, scope + '.' + exp), sig);
}

function cookieHeader(token) {
  return COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; Max-Age=' + (TOKEN_DAYS * 86400) + '; HttpOnly; Secure; SameSite=Lax';
}

/* =====================================================================
 *  GASへの取り次ぎ
 * ===================================================================== */

async function callGas(env, action, payload) {
  if (!env.GAS_URL)    throw new Error('GAS_URL が設定されていません');
  if (!env.GAS_SECRET) throw new Error('GAS_SECRET が設定されていません');

  const res = await fetch(env.GAS_URL, {
    method: 'POST',
    // GASは Content-Type を見ないので text/plain にしておく。
    // application/json にすると、ブラウザ以外からでも余計な手間が増える
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: env.GAS_SECRET, action, payload: payload || {} }),
    redirect: 'follow',
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error('GASが ' + res.status + ' を返しました');
  }

  let out;
  try {
    out = JSON.parse(text);
  } catch (e) {
    // ログイン画面のHTMLが返ってくるときはここに来る
    throw new Error(
      'GASからJSONが返りませんでした。デプロイの「アクセスできるユーザー」が' +
      '「全員」になっているか、GAS_URL が /exec で終わっているか確認してください。');
  }
  if (out.error) throw new GasError(out.error === 'AUTH'
    ? 'GAS_SECRET と、GAS側のCF_SECRETが一致していません' : out.error);
  return out.data;
}

/* =====================================================================
 *  入口
 * ===================================================================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/' || path === '/index.html') {
        return new Response(renderPage(env, url.searchParams.get('id') || ''), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      }
      if (path === '/icon.svg')            return iconSvg();
      if (path === '/icon.png')            return iconPng();
      if (path === '/apple-touch-icon.png' ||
          path === '/apple-touch-icon-precomposed.png') return iconPng();
      if (path === '/favicon.ico')         return iconSvg();
      if (path === '/manifest.webmanifest') return manifest(env);

      if (path === '/jsqr.js') return await serveJsqr(request, env, ctx);
      if (path.startsWith('/api/')) return await handleApi(request, env, url, path);
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      // GASが「管理番号が見つかりません」などを返しただけのときは、
      // こちらの不具合ではないので 400 にして、文面だけ画面へ渡す
      return err((e && e.message) ? e.message : String(e),
                 e instanceof GasError ? 400 : 500);
    }
  },
};

/* ---------------------------------------------------------------------
 *  アイコン（⚡）
 *    タブのファビコンはSVG、スマホのホーム画面はPNG。
 *    iOSはSVGをホーム画面アイコンに使えないので、PNGも持っている。
 * ------------------------------------------------------------------- */

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">  <stop offset="0" stop-color="#2a97a1"/><stop offset="1" stop-color="#176b73"/></linearGradient><linearGradient id="b" x1="0" y1="0" x2="0" y2="1">  <stop offset="0" stop-color="#ffe14d"/><stop offset="1" stop-color="#f7b500"/></linearGradient></defs><rect width="100" height="100" rx="18" ry="18" fill="url(#g)"/><path d="M57.3 12.2 L28.5 55.2 L46.1 55.2 L42.7 87.8 L71.5 44.8 L53.9 44.8 Z" fill="url(#b)" stroke="#b07f08" stroke-width="1.5" stroke-linejoin="round"/></svg>';

// 192×192。角は丸めていない。iOSもAndroidも自分で丸めるので、
// こちらで丸めると角が二重になる
const ICON_PNG_B64 = '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';

const ICON_CACHE = 'public, max-age=604800, immutable';

function iconSvg() {
  return new Response(ICON_SVG, {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': ICON_CACHE },
  });
}

let ICON_PNG_BYTES = null;
function iconPng() {
  if (!ICON_PNG_BYTES) {
    const bin = atob(ICON_PNG_B64);
    ICON_PNG_BYTES = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) ICON_PNG_BYTES[i] = bin.charCodeAt(i);
  }
  return new Response(ICON_PNG_BYTES, {
    headers: { 'content-type': 'image/png', 'cache-control': ICON_CACHE },
  });
}

function manifest(env) {
  // display を standalone にすると、ホームから開いたとき
  // アドレスバーが消えてアプリらしくなる。
  // ただしiOSでは、取説のリンク（別タブ）を開いたあと戻れなくなることがあるので
  // browser のままにしてある。見た目より、書類が開けるほうを取った
  const body = {
    name: env.APP_NAME || '医療機器DX台帳',
    short_name: '点検',
    start_url: '/',
    scope: '/',
    display: 'browser',
    background_color: '#f4f8f8',
    theme_color: '#1f7f88',
    icons: [
      { src: '/icon.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon.svg', sizes: 'any',     type: 'image/svg+xml' },
    ],
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    },
  });
}

/* ---------------------------------------------------------------------
 *  QRのライブラリ。GASの jsqr.html を取ってきて、エッジに置いておく
 * ------------------------------------------------------------------- */

let JSQR_MEMO = null;      // 同じ実行環境が生きている間は使い回す

async function serveJsqr(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL('/jsqr.js', request.url).toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  let src = JSQR_MEMO;
  if (!src) {
    try {
      const d = await callGas(env, 'jsqr');
      src = (d && d.src) ? d.src : '';
    } catch (e) {
      return new Response(
        'console.error("[mkdx] jsqr.js を取得できません: ' +
        String((e && e.message) || e).replace(/"/g, "'") + '");',
        { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    }
    JSQR_MEMO = src;
  }

  const res = new Response(src, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/* =====================================================================
 *  API（画面から呼ぶぶん）
 * ===================================================================== */

async function handleApi(request, env, url, path) {
  const method = request.method;

  // ---- ログイン ----
  if (path === '/api/login' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, 400));     // 総当たり対策のささやかな遅延
    if (!env.INSPECT_PW ||
        !sameSecret(String(b.pw || '').trim(), String(env.INSPECT_PW).trim())) {
      return json({ ok: false }, 401);
    }
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader(await issueToken(env)) });
  }

  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, {
      'set-cookie': COOKIE + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    });
  }

  const ok = await loggedIn(env, request);
  if (path === '/api/me') return json({ ok });
  if (!ok) return err('AUTH', 401);

  const seg = path.split('/').filter(Boolean);        // ['api', ...]

  // ---- 疎通確認。つながらないときはここを開くと原因が出る ----
  if (path === '/api/ping') {
    return json(await callGas(env, 'ping'));
  }

  // ---- 機器を1台開く ----
  if (seg[1] === 'device' && method === 'GET') {
    return json(await callGas(env, 'device',
      { kanriNo: decodeURIComponent(seg[2] || '') }));
  }

  // ---- 点検・故障報告 ----
  if (path === '/api/inspection' && method === 'POST') {
    return json(await callGas(env, 'inspect', await request.json()));
  }
  if (path === '/api/trouble' && method === 'POST') {
    return json(await callGas(env, 'trouble', await request.json()));
  }
  if (seg[1] === 'history' && seg[3] === 'inspection' && method === 'PUT') {
    const p = await request.json();
    p.hid = decodeURIComponent(seg[2]);
    return json(await callGas(env, 'updateInspect', p));
  }
  if (seg[1] === 'history' && seg[3] === 'trouble' && method === 'PUT') {
    const p = await request.json();
    p.hid = decodeURIComponent(seg[2]);
    return json(await callGas(env, 'updateTrouble', p));
  }

  // ---- その他報告（ステータスは変えない）----
  if (path === '/api/other' && method === 'POST') {
    return json(await callGas(env, 'other', await request.json()));
  }
  if (seg[1] === 'history' && seg[3] === 'other' && method === 'PUT') {
    const p = await request.json();
    p.hid = decodeURIComponent(seg[2]);
    return json(await callGas(env, 'updateOther', p));
  }

  // ---- 書類 ----
  if (seg[1] === 'files' && method === 'GET') {
    return json(await callGas(env, 'files',
      { kanriNo: decodeURIComponent(seg[2] || '') }));
  }
  if (path === '/api/upload' && method === 'POST') {
    return json(await callGas(env, 'upload', await request.json()));
  }

  // GASからはbase64で受け取るが、ブラウザへは普通のファイルとして返す。
  // こうしておくと、リンクをそのまま開けるし <img src> でも使える
  if (seg[1] === 'file' && method === 'GET') {
    const d = await callGas(env, 'file', { fileId: decodeURIComponent(seg[2] || '') });
    return binary(d.data, d.mime, d.name, url.searchParams.get('dl') === '1');
  }

  // ---- 代表写真。無ければ404を返して、画面側は黙って隠す ----
  if (seg[1] === 'thumb' && method === 'GET') {
    let d = null;
    try { d = await callGas(env, 'thumb', { kanriNo: decodeURIComponent(seg[2] || '') }); }
    catch (e) { d = null; }
    if (!d || !d.ok || !d.dataUrl) return new Response('', { status: 404 });

    const m = String(d.dataUrl).match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return new Response('', { status: 404 });
    return binary(m[2], m[1], 'thumb.jpg', false, 'private, max-age=3600');
  }

  return err('そのAPIはありません: ' + path, 404);
}

// base64 → バイナリのレスポンス
function binary(b64, mime, name, download, cache) {
  const bin = atob(String(b64 || ''));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Response(buf, {
    headers: {
      'content-type': mime || 'application/octet-stream',
      'content-disposition': (download ? 'attachment' : 'inline') +
        "; filename*=UTF-8''" + encodeURIComponent(name || 'file'),
      'cache-control': cache || 'private, max-age=600',
    },
  });
}

/* =====================================================================
 *  画面
 * ===================================================================== */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPage(env, initId) {
  const appName = env.APP_NAME || '医療機器DX台帳';
  const links = String(env.GAS_LINKS || '') === '1' && env.GAS_URL
    ? `<p class="sub center" style="margin-top:18px">
         📋 <a href="${esc(env.GAS_URL)}?p=ledger" target="_blank" rel="noopener">台帳</a>
         🕘 <a href="${esc(env.GAS_URL)}?p=history" target="_blank" rel="noopener">履歴</a>
         ⚙️ <a href="${esc(env.GAS_URL)}?p=admin" target="_blank" rel="noopener">マスタ管理</a>
       </p>` : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f7f88">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-title" content="点検">
<meta name="application-name" content="点検">
<title>${esc(appName)}</title>
<style>
:root{
  --bg:#f4f8f8; --card:#fff; --line:#dfe9ea; --ink:#1d2b2e; --sub:#6b8286;
  --accent:#1f7f88; --accent-weak:#e2f2f3; --warn:#c2621f; --warn-weak:#fdefe2;
  --pink:#e8738f; --pink-weak:#fdeef2; --radius:14px;
  padding-top:env(safe-area-inset-top,0px); padding-bottom:env(safe-area-inset-bottom,0px);
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);
  font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;
  font-size:16px;line-height:1.6}
.wrap{max-width:560px;margin:0 auto;padding:16px 14px 72px}
.hd{display:flex;align-items:baseline;gap:8px;margin:4px 0 14px}
.hd h1{font-size:18px;margin:0;font-weight:700}
.hd span{font-size:12px;color:var(--sub)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:15px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
.card h2{font-size:15px;margin:0 0 10px;font-weight:700}
label{display:block;font-size:13px;color:var(--sub);margin:0 0 4px}
input[type=text],input[type=number],input[type=password],input[type=month],select,textarea{
  width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;
  font-size:16px;background:#fff;color:var(--ink);font-family:inherit}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);border-color:transparent}
textarea{resize:vertical}
button{font-family:inherit;font-size:16px;border-radius:10px;border:0;padding:13px 16px;
  cursor:pointer;font-weight:700}
.btn{background:var(--accent);color:#fff;width:100%}
.btn:disabled{opacity:.5}
.btn-sub{background:#fff;color:var(--accent);border:1px solid var(--accent);width:100%}
.btn-pink{background:var(--pink);color:#fff;width:100%}
.btn-link{background:none;color:var(--accent);padding:6px 0;font-size:13px;font-weight:400;
  text-decoration:underline;width:auto}
.btn-big{padding:20px 16px;font-size:18px}
.btn,.btn-sub,.btn-pink{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn-big{white-space:normal}
.kv{display:grid;grid-template-columns:104px 1fr;gap:4px 10px;font-size:14px}
.kv dt{color:var(--sub)}
.kv dd{margin:0;font-weight:600;word-break:break-word}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700}
.badge.ok{background:var(--accent-weak);color:var(--accent)}
.badge.ng{background:var(--warn-weak);color:var(--warn)}
.msg{padding:10px 12px;border-radius:10px;font-size:14px;margin-bottom:12px}
.msg.err{background:var(--warn-weak);color:var(--warn)}
.msg.info{background:var(--accent-weak);color:var(--accent)}
.msg.edit{background:var(--pink-weak);color:var(--pink);font-weight:700}
.hide{display:none!important}
.center{text-align:center}
.sub{font-size:12px;color:var(--sub)}
.spin{display:inline-block;width:16px;height:16px;border:2px solid var(--line);
  border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite;
  vertical-align:-3px;margin-right:6px}
@keyframes sp{to{transform:rotate(360deg)}}

#devThumbHost{margin:0 0 12px}
#devThumbHost img{width:100%;max-height:220px;object-fit:cover;display:block;
  border-radius:12px;background:var(--accent-weak);cursor:pointer}

/* ---- QRのライブスキャン ---- */
#scan{position:fixed;inset:0;background:#000;z-index:60;display:none;
  flex-direction:column;align-items:center;justify-content:center}
#scan.on{display:flex}
#scan video{width:100%;height:100%;object-fit:cover;position:absolute;inset:0}
#scan .frame{position:relative;width:min(72vw,72vh);aspect-ratio:1;
  border:3px solid rgba(255,255,255,.9);border-radius:18px;
  box-shadow:0 0 0 100vmax rgba(0,0,0,.45)}
#scan .tip{position:absolute;left:0;right:0;bottom:calc(14% + env(safe-area-inset-bottom,0px));
  color:#fff;text-align:center;font-size:14px;font-weight:700;
  text-shadow:0 1px 4px rgba(0,0,0,.8);padding:0 20px}
#scan .x{position:absolute;top:calc(14px + env(safe-area-inset-top,0px));right:14px;
  width:44px;height:44px;padding:0;border-radius:50%;
  background:rgba(0,0,0,.55);color:#fff;font-size:20px;line-height:1}

.tabs{display:flex;gap:6px;margin-bottom:12px}
.tab{flex:1;background:var(--card);color:var(--sub);border:1px solid var(--line);
  padding:10px;font-size:14px}
.tab.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.item{padding:12px 0;border-bottom:1px solid var(--line)}
.item:last-of-type{border-bottom:0}
.item.miss{background:var(--warn-weak);margin:0 -15px;padding:12px 15px;border-radius:8px}
.item-ttl{font-size:15px;font-weight:600;margin-bottom:8px}
.req{font-size:11px;color:var(--warn);background:var(--warn-weak);
  padding:1px 7px;border-radius:999px;margin-left:6px;font-weight:700;vertical-align:2px}
.seg{display:flex;gap:8px;margin-top:6px}
.seg-b{flex:1;background:var(--card);border:1px solid var(--line);color:var(--sub);
  font-size:22px;padding:14px}
.seg-b.ok.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.seg-b.ng.on{background:var(--warn);color:#fff;border-color:var(--warn)}
.prev{font-size:12px;color:var(--sub);margin-top:6px;opacity:.8}

.done-emoji{font-size:48px;line-height:1.2;margin-bottom:4px}

.ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;
  align-items:flex-start;justify-content:center;z-index:40;padding:16px;overflow-y:auto}
.ov.on{display:flex}
.dlg{background:var(--card);border-radius:16px;padding:18px;width:100%;max-width:520px;
  margin:auto;box-shadow:0 10px 40px rgba(0,0,0,.25)}
.dlg h2{font-size:16px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.dlg .close{margin-top:14px}

.doc-kind{font-size:12px;font-weight:700;color:var(--accent);background:var(--accent-weak);
  padding:4px 10px;border-radius:999px;display:inline-block;margin:14px 0 6px}
.doc-kind:first-child{margin-top:4px}
.doc-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;
  background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:11px 12px;margin-bottom:6px;font-weight:400;text-decoration:none;color:inherit}
.doc-row:active{background:var(--accent-weak)}
.doc-ic{font-size:22px;flex:0 0 auto;line-height:1}
.doc-tx{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.doc-nm{font-size:14px;font-weight:600;word-break:break-all}

.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.thumb{position:relative;width:76px;height:76px;border-radius:10px;overflow:hidden;
  border:1px solid var(--line)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb-x{position:absolute;top:2px;right:2px;width:26px;height:26px;padding:0;
  border-radius:50%;background:rgba(0,0,0,.62);color:#fff;font-size:13px;line-height:1;
  display:flex;align-items:center;justify-content:center}

@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#101819; --card:#172124; --line:#2b393d; --ink:#e6eef0; --sub:#93a6aa;
    --accent:#6fc0c8; --accent-weak:#1c3134; --warn:#e9a06a; --warn-weak:#33261c;
    --pink:#f0909f; --pink-weak:#331f26;
  }
  :root:not([data-theme="light"]) input,
  :root:not([data-theme="light"]) select,
  :root:not([data-theme="light"]) textarea{background:#0e1618;color:var(--ink)}
  :root:not([data-theme="light"]) .btn-sub{background:transparent}
  :root:not([data-theme="light"]) .seg-b{background:#0e1618}
  :root:not([data-theme="light"]) .doc-row{background:#0e1618}
  :root:not([data-theme="light"]) .seg-b.ok.on,
  :root:not([data-theme="light"]) .seg-b.ng.on,
  :root:not([data-theme="light"]) .btn,
  :root:not([data-theme="light"]) .btn-pink{color:#0e1618}
}
</style>
</head>
<body>
<div class="wrap">

  <div class="hd">
    <h1>🏥 ${esc(appName)}</h1><span>⚡ 点検入力</span>
  </div>

  <div id="err" class="msg err hide"></div>

  <div id="vPw" class="hide">
    <div class="card">
      <h2>🔑 パスワード</h2>
      <label for="pw">🏥 現場共通のパスワードを入力してね</label>
      <input type="password" id="pw" inputmode="numeric" autocomplete="current-password"
             onkeydown="if(event.key==='Enter')doLogin()">
      <p class="sub">😌 一度入力すると30日間は省略されます</p>
      <button class="btn" id="btnPw" onclick="doLogin()">🔓 開く</button>
    </div>
  </div>

  <div id="vFind" class="hide">
    <div class="card">
      <h2>🔍 機器を選ぶ</h2>
      <button class="btn btn-big" id="btnShot" onclick="openScan()">📷 QRをスキャン</button>
      <p class="sub center" style="margin:10px 0 0">🏷 カメラをQRラベルに向けてね</p>

      <button class="btn-sub" id="btnPhoto" onclick="pickQrPhoto()" style="margin-top:10px">
        📸 写真から読む</button>

      <p class="sub center" style="margin:16px 0 6px">— ⌨️ または手入力 —</p>
      <label for="kanri">🏷 管理番号</label>
      <input type="text" id="kanri" placeholder="A1403" autocapitalize="characters"
             autocomplete="off" onkeydown="if(event.key==='Enter')findByInput()">
      <button class="btn-sub" id="btnFind" onclick="findByInput()" style="margin-top:8px">
        📥 読み込む</button>
    </div>
  </div>

  <div id="vMain" class="hide">
    <div class="card">
      <div id="devThumbHost" class="hide"></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div>
          <div style="font-weight:700;font-size:16px" id="devName"></div>
          <div class="sub" id="devNo"></div>
        </div>
        <span class="badge" id="devStatus"></span>
      </div>
      <dl class="kv" id="devBody" style="margin:12px 0 14px"></dl>
      <button class="btn-sub" id="btnDocs" onclick="openDocs()">📎 書類を見る</button>
    </div>

    <div class="card">
      <h2>🙋 実施者</h2>
      <select id="user" onchange="rememberUser()"></select>
      <button class="btn-link" id="btnAllUsers" onclick="toggleUsers()"></button>
    </div>

    <div id="formArea"></div>

    <button class="btn-sub" onclick="nextDevice()">🔍 別の機器を選ぶ</button>
  </div>

  <div id="vDone" class="hide">
    <div class="card center">
      <div class="done-emoji" id="doneEmoji">🎉</div>
      <h2 id="doneTitle">🎉 登録しました</h2>
      <p class="sub" id="doneBody"></p>
      <button class="btn btn-big" onclick="openScan()" style="margin-top:10px">
        📷 次の機器のQRをスキャン</button>
      <button class="btn-sub" onclick="startEdit()" style="margin-top:8px">
        ✏️ この記録を修正する</button>
      <button class="btn-link" onclick="nextDevice()" style="margin-top:10px">
        ⌨️ 管理番号を手入力する</button>
    </div>
  </div>

  ${links}

  <input type="file" id="qrFile" accept="image/*" style="display:none"
         onchange="onQrPhoto(this)">
  <input type="file" id="photoFile" accept="image/*" capture="environment" multiple
         style="display:none" onchange="onPickPhoto(this)">
</div>

<div id="scan">
  <video id="scanVideo" playsinline muted></video>
  <div class="frame"></div>
  <div class="tip" id="scanTip">🏷 QRラベルを枠に入れてね</div>
  <button class="x" onclick="closeScan()">✕</button>
</div>

<div class="ov" id="ovDocs" onclick="if(event.target===this)closeDocs()">
  <div class="dlg">
    <h2>📎 書類ボックス</h2>
    <p class="sub" style="margin:0 0 10px">👆 タップすると別のタブで開きます。</p>
    <div id="docsBody"></div>
    <button class="btn-sub close" onclick="closeDocs()">✖️ 閉じる</button>
  </div>
</div>

<div class="ov" id="ovView" onclick="if(event.target===this)closeView()">
  <div class="dlg">
    <h2 id="viewTitle"></h2>
    <div id="viewBody" style="margin-top:10px"></div>
    <button class="btn-sub close" onclick="closeView()">✖️ 閉じる</button>
  </div>
</div>

<script src="/jsqr.js"></script>
<script>
var INIT_ID = ${JSON.stringify(String(initId || ''))};
${CLIENT_JS}
</script>
</body>
</html>`;
}

/* =====================================================================
 *  画面側のJS
 * ===================================================================== */

const CLIENT_JS = String.raw`
var S = { ctx:null, allUsers:false, editHid:'', editKind:'', last:null,
          files:[], photos:[] };
var MODE = 'inspect';
var MAX_PHOTO_SIDE = 1600, PHOTO_QUALITY = 0.82;

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function show(id){
  ['vPw','vFind','vMain','vDone'].forEach(function(v){
    document.getElementById(v).classList.toggle('hide', v !== id);
  });
  window.scrollTo(0,0);
}
function err(msg){
  var e = document.getElementById('err');
  e.textContent = '⚠️ ' + msg; e.classList.remove('hide');
  window.scrollTo(0,0);
  setTimeout(function(){ e.classList.add('hide'); }, 8000);
}
function busy(on, el){
  if (!el) return;
  el.disabled = on;
  el.innerHTML = on ? '<span class="spin"></span>処理中…' : el.dataset.label;
}
function markLabels(root){
  (root || document).querySelectorAll('button').forEach(function(b){
    if (!b.dataset.label) b.dataset.label = b.innerHTML;
  });
}

/* ---------- サーバーとのやりとり ---------- */
function api(path, opt){
  opt = opt || {};
  opt.credentials = 'same-origin';
  return fetch(path, opt).then(function(r){
    if (r.status === 401) { show('vPw'); throw new Error('AUTH'); }
    return r.json().then(function(d){
      if (!r.ok) throw new Error(d.error || ('エラー ' + r.status));
      return d;
    }).catch(function(e){
      if (e instanceof SyntaxError) throw new Error('サーバーの返事を読めませんでした');
      throw e;
    });
  });
}
function postJson(path, body, method){
  return api(path, {
    method: method || 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

/* ---------- 起動 ---------- */
function initId_(){
  var v = (typeof INIT_ID === 'string') ? INIT_ID.trim() : '';
  v = v.replace(/^["']+|["']+$/g, '').trim();
  if (!v || v === 'undefined' || v === 'null') return '';
  var m = v.match(/[?&]id=([^&#]+)/);
  if (m) { try { v = decodeURIComponent(m[1]); } catch(e){ v = m[1]; } }
  return v.replace(/\s+/g, '').toUpperCase();
}

function afterAuth(){
  var id = initId_();
  if (id) { loadDevice(id, true); } else { show('vFind'); }
}

window.addEventListener('DOMContentLoaded', function(){
  markLabels();
  if (typeof jsQR !== 'function'){
    var bp = document.getElementById('btnPhoto');
    if (bp) bp.classList.add('hide');
  }
  api('/api/me').then(function(d){
    if (d.ok) afterAuth();
    else { show('vPw'); document.getElementById('pw').focus(); }
  }).catch(function(){ show('vPw'); });
});

function doLogin(){
  var el = document.getElementById('btnPw');
  var pw = document.getElementById('pw').value;
  if (!pw){ err('🔑 パスワードを入力してね'); return; }
  busy(true, el);
  postJson('/api/login', { pw: pw })
    .then(function(){
      busy(false, el);
      document.getElementById('pw').value = '';
      afterAuth();
    })
    .catch(function(e){
      busy(false, el);
      err(e.message === 'AUTH' ? '🙅 パスワードが違うみたい' : e.message);
      show('vPw');
    });
}

/* =============================================================
 *  QR ── iframe の外なので、カメラをそのまま開ける
 * ============================================================= */

var SCAN = { stream:null, raf:0, canvas:null, ctx:null, busy:false };

function openScan(){
  if (typeof jsQR !== 'function'){ err('QRの読み取り機能が読み込めていません'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    err('この端末ではカメラを使えません。📸 写真から読む を使ってね'); return;
  }
  var box = document.getElementById('scan');
  box.classList.add('on');
  document.getElementById('scanTip').textContent = '🏷 QRラベルを枠に入れてね';

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
    audio: false
  }).then(function(stream){
    SCAN.stream = stream;
    var v = document.getElementById('scanVideo');
    v.srcObject = stream;
    v.setAttribute('playsinline', '');
    return v.play();
  }).then(function(){
    SCAN.canvas = document.createElement('canvas');
    SCAN.ctx = SCAN.canvas.getContext('2d', { willReadFrequently: true });
    SCAN.busy = false;
    tick();
  }).catch(function(e){
    closeScan();
    var n = (e && e.name) || '';
    if (n === 'NotAllowedError') err('📷 カメラの使用が許可されませんでした。ブラウザの設定から許可してね');
    else if (n === 'NotFoundError') err('📷 カメラが見つかりません');
    else err('📷 カメラを開けませんでした（' + (e.message || n) + '）');
  });
}

function closeScan(){
  document.getElementById('scan').classList.remove('on');
  if (SCAN.raf) { cancelAnimationFrame(SCAN.raf); SCAN.raf = 0; }
  if (SCAN.stream){
    SCAN.stream.getTracks().forEach(function(t){ t.stop(); });
    SCAN.stream = null;
  }
  var v = document.getElementById('scanVideo');
  if (v) v.srcObject = null;
}

function tick(){
  SCAN.raf = requestAnimationFrame(tick);
  if (SCAN.busy) return;

  var v = document.getElementById('scanVideo');
  if (!v || v.readyState < 2) return;

  // 真ん中の正方形だけ見る。全画面を毎フレーム解析すると熱を持つ
  var side = Math.min(v.videoWidth, v.videoHeight);
  if (!side) return;
  var size = Math.min(640, side);
  var sx = (v.videoWidth - side) / 2, sy = (v.videoHeight - side) / 2;

  SCAN.canvas.width = size; SCAN.canvas.height = size;
  SCAN.ctx.drawImage(v, sx, sy, side, side, 0, 0, size, size);
  var img = SCAN.ctx.getImageData(0, 0, size, size);

  var code = jsQR(img.data, img.width, img.height, { inversionAttempts:'attemptBoth' });
  if (code && code.data){
    SCAN.busy = true;
    if (navigator.vibrate) { try { navigator.vibrate(60); } catch(e){} }
    document.getElementById('scanTip').textContent = '✅ 読み取りました';
    closeScan();
    handleScan(code.data);
  }
}

function handleScan(text){
  var v = String(text || '').trim();
  var m = v.match(/[?&]id=([^&#]+)/);
  if (m) { try { v = decodeURIComponent(m[1]); } catch(e){ v = m[1]; } }
  v = v.replace(/\s+/g, '').toUpperCase();
  if (!v){ err('QRが空でした'); return; }
  document.getElementById('kanri').value = v;
  loadDevice(v);
}

/* ---------- 写真から読む ---------- */
function pickQrPhoto(){ document.getElementById('qrFile').click(); }

function onQrPhoto(input){
  var f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  loadImage(f).then(function(im){
    var w = im.width || im.naturalWidth, h = im.height || im.naturalHeight;
    var sc = Math.min(1, 1000 / Math.max(w, h));
    var cw = Math.round(w * sc), ch = Math.round(h * sc);
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(im, 0, 0, cw, ch);
    var d = cx.getImageData(0, 0, cw, ch);

    var code = jsQR(d.data, cw, ch, { inversionAttempts:'attemptBoth' });
    if (!code){
      binarize_(d.data);
      cx.putImageData(d, 0, 0);
      code = jsQR(d.data, cw, ch, { inversionAttempts:'attemptBoth' });
    }
    if (code && code.data) handleScan(code.data);
    else err('QRコードを読み取れませんでした。少し距離を取って撮ってみてね');
  }).catch(function(){ err('📷 写真を読み込めませんでした'); });
}

function binarize_(data){
  var hist = new Array(256).fill(0), i;
  for (i = 0; i < data.length; i += 4){
    var g = (data[i]*299 + data[i+1]*587 + data[i+2]*114) / 1000 | 0;
    data[i] = data[i+1] = data[i+2] = g;
    hist[g]++;
  }
  var total = data.length / 4, sum = 0;
  for (i = 0; i < 256; i++) sum += i * hist[i];
  var sumB = 0, wB = 0, best = 0, th = 128;
  for (i = 0; i < 256; i++){
    wB += hist[i]; if (!wB) continue;
    var wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    var mB = sumB / wB, mF = (sum - sumB) / wF;
    var between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best){ best = between; th = i; }
  }
  for (i = 0; i < data.length; i += 4){
    var v = data[i] > th ? 255 : 0;
    data[i] = data[i+1] = data[i+2] = v;
  }
}

// iPhoneの写真はcanvasに描くと横倒しになるので、向きを直してから使う
function loadImage(file){
  if (window.createImageBitmap){
    try {
      return createImageBitmap(file, { imageOrientation:'from-image' })
        .catch(function(){ return loadImagePlain(file); });
    } catch(e){ /* 下へ */ }
  }
  return loadImagePlain(file);
}
function loadImagePlain(file){
  return new Promise(function(res, rej){
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function(){ res(img); URL.revokeObjectURL(url); };
    img.onerror = function(){ rej(new Error('画像を読めません')); };
    img.src = url;
  });
}

/* ---------- 機器読み込み ---------- */
function findByInput(){
  var v = document.getElementById('kanri').value.trim();
  if (!v) { err('🏷 管理番号を入力してね'); return; }
  loadDevice(v);
}

function loadDevice(kanriNo, silent){
  var key = String(kanriNo == null ? '' : kanriNo).trim().toUpperCase();
  if (!key){ show('vFind'); return; }

  var el = document.getElementById('btnFind');
  busy(true, el);
  api('/api/device/' + encodeURIComponent(key))
    .then(function(ctx){
      busy(false, el);
      S.ctx = ctx;
      S.editHid = ''; S.editKind = '';
      S.files = []; S.photos = [];
      renderDevice();
      show('vMain');
      loadFileList();
    })
    .catch(function(e){
      busy(false, el);
      if (e.message === 'AUTH') return;
      show('vFind');
      if (!silent) err(e.message);
    });
}

/* ---------- 機器カード ---------- */
function renderDevice(){
  var d = S.ctx.device;
  document.getElementById('devName').textContent = d.name;
  document.getElementById('devNo').textContent   = '🏷 ' + d.kanriNo;
  var st = document.getElementById('devStatus');
  st.textContent = (d.status === '稼働中' ? '✅ ' : '🔧 ') + d.status;
  st.className = 'badge ' + (d.status === '稼働中' ? 'ok' : 'ng');

  document.getElementById('devBody').innerHTML =
      '<dt>🗂 機器区分</dt><dd>' + esc(d.category) + '</dd>'
    + '<dt>🏭 メーカー</dt><dd>' + esc(d.maker) + ' 🔤 ' + esc(d.model) + '</dd>'
    + '<dt>📍 設置場所</dt><dd>🏥 ' + esc(d.site) + ' 🏢 ' + esc(d.dept)
    +   '<br>📦 ' + esc(d.loc) + '</dd>'
    + '<dt>🗓 前回点検</dt><dd>'
    +   (S.ctx.lastDate ? '✅ ' + S.ctx.lastDate : '🆕 まだ記録なし') + '</dd>';

  // 代表写真。無い機器では 404 が返るので、その場で枠ごと消す
  var host = document.getElementById('devThumbHost');
  host.className = 'hide';
  host.innerHTML = '<img src="/api/thumb/' + encodeURIComponent(d.kanriNo)
                 + '" alt="機器の写真" onclick="openThumb()"'
                 + ' onload="this.parentNode.className=\'\'"'
                 + ' onerror="this.parentNode.className=\'hide\';this.remove()">';

  renderUsers();
  MODE = 'inspect';
  renderTabs();
}

function openThumb(){
  if (!S.ctx) return;
  var no = S.ctx.device.kanriNo;
  document.getElementById('viewTitle').textContent = '🖼 ' + no + ' の写真';
  document.getElementById('viewBody').innerHTML =
    '<img src="/api/thumb/' + encodeURIComponent(no)
    + '" alt="" style="width:100%;border-radius:10px">';
  document.getElementById('ovView').classList.add('on');
}
function closeView(){
  document.getElementById('ovView').classList.remove('on');
  document.getElementById('viewBody').innerHTML = '';
}

/* ---------- 実施者 ---------- */
function renderUsers(){
  var sel  = document.getElementById('user');
  var list = (S.ctx.users || []).filter(function(u){ return S.allUsers || u.mine; });
  if (!list.length) { S.allUsers = true; list = S.ctx.users || []; }

  var saved = '';
  try { saved = localStorage.getItem('mkdx_user') || ''; } catch(e){}

  sel.innerHTML = '<option value="">👇 選択してください</option>'
    + list.map(function(u){
        return '<option value="' + esc(u.id) + '"' + (u.id === saved ? ' selected' : '') + '>'
             + esc(u.name) + '（' + esc(u.dept) + '）</option>';
      }).join('');

  document.getElementById('btnAllUsers').textContent =
    S.allUsers ? '🙋 自部署のみ表示' : '👥 他部署の職員も表示';
}
function toggleUsers(){ S.allUsers = !S.allUsers; renderUsers(); }
function rememberUser(){
  var v = document.getElementById('user').value;
  try { if (v) localStorage.setItem('mkdx_user', v); } catch(e){}
}
function setUser(id){
  var sel = document.getElementById('user');
  for (var i=0; i<sel.options.length; i++){
    if (sel.options[i].value === String(id)){ sel.selectedIndex = i; return; }
  }
  if (!S.allUsers){ S.allUsers = true; renderUsers(); setUser(id); }
}

/* =============================================================
 *  書類（中身はGoogleドライブ）
 * ============================================================= */

function loadFileList(){
  var btn = document.getElementById('btnDocs');
  if (!btn || !S.ctx) return;
  btn.innerHTML = '📎 書類を読み込み中<span class="spin" style="margin-left:6px"></span>';
  api('/api/files/' + encodeURIComponent(S.ctx.device.kanriNo))
    .then(function(d){ S.files = d.files || []; updateDocsBtn(); })
    .catch(function(){ S.files = []; btn.innerHTML = '📎 書類を見る'; });
}

function updateDocsBtn(){
  var btn = document.getElementById('btnDocs');
  if (!btn) return;
  btn.innerHTML = S.files.length
    ? '📎 書類を見る（' + S.files.length + ' 件）'
    : '📎 書類を見る（🗒 まだありません）';
  btn.dataset.label = btn.innerHTML;
}

function openDocs(){
  if (!S.ctx) return;
  renderDocs();
  document.getElementById('ovDocs').classList.add('on');
}
function closeDocs(){ document.getElementById('ovDocs').classList.remove('on'); }

function renderDocs(){
  var box = document.getElementById('docsBody');
  if (!S.files.length){
    box.innerHTML = '<p class="sub center" style="padding:24px 0">'
      + '🗒 この機器の書類はまだ登録されていません。</p>';
    return;
  }
  var h = '', lastKind = '';
  S.files.forEach(function(f){
    if (f.kind !== lastKind){
      h += '<div class="doc-kind">' + esc(f.kind) + '</div>';
      lastKind = f.kind;
    }
    var ic = f.isImage ? '🖼' : (f.isPdf ? '📄' : '📎');
    // Workers が普通のファイルとして返すので、リンクで開ける
    h += '<a class="doc-row" target="_blank" rel="noopener" href="/api/file/'
       +   encodeURIComponent(f.id) + '">'
       +   '<span class="doc-ic">' + ic + '</span>'
       +   '<span class="doc-tx">'
       +     '<span class="doc-nm">' + esc(f.name) + '</span>'
       +     '<span class="sub">' + esc(f.sizeText) + '　' + esc(f.date) + '</span>'
       +   '</span>'
       + '</a>';
  });
  box.innerHTML = h;
}

/* ---------- 故障報告に添える写真 ---------- */
function pickPhoto(){ document.getElementById('photoFile').click(); }

function onPickPhoto(input){
  var files = Array.prototype.slice.call(input.files || []);
  input.value = '';
  if (!files.length) return;
  var btn = document.getElementById('btnPickPhoto');
  busy(true, btn);

  Promise.all(files.map(shrinkPhoto_)).then(function(list){
    busy(false, btn);
    list.forEach(function(p){ if (p) S.photos.push(p); });
    renderPhotos();
  }).catch(function(e){
    busy(false, btn);
    err('📷 写真を読み込めませんでした' + (e && e.message ? '（' + e.message + '）' : ''));
  });
}

// 長辺1600pxのJPEGに縮めてから送る
function shrinkPhoto_(file){
  return loadImage(file).then(function(im){
    var w0 = im.width || im.naturalWidth, h0 = im.height || im.naturalHeight;
    if (!w0 || !h0) return null;
    var sc = Math.min(1, MAX_PHOTO_SIDE / Math.max(w0, h0));
    var w = Math.round(w0 * sc), h = Math.round(h0 * sc);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var cx = c.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
    cx.drawImage(im, 0, 0, w, h);
    var dataUrl = c.toDataURL('image/jpeg', PHOTO_QUALITY);
    return {
      name: (file.name || 'photo.jpg').replace(/\.[^.]+$/, '') + '.jpg',
      mime: 'image/jpeg',
      data: dataUrl.split(',')[1],
      thumb: c.toDataURL('image/jpeg', 0.5)
    };
  });
}

function renderPhotos(){
  var box = document.getElementById('photoList');
  if (!box) return;
  if (!S.photos.length){ box.innerHTML = ''; return; }
  box.innerHTML = S.photos.map(function(p, i){
    return '<div class="thumb">'
         +   '<img src="' + p.thumb + '" alt="">'
         +   '<button type="button" class="thumb-x" onclick="removePhoto(' + i + ')">🗑</button>'
         + '</div>';
  }).join('');
}
function removePhoto(i){ S.photos.splice(i, 1); renderPhotos(); }

// 写真のファイル名。履歴IDと日付8桁を頭に付けて、あとから探しやすくする
//   例）HIS0123_20261013_image.jpg
// 同じ名前が既にあるときの連番は、保存するGAS側（filebox.gs）で付ける
function photoName_(hid, base){
  var d = stampDate_();
  return (hid ? hid + '_' : '') + (d ? d + '_' : '') + base;
}

// 日付8桁。サーバーが返した今日を優先し、無ければ端末の日付を使う
function stampDate_(){
  var t = (S.ctx && S.ctx.today) ? String(S.ctx.today) : '';
  var m = t.match(/(\d{4})\D?(\d{2})\D?(\d{2})/);
  if (m) return m[1] + m[2] + m[3];
  var n = new Date();
  return String(n.getFullYear())
       + ('0' + (n.getMonth() + 1)).slice(-2)
       + ('0' + n.getDate()).slice(-2);
}

// 履歴を登録したあとに、保留していた写真を1枚ずつ上げる
function uploadPhotos_(kanriNo, hid){
  if (!S.photos.length) return Promise.resolve({ ok:0, ng:0 });
  var list = S.photos.slice();
  var ok = 0, ng = 0;

  return list.reduce(function(chain, p){
    return chain.then(function(){
      return postJson('/api/upload', {
        kanriNo: kanriNo, kind: '機器写真',
        name: photoName_(hid, p.name), mime: p.mime, data: p.data
      }).then(function(){ ok++; }).catch(function(){ ng++; });
    });
  }, Promise.resolve()).then(function(){
    S.photos = []; renderPhotos();
    return { ok: ok, ng: ng };
  });
}

/* ---------- タブとフォーム ---------- */
function renderTabs(){
  var a = document.getElementById('formArea');
  var editing = !!S.editHid;
  var h = '';

  if (editing){
    h += '<div class="msg edit">✏️ ' + esc(S.editHid) + ' を修正しています</div>';
  } else {
    h += '<div class="tabs">'
       + '<button class="tab' + (MODE==='inspect'?' on':'') + '" onclick="setMode(\'inspect\')">✅ 点検</button>'
       + '<button class="tab' + (MODE==='trouble'?' on':'') + '" onclick="setMode(\'trouble\')">🔧 故障報告</button>'
       + '<button class="tab' + (MODE==='other'?' on':'') + '" onclick="setMode(\'other\')">💬 その他</button>'
       + '</div>';
  }

  if (MODE === 'inspect')      h += renderForm(editing);
  else if (MODE === 'other')   h += renderOther(editing);
  else                         h += renderTrouble(editing);
  a.innerHTML = h;
  markLabels(a);

  if (editing && S.last && S.last.payload){
    applyEditValues(S.last.payload);
    setUser(S.last.payload.userId);
  }
  if (MODE === 'inspect') updateJudge();
  if (MODE === 'trouble' || MODE === 'other') renderPhotos();
}

function setMode(m){ MODE = m; renderTabs(); }

function renderForm(editing){
  var ctx = S.ctx, items = ctx.items || [];
  var h = '<div class="card">';
  h += '<h2>📋 ' + esc(ctx.sheetName || '点検') + '</h2>';

  if (!items.length){
    h += '<p class="sub">🙇 この機器区分には点検項目がまだ登録されていません。'
       + '⚙️ マスタ管理画面を確認してください。</p>';
  }

  for (var i=0; i<items.length; i++){
    var it = items[i];
    var pv = (ctx.prev || {})[it.id];
    var hasPv = (pv !== undefined && pv !== null && pv !== '');

    h += '<div class="item" data-id="' + esc(it.id) + '" data-type="' + esc(it.type) + '"'
       + ' data-req="' + (it.required ? '1' : '0') + '">';
    h += '<div class="item-ttl">' + esc(it.name)
       + (it.required ? '<span class="req">❗必須</span>' : '') + '</div>';
    if (it.note) h += '<div class="sub">💡 ' + esc(it.note) + '</div>';

    if (it.type === '○×'){
      h += '<div class="seg">'
         + '<button type="button" class="seg-b ok" onclick="pick(this,\'○\')">⭕️</button>'
         + '<button type="button" class="seg-b ng" onclick="pick(this,\'×\')">❌</button>'
         + '</div>';
    } else if (it.type === '数値'){
      h += '<input type="number" step="any" inputmode="decimal" class="val">';
    } else if (it.type === '日付'){
      h += '<input type="month" class="val">';
    } else {
      h += '<input type="text" class="val">';
    }

    if (hasPv && !editing) h += '<div class="prev">🕘 前回 : ' + esc(pv) + '</div>';
    h += '</div>';
  }

  h += '<label for="memo" style="margin-top:14px">📝 備考（任意）</label>';
  h += '<textarea id="memo" rows="2"></textarea>';
  h += '<div id="judgeBox" class="sub" style="margin:10px 0 2px"></div>';
  h += '<button class="btn' + (editing?' btn-pink':'') + '" id="btnSend" onclick="sendInspection()">'
     + (editing ? '💾 修正を保存する' : '✅ 点検を登録する') + '</button>';
  if (editing){
    h += '<button class="btn-sub" style="margin-top:8px" onclick="cancelEdit()">↩️ やめる</button>';
  }
  h += '</div>';
  return h;
}

function renderTrouble(editing){
  var h = '<div class="card">';
  h += '<h2>🔧 故障報告</h2>';
  if (!editing){
    h += '<p class="sub">🚦 登録すると機器のステータスが「故障中」になります。</p>';
    h += '<p class="sub" style="margin-top:4px">💬 まだ使えるけど気になる、くらいなら '
       + '<button type="button" class="btn-link" style="display:inline;padding:0" '
       + 'onclick="setMode(\'other\')">その他報告</button> へ</p>';
  }
  h += '<label for="trouble" style="margin-top:10px">😢 故障の内容</label>';
  h += '<textarea id="trouble" rows="4" placeholder="例）カフの加圧が安定しない"></textarea>';

  if (!editing){
    h += '<label style="margin-top:12px">📸 写真（任意・何枚でも）</label>';
    h += '<button type="button" class="btn-sub" id="btnPickPhoto" onclick="pickPhoto()">'
       + '📸 写真を撮る・選ぶ</button>';
    h += '<div id="photoList" class="thumbs"></div>';
    h += '<p class="sub">📂 撮った写真はこの機器の書類に「🖼 機器写真」として保存されます。</p>';
  }

  h += '<label for="tmemo" style="margin-top:10px">📝 備考（任意）</label>';
  h += '<textarea id="tmemo" rows="2"></textarea>';
  h += '<button class="btn' + (editing?' btn-pink':'') + '" id="btnTrouble" onclick="sendTrouble()" '
     + 'style="margin-top:12px">' + (editing ? '💾 修正を保存する' : '🔧 故障を報告する') + '</button>';
  if (editing){
    h += '<button class="btn-sub" style="margin-top:8px" onclick="cancelEdit()">↩️ やめる</button>';
  }
  h += '</div>';
  return h;
}

/* ---------- その他報告 ----------
 *  「使えるけど気になること」を上げる。ステータスは変えない。
 *  故障との線引きを、画面の一番上で言い切っておく
 */
var OTHER_DEFAULT = [
  { name:'付属品・消耗品',   icon:'📦', hint:'コードが無い、電極パッドが残り少ない' },
  { name:'異音・違和感',     icon:'👂', hint:'音が変、画面がちらつく（まだ使える）' },
  { name:'置き場所・ラベル', icon:'📍', hint:'台帳と場所が違う、QRが剥がれた' },
  { name:'その他',           icon:'💬', hint:'上のどれでもない' }
];
function otherKinds_(){
  var k = S.ctx && S.ctx.otherKinds;
  return (k && k.length) ? k : OTHER_DEFAULT;
}

function renderOther(editing){
  var kinds = otherKinds_();
  var h = '<div class="card">';
  h += '<h2>💬 その他報告</h2>';
  if (!editing){
    h += '<div class="msg info" style="margin:6px 0 4px">'
       + '💬 <b>使えるけど気になること</b>を伝えます。ステータスは変わりません。</div>';
    h += '<p class="sub" style="margin:0 0 6px">⚠️ 使えない・危ないときは '
       + '<button type="button" class="btn-link" style="display:inline;padding:0;color:var(--warn)" '
       + 'onclick="setMode(\'trouble\')">🔧 故障報告</button> へ</p>';
  }

  h += '<label style="margin-top:10px">🗂 分類</label>';
  h += '<div class="seg" id="otherCat" data-value="" '
     + 'style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
  kinds.forEach(function(k){
    h += '<button type="button" class="seg-b ok" data-cat="' + esc(k.name) + '" '
       + 'style="font-size:14px;padding:12px 6px;line-height:1.35;word-break:keep-all" '
       + 'onclick="pickCat(this)">' + esc(k.icon) + ' ' + esc(k.name) + '</button>';
  });
  h += '</div>';
  h += '<p class="sub" id="otherHint" style="margin:6px 0 0">👆 近いものを1つ選んでね</p>';

  h += '<label for="otherText" style="margin-top:10px">✍️ 内容</label>';
  h += '<textarea id="otherText" rows="3" placeholder="分類を選ぶと例が出ます"></textarea>';

  if (!editing){
    h += '<label style="margin-top:12px">📸 写真（任意・何枚でも）</label>';
    h += '<button type="button" class="btn-sub" id="btnPickPhoto" onclick="pickPhoto()">'
       + '📸 写真を撮る・選ぶ</button>';
    h += '<div id="photoList" class="thumbs"></div>';
    h += '<p class="sub">📂 撮った写真はこの機器の書類に「🖼 機器写真」として保存されます。</p>';
  }

  h += '<label for="omemo" style="margin-top:10px">📝 備考（任意）</label>';
  h += '<textarea id="omemo" rows="2"></textarea>';
  h += '<button class="btn' + (editing?' btn-pink':'') + '" id="btnOther" onclick="sendOther()" '
     + 'style="margin-top:12px">' + (editing ? '💾 修正を保存する' : '💬 その他報告を送る') + '</button>';
  if (editing){
    h += '<button class="btn-sub" style="margin-top:8px" onclick="cancelEdit()">↩️ やめる</button>';
  }
  h += '</div>';
  return h;
}

// 分類ボタン。選んだら例文を入力欄の薄い字に出す
function pickCat(btn){
  var box = document.getElementById('otherCat');
  if (!box) return;
  box.querySelectorAll('.seg-b').forEach(function(b){ b.classList.remove('on'); });
  btn.classList.add('on');
  box.dataset.value = btn.dataset.cat;

  var k = null, list = otherKinds_();
  for (var i = 0; i < list.length; i++){ if (list[i].name === btn.dataset.cat){ k = list[i]; break; } }
  var hint = document.getElementById('otherHint');
  var ta = document.getElementById('otherText');
  if (k && hint) hint.textContent = '💡 例）' + k.hint;
  if (k && ta)   ta.placeholder  = '例）' + k.hint;
}

function setCat_(name){
  var box = document.getElementById('otherCat');
  if (!box) return;
  var hit = box.querySelector('.seg-b[data-cat="' + String(name).replace(/"/g, '') + '"]');
  if (hit) pickCat(hit);
}

function applyEditValues(pl){
  if (MODE === 'other'){
    setCat_(pl.category || '');
    var ot = document.getElementById('otherText');
    var om = document.getElementById('omemo');
    if (ot) ot.value = pl.text || '';
    if (om) om.value = pl.memo || '';
    return;
  }
  if (MODE === 'trouble'){
    var t = document.getElementById('trouble');
    var m = document.getElementById('tmemo');
    if (t) t.value = pl.trouble || '';
    if (m) m.value = pl.memo || '';
    return;
  }
  (pl.results || []).forEach(function(r){
    var box = document.querySelector('.item[data-id="' + r.id + '"]');
    if (!box) return;
    if (box.dataset.type === '○×'){
      box.querySelectorAll('.seg-b').forEach(function(b){
        b.classList.toggle('on',
          (b.classList.contains('ok') && r.value === '○') ||
          (b.classList.contains('ng') && r.value === '×'));
      });
    } else {
      var inp = box.querySelector('.val');
      if (inp) inp.value = r.value;
    }
  });
  var mm = document.getElementById('memo');
  if (mm) mm.value = pl.memo || '';
}

/* ---------- 入力 ---------- */
function pick(btn, v){
  var box = btn.closest('.item');
  box.querySelectorAll('.seg-b').forEach(function(b){ b.classList.remove('on'); });
  btn.classList.add('on');
  box.classList.remove('miss');
  updateJudge();
}

function collect(){
  var results = [], miss = [];
  document.querySelectorAll('#formArea .item').forEach(function(box){
    var id = box.dataset.id, type = box.dataset.type, req = box.dataset.req === '1';
    var v = '';
    if (type === '○×'){
      var on = box.querySelector('.seg-b.on');
      v = on ? (on.classList.contains('ok') ? '○' : '×') : '';
    } else {
      var inp = box.querySelector('.val');
      v = inp ? String(inp.value).trim() : '';
    }
    box.classList.toggle('miss', req && v === '');
    if (req && v === '') miss.push(box.querySelector('.item-ttl').textContent.replace('❗必須',''));
    if (v !== '') results.push({ id: id, value: v });
  });
  return { results: results, miss: miss };
}

function updateJudge(){
  var box = document.getElementById('judgeBox');
  if (!box) return;
  var ng = false;
  document.querySelectorAll('#formArea .item').forEach(function(b){
    var on = b.querySelector('.seg-b.on');
    if (on && on.classList.contains('ng')) ng = true;
  });
  box.innerHTML = '⚖️ 総合判定 : <span class="badge ' + (ng?'ng':'ok') + '">'
                + (ng ? '❌ NG' : '✅ OK') + '</span>'
                + (ng ? ' <span class="sub">❌があるため</span>' : '');
}

/* ---------- 送信 ---------- */
function sendInspection(){
  var user = document.getElementById('user').value;
  if (!user){ err('実施者を選んでね🙋'); return; }

  var c = collect();
  if (c.miss.length){ err('✍️ 未入力があります : ' + c.miss.join('、')); return; }
  if (!c.results.length){ err('📋 点検結果が入力されていません'); return; }

  var payload = {
    kanriNo: S.ctx.device.kanriNo,
    userId : user,
    results: c.results,
    memo   : (document.getElementById('memo') || {}).value || ''
  };
  var el = document.getElementById('btnSend');
  var wasEdit = !!S.editHid;
  busy(true, el);

  var req = (wasEdit && S.editKind === 'inspect')
    ? postJson('/api/history/' + encodeURIComponent(S.editHid) + '/inspection', payload, 'PUT')
    : postJson('/api/inspection', payload);

  req.then(function(r){
    busy(false, el);
    S.last = { kind:'inspect', hid:r.id, payload:payload };
    S.editHid = ''; S.editKind = '';
    done('🎉', wasEdit ? '💾 修正を保存しました' : '✅ 点検を登録しました',
         '🆔 ' + r.id + '　⚖️ 総合判定 ' + (r.judge === 'NG' ? '❌ NG' : '✅ OK'));
  }).catch(function(e){
    busy(false, el);
    if (e.message !== 'AUTH') err(e.message);
  });
}

function sendTrouble(){
  var user = document.getElementById('user').value;
  if (!user){ err('報告者を選んでね🙋'); return; }
  var tx = document.getElementById('trouble').value.trim();
  if (!tx){ err('✍️ 故障の内容を入力してね'); return; }

  var payload = {
    kanriNo: S.ctx.device.kanriNo,
    userId : user,
    trouble: tx,
    memo   : (document.getElementById('tmemo') || {}).value || ''
  };
  var el = document.getElementById('btnTrouble');
  var wasEdit = !!S.editHid;
  var nPhoto  = S.photos.length;
  busy(true, el);

  var req = (wasEdit && S.editKind === 'trouble')
    ? postJson('/api/history/' + encodeURIComponent(S.editHid) + '/trouble', payload, 'PUT')
    : postJson('/api/trouble', payload);

  req.then(function(r){
    if (!wasEdit && nPhoto){
      el.innerHTML = '<span class="spin"></span>📸 写真を保存中…';
      return uploadPhotos_(payload.kanriNo, r.id).then(function(u){ return [r, u]; });
    }
    return [r, { ok:0, ng:0 }];
  }).then(function(pair){
    var r = pair[0], u = pair[1];
    busy(false, el);
    S.last = { kind:'trouble', hid:r.id, payload:payload };
    S.editHid = ''; S.editKind = '';
    if (S.ctx && S.ctx.device && r.status) S.ctx.device.status = r.status;

    var body = '🆔 ' + r.id
             + (r.status ? '　🚦 ステータスを「' + r.status + '」にしました' : '');
    if (u.ok) body += '　📸 写真 ' + u.ok + ' 枚を添付';
    if (u.ng) body += '（⚠️ ' + u.ng + ' 枚は失敗）';
    done('🔧', wasEdit ? '💾 修正を保存しました' : '🔧 故障を報告しました', body);
    loadFileList();
  }).catch(function(e){
    busy(false, el);
    if (e.message !== 'AUTH') err(e.message);
  });
}

function sendOther(){
  var user = document.getElementById('user').value;
  if (!user){ err('報告者を選んでね🙋'); return; }
  var cat = (document.getElementById('otherCat') || { dataset:{} }).dataset.value || '';
  if (!cat){ err('🗂 分類を選んでね'); return; }
  var tx = document.getElementById('otherText').value.trim();
  if (!tx){ err('✍️ 内容を入力してね'); return; }

  var payload = {
    kanriNo : S.ctx.device.kanriNo,
    userId  : user,
    category: cat,
    text    : tx,
    memo    : (document.getElementById('omemo') || {}).value || ''
  };
  var el = document.getElementById('btnOther');
  var wasEdit = !!S.editHid;
  var nPhoto  = S.photos.length;
  busy(true, el);

  var req = (wasEdit && S.editKind === 'other')
    ? postJson('/api/history/' + encodeURIComponent(S.editHid) + '/other', payload, 'PUT')
    : postJson('/api/other', payload);

  req.then(function(r){
    if (!wasEdit && nPhoto){
      el.innerHTML = '<span class="spin"></span>📸 写真を保存中…';
      return uploadPhotos_(payload.kanriNo, r.id).then(function(u){ return [r, u]; });
    }
    return [r, { ok:0, ng:0 }];
  }).then(function(pair){
    var r = pair[0], u = pair[1];
    busy(false, el);
    S.last = { kind:'other', hid:r.id, payload:payload };
    S.editHid = ''; S.editKind = '';

    var body = '🆔 ' + r.id + '　🗂 ' + cat + '　🚦 ステータスはそのまま';
    if (u.ok) body += '　📸 写真 ' + u.ok + ' 枚を添付';
    if (u.ng) body += '（⚠️ ' + u.ng + ' 枚は失敗）';
    done('💬', wasEdit ? '💾 修正を保存しました' : '💬 その他報告を送りました', body);
    loadFileList();
  }).catch(function(e){
    busy(false, el);
    if (e.message !== 'AUTH') err(e.message);
  });
}

/* ---------- 完了・修正 ---------- */
function done(emoji, title, body){
  document.getElementById('doneEmoji').textContent = emoji;
  document.getElementById('doneTitle').textContent = title;
  document.getElementById('doneBody').textContent  = body;
  show('vDone');
}

function startEdit(){
  if (!S.last || !S.last.hid){ err('🕘 修正できる記録がありません'); return; }
  S.editHid  = S.last.hid;
  S.editKind = S.last.kind;
  MODE = S.last.kind;
  show('vMain');
  renderTabs();
}

function cancelEdit(){
  S.editHid = ''; S.editKind = '';
  MODE = 'inspect';
  renderTabs();
}

function nextDevice(){
  S.editHid = ''; S.editKind = '';
  S.photos = [];
  document.getElementById('kanri').value = '';
  show('vFind');
}
`;
