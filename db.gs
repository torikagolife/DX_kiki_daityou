/*** 医療機器DX台帳 ─ 共通データアクセス層 **********************
 *  db.gs
 *  シートの読み書きはすべてここを通す。画面側から直接 getRange しない。
 ****************************************************************/

const SHEET = {
  DEV : '機器マスタ',
  CAT : '機器区分マスタ',
  DEPT: '部署マスタ',
  LOC : '保管場所マスタ',
  MKR : 'メーカーマスタ',
  CHK : '点検表マスタ',
  ITM : '点検項目マスタ',
  ACT : 'アクションマスタ',
  USR : 'ユーザーマスタ',
  HIS : '医療機器履歴',
  RES : '点検結果',
  VIEW: '医療機器管理台帳(View)'
};

// キャッシュ対象。履歴・点検結果は常に最新を読むので入れない
const CACHEABLE = [SHEET.DEV, SHEET.CAT, SHEET.DEPT, SHEET.LOC, SHEET.MKR,
                   SHEET.CHK, SHEET.ITM, SHEET.ACT, SHEET.USR];
const CACHE_SEC = 600;      // 10分
const CHUNK     = 90000;    // CacheService 1キーの上限(100KB)に対する余裕
const ISO_RE    = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/* ---------- シート取得 ---------- */

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('シートが見つかりません: ' + name);
  return sh;
}

function header_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
           .map(function (h) { return String(h).trim(); });
}

/* ---------- 読み込み ---------- */

// 1行目をキーにしたオブジェクト配列で返す。_row に実際の行番号が入る
function readTable_(name) {
  const sh    = sheet_(name);
  const width = sh.getLastColumn();
  const last  = sh.getLastRow();
  const head  = header_(sh);
  if (last < 2) return { header: head, rows: [] };

  const values = sh.getRange(2, 1, last - 1, width).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let empty = true;
    for (let c = 0; c < v.length; c++) if (v[c] !== '' && v[c] !== null) { empty = false; break; }
    if (empty) continue;                       // 空行は捨てる
    const o = { _row: i + 2 };
    for (let c = 0; c < head.length; c++) if (head[c]) o[head[c]] = v[c];
    rows.push(o);
  }
  return { header: head, rows: rows };
}

/* ---------- キャッシュ（90KBずつ分割して保存） ---------- */

function cachePut_(key, obj) {
  const s = JSON.stringify(obj);
  const n = Math.ceil(s.length / CHUNK);
  if (n > 8) return;                           // でかすぎる時は諦める
  const map = {};
  for (let i = 0; i < n; i++) map[key + '_' + i] = s.substring(i * CHUNK, (i + 1) * CHUNK);
  map[key + '_n'] = String(n);
  CacheService.getScriptCache().putAll(map, CACHE_SEC);
}

function cacheGet_(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(key + '_n') || 0);
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  const got = c.getAll(keys);
  let s = '';
  for (let i = 0; i < n; i++) {
    const part = got[key + '_' + i];
    if (part == null) return null;             // 1つでも欠けたら無効扱い
    s += part;
  }
  try { return reviveDates_(JSON.parse(s)); } catch (e) { return null; }
}

function cacheDrop_(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(key + '_n') || 0);
  const keys = [key + '_n'];
  for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  c.removeAll(keys);
}

// JSONを通すと Date が文字列になるので戻す
function reviveDates_(t) {
  for (let i = 0; i < t.rows.length; i++) {
    const r = t.rows[i];
    for (const k in r) if (typeof r[k] === 'string' && ISO_RE.test(r[k])) r[k] = new Date(r[k]);
  }
  return t;
}

/* ---------- 公開API ---------- */

// opt.fresh = true でキャッシュを無視
function getTable(name, opt) {
  const cacheable = CACHEABLE.indexOf(name) >= 0;
  if (cacheable && !(opt && opt.fresh)) {
    const hit = cacheGet_('tbl:' + name);
    if (hit) return hit;
  }
  const t = readTable_(name);
  if (cacheable) cachePut_('tbl:' + name, t);
  return t;
}

function dropCache(name) {
  if (name) { cacheDrop_('tbl:' + name); return; }
  for (let i = 0; i < CACHEABLE.length; i++) cacheDrop_('tbl:' + CACHEABLE[i]);
}

// 主キーで1件引く
function findRow(name, keyCol, keyVal, opt) {
  const t = getTable(name, opt);
  const s = String(keyVal);
  for (let i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][keyCol]) === s) return t.rows[i];
  }
  return null;
}

