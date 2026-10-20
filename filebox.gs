/*** 医療機器DX台帳 ─ ファイルBOX ******************************
 *  filebox.gs
 *  機器ごとのGoogleドライブフォルダに、取説・写真・報告書を置く。
 *
 *  現場スマホはGoogleアカウントを持たないので、ドライブの共有リンクは
 *  使えない。ファイルの中身は必ずこのGAS（＝トリさんの権限）経由で
 *  base64にして画面へ渡す。ドライブ側は非公開のままでよい。
 *
 *  ▼ サムネイル（機器の代表写真）
 *    機器フォルダの中に __thumb.jpg という決まった名前で1枚だけ置く。
 *    スプレッドシートに列を足さなくて済むのでこの方式にした。
 *    書類一覧には出さない（見た目がうるさいので除外している）。
 *    画面側で320pxに縮めてから送るので、1枚20〜40KB程度。
 ****************************************************************/

const FB_ROOT_PROP = 'DRIVE_ROOT_ID';
const FB_ROOT_NAME = '医療機器DX台帳_ファイル';

// ファイルの種別。ファイル名の先頭に [取説] のように付けて見分ける
const FILE_KINDS = ['取説', '添付文書', '機器写真', '点検記録', '修理報告', 'その他'];

const FB_MAX_UPLOAD = 12 * 1024 * 1024;   // 1ファイル12MBまで
const FB_MAX_INLINE =  8 * 1024 * 1024;   // 画面に流すのは8MBまで

// サムネイル
const FB_THUMB_BASE      = '__thumb';     // この名前で始まるファイルがサムネイル
const FB_THUMB_MAX       = 400 * 1024;    // 400KBまで（縮めて送るので充分）
const FB_THUMB_CACHE_SEC = 6 * 3600;      // キャッシュ6時間
const FB_CACHE_LIMIT     = 90000;         // CacheServiceの1件あたり上限の手前

/* =============================================================
 *  フォルダ
 * ============================================================= */

// ルートフォルダ。無ければ作ってスクリプトプロパティに覚える
function fbRoot_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(FB_ROOT_PROP);
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* 消された・権限が無い場合は作り直す */ }
  }
  const made = DriveApp.createFolder(FB_ROOT_NAME);
  props.setProperty(FB_ROOT_PROP, made.getId());
  return made;
}

// 機器のフォルダ。create=true なら無ければ作る
//   機器マスタの ファイルBOXID と突き合わせ、ズレていたら直す
function fbFolder_(kanriNo, create) {
  const key = String(kanriNo || '').trim();
  if (!key) throw new Error('管理番号が指定されていません');

  const dev = findRow(SHEET.DEV, '管理番号', key, { fresh: true });
  if (!dev) throw new Error('管理番号が見つかりません: ' + key);

  const boxId = String(dev['ファイルBOXID'] || '').trim();
  if (boxId) {
    try {
      const f = DriveApp.getFolderById(boxId);
      if (!f.isTrashed()) return f;
    } catch (e) { /* IDが古い。作り直す */ }
  }

  const root = fbRoot_();
  // 同じ名前のフォルダが既にあれば拾う（作り直しで散らからないように）
  const it = root.getFoldersByName(key);
  let folder = it.hasNext() ? it.next() : null;
  if (!folder) {
    if (!create) return null;
    folder = root.createFolder(key);
    folder.setDescription(key + ' ' + String(dev['機器名'] || ''));
  }
  updateRow(SHEET.DEV, '管理番号', key, { 'ファイルBOXID': folder.getId() });
  return folder;
}

// 速い版。サムネイルの一括取得で何十回も呼ばれるので、
// 機器マスタはキャッシュのまま読み、ファイルBOXIDがあればIDで直に開く。
// 無ければ null を返すだけ（フォルダは作らない・マスタも書き換えない）
function fbFolderFast_(kanriNo) {
  const key = String(kanriNo || '').trim();
  if (!key) return null;
  const dev = findRow(SHEET.DEV, '管理番号', key);
  if (!dev) return null;
  return fbFolderById_(String(dev['ファイルBOXID'] || '').trim());
}

function fbFolderById_(boxId) {
  const id = String(boxId || '').trim();
  if (!id) return null;
  try {
    const f = DriveApp.getFolderById(id);
    return f.isTrashed() ? null : f;
  } catch (e) { return null; }
}

