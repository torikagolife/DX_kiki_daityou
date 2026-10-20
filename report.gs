/*** 医療機器DX台帳 ─ 立入検査向けの帳票 ********************************
 *  report.gs
 *
 *  医療法施行規則（医療機器の保守点検に関する計画の策定と、適切な実施）で
 *  求められる2つの書類を、台帳と履歴から作ります。
 *
 *    ① 保守点検計画（年度ごと）
 *         医療機器名・製造販売業者名・型式・購入年（＝使用開始日で代用）・
 *         保守点検をする時期と間隔。年度12か月の「予定」と「実績」を並べる。
 *    ② 保守点検・修理の記録（期間を指定）
 *         医療機器名・製造販売業者名・型式・購入年に加えて、
 *         保守点検の記録（年月日・概要・実施者）と修理の記録（年月日・概要・記録者）。
 *
 *  ⚠️ 読むだけです。台帳にも履歴にも書き込みません。
 *
 *  使っているもの（ほかのファイルにある）
 *    getTable / SHEET / ACTIVE … データ層
 **********************************************************************/

// 帳票で使うアクション
const RP_ACT_DEPT   = 'ACT002';                 // 部署点検
const RP_ACT_VENDOR = ['ACT003', 'ACT004'];     // 業者点検（校正は業者点検に統合）
const RP_ACT_REPAIR = ['ACT005', 'ACT006', 'ACT007'];   // 故障報告・故障出し・故障復帰
const RP_GONE       = ['廃棄', '紛失'];         // 計画には載せないステータス

/* =============================================================
 *  日付の小道具（シートの値が Date でも文字列でも読む）
 * ============================================================= */

function rpDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim().replace(/-/g, '/');
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function rpFmt_(d) {
  return d ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd') : '';
}

// 年×12＋月 の通し番号（月の足し引きを簡単にするため）
function rpMonthIdx_(d) {
  const s = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM').split('-');
  return Number(s[0]) * 12 + (Number(s[1]) - 1);
}

function rpIdxLabel_(idx) {
  return Math.floor(idx / 12) + '/' + ('0' + (idx % 12 + 1)).slice(-2);
}

// いまの年度（4月始まり）
function rpThisFy_() {
  const s = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM').split('-');
  const y = Number(s[0]), m = Number(s[1]);
  return m >= 4 ? y : y - 1;
}

/* =============================================================
 *  共通の下ごしらえ
 * ============================================================= */

function rpLoad_() {
  const cats = {};
  getTable(SHEET.CAT, { fresh: true }).rows.forEach(function (r) {
    cats[String(r['機器区分ID'])] = r;
  });
  const users = {};
  getTable(SHEET.USR, { fresh: true }).rows.forEach(function (r) {
    users[String(r['職員番号'])] = String(r['ユーザー名'] || '');
  });
  const sheets = {};
  getTable(SHEET.CHK, { fresh: true }).rows.forEach(function (r) {
    sheets[String(r['点検表ID'])] = String(r['点検表名'] || '');
  });
  const devs = getTable(SHEET.DEV, { fresh: true }).rows
    .filter(function (r) { return String(r['管理番号'] || '').trim(); });
  const his = getTable(SHEET.HIS, { fresh: true }).rows;
  return { cats: cats, users: users, sheets: sheets, devs: devs, his: his };
}

function rpIsSpecial_(cat) {
  return !!cat && String(cat['特定保守管理医療機器'] || '') === ACTIVE;
}

// 絞り込み。opt = { scope:'special'|'all', site, dept, cat }
function rpPick_(base, opt, includeGone) {
  opt = opt || {};
  return base.devs.filter(function (d) {
    const cat = base.cats[String(d['機器区分ID'])];
    if (opt.scope !== 'all' && !rpIsSpecial_(cat)) return false;
    if (opt.site && String(d['拠点'] || '') !== opt.site) return false;
    if (opt.dept && String(d['部署名'] || '') !== opt.dept) return false;
    if (opt.cat  && String(d['機器区分名'] || '') !== opt.cat) return false;
    if (!includeGone && RP_GONE.indexOf(String(d['ステータス'] || '')) >= 0) return false;
    return true;
  }).sort(function (a, b) {
    return (String(a['部署名'] || '') + '\t' + String(a['機器区分名'] || '') + '\t' + String(a['管理番号']))
      .localeCompare(String(b['部署名'] || '') + '\t' + String(b['機器区分名'] || '') + '\t' + String(b['管理番号']), 'ja');
  });
}

