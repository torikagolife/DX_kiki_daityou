/*** 医療機器DX台帳 ─ 機器のカルテ（1台の全部を1画面に） **********************
 *  karte.gs
 *
 *  管理画面の「🩺 カルテ」（?p=karte&id=管理番号）と、ナビの検索窓から使います。
 *
 *    searchDevices(q)    検索窓の言葉で機器を探す
 *                        管理番号がぴったり1台に当たれば、そのままカルテを開く
 *                        当たらなければ、機器名・型番・製造番号・資産番号・メーカー・部署・保管場所の部分一致で候補を返す
 *    getDeviceKarte(no)  1台ぶんのカルテ
 *                        基本情報・機器区分（周期・特定保守）・点検期限・履歴の全部・集計・代表写真
 *                        書類ボックスの一覧は画面から apiListFiles で別に取る（カルテを先に早く出すため）
 *
 *  ⚠️ 読むだけです。何も書き込みません。
 *
 *  使っているもの（ほかのファイルにある）
 *    getTable / SHEET / ACTIVE … データ層    dueBase_ / dueOf_ / dueRuleText_ … due.gs
 *    getThumb … filebox.gs（代表写真。無くてもカルテは出る）
 **********************************************************************/

const KR_SEARCH_MAX = 50;      // 候補の上限

// 履歴のアクションの見た目（絵文字と、絞り込みの組）
const KR_ACT = {
  ACT001: { label: '導入', icon: '🆕', group: 'move'    },   // 導入
  ACT002: { label: '部署点検', icon: '✅', group: 'inspect' },   // 部署点検
  ACT003: { label: '業者点検', icon: '🛠', group: 'inspect' },   // 業者点検
  ACT004: { label: '業者点検', icon: '🛠', group: 'inspect' },   // 業者点検（もう1つの種類）
  ACT005: { label: '故障報告', icon: '🔧', group: 'trouble' },   // 故障報告
  ACT006: { label: '故障出し', icon: '🚚', group: 'trouble' },   // 故障出し
  ACT007: { label: '故障復帰', icon: '💚', group: 'trouble' },   // 故障復帰
  ACT008: { label: '移設', icon: '🔀', group: 'move'    },   // 移設
  ACT009: { label: '貸出', icon: '📤', group: 'move'    },   // 貸出
  ACT010: { label: '返却', icon: '📥', group: 'move'    },   // 返却
  ACT011: { label: '廃棄・紛失', icon: '🗑', group: 'move'    },   // 廃棄・紛失
  ACT012: { label: 'その他報告', icon: '💬', group: 'other'   }    // その他報告
};

/* =============================================================
 *  小道具
 * ============================================================= */

function krStr_(v) { return v == null ? '' : String(v).trim(); }

function krDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = String(v).trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  return null;
}

function krFmt_(v, withTime) {
  const d = krDate_(v);
  if (!d) return krStr_(v);
  return Utilities.formatDate(d, 'Asia/Tokyo', withTime ? 'yyyy/MM/dd HH:mm' : 'yyyy/MM/dd');
}

function krIndex_(sheet, key) {
  const out = {};
  try {
    getTable(sheet, { fresh: true }).rows.forEach(function (r) { out[krStr_(r[key])] = r; });
  } catch (e) { /* 読めなければ名前が出ないだけ */ }
  return out;
}

// 機器の行を画面に渡す形に（検索の候補とカルテで共通）
function krDevHead_(d) {
  return {
    kanriNo: krStr_(d['管理番号']),
    name   : krStr_(d['機器名']),
    cat    : krStr_(d['機器区分名']),
    maker  : krStr_(d['メーカー名']),
    model  : krStr_(d['型番']),
    serial : krStr_(d['製造番号']),
    asset  : krStr_(d['資産番号']),
    dept   : krStr_(d['部署名']),
    loc    : krStr_(d['保管場所名']),
    site   : krStr_(d['拠点']),
    status : krStr_(d['ステータス'])
  };
}

