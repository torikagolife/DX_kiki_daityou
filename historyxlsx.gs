/*** 医療機器DX台帳 ─ 履歴を Excel（xlsx）で書き出す ************************
 *  historyxlsx.gs
 *
 *  履歴画面の「📥 Excel」から呼ばれます。
 *  画面と同じ条件（管理番号・アクション・期間）で、画面の300件の制限なしに全部を書き出します。
 *
 *    シート1「履歴」     1行＝1件。部署・保管場所（その時点）、点検表、登録日時まで入れる
 *    シート2「点検結果」 書き出した履歴のうち、点検項目の結果があるものを1行＝1項目で
 *    シート3「条件」     出力日時・件数・絞り込みの条件
 *
 *  作り方は台帳ビューの書き出し（ledgerxlsx.gs）と同じです。
 *    使い捨てのスプレッドシートに書く → Google の書き出しで xlsx にする → 使い捨てはゴミ箱へ
 *  ⚠️ 台帳のスプレッドシートには何も書き込みません。
 *
 *  使っているもの（ほかのファイルにある）
 *    getHistory … 履歴画面の一覧（絞り込みを画面とまったく同じにするため、そのまま呼ぶ）
 *    getTable / SHEET … データ層
 **********************************************************************/

const HX_TMP_PREFIX = '__履歴書き出し_';    // 使い捨てファイルの名前の頭（残ってしまったら消してよい）
const HX_MAX_ROWS   = 20000;                // 履歴の上限
const HX_MAX_RES    = 50000;                // 点検結果の行の上限

const HX_COLORS = {
  ng     : '#fdecea',     // 総合判定 NG・点検項目の ×
  trouble: '#fff4e0',     // 故障報告・故障出し
  back   : '#eaf6ec',     // 故障復帰
  other  : '#eef3ff'      // その他報告
};

/**
 * @param {Object} opt  画面の絞り込み { kanriNo, actId, from, to, actName }
 * @return {{name: string, mime: string, data: string, count: number, partial: boolean}}
 */
function exportHistoryXlsx(opt) {
  opt = opt || {};
  const q = {
    kanriNo: String(opt.kanriNo || '').trim(),
    actId  : String(opt.actId || ''),
    from   : String(opt.from || ''),
    to     : String(opt.to || ''),
    limit  : HX_MAX_ROWS
  };
  const r = getHistory(q);
  const list = (r && r.rows) || [];
  const total = (r && r.total != null) ? Number(r.total) : list.length;
  if (!list.length) throw new Error('書き出す履歴がありません');

  const data = hxRows_(list);
  const filtered = !!(q.kanriNo || q.actId || q.from || q.to);
  const cond = [];
  if (q.kanriNo) cond.push('管理番号：' + q.kanriNo);
  if (q.actId)   cond.push('アクション：' + (opt.actName || q.actId));
  if (q.from || q.to) cond.push('期間：' + (q.from || '…') + ' 〜 ' + (q.to || '…'));

  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
  const ss = SpreadsheetApp.create(HX_TMP_PREFIX + stamp);
  const id = ss.getId();
  try {
    hxFillMain_(ss.getSheets()[0], data.main);
    const resShown = hxFillRes_(ss.insertSheet('点検結果'), data.res);
    hxFillInfo_(ss.insertSheet('条件'), {
      count: list.length, total: total, cond: cond.join('　／　'),
      resCount: data.res.length, resShown: resShown
    });
    ss.setActiveSheet(ss.getSheets()[0]);
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
      name: '医療機器履歴_' + day + (filtered ? '_絞り込み' : '') + '.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: Utilities.base64Encode(res.getBlob().getBytes()),
      count: list.length,
      partial: list.length < total
    };
  } finally {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* 消せなくても書き出しは済んでいる */ }
  }
}

/* =============================================================
 *  行を作る
 * ============================================================= */

function hxDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = String(v || '').trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
}

function hxIndex_(sheet, key) {
  const out = {};
  try {
    getTable(sheet, { fresh: true }).rows.forEach(function (r) { out[String(r[key])] = r; });
  } catch (e) { /* 読めなくても、その列が空になるだけ */ }
  return out;
}