// そのファイルが本当にルートフォルダ配下にあるか検証する。
// 画面から来た fileId をそのまま信じると、他のドライブファイルを
// 読み出せてしまうため、必ずこれを通す。
function fbAssertInRoot_(file) {
  const rootId = fbRoot_().getId();
  const seen = {};
  let stack = [file];
  for (let depth = 0; depth < 6 && stack.length; depth++) {
    const next = [];
    for (let i = 0; i < stack.length; i++) {
      const parents = stack[i].getParents();
      while (parents.hasNext()) {
        const p = parents.next();
        const pid = p.getId();
        if (pid === rootId) return true;
        if (!seen[pid]) { seen[pid] = 1; next.push(p); }
      }
    }
    stack = next;
  }
  throw new Error('このファイルは台帳の管理下にありません');
}

/* =============================================================
 *  一覧・取得
 * ============================================================= */

function fbParseName_(name) {
  const m = String(name).match(/^\[([^\]]+)\]\s*(.*)$/);
  if (m && FILE_KINDS.indexOf(m[1]) >= 0) return { kind: m[1], base: m[2] };
  return { kind: 'その他', base: String(name) };
}

// サムネイル用の隠しファイルかどうか
function fbIsThumbName_(name) {
  return String(name || '').indexOf(FB_THUMB_BASE) === 0;
}

// そのフォルダに同じ名前のファイルが既にあるか（ゴミ箱の中は数えない）
function fbHasName_(folder, name) {
  const it = folder.getFilesByName(name);
  while (it.hasNext()) {
    if (!it.next().isTrashed()) return true;
  }
  return false;
}

// 同じ名前が既にあれば _2 _3 … と連番を足す。
//   [機器写真] HIS0123_20261013_image.jpg
//   [機器写真] HIS0123_20261013_image_2.jpg
// iPhoneで撮るとファイル名が image.jpg で揃ってしまうので、ここで分ける
function fbUniqueName_(folder, name) {
  if (!fbHasName_(folder, name)) return name;

  const dot  = name.lastIndexOf('.');
  const stem = (dot > 0) ? name.slice(0, dot) : name;
  const ext  = (dot > 0) ? name.slice(dot)    : '';

  for (let i = 2; i <= 99; i++) {
    const cand = stem + '_' + i + ext;
    if (!fbHasName_(folder, cand)) return cand;
  }
  // 100枚以上ぶつかることは無いはずだが、念のための逃げ道
  return stem + '_' + Date.now() + ext;
}