// 帳票の頭に出す、機器1台ぶんの基本情報（記載事項の①〜③）
function rpDevHead_(d, cat) {
  const start = rpDate_(d['使用開始日']);
  return {
    kanriNo : String(d['管理番号']),
    name    : String(d['機器名'] || ''),
    category: String(d['機器区分名'] || ''),
    maker   : String(d['メーカー名'] || ''),
    model   : String(d['型番'] || ''),
    serial  : String(d['製造番号'] || ''),
    start   : rpFmt_(start),
    startY  : start ? Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy') : '',
    dept    : String(d['部署名'] || ''),
    loc     : String(d['保管場所名'] || ''),
    site    : String(d['拠点'] || ''),
    status  : String(d['ステータス'] || ''),
    contract: String(d['保守契約有無'] || ''),
    special : rpIsSpecial_(cat),
    cls     : String(d['クラス分類'] || '')
  };
}

// 機器ごとの履歴を、種類別に日付順で持つ
function rpHisByDev_(his) {
  const out = {};
  his.forEach(function (h) {
    const no = String(h['管理番号'] || '');
    if (!no) return;
    const d = rpDate_(h['実施日']) || rpDate_(h['登録日時']);
    if (!d) return;
    (out[no] = out[no] || []).push({ h: h, d: d, act: String(h['アクションID'] || '') });
  });
  Object.keys(out).forEach(function (k) {
    out[k].sort(function (a, b) { return a.d - b.d; });
  });
  return out;
}

/* =============================================================
 *  画面の選択肢
 * ============================================================= */

function getReportBase() {
  const devs = getTable(SHEET.DEV, { fresh: true }).rows;
  const uniq = function (col) {
    const seen = {}, out = [];
    devs.forEach(function (d) {
      const v = String(d[col] || '').trim();
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    });
    return out.sort(function (a, b) { return a.localeCompare(b, 'ja'); });
  };

  // 年度の選択肢：履歴のいちばん古い年度〜来年度
  const fy = rpThisFy_();
  let oldest = fy;
  getTable(SHEET.HIS, { fresh: true }).rows.forEach(function (h) {
    const d = rpDate_(h['実施日']);
    if (!d) return;
    const s = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM').split('-');
    const y = Number(s[1]) >= 4 ? Number(s[0]) : Number(s[0]) - 1;
    if (y < oldest && y >= 2000) oldest = y;
  });
  const years = [];
  for (let y = fy + 1; y >= Math.max(oldest, fy - 10); y--) years.push(y);

  return {
    sites: uniq('拠点'), depts: uniq('部署名'), cats: uniq('機器区分名'),
    years: years, thisFy: fy,
    today: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd')
  };
}

/* =============================================================
 *  ① 保守点検計画
 *    opt = { fy, scope, site, dept, cat }
 *
 *    予定の立て方（種類ごと）
 *      周期 = 機器区分マスタの「部署点検周期(月)」「業者点検周期(月)」
 *      起点 = 年度が始まる前の最後の実施日。無ければ使用開始日。どちらも無ければ4月
 *      予定 = 起点の月＋周期、さらに＋周期…のうち、年度の12か月に入る月
 *             起点＋周期が年度の前に過ぎていたら（＝期限切れのまま年度に入ったら）、4月を最初の予定にする
 *    セルの記号
 *      P 予定 / D 実施（予定外を含む）/ PD 予定どおり実施 / M 予定月が過ぎたのに実施なし
 *      O 予定はあるが、システム導入前（opt.since より前）なので記録は紙を見る
 *    opt.since = 'yyyy-MM'（任意）。この月より前は「実施なし」にしない
 * ============================================================= */

