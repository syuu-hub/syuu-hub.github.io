// 外部の無料データソース
// ・Overpass API（OpenStreetMap）：駅・ホテル・病院・繁華街・商業施設
// ・Open-Meteo：現在の降水（※商用利用は有料プランが必要）
// ・ODPT（公共交通オープンデータ）：運行情報（任意・要無料登録キー）

export async function fetchSpots(center, radiusM = 6000) {
  const r = Math.min(10000, Math.round(radiusM));
  const [lng, lat] = center;
  const a = `(around:${r},${lat},${lng})`;
  const q = `[out:json][timeout:40];(
node["railway"="station"]${a};
node["railway"="halt"]["name"]${a};
nwr["tourism"="hotel"]${a};
nwr["amenity"="hospital"]${a};
node["amenity"~"^(bar|pub|nightclub|karaoke_box)$"]${a};
nwr["shop"~"^(mall|department_store)$"]${a};
);out center tags;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(q),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`需要スポットの取得に失敗しました (${res.status})`);
  const json = await res.json();
  const spots = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    const lat2 = el.lat ?? (el.center && el.center.lat);
    const lng2 = el.lon ?? (el.center && el.center.lon);
    if (lat2 == null) continue;
    let cat = null;
    if (t.railway === 'station' || t.railway === 'halt') cat = 'station';
    else if (t.tourism === 'hotel') cat = 'hotel';
    else if (t.amenity === 'hospital') cat = 'hospital';
    else if (/^(bar|pub|nightclub|karaoke_box)$/.test(t.amenity || '')) cat = 'nightlife';
    else if (/^(mall|department_store)$/.test(t.shop || '')) cat = 'shopping';
    if (!cat) continue;
    const name = t['name:ja'] || t.name || null;
    spots.push({
      id: `${el.type}/${el.id}`,
      name: cat === 'nightlife' ? null : name ? (cat === 'station' && !/駅$/.test(name) ? name + '駅' : name) : null,
      lng: lng2,
      lat: lat2,
      cat,
    });
  }
  return spots;
}

export async function fetchWeather([lng, lat]) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&current=precipitation,weather_code&timezone=Asia%2FTokyo`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('天気の取得に失敗しました');
  const j = await res.json();
  const mm = j.current?.precipitation ?? 0;
  const code = j.current?.weather_code ?? 0;
  if (mm >= 4 || [65, 67, 75, 82, 86, 95, 96, 99].includes(code)) return 'heavy';
  if (mm > 0.1 || (code >= 51 && code <= 86)) return 'rain';
  return 'clear';
}

// ODPT の運行情報から「平常運転」以外を検出
export async function fetchRailDisruption(consumerKey) {
  const url = `https://api.odpt.org/api/v4/odpt:TrainInformation?acl:consumerKey=${encodeURIComponent(consumerKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('運行情報の取得に失敗しました');
  const list = await res.json();
  const bad = [];
  for (const it of list) {
    const text = (it['odpt:trainInformationText'] && (it['odpt:trainInformationText'].ja || it['odpt:trainInformationText'].en)) || '';
    if (text && !/平常|通常|normal/i.test(text)) bad.push(text);
  }
  return bad;
}
