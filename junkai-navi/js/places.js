// 登録地点（任意で設定する需要地点・イベント会場）
// ・住所から緯度経度を調べる（国土地理院の住所検索 → 見つからなければ OpenStreetMap の Nominatim）
// ・CSV への書き出しと読み込み
import { fetchT } from './sources.js?v=7';
import { parseCsv } from './csv.js?v=7';

// 日本付近の座標か
export const inJapan = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat > 20 && lat < 46 && lng > 122 && lng < 154;

// 住所（または施設名）→ { lat, lng, title }。見つからなければ null
export async function geocode(addr, fetcher = fetchT) {
  const q = String(addr || '').trim();
  if (!q) return null;
  try {
    const res = await fetcher(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`, {}, 10000);
    if (res.ok) {
      const list = await res.json();
      const hit = Array.isArray(list) && list.find((f) => f && f.geometry && Array.isArray(f.geometry.coordinates));
      if (hit) {
        const [lng, lat] = hit.geometry.coordinates.map(Number);
        if (inJapan(lat, lng)) return { lat, lng, title: (hit.properties && hit.properties.title) || q };
      }
    }
  } catch { /* 次の検索へ */ }
  try {
    const res = await fetcher(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(q)}`, {}, 10000);
    if (res.ok) {
      const list = await res.json();
      const hit = Array.isArray(list) && list[0];
      if (hit) {
        const lat = +hit.lat, lng = +hit.lon;
        if (inJapan(lat, lng)) return { lat, lng, title: hit.display_name || q };
      }
    }
  } catch { /* 見つからない */ }
  return null;
}

// ===== CSV =====
export const PLACE_HEAD = ['名前', '住所', '種類', '終了日時', '規模', '緯度', '経度'];
const SIZE_JA = { s: '小', m: '中', l: '大' };
const SIZE_KEY = { 小: 's', 中: 'm', 大: 'l', s: 's', m: 'm', l: 'l' };
const pad = (n) => String(n).padStart(2, '0');
export const fmtStamp = (t) => { const d = new Date(t); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const parseStamp = (v) => {
  const m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[\sT]+(\d{1,2}):(\d{2})/.exec(String(v || '').trim());
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
};
const cell = (v) => { if (v == null) return ''; v = String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

export function placesToCsv(list) {
  const rows = [PLACE_HEAD];
  for (const p of list) {
    rows.push([
      p.name, p.addr || '', p.kind === 'event' ? 'イベント' : '常設',
      p.kind === 'event' && p.end ? fmtStamp(p.end) : '', p.kind === 'event' ? SIZE_JA[p.size] || '中' : '',
      p.lat != null ? (+p.lat).toFixed(6) : '', p.lng != null ? (+p.lng).toFixed(6) : '',
    ]);
  }
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// 戻り値：{ items: [{name, addr, kind, end?, size?, lat?, lng?}], errors: [行番号: 理由] }
// 緯度・経度が無い行は、取り込み時に住所から調べる
export function csvToPlaces(text) {
  const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
  const head = (rows.shift() || []).map((h) => h.trim());
  const ci = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const iName = ci('名前', '名称', '施設名'), iAddr = ci('住所', '所在地'), iKind = ci('種類', '種別');
  const iEnd = ci('終了日時', '終了時刻'), iSize = ci('規模'), iLat = ci('緯度', 'lat'), iLng = ci('経度', 'lng', 'lon');
  if (iAddr < 0 && (iLat < 0 || iLng < 0)) throw new Error('「住所」の列（または「緯度」「経度」の列）があるCSVを選んでください');
  const get = (r, i) => (i < 0 ? '' : String(r[i] ?? '').trim());
  const items = [], errors = [];
  rows.forEach((r, n) => {
    const line = n + 2;
    const addr = get(r, iAddr);
    const name = get(r, iName) || addr;
    let lat = parseFloat(get(r, iLat)), lng = parseFloat(get(r, iLng));
    if (!inJapan(lat, lng)) { lat = null; lng = null; }
    if (!addr && lat == null) { errors.push(`${line}行目：住所がありません`); return; }
    const kind = /イベント|event/i.test(get(r, iKind)) ? 'event' : 'custom';
    const item = { name, addr, kind };
    if (lat != null) { item.lat = lat; item.lng = lng; }
    if (kind === 'event') {
      const end = parseStamp(get(r, iEnd));
      if (end == null) { errors.push(`${line}行目：イベントの終了日時（例 2026/11/20 21:00）がありません`); return; }
      item.end = new Date(end).toISOString();
      item.size = SIZE_KEY[get(r, iSize)] || 'm';
    }
    items.push(item);
  });
  return { items, errors };
}

// 同じ名前・住所の地点は上書き、それ以外は追加。戻り値：{ list, added, updated }
export function mergePlaces(list, incoming, newId = () => 'u' + Date.now() + Math.random().toString(36).slice(2, 6)) {
  const out = list.slice();
  let added = 0, updated = 0;
  for (const it of incoming) {
    const i = out.findIndex((p) => p.name === it.name && (p.addr || '') === (it.addr || ''));
    if (i >= 0) { out[i] = { ...out[i], ...it, id: out[i].id }; updated++; }
    else { out.push({ ...it, id: newId() }); added++; }
  }
  return { list: out, added, updated };
}
