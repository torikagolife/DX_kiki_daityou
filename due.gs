/*** 医療機器DX台帳 ─ 点検期限（期限切れ・7日以内・期限が近い）*************
 *  due.gs
 *
 *  点検の「次回予定日」までの残り日数から、3段階の目印を付けます。
 *
 *    ⛔ over  期限切れ        次回予定日を過ぎた
 *    ⚠️ week  7日以内         周期に関係なく、今日から7日以内
 *    🗓 soon  期限が近い      周期の4分の1（最短7日・最長60日）より内側
 *
 *    「期限が近い」の幅（周期ごと）
 *       1か月 → 7日   2か月 → 15日   3か月 → 22日   4か月 → 30日
 *       6か月 → 45日  12か月以上 → 60日
 *    一律1か月にしないのは、毎月点検の機器がいつ見ても「近い」になってしまうため。
 *
 *  使うところ
 *    台帳ビューの上のカード   … dueAugmentLedger_()（web.gs の apiGetLedger から）
 *    点検画面の機器カード     … dueForDevice_()（apiGetContext と cfapi の device から）
 *    点検画面の「期限が近い機器」… getDueList()（部署ごとの一覧。部署点検だけ）
 *
 *  次回予定日の出し方は台帳ビューと同じ
 *    最後の実施日 ＋ 周期（月）。月末をはみ出したら月末に丸める（EDATEと同じ）
 *    部署点検 = ACT002、業者点検 = ACT003（業者点検）と ACT004（校正）
 *    実施記録が無い機器は次回予定日を出さない（台帳の「点検記録なし」に入る）
 *
 *  ⚠️ 読むだけです。どのシートにも書き込みません。
 *
 *  使っているもの（ほかのファイルにある）
 *    getTable / SHEET … データ層
 **********************************************************************/

const DUE_WEEK  = 7;      // 「7日以内」の日数
const DUE_RATIO = 0.25;   // 「期限が近い」は周期のこの割合
const DUE_MIN   = 7;      // 「期限が近い」の最短（日）
const DUE_MAX   = 60;     // 「期限が近い」の最長（日）
const DUE_SKIP_STATUS = ['廃棄', '紛失'];   // 期限を数えない機器

const DUE_ACT_DEPT  = ['ACT002'];
const DUE_ACT_MAKER = ['ACT003', 'ACT004'];

/* =============================================================
 *  決まりごと
 * ============================================================= */

// 周期（月）から「期限が近い」の幅（日）
function dueWindow_(cycleMonths) {
  const c = Number(cycleMonths) || 0;
  if (c <= 0) return 0;
  return Math.max(DUE_MIN, Math.min(DUE_MAX, Math.floor(c * 30 * DUE_RATIO)));
}

// 残り日数と周期から目印
function dueLevel_(days, cycleMonths) {
  if (days === null || days === undefined || isNaN(days)) return '';
  if (days < 0) return 'over';
  if (days <= DUE_WEEK) return 'week';
  if (days <= dueWindow_(cycleMonths)) return 'soon';
  return '';
}

// 画面に出す決まりの説明
function dueRuleText_() {
  return '⚠️ 7日以内　🗓 期限が近い＝周期の4分の1（最短' + DUE_MIN + '日・最長' + DUE_MAX + '日）より内側'
       + '（1か月→' + dueWindow_(1) + '日、3か月→' + dueWindow_(3) + '日、6か月→' + dueWindow_(6)
       + '日、12か月→' + dueWindow_(12) + '日）';
}

/* =============================================================
 *  日付の小道具（日本時間の「日」で数える）
 * ============================================================= */

function dueDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = String(v).trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// 日本時間の年月日を通し日数にする（時刻やタイムゾーンのずれを消すため）
function dueDayNum_(d) {
  const s = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd').split('-');
  return Math.round(Date.UTC(Number(s[0]), Number(s[1]) - 1, Number(s[2])) / 86400000);
}

function dueToday_() {
  return dueDayNum_(new Date());
}

// 月を足す。はみ出した日は月末に丸める（1/31 ＋ 1か月 → 2/28）
function dueAddMonths_(d, n) {
  const s = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd').split('-');
  const y = Number(s[0]), m = Number(s[1]) - 1 + Number(n), day = Number(s[2]);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)) - 9 * 3600000);   // 日本時間の0時
}

function dueFmt_(d) {
  return d ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd') : '';
}

/* =============================================================
 *  下ごしらえ（マスタと履歴を1回だけ読む）
 * ============================================================= */

function dueBase_() {
  const cats = {};
  getTable(SHEET.CAT, { fresh: true }).rows.forEach(function (r) {
    cats[String(r['機器区分ID'])] = r;
  });

  // 機器ごとの最後の実施日
  const last = {};
  getTable(SHEET.HIS, { fresh: true }).rows.forEach(function (h) {
    const no = String(h['管理番号'] || '');
    if (!no) return;
    const act = String(h['アクションID'] || '');
    const kind = DUE_ACT_DEPT.indexOf(act) >= 0 ? 'dept'
               : DUE_ACT_MAKER.indexOf(act) >= 0 ? 'maker' : '';
    if (!kind) return;
    const d = dueDate_(h['実施日']);
    if (!d) return;
    const x = last[no] = last[no] || {};
    if (!x[kind] || d > x[kind]) x[kind] = d;
  });

  return { cats: cats, last: last, today: dueToday_() };
}

