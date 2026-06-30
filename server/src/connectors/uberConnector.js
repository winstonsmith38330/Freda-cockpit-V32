import { cleanText, maskSecret, round2 } from '../utils/safe.js';
import { normalizeReportingDate, periodMatchesSelectedDate } from '../utils/dateUtils.js';

const UBER_STORES = [
  { key: 'beverly_hills', name: 'Beverly Hills', idKey: 'UBER_STORE_BEVERLY_HILLS', nameKey: 'UBER_STORE_NAME_BEVERLY_HILLS', defaultVisible: 'L.A Donut' },
  { key: 'penrith', name: 'Penrith', idKey: 'UBER_STORE_PENRITH', nameKey: 'UBER_STORE_NAME_PENRITH', defaultVisible: 'L.A DONUTS (Penrith)' },
  { key: 'taren_point', name: 'Taren Point', idKey: 'UBER_STORE_TAREN_POINT', nameKey: 'UBER_STORE_NAME_TAREN_POINT', defaultVisible: 'L.A DONUTS Taren Point' }
];

export async function syncUber(env, fetchImpl = fetch, opts = {}) {
  const selectedDate = normalizeReportingDate(opts.reportingDate || opts.date || opts.today, env.TIMEZONE || 'Australia/Sydney');
  const startedAt = new Date().toISOString();
  const result = {
    ok: false,
    status: 'not_synced',
    mode: 'uber-manager-online-browser-sync-v33',
    source: 'Uber Eats Manager',
    reportingDate: selectedDate,
    periodMatched: false,
    startedAt,
    finishedAt: null,
    uberEats: {},
    details: [],
    warnings: [],
    errors: [],
    diagnostics: uberDiagnostics(env)
  };

  if (!String(env.UBER_COOKIE || '').trim()) {
    result.errors.push('Missing UBER_COOKIE. Add a fresh Uber Manager Cookie header in Render Environment.');
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const stores = selectedStores(opts);
  for (const store of stores) {
    const detail = await syncUberStoreV33(env, fetchImpl, store, selectedDate, opts).catch(err => ({
      store: store.name,
      ok: false,
      status: 'failed',
      attemptedUrls: [],
      warnings: [],
      errors: [String(err?.stack || err?.message || err)],
      steps: []
    }));
    result.details.push(detail);
    if (detail.metric && detail.ok) result.uberEats[store.name] = detail.metric;
  }

  const storeMetrics = Object.values(result.uberEats || {});
  const repeated = detectRepeatedSuspiciousMetrics(storeMetrics);
  if (repeated) {
    result.warnings.push(repeated);
    if (String(env.UBER_ALLOW_REPEATED_STORE_METRICS || '').toLowerCase() !== 'true') {
      result.errors.push('Rejected Uber sync because all stores returned the same suspicious zero-sales/order metric. This usually means Uber Manager did not switch stores or sales values were not extracted.');
      result.uberEats = {};
    }
  }

  result.ok = Object.keys(result.uberEats).length > 0;
  result.status = result.ok ? 'success' : 'not_synced';
  result.periodMatched = result.ok && Object.values(result.uberEats).some(metric => Boolean(metric.periodMatched));
  if (!result.ok && !result.errors.length) result.errors.push('Uber did not produce trusted selected-date values. Stale WTD/month values, repeated-store metrics and zero-sales-with-orders were rejected.');
  result.finishedAt = new Date().toISOString();
  return result;
}

async function syncUberStoreV33(env, fetchImpl, store, selectedDate, opts = {}) {
  const detail = {
    store: store.name,
    ok: false,
    status: 'not_synced',
    attemptedUrls: [],
    warnings: [],
    errors: [],
    steps: [],
    jsonCandidates: [],
    metric: null
  };

  const manager = managerBase(env);
  const url = uberSalesUrl(manager, selectedDate, store, env);
  detail.attemptedUrls.push(url);
  const useBrowser = truthy(env.UBER_BROWSER_ONLINE_SYNC ?? env.BROWSER_ONLINE_SYNC ?? env.ENABLE_BROWSER_SYNC ?? 'true');

  let extraction;
  if (useBrowser) {
    extraction = await fetchWithBrowser(env, store, url, selectedDate, detail);
  } else {
    extraction = await fetchWithHttp(env, fetchImpl, url, detail);
  }

  const metric = metricFromExtraction(extraction, store, selectedDate, detail);
  if (!metric) {
    detail.status = 'not_synced';
    if (!detail.errors.length) detail.errors.push('Uber Manager page was reached, but no trusted selected-day sales metric was extracted.');
    return detail;
  }

  const orders = Number(metric.orders ?? metric.transactions ?? 0);
  const sales = Number(metric.sales ?? metric.totalSales ?? metric.netSales ?? 0);
  if (orders > 0 && sales <= 0 && !truthy(env.UBER_ALLOW_ZERO_SALES_WITH_ORDERS)) {
    detail.status = 'rejected_zero_sales_with_orders';
    detail.warnings.push(`Rejected ${store.name}: orders=${orders} but sales=0. This was the V32 failure mode and is not trusted.`);
    return detail;
  }

  detail.metric = metric;
  detail.ok = true;
  detail.status = 'success';
  return detail;
}

async function fetchWithBrowser(env, store, url, selectedDate, detail) {
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: String(env.PLAYWRIGHT_HEADLESS || 'true').toLowerCase() !== 'false' });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
      extraHTTPHeaders: {
        Cookie: String(env.UBER_COOKIE || ''),
        'User-Agent': env.UBER_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(Number(env.UBER_BROWSER_TIMEOUT_MS || env.BROWSER_SYNC_TIMEOUT_MS || 45000));
    detail.steps.push({ step: 'goto-sales-url', url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(env.UBER_BROWSER_TIMEOUT_MS || 45000) });
    await page.waitForTimeout(Number(env.UBER_PAGE_SETTLE_MS || 2500));

    await selectUberStoreIfNeeded(page, store, detail, env);
    await forceSelectedDateIfPossible(page, selectedDate, detail);
    await page.waitForTimeout(Number(env.UBER_AFTER_STORE_SWITCH_WAIT_MS || 2500));

    const bodyText = cleanText(await page.locator('body').innerText({ timeout: 10000 }).catch(() => ''));
    const title = await page.title().catch(() => '');
    const currentUrl = page.url();
    const jsonTexts = await page.$$eval('script', scripts => scripts.map(s => s.textContent || '').filter(Boolean).slice(0, 120)).catch(() => []);
    const runtimeJson = await page.evaluate(() => {
      const out = [];
      try { out.push(JSON.stringify(window.__NEXT_DATA__ || null)); } catch {}
      try { out.push(JSON.stringify(window.__APOLLO_STATE__ || null)); } catch {}
      try { out.push(JSON.stringify(window.localStorage || null)); } catch {}
      return out.filter(x => x && x !== 'null' && x !== '{}');
    }).catch(() => []);

    detail.steps.push({ step: 'browser-capture', currentUrl, title, bodyChars: bodyText.length, jsonTextCount: jsonTexts.length, runtimeJsonCount: runtimeJson.length });
    detail.pagePreview = bodyText.slice(0, Number(env.UBER_PAGE_PREVIEW_CHARS || 2500));
    return { source: 'browser', bodyText, title, currentUrl, jsonTexts: [...jsonTexts, ...runtimeJson] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function fetchWithHttp(env, fetchImpl, url, detail) {
  const response = await fetchImpl(url, {
    headers: {
      Cookie: String(env.UBER_COOKIE || ''),
      'User-Agent': env.UBER_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  const bodyText = cleanText(await response.text());
  detail.steps.push({ step: 'http-fetch', status: response.status, chars: bodyText.length });
  detail.pagePreview = bodyText.slice(0, Number(env.UBER_PAGE_PREVIEW_CHARS || 2500));
  return { source: 'http', bodyText, title: '', currentUrl: url, jsonTexts: extractScriptJsonCandidates(bodyText) };
}

async function selectUberStoreIfNeeded(page, store, detail, env) {
  const visible = storeVisibleName(store, env);
  if (!visible) return;
  const beforeText = cleanText(await page.locator('body').innerText().catch(() => ''));
  const alreadyVisible = beforeText.toLowerCase().includes(visible.toLowerCase());
  detail.steps.push({ step: 'store-visible-check', visibleName: visible, alreadyVisible });
  if (alreadyVisible && !truthy(env.UBER_FORCE_STORE_MENU_SWITCH)) return;

  const triggerSelectors = [
    '[data-testid*="store"]',
    '[aria-label*="store" i]',
    '[aria-label*="merchant" i]',
    'button:has-text("L.A")',
    'button:has-text("Donut")',
    'button:has-text("Penrith")',
    'button:has-text("Taren")',
    'button:has-text("Beverly")'
  ];

  for (const selector of triggerSelectors) {
    const trigger = page.locator(selector).first();
    if (await trigger.count().catch(() => 0)) {
      await trigger.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(900);
      const option = page.getByText(visible, { exact: false }).first();
      if (await option.count().catch(() => 0)) {
        await option.click({ timeout: 4000 }).catch(() => {});
        detail.steps.push({ step: 'store-switch-clicked', visibleName: visible, selector });
        return;
      }
    }
  }

  const fallbackOption = page.getByText(visible, { exact: false }).first();
  if (await fallbackOption.count().catch(() => 0)) {
    await fallbackOption.click({ timeout: 4000 }).catch(() => {});
    detail.steps.push({ step: 'store-switch-clicked-text-only', visibleName: visible });
    return;
  }

  detail.warnings.push(`Could not click Uber store selector for ${store.name}. Extraction will continue but store switching is not confirmed.`);
}

async function forceSelectedDateIfPossible(page, selectedDate, detail) {
  // The URL already carries start/end. This extra check is deliberately gentle:
  // it logs page evidence but does not change POS or other connectors.
  const text = cleanText(await page.locator('body').innerText().catch(() => ''));
  const dateVisible = text.includes(selectedDate) || text.includes(selectedDate.split('-').reverse().join('/'));
  detail.steps.push({ step: 'date-visible-check', selectedDate, dateVisible });
}

function metricFromExtraction(extraction, store, selectedDate, detail) {
  const jsonMetrics = extractMetricsFromJsonTexts(extraction.jsonTexts || [], detail);
  const textMetrics = extractMetricsFromText(extraction.bodyText || '', detail);
  const metric = bestMetric(jsonMetrics, textMetrics);
  if (!metric) return null;

  const sales = roundMoney(metric.sales ?? metric.totalSales ?? metric.netSales ?? 0);
  const orders = finiteNumber(metric.orders ?? metric.transactions ?? 0) || 0;
  const aov = sales > 0 && orders > 0 ? roundMoney(sales / orders) : roundMoney(metric.aov || 0);
  const periodMatched = periodMatchesSelectedDate ? periodMatchesSelectedDate(metric.period || selectedDate, selectedDate) : true;

  return {
    store: store.name,
    source: `uber-manager-${extraction.source}-v33`,
    period: selectedDate,
    periodLabel: 'Uber selected day online',
    periodMatched,
    sales,
    totalSales: roundMoney(metric.totalSales ?? sales),
    netSales: roundMoney(metric.netSales ?? sales),
    orders,
    transactions: orders,
    aov,
    hourlyRows: metric.hourlyRows || [],
    capturedAt: new Date().toISOString(),
    extractionConfidence: metric.confidence || 'medium',
    extractionMethod: metric.method || 'text-or-json'
  };
}

function extractMetricsFromJsonTexts(texts = [], detail) {
  const candidates = [];
  for (const raw of texts) {
    if (!raw || raw.length < 2) continue;
    const fragments = possibleJsonFragments(raw);
    for (const fragment of fragments.slice(0, 20)) {
      try {
        const parsed = JSON.parse(fragment);
        const flat = flattenJson(parsed).slice(0, 5000);
        const metric = metricFromFlatPairs(flat);
        if (metric) {
          metric.method = 'json-runtime';
          candidates.push(metric);
          detail.jsonCandidates.push({ method: metric.method, sales: metric.sales, orders: metric.orders, labels: metric.labels?.slice?.(0, 8) || [] });
        }
      } catch {}
    }
  }
  return candidates;
}

function extractMetricsFromText(text = '', detail) {
  const normalized = cleanText(text || '');
  const out = [];
  const orders = firstNumberNear(normalized, [/(\d{1,6})\s+(?:orders?|transactions?)/i, /(?:orders?|transactions?)\s+(\d{1,6})/i]);
  const sales = firstMoneyNear(normalized, [
    /(?:net\s*sales?|sales?|revenue|gross\s*sales?|total)\s*\$?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
    /\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:sales?|revenue|gross|net)?/i
  ]);
  const aov = firstMoneyNear(normalized, [/(?:aov|average\s+order\s+value)\s*\$?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i]);
  if (Number.isFinite(sales) || Number.isFinite(orders)) {
    out.push({ sales: sales || 0, totalSales: sales || 0, netSales: sales || 0, orders: orders || 0, transactions: orders || 0, aov: aov || 0, method: 'visible-text', confidence: sales > 0 ? 'medium' : 'low' });
    detail.steps.push({ step: 'text-metric-candidate', sales: sales || 0, orders: orders || 0, aov: aov || 0 });
  }
  return out;
}

function metricFromFlatPairs(pairs = []) {
  const labels = [];
  let sales = null;
  let netSales = null;
  let totalSales = null;
  let orders = null;
  let aov = null;
  for (const { path, value } of pairs) {
    const p = String(path || '').toLowerCase();
    const n = moneyNumber(value);
    if (!Number.isFinite(n)) continue;
    if (/(net.*sales|sales.*net)/.test(p)) { netSales = bestMoney(netSales, n); labels.push(path); }
    else if (/(gross.*sales|total.*sales|sales.*total|revenue)/.test(p)) { totalSales = bestMoney(totalSales, n); labels.push(path); }
    else if (/\bsales\b/.test(p) && n > 0) { sales = bestMoney(sales, n); labels.push(path); }
    else if (/(order.*count|orders|trips|transactions)/.test(p)) { orders = bestCount(orders, n); labels.push(path); }
    else if (/(aov|average.*order)/.test(p)) { aov = bestMoney(aov, n); labels.push(path); }
  }
  const chosenSales = roundMoney(netSales ?? totalSales ?? sales ?? 0);
  if (!chosenSales && !orders) return null;
  return { sales: chosenSales, totalSales: roundMoney(totalSales ?? chosenSales), netSales: roundMoney(netSales ?? chosenSales), orders: Number(orders || 0), transactions: Number(orders || 0), aov: roundMoney(aov || (chosenSales && orders ? chosenSales / orders : 0)), labels, confidence: chosenSales > 0 ? 'high' : 'low' };
}

function flattenJson(obj, prefix = '', out = []) {
  if (out.length > 10000) return out;
  if (obj == null) return out;
  if (typeof obj !== 'object') {
    out.push({ path: prefix, value: obj });
    return out;
  }
  if (Array.isArray(obj)) {
    obj.slice(0, 200).forEach((v, i) => flattenJson(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(obj).slice(0, 300)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function possibleJsonFragments(raw = '') {
  const out = [];
  const s = String(raw || '').trim();
  if (s.startsWith('{') || s.startsWith('[')) out.push(s);
  const next = s.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (next?.[1]) out.push(next[1].trim());
  const assignment = s.match(/(?:window\.__\w+__|__APOLLO_STATE__)\s*=\s*({[\s\S]*?});?\s*$/);
  if (assignment?.[1]) out.push(assignment[1]);
  return [...new Set(out)].filter(x => x.length >= 2 && x.length < 3_000_000);
}

function extractScriptJsonCandidates(html = '') {
  const out = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) out.push(m[1]);
    if (out.length >= 120) break;
  }
  return out;
}

function bestMetric(jsonMetrics = [], textMetrics = []) {
  const candidates = [...jsonMetrics, ...textMetrics].filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => scoreMetric(b) - scoreMetric(a));
  return candidates[0];
}

function scoreMetric(metric = {}) {
  let s = 0;
  if (Number(metric.sales) > 0 || Number(metric.netSales) > 0 || Number(metric.totalSales) > 0) s += 10;
  if (Number(metric.orders) > 0 || Number(metric.transactions) > 0) s += 4;
  if (metric.method === 'json-runtime') s += 3;
  if (metric.confidence === 'high') s += 3;
  return s;
}

function detectRepeatedSuspiciousMetrics(metrics = []) {
  if (metrics.length < 2) return '';
  const fingerprints = metrics.map(m => `${roundMoney(m.sales)}|${Number(m.orders || 0)}|${roundMoney(m.aov)}`);
  const allSame = fingerprints.every(x => x === fingerprints[0]);
  const orders = Number(metrics[0]?.orders || 0);
  const sales = Number(metrics[0]?.sales || 0);
  if (allSame && orders > 0 && sales <= 0) return `Suspicious repeated Uber metrics across stores: all stores returned sales=${sales}, orders=${orders}. This usually means store switching or sales extraction failed.`;
  if (allSame && metrics.length >= 3) return `Warning: all Uber stores returned identical metrics (${fingerprints[0]}). This is unusual; verify store switching.`;
  return '';
}

function managerBase(env) {
  const explicit = String(env.UBER_MANAGER_BASE_URL || env.UBER_MANAGER_HOME_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const uuid = String(env.UBER_MANAGER_HOME_ID || env.UBER_HOME_UUID || '').trim();
  if (uuid) return `https://merchants.ubereats.com/manager/home/${uuid}`;
  return 'https://merchants.ubereats.com/manager';
}

function uberSalesUrl(manager, selectedDate, store, env) {
  const base = manager.replace(/\/$/, '');
  const url = new URL(base.includes('/analytics/sales-v2') ? base : `${base}/analytics/sales-v2`);
  url.searchParams.set('dateRange', 'custom');
  url.searchParams.set('start', selectedDate);
  url.searchParams.set('end', selectedDate);
  url.searchParams.set('startDate', selectedDate);
  url.searchParams.set('endDate', selectedDate);
  const id = String(env?.[store.idKey] || '').trim();
  if (id && truthy(env.UBER_APPEND_STORE_ID_TO_QUERY)) url.searchParams.set('storeId', id);
  return url.toString();
}

function selectedStores(opts = {}) {
  const raw = String(opts.store || opts.storeName || opts.storeSlug || '').toLowerCase();
  if (!raw) return UBER_STORES;
  return UBER_STORES.filter(store => {
    const s = `${store.key} ${store.name}`.toLowerCase();
    return s.includes(raw) || raw.includes(store.key) || raw.includes(store.name.toLowerCase());
  }).length ? UBER_STORES.filter(store => `${store.key} ${store.name}`.toLowerCase().includes(raw) || raw.includes(store.key) || raw.includes(store.name.toLowerCase())) : UBER_STORES;
}

function storeVisibleName(store, env) {
  return String(env?.[store.nameKey] || store.defaultVisible || store.name || '').trim();
}

export function uberDiagnostics(env, extra = {}) {
  const manager = managerBase(env);
  const stores = UBER_STORES.map(store => ({
    store: store.name,
    idEnv: store.idKey,
    id: maskSecret(env?.[store.idKey] || ''),
    visibleNameEnv: store.nameKey,
    visibleName: storeVisibleName(store, env)
  }));
  const sameIds = new Set(stores.map(s => String(env?.[s.idEnv] || '').trim()).filter(Boolean)).size === 1 && stores.filter(s => String(env?.[s.idEnv] || '').trim()).length > 1;
  return {
    source: 'Uber Eats Manager',
    connectorVersion: '0.2.33',
    cookie: maskSecret(env.UBER_COOKIE || ''),
    managerBaseUrl: manager,
    onlineOnly: true,
    workbookImportEnabled: truthy(env.UBER_FILE_IMPORT_ENABLED),
    browserFallbackEnabled: truthy(env.UBER_BROWSER_FALLBACK_ENABLED ?? 'true'),
    browserOnlineSync: truthy(env.UBER_BROWSER_ONLINE_SYNC ?? env.ENABLE_BROWSER_SYNC ?? 'true'),
    sameConfiguredStoreIds: sameIds,
    note: 'V33 uses visible store selection and rejects the V32 failure mode where all stores return the same orders with zero sales.',
    stores,
    ...extra
  };
}

function firstNumberNear(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return Number(String(m[1]).replace(/,/g, ''));
  }
  return null;
}

function firstMoneyNear(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return moneyNumber(m[1]);
  }
  return null;
}

function moneyNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = String(value ?? '').replace(/[$,\s]/g, '');
  if (!cleaned || !/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(value) {
  const n = Number(value || 0);
  if (typeof round2 === 'function') return round2(n);
  return Math.round(n * 100) / 100;
}

function bestMoney(current, candidate) {
  if (!Number.isFinite(candidate)) return current;
  if (!Number.isFinite(current)) return candidate;
  return Math.max(current, candidate);
}

function bestCount(current, candidate) {
  if (!Number.isFinite(candidate)) return current;
  if (!Number.isFinite(current)) return candidate;
  if (candidate > 0 && candidate < 10000) return Math.max(current, candidate);
  return current;
}

function truthy(value) {
  return String(value ?? '').toLowerCase() === 'true' || String(value ?? '') === '1' || String(value ?? '').toLowerCase() === 'yes';
}
