import fs from 'fs';
import AdmZip from 'adm-zip';

const STORE_PATTERNS = [
  ['Beverly Hills', /\bbeverly\b|\bbh\b|beverly\s*hills/i],
  ['Penrith', /\bpenrith\b|\bpen\b|\bpn\b/i],
  ['Taren Point', /\btaren\b|\btp\b|taren\s*point/i],
  ["Frieda's Pies", /\bfrieda\b|\bfrida\b|\bpies?\b/i]
];

const PRODUCT_HINTS = [
  'homer', 'glaze', 'glazed', 'choc', 'chocolate', 'cinnamon', 'caramel', 'fairy',
  'passion', 'pineapple', 'm&m', 'nutella', 'biscoff', 'oreo', 'snickers', 'gaytime',
  'brulee', 'strawberry', 'vanilla slice', 'boston', 'raspberry', 'banana', 'lemon',
  'finger bun', 'eclair', 'scroll', 'apple', 'special', 'rings', 'balls', 'longs',
  'pies', 'beef', 'cheese', 'naan', 'chunky'
];

const STOCK_HINTS = [
  'milk', 'coffee', 'cups', 'bags', 'boxes', 'gloves', 'napkins', 'trays', 'balls',
  'rings', 'containers', 'labels', 'cream', 'sugar', 'chocolate', 'oil', 'flour',
  'stock', 'order', 'delivery', 'driver', 'two trips', 'trip', 'urgent'
];

export function parseWhatsappUpload(file) {
  const uploadedName = String(file?.originalname || file?.filename || '').trim();
  const diagnostics = {
    parserVersion: '0.2.33',
    uploadedName,
    uploadedPath: file?.path || '',
    entries: [],
    warnings: [],
    errors: []
  };

  try {
    if (!file?.path || !fs.existsSync(file.path)) {
      return fail('Uploaded WhatsApp file was not found on the server.', diagnostics);
    }

    const extracted = readWhatsappUpload(file, diagnostics);
    const text = extracted.text || '';
    diagnostics.totalTextChars = text.length;
    diagnostics.textSources = extracted.sources;

    if (!text.trim()) {
      return fail(
        'No readable WhatsApp text found. Export the chat with messages included, then upload the .txt or the .zip containing the exported .txt.',
        diagnostics
      );
    }

    const messages = normaliseWhatsAppLines(text);
    const actions = extractActions(messages, text);
    const stockRequests = extractStockRequests(text);
    const soldOutSignals = actions.filter(a => a.type === 'Sell-out').map(actionToSignal);
    const leftoverSignals = actions.filter(a => a.type === 'Leftover').map(actionToSignal);
    const photoSignals = extractPhotoSignals(messages, text);
    const storeCounts = countBy(actions, 'store');
    const typeCounts = countBy(actions, 'type');

    const warnings = [
      ...diagnostics.warnings,
      ...(messages.length === 0 ? ['Text was readable but no standard WhatsApp message timestamps were detected. Parsed as free text where possible.'] : []),
      ...(actions.length === 0 ? ['No operational signals detected. Parser succeeded, but messages did not contain sell-out, leftover, stock or ops keywords.'] : [])
    ];

    return {
      ok: true,
      source: 'WhatsApp export parser',
      parserVersion: '0.2.33',
      uploadedName,
      messageCount: messages.length,
      actionCount: actions.length,
      photoCount: photoSignals.length,
      summary: summarize(actions, stockRequests, photoSignals, messages),
      actions,
      stockRequests,
      soldOutSignals,
      leftoverSignals,
      photoSignals,
      storeCounts,
      typeCounts,
      sampleMessages: messages.slice(0, 8),
      warnings,
      diagnostics
    };
  } catch (err) {
    diagnostics.errors.push(err?.stack || err?.message || String(err));
    return fail(`WhatsApp upload could not be parsed: ${err?.message || err}`, diagnostics);
  }
}

function readWhatsappUpload(file, diagnostics) {
  const name = String(file.originalname || file.filename || '').toLowerCase();
  const sources = [];
  let text = '';

  if (name.endsWith('.zip')) {
    const zip = new AdmZip(file.path);
    const entries = zip.getEntries();
    diagnostics.entries = entries.map(entry => ({
      name: entry.entryName,
      isDirectory: entry.isDirectory,
      size: entry.header?.size || 0,
      compressedSize: entry.header?.compressedSize || 0
    }));

    const textEntries = entries
      .filter(entry => !entry.isDirectory)
      .filter(entry => /(^|\/|\\)(?:_chat|chat|whatsapp|messages).*\.txt$/i.test(entry.entryName) || /\.txt$/i.test(entry.entryName))
      .sort((a, b) => scoreWhatsappEntryName(b.entryName) - scoreWhatsappEntryName(a.entryName));

    if (!textEntries.length) {
      diagnostics.warnings.push('ZIP was readable but did not contain a .txt WhatsApp export. It may contain only media files.');
    }

    for (const entry of textEntries) {
      const decoded = decodeBuffer(entry.getData());
      if (!decoded.trim()) continue;
      sources.push({ type: 'zip-entry', name: entry.entryName, chars: decoded.length });
      text += `\n\n--- ZIP ENTRY: ${entry.entryName} ---\n${decoded}`;
    }
  } else {
    const decoded = decodeBuffer(fs.readFileSync(file.path));
    sources.push({ type: 'file', name: file.originalname || file.filename || 'upload', chars: decoded.length });
    text = decoded;
  }

  return { text, sources };
}

