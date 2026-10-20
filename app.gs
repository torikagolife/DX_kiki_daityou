/*** 医療機器DX台帳 ─ ドメイン層 ********************************
 *  app.gs
 *  FV列の解決・波及更新・点検登録・故障報告・修正
 ****************************************************************/

const ACT_INSPECT = 'ACT002';   // 部署点検
const ACT_TROUBLE = 'ACT005';   // 故障報告
const ACT_OTHER   = 'ACT012';   // その他報告（ステータスは変えない）
const ST_TROUBLE  = '故障中';
const ACTIVE      = '〇';

// その他報告の分類。点検画面・履歴画面・LINE WORKS通知で同じものを使う。
// 並び順がそのまま画面の並び順になる
const OTHER_KINDS = [
  { name: '付属品・消耗品',   icon: '📦', hint: 'コードが無い、電極パッドが残り少ない' },
  { name: '異音・違和感',     icon: '👂', hint: '音が変、画面がちらつく（まだ使える）' },
  { name: '置き場所・ラベル', icon: '📍', hint: '台帳と場所が違う、QRが剥がれた' },
  { name: 'その他',           icon: '💬', hint: '上のどれでもない' }
];

function otherKind_(name) {
  const n = String(name || '').trim();
  for (let i = 0; i < OTHER_KINDS.length; i++) {
    if (OTHER_KINDS[i].name === n) return OTHER_KINDS[i];
  }
  return null;
}

// 履歴の「故障内容／対応内容」には、分類を頭に付けて1列で持つ。
// 列を増やさずに済み、あとで [付属品・消耗品] で絞り込める
function otherText_(category, text) {
  return '[' + String(category) + '] ' + String(text || '').trim();
}

/* =============================================================
 *  FV列の解決
 * ============================================================= */

function fillDeviceFv_(dev, dic) {
  const cat = dic.cat[String(dev['機器区分ID'])];
  const mkr = dic.mkr[String(dev['メーカーID'])];
  const dep = dic.dept[String(dev['部署ID'])];
  const loc = dic.loc[String(dev['保管場所ID'])];
  dev['機器区分名']  = cat ? cat['機器区分名']  : '';
  dev['メーカー名']  = mkr ? mkr['メーカー名']  : '';
  dev['部署名']      = dep ? dep['部署名']      : '';
  dev['保管場所名']  = loc ? loc['保管場所名']  : '';
  dev['拠点']        = loc ? loc['拠点']        : '';
  return dev;
}

function fillLocFv_(loc, dic) {
  const dep = dic.dept[String(loc['部署ID'])];
  loc['部署名'] = dep ? dep['部署名'] : '';
  return loc;
}

function fillUserFv_(usr, dic) {
  const dep = dic.dept[String(usr['部署ID'])];
  usr['部署名'] = dep ? dep['部署名'] : '';
  return usr;
}

function dicts_(fresh) {
  const o = fresh ? { fresh: true } : undefined;
  return {
    cat : indexBy(getTable(SHEET.CAT,  o).rows, '機器区分ID'),
    mkr : indexBy(getTable(SHEET.MKR,  o).rows, 'メーカーID'),
    dept: indexBy(getTable(SHEET.DEPT, o).rows, '部署ID'),
    loc : indexBy(getTable(SHEET.LOC,  o).rows, '保管場所ID'),
    chk : indexBy(getTable(SHEET.CHK,  o).rows, '点検表ID'),
    usr : indexBy(getTable(SHEET.USR,  o).rows, '職員番号')
  };
}

/* =============================================================
 *  波及更新
 * ============================================================= */

function refreshFv_(sheetName, specs) {
  const sh   = sheet_(sheetName);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const head = header_(sh);

  for (let s = 0; s < specs.length; s++) {
    const sp = specs[s];                       // {key, fv, dict, from}
    const ki = head.indexOf(sp.key);
    const fi = head.indexOf(sp.fv);
    if (ki < 0 || fi < 0) continue;

    const keys = sh.getRange(2, ki + 1, last - 1, 1).getValues();
    const out  = keys.map(function (r) {
      const src = sp.dict[String(r[0])];
      return [src ? src[sp.from] : ''];
    });
    sh.getRange(2, fi + 1, out.length, 1).setValues(out);
  }
  dropCache(sheetName);
  return last - 1;
}

