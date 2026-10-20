/*** 医療機器DX台帳 ─ Web層 ************************************
 *  web.gs
 *  ルーティング・PW認証・クライアントから呼ぶAPI
 ****************************************************************/

const APP_NAME   = '医療機器DX台帳';
const TOKEN_DAYS = 30;

// ブラウザのタブに出すアイコン（⚡）。
// GASのウェブアプリは googleusercontent.com の iframe の中で動くので、
// HTMLに <link rel="icon"> を書いても効かない。
// 親フレームのアイコンを決められるのは setFaviconUrl() だけなので、ここで指定する。
// 画像は Cloudflare Workers 版の点検画面に置いてあるものを借りている。
// 別の場所に移したときは、スクリプトプロパティ FAVICON_URL に入れれば上書きできる。
const FAVICON_DEFAULT = 'https://mkdx-inspect.report-902.workers.dev/icon.png';

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

// 共通ナビを差し込むための include。現在ページ名を渡す
function include(name, params) {
  const t = HtmlService.createTemplateFromFile(name);
  if (params) for (const k in params) t[k] = params[k];
  return t.evaluate().getContent();
}

function appUrl_() {
  return ScriptApp.getService().getUrl();
}

/* ---------- ルーティング ---------- */

function doGet(e) {
  const p    = (e && e.parameter) ? e.parameter : {};
  const page = String(p.p || 'inspect');

  let file, title, now;
  if (page === 'admin')        { file = 'admin';    title = APP_NAME + ' 管理';     now = 'admin'; }
  else if (page === 'ledger')  { file = 'ledgers';  title = APP_NAME + ' 台帳';     now = 'ledger'; }
  else if (page === 'history') { file = 'historys'; title = APP_NAME + ' 履歴';     now = 'history'; }
  else if (page === 'qr')      { file = 'qr';       title = APP_NAME + ' QRラベル'; now = 'qr'; }
  else                         { file = 'inspect';  title = APP_NAME;               now = 'inspect'; }

  const t = HtmlService.createTemplateFromFile(file);
  // 未指定なら必ず空文字にする（"undefined" という文字列が渡らないように）
  t.initId  = (p.id  === undefined || p.id  === null) ? '' : String(p.id).trim();
  t.initHid = (p.hid === undefined || p.hid === null) ? '' : String(p.hid).trim();
  t.navUrl  = appUrl_();
  t.navNow  = now;
  const out = t.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  // アイコンの指定で転んでも画面は開けるようにしておく
  try {
    const icon = prop_('FAVICON_URL') || FAVICON_DEFAULT;
    if (icon) out.setFaviconUrl(icon);
  } catch (err) {
    Logger.log('ファビコンを設定できませんでした: ' + err);
  }

  return out;
}

/* ---------- トークン ---------- */

function sign_(s) {
  const raw = Utilities.computeHmacSha256Signature(s, prop_('TOKEN_SECRET') || 'fallback');
  return Utilities.base64EncodeWebSafe(raw);
}

function issueToken_(scope) {
  const exp  = Date.now() + TOKEN_DAYS * 24 * 3600 * 1000;
  const body = scope + '.' + exp;
  return body + '.' + sign_(body);
}

function checkToken_(token, scope) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3)            throw new Error('AUTH');
  const body = parts[0] + '.' + parts[1];
  if (parts[0] !== scope)            throw new Error('AUTH');
  if (sign_(body) !== parts[2])      throw new Error('AUTH');
  if (Number(parts[1]) < Date.now()) throw new Error('AUTH');
  return true;
}

// 点検画面（inspect）と管理画面（admin）のどちらでも通す
function checkTokenAny_(token) {
  try { checkToken_(token, 'inspect'); return 'inspect'; } catch (e) {}
  checkToken_(token, 'admin');
  return 'admin';
}

/* ---------- 認証API ---------- */

function verifyPassword(pw, scope) {
  const key = (scope === 'admin') ? 'ADMIN_PW' : 'INSPECT_PW';
  const ok  = String(pw || '').trim() === String(prop_(key)).trim();
  Utilities.sleep(400);                    // 総当たり対策のささやかな遅延
  if (!ok) return { ok: false };
  return { ok: true, token: issueToken_(scope === 'admin' ? 'admin' : 'inspect') };
}