/* =============================================================
 *  検索
 * ============================================================= */

function searchDevices(q) {
  q = krStr_(q);
  if (!q) return { q: '', exact: '', items: [], total: 0 };
  const devs = getTable(SHEET.DEV, { fresh: true }).rows
    .filter(function (r) { return krStr_(r['管理番号']); });

  // 管理番号がぴったり（大文字小文字・前後の空白は無視）
  const up = q.toUpperCase();
  const exact = devs.filter(function (r) { return krStr_(r['管理番号']).toUpperCase() === up; })[0];
  if (exact) return { q: q, exact: krStr_(exact['管理番号']), items: [], total: 1 };

  // 部分一致。空白で区切ったら全部の言葉を含むもの（例「心電図 内科」）
  const words = up.split(/[\s　]+/).filter(String);
  const hits = [];
  devs.forEach(function (r) {
    const hay = ['管理番号', '機器名', '型番', '製造番号', '資産番号', 'メーカー名', '部署名', '保管場所名', '機器区分名']
      .map(function (k) { return krStr_(r[k]); }).join(' ').toUpperCase();
    if (words.every(function (w) { return hay.indexOf(w) >= 0; })) hits.push(r);
  });

  // 管理番号が言葉で始まるものを先に、あとは管理番号順
  hits.sort(function (a, b) {
    const sa = krStr_(a['管理番号']).toUpperCase().indexOf(up) === 0 ? 0 : 1;
    const sb = krStr_(b['管理番号']).toUpperCase().indexOf(up) === 0 ? 0 : 1;
    return (sa - sb) || krStr_(a['管理番号']).localeCompare(krStr_(b['管理番号']));
  });

  return { q: q, exact: '', items: hits.slice(0, KR_SEARCH_MAX).map(krDevHead_), total: hits.length };
}

/* =============================================================
 *  カルテ
 * ============================================================= */