// 列の値をキーにした辞書を作る（マスタ参照用）
function indexBy(rows, keyCol) {
  const m = {};
  for (let i = 0; i < rows.length; i++) m[String(rows[i][keyCol])] = rows[i];
  return m;
}

/* ---------- 書き込み ---------- */

// objs: [{列名:値, ...}] をヘッダー順に並べて末尾へ一括追記
function appendRows(name, objs) {
  if (!objs || !objs.length) return 0;
  const sh    = sheet_(name);
  const width = sh.getLastColumn();
  const head  = header_(sh);
  const values = objs.map(function (o) {
    return head.map(function (h) {
      const v = h ? o[h] : undefined;
      return (v === undefined || v === null) ? '' : v;
    });
  });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, width).setValues(values);
  dropCache(name);
  return values.length;
}

// 主キーで1行見つけて patch の列だけ上書き
function updateRow(name, keyCol, keyVal, patch) {
  const sh    = sheet_(name);
  const width = sh.getLastColumn();
  const head  = header_(sh);
  const ki    = head.indexOf(keyCol);
  if (ki < 0) throw new Error('列が見つかりません: ' + keyCol + ' @' + name);

  const last = sh.getLastRow();
  if (last < 2) return false;

  const col = sh.getRange(2, ki + 1, last - 1, 1).getValues();
  const s = String(keyVal);
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0]) !== s) continue;
    const range = sh.getRange(i + 2, 1, 1, width);
    const cur   = range.getValues()[0];
    for (const k in patch) {
      const ci = head.indexOf(k);
      if (ci >= 0) cur[ci] = patch[k];
    }
    range.setValues([cur]);
    dropCache(name);
    return true;
  }
  return false;
}

// 指定列が値に一致する行をすべて削除（下から消す）
function deleteRowsWhere(name, col, val) {
  const sh   = sheet_(name);
  const head = header_(sh);
  const ci   = head.indexOf(col);
  if (ci < 0) throw new Error('列が見つかりません: ' + col + ' @' + name);

  const last = sh.getLastRow();
  if (last < 2) return 0;

  const vals = sh.getRange(2, ci + 1, last - 1, 1).getValues();
  const s = String(val);
  const targets = [];
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === s) targets.push(i + 2);
  }
  for (let i = targets.length - 1; i >= 0; i--) sh.deleteRow(targets[i]);
  dropCache(name);
  return targets.length;
}

/* ---------- 採番と排他 ---------- */

// 必ず withLock の中で呼ぶこと（採番だけ先にやると衝突する）
function nextId_(name, col, prefix, digits) {
  const sh   = sheet_(name);
  const head = header_(sh);
  const ci   = head.indexOf(col);
  if (ci < 0) throw new Error('列が見つかりません: ' + col + ' @' + name);

  const last = sh.getLastRow();
  let max = 0;
  if (last >= 2) {
    const vals = sh.getRange(2, ci + 1, last - 1, 1).getValues();
    for (let i = 0; i < vals.length; i++) {
      const v = String(vals[i][0] || '');
      if (v.indexOf(prefix) !== 0) continue;
      const n = parseInt(v.substring(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  let s = String(max + 1);
  while (s.length < digits) s = '0' + s;
  return prefix + s;
}

// 採番〜追記をまとめて囲む。同時送信の衝突防止
function withLock(fn, waitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 20000)) {
    throw new Error('混み合っています。少し待ってからもう一度送信してください。');
  }
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- 日付ユーティリティ ---------- */

function now_()   { return new Date(); }
function today_() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function fmtDate_(d) {
  if (!d) return '';
  return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'yyyy/MM/dd');
}

/* ---------- 動作確認 ---------- */

function selfTest() {
  const log = [];
  for (const k in SHEET) {
    const name = SHEET[k];
    try {
      const t = readTable_(name);
      log.push(name + ' : ' + t.rows.length + '行 / ' + t.header.length + '列');
    } catch (e) {
      log.push(name + ' : ✕ ' + e.message);
    }
  }
  const dev = findRow(SHEET.DEV, '管理番号', 'A1403');
  log.push('--- A1403 ---');
  log.push(dev ? (dev['機器名'] + ' / ' + dev['機器区分名'] + ' / ' + dev['部署名']) : '見つからない');
  log.push('次の履歴ID : ' + withLock(function () {
    return nextId_(SHEET.HIS, '履歴ID', 'HIS', 6);
  }));
  log.push('タイムゾーン : ' + Session.getScriptTimeZone());
  Logger.log(log.join('\n'));
}