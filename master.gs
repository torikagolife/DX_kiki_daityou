/*** 医療機器DX台帳 ─ マスタ管理 ********************************
 *  master.gs
 *  マスタの一覧・追加・更新・無効化を1本化する
 ****************************************************************/

// 画面に出すマスタの定義。ここに足せば画面にタブが増える
//   type: id=自動採番 / text=自由入力 / ref=他マスタ参照 / fv=refの名前（自動）
//         select=選択肢 / order=表示順 / active=有効フラグ / num=数値 / date=日付
//         ro=画面では見るだけ（保存しても変わらない。note に理由を書く）
//   icon: タブとダイアログのタイトルに出す絵文字
const MASTERS = {
  dev: {
    sheet: SHEET.DEV, key: '管理番号', label: '機器', icon: '🩺',
    idGen: null,                       // 管理番号は人が入力する
    special: 'device',                 // 専用画面で扱う
    listCols: ['管理番号', '機器名', '機器区分名', 'メーカー名', '部署名', '保管場所名', 'ステータス'],
    fields: [
      { col: '管理番号',     type: 'text', required: true, pk: true },
      { col: '機器名',       type: 'text', required: true },
      { col: '機器区分ID',   type: 'ref',  required: true, ref: 'cat' },
      { col: '機器区分名',   type: 'fv' },
      { col: 'メーカーID',   type: 'ref',  ref: 'maker' },
      { col: 'メーカー名',   type: 'fv' },
      { col: 'クラス分類',   type: 'select', options: ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'] },
      { col: '型番',         type: 'text' },
      { col: '製造番号',     type: 'text' },
      { col: '資産番号',     type: 'text' },
      { col: '使用開始日',   type: 'date' },
      { col: '保守契約有無', type: 'select', options: ['', '有', '無'] },
      { col: '部署ID',       type: 'ref',  required: true, ref: 'dept' },
      { col: '部署名',       type: 'fv' },
      { col: '保管場所ID',   type: 'ref',  required: true, ref: 'loc' },
      { col: '保管場所名',   type: 'fv' },
      { col: '拠点',         type: 'fv' },
      { col: 'ステータス',   type: 'status' },
      { col: 'ファイルBOXID', type: 'text' },
      { col: '備考',         type: 'text' }
    ],
    noActive: true,                    // 機器は廃棄アクションで扱うので無効化しない
    copySkip: ['製造番号', '資産番号', '使用開始日', 'ファイルBOXID', '備考']
  },

  user: {
    sheet: SHEET.USR, key: '職員番号', label: 'ユーザー', icon: '👤',
    idGen: null,
    listCols: ['職員番号', 'ユーザー名', '部署名'],
    fields: [
      { col: '職員番号',   type: 'text',   required: true, pk: true },
      { col: 'ユーザー名', type: 'text',   required: true },
      { col: '部署ID',     type: 'ref',    required: true, ref: 'dept' },
      { col: '部署名',     type: 'fv' },
      // 「権限」列はやめた（画面の入口はパスワードで分けているため、何にも効いていなかった）
      { col: '有効',       type: 'active' },
      { col: '備考',       type: 'text' }
    ]
  },

  dept: {
    sheet: SHEET.DEPT, key: '部署ID', label: '部署', icon: '🏢',
    idGen: { prefix: 'DEP', digits: 3 },
    listCols: ['部署ID', '部署名'],
    fields: [
      { col: '部署ID',   type: 'id',   pk: true },
      { col: '部署名',   type: 'text', required: true },
      // 「担当者１・２」列はやめた（人の情報はユーザーマスタ1か所に持つ）
      { col: '表示順',   type: 'order' },
      { col: '有効',     type: 'active' },
      { col: '備考',     type: 'text' }
    ]
  },

  loc: {
    sheet: SHEET.LOC, key: '保管場所ID', label: '保管場所', icon: '📍',
    idGen: { prefix: 'LOC', digits: 3 },
    listCols: ['保管場所ID', '保管場所名', '部署名', '拠点'],
    fields: [
      { col: '保管場所ID', type: 'id',   pk: true },
      { col: '保管場所名', type: 'text', required: true },
      { col: '部署ID',     type: 'ref',  required: true, ref: 'dept' },
      { col: '部署名',     type: 'fv' },
      { col: '拠点',       type: 'text', required: true },
      { col: '表示順',     type: 'order' },
      { col: '有効',       type: 'active' },
      { col: '備考',       type: 'text' }
    ]
  },

  maker: {
    sheet: SHEET.MKR, key: 'メーカーID', label: 'メーカー', icon: '🏭',
    idGen: { prefix: 'MKR', digits: 3 },
    listCols: ['メーカーID', 'メーカー名', '電話番号', '担当者'],
    fields: [
      { col: 'メーカーID',     type: 'id',   pk: true },
      { col: 'メーカー名',     type: 'text', required: true },
      { col: '電話番号',       type: 'text' },
      { col: '担当者',         type: 'text' },
      { col: 'メールアドレス', type: 'text' },
      { col: 'ホームページ',   type: 'text' },
      { col: '表示順',         type: 'order' },
      { col: '有効',           type: 'active' },
      { col: '備考',           type: 'text' }
    ]
  },

  cat: {
    sheet: SHEET.CAT, key: '機器区分ID', label: '機器区分', icon: '🗂',
    idGen: { prefix: 'CAT', digits: 3 },
    listCols: ['機器区分ID', '機器区分名', '点検表名', '部署点検周期(月)', '業者点検周期(月)'],
    fields: [
      { col: '機器区分ID',           type: 'id',     pk: true },
      { col: '機器区分名',           type: 'text',   required: true },
      { col: '特定保守管理医療機器', type: 'select', options: ['', '〇'] },
      { col: '点検表ID',             type: 'ref',    ref: 'chk' },
      { col: '点検表名',             type: 'fv' },
      { col: '部署点検周期(月)',     type: 'num' },
      { col: '業者点検周期(月)',     type: 'num' },
      { col: '表示順',               type: 'order' },
      { col: '有効',                 type: 'active' },
      { col: '備考',                 type: 'text' }
    ]
  },

  chk: {
    sheet: SHEET.CHK, key: '点検表ID', label: '点検表', icon: '📋',
    idGen: { prefix: 'CHK', digits: 3 },
    listCols: ['点検表ID', '点検表名', '機器区分ID', '点検区分'],
    fields: [
      { col: '点検表ID',   type: 'id',     pk: true },
      { col: '点検表名',   type: 'text',   required: true },
      // 正は機器区分マスタの「点検表ID」。こちらはそれに合わせて自動で入る（syncChkCat_）
      { col: '機器区分ID', type: 'ro',
        note: '機器区分マスタで、この点検表を選んだ区分のIDが自動で入ります' },
      { col: '点検区分',   type: 'select', options: ['部署点検', '業者点検'] },
      { col: '表示順',     type: 'order' },
      { col: '有効',       type: 'active' },
      { col: '備考',       type: 'text' }
    ]
  },

  item: {
    sheet: SHEET.ITM, key: '点検項目ID', label: '点検項目', icon: '☑️',
    idGen: { prefix: 'ITM', digits: 3 },
    listCols: ['点検項目ID', '点検表名', '表示順', '項目名', '入力形式'],
    fields: [
      { col: '点検項目ID', type: 'id',     pk: true },
      { col: '点検表ID',   type: 'ref',    required: true, ref: 'chk' },
      { col: '点検表名',   type: 'fv' },
      { col: '表示順',     type: 'order' },
      { col: '項目名',     type: 'text',   required: true },
      { col: '入力形式',   type: 'select', options: ['○×', '数値', '日付', '文字'] },
      { col: '必須',       type: 'select', options: ['〇', ''] },
      { col: '備考',       type: 'text' }
    ],
    noActive: true                     // このシートに「有効」列が無い
  },

  act: {
    sheet: SHEET.ACT, key: 'アクションID', label: 'アクション', icon: '⚡',
    idGen: { prefix: 'ACT', digits: 3 },
    listCols: ['アクションID', 'アクション名', 'ステータス更新', '点検日更新'],
    fields: [
      { col: 'アクションID',   type: 'id',   pk: true },
      { col: 'アクション名',   type: 'text', required: true },
      // 実際の動きはコード（action.gs の ACTION_FORM）が決めている。ここは説明のための列
      { col: 'ステータス更新', type: 'ro',
        note: '実際の動きはプログラムで決まっています。ここを書き換えても動きは変わりません' },
      { col: '点検日更新',     type: 'ro',
        note: '同上。最終点検日は機器マスタには持たず、台帳ビューが履歴から計算します' },
      { col: '有効',           type: 'active' },
      { col: '備考',           type: 'text' }
    ]
  }
};

// タブの並び順（定義の順ではなく、使う頻度の順に出す）
const MASTER_ORDER = ['dev', 'user', 'dept', 'loc', 'maker', 'cat', 'chk', 'item', 'act'];

/* =============================================================
 *  一覧
 * ============================================================= */

function listMaster(name, opt) {
  const m = MASTERS[name];
  if (!m) throw new Error('不明なマスタです: ' + name);

  const t = getTable(m.sheet, { fresh: true });
  let rows = t.rows;
  if (!m.noActive && !(opt && opt.all)) {
    rows = rows.filter(function (r) { return String(r['有効']) === ACTIVE; });
  }
  rows = rows.slice().sort(function (a, b) {
    const ao = Number(a['表示順'] || 9999), bo = Number(b['表示順'] || 9999);
    if (ao !== bo) return ao - bo;
    return String(a[m.key]).localeCompare(String(b[m.key]));
  });

  return {
    name     : name,
    label    : m.label,
    icon     : m.icon || '📑',
    key      : m.key,
    cols     : m.listCols,
    fields   : m.fields,
    noActive : !!m.noActive,
    special  : m.special || '',
    rows     : rows.map(function (r) {
      const o = {
        _key    : String(r[m.key]),
        _active : m.noActive ? true : (String(r['有効']) === ACTIVE)
      };
      for (let i = 0; i < m.fields.length; i++) {
        const c = m.fields[i].col;
        const v = r[c];
        o[c] = (v instanceof Date) ? fmtDate_(v) : (v === undefined ? '' : v);
      }
      for (let j = 0; j < m.listCols.length; j++) {
        const lc = m.listCols[j];
        if (o[lc] === undefined) {
          const lv = r[lc];
          o[lc] = (lv instanceof Date) ? fmtDate_(lv) : (lv === undefined ? '' : lv);
        }
      }
      return o;
    })
  };
}

function refOptions(name) {
  const m = MASTERS[name];
  if (!m) return [];
  const labelCol = m.fields[1].col;
  let rows = getTable(m.sheet, { fresh: true }).rows;
  if (!m.noActive) {
    rows = rows.filter(function (r) { return String(r['有効']) === ACTIVE; });
  }
  return rows
    .sort(function (a, b) { return Number(a['表示順'] || 9999) - Number(b['表示順'] || 9999); })
    .map(function (r) { return { id: String(r[m.key]), name: String(r[labelCol] || '') }; });
}

function getMasterContext(name) {
  // ここで m を取っておかないと、末尾の copySkip で落ちる
  const m = MASTERS[name];
  if (!m) throw new Error('不明なマスタです: ' + name);

  const t = listMaster(name, { all: true });
  const refs = {};
  for (let i = 0; i < t.fields.length; i++) {
    const f = t.fields[i];
    if (f.type === 'ref' && !refs[f.ref]) refs[f.ref] = refOptions(f.ref);
  }
  t.refs = refs;
  t.tabs = MASTER_ORDER.filter(function (k) { return !!MASTERS[k]; })
    .map(function (k) {
      return {
        name : k,
        label: (MASTERS[k].icon ? MASTERS[k].icon + ' ' : '') + MASTERS[k].label
      };
    });

  // 機器マスタは導入時に登録者と導入日が要る
  if (t.special === 'device') {
    t.users = getTable(SHEET.USR, { fresh: true }).rows
      .filter(function (r) { return String(r['有効']) === ACTIVE; })
      .map(function (r) {
        return { id: String(r['職員番号']), name: r['ユーザー名'] + '（' + r['部署名'] + '）' };
      });
    t.today = fmtDate_(today_()).replace(/\//g, '-');
  }

  // コピーして新規作成するとき、引き継がない列
  //   機器なら製造番号・資産番号のような1台ごとに違うもの
  t.copySkip = m.copySkip || [];
  return t;
}

/* =============================================================
 *  保存
 * ============================================================= */

function saveMaster(p) {
  const m = MASTERS[p.name];
  if (!m) throw new Error('不明なマスタです: ' + p.name);
  const v = p.values || {};

  const isNewRec = !p.key;
  for (let i = 0; i < m.fields.length; i++) {
    const f = m.fields[i];
    if (f.pk && !isNewRec) continue;
    if (f.required && !String(v[f.col] || '').trim()) {
      throw new Error(f.col + ' を入力してください');
    }
  }

  // 機器マスタは履歴も書くので専用処理へ回す
  if (m.special === 'device') {
    // 保管場所はどこかの部署に属している。機器の部署と食い違う組み合わせは止める
    let cur = null;
    if (!isNewRec) cur = findRow(SHEET.DEV, '管理番号', String(p.key), { fresh: true });
    const deptId = String(v['部署ID'] !== undefined ? v['部署ID'] : (cur ? cur['部署ID'] : '')).trim();
    const locId  = String(v['保管場所ID'] !== undefined ? v['保管場所ID'] : (cur ? cur['保管場所ID'] : '')).trim();
    assertLocDept_(deptId, locId);

    if (isNewRec) {
      const r = registerDevice({ values: v, userId: p.userId, introDate: p.introDate });
      // ここは変更なし（コピーも新規登録と同じ扱い）
      refreshAllFv();
      return { key: r.kanriNo, isNew: true, hid: r.hid };
    }
    const r2 = updateDevice({ key: p.key, values: v });
    refreshAllFv();
    return { key: r2.kanriNo, isNew: false };
  }

  return withLock(function () {
    const isNew = isNewRec;
    const rec = {};

    if (isNew) {
      if (m.idGen) {
        rec[m.key] = nextId_(m.sheet, m.key, m.idGen.prefix, m.idGen.digits);
      } else {
        const id = String(v[m.key] || '').trim();
        if (!id) throw new Error(m.key + ' を入力してください');
        if (findRow(m.sheet, m.key, id, { fresh: true })) {
          throw new Error('その' + m.key + 'は既に登録されています: ' + id);
        }
        rec[m.key] = id;
      }
    } else {
      rec[m.key] = String(p.key);
    }

    for (let i = 0; i < m.fields.length; i++) {
      const f = m.fields[i];
      if (f.pk) continue;
      if (f.type === 'fv' || f.type === 'status' || f.type === 'ro') continue;
      if (f.type === 'active') {
        rec[f.col] = (String(v[f.col]) === 'false') ? '' : ACTIVE;
      } else if (f.type === 'order') {
        const n = parseInt(v[f.col], 10);
        rec[f.col] = isNaN(n) ? nextOrder_(m.sheet) : n;
      } else if (f.type === 'num') {
        const s = String(v[f.col] === undefined ? '' : v[f.col]).trim();
        if (s === '') { rec[f.col] = ''; }
        else {
          const n2 = Number(s);
          if (isNaN(n2)) throw new Error(f.col + ' は数字で入力してください');
          rec[f.col] = n2;
        }
      } else if (f.type === 'date') {
        const s2 = String(v[f.col] === undefined ? '' : v[f.col]).trim();
        rec[f.col] = s2 ? new Date(s2) : '';
      } else {
        rec[f.col] = String(v[f.col] === undefined ? '' : v[f.col]).trim();
      }
    }

    fillRefFv_(m, rec);

    if (isNew) {
      appendRows(m.sheet, [rec]);
    } else {
      const patch = {};
      for (const k in rec) if (k !== m.key) patch[k] = rec[k];
      if (!updateRow(m.sheet, m.key, rec[m.key], patch)) {
        throw new Error('更新対象が見つかりません: ' + rec[m.key]);
      }
    }

    refreshAllFv();
    // 機器区分の点検表を変えたら、点検表マスタの「機器区分ID」も合わせる
    if (p.name === 'cat' || p.name === 'chk') syncChkCat_();
    return { key: rec[m.key], isNew: isNew };
  });
}

function toggleMasterActive(name, key, active) {
  const m = MASTERS[name];
  if (!m) throw new Error('不明なマスタです: ' + name);
  if (m.noActive) throw new Error(m.label + 'には有効・無効の切り替えがありません');
  const ok = updateRow(m.sheet, m.key, String(key), {
    '有効': active ? ACTIVE : ''
  });
  if (!ok) throw new Error('対象が見つかりません: ' + key);
  return { key: String(key), active: !!active };
}

/* ---------- 整合性のチェック ---------- */

/**
 * 保管場所が、その部署のものかを確かめる。違えば止める。
 * 機器マスタの保存と、アクション登録の「移設」から呼ぶ。
 */
function assertLocDept_(deptId, locId) {
  deptId = String(deptId || '').trim();
  locId  = String(locId  || '').trim();
  if (!deptId || !locId) return;
  const loc = findRow(SHEET.LOC, '保管場所ID', locId, { fresh: true });
  if (!loc) throw new Error('保管場所が見つかりません: ' + locId);
  const owner = String(loc['部署ID'] || '').trim();
  if (owner && owner !== deptId) {
    const dep = findRow(SHEET.DEPT, '部署ID', deptId, { fresh: true });
    throw new Error('保管場所「' + String(loc['保管場所名'] || locId) + '」は「'
      + String(loc['部署名'] || owner) + '」の場所です。'
      + '部署を「' + String(loc['部署名'] || owner) + '」にするか、'
      + (dep ? '「' + String(dep['部署名'] || deptId) + '」の' : '') + '保管場所を選び直してください');
  }
}

/**
 * 点検表マスタの「機器区分ID」を、機器区分マスタの「点検表ID」に合わせる。
 *   正は機器区分マスタ（どの区分がどの点検表を使うか）。
 *   1つの点検表を複数の区分で使っているときは、いちばん若い区分IDを入れる。
 *   どの区分からも使われていない点検表は空にする。
 * 変わった行だけ書き換える。エディタから実行してもよい。
 * @return {number} 書き換えた行数
 */
function syncChkCat_() {
  const want = {};
  getTable(SHEET.CAT, { fresh: true }).rows.forEach(function (c) {
    const chk = String(c['点検表ID'] || '').trim();
    const cat = String(c['機器区分ID'] || '').trim();
    if (!chk || !cat) return;
    if (!want[chk] || cat < want[chk]) want[chk] = cat;
  });
  let n = 0;
  getTable(SHEET.CHK, { fresh: true }).rows.forEach(function (r) {
    const id = String(r['点検表ID'] || '').trim();
    if (!id) return;
    const now = String(r['機器区分ID'] || '').trim();
    const to = want[id] || '';
    if (now !== to) { updateRow(SHEET.CHK, '点検表ID', id, { '機器区分ID': to }); n++; }
  });
  return n;
}

// エディタから1回だけ実行する用（ずれていないかの確認と修正）
function syncCheckSheetCategory() {
  Logger.log('点検表マスタの機器区分IDを ' + syncChkCat_() + ' 行直しました');
}

/* ---------- 補助 ---------- */

function nextOrder_(sheetName) {
  const rows = getTable(sheetName, { fresh: true }).rows;
  let max = 0;
  for (let i = 0; i < rows.length; i++) {
    const n = Number(rows[i]['表示順'] || 0);
    if (n > max) max = n;
  }
  return max + 1;
}

function fillRefFv_(m, rec) {
  for (let i = 0; i < m.fields.length; i++) {
    const f = m.fields[i];
    if (f.type !== 'ref') continue;
    const tgt = MASTERS[f.ref];
    if (!tgt) continue;
    const fvField = m.fields[i + 1];
    if (!fvField || fvField.type !== 'fv') continue;

    const src = findRow(tgt.sheet, tgt.key, rec[f.col], { fresh: true });
    rec[fvField.col] = src ? String(src[tgt.fields[1].col] || '') : '';
  }
}
