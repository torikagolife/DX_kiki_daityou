/*** 医療機器DX台帳 ─ 台帳ビューを Excel（xlsx）で書き出す ******************
 *  ledgerxlsx.gs
 *
 *  台帳ビューの「📥 Excel」から呼ばれます。
 *  画面でいま見えている行（絞り込み・並べ替えをそのまま）を、1枚の xlsx にして返します。
 *
 *    1. 使い捨てのスプレッドシートを作って、行を書き込む
 *       （見出しの固定・列幅・期限の色・ステータスの色もここで付ける）
 *    2. Google の書き出し（export?format=xlsx）で xlsx にする
 *    3. 使い捨てのスプレッドシートはゴミ箱へ
 *    4. 中身を base64 で画面に返す → 画面がダウンロードさせる
 *
 *  ⚠️ 台帳のスプレッドシートには何も書き込みません。
 *     使い捨てのファイルは、失敗したときも必ずゴミ箱へ入れます。
 *
 *  使っている権限（appsscript.json に入っているもの）
 *    spreadsheets / drive / script.external_request
 **********************************************************************/

const LX_TMP_PREFIX = '__台帳書き出し_';     // 使い捨てファイルの名前の頭（残ってしまったら消してよい）
const LX_MAX_ROWS   = 5000;

// 期限・ステータスの色（台帳ビューの画面と同じ系統）
const LX_COLORS = {
  over: '#ffe2de', week: '#ffe9cc', soon: '#fff5c2',
  '故障中': '#fdecea', '修理中': '#fff4e0', '貸出中': '#eef3ff', '廃棄': '#f3f4f5', '紛失': '#f3f4f5'
};

/**
 * @param {Object} p
 *   heads  : 見出しの配列
 *   keys   : 列のキーの配列（日付列の判定に使う）
 *   rows   : 行の配列（各行は heads と同じ長さの配列。文字列）
 *   marks  : [[行番号, 列番号, 'over'|'week'|'soon'], ...]（0始まり。見出しを含まない）
 *   status : 行ごとのステータス（行の色付け用）
 *   cond   : 絞り込みの説明（「条件」シートに書く）
 * @return {{name: string, mime: string, data: string}}
 */
function exportLedgerXlsx(p) {
  p = p || {};
  const heads = (p.heads || []).map(String);
  const keys  = (p.keys || []).map(String);
  const rows  = p.rows || [];
  if (!heads.length) throw new Error('見出しがありません');
  if (rows.length > LX_MAX_ROWS) throw new Error('行が多すぎます（' + LX_MAX_ROWS + '行まで）');

  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
  const ss = SpreadsheetApp.create(LX_TMP_PREFIX + stamp);
  const id = ss.getId();
  try {
    lxFill_(ss, heads, keys, rows, p.marks || [], p.status || [], String(p.cond || ''));
    SpreadsheetApp.flush();

    const res = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const type = String(res.getHeaders()['Content-Type'] || res.getHeaders()['content-type'] || '');
    if (code !== 200) throw new Error('Excel に書き出せませんでした（HTTP ' + code + '）');
    if (type.indexOf('text/html') >= 0) throw new Error('Excel の代わりにHTMLが返ってきました。権限を承認し直してください');

    const day = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    return {
      name: '医療機器管理台帳_' + day + (p.filtered ? '_絞り込み' : '') + '.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: Utilities.base64Encode(res.getBlob().getBytes())
    };
  } finally {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* 消せなくても書き出しは済んでいる */ }
  }
}

// 'yyyy/MM/dd' を Date に（Excel で日付として並べ替え・絞り込みできるように）
function lxDate_(s) {
  const m = String(s || '').match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function lxFill_(ss, heads, keys, rows, marks, status, cond) {
  const sh = ss.getSheets()[0];
  sh.setName('医療機器管理台帳');
  const nc = heads.length, nr = rows.length;

  // 新しいシートは1000行×26列。足りなければ先に増やす
  if (sh.getMaxRows() < nr + 1) sh.insertRowsAfter(sh.getMaxRows(), nr + 1 - sh.getMaxRows());
  if (sh.getMaxColumns() < nc) sh.insertColumnsAfter(sh.getMaxColumns(), nc - sh.getMaxColumns());

  // 日付の列は日付として、それ以外は文字のまま（製造番号の先頭の0などが消えないように）
  const dateCol = keys.map(function (k) { return /^(lastDept|nextDept|lastMaker|nextMaker)$/.test(k); });
  const numCol  = keys.map(function (k) { return k === 'years'; });

  const fmts = [], vals = [];
  rows.forEach(function (r) {
    const fr = [], vr = [];
    for (let c = 0; c < nc; c++) {
      const v = r[c] == null ? '' : String(r[c]);
      if (dateCol[c]) {
        const d = lxDate_(v);
        fr.push('yyyy/mm/dd'); vr.push(d || v);
      } else if (numCol[c] && v !== '' && !isNaN(Number(v))) {
        fr.push('0'); vr.push(Number(v));
      } else {
        fr.push('@'); vr.push(v);
      }
    }
    fmts.push(fr); vals.push(vr);
  });

  // 見出し
  sh.getRange(1, 1, 1, nc).setValues([heads])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#14486e')
    .setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 30);

  if (nr) {
    const rg = sh.getRange(2, 1, nr, nc);
    rg.setNumberFormats(fmts);
    rg.setValues(vals);

    // 色：まずステータスで行を塗り、その上に期限の色を重ねる
    const bg = [];
    for (let i = 0; i < nr; i++) {
      const c0 = LX_COLORS[String(status[i] || '')] || null;
      const row = [];
      for (let c = 0; c < nc; c++) row.push(c0);
      bg.push(row);
    }
    marks.forEach(function (m) {
      const i = Number(m[0]), c = Number(m[1]);
      if (i >= 0 && i < nr && c >= 0 && c < nc && LX_COLORS[m[2]]) bg[i][c] = LX_COLORS[m[2]];
    });
    rg.setBackgrounds(bg);
    rg.setVerticalAlignment('middle');
  }

  // 見出しと左2列（管理番号・機器名）を固定。並べ替え用のフィルタも付けておく
  sh.setFrozenRows(1);
  sh.setFrozenColumns(Math.min(2, nc));
  sh.getRange(1, 1, Math.max(1, nr + 1), nc).createFilter();
  for (let c = 1; c <= nc; c++) sh.autoResizeColumn(c);
  for (let c = 1; c <= nc; c++) {
    const w = sh.getColumnWidth(c);
    sh.setColumnWidth(c, Math.min(Math.max(w + 16, 70), 320));
  }

  // 余った行・列を消して、軽くする
  const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
  if (maxR > nr + 1) sh.deleteRows(nr + 2, maxR - nr - 1);
  if (maxC > nc) sh.deleteColumns(nc + 1, maxC - nc);

  // 条件シート
  const info = ss.insertSheet('条件');
  const at = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  info.getRange(1, 1, 5, 2).setValues([
    ['出力日時', at],
    ['件数', nr + ' 件'],
    ['絞り込み', cond || 'なし（全件）'],
    ['色', '赤＝点検期限切れ　オレンジ＝7日以内　黄＝期限が近い（周期の4分の1・最短7日・最長60日）'],
    ['出典', '医療機器DX台帳 台帳ビュー'],
  ]).setNumberFormat('@');
  info.getRange(1, 1, 5, 1).setFontWeight('bold');
  info.setColumnWidth(1, 90);
  info.setColumnWidth(2, 640);
  ss.setActiveSheet(sh);
}
