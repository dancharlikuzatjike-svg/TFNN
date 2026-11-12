const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');
const db = require('../src/db');
const agent = require('../tools/price-agent');

const BASE = 'https://nammic.com.na/wp-content/uploads/Library/Trade%20and%20Marketing/Statistics/Weekly/';
const HOME = `
  <a href="${BASE}2024/05.%20May/20%20May%20Weekly%20Livestock%20and%20Meat%20Prices.pdf">Weekly Prices</a>
  <a href="${BASE}2026/10.%20October/27%20Oct%202026%20Weekly%20Livestock%20and%20Meat%20Producer%20Prices.pdf">27 Oct</a>
  <a href="${BASE}2026/11.%20November/03%20Nov%202026%20Weekly%20Livestock%20and%20Meat%20Producer%20Prices.pdf">3 Nov</a>
  <a href="${BASE}2026/11.%20November/04%20Nov%20Weekly%20Beef%20Consumer%20Prices%20%28Consolidated%29.pdf">consumer</a>
  <a href="https://nammic.com.na/wp-content/uploads/Library/Trade%20and%20Marketing/Auction%20Calendars/2026_Agra_Calendar.pdf">calendar</a>`;

test('the agent picks the newest weekly producer price report and ignores other PDFs', () => {
  const links = agent.findReportLinks(HOME);
  assert.strictEqual(links.length, 3);
  assert.match(links[0].file, /^03 Nov 2026 Weekly Livestock and Meat Producer Prices\.pdf$/);
  assert.match(links[2].file, /^20 May/);
  assert.strictEqual(agent.reportDate('x/Weekly/2026/08. August/02 Sep Weekly Livestock and Meat Producer Prices.pdf'), Date.UTC(2026, 8, 2));
});

const QUOTES = [
  { category: 'Tollies/Heifers Mix', unit: 'kg', average: 34.2, min: 30, max: 38.5 },
  { category: 'Store Oxen', unit: 'kg', average: 33.1, min: 31, max: 35 },
  { category: 'Slaughter Oxen', unit: 'kg', average: 35.91, min: 32.68, max: 40.17 },
  { category: 'Cows Medium', unit: 'kg', average: 24.5, min: 22, max: 27 },
  { category: 'Slaughter Bulls', unit: 'kg', average: 2950, min: null, max: null },   // misread: per-kg can't be 2950
  { category: 'Cows with calves', unit: 'head', average: 15040, min: 13000, max: 17000 },
  { category: 'Slaughter Sheep Dorper', unit: 'kg', average: 41.3, min: 45, max: 47 }, // average below its own min
  { category: 'Slaughter Sheep Fat Tails', unit: 'kg', average: 36, min: 34, max: 38 },
  { category: 'GOAT', unit: 'head', average: 1178, min: 1011, max: 1312 },
];

test('auction rows become TFNN classes, and unbelievable numbers are left out', () => {
  const { items, unpriced, rejected } = agent.toItems(QUOTES);
  const get = (sp, cl) => items.find((i) => i.species === sp && i.class === cl);
  assert.deepStrictEqual([get('Cattle', 'Cow').basis, get('Cattle', 'Cow').price], ['kg', 24.5]);
  assert.strictEqual(get('Cattle', 'Steer').price, 33.1);            // Store Oxen preferred over Slaughter Oxen
  assert.strictEqual(get('Cattle', 'Calf').price, 34.2);
  assert.strictEqual(get('Sheep', 'Ewe').price, 36);                 // Dorper row rejected, falls back to Fat Tails
  assert.deepStrictEqual([get('Goat', 'Doe').basis, get('Goat', 'Doe').price], ['head', 1178]);
  assert.match(get('Goat', 'Doe').note, /"GOAT".*range 1011 to 1312/);
  assert.ok(!get('Cattle', 'Bull'));
  assert.ok(!get('Goat', 'Kid'));
  assert.deepStrictEqual(unpriced, ['Cattle Bull', 'Cattle Heifer']);
  assert.strictEqual(rejected.length, 2);
});

