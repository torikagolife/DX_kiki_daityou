/*** 医療機器DX台帳 ─ 書類ボックスの写真のサムネイル ************************
 *  preview.gs
 *
 *  書類ボックスの一覧で、写真を小さく並べて見せるための縮小画像を返します。
 *  （機器の「代表写真」＝ __thumb.jpg とは別物。こちらは一覧の見た目用）
 *
 *    ・Googleドライブが作っているサムネイル（getThumbnail、長辺200px前後）を使う
 *    ・ドライブがまだ作っていない（入れた直後など）ときは、元の写真が小さければそれを使う
 *    ・どちらも無理なら空を返す。画面は 🖼 アイコンのまま
 *    ・一度作ったものは6時間キャッシュに置く（代表写真と同じ）
 *
 *  使うところ
 *    台帳ビュー・マスタ管理・点検画面（GAS版） … getFilePreviews（まとめて取る）
 *    点検画面（Cloudflare版）                 … getFilePreview（1枚ずつ。<img> で直接読む）
 *
 *  ⚠️ 読むだけです。ドライブにもシートにも書き込みません。
 *     台帳のフォルダの外のファイルは返しません（fbAssertInRoot_ で確かめる）。
 *
 *  使っているもの（filebox.gs にある）
 *    fbAssertInRoot_ / FB_THUMB_CACHE_SEC / FB_CACHE_LIMIT
 **********************************************************************/

const PV_MAX_IDS   = 12;            // 1回に取る枚数の上限（時間切れよけ）
const PV_RAW_MAX   = 300 * 1024;    // サムネイルが無いとき、元の写真をそのまま使ってよい大きさ
const PV_CACHE_PFX = 'fpv_';
const PV_NONE_SEC  = 10 * 60;       // 作れなかったことを覚えておく時間

function pvKey_(id) { return PV_CACHE_PFX + String(id); }

// 1枚ぶん。返りは dataURL か ''（作れない・写真ではない）
function pvMake_(id) {
  const f = DriveApp.getFileById(String(id));
  fbAssertInRoot_(f);                                   // 台帳の管理下のファイルだけ
  if (f.isTrashed()) return '';
  const mime = String(f.getMimeType() || '');
  if (mime.indexOf('image/') !== 0) return '';

  let blob = null;
  try { blob = f.getThumbnail(); } catch (e) { blob = null; }
  if (blob && blob.getBytes().length) {
    return 'data:' + (blob.getContentType() || 'image/png') + ';base64,'
         + Utilities.base64Encode(blob.getBytes());
  }
  // ドライブのサムネイルがまだ無いときは、元の写真が小さければそのまま使う
  if (f.getSize() <= PV_RAW_MAX) {
    return 'data:' + mime + ';base64,' + Utilities.base64Encode(f.getBlob().getBytes());
  }
  return '';
}

/**
 * まとめて取る（GAS版の画面から）
 * @param {string[]} ids  ファイルID。PV_MAX_IDS 件まで
 * @return {{map: Object<string,string>}}  id → dataURL（作れなかったものは ''）
 */
function getFilePreviews(ids) {
  const keys = [];
  (ids || []).forEach(function (x) {
    const s = String(x || '').trim();
    if (s && keys.indexOf(s) < 0 && keys.length < PV_MAX_IDS) keys.push(s);
  });
  const out = {};
  if (!keys.length) return { map: out };

  const cache = CacheService.getScriptCache();
  let hits = {};
  try { hits = cache.getAll(keys.map(pvKey_)) || {}; } catch (e) { hits = {}; }

  const put = {}, none = {};
  keys.forEach(function (id) {
    const v = hits[pvKey_(id)];
    if (v !== undefined && v !== null) { out[id] = (v === '-') ? '' : v; return; }
    let url = '';
    try { url = pvMake_(id); } catch (e) { url = ''; }
    out[id] = url;
    if (!url) none[pvKey_(id)] = '-';
    else if (url.length < FB_CACHE_LIMIT) put[pvKey_(id)] = url;   // 大きすぎるものは置かない
  });
  try { if (Object.keys(put).length) cache.putAll(put, FB_THUMB_CACHE_SEC); } catch (e) {}
  // 「作れなかった」は短めに覚える（ドライブがあとからサムネイルを作ることがあるため）
  try { if (Object.keys(none).length) cache.putAll(none, PV_NONE_SEC); } catch (e) {}
  return { map: out };
}

/**
 * 1枚だけ取る（Cloudflare版の画面から。<img src="/api/fpv/ID"> で読む）
 * @return {{ok: boolean, dataUrl?: string}}
 */
function getFilePreview(id) {
  const m = getFilePreviews([id]).map;
  const url = m[String(id)] || '';
  return url ? { ok: true, dataUrl: url } : { ok: false };
}