function scoreWhatsappEntryName(name = '') {
  const n = String(name).toLowerCase();
  let score = 0;
  if (n.includes('_chat')) score += 10;
  if (n.includes('whatsapp')) score += 6;
  if (n.includes('chat')) score += 5;
  if (n.endsWith('.txt')) score += 2;
  if (n.includes('__macosx')) score -= 20;
  return score;
}

export function decodeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.slice(2).toString('utf16le').replace(/^\uFEFF/, '');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return swapUtf16Be(buffer.slice(2)).toString('utf16le').replace(/^\uFEFF/, '');
  if (looksUtf16Le(buffer)) return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function looksUtf16Le(buffer) {
  if (!buffer?.length || buffer.length < 8) return false;
  let zeros = 0;
  const n = Math.min(buffer.length, 200);
  for (let i = 1; i < n; i += 2) if (buffer[i] === 0) zeros += 1;
  return zeros > n / 4;
}

function swapUtf16Be(buffer) {
  const out = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i += 2) {
    out[i] = buffer[i + 1] || 0;
    out[i + 1] = buffer[i] || 0;
  }
  return out;
}

export function normaliseWhatsAppLines(text) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u202f/g, ' ')
    .replace(/\u00a0/g, ' ');
  const lines = normalized.split('\n').map(x => x.trim()).filter(Boolean);
  const messages = [];

  for (const line of lines) {
    if (/^--- ZIP ENTRY:/i.test(line)) continue;
    const parsed = parseWhatsAppLine(line);
    if (parsed) {
      messages.push(parsed);
    } else if (messages.length) {
      messages[messages.length - 1].body = `${messages[messages.length - 1].body || ''}\n${line}`.trim();
      messages[messages.length - 1].raw = `${messages[messages.length - 1].raw || ''}\n${line}`.trim();
    } else {
      messages.push({ date: '', time: '', sender: '', body: line, raw: line, system: true });
    }
  }

  return messages;
}

export function parseWhatsappLine(line) {
  const s = String(line || '').trim();
  const patterns = [
    /^\[(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm|AM|PM)?)\]\s*([^:]{1,100}):\s*([\s\S]*)$/,
    /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm|AM|PM)?)\s*-\s*([^:]{1,100}):\s*([\s\S]*)$/,
    /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm|AM|PM)?)\s*-\s*([\s\S]*)$/,
    /^\[(\d{4}-\d{2}-\d{2}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]{1,100}):\s*([\s\S]*)$/
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    if (m.length === 5) return { date: normalizeDateToken(m[1]), time: to24h(m[2]), sender: (m[3] || '').trim(), body: (m[4] || '').trim(), raw: s };
    return { date: normalizeDateToken(m[1]), time: to24h(m[2]), sender: '', body: (m[3] || '').trim(), raw: s, system: true };
  }

  return null;
}