// A stand-in for the internet: the price board's site, the Claude API, and the real TFNN app.
function fakeFetch({ quotes, calls }) {
  return async (url, opts = {}) => {
    calls.push(url);
    const reply = (status, body, isText) => ({ ok: status < 400, status, text: async () => body, json: async () => (isText ? JSON.parse(body) : body), arrayBuffer: async () => body });
    if (url === 'https://nammic.com.na/') return reply(200, HOME, true);
    if (url.endsWith('.pdf')) return reply(200, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 32)]));
    if (url === 'https://api.anthropic.com/v1/messages') {
      const sent = JSON.parse(opts.body);
      assert.strictEqual(opts.headers['x-api-key'], 'test-key');
      assert.strictEqual(sent.messages[0].content[0].type, 'document');
      assert.strictEqual(sent.output_config.format.type, 'json_schema');
      return reply(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ report_date: '03 November 2026', auction_period: '27-30 Oct 2026', quotes }) }] });
    }
    if (url.startsWith('https://tfnn.test/')) {
      const res = await request(app).post(url.replace('https://tfnn.test', '')).set(opts.headers).send(JSON.parse(opts.body));
      return reply(res.status, res.body);
    }
    throw new Error('unexpected request to ' + url);
  };
}

test('a full run reads the report and leaves prices waiting for approval in TFNN', async () => {
  await db.query(`DELETE FROM price_proposal; DELETE FROM reference_price WHERE species = 'Cattle' AND class IN ('Cow','Steer','Calf')`);
  process.env.CRON_SECRET = 'test-cron-secret';
  const env = { ANTHROPIC_API_KEY: 'test-key', CRON_SECRET: 'test-cron-secret', TFNN_URL: 'https://tfnn.test', PRICE_AGENT_RETRY_MS: '1' };
  const calls = [], lines = [];
  const out = await agent.run({ env, fetchFn: fakeFetch({ quotes: QUOTES, calls }), log: (l) => lines.push(l) });
  assert.match(calls[1], /03%20Nov%202026/);
  assert.strictEqual(out.result.pending, out.items.length);
  assert.match(out.source, /03 November 2026 \(auctions 27-30 Oct 2026\)/);

  const cow = (await db.query(`SELECT * FROM price_proposal WHERE status = 'pending' AND species = 'Cattle' AND class = 'Cow'`)).rows[0];
  assert.strictEqual(Number(cow.price), 24.5 * 450);
  assert.match(cow.note, /Cows Medium/);

  // dry run sends nothing to TFNN; a wrong secret or an empty report fails loudly
  const dryCalls = [];
  await agent.run({ env, dryRun: true, fetchFn: fakeFetch({ quotes: QUOTES, calls: dryCalls }), log: () => {} });
  assert.ok(!dryCalls.some((u) => u.startsWith('https://tfnn.test')));
  await assert.rejects(agent.run({ env: { ...env, CRON_SECRET: 'wrong' }, fetchFn: fakeFetch({ quotes: QUOTES, calls: [] }), log: () => {} }), /refused the prices \(401\)/);
  await assert.rejects(agent.run({ env, fetchFn: fakeFetch({ quotes: [], calls: [] }), log: () => {} }), /nothing was sent/);
  await db.query('DELETE FROM price_proposal');
});

test('a price equal to the live market price is not sent for approval again', async () => {
  await db.query(`DELETE FROM price_proposal WHERE species = 'Sheep' AND class = 'Ewe'; DELETE FROM reference_price WHERE species = 'Sheep' AND class = 'Ewe'`);
  process.env.CRON_SECRET = 'test-cron-secret';
  const send = () => request(app).post('/api/v1/jobs/market-price-proposals').set('x-cron-secret', 'test-cron-secret').send({ items: [{ species: 'Sheep', class: 'Ewe', basis: 'head', price: 800 }] });
  assert.strictEqual((await send()).body.result.pending, 1);
  const farmer = await registerFarmer();
  await db.query(`UPDATE users SET role = 'admin' WHERE phone = $1`, [farmer.phone]);
  const login = await request(app).post('/api/v1/auth/login').send({ phone: farmer.phone, password: farmer.password });
  const id = (await db.query(`SELECT proposal_id FROM price_proposal WHERE status = 'pending' AND species = 'Sheep' AND class = 'Ewe'`)).rows[0].proposal_id;
  await request(app).post('/api/v1/admin/price-proposals/decide').set('Authorization', `Bearer ${login.body.token}`).send({ ids: [id], action: 'approve' });
  const again = await send();
  assert.strictEqual(again.body.result.pending, 0);
  assert.match(again.body.result.skipped[0].reason, /same as the current market price/);
  await db.query(`DELETE FROM reference_price WHERE species = 'Sheep' AND class = 'Ewe'`);
});