// 機器1台ぶんの期限（部署点検・業者点検）
function dueOf_(dev, base) {
  const cat = base.cats[String(dev['機器区分ID'])] || {};
  const last = base.last[String(dev['管理番号'])] || {};
  const skip = DUE_SKIP_STATUS.indexOf(String(dev['ステータス'] || '')) >= 0;

  const one = function (kind, label, cycle) {
    const c = Number(cycle) || 0;
    const l = last[kind] || null;
    const out = { kind: label, cycle: c, last: dueFmt_(l), next: '', days: null, level: '', window: dueWindow_(c) };
    if (!c || !l) return out;
    const next = dueAddMonths_(l, c);
    out.next = dueFmt_(next);
    out.days = dueDayNum_(next) - base.today;
    out.level = skip ? '' : dueLevel_(out.days, c);
    return out;
  };

  return {
    dept : one('dept',  '部署点検', cat['部署点検周期(月)']),
    maker: one('maker', '業者点検', cat['業者点検周期(月)'])
  };
}

/* =============================================================
 *  点検画面：機器カードに出す期限
 * ============================================================= */

function dueForDevice_(kanriNo) {
  try {
    const no = String(kanriNo || '').trim();
    const dev = getTable(SHEET.DEV, { fresh: true }).rows.filter(function (r) {
      return String(r['管理番号']).toUpperCase() === no.toUpperCase();
    })[0];
    if (!dev) return null;
    return dueOf_(dev, dueBase_());
  } catch (e) {
    return null;      // 期限が出せなくても点検はできるようにする
  }
}

/* =============================================================
 *  点検画面：部署ごとの「期限が近い機器」（部署点検だけ）
 *    業者点検は現場の仕事ではないので、ここには出さない
 * ============================================================= */

function getDueList(dept) {
  dept = String(dept || '').trim();
  const base = dueBase_();
  const devs = getTable(SHEET.DEV, { fresh: true }).rows
    .filter(function (r) { return String(r['管理番号'] || '').trim(); });

  const seen = {}, depts = [];
  const items = [];
  const counts = { over: 0, week: 0, soon: 0 };

  devs.forEach(function (d) {
    const dp = String(d['部署名'] || '');
    if (dp && !seen[dp]) { seen[dp] = 1; depts.push(dp); }
    if (dept && dp !== dept) return;

    const due = dueOf_(d, base).dept;
    if (!due.level) return;
    counts[due.level]++;
    items.push({
      kanriNo: String(d['管理番号']),
      name   : String(d['機器名'] || ''),
      dept   : dp,
      loc    : String(d['保管場所名'] || ''),
      next   : due.next,
      days   : due.days,
      level  : due.level,
      cycle  : due.cycle
    });
  });

  items.sort(function (a, b) {
    return (a.days - b.days) || a.kanriNo.localeCompare(b.kanriNo);
  });

  return {
    depts : depts.sort(function (a, b) { return a.localeCompare(b, 'ja'); }),
    dept  : dept,
    items : items,
    counts: counts,
    rule  : dueRuleText_(),
    today : Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd')
  };
}

/* =============================================================
 *  台帳ビュー：行に目印を足す
 *    台帳が出している次回予定日（nextDept / nextMaker）をそのまま使う。
 *    画面に出ている日付と色が食い違わないように。
 *    期限切れの判定も台帳の _overDept / _overMaker に合わせる。
 * ============================================================= */

function dueAugmentLedger_(d) {
  if (!d || !d.rows) return d;
  try {
    const cats = {};
    getTable(SHEET.CAT, { fresh: true }).rows.forEach(function (r) {
      cats[String(r['機器区分ID'])] = r;
    });
    const catOf = {};
    getTable(SHEET.DEV, { fresh: true }).rows.forEach(function (r) {
      catOf[String(r['管理番号'])] = cats[String(r['機器区分ID'])] || {};
    });
    const today = dueToday_();

    const mark = function (row, nextStr, over, cycle) {
      if (DUE_SKIP_STATUS.indexOf(String(row.status || '')) >= 0) return { level: '', days: null };
      const nd = dueDate_(nextStr);
      const days = nd ? dueDayNum_(nd) - today : null;
      if (over) return { level: 'over', days: days };
      return { level: days === null ? '' : dueLevel_(days, cycle), days: days };
    };

    d.rows.forEach(function (r) {
      const cat = catOf[String(r.kanriNo)] || {};
      r._dueDept  = mark(r, r.nextDept,  !!r._overDept,  cat['部署点検周期(月)']);
      r._dueMaker = mark(r, r.nextMaker, !!r._overMaker, cat['業者点検周期(月)']);
    });
    d.dueRule = dueRuleText_();
  } catch (e) {
    d.dueRule = '';     // 目印が付けられなくても台帳は出す
  }
  return d;
}