function pingToken(token, scope) {
  try { checkToken_(token, scope || 'inspect'); return true; }
  catch (e) { return false; }
}

/* ---------- 点検画面API ---------- */

function apiGetContext(token, kanriNo) {
  checkToken_(token, 'inspect');
  return getInspectionContext(kanriNo);
}

function apiSubmitInspection(token, p) {
  checkToken_(token, 'inspect');
  return submitInspection(p);
}

function apiSubmitTrouble(token, p) {
  checkToken_(token, 'inspect');
  return submitTrouble(p);
}

function apiUpdateInspection(token, p) {
  checkToken_(token, 'inspect');
  return updateInspection(p);
}

function apiUpdateTrouble(token, p) {
  checkToken_(token, 'inspect');
  return updateTrouble(p);
}

// その他報告（ステータスは変えない）
function apiSubmitOther(token, p) {
  checkToken_(token, 'inspect');
  return submitOther(p);
}

function apiUpdateOther(token, p) {
  checkToken_(token, 'inspect');
  return updateOther(p);
}

/* ---------- QRラベル画面API（管理PW） ---------- */

function apiGetQrLabels(token) {
  checkToken_(token, 'admin');
  return getQrLabelData();
}

/* ---------- マスタ管理API（管理PW） ---------- */

function apiGetMaster(token, name) {
  checkToken_(token, 'admin');
  return getMasterContext(name);
}

function apiSaveMaster(token, p) {
  checkToken_(token, 'admin');
  return saveMaster(p);
}

function apiToggleActive(token, name, key, active) {
  checkToken_(token, 'admin');
  return toggleMasterActive(name, key, active);
}

/* ---------- 台帳ビューAPI（管理PW） ---------- */

function apiGetLedger(token) {
  checkToken_(token, 'admin');
  return getLedger();
}

/* ---------- 履歴API（管理PW） ---------- */

function apiGetHistory(token, opt) {
  checkToken_(token, 'admin');
  return getHistory(opt);
}

function apiGetHistoryDetail(token, hid) {
  checkToken_(token, 'admin');
  return getHistoryDetail(hid);
}

function apiAdminUpdateInspection(token, p) {
  checkToken_(token, 'admin');
  return updateInspection(p);
}

function apiAdminUpdateTrouble(token, p) {
  checkToken_(token, 'admin');
  return updateTrouble(p);
}

/* ---------- アクション登録API（管理PW） ---------- */

function apiGetActionContext(token) {
  checkToken_(token, 'admin');
  return getActionContext();
}

function apiFindDevice(token, kanriNo) {
  checkToken_(token, 'admin');
  return findDeviceForAction(kanriNo);
}

function apiSubmitAction(token, p) {
  checkToken_(token, 'admin');
  return submitAction(p);
}

/* ---------- ファイルBOXAPI ---------- */

// 見る・足すは現場でもできる。消す・名前を変えるのは管理者だけ
function apiListFiles(token, kanriNo) {
  checkTokenAny_(token);
  return listFiles(kanriNo);
}

function apiGetFile(token, fileId) {
  checkTokenAny_(token);
  return getFileData(fileId);
}

function apiUploadFile(token, p) {
  checkTokenAny_(token);
  return uploadFile(p);
}

function apiDeleteFile(token, fileId) {
  checkToken_(token, 'admin');
  return deleteFile(fileId);
}

function apiRenameFile(token, fileId, kind, name) {
  checkToken_(token, 'admin');
  return renameFile(fileId, kind, name);
}

function apiPrepareFolders(token, limit) {
  checkToken_(token, 'admin');
  return fbPrepareFolders(limit);
}

/* ---------- サムネイルAPI ---------- */

// 見るのは現場でもできる（点検画面で機器写真を出すため）
function apiGetThumb(token, kanriNo) {
  checkTokenAny_(token);
  return getThumb(kanriNo);
}

// 機器マスタの一覧で、画面に出た行の分だけまとめて取る
function apiGetThumbs(token, list) {
  checkTokenAny_(token);
  return getThumbs(list);
}

// 貼る・外すは管理者だけ
function apiSetThumb(token, p) {
  checkToken_(token, 'admin');
  return setThumb(p);
}

function apiClearThumb(token, kanriNo) {
  checkToken_(token, 'admin');
  return clearThumb(kanriNo);
}
