// タクシーアナライザの「営業ログCSV」から乗車地点を読み込む
// 列：日時, 営業日, 種別, …, 運賃合計, …, 乗車種別, 配車アプリ, 乗車時刻, 乗車施設, 乗車住所, 乗車住所の入力, 乗車緯度, 乗車経度, …

// UTF-8（BOM付き含む）で読めなければ Shift_JIS として読む（Excelで保存し直した場合など）
export function decodeCsv(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

const parseStamp = (v) => {
  const m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(v || '');
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : null;
};

// 「〇〇駅（駅）」→「〇〇駅」
const placeName = (v) => (v ? v.replace(/（[^（）]*）$/, '').trim() : '');
// 住所は番地を落として短く
const shortAddr = (v) => (v ? v.replace(/^日本[、,\s]*/, '').replace(/〒?\d{3}-?\d{4}\s*/, '').replace(/^(東京都|北海道|京都府|大阪府|.{2,3}県)/, '').replace(/[0-9０-９].*$/, '').replace(/[、,\s\-－]+$/, '').slice(0, 14) : '');

// 戻り値：{ rides: [{lng,lat,t,name,fac,addr,fare,kind,app}], total, skipped }
// 施設や手入力で記録した乗車は緯度・経度が空なので lat/lng は null（施設名・住所から位置を調べて使う）
export function importAnalyzerCsv(text) {
  const rows = parseCsv(text);
  const head = (rows.shift() || []).map((h) => h.trim());
  const ci = (name) => head.indexOf(name);
  if (ci('種別') < 0 || ci('乗車緯度') < 0 || ci('乗車経度') < 0) {
    throw new Error('タクシーアナライザの「営業ログ」CSVではありません（乗車緯度・乗車経度の列がありません）');
  }
  const get = (r, name) => { const i = ci(name); return i < 0 ? '' : (r[i] || '').trim(); };
  const rides = [];
  let total = 0, skipped = 0;
  for (const r of rows) {
    if (get(r, '種別') !== '乗車記録') continue;
    total++;
    const lat = parseFloat(get(r, '乗車緯度')), lng = parseFloat(get(r, '乗車経度'));
    const t = parseStamp(get(r, '乗車時刻')) ?? parseStamp(get(r, '日時'));
    // 日本付近の座標だけ使う
    const hasPos = Number.isFinite(lat) && Number.isFinite(lng) && lat > 20 && lat < 46 && lng > 122 && lng < 154;
    const fac = placeName(get(r, '乗車施設')), addr = get(r, '乗車住所');
    if (t == null || (!hasPos && !fac && !addr)) { skipped++; continue; }
    rides.push({
      lng: hasPos ? lng : null, lat: hasPos ? lat : null, t, fac, addr,
      name: fac || shortAddr(addr) || null,
      fare: +get(r, '運賃合計') || 0,
      kind: get(r, '乗車種別'),
      app: get(r, '配車アプリ'),
    });
  }
  rides.sort((a, b) => a.t - b.t);
  return { rides, total, skipped };
}

// 流し・乗り場（その場で拾えた需要）だけに絞る。アプリ・無線・予約は呼ばれた場所なので除く
// 乗車地点ごとにまとめるキー（施設名、なければ住所）
export const placeKey = (r) => r.fac || r.addr || '';

export const isStreetRide = (r) => !r.app && (r.kind === '流し' || r.kind === '乗り場' || r.kind === '');