function refreshAllFv() {
  const d = dicts_(true);
  refreshFv_(SHEET.LOC, [
    { key: '部署ID',     fv: '部署名',   dict: d.dept, from: '部署名' }
  ]);
  refreshFv_(SHEET.USR, [
    { key: '部署ID',     fv: '部署名',   dict: d.dept, from: '部署名' }
  ]);
  refreshFv_(SHEET.CAT, [
    { key: '点検表ID',   fv: '点検表名', dict: d.chk,  from: '点検表名' }
  ]);
  refreshFv_(SHEET.ITM, [
    { key: '点検表ID',   fv: '点検表名', dict: d.chk,  from: '点検表名' }
  ]);
  const d2 = dicts_(true);
  refreshFv_(SHEET.DEV, [
    { key: '機器区分ID', fv: '機器区分名', dict: d2.cat,  from: '機器区分名' },
    { key: 'メーカーID', fv: 'メーカー名', dict: d2.mkr,  from: 'メーカー名' },
    { key: '部署ID',     fv: '部署名',     dict: d2.dept, from: '部署名' },
    { key: '保管場所ID', fv: '保管場所名', dict: d2.loc,  from: '保管場所名' },
    { key: '保管場所ID', fv: '拠点',       dict: d2.loc,  from: '拠点' }
  ]);
  return 'FV列を更新しました';
}

/* =============================================================
 *  点検画面に渡すデータ
 * ============================================================= */

function getInspectionContext(kanriNo) {
  const key = String(kanriNo || '').trim();
  if (!key) throw new Error('管理番号が指定されていません');

  const dev = findRow(SHEET.DEV, '管理番号', key);
  if (!dev) throw new Error('管理番号が見つかりません: ' + key);

  const dic = dicts_();
  const cat = dic.cat[String(dev['機器区分ID'])];

  // 点検表 → 点検項目（表示順）
  const chkId = cat ? String(cat['点検表ID'] || '') : '';
  const items = getTable(SHEET.ITM).rows
    .filter(function (r) { return String(r['点検表ID']) === chkId; })
    .sort(function (a, b) { return (a['表示順'] || 0) - (b['表示順'] || 0); })
    .map(function (r) {
      return {
        id      : r['点検項目ID'],
        name    : r['項目名'],
        type    : r['入力形式'],
        required: String(r['必須']) === ACTIVE,
        note    : r['備考'] || ''
      };
    });

  // 実施者候補（有効なユーザーのみ、自部署を先頭に）
  const myDept = String(dev['部署ID'] || '');
  const users = getTable(SHEET.USR).rows
    .filter(function (r) { return String(r['有効']) === ACTIVE; })
    .map(function (r) {
      return { id: String(r['職員番号']), name: r['ユーザー名'],
               dept: r['部署名'], mine: String(r['部署ID']) === myDept };
    })
    .sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); });

  // 前回の部署点検（実施日＋項目ごとの入力値）
  let lastDate = '', lastHid = '';
  const his = getTable(SHEET.HIS, { fresh: true }).rows;
  for (let i = 0; i < his.length; i++) {
    const h = his[i];
    if (String(h['管理番号']) !== key) continue;
    if (String(h['アクションID']) !== ACT_INSPECT) continue;
    const d = h['実施日'];
    if (d && (!lastDate || new Date(d) > new Date(lastDate))) {
      lastDate = d;
      lastHid  = String(h['履歴ID']);
    }
  }

  const prev = {};
  if (lastHid) {
    const res = getTable(SHEET.RES, { fresh: true }).rows;
    for (let i = 0; i < res.length; i++) {
      if (String(res[i]['履歴ID']) === lastHid) {
        prev[String(res[i]['点検項目ID'])] = res[i]['入力値'];
      }
    }
  }

  return {
    device: {
      kanriNo : dev['管理番号'],
      name    : dev['機器名'],
      category: dev['機器区分名'],
      maker   : dev['メーカー名'],
      model   : dev['型番'],
      dept    : dev['部署名'],
      loc     : dev['保管場所名'],
      site    : dev['拠点'],
      status  : dev['ステータス']
    },
    sheetName: cat ? cat['点検表名'] : '',
    items    : items,
    users    : users,
    lastDate : fmtDate_(lastDate),
    prev     : prev,
    today    : fmtDate_(today_()),
    otherKinds: OTHER_KINDS          // その他報告の分類（点検画面のボタンになる）
  };
}