function fbInfo_(f) {
  const p = fbParseName_(f.getName());
  const mime = f.getMimeType();
  return {
    id      : f.getId(),
    name    : p.base,
    kind    : p.kind,
    mime    : mime,
    isImage : mime.indexOf('image/') === 0,
    isPdf   : mime === 'application/pdf',
    size    : f.getSize(),
    sizeText: fbSize_(f.getSize()),
    date    : Utilities.formatDate(f.getLastUpdated(),
                Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm'),
    tooBig  : f.getSize() > FB_MAX_INLINE
  };
}

function fbSize_(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 機器のファイル一覧。フォルダが無ければ空で返す（作らない）
function listFiles(kanriNo) {
  const folder = fbFolder_(kanriNo, false);
  if (!folder) return { kanriNo: String(kanriNo), files: [], kinds: FILE_KINDS };

  const out = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (fbIsThumbName_(f.getName())) continue;   // サムネイルは一覧に出さない
    out.push(fbInfo_(f));
  }
  // 種別の並び順 → 新しい順
  out.sort(function (a, b) {
    const ka = FILE_KINDS.indexOf(a.kind), kb = FILE_KINDS.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.date < b.date ? 1 : -1;
  });
  return { kanriNo: String(kanriNo), files: out, kinds: FILE_KINDS };
}

// ファイルの中身をbase64で返す（画面で表示・ダウンロードする用）
function getFileData(fileId) {
  const f = DriveApp.getFileById(String(fileId));
  fbAssertInRoot_(f);
  if (f.getSize() > FB_MAX_INLINE) {
    throw new Error('ファイルが大きすぎます（' + fbSize_(f.getSize())
      + '）。' + fbSize_(FB_MAX_INLINE) + ' までしか開けません。');
  }
  const blob = f.getBlob();
  const p = fbParseName_(f.getName());
  return {
    id  : f.getId(),
    name: p.base,
    kind: p.kind,
    mime: blob.getContentType(),
    data: Utilities.base64Encode(blob.getBytes())
  };
}

/* =============================================================
 *  追加・更新・削除
 * ============================================================= */

// p = { kanriNo, kind, name, mime, data(base64) }
function uploadFile(p) {
  const kind = (FILE_KINDS.indexOf(p.kind) >= 0) ? p.kind : 'その他';
  const name = String(p.name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!name) throw new Error('ファイル名がありません');
  if (!p.data) throw new Error('ファイルの中身がありません');
  if (fbIsThumbName_(name)) throw new Error('この名前は使えません: ' + name);

  const bytes = Utilities.base64Decode(p.data);
  if (bytes.length > FB_MAX_UPLOAD) {
    throw new Error('ファイルが大きすぎます（' + fbSize_(bytes.length)
      + '）。' + fbSize_(FB_MAX_UPLOAD) + ' までにしてください。');
  }

  const folder = fbFolder_(p.kanriNo, true);
  const full = fbUniqueName_(folder, '[' + kind + '] ' + name);
  const blob = Utilities.newBlob(bytes, p.mime || 'application/octet-stream', full);
  const f = folder.createFile(blob);
  return fbInfo_(f);
}

function renameFile(fileId, kind, name) {
  const f = DriveApp.getFileById(String(fileId));
  fbAssertInRoot_(f);
  const k = (FILE_KINDS.indexOf(kind) >= 0) ? kind : 'その他';
  const n = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!n) throw new Error('ファイル名を入力してください');
  if (fbIsThumbName_(n)) throw new Error('この名前は使えません: ' + n);
  f.setName('[' + k + '] ' + n);
  return fbInfo_(f);
}

// ゴミ箱へ移すだけ。完全削除はしない（戻せるように）
function deleteFile(fileId) {
  const f = DriveApp.getFileById(String(fileId));
  fbAssertInRoot_(f);
  f.setTrashed(true);
  return { id: String(fileId) };
}

/* =============================================================
 *  サムネイル（機器の代表写真）
 * ============================================================= */

function fbThumbKey_(kanriNo) { return 'thm_' + String(kanriNo); }

// フォルダの中のサムネイルファイルを返す（無ければ null）
function fbThumbFile_(folder) {
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (fbIsThumbName_(f.getName())) return f;
  }
  return null;
}

function fbThumbUrl_(file) {
  const blob = file.getBlob();
  return 'data:' + blob.getContentType() + ';base64,'
       + Utilities.base64Encode(blob.getBytes());
}

// 1台ぶん。点検画面・編集ダイアログから呼ぶ
function getThumb(kanriNo) {
  const key = String(kanriNo || '').trim();
  if (!key) return { kanriNo: '', ok: false };

  const cache = CacheService.getScriptCache();
  const ck = fbThumbKey_(key);
  let hit = null;
  try { hit = cache.get(ck); } catch (e) {}
  if (hit !== null && hit !== undefined) {
    return (hit === '-') ? { kanriNo: key, ok: false }
                         : { kanriNo: key, ok: true, dataUrl: hit };
  }

  const folder = fbFolderFast_(key);
  const f = folder ? fbThumbFile_(folder) : null;
  if (!f) {
    try { cache.put(ck, '-', FB_THUMB_CACHE_SEC); } catch (e) {}
    return { kanriNo: key, ok: false };
  }

  const url = fbThumbUrl_(f);
  try {
    if (url.length < FB_CACHE_LIMIT) cache.put(ck, url, FB_THUMB_CACHE_SEC);
  } catch (e) {}
  return { kanriNo: key, ok: true, dataUrl: url, id: f.getId() };
}

