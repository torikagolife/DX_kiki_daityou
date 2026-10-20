/*** 医療機器DX台帳 ─ アクション登録 ****************************
 *  action.gs
 *  点検画面で扱わないアクション（業者点検・移設・廃棄など）を
 *  管理画面から1台ずつ登録する
 ****************************************************************/

const ACT_MAKER   = 'ACT003';   // 業者点検
const ACT_OUT     = 'ACT006';   // 故障出し
const ACT_BACK    = 'ACT007';   // 故障復帰
const ACT_MOVE    = 'ACT008';   // 移設
const ACT_LEND    = 'ACT009';   // 貸出
const ACT_RETURN  = 'ACT010';   // 返却
const ACT_DISPOSE = 'ACT011';   // 廃棄・紛失
// ACT012 その他報告 の定数（ACT_OTHER / OTHER_KINDS）は app.gs にある。
// GASは全ファイルで名前を共有するので、ここで const を書き直すと全体が動かなくなる

// 管理画面から登録できるアクションと、その振る舞い
//   judge   : 総合判定の欄を出す
//   trouble : 対応内容の欄を出す
//   move    : 移設先の部署・保管場所を聞いて機器マスタを更新する
//   status  : 固定値なら文字列、選択させるなら配列、触らないなら null
//   category: その他報告の分類を選ばせる（OTHER_KINDS）
const ACTION_FORM = {
  'ACT001': { label: '導入',       status: '稼働中', useStartDate: true },
  'ACT003': { label: '業者点検',   status: null,     judge: true },
  'ACT005': { label: '故障報告',   status: '故障中', trouble: true, judge: 'NG' },
  'ACT006': { label: '故障出し',   status: '修理中', trouble: true },
  'ACT007': { label: '故障復帰',   status: '稼働中', trouble: true },
  'ACT008': { label: '移設',       status: null,     move: true },
  'ACT009': { label: '貸出',       status: '貸出中' },
  'ACT010': { label: '返却',       status: '稼働中' },
  'ACT011': { label: '廃棄・紛失', status: ['廃棄', '紛失'] },
  'ACT012': { label: 'その他報告', status: null,     trouble: true, category: true }
};

/* =============================================================
 *  画面に渡す選択肢
 * ============================================================= */

