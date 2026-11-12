#!/usr/bin/env node
// TFNN market price agent.
//
// Once a week this script:
//   1. finds the newest "Weekly Livestock and Meat Producer Prices" PDF on the Livestock and
//      Livestock Products Board of Namibia website (nammic.com.na),
//   2. asks Claude to read the auction price table in it (the table is an image, so plain
//      text extraction cannot read it),
//   3. turns those auction categories into TFNN classes,
//   4. sends them to the TFNN server, where they wait on the admin Prices tab for approval.
//
// Run by .github/workflows/market-prices.yml. Needs Node 20+ and no packages.
//   ANTHROPIC_API_KEY   Claude API key (from platform.claude.com)
//   CRON_SECRET         same value as CRON_SECRET on the TFNN server
//   TFNN_URL            default https://tfnn-1.onrender.com
//   PRICE_AGENT_MODEL   default claude-sonnet-5-5
//   REPORT_URL          optional: read this PDF instead of looking for the newest one
// Flags: --dry-run  read the report and print what would be sent, without sending it.

const SITE = 'https://nammic.com.na';
const LISTING_PAGES = [SITE + '/', SITE + '/weekly-prices-' + new Date().getFullYear() + '/', SITE + '/applications-clone/'];
const USER_AGENT = 'Mozilla/5.0 (compatible; TFNN-price-agent/1.0; +https://tfnn-1.onrender.com)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ---- 1. find the newest report -------------------------------------------------------------

// Pulls every weekly producer-price PDF link out of a page and returns them newest first.
function findReportLinks(html, baseUrl = SITE + '/') {
  const found = new Map();
  const re = /(?:href|src)\s*=\s*["']([^"']+?\.pdf)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let url;
    try { url = new URL(m[1].replace(/&amp;/g, '&'), baseUrl).href; } catch (e) { continue; }
    let name;
    try { name = decodeURIComponent(url); } catch (e) { name = url; }
    if (!/\/Statistics\/Weekly\//i.test(name)) continue;
    const file = name.split('/').pop();
    if (!/weekly/i.test(file) || !/livestock/i.test(file) || !/prices/i.test(file) || /consumer/i.test(file)) continue;
    found.set(url, { url, file, date: reportDate(name) });
  }
  return [...found.values()].sort((a, b) => (b.date || 0) - (a.date || 0));
}

// "…/Weekly/2026/11. November/03 Nov 2026 Weekly Livestock…pdf" -> a timestamp (or null)
function reportDate(name) {
  const file = name.split('/').pop();
  const d = /(\d{1,2})\s*([A-Za-z]{3,9})\.?\s*(\d{4})?/.exec(file);
  if (!d) return null;
  const month = MONTHS.indexOf(d[2].slice(0, 3).toLowerCase());
  const year = d[3] || (/\/Weekly\/(\d{4})\//i.exec(name) || [])[1];
  if (month < 0 || !year) return null;
  return Date.UTC(Number(year), month, Number(d[1]));
}

async function findLatestReport(fetchFn = fetch) {
  const errors = [];
  for (const page of LISTING_PAGES) {
    try {
      const res = await fetchFn(page, { headers: { 'user-agent': USER_AGENT } });
      if (!res.ok) { errors.push(`${page} answered ${res.status}`); continue; }
      const links = findReportLinks(await res.text(), page);
      if (links.length) return links[0];
      errors.push(`${page} had no weekly producer price link`);
    } catch (e) { errors.push(`${page}: ${e.message}`); }
  }
  throw new Error('Could not find the weekly price report. ' + errors.join('; '));
}

// ---- 2. ask Claude to read the auction table -----------------------------------------------

const QUOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['report_date', 'auction_period', 'quotes'],
  properties: {
    report_date: { type: 'string', description: 'Date printed on the report, e.g. "03 November 2026"' },
    auction_period: { type: 'string', description: 'Period the auction prices cover, e.g. "27-30 Oct 2026". Empty if not shown.' },
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'unit', 'average', 'min', 'max'],
        properties: {
          category: { type: 'string', description: 'Row label exactly as printed, e.g. "Slaughter Oxen"' },
          unit: { type: 'string', enum: ['kg', 'head'] },
          average: { type: 'number' },
          min: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          max: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        },
      },
    },
  },
};