function getMaintenancePlan(opt) {
  opt = opt || {};
  const fy = Number(opt.fy) || rpThisFy_();
  const base = rpLoad_();
  const byDev = rpHisByDev_(base.his);
  const fyStart = fy * 12 + 3;                  // 4月
  const nowIdx = rpMonthIdx_(new Date());
  const sm = String(opt.since || '').match(/^(\d{4})-(\d{1,2})/);
  const sinceIdx = sm ? Number(sm[1]) * 12 + Number(sm[2]) - 1 : 0;

  const months = [];
  for (let i = 0; i < 12; i++) months.push(((fyStart + i) % 12) + 1);

  const list = [], warn = [];
  rpPick_(base, opt, false).forEach(function (d) {
    const cat = base.cats[String(d['機器区分ID'])];
    const head = rpDevHead_(d, cat);
    const recs = byDev[head.kanriNo] || [];

    const kinds = [
      { key: 'dept',   label: '部署点検', acts: [RP_ACT_DEPT],
        cycle: Number(cat ? cat['部署点検周期(月)'] : 0) || 0 },
      { key: 'vendor', label: '業者点検', acts: RP_ACT_VENDOR,
        cycle: Number(cat ? cat['業者点検周期(月)'] : 0) || 0 },
    ];

    const rows = [];
    kinds.forEach(function (k) {
      const mine = recs.filter(function (r) { return k.acts.indexOf(r.act) >= 0; });
      const inFy = mine.filter(function (r) {
        const i = rpMonthIdx_(r.d);
        return i >= fyStart && i < fyStart + 12;
      });
      // 周期も無く、年度内の実施も無い種類は行にしない
      if (!k.cycle && !inFy.length) return;

      const before = mine.filter(function (r) { return rpMonthIdx_(r.d) < fyStart; });
      const lastBefore = before.length ? before[before.length - 1].d : null;
      const startD = rpDate_(d['使用開始日']);

      const plan = {};
      let note = '';
      if (k.cycle > 0) {
        let m;
        if (lastBefore)  m = rpMonthIdx_(lastBefore) + k.cycle;
        else if (startD) m = rpMonthIdx_(startD) + k.cycle;
        else { m = fyStart; note = '起点なし（4月から）'; }
        if (m < fyStart) {
          if (lastBefore) note = '年度当初で期限切れ';
          // 期限切れ・起点が古いときは4月を最初の予定にする
          m = fyStart;
        }
        while (m < fyStart + 12) { plan[m] = 1; m += k.cycle; }
        if (!Object.keys(plan).length) {
          // 周期が長く、この年度に予定が無い（例：24か月ごと）
          const nx = (lastBefore ? rpMonthIdx_(lastBefore) : (startD ? rpMonthIdx_(startD) : fyStart)) + k.cycle;
          note = '年度内の予定なし（次回 ' + rpIdxLabel_(nx) + '）';
        }
      } else {
        note = '周期が未設定';
      }

      const done = {};
      inFy.forEach(function (r) { done[rpMonthIdx_(r.d)] = (done[rpMonthIdx_(r.d)] || 0) + 1; });

      const cells = [];
      let planN = 0, doneN = 0, missN = 0;
      for (let i = 0; i < 12; i++) {
        const idx = fyStart + i;
        const p = !!plan[idx], dn = !!done[idx];
        let c = '';
        if (p && dn) c = 'PD';
        else if (dn) c = 'D';
        else if (p && idx < sinceIdx) c = 'O';
        else if (p && idx < nowIdx) c = 'M';
        else if (p) c = 'P';
        cells.push(c);
        if (p) planN++;
        if (dn) doneN++;
        if (c === 'M') missN++;
      }

      const last = mine.length ? mine[mine.length - 1].d : null;
      rows.push({
        kind: k.label, cycle: k.cycle, cells: cells, note: note,
        planN: planN, doneN: doneN, missN: missN,
        last: rpFmt_(last),
        next: (k.cycle > 0 && last) ? rpIdxLabel_(rpMonthIdx_(last) + k.cycle) : ''
      });
    });

    if (!rows.length) {
      warn.push({ kanriNo: head.kanriNo, name: head.name, dept: head.dept,
                  why: '機器区分「' + (head.category || '未設定') + '」に点検周期が入っていません' });
    } else {
      rows.forEach(function (r) {
        if (r.note === '周期が未設定' && r.kind === '部署点検' && head.special) {
          warn.push({ kanriNo: head.kanriNo, name: head.name, dept: head.dept,
                      why: '部署点検の周期が未設定なのに、実施記録があります' });
        }
      });
    }
    if (!head.start) {
      warn.push({ kanriNo: head.kanriNo, name: head.name, dept: head.dept,
                  why: '使用開始日（購入年）が入っていません' });
    }
    if (!head.maker || !head.model) {
      warn.push({ kanriNo: head.kanriNo, name: head.name, dept: head.dept,
                  why: (!head.maker ? 'メーカー' : '') + (!head.maker && !head.model ? '・' : '')
                     + (!head.model ? '型番' : '') + 'が入っていません' });
    }

    list.push({ dev: head, rows: rows });
  });

  // 集計
  let planN = 0, doneN = 0, missN = 0;
  list.forEach(function (x) {
    x.rows.forEach(function (r) { planN += r.planN; doneN += r.doneN; missN += r.missN; });
  });

  return {
    fy: fy, months: months,
    since: sinceIdx ? rpIdxLabel_(sinceIdx) : '',
    period: fy + '/04/01 〜 ' + (fy + 1) + '/03/31',
    list: list, warn: warn,
    sum: { devices: list.length, plan: planN, done: doneN, miss: missN },
    made: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')
  };
}