function getActionContext() {
  const acts = getTable(SHEET.ACT, { fresh: true }).rows
    .filter(function (r) { return String(r['有効']) === ACTIVE; })
    .filter(function (r) { return !!ACTION_FORM[String(r['アクションID'])]; })
    .map(function (r) {
      const id = String(r['アクションID']);
      const f  = ACTION_FORM[id];
      return {
        id      : id,
        name    : String(r['アクション名'] || f.label),
        judge   : !!f.judge,
        trouble : !!f.trouble,
        move    : !!f.move,
        statusOpts: Array.isArray(f.status) ? f.status : null,
        statusFix : (typeof f.status === 'string') ? f.status : '',
        useStart  : !!f.useStartDate,
        categoryOpts: f.category ? OTHER_KINDS : null
      };
    });

  const opt = function (sheetName, keyCol, nameCol) {
    return getTable(sheetName, { fresh: true }).rows
      .filter(function (r) { return String(r['有効']) === ACTIVE; })
      .sort(function (a, b) { return Number(a['表示順'] || 9999) - Number(b['表示順'] || 9999); })
      .map(function (r) { return { id: String(r[keyCol]), name: String(r[nameCol] || '') }; });
  };

  const users = getTable(SHEET.USR, { fresh: true }).rows
    .filter(function (r) { return String(r['有効']) === ACTIVE; })
    .map(function (r) {
      return { id: String(r['職員番号']), name: String(r['ユーザー名'] || ''),
               dept: String(r['部署名'] || '') };
    });

  return {
    actions: acts,
    depts  : opt(SHEET.DEPT, '部署ID', '部署名'),
    locs   : getTable(SHEET.LOC, { fresh: true }).rows
               .filter(function (r) { return String(r['有効']) === ACTIVE; })
               .sort(function (a, b) { return Number(a['表示順'] || 9999) - Number(b['表示順'] || 9999); })
               .map(function (r) {
                 return { id: String(r['保管場所ID']), name: String(r['保管場所名'] || ''),
                          dept: String(r['部署ID'] || ''), site: String(r['拠点'] || '') };
               }),
    users  : users,
    today  : fmtDate_(today_()).replace(/\//g, '-')
  };
}

// 機器を1件引く（アクション登録の対象確認用）
function findDeviceForAction(kanriNo) {
  const key = String(kanriNo || '').trim().toUpperCase();
  if (!key) throw new Error('管理番号を入力してください');

  const dev = findRow(SHEET.DEV, '管理番号', key, { fresh: true });
  if (!dev) throw new Error('管理番号が見つかりません: ' + key);

  return {
    kanriNo : String(dev['管理番号']),
    name    : String(dev['機器名'] || ''),
    category: String(dev['機器区分名'] || ''),
    maker   : String(dev['メーカー名'] || ''),
    model   : String(dev['型番'] || ''),
    deptId  : String(dev['部署ID'] || ''),
    dept    : String(dev['部署名'] || ''),
    locId   : String(dev['保管場所ID'] || ''),
    loc     : String(dev['保管場所名'] || ''),
    site    : String(dev['拠点'] || ''),
    status  : String(dev['ステータス'] || ''),
    startDate: fmtDate_(dev['使用開始日']).replace(/\//g, '-')
  };
}

/* =============================================================
 *  登録
 * ============================================================= */

// p = { kanriNo, actId, userId, date, judge, trouble, memo,
//       newDeptId, newLocId, newStatus }
function submitAction(p) {
  const actId = String(p.actId || '');
  const f = ACTION_FORM[actId];
  if (!f) throw new Error('この画面から登録できないアクションです: ' + actId);

  const dev = findRow(SHEET.DEV, '管理番号', String(p.kanriNo), { fresh: true });
  if (!dev) throw new Error('管理番号が見つかりません: ' + p.kanriNo);
  if (!p.userId) throw new Error('実施者を選択してください');
  if (!p.date)   throw new Error('実施日を入力してください');

  if (f.trouble && !String(p.trouble || '').trim()) {
    throw new Error('内容を入力してください');
  }

  // その他報告は分類が要る。内容の頭に [分類] を付けて残す
  let troubleText = String(p.trouble || '');
  let category = '';
  if (f.category) {
    const kind = otherKind_(p.category);
    if (!kind) throw new Error('分類を選択してください');
    category = kind.name;
    troubleText = otherText_(category, p.trouble);
  }

  // 移設は移設先が要る
  let newDeptId = '', newLocId = '';
  if (f.move) {
    newDeptId = String(p.newDeptId || '').trim();
    newLocId  = String(p.newLocId  || '').trim();
    if (!newDeptId || !newLocId) throw new Error('移設先の部署と保管場所を選択してください');
    assertLocDept_(newDeptId, newLocId);          // 保管場所がその部署のものか（master.gs）
  }

  // ステータス
  let newStatus = '';
  if (Array.isArray(f.status)) {
    newStatus = String(p.newStatus || '').trim();
    if (f.status.indexOf(newStatus) < 0) {
      throw new Error('ステータスを選択してください（' + f.status.join(' / ') + '）');
    }
  } else if (typeof f.status === 'string') {
    newStatus = f.status;
  }

  // 判定
  let judge = '';
  if (f.judge === 'NG') judge = 'NG';
  else if (f.judge)     judge = String(p.judge || '').trim();

  const d = new Date(p.date);
  if (isNaN(d.getTime())) throw new Error('実施日が正しくありません');

  // 履歴に残す部署・保管場所は「そのアクション時点のもの」。
  // 移設は移設先を記録する（移った先で実施した扱い）
  const hisDept = f.move ? newDeptId : String(dev['部署ID'] || '');
  const hisLoc  = f.move ? newLocId  : String(dev['保管場所ID'] || '');

  const res = withLock(function () {
    const hid = nextId_(SHEET.HIS, '履歴ID', 'HIS', 6);

    appendRows(SHEET.HIS, [{
      '履歴ID'      : hid,
      '管理番号'    : String(dev['管理番号']),
      'アクションID': actId,
      '職員番号(実施者)': String(p.userId),
      '部署ID'      : hisDept,
      '保管場所ID'  : hisLoc,
      '登録日時'    : now_(),
      '実施日'      : d,
      '総合判定'    : judge,
      '故障内容／対応内容': troubleText,
      '備考'        : String(p.memo || '')
    }]);

    // 機器マスタ側の反映
    const patch = {};
    if (newStatus) patch['ステータス'] = newStatus;
    if (f.move) {
      const dic = dicts_(true);
      const dep = dic.dept[newDeptId];
      const loc = dic.loc[newLocId];
      patch['部署ID']     = newDeptId;
      patch['部署名']     = dep ? String(dep['部署名'] || '') : '';
      patch['保管場所ID'] = newLocId;
      patch['保管場所名'] = loc ? String(loc['保管場所名'] || '') : '';
      patch['拠点']       = loc ? String(loc['拠点'] || '') : '';
    }
    if (Object.keys(patch).length) {
      updateRow(SHEET.DEV, '管理番号', String(dev['管理番号']), patch);
    }

    return { hid: hid, status: newStatus || String(dev['ステータス'] || '') };
  });

  // LINE WORKS の幹部ルームへ知らせる（notify.gs）。
  //   ・流すのは故障報告(ACT005)・故障出し(ACT006)・故障復帰(ACT007)・その他報告(ACT012)。
  //     それ以外のアクションIDを渡しても notifyEvent_ 側で素通りする
  //   ・ロックの外で呼ぶ。送信待ちのあいだ他の人の登録を止めないため
  //   ・notifyEvent_ は中で例外を飲むので、ここが原因で登録が失敗することはない
  notifyEvent_(actId, {
    kanriNo : String(dev['管理番号']),
    hid     : res.hid,
    userId  : p.userId,
    category: category,
    text    : p.trouble,
    memo    : p.memo
  });

  return res;
}

/* ---------- 動作確認 ---------- */

function actionTest() {
  const c = getActionContext();
  const log = ['登録できるアクション ' + c.actions.length + '件'];
  for (let i = 0; i < c.actions.length; i++) {
    const a = c.actions[i];
    log.push('  ' + a.id + ' ' + a.name
      + (a.judge   ? ' [判定]' : '')
      + (a.trouble ? ' [内容]' : '')
      + (a.move    ? ' [移設先]' : '')
      + (a.statusOpts ? ' [状態選択:' + a.statusOpts.join('/') + ']' : '')
      + (a.statusFix  ? ' [状態→' + a.statusFix + ']' : '')
      + (a.categoryOpts ? ' [分類:' + a.categoryOpts.length + ']' : ''));
  }
  log.push('部署 ' + c.depts.length + ' / 保管場所 ' + c.locs.length
    + ' / ユーザー ' + c.users.length);
  log.push('--- A1403 ---');
  log.push(JSON.stringify(findDeviceForAction('A1403')));
  Logger.log(log.join('\n'));
}