const READ_PROMPT = `This is the weekly livestock and meat producer price report from the Livestock and Livestock Products Board of Namibia.

Find the table of LIVE ANIMAL AUCTION prices (it is usually titled with "Auction Prices" and credited to LABTA, the livestock auctioneers' association). It has one row per category of animal, with Average, Minimum and Maximum columns.

Copy every row of that auction table that has an average price:
- category: the row label exactly as printed.
- unit: "kg" when the price is in N$ per kg, "head" when it is N$ per animal (goats and cows with calves are usually per head; the table says which).
- average, min, max: the numbers as printed, as plain numbers (write 35.91, not "35,91" or "N$35.91"). Use null for a missing min or max.

Rules:
- Only the live auction table. Ignore the abattoir carcass price schedules (grades A0 to C6), consumer prices and buyer conditions.
- Leave out rows with no average (for example "not available").
- Never estimate, round or fill in a number you cannot read clearly. Leave that row out instead.
- If the report has no auction table, return an empty quotes list.`;

async function readReport(pdfBase64, { apiKey, model, fetchFn = fetch }) {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: READ_PROMPT },
        ],
      }],
      output_config: { format: { type: 'json_schema', schema: QUOTE_SCHEMA } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API answered ${res.status}: ${(body.error && body.error.message) || 'no details'}`);
  if (body.stop_reason !== 'end_turn') throw new Error(`Claude stopped early (${body.stop_reason}), so the answer cannot be trusted`);
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return JSON.parse(text);
}

// ---- 3. auction categories -> TFNN classes -------------------------------------------------

// For each TFNN class: the auction categories that can price it, best first. The first one
// present in this week's report is used. Kid goats have no auction category, so they get no price.
const CLASS_SOURCES = [
  { species: 'Cattle', class: 'Cow', from: ['Cows Medium', 'Cows Fat', 'Cows Lean'] },
  { species: 'Cattle', class: 'Bull', from: ['Slaughter Bulls'] },
  { species: 'Cattle', class: 'Heifer', from: ['Store Heifers', 'Slaughter Heifers', 'Heifers'] },
  { species: 'Cattle', class: 'Steer', from: ['Store Oxen', 'Slaughter Oxen', 'Tollies'] },
  { species: 'Cattle', class: 'Calf', from: ['Tollies/Heifers Mix', 'Tollies', 'Heifers'] },
  { species: 'Sheep', class: 'Ewe', from: ['Slaughter Sheep Dorper', 'Slaughter Sheep Fat Tails'] },
  { species: 'Sheep', class: 'Ram', from: ['Slaughter Sheep Dorper', 'Slaughter Sheep Fat Tails'] },
  { species: 'Sheep', class: 'Wether', from: ['Slaughter Sheep Dorper', 'Slaughter Sheep Fat Tails'] },
  { species: 'Sheep', class: 'Lamb', from: ['Slaughter Sheep Dorper', 'Slaughter Sheep Fat Tails'] },
  { species: 'Goat', class: 'Doe', from: ['Goat', 'Goats'] },
  { species: 'Goat', class: 'Buck', from: ['Goat', 'Goats'] },
  { species: 'Goat', class: 'Wether', from: ['Goat', 'Goats'] },
];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

// A quote the agent will not pass on: wrong shape, or a number no auction would print.
function quoteProblem(q) {
  if (!q || !q.category || (q.unit !== 'kg' && q.unit !== 'head')) return 'missing category or unit';
  if (!Number.isFinite(q.average) || q.average <= 0) return 'no usable average';
  if (q.unit === 'kg' && (q.average < 5 || q.average > 300)) return `N$${q.average}/kg is not a believable live price`;
  if (q.unit === 'head' && (q.average < 100 || q.average > 300000)) return `N$${q.average} per head is not believable`;
  if (q.min != null && q.max != null && (q.min > q.average || q.max < q.average)) return 'average is outside its own min-max range';
  return null;
}

function toItems(quotes) {
  const good = new Map(), rejected = [];
  for (const q of quotes || []) {
    const problem = quoteProblem(q);
    if (problem) rejected.push({ category: q && q.category, problem });
    else good.set(norm(q.category), q);
  }
  const items = [], unpriced = [];
  for (const c of CLASS_SOURCES) {
    const q = c.from.map((name) => good.get(norm(name))).find(Boolean);
    if (!q) { unpriced.push(`${c.species} ${c.class}`); continue; }
    const range = q.min != null && q.max != null ? `, range ${q.min} to ${q.max}` : '';
    items.push({ species: c.species, class: c.class, basis: q.unit, price: q.average, note: `Auction category "${q.category}": average N$${q.average} per ${q.unit}${range}` });
  }
  return { items, unpriced, rejected };
}

// ---- 4. run ---------------------------------------------------------------------------------

async function run({ env = process.env, dryRun = false, fetchFn = fetch, log = console.log } = {}) {
  const tfnnUrl = (env.TFNN_URL || 'https://tfnn-1.onrender.com').replace(/\/+$/, '');
  const model = env.PRICE_AGENT_MODEL || 'claude-sonnet-5-5';
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  if (!dryRun && !env.CRON_SECRET) throw new Error('CRON_SECRET is not set');

  const report = env.REPORT_URL ? { url: env.REPORT_URL, file: decodeURIComponent(env.REPORT_URL.split('/').pop()) } : await findLatestReport(fetchFn);
  log('Report: ' + report.file + '\n        ' + report.url);

  const pdfRes = await fetchFn(report.url, { headers: { 'user-agent': USER_AGENT } });
  if (!pdfRes.ok) throw new Error(`Could not download the report (${pdfRes.status})`);
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  if (pdf.length < 1000 || pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('The report link did not return a PDF');
  if (pdf.length > 20 * 1024 * 1024) throw new Error('The report is unexpectedly large (over 20 MB)');

  const read = await readReport(pdf.toString('base64'), { apiKey: env.ANTHROPIC_API_KEY, model, fetchFn });
  log(`Read ${read.quotes.length} auction rows (report dated ${read.report_date || '?'}, auctions ${read.auction_period || '?'})`);
  read.quotes.forEach((q) => log(`  ${q.category}: ${q.average} per ${q.unit}`));

  const { items, unpriced, rejected } = toItems(read.quotes);
  rejected.forEach((r) => log(`  Left out "${r.category}": ${r.problem}`));
  if (unpriced.length) log('No auction price this week for: ' + unpriced.join(', '));
  if (!items.length) throw new Error('No usable auction prices were found in the report, so nothing was sent');

  const source = `LLPB weekly producer prices${read.report_date ? ', ' + read.report_date : ''}${read.auction_period ? ' (auctions ' + read.auction_period + ')' : ''}`.slice(0, 200);
  if (dryRun) {
    log('\nDry run - this is what would be sent to TFNN:\n' + JSON.stringify({ source, items }, null, 2));
    return { dryRun: true, source, items };
  }

  // The free server sleeps when idle, so the first request can take a minute. Try a few times.
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetchFn(tfnnUrl + '/api/v1/jobs/market-price-proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cron-secret': env.CRON_SECRET },
        body: JSON.stringify({ source, items }),
        signal: AbortSignal.timeout(120000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`TFNN refused the prices (${res.status}): ${body.error || ''}`), { fatal: true });
      if (!res.ok) throw new Error(`TFNN answered ${res.status}`);
      const r = body.result;
      log(`\nSent to TFNN: ${r.pending} waiting for approval (${r.flagged} with a warning), ${r.applied} applied automatically, ${r.skipped.length} skipped`);
      r.skipped.forEach((s) => log(`  Skipped ${s.item}: ${s.reason}`));
      return { source, items, result: r };
    } catch (e) {
      if (e.fatal) throw e;
      lastError = e;
      log(`TFNN did not answer (try ${attempt} of 4): ${e.message}`);
      if (attempt < 4) await new Promise((ok) => setTimeout(ok, env.PRICE_AGENT_RETRY_MS ? Number(env.PRICE_AGENT_RETRY_MS) : 20000));
    }
  }
  throw new Error('Could not reach TFNN: ' + lastError.message);
}

module.exports = { findReportLinks, reportDate, findLatestReport, readReport, toItems, quoteProblem, run, QUOTE_SCHEMA };

if (require.main === module) {
  run({ dryRun: process.argv.includes('--dry-run') }).catch((e) => { console.error('Price agent failed: ' + e.message); process.exit(1); });
}