// まとめて。機器マスタの一覧が画面に出た分だけ取りにくる用。
// 返りは { map: { 'A1403': 'data:image/...', 'A1404': '' } }
//   空文字 = サムネイル無し
function getThumbs(list) {
  const keys = [];
  (list || []).forEach(function (k) {
    const s = String(k || '').trim();
    if (s && keys.indexOf(s) < 0) keys.push(s);
  });
  const out = {};
  if (!keys.length) return { map: out };

  const cache = CacheService.getScriptCache();
  const cks = keys.map(fbThumbKey_);
  let hits = {};
  try { hits = cache.getAll(cks) || {}; } catch (e) { hits = {}; }

  const need = [];
  keys.forEach(function (k) {
    const v = hits[fbThumbKey_(k)];
    if (v === undefined || v === null) need.push(k);
    else out[k] = (v === '-') ? '' : v;
  });
  if (!need.length) return { map: out };

  // 機器マスタは1回だけ読む（1件ずつ findRow すると遅い）
  const box = {};
  const rows = getTable(SHEET.DEV).rows;
  for (let i = 0; i < rows.length; i++) {
    const no = String(rows[i]['管理番号'] || '').trim();
    if (no) box[no] = String(rows[i]['ファイルBOXID'] || '').trim();
  }

  const put = {};
  need.forEach(function (k) {
    let url = '';
    const folder = fbFolderById_(box[k]);
    if (folder) {
      const f = fbThumbFile_(folder);
      if (f) { try { url = fbThumbUrl_(f); } catch (e) { url = ''; } }
    }
    out[k] = url;
    // 大きすぎるものはキャッシュしない（'-' にすると無いことになってしまう）
    if (!url) put[fbThumbKey_(k)] = '-';
    else if (url.length < FB_CACHE_LIMIT) put[fbThumbKey_(k)] = url;
  });
  try { if (Object.keys(put).length) cache.putAll(put, FB_THUMB_CACHE_SEC); } catch (e) {}

  return { map: out };
}

// p = { kanriNo, mime, data(base64) }　画面側で縮めてから渡す
function setThumb(p) {
  const key = String((p && p.kanriNo) || '').trim();
  if (!key) throw new Error('管理番号が指定されていません');
  if (!p.data) throw new Error('画像がありません');

  const mime = String(p.mime || 'image/jpeg');
  if (mime.indexOf('image/') !== 0) throw new Error('画像ファイルを選んでください');

  const bytes = Utilities.base64Decode(p.data);
  if (bytes.length > FB_THUMB_MAX) {
    throw new Error('サムネイルが大きすぎます（' + fbSize_(bytes.length)
      + '）。' + fbSize_(FB_THUMB_MAX) + ' までにしてください。');
  }

  const folder = fbFolder_(key, true);

  // 既にあるサムネイルはゴミ箱へ（1台1枚にする）
  const olds = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed() && fbIsThumbName_(f.getName())) olds.push(f);
  }
  olds.forEach(function (f) { f.setTrashed(true); });

  const ext = (mime === 'image/png') ? 'png' : 'jpg';
  const made = folder.createFile(
    Utilities.newBlob(bytes, mime, FB_THUMB_BASE + '.' + ext));

  const url = 'data:' + mime + ';base64,' + p.data;
  try {
    const cache = CacheService.getScriptCache();
    if (url.length < FB_CACHE_LIMIT) cache.put(fbThumbKey_(key), url, FB_THUMB_CACHE_SEC);
    else cache.remove(fbThumbKey_(key));
  } catch (e) {}

  return { kanriNo: key, ok: true, id: made.getId(), dataUrl: url };
}

function clearThumb(kanriNo) {
  const key = String(kanriNo || '').trim();
  if (!key) throw new Error('管理番号が指定されていません');

  const folder = fbFolderFast_(key);
  let n = 0;
  if (folder) {
    const olds = [];
    const it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (!f.isTrashed() && fbIsThumbName_(f.getName())) olds.push(f);
    }
    olds.forEach(function (f) { f.setTrashed(true); n++; });
  }
  try { CacheService.getScriptCache().put(fbThumbKey_(key), '-', FB_THUMB_CACHE_SEC); } catch (e) {}
  return { kanriNo: key, ok: true, removed: n };
}

/* =============================================================
 *  まとめて整える
 * ============================================================= */

