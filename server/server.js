const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const categories = {
  all: 'shop OR office OR craft OR amenity OR healthcare OR tourism OR leisure',
  auto: 'shop=car_repair OR shop=car OR craft=car_repair',
  pets: 'shop=pet OR amenity=veterinary',
  food: 'amenity=restaurant OR amenity=cafe OR amenity=fast_food OR amenity=bar',
  clothing: 'shop=clothes OR shop=shoes OR shop=boutique',
  furniture: 'shop=furniture OR shop=interior_decoration',
  beauty: 'shop=hairdresser OR shop=beauty OR amenity=beauty_salon',
  health: 'amenity=clinic OR amenity=dentist OR healthcare=doctor',
  construction: 'craft=builder OR shop=hardware OR craft=carpenter',
  other: 'shop OR craft OR office'
};

function escapeOverpass(value) {
  return String(value || '').replace(/[()[\]{}\\^$.*+?|]/g, ' ').trim().slice(0, 100);
}
function getTag(tags, keys) {
  for (const key of keys) if (tags && tags[key]) return tags[key];
  return '';
}
function cleanUrl(value) {
  if (!value) return '';
  let v = String(value).trim();
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    return u.href;
  } catch { return ''; }
}
function normalizeElement(el) {
  const t = el.tags || {};
  const name = t.name || t['name:pt'] || t.brand || 'Empresa sem nome cadastrado';
  const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
  const city = t['addr:city'] || t['addr:suburb'] || '';
  const state = t['addr:state'] || '';
  const website = cleanUrl(getTag(t, ['website', 'contact:website', 'url']));
  let instagram = getTag(t, ['contact:instagram', 'instagram']);
  if (instagram && !/^https?:\/\//i.test(instagram)) {
    instagram = 'https://www.instagram.com/' + instagram.replace(/^@/, '').replace(/^\/+|\/+$/g, '') + '/';
  }
  const phone = getTag(t, ['contact:phone', 'phone', 'contact:mobile', 'mobile']);
  const type = getTag(t, ['shop', 'amenity', 'craft', 'office', 'healthcare']) || 'estabelecimento';
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const osmUrl = `https://www.openstreetmap.org/${el.type}/${el.id}`;
  return {
    id: `osm-${el.type}-${el.id}`, name, type,
    address: [street, city, state].filter(Boolean).join(' — ') || 'Endereço não informado no mapa',
    city, state, phone, website, instagram,
    websiteStatus: website ? 'site-encontrado' : 'site-nao-identificado',
    instagramBioStatus: instagram ? 'revisao-manual' : 'instagram-nao-identificado',
    lat, lon, osmUrl,
    source: 'OpenStreetMap',
    note: website ? 'O mapa registra um site; confirme se pertence à empresa.' : 'Nenhum site registrado nesta fonte; isso não confirma ausência de site.'
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'LeadHunter Brasil', version: '0.1.0' }));

app.get('/api/search', async (req, res) => {
  const city = escapeOverpass(req.query.city);
  const state = escapeOverpass(req.query.state);
  const segment = String(req.query.segment || 'all');
  const limit = Math.max(10, Math.min(100, Number(req.query.limit) || 50));
  if (!city) return res.status(400).json({ error: 'Informe uma cidade para iniciar a busca.' });
  if (!categories[segment]) return res.status(400).json({ error: 'Segmento inválido.' });

  // Overpass searches within a named administrative area. State is appended to reduce ambiguity.
  const areaName = [city, state].filter(Boolean).join(', ');
  const filter = segment === 'all'
    ? '(shop)(name)(area.searchArea);'
    : null;
  const qParts = [];
  if (segment === 'all') {
    qParts.push(`nwr["name"]["shop"](area.searchArea);`);
    qParts.push(`nwr["name"]["amenity"~"restaurant|cafe|fast_food|bar|veterinary|clinic|dentist"](area.searchArea);`);
    qParts.push(`nwr["name"]["craft"](area.searchArea);`);
    qParts.push(`nwr["name"]["office"](area.searchArea);`);
  } else {
    const terms = categories[segment].split(' OR ').map(s => s.trim());
    for (const term of terms) {
      const [key, val] = term.includes('=') ? term.split('=') : [term, null];
      if (val) qParts.push(`nwr["name"]["${key}"="${val}"](area.searchArea);`);
      else qParts.push(`nwr["name"]["${key}"](area.searchArea);`);
    }
  }
  const query = `[out:json][timeout:25];area["name"="${areaName}"]["boundary"="administrative"]->.searchArea;(${qParts.join('')});out center tags ${limit};`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  let payload = null;
  let lastError = 'Fonte pública temporariamente indisponível.';
  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 28000);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'LeadHunterBrasil/0.1 (public-data research)' },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`Overpass respondeu HTTP ${response.status}`);
      payload = await response.json();
      break;
    } catch (err) { lastError = err.message || lastError; }
  }
  if (!payload) return res.status(503).json({ error: 'Não foi possível consultar a fonte pública agora. Tente novamente mais tarde.', detail: lastError });
  const seen = new Set();
  const results = [];
  for (const el of payload.elements || []) {
    const item = normalizeElement(el);
    if (!item.name || item.name === 'Empresa sem nome cadastrado' || seen.has(item.id)) continue;
    seen.add(item.id);
    results.push(item);
  }
  res.json({
    query: { city, state, segment, limit },
    count: results.length,
    source: 'OpenStreetMap / Overpass API',
    warning: 'Cobertura variável. Ausência de site nos dados não prova que a empresa não tenha site. A análise de link na bio do Instagram precisa de acesso público permitido ou confirmação manual.',
    results: results.slice(0, limit)
  });
});

// Safe, lightweight URL audit. Reject private/local IP ranges and non-HTTP protocols.
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
  return false;
}
app.post('/api/audit-site', async (req, res) => {
  const raw = String(req.body?.url || '').trim();
  if (!raw || raw.length > 2048) return res.status(400).json({ error: 'Informe um endereço válido.' });
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); }
  catch { return res.status(400).json({ error: 'Endereço inválido.' }); }
  if (!['http:', 'https:'].includes(url.protocol) || isPrivateHost(url.hostname)) {
    return res.status(400).json({ error: 'Endereço não permitido para verificação.' });
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url.href, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { 'User-Agent': 'LeadHunterBrasil/0.1 site-check' }
    });
    clearTimeout(timer);
    const status = response.status;
    const location = response.headers.get('location') || '';
    const reachable = status >= 200 && status < 400;
    res.json({
      url: url.href, httpStatus: status, reachable,
      result: reachable ? 'respondendo' : 'resposta-com-problema',
      redirect: location,
      message: reachable ? 'O endereço respondeu à solicitação. Isso não avalia qualidade, segurança ou SEO.' : 'O endereço respondeu com um status que merece revisão.',
      checkedAt: new Date().toISOString()
    });
  } catch (err) {
    res.json({
      url: url.href, reachable: false, result: 'nao-verificado-ou-indisponivel',
      message: 'Não foi possível confirmar a resposta. Bloqueios, timeout e restrições do site também podem causar isso.',
      detail: err.name === 'AbortError' ? 'Tempo limite excedido' : 'Falha de conexão',
      checkedAt: new Date().toISOString()
    });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`LeadHunter Brasil ativo na porta ${PORT}`));