/* =============================================================
 *  判定の算出（登録・修正で共用）
 * ============================================================= */

function calcJudge_(results, manual) {
  if (manual) return manual;
  const itm = indexBy(getTable(SHEET.ITM).rows, '点検項目ID');
  for (let i = 0; i < results.length; i++) {
    const m = itm[String(results[i].id)];
    if (m && String(m['入力形式']) === '○×' && String(results[i].value) === '×') return 'NG';
  }
  return 'OK';
}

/* =============================================================
 *  登録
 * ============================================================= */

// p = {kanriNo, userId, results:[{id,value}], judge, memo}
function submitInspection(p) {
  const dev = findRow(SHEET.DEV, '管理番号', String(p.kanriNo));
  if (!dev) throw new Error('管理番号が見つかりません: ' + p.kanriNo);
  if (!p.userId) throw new Error('実施者を選択してください');

  const cat   = dicts_().cat[String(dev['機器区分ID'])];
  const chkId = cat ? cat['点検表ID'] : '';
  const judge = calcJudge_(p.results || [], p.judge);

  return withLock(function () {
    const hid = nextId_(SHEET.HIS, '履歴ID', 'HIS', 6);
    appendRows(SHEET.HIS, [{
      '履歴ID'      : hid,
      '管理番号'    : dev['管理番号'],
      'アクションID': ACT_INSPECT,
      '職員番号(実施者)': String(p.userId),
      '部署ID'      : dev['部署ID'],
      '保管場所ID'  : dev['保管場所ID'],
      '点検表ID'    : chkId,
      '登録日時'    : now_(),
      '実施日'      : today_(),
      '総合判定'    : judge,
      '備考'        : p.memo || ''
    }]);
    if (p.results && p.results.length) {
      appendRows(SHEET.RES, p.results.map(function (r) {
        return { '履歴ID': hid, '点検項目ID': r.id, '入力値': r.value };
      }));
    }
    return { id: hid, judge: judge };
  });
}

// p = {kanriNo, userId, trouble, memo}
function submitTrouble(p) {
  // キャッシュ越しだと古い行を掴むことがあるので必ず最新を読む
  const dev = findRow(SHEET.DEV, '管理番号', String(p.kanriNo), { fresh: true });
  if (!dev) throw new Error('管理番号が見つかりません: ' + p.kanriNo);
  if (!p.userId)  throw new Error('報告者を選択してください');
  if (!p.trouble) throw new Error('故障内容を入力してください');

  const res = withLock(function () {
    const hid = nextId_(SHEET.HIS, '履歴ID', 'HIS', 6);
    appendRows(SHEET.HIS, [{
      '履歴ID'      : hid,
      '管理番号'    : dev['管理番号'],
      'アクションID': ACT_TROUBLE,
      '職員番号(実施者)': String(p.userId),
      '部署ID'      : dev['部署ID'],
      '保管場所ID'  : dev['保管場所ID'],
      '登録日時'    : now_(),
      '実施日'      : today_(),
      '総合判定'    : 'NG',
      '故障内容／対応内容': p.trouble,
      '備考'        : p.memo || ''
    }]);

    // ステータス更新。失敗したら黙って見逃さず例外にする
    const ok = updateRow(SHEET.DEV, '管理番号', dev['管理番号'], { 'ステータス': ST_TROUBLE });
    if (!ok) {
      throw new Error('履歴は登録しましたが、ステータスを更新できませんでした（'
        + dev['管理番号'] + '）。管理画面で確認してください。');
    }
    dropCache(SHEET.DEV);

    return { id: hid, status: ST_TROUBLE };
  });

  // LINE WORKS の幹部ルームへ知らせる（notify.gs）。
  //   ・ロックの外で呼ぶ。送信待ちのあいだ他の人の登録を止めないため
  //   ・notifyEvent_ は中で例外を飲むので、ここが原因で故障報告が失敗することはない
  notifyEvent_(ACT_TROUBLE, {
    kanriNo: dev['管理番号'],
    hid    : res.id,
    userId : p.userId,
    text   : p.trouble,
    memo   : p.memo
  });

  return res;
}