function normalizeDateToken(value = '') {
  const s = String(value).trim().replace(/[.]/g, '/').replace(/-/g, '/');
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) return s.replace(/\//g, '-');
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return value;
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${month}-${day}`;
}

function to24h(value) {
  const s = String(value || '').trim().replace(/\s+/g, ' ');
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return s;
  let h = Number(m[1]);
  const min = m[2];
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

function extractActions(messages, fullText = '') {
  const actions = [];
  const lines = messages.length ? messages : [{ body: fullText, raw: fullText, time: '', sender: '' }];

  for (const msg of lines) {
    const body = String(msg.body || msg.raw || '').trim();
    if (!body) continue;
    const lower = body.toLowerCase();
    const store = inferStore(`${msg.sender || ''} ${body}`);
    const products = extractProducts(body);
    const quantities = extractQuantities(body);

    if (/sell\s*[- ]?out|sold\s*out|soldout|empty|finished|no\s+more|run\s*out|ran\s*out|all\s*gone|nothing\s+left|plus\s+rien|rupture/i.test(lower)) {
      actions.push(makeAction('Sell-out', msg, store, 'High', 'Sold-out / empty stock signal', 'Check sell-out timing. If earlier than target, increase next same-day production unless planned/FOMO.', products, quantities));
    } else if (/left\s*[- ]?over|leftover|waste|wastage|remain(?:ing)?|reste|restant|too\s+much|throw\s+away|bin/i.test(lower)) {
      actions.push(makeAction('Leftover', msg, store, 'Medium', 'Leftover / waste signal', 'Record leftover product and reduce or rebalance next week production.', products, quantities));
    } else if (/stock|need|needed|needs|order|short|low|running\s+low|delivery|driver|trip|milk|container|coffee\s*shot|cups|bags|boxes|tray|gloves|napkins|balls|rings|besoin|commander/i.test(lower)) {
      actions.push(makeAction('Stock', msg, store, 'Medium', 'Stock request / usage signal', 'Add to stock-use estimate and the two-trip delivery plan.', products, quantities));
    } else if (/clean|display|cabinet|photo|image omitted|training|staff|dirty|standard|presentation|présentation|label|price/i.test(lower)) {
      actions.push(makeAction('Ops', msg, store, 'Medium', 'Ops / training signal', 'Manager follow-up or training evidence required.', products, quantities));
    }
  }

  return actions.slice(0, 220);
}

function extractProducts(text = '') {
  const lower = String(text).toLowerCase();
  return PRODUCT_HINTS.filter(p => lower.includes(p)).slice(0, 12);
}

function extractQuantities(text = '') {
  const out = [];
  const re = /(?:\b(\d{1,4})\s*(?:x|×)?\s*([a-zA-Z&' ]{2,30})\b)|(?:\b([a-zA-Z&' ]{2,30})\s*[:=]\s*(\d{1,4})\b)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (m[1] && m[2]) out.push({ qty: Number(m[1]), item: m[2].trim() });
    if (m[3] && m[4]) out.push({ qty: Number(m[4]), item: m[3].trim() });
    if (out.length >= 20) break;
  }
  return out.filter(x => x.item && Number.isFinite(x.qty));
}

function extractStockRequests(text) {
  const lower = String(text || '').toLowerCase();
  const rows = [];
  for (const item of STOCK_HINTS) {
    const re = new RegExp(`\\b${escapeRegExp(item)}\\b`, 'gi');
    const count = (lower.match(re) || []).length;
    if (count) rows.push({ item, count });
  }
  return rows;
}

function extractPhotoSignals(messages, text) {
  const sourceMessages = messages.length ? messages : [{ body: text, time: '', sender: '', raw: text }];
  const out = [];
  for (const msg of sourceMessages) {
    const body = `${msg.body || ''} ${msg.raw || ''}`;
    if (/image omitted|photo omitted|video omitted|\.jpe?g|\.png|\.heic|attached/i.test(body)) {
      out.push({ store: inferStore(`${msg.sender || ''} ${body}`), time: msg.time || '', sender: msg.sender || '', text: (msg.body || msg.raw || '').slice(0, 500) });
    }
  }
  return out.slice(0, 80);
}

function inferStore(text = '') {
  const hit = STORE_PATTERNS.find(([, re]) => re.test(text));
  return hit?.[0] || 'Unknown';
}

function makeAction(type, msg, store, priority, title, recommendation, products = [], quantities = []) {
  return {
    id: stableActionId(type, msg, store),
    type,
    store,
    date: msg.date || '',
    time: msg.time || '',
    sender: msg.sender || '',
    priority,
    title: `${store !== 'Unknown' ? `${store}: ` : ''}${title}`,
    body: `${msg.time ? `${msg.time} · ` : ''}${msg.sender ? `${msg.sender}: ` : ''}${String(msg.body || msg.raw || '').slice(0, 1200)}`,
    products,
    quantities,
    action: recommendation,
    recommendation,
    owner: 'Manager',
    status: 'Open'
  };
}

function stableActionId(type, msg, store) {
  const base = `${type}|${store}|${msg.date || ''}|${msg.time || ''}|${msg.sender || ''}|${String(msg.body || msg.raw || '').slice(0, 80)}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (Math.imul(31, h) + base.charCodeAt(i)) | 0;
  return `wa_${Math.abs(h).toString(36)}`;
}

function actionToSignal(a) {
  return { store: a.store, date: a.date, time: a.time, sender: a.sender, text: a.body, products: a.products || [], quantities: a.quantities || [] };
}

function summarize(actions, stockRequests, photoSignals, messages) {
  const sellouts = actions.filter(a => a.type === 'Sell-out').length;
  const leftovers = actions.filter(a => a.type === 'Leftover').length;
  const stock = actions.filter(a => a.type === 'Stock').length;
  const ops = actions.filter(a => a.type === 'Ops').length;
  return `${messages.length} messages parsed; ${actions.length} operational signals detected: ${sellouts} sell-out, ${leftovers} leftover, ${stock} stock, ${ops} ops/training, ${stockRequests.length} stock terms, ${photoSignals.length} photo/media references.`;
}

function countBy(rows, key) {
  const out = {};
  for (const row of rows || []) out[row?.[key] || 'Unknown'] = (out[row?.[key] || 'Unknown'] || 0) + 1;
  return out;
}

function fail(error, diagnostics = {}) {
  return { ok: false, status: 'failed', error, errors: [error, ...(diagnostics.errors || [])], warnings: diagnostics.warnings || [], diagnostics };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