function hxRows_(list) {
  const his  = hxIndex_(SHEET.HIS, '履歴ID');
  const devs = hxIndex_(SHEET.DEV, '管理番号');
  const dept = hxIndex_(SHEET.DEPT, '部署ID');
  const loc  = hxIndex_(SHEET.LOC, '保管場所ID');
  const chk  = hxIndex_(SHEET.CHK, '点検表ID');
  const itm  = hxIndex_(SHEET.ITM, '点検項目ID');

  const main = [], want = {}, order = {};
  list.forEach(function (r, i) {
    const hid = String(r.hid || '');
    const h = his[hid] || {};
    const no = String(r.kanriNo || h['管理番号'] || '');
    const dv = devs[no] || {};
    const deptId = String(h['部署ID'] || ''), locId = String(h['保管場所ID'] || ''), chkId = String(h['点検表ID'] || '');
    const actId = String(h['アクションID'] || '');
    main.push({
      hid    : hid,
      date   : hxDate_(h['実施日']) || hxDate_(r.date),
      dateTx : String(r.date || ''),
      kanriNo: no,
      name   : String(r.devName || dv['機器名'] || ''),
      cat    : String(dv['機器区分名'] || ''),
      dept   : deptId ? String((dept[deptId] || {})['部署名'] || deptId) : '',
      loc    : locId ? String((loc[locId] || {})['保管場所名'] || locId) : '',
      act    : String(r.actName || actId),
      actId  : actId,
      user   : String(r.userName || ''),
      userId : String(h['職員番号(実施者)'] == null ? '' : h['職員番号(実施者)']),
      judge  : String(r.judge || h['総合判定'] || ''),
      trouble: String(h['故障内容／対応内容'] != null && h['故障内容／対応内容'] !== '' ? h['故障内容／対応内容'] : (r.trouble || '')),
      memo   : String(h['備考'] != null && h['備考'] !== '' ? h['備考'] : (r.memo || '')),
      sheet  : chkId ? String((chk[chkId] || {})['点検表名'] || chkId) : '',
      reg    : hxDate_(h['登録日時'])
    });
    if (hid) { want[hid] = main[main.length - 1]; order[hid] = i; }
  });

  // 点検結果（書き出す履歴のぶんだけ）
  const res = [];
  try {
    getTable(SHEET.RES, { fresh: true }).rows.forEach(function (x) {
      const hid = String(x['履歴ID'] || '');
      const m = want[hid];
      if (!m) return;
      const it = itm[String(x['点検項目ID'])] || {};
      res.push({
        hid: hid, date: m.date, dateTx: m.dateTx, kanriNo: m.kanriNo, name: m.name, sheet: m.sheet,
        no: Number(it['表示順']) || 0, item: String(it['項目名'] || x['点検項目ID'] || ''),
        val: String(x['入力値'] == null ? '' : x['入力値']), ord: order[hid]
      });
    });
  } catch (e) { /* 点検結果が読めなくても、履歴だけは出す */ }
  res.sort(function (a, b) { return (a.ord - b.ord) || (a.no - b.no); });

  return { main: main, res: res };
}

/* =============================================================
 *  シートに書く
 * ============================================================= */

function hxFit_(sh, nr, nc) {
  if (sh.getMaxRows() < nr) sh.insertRowsAfter(sh.getMaxRows(), nr - sh.getMaxRows());
  if (sh.getMaxColumns() < nc) sh.insertColumnsAfter(sh.getMaxColumns(), nc - sh.getMaxColumns());
}
function hxTrim_(sh, nr, nc) {
  const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
  if (maxR > nr) sh.deleteRows(nr + 1, maxR - nr);
  if (maxC > nc) sh.deleteColumns(nc + 1, maxC - nc);
}
function hxHead_(sh, heads) {
  sh.getRange(1, 1, 1, heads.length).setValues([heads])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#14486e')
    .setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 30);
}

// 列：[見出し, 幅, 書式, 値を取る関数, 折り返すか]
const HX_MAIN_COLS = [
  ['履歴ID',          90,  '@',               function (m) { return m.hid; }],
  ['実施日',          92,  'yyyy/mm/dd',      function (m) { return m.date || m.dateTx; }],
  ['管理番号',        84,  '@',               function (m) { return m.kanriNo; }],
  ['機器名',          200, '@',               function (m) { return m.name; }, true],
  ['機器区分',        130, '@',               function (m) { return m.cat; }],
  ['部署（当時）',    110, '@',               function (m) { return m.dept; }],
  ['保管場所（当時）', 120, '@',              function (m) { return m.loc; }],
  ['アクション',      96,  '@',               function (m) { return m.act; }],
  ['実施者',          96,  '@',               function (m) { return m.user; }],
  ['職員番号',        76,  '@',               function (m) { return m.userId; }],
  ['総合判定',        64,  '@',               function (m) { return m.judge; }],
  ['故障内容／対応内容', 300, '@',            function (m) { return m.trouble; }, true],
  ['備考',            220, '@',               function (m) { return m.memo; }, true],
  ['点検表',          180, '@',               function (m) { return m.sheet; }, true],
  ['登録日時',        124, 'yyyy/mm/dd hh:mm', function (m) { return m.reg || ''; }]
];