// その他報告。「使えるけど気になること」を上げる。ステータスは変えない
// p = {kanriNo, userId, category, text, memo}
function submitOther(p) {
  const dev = findRow(SHEET.DEV, '管理番号', String(p.kanriNo), { fresh: true });
  if (!dev) throw new Error('管理番号が見つかりません: ' + p.kanriNo);
  if (!p.userId) throw new Error('報告者を選択してください');
  const kind = otherKind_(p.category);
  if (!kind) throw new Error('分類を選択してください');
  const text = String(p.text || '').trim();
  if (!text) throw new Error('内容を入力してください');

  const res = withLock(function () {
    const hid = nextId_(SHEET.HIS, '履歴ID', 'HIS', 6);
    appendRows(SHEET.HIS, [{
      '履歴ID'      : hid,
      '管理番号'    : dev['管理番号'],
      'アクションID': ACT_OTHER,
      '職員番号(実施者)': String(p.userId),
      '部署ID'      : dev['部署ID'],
      '保管場所ID'  : dev['保管場所ID'],
      '登録日時'    : now_(),
      '実施日'      : today_(),
      '総合判定'    : '',
      '故障内容／対応内容': otherText_(kind.name, text),
      '備考'        : p.memo || ''
    }]);
    // ステータスは触らない。故障中にしたいなら故障報告で上げてもらう
    return { id: hid, category: kind.name };
  });

  // LINE WORKS の幹部ルームへ知らせる（notify.gs）。ロックの外で呼ぶ
  notifyEvent_(ACT_OTHER, {
    kanriNo : dev['管理番号'],
    hid     : res.id,
    userId  : p.userId,
    category: kind.name,
    text    : text,
    memo    : p.memo
  });

  return res;
}

/* =============================================================
 *  修正（直前に登録した記録の訂正）
 * ============================================================= */

// p = {hid, userId, results:[{id,value}], judge, memo}
function updateInspection(p) {
  const hid = String(p.hid || '');
  if (!hid) throw new Error('履歴IDが指定されていません');
  if (!p.userId) throw new Error('実施者を選択してください');

  const his = findRow(SHEET.HIS, '履歴ID', hid, { fresh: true });
  if (!his) throw new Error('履歴が見つかりません: ' + hid);
  if (String(his['アクションID']) !== ACT_INSPECT) {
    throw new Error('この履歴は点検記録ではありません');
  }

  const judge = calcJudge_(p.results || [], p.judge);

  return withLock(function () {
    updateRow(SHEET.HIS, '履歴ID', hid, {
      '職員番号(実施者)': String(p.userId),
      '総合判定': judge,
      '備考'    : p.memo || ''
    });
    deleteRowsWhere(SHEET.RES, '履歴ID', hid);
    if (p.results && p.results.length) {
      appendRows(SHEET.RES, p.results.map(function (r) {
        return { '履歴ID': hid, '点検項目ID': r.id, '入力値': r.value };
      }));
    }
    return { id: hid, judge: judge };
  });
}

// p = {hid, userId, trouble, memo}
function updateTrouble(p) {
  const hid = String(p.hid || '');
  if (!hid) throw new Error('履歴IDが指定されていません');
  if (!p.userId)  throw new Error('報告者を選択してください');
  if (!p.trouble) throw new Error('故障内容を入力してください');

  const his = findRow(SHEET.HIS, '履歴ID', hid, { fresh: true });
  if (!his) throw new Error('履歴が見つかりません: ' + hid);
  if (String(his['アクションID']) !== ACT_TROUBLE) {
    throw new Error('この履歴は故障報告ではありません');
  }

  return withLock(function () {
    updateRow(SHEET.HIS, '履歴ID', hid, {
      '職員番号(実施者)': String(p.userId),
      '故障内容／対応内容': p.trouble,
      '備考': p.memo || ''
    });
    return { id: hid };
  });
}