function getDeviceKarte(kanriNo) {
  const key = krStr_(kanriNo).toUpperCase();
  if (!key) throw new Error('管理番号を入れてください');
  const dev = getTable(SHEET.DEV, { fresh: true }).rows.filter(function (r) {
    return krStr_(r['管理番号']).toUpperCase() === key;
  })[0];
  if (!dev) throw new Error('管理番号 ' + krStr_(kanriNo) + ' の機器は見つかりませんでした');
  const no = krStr_(dev['管理番号']);

  const cats  = krIndex_(SHEET.CAT, '機器区分ID');
  const acts  = krIndex_(SHEET.ACT, 'アクションID');
  const users = krIndex_(SHEET.USR, '職員番号');
  const depts = krIndex_(SHEET.DEPT, '部署ID');
  const locs  = krIndex_(SHEET.LOC, '保管場所ID');
  const chks  = krIndex_(SHEET.CHK, '点検表ID');
  const cat = cats[krStr_(dev['機器区分ID'])] || {};

  // ---- 基本情報 ----
  const head = krDevHead_(dev);
  const start = krDate_(dev['使用開始日']);
  let years = '';
  if (start) {
    const y = (Date.now() - start.getTime()) / (365.25 * 86400000);
    years = y >= 0 ? (Math.floor(y * 10) / 10).toFixed(1) : '';
  }
  head.devClass  = krStr_(dev['クラス分類']);
  head.start     = start ? krFmt_(start) : '';
  head.years     = years;
  head.contract  = krStr_(dev['保守契約有無']);
  head.memo      = krStr_(dev['備考']);
  head.catId     = krStr_(dev['機器区分ID']);
  head.tokutei   = krStr_(cat['特定保守管理医療機器']) === ACTIVE;
  head.cycleDept = krStr_(cat['部署点検周期(月)']);
  head.cycleMaker= krStr_(cat['業者点検周期(月)']);
  head.sheet     = krStr_(cat['点検表名']);

  // ---- 点検期限（台帳ビュー・点検画面と同じ決まり） ----
  let due = null;
  try { due = dueOf_(dev, dueBase_()); } catch (e) { due = null; }

  // ---- 履歴（この機器のぶん全部・新しい順） ----
  const his = [];
  getTable(SHEET.HIS, { fresh: true }).rows.forEach(function (h) {
    if (krStr_(h['管理番号']).toUpperCase() !== key) return;
    const actId = krStr_(h['アクションID']);
    const a = KR_ACT[actId] || { label: '', icon: '⚡', group: 'other' };
    const uid = krStr_(h['職員番号(実施者)']);
    const d = krDate_(h['実施日']);
    const reg = krDate_(h['登録日時']);
    his.push({
      hid    : krStr_(h['履歴ID']),
      date   : d ? krFmt_(d) : krStr_(h['実施日']),
      t      : (d ? d.getTime() : 0),
      tReg   : (reg ? reg.getTime() : 0),
      actId  : actId,
      act    : krStr_((acts[actId] || {})['アクション名']) || a.label || actId,
      icon   : a.icon,
      group  : a.group,
      user   : krStr_((users[uid] || {})['ユーザー名']) || uid,
      judge  : krStr_(h['総合判定']),
      trouble: krStr_(h['故障内容／対応内容']),
      memo   : krStr_(h['備考']),
      dept   : krStr_((depts[krStr_(h['部署ID'])] || {})['部署名']),
      loc    : krStr_((locs[krStr_(h['保管場所ID'])] || {})['保管場所名']),
      sheet  : krStr_((chks[krStr_(h['点検表ID'])] || {})['点検表名'])
    });
  });
  his.sort(function (a, b) {
    return (b.t - a.t) || (b.tReg - a.tReg) || b.hid.localeCompare(a.hid);
  });

  // ---- 集計 ----
  const cnt = { all: his.length, inspect: 0, trouble: 0, move: 0, other: 0, ng: 0 };
  let lastTrouble = null, lastNg = null, statusSince = null;
  his.forEach(function (x) {
    cnt[x.group] = (cnt[x.group] || 0) + 1;
    if (x.judge === 'NG') { cnt.ng++; if (!lastNg) lastNg = x; }
    if ((x.actId === 'ACT005' || x.actId === 'ACT006') && !lastTrouble) lastTrouble = x;
  });
  // いまのステータスになった日（ステータスを変えるアクションのうち、いちばん新しいもの）
  const changers = ['ACT001', 'ACT005', 'ACT006', 'ACT007', 'ACT009', 'ACT010', 'ACT011'];
  for (let i = 0; i < his.length; i++) {
    if (changers.indexOf(his[i].actId) >= 0) { statusSince = his[i]; break; }
  }
  const dayNum = function (t) {
    return Math.floor((Date.now() - t) / 86400000);
  };
  const troubleCount12 = his.filter(function (x) {
    return x.actId === 'ACT005' && x.t && dayNum(x.t) <= 365;
  }).length;

  his.forEach(function (x) { delete x.t; delete x.tReg; });

  // ---- 代表写真（無くてもよい） ----
  let thumb = '';
  try {
    const t = getThumb(no);
    if (t && t.ok && t.dataUrl) thumb = t.dataUrl;
  } catch (e) { thumb = ''; }

  return {
    dev: head,
    due: due,
    dueRule: (function () { try { return dueRuleText_(); } catch (e) { return ''; } })(),
    his: his,
    cnt: cnt,
    stat: {
      since    : statusSince ? { date: statusSince.date, act: statusSince.act,
                                 days: statusSince.date ? dayNum(krDate_(statusSince.date).getTime()) : null } : null,
      lastTrouble: lastTrouble ? { date: lastTrouble.date, act: lastTrouble.act, hid: lastTrouble.hid } : null,
      lastNg   : lastNg ? { date: lastNg.date, act: lastNg.act, hid: lastNg.hid } : null,
      trouble12: troubleCount12
    },
    thumb: thumb,
    at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')
  };
}
