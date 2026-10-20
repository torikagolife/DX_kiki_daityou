/*** 医療機器DX台帳 ─ 診断・ログ ********************************
 *  diag.gs
 *  エディタのログが出ない時でも __LOG シートに残す
 ****************************************************************/

const LOG_SHEET = '__LOG';

/* ---------- ログ ---------- */

function logSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['日時', '種別', '内容']]);
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 150);
    sh.setColumnWidth(2, 70);
    sh.setColumnWidth(3, 800);
  }
  return sh;
}

// どこからでも呼べるログ。Logger と __LOG シートの両方に出す
function LOG(kind, msg) {
  const line = String(msg);
  Logger.log('[' + kind + '] ' + line);
  try {
    logSheet_().appendRow([new Date(), String(kind), line]);
  } catch (e) { /* ログ自体の失敗は無視 */ }
}

function clearLog() {
  const sh = logSheet_();
  const last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  return 'ログを消去しました';
}

// 例外を必ずログに残して投げ直す
function guard_(label, fn) {
  try {
    return fn();
  } catch (e) {
    LOG('ERR', label + ' : ' + e.message + '\n' + (e.stack || ''));
    throw e;
  }
}

/* ---------- 診断 ---------- */

function diag() {
  clearLog();
  LOG('DIAG', '=== 診断開始 ' + new Date() + ' ===');

  // 1. スプレッドシート
  try {
    const ss = ss_();
    LOG('OK', '1 スプレッドシート : ' + ss.getName() + ' / ' + ss.getId());
    LOG('OK', '1 タイムゾーン : ' + Session.getScriptTimeZone());
  } catch (e) { LOG('ERR', '1 スプレッドシート : ' + e.message); return 'NG'; }

  // 2. シートの存在とヘッダー
  const missing = [];
  for (const k in SHEET) {
    const name = SHEET[k];
    try {
      const sh = ss_().getSheetByName(name);
      if (!sh) { missing.push(name); LOG('ERR', '2 シート無し : ' + name); continue; }
      const head = header_(sh);
      LOG('OK', '2 ' + name + ' : ' + (sh.getLastRow() - 1) + '行 / [' + head.join(' | ') + ']');
    } catch (e) { LOG('ERR', '2 ' + name + ' : ' + e.message); }
  }
  if (missing.length) { LOG('ERR', '2 シート名が一致しません : ' + missing.join(', ')); return 'NG'; }

  // 3. 「有効」列の中身を文字コードで確認（〇 と ○ の取り違え検出）
  try {
    const u = readTable_(SHEET.USR).rows;
    const codes = {};
    for (let i = 0; i < u.length; i++) {
      const v = String(u[i]['有効'] || '');
      const key = v + '(U+' + (v ? v.charCodeAt(0).toString(16).toUpperCase() : '空') + ')';
      codes[key] = (codes[key] || 0) + 1;
    }
    LOG('OK', '3 ユーザーマスタ 有効列 : ' + JSON.stringify(codes));
    LOG('OK', '3 コード側の ACTIVE : ' + ACTIVE + '(U+' + ACTIVE.charCodeAt(0).toString(16).toUpperCase() + ')');
    const hit = u.filter(function (r) { return String(r['有効']) === ACTIVE; }).length;
    LOG(hit ? 'OK' : 'ERR', '3 有効なユーザー : ' + hit + '名 / 全' + u.length + '名');
  } catch (e) { LOG('ERR', '3 有効列 : ' + e.message); }

  // 4. 職員番号の型（文字列と数値の混在検出）
  try {
    const u = readTable_(SHEET.USR).rows;
    const h = readTable_(SHEET.HIS).rows;
    const t1 = {}, t2 = {};
    u.forEach(function (r) { t1[typeof r['職員番号']] = (t1[typeof r['職員番号']] || 0) + 1; });
    h.forEach(function (r) { t2[typeof r['職員番号(実施者)']] = (t2[typeof r['職員番号(実施者)']] || 0) + 1; });
    LOG('OK', '4 職員番号の型 ユーザーマスタ=' + JSON.stringify(t1) + ' 履歴=' + JSON.stringify(t2));
  } catch (e) { LOG('ERR', '4 職員番号 : ' + e.message); }

  // 5. db.gs の基本動作
  try {
    const dev = findRow(SHEET.DEV, '管理番号', 'A1403');
    LOG(dev ? 'OK' : 'ERR', '5 findRow A1403 : ' + (dev ? JSON.stringify(dev) : '見つからない'));
  } catch (e) { LOG('ERR', '5 findRow : ' + e.message + '\n' + (e.stack || '')); }

  // 6. キャッシュ
  try {
    dropCache();
    const a = getTable(SHEET.DEV).rows.length;
    const b = getTable(SHEET.DEV).rows.length;      // 2回目はキャッシュから
    LOG(a === b ? 'OK' : 'ERR', '6 キャッシュ : 直読み' + a + '行 / キャッシュ' + b + '行');
  } catch (e) { LOG('ERR', '6 キャッシュ : ' + e.message + '\n' + (e.stack || '')); }

  // 7. 辞書
  try {
    const d = dicts_();
    LOG('OK', '7 辞書 : 区分' + Object.keys(d.cat).length +
              ' / メーカー' + Object.keys(d.mkr).length +
              ' / 部署' + Object.keys(d.dept).length +
              ' / 場所' + Object.keys(d.loc).length +
              ' / 点検表' + Object.keys(d.chk).length +
              ' / ユーザー' + Object.keys(d.usr).length);
  } catch (e) { LOG('ERR', '7 辞書 : ' + e.message + '\n' + (e.stack || '')); }

  // 8. 機器 → 区分 → 点検表 → 点検項目 の一本道
  try {
    const dev   = findRow(SHEET.DEV, '管理番号', 'A1403');
    const d     = dicts_();
    const cat   = dev ? d.cat[String(dev['機器区分ID'])] : null;
    const chkId = cat ? String(cat['点検表ID'] || '') : '';
    const items = getTable(SHEET.ITM).rows.filter(function (r) {
      return String(r['点検表ID']) === chkId;
    });
    LOG('OK', '8 A1403 → ' + (dev ? dev['機器区分ID'] : '?') +
              ' → ' + (cat ? cat['機器区分名'] : '区分なし') +
              ' → ' + chkId + ' → 点検項目' + items.length + '件');
    if (!items.length) LOG('ERR', '8 点検項目が0件。点検項目マスタの点検表IDを確認');
  } catch (e) { LOG('ERR', '8 一本道 : ' + e.message + '\n' + (e.stack || '')); }

  // 9. getInspectionContext 本体
  try {
    const ctx = getInspectionContext('A1403');
    LOG('OK', '9 機器 : ' + ctx.device.name + ' / ' + ctx.device.category +
              ' / ' + ctx.device.site + ' ' + ctx.device.dept + ' ' + ctx.device.loc);
    LOG('OK', '9 点検表 : ' + ctx.sheetName + '（' + ctx.items.length + '項目）');
    for (let i = 0; i < ctx.items.length; i++) {
      const it = ctx.items[i];
      LOG('OK', '9   ' + it.type + ' : ' + it.name + (it.required ? ' *' : '') +
                '  前回=' + (ctx.prev[it.id] !== undefined ? ctx.prev[it.id] : '—'));
    }
    LOG(ctx.users.length ? 'OK' : 'ERR', '9 実施者候補 : ' + ctx.users.length + '名' +
        (ctx.users.length ? ' / 先頭 ' + ctx.users[0].name + '(' + ctx.users[0].dept + ')' : ''));
    LOG('OK', '9 前回点検 : ' + (ctx.lastDate || '記録なし'));
  } catch (e) { LOG('ERR', '9 getInspectionContext : ' + e.message + '\n' + (e.stack || '')); }

  // 10. スクリプトプロパティ（値は伏せる）
  try {
    const keys = ['SS_ID', 'INSPECT_PW', 'ADMIN_PW', 'TOKEN_SECRET'];
    const p = PropertiesService.getScriptProperties();
    const s = keys.map(function (k) {
      const v = p.getProperty(k);
      return k + '=' + (v ? '設定済み(' + v.length + '文字)' : '未設定');
    });
    LOG('OK', '10 プロパティ : ' + s.join(' / '));
  } catch (e) { LOG('ERR', '10 プロパティ : ' + e.message); }

  LOG('DIAG', '=== 診断終了 ===');
  return '完了。__LOG シートを見てください';
}

/* ---------- 全文字コードを吐く（必要な時だけ） ---------- */

function dumpActiveColumn(sheetName, colName) {
  const rows = readTable_(sheetName || SHEET.USR).rows;
  const c = colName || '有効';
  const out = rows.map(function (r, i) {
    const v = String(r[c] == null ? '' : r[c]);
    let codes = '';
    for (let k = 0; k < v.length; k++) {
      codes += 'U+' + v.charCodeAt(k).toString(16).toUpperCase() + ' ';
    }
    return (i + 2) + '行 : "' + v + '" ' + codes;
  });
  LOG('DUMP', (sheetName || SHEET.USR) + '.' + c + '\n' + out.join('\n'));
  return out.length + '行を __LOG に出しました';
}