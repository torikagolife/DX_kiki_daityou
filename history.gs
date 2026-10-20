/*** 医療機器DX台帳 ─ 履歴の閲覧と修正 **************************
 *  history.gs
 ****************************************************************/

// 一覧。opt = { kanriNo, actId, from, to, limit }
function getHistory(opt) {
  opt = opt || {};
  const acts = indexBy(getTable(SHEET.ACT, { fresh: true }).rows, 'アクションID');
  const usrs = indexBy(getTable(SHEET.USR, { fresh: true }).rows, '職員番号');
  const devs = indexBy(getTable(SHEET.DEV, { fresh: true }).rows, '管理番号');

  const fromT = opt.from ? new Date(opt.from).getTime() : 0;
  const toT   = opt.to   ? new Date(opt.to).getTime() + 86400000 : 0;

  let rows = getTable(SHEET.HIS, { fresh: true }).rows.filter(function (h) {
    if (opt.kanriNo && String(h['管理番号']) !== String(opt.kanriNo)) return false;
    if (opt.actId   && String(h['アクションID']) !== String(opt.actId)) return false;
    if (fromT || toT) {
      const d = h['実施日'];
      if (!d) return false;
      const t = new Date(d).getTime();
      if (isNaN(t)) return false;
      if (fromT && t < fromT) return false;
      if (toT   && t >= toT)  return false;
    }
    return true;
  });

  // 実施日の新しい順。同日なら履歴IDの大きい順
  rows.sort(function (a, b) {
    const at = a['実施日'] ? new Date(a['実施日']).getTime() : 0;
    const bt = b['実施日'] ? new Date(b['実施日']).getTime() : 0;
    if (at !== bt) return bt - at;
    return String(b['履歴ID']).localeCompare(String(a['履歴ID']));
  });

  const total = rows.length;
  const limit = Number(opt.limit || 200);
  if (rows.length > limit) rows = rows.slice(0, limit);

  const list = rows.map(function (h) {
    const u   = usrs[String(h['職員番号(実施者)'] || '')];
    const dev = devs[String(h['管理番号'] || '')];
    const act = acts[String(h['アクションID'] || '')];
    return {
      hid      : String(h['履歴ID'] || ''),
      kanriNo  : String(h['管理番号'] || ''),
      devName  : dev ? String(dev['機器名'] || '') : '（削除済み）',
      actId    : String(h['アクションID'] || ''),
      actName  : act ? String(act['アクション名'] || '') : String(h['アクションID'] || ''),
      userId   : String(h['職員番号(実施者)'] || ''),
      userName : u ? String(u['ユーザー名'] || '') : '',
      dept     : String(h['部署ID'] || ''),
      loc      : String(h['保管場所ID'] || ''),
      chkId    : String(h['点検表ID'] || ''),
      regAt    : h['登録日時'] ? Utilities.formatDate(new Date(h['登録日時']),
                   Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm') : '',
      date     : fmtDate_(h['実施日']),
      judge    : String(h['総合判定'] || ''),
      trouble  : String(h['故障内容／対応内容'] || ''),
      memo     : String(h['備考'] || ''),
      editable : (String(h['アクションID']) === ACT_INSPECT ||
                  String(h['アクションID']) === ACT_TROUBLE)
    };
  });

  return {
    rows   : list,
    total  : total,
    shown  : list.length,
    actions: getTable(SHEET.ACT, { fresh: true }).rows
               .filter(function (r) { return String(r['有効']) === ACTIVE; })
               .map(function (r) {
                 return { id: String(r['アクションID']), name: String(r['アクション名'] || '') };
               })
  };
}

// 1件の詳細（点検結果もまとめて返す）
//   hid が空のときは例外を投げず null を返す。
//   画面側の取りこぼしで空が来ても、エラー表示にならないようにするため。
function getHistoryDetail(hid) {
  const key = String(hid === undefined || hid === null ? '' : hid).trim();
  if (!key || key === 'undefined' || key === 'null') return null;

  const h = findRow(SHEET.HIS, '履歴ID', key, { fresh: true });
  if (!h) throw new Error('履歴が見つかりません: ' + key);

  const dev = findRow(SHEET.DEV, '管理番号', String(h['管理番号']), { fresh: true });
  const act = findRow(SHEET.ACT, 'アクションID', String(h['アクションID']), { fresh: true });

  // 点検項目（この履歴が使った点検表のもの）
  const chkId = String(h['点検表ID'] || '');
  const items = chkId
    ? getTable(SHEET.ITM, { fresh: true }).rows
        .filter(function (r) { return String(r['点検表ID']) === chkId; })
        .sort(function (a, b) { return (a['表示順'] || 0) - (b['表示順'] || 0); })
        .map(function (r) {
          return {
            id      : String(r['点検項目ID']),
            name    : String(r['項目名'] || ''),
            type    : String(r['入力形式'] || ''),
            required: String(r['必須']) === ACTIVE,
            note    : String(r['備考'] || '')
          };
        })
    : [];

  // 実際に記録された値
  const vals = {};
  const res = getTable(SHEET.RES, { fresh: true }).rows;
  for (let i = 0; i < res.length; i++) {
    if (String(res[i]['履歴ID']) === key) {
      vals[String(res[i]['点検項目ID'])] = res[i]['入力値'];
    }
  }

  // 実施者の候補（その機器の部署を先頭に）
  const myDept = dev ? String(dev['部署ID'] || '') : '';
  const users = getTable(SHEET.USR, { fresh: true }).rows
    .filter(function (r) { return String(r['有効']) === ACTIVE; })
    .map(function (r) {
      return { id: String(r['職員番号']), name: String(r['ユーザー名'] || ''),
               dept: String(r['部署名'] || ''), mine: String(r['部署ID']) === myDept };
    })
    .sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); });

  return {
    hid      : key,
    kanriNo  : String(h['管理番号'] || ''),
    devName  : dev ? String(dev['機器名'] || '') : '（削除済み）',
    actId    : String(h['アクションID'] || ''),
    actName  : act ? String(act['アクション名'] || '') : String(h['アクションID'] || ''),
    userId   : String(h['職員番号(実施者)'] || ''),
    regAt    : h['登録日時'] ? Utilities.formatDate(new Date(h['登録日時']),
                 Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm') : '',
    date     : fmtDate_(h['実施日']),
    judge    : String(h['総合判定'] || ''),
    trouble  : String(h['故障内容／対応内容'] || ''),
    memo     : String(h['備考'] || ''),
    sheetName: chkId,
    items    : items,
    values   : vals,
    users    : users,
    editable : (String(h['アクションID']) === ACT_INSPECT ||
                String(h['アクションID']) === ACT_TROUBLE),
    kind     : (String(h['アクションID']) === ACT_TROUBLE) ? 'trouble' : 'inspect'
  };
}

/* ---------- 動作確認 ---------- */

function historyTest() {
  const d = getHistory({});
  const log = ['履歴 ' + d.total + '件（表示 ' + d.shown + '）'];
  for (let i = 0; i < Math.min(d.rows.length, 10); i++) {
    const r = d.rows[i];
    log.push([r.hid, r.date, r.kanriNo, r.actName, r.userName, r.judge || '—'].join(' / '));
  }
  Logger.log(log.join('\n'));
}