/* =============================================================
 *  ② 保守点検・修理の記録
 *    opt = { from:'yyyy-MM-dd', to:'yyyy-MM-dd', scope, site, dept, cat,
 *            withDept:true|false（部署点検を含める）, withEmpty:true|false（記録の無い機器も載せる） }
 * ============================================================= */

function getMaintenanceRecords(opt) {
  opt = opt || {};
  const fy = rpThisFy_();
  const from = rpDate_(opt.from) || new Date(fy, 3, 1);
  const to   = rpDate_(opt.to)   || new Date(fy + 1, 2, 31);
  if (from > to) throw new Error('期間の始まりが終わりより後になっています');
  const toEnd = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59);

  const base = rpLoad_();
  const byDev = rpHisByDev_(base.his);
  const withDept = opt.withDept !== false;

  const inspActs = (withDept ? [RP_ACT_DEPT] : []).concat(RP_ACT_VENDOR);

  // 期間内の点検の履歴IDを集めて、×が付いた項目名を引けるようにする
  const want = {};
  Object.keys(byDev).forEach(function (no) {
    byDev[no].forEach(function (r) {
      if (r.d >= from && r.d <= toEnd && r.act === RP_ACT_DEPT && withDept) {
        want[String(r.h['履歴ID'])] = [];
      }
    });
  });
  if (Object.keys(want).length) {
    const items = {};
    getTable(SHEET.ITM, { fresh: true }).rows.forEach(function (r) {
      items[String(r['点検項目ID'])] = { name: String(r['項目名'] || ''), type: String(r['入力形式'] || '') };
    });
    getTable(SHEET.RES, { fresh: true }).rows.forEach(function (r) {
      const hid = String(r['履歴ID']);
      if (!want[hid]) return;
      const it = items[String(r['点検項目ID'])];
      if (it && it.type === '○×' && String(r['入力値']) === '×') want[hid].push(it.name);
    });
  }

  const user = function (id) {
    const n = base.users[String(id || '')];
    return n || (id ? String(id) : '');
  };

  const list = [];
  let inspN = 0, repairN = 0, emptyN = 0;
  rpPick_(base, opt, true).forEach(function (d) {
    const cat = base.cats[String(d['機器区分ID'])];
    const head = rpDevHead_(d, cat);
    const recs = (byDev[head.kanriNo] || []).filter(function (r) { return r.d >= from && r.d <= toEnd; });

    const insp = recs.filter(function (r) { return inspActs.indexOf(r.act) >= 0; }).map(function (r) {
      const h = r.h;
      const isDept = r.act === RP_ACT_DEPT;
      const parts = [];
      const sheet = base.sheets[String(h['点検表ID'] || '')];
      parts.push(isDept ? ('部署点検' + (sheet ? '（' + sheet + '）' : '')) : '業者点検');
      const ng = want[String(h['履歴ID'])] || [];
      if (ng.length) parts.push('× ' + ng.join('、'));
      const memo = String(h['備考'] || '').trim();
      if (memo) parts.push(memo);
      return { date: rpFmt_(r.d), kind: isDept ? '部署点検' : '業者点検',
               summary: parts.join(' ／ '), judge: String(h['総合判定'] || ''),
               who: user(h['職員番号(実施者)']), hid: String(h['履歴ID']) };
    });

    const rep = recs.filter(function (r) { return RP_ACT_REPAIR.indexOf(r.act) >= 0; }).map(function (r) {
      const h = r.h;
      const kind = r.act === 'ACT005' ? '故障報告' : (r.act === 'ACT006' ? '故障出し（修理へ）' : '故障復帰（修理完了）');
      const parts = [];
      const body = String(h['故障内容／対応内容'] || '').trim();
      if (body) parts.push(body);
      const memo = String(h['備考'] || '').trim();
      if (memo) parts.push(memo);
      return { date: rpFmt_(r.d), kind: kind, summary: parts.join(' ／ '),
               who: user(h['職員番号(実施者)']), hid: String(h['履歴ID']) };
    });

    if (!insp.length && !rep.length) {
      // 計画の対象（廃棄・紛失以外）で記録が無いものは、数えておく
      if (RP_GONE.indexOf(head.status) < 0) emptyN++;
      if (!opt.withEmpty) return;
      if (RP_GONE.indexOf(head.status) >= 0) return;
    }

    inspN += insp.length;
    repairN += rep.length;
    list.push({ dev: head, insp: insp, repair: rep });
  });

  return {
    from: rpFmt_(from), to: rpFmt_(to), withDept: withDept,
    list: list,
    sum: { devices: list.length, insp: inspN, repair: repairN, empty: emptyN },
    made: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')
  };
}