// p = {hid, userId, category, text, memo}
// 修正では通知しない（故障報告の修正と同じ扱い）
function updateOther(p) {
  const hid = String(p.hid || '');
  if (!hid) throw new Error('履歴IDが指定されていません');
  if (!p.userId) throw new Error('報告者を選択してください');
  const kind = otherKind_(p.category);
  if (!kind) throw new Error('分類を選択してください');
  const text = String(p.text || '').trim();
  if (!text) throw new Error('内容を入力してください');

  const his = findRow(SHEET.HIS, '履歴ID', hid, { fresh: true });
  if (!his) throw new Error('履歴が見つかりません: ' + hid);
  if (String(his['アクションID']) !== ACT_OTHER) {
    throw new Error('この履歴はその他報告ではありません');
  }

  return withLock(function () {
    updateRow(SHEET.HIS, '履歴ID', hid, {
      '職員番号(実施者)': String(p.userId),
      '故障内容／対応内容': otherText_(kind.name, text),
      '備考': p.memo || ''
    });
    return { id: hid, category: kind.name };
  });
}

/* =============================================================
 *  動作確認
 * ============================================================= */

function appTest() {
  const log = [];
  const ctx = getInspectionContext('A1403');
  log.push('機器 : ' + ctx.device.name + ' / ' + ctx.device.category +
           ' / ' + ctx.device.dept + ' ' + ctx.device.loc);
  log.push('点検表 : ' + ctx.sheetName + '（' + ctx.items.length + '項目）');
  for (let i = 0; i < ctx.items.length; i++) {
    const it = ctx.items[i];
    log.push('   ' + it.type + ' : ' + it.name + (it.required ? ' *' : '') +
             '   前回=' + (ctx.prev[it.id] !== undefined ? ctx.prev[it.id] : '—'));
  }
  log.push('実施者候補 : ' + ctx.users.length + '名' +
           (ctx.users.length ? ' / 先頭 ' + ctx.users[0].name + '(' + ctx.users[0].dept + ')'
                             : '  ← 0件。ユーザーマスタの「有効」列を確認'));
  log.push('前回点検 : ' + (ctx.lastDate || '記録なし'));
  Logger.log(log.join('\n'));
}

/* =============================================================
 *  QRラベル用のデータ
 * ============================================================= */