function hxFillMain_(sh, main) {
  sh.setName('履歴');
  const cols = HX_MAIN_COLS, nc = cols.length, nr = main.length;
  hxFit_(sh, nr + 1, nc);
  hxHead_(sh, cols.map(function (c) { return c[0]; }));

  if (nr) {
    const vals = [], fmts = [], bg = [];
    main.forEach(function (m) {
      vals.push(cols.map(function (c) { const v = c[3](m); return v == null ? '' : v; }));
      fmts.push(cols.map(function (c, i) {
        // 日付が読めなかったものは文字のまま
        return (c[2] !== '@' && !(vals[vals.length - 1][i] instanceof Date)) ? '@' : c[2];
      }));
      const color = m.judge === 'NG' ? HX_COLORS.ng
        : (m.actId === 'ACT005' || m.actId === 'ACT006') ? HX_COLORS.trouble
        : m.actId === 'ACT007' ? HX_COLORS.back
        : m.actId === 'ACT012' ? HX_COLORS.other : null;
      bg.push(cols.map(function () { return color; }));
    });
    const rg = sh.getRange(2, 1, nr, nc);
    rg.setNumberFormats(fmts);
    rg.setValues(vals);
    rg.setBackgrounds(bg);
    rg.setVerticalAlignment('top');
    cols.forEach(function (c, i) {
      if (c[4]) sh.getRange(2, i + 1, nr, 1).setWrap(true);
    });
  }

  sh.setFrozenRows(1);
  sh.setFrozenColumns(4);       // 履歴ID・実施日・管理番号・機器名
  sh.getRange(1, 1, Math.max(1, nr + 1), nc).createFilter();
  cols.forEach(function (c, i) { sh.setColumnWidth(i + 1, c[1]); });
  hxTrim_(sh, nr + 1, nc);
}

function hxFillRes_(sh, res) {
  const heads = ['履歴ID', '実施日', '管理番号', '機器名', '点検表', '表示順', '点検項目', '入力値'];
  const widths = [90, 92, 84, 200, 200, 60, 320, 80];
  const nc = heads.length;
  const list = res.slice(0, HX_MAX_RES);
  const nr = list.length;
  hxFit_(sh, Math.max(2, nr + 1), nc);
  hxHead_(sh, heads);

  if (nr) {
    const vals = [], fmts = [], bg = [];
    list.forEach(function (x) {
      const d = x.date || x.dateTx;
      vals.push([x.hid, d, x.kanriNo, x.name, x.sheet, x.no || '', x.item, x.val]);
      fmts.push(['@', d instanceof Date ? 'yyyy/mm/dd' : '@', '@', '@', '@', '0', '@', '@']);
      const bad = /^(×|✕|NG|異常|不良)$/.test(x.val.trim());
      bg.push(heads.map(function (_, i) { return bad && i === 7 ? HX_COLORS.ng : null; }));
    });
    const rg = sh.getRange(2, 1, nr, nc);
    rg.setNumberFormats(fmts);
    rg.setValues(vals);
    rg.setBackgrounds(bg);
    rg.setVerticalAlignment('top');
    sh.getRange(2, 7, nr, 1).setWrap(true);
    sh.getRange(2, 8, nr, 1).setHorizontalAlignment('center');
  } else {
    sh.getRange(2, 1).setValue('（書き出した履歴に、点検項目の結果はありません）');
  }

  sh.setFrozenRows(1);
  sh.setFrozenColumns(4);
  if (nr) sh.getRange(1, 1, nr + 1, nc).createFilter();
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  hxTrim_(sh, Math.max(2, nr + 1), nc);
  return nr;
}

function hxFillInfo_(sh, o) {
  const at = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  const rows = [
    ['出力日時', at],
    ['件数', o.count + ' 件' + (o.count < o.total ? '（該当 ' + o.total + ' 件のうち、新しい順に ' + o.count + ' 件まで）' : '')],
    ['絞り込み', o.cond || 'なし（全件）'],
    ['並び', '新しい順（履歴画面と同じ）'],
    ['点検結果', o.resCount + ' 行' + (o.resShown < o.resCount ? '（' + o.resShown + ' 行まで）' : '')],
    ['色', '赤＝総合判定 NG（点検結果シートでは × など）　オレンジ＝故障報告・故障出し　緑＝故障復帰　青＝その他報告'],
    ['部署・保管場所', 'その記録をしたときの部署・保管場所（いまの場所ではありません）'],
    ['出典', '医療機器DX台帳 履歴画面']
  ];
  sh.getRange(1, 1, rows.length, 2).setValues(rows).setNumberFormat('@');
  sh.getRange(1, 1, rows.length, 1).setFontWeight('bold');
  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 640);
}