// 全機器のフォルダを作り、機器マスタのファイルBOXIDを埋める。
// 1回の実行で止まらないよう、未処理のものだけを上限件数まで進める。
function fbPrepareFolders(limit) {
  const max = Number(limit || 120);
  const devs = getTable(SHEET.DEV, { fresh: true }).rows;
  const root = fbRoot_();

  // ルート直下の既存フォルダを先に拾っておく（毎回検索すると遅い）
  const exist = {};
  const it = root.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) exist[f.getName()] = f.getId();
  }

  const sh = sheet_(SHEET.DEV);
  const head = header_(sh);
  const boxCol = head.indexOf('ファイルBOXID') + 1;
  const noCol  = head.indexOf('管理番号') + 1;
  if (!boxCol || !noCol) throw new Error('機器マスタの列が見つかりません');

  let made = 0, filled = 0, done = 0;
  for (let i = 0; i < devs.length; i++) {
    const d = devs[i];
    const no = String(d['管理番号'] || '').trim();
    if (!no) continue;

    const cur = String(d['ファイルBOXID'] || '').trim();
    if (cur) { done++; continue; }            // 既に入っている

    if (made + filled >= max) break;          // 実行時間を使い切らない

    let fid = exist[no];
    if (!fid) {
      const f = root.createFolder(no);
      f.setDescription(no + ' ' + String(d['機器名'] || ''));
      fid = f.getId();
      made++;
    } else {
      filled++;
    }
    sh.getRange(d._row, boxCol).setValue(fid);
  }
  dropCache(SHEET.DEV);

  const rest = devs.filter(function (d) {
    return String(d['管理番号'] || '').trim() && !String(d['ファイルBOXID'] || '').trim();
  }).length - (made + filled);

  const msg = 'フォルダ作成 ' + made + ' / 既存を紐付け ' + filled
            + ' / 設定済み ' + done + ' / 残り ' + Math.max(0, rest);
  Logger.log(msg);
  return msg;
}

/* =============================================================
 *  動作確認
 * ============================================================= */

function fbTest() {
  const log = [];
  const root = fbRoot_();
  log.push('ルートフォルダ : ' + root.getName() + ' / ' + root.getId());
  log.push('ドライブURL   : ' + root.getUrl());

  const no = 'A1403';
  const folder = fbFolder_(no, true);
  log.push('機器フォルダ   : ' + folder.getName() + ' / ' + folder.getId());

  // テキストを1件置いてみる
  const up = uploadFile({
    kanriNo: no, kind: '取説', name: 'テスト.txt',
    mime: 'text/plain',
    data: Utilities.base64Encode(Utilities.newBlob('動作確認', 'text/plain').getBytes())
  });
  log.push('アップロード   : ' + up.kind + ' / ' + up.name + ' / ' + up.sizeText);

  const list = listFiles(no);
  log.push('一覧          : ' + list.files.length + '件');
  for (let i = 0; i < list.files.length; i++) {
    const f = list.files[i];
    log.push('   [' + f.kind + '] ' + f.name + '  ' + f.sizeText + '  ' + f.date);
  }

  const got = getFileData(up.id);
  log.push('読み出し      : ' + got.mime + ' / '
    + Utilities.newBlob(Utilities.base64Decode(got.data)).getDataAsString());

  deleteFile(up.id);
  log.push('削除後        : ' + listFiles(no).files.length + '件');

  // --- サムネイル ---
  // 1×1の赤いPNGを置いて、取得・一覧に出ない・削除まで通す
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  setThumb({ kanriNo: no, mime: 'image/png', data: png });
  const t1 = getThumb(no);
  log.push('サムネイル    : ' + (t1.ok ? 'あり / ' + t1.dataUrl.length + '文字' : 'なし'));
  log.push('一覧に出ない   : ' + listFiles(no).files.length + '件（0ならOK）');
  const t2 = getThumbs([no, 'ZZZ9999']);
  log.push('一括取得      : ' + no + '=' + (t2.map[no] ? 'あり' : 'なし')
    + ' / ZZZ9999=' + (t2.map['ZZZ9999'] ? 'あり' : 'なし'));
  clearThumb(no);
  log.push('サムネイル削除 : ' + (getThumb(no).ok ? 'まだある(NG)' : 'なし(OK)'));

  const dev = findRow(SHEET.DEV, '管理番号', no, { fresh: true });
  log.push('機器マスタのファイルBOXID : ' + dev['ファイルBOXID']);

  Logger.log(log.join('\n'));
}