function getQrLabelData() {
  const devs = getTable(SHEET.DEV).rows;
  const list = devs.map(function (d) {
    return {
      kanriNo : String(d['管理番号'] || ''),
      name    : String(d['機器名'] || ''),
      category: String(d['機器区分名'] || ''),
      dept    : String(d['部署名'] || ''),
      loc     : String(d['保管場所名'] || ''),
      site    : String(d['拠点'] || ''),
      status  : String(d['ステータス'] || '')
    };
  }).filter(function (d) { return d.kanriNo; });

  // 絞り込み用の選択肢（重複を除いて並べる）
  const uniq = function (arr) {
    const seen = {}, out = [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    return out.sort();
  };

  return {
    devices: list,
    depts  : uniq(list.map(function (d) { return d.dept; })),
    sites  : uniq(list.map(function (d) { return d.site; })),
    cats   : uniq(list.map(function (d) { return d.category; }))
  };
}
/* =============================================================
 *  機器の新規導入（機器マスタ＋導入履歴を同時に書く）
 * ============================================================= */

const ACT_INTRO = 'ACT001';   // 導入
const ST_ACTIVE = '稼働中';

// p = { values:{機器マスタの各列}, userId, introDate }
function registerDevice(p) {
  const v = p.values || {};
  const kanriNo = String(v['管理番号'] || '').trim();
  if (!kanriNo) throw new Error('管理番号を入力してください');
  if (!p.userId) throw new Error('登録者を選択してください');

  if (findRow(SHEET.DEV, '管理番号', kanriNo, { fresh: true })) {
    throw new Error('その管理番号は既に登録されています: ' + kanriNo);
  }

  const dic = dicts_(true);
  const dev = {};
  for (const k in v) dev[k] = v[k];
  dev['管理番号'] = kanriNo;
  if (!String(dev['ステータス'] || '').trim()) dev['ステータス'] = ST_ACTIVE;
  fillDeviceFv_(dev, dic);

  const d = p.introDate ? new Date(p.introDate) : today_();

  return withLock(function () {
    appendRows(SHEET.DEV, [dev]);

    const hid = nextId_(SHEET.HIS, '履歴ID', 'HIS', 6);
    appendRows(SHEET.HIS, [{
      '履歴ID'      : hid,
      '管理番号'    : kanriNo,
      'アクションID': ACT_INTRO,
      '職員番号(実施者)': String(p.userId),
      '部署ID'      : dev['部署ID'],
      '保管場所ID'  : dev['保管場所ID'],
      '登録日時'    : now_(),
      '実施日'      : d,
      '備考'        : '新規導入'
    }]);

    return { kanriNo: kanriNo, hid: hid };
  });
}

// 機器マスタの編集。ステータスは履歴で動かすのでここでは触らない
function updateDevice(p) {
  const v = p.values || {};
  const kanriNo = String(p.key || '').trim();
  if (!kanriNo) throw new Error('管理番号がありません');

  const cur = findRow(SHEET.DEV, '管理番号', kanriNo, { fresh: true });
  if (!cur) throw new Error('機器が見つかりません: ' + kanriNo);

  const dic = dicts_(true);
  const rec = {};
  for (const k in v) {
    if (k === '管理番号' || k === 'ステータス') continue;
    rec[k] = v[k];
  }
  // FV解決のため現在値とマージした仮レコードを作る
  const tmp = {};
  for (const k in cur) tmp[k] = cur[k];
  for (const k in rec) tmp[k] = rec[k];
  fillDeviceFv_(tmp, dic);
  rec['機器区分名'] = tmp['機器区分名'];
  rec['メーカー名'] = tmp['メーカー名'];
  rec['部署名']     = tmp['部署名'];
  rec['保管場所名'] = tmp['保管場所名'];
  rec['拠点']       = tmp['拠点'];

  return withLock(function () {
    if (!updateRow(SHEET.DEV, '管理番号', kanriNo, rec)) {
      throw new Error('更新できませんでした: ' + kanriNo);
    }
    return { kanriNo: kanriNo };
  });
}

// 機器マスタ画面を開いたときに渡す選択肢
function getDeviceContext() {
  const t = getTable(SHEET.DEV, { fresh: true });

  const opt = function (sheetName, keyCol, nameCol) {
    return getTable(sheetName, { fresh: true }).rows
      .filter(function (r) { return String(r['有効']) === ACTIVE; })
      .sort(function (a, b) { return Number(a['表示順'] || 9999) - Number(b['表示順'] || 9999); })
      .map(function (r) { return { id: String(r[keyCol]), name: String(r[nameCol] || '') }; });
  };

  const users = getTable(SHEET.USR, { fresh: true }).rows
    .filter(function (r) { return String(r['有効']) === ACTIVE; })
    .map(function (r) {
      return { id: String(r['職員番号']), name: r['ユーザー名'] + '（' + r['部署名'] + '）' };
    });

  return {
    rows: t.rows.map(function (r) {
      const o = {};
      for (const k in r) {
        if (k === '_row') continue;
        o[k] = (r[k] instanceof Date) ? fmtDate_(r[k]) : (r[k] === undefined ? '' : r[k]);
      }
      return o;
    }),
    refs: {
      cat  : opt(SHEET.CAT, '機器区分ID', '機器区分名'),
      maker: opt(SHEET.MKR, 'メーカーID', 'メーカー名'),
      dept : opt(SHEET.DEPT, '部署ID', '部署名'),
      loc  : opt(SHEET.LOC, '保管場所ID', '保管場所名'),
      user : users
    },
    today: fmtDate_(today_()).replace(/\//g, '-')
  };
}