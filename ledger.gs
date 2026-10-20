/*** 医療機器DX台帳 ─ 台帳ビュー ********************************
 *  ledger.gs
 *  機器マスタ・履歴・機器区分から18列を導出して返す
 *  スプレッドシートの数式には依存しない（画面で毎回計算する）
 ****************************************************************/

function getLedger() {
  const devs = getTable(SHEET.DEV, { fresh: true }).rows;
  const cats = indexBy(getTable(SHEET.CAT, { fresh: true }).rows, '機器区分ID');
  const his  = getTable(SHEET.HIS, { fresh: true }).rows;

  // 管理番号ごとに、部署点検・業者点検の最新実施日を集める
  const last = {};
  for (let i = 0; i < his.length; i++) {
    const h   = his[i];
    const key = String(h['管理番号'] || '');
    if (!key) continue;
    const act = String(h['アクションID'] || '');
    const d   = h['実施日'];
    if (!d) continue;
    const t = new Date(d).getTime();
    if (isNaN(t)) continue;

    if (!last[key]) last[key] = { dept: 0, maker: 0 };
        if (act === ACT_INSPECT && t > last[key].dept)  last[key].dept  = t;
    // 業者点検（校正は業者点検に統合したが、過去データ用にACT004も拾う）
    if ((act === 'ACT003' || act === 'ACT004') && t > last[key].maker) last[key].maker = t;
  }

  const todayT = today_().getTime();

  const rows = devs.map(function (d) {
    const no  = String(d['管理番号'] || '');
    const cat = cats[String(d['機器区分ID'] || '')] || null;
    const L   = last[no] || { dept: 0, maker: 0 };

    const lastDept  = L.dept  ? new Date(L.dept)  : null;
    const lastMaker = L.maker ? new Date(L.maker) : null;

    const cycleDept  = cat ? toNum_(cat['部署点検周期(月)']) : 0;
    const cycleMaker = cat ? toNum_(cat['業者点検周期(月)']) : 0;

    const nextDept  = (lastDept  && cycleDept  > 0) ? addMonths_(lastDept,  cycleDept)  : null;
    const nextMaker = (lastMaker && cycleMaker > 0) ? addMonths_(lastMaker, cycleMaker) : null;

    const status = String(d['ステータス'] || '');

    return {
      kanriNo   : no,
      name      : String(d['機器名'] || ''),
      category  : String(d['機器区分名'] || ''),
      maker     : String(d['メーカー名'] || ''),
      model     : String(d['型番'] || ''),
      serial    : String(d['製造番号'] || ''),
      dept      : String(d['部署名'] || ''),
      loc       : String(d['保管場所名'] || ''),
      site      : String(d['拠点'] || ''),
      status    : status,
      lastDept  : fmtDate_(lastDept),
      nextDept  : fmtDate_(nextDept),
      lastMaker : fmtDate_(lastMaker),
      nextMaker : fmtDate_(nextMaker),
      years     : yearsFrom_(d['使用開始日']),
      tokutei   : cat ? String(cat['特定保守管理医療機器'] || '') : '',
      devClass  : String(d['クラス分類'] || ''),
      fileBox   : String(d['ファイルBOXID'] || ''),
      memo      : String(d['備考'] || ''),

      // 画面での色分け・絞り込み用
      _overDept  : !!(nextDept  && nextDept.getTime()  < todayT),
      _overMaker : !!(nextMaker && nextMaker.getTime() < todayT),
      _noRecord  : !lastDept && !lastMaker,
      _trouble   : (status === ST_TROUBLE || status === '修理中'),
      _retired   : (status === '廃棄' || status === '紛失')
    };
  });

  // 絞り込み用の選択肢
  const uniq = function (arr) {
    const seen = {}, out = [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    return out.sort();
  };

  return {
    rows   : rows,
    sites  : uniq(rows.map(function (r) { return r.site; })),
    depts  : uniq(rows.map(function (r) { return r.dept; })),
    cats   : uniq(rows.map(function (r) { return r.category; })),
    stats  : uniq(rows.map(function (r) { return r.status; })),
    today  : fmtDate_(today_())
  };
}

/* ---------- 補助 ---------- */

function toNum_(v) {
  const n = Number(String(v === undefined || v === null ? '' : v).trim());
  return isNaN(n) ? 0 : n;
}

// 月を足す。月末日のはみ出しはその月の末日に丸める
function addMonths_(d, months) {
  const base = new Date(d);
  const y = base.getFullYear();
  const m = base.getMonth();
  const day = base.getDate();
  const t = new Date(y, m + months, 1);
  const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return new Date(t.getFullYear(), t.getMonth(), Math.min(day, lastDay));
}

function yearsFrom_(start) {
  if (!start) return '';
  const s = new Date(start);
  if (isNaN(s.getTime())) return '';
  const n = today_();
  let y = n.getFullYear() - s.getFullYear();
  const md = (n.getMonth() - s.getMonth()) * 100 + (n.getDate() - s.getDate());
  if (md < 0) y--;
  return (y >= 0) ? String(y) : '';
}

/* ---------- 動作確認 ---------- */

function ledgerTest() {
  const d = getLedger();
  const log = ['台帳 ' + d.rows.length + '行 / 基準日 ' + d.today];
  for (let i = 0; i < d.rows.length; i++) {
    const r = d.rows[i];
    log.push([
      r.kanriNo, r.status,
      '最終' + (r.lastDept || '—'),
      '次回' + (r.nextDept || '—') + (r._overDept ? ' ⚠期限切れ' : ''),
      '業者' + (r.lastMaker || '—') + '→' + (r.nextMaker || '—'),
      r.years ? r.years + '年' : ''
    ].join(' / '));
  }
  Logger.log(log.join('\n'));
}