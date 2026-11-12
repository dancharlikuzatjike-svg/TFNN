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

// Text of real LLPB reports, in the three layouts the board has used.
const AUG_2026 = `Weekly Livestock and
Meat Producer Prices
DATE: 31 August 2026
LABTA Auction Prices
Some page header text
LABTA Auction Prices
25 August – 28 August 2026
Average Price per kg (N$/kg)
|  |  | Type  | Average  | Min  | Max  |
| --- | --- | --- | --- | --- | --- |
|  | Tollies/Heifers Mix  |  | 31.55  | 26.32  | 35.84  |
|  | Tollies  |  | 37.11  | 33.81  | 39.35  |
|  | Heifers  |  | 32.21  | 30.09  | 34.66  |
|  | Store Oxen  |  | 36.53  | 34.51  | 38.57  |
|  | Store Heifers  |  | 32.27  | 30.72  | 33.66  |
|  | Slaughter Oxen  |  | 37.42  | 33.56  | 39.76  |
|  | Slaughter Heifers  |  | 35.66  | 34.99  | 36.21  |
|  | Cows Fat  |  | 35.37  | 32.86  | 37.12  |
|  | Cows Medium  |  | 30.37  | 27.81  | 32.31  |
|  | Cows Lean  |  | 23.28  | 18.93  | 26.01  |
|  | Slaughter Bulls  |  | 33.48  | 31.97  | 34.55  |
|  | Cows with calves  |  | 11, 631.00 9, 930.00 14, 300.00  |  |  |
| Slaughter Sheep Dorper  |  |  | 39.93  | 34.63  | 44.44  |
|  | Goat (N$/per head)  |  | 1,405.00 1, 171.00 1, 624.00  |  |  |`;
const MAR_2026 = `DATE: 04 March 2026
Goat (N$/per head)
LABTA Auction Prices
23 - 27 February 2026
Average Price per kg (N$/kg)
Type Average Min Max
Tollies/Heifers Mix

33.54 30.58 35.71

Tollies

37.84 36.09 40.11

Store Oxen

37.04 33.72 39.27

Slaughter Sheep Fat Tails

38.11 34.71 41.85

Goat (N$/per head)

1,378.00 1,104.00 1,900.00`;
const NOV_2025 = `DATE: 04 November 2025
LABTA Auction Prices
27 - 31 October 2025
Average Price per kg
Type Average Min Max
Tollies/Heifers Mix
38,07 34,35 42,28
Tollies
41,64 38,33 45,44
Tollies Nguni
Heifers
37,18 33,76 41,32
Heifers Nguni
36,14 36,14 36,14
Store Oxen
38,28 36,44 39,99
Slaughter Oxen
Cows with calves
16 528,00 12 600,00 23 813,00`;
const NOV_2026_EMPTY = `DATE: 03 November 2026
LABTA Auction Prices
27 Oct– 30 Oct 2026
Average Price per kg (N$/kg)
Type Average Min Max
Tollies/Heifers Mix
Tollies
Heifers
Store Oxen
Cows Medium
Slaughter Sheep Dorper
Goat(N$/per head)
NOT AVAILABLE (no action)
NOT AVAILABLE (no action)`;

test('the auction table is read correctly in every layout the board has used', () => {
  const aug = agent.parseAuctionTable(AUG_2026);
  const row = (t, c) => t.quotes.find((q) => q.category === c);
  assert.strictEqual(aug.report_date, '31 August 2026');
  assert.strictEqual(aug.auction_period, '25 August – 28 August 2026');
  assert.strictEqual(aug.quotes.length, 14);
  assert.deepStrictEqual(row(aug, 'Heifers'), { category: 'Heifers', unit: 'kg', average: 32.21, min: 30.09, max: 34.66 });
  assert.deepStrictEqual(row(aug, 'Store Heifers').average, 32.27);
  assert.deepStrictEqual(row(aug, 'Cows with calves'), { category: 'Cows with calves', unit: 'head', average: 11631, min: 9930, max: 14300 });
  assert.deepStrictEqual(row(aug, 'Goat'), { category: 'Goat', unit: 'head', average: 1405, min: 1171, max: 1624 });

  const mar = agent.parseAuctionTable(MAR_2026);
  assert.strictEqual(mar.quotes.length, 5);
  assert.deepStrictEqual(row(mar, 'Goat'), { category: 'Goat', unit: 'head', average: 1378, min: 1104, max: 1900 });
  assert.strictEqual(row(mar, 'Slaughter Sheep Fat Tails').average, 38.11);

  const nov25 = agent.parseAuctionTable(NOV_2025);
  assert.deepStrictEqual(row(nov25, 'Tollies/Heifers Mix'), { category: 'Tollies/Heifers Mix', unit: 'kg', average: 38.07, min: 34.35, max: 42.28 });
  assert.strictEqual(row(nov25, 'Heifers').average, 37.18);          // not the empty "Tollies Nguni" row above it
  assert.strictEqual(row(nov25, 'Heifers Nguni').average, 36.14);
  assert.ok(!row(nov25, 'Slaughter Oxen'));                          // empty row stays empty
  assert.deepStrictEqual(row(nov25, 'Cows with calves'), { category: 'Cows with calves', unit: 'head', average: 16528, min: 12600, max: 23813 });

  const empty = agent.parseAuctionTable(NOV_2026_EMPTY);
  assert.strictEqual(empty.found, true);
  assert.strictEqual(empty.quotes.length, 0);
  assert.strictEqual(agent.parseAuctionTable('A report with no auction section').found, false);
});

test('August 2026 report gives the same per-head prices that were loaded into TFNN by hand', () => {
  const { items } = agent.toItems(agent.parseAuctionTable(AUG_2026).quotes);
  const price = (sp, cl) => items.find((i) => i.species === sp && i.class === cl).price;
  assert.strictEqual(Math.round(price('Cattle', 'Cow') * 450), 13667);
  assert.strictEqual(Math.round(price('Cattle', 'Bull') * 700), 23436);
  assert.strictEqual(Math.round(price('Cattle', 'Calf') * 220), 6941);
  assert.strictEqual(price('Goat', 'Buck'), 1405);
});

// A stand-in for the internet: the price board's site and the real TFNN app.
function fakeFetch({ calls }) {
  return async (url, opts = {}) => {
    calls.push(url);
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => body, json: async () => body, arrayBuffer: async () => body });
    if (url === 'https://nammic.com.na/') return reply(200, HOME);
    if (url.endsWith('.pdf')) return reply(200, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 32)]));
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
  const env = { CRON_SECRET: 'test-cron-secret', TFNN_URL: 'https://tfnn.test', PRICE_AGENT_RETRY_MS: '1' };
  const calls = [], lines = [];
  const out = await agent.run({ env, fetchFn: fakeFetch({ calls }), toText: () => AUG_2026, log: (l) => lines.push(l) });
  assert.match(calls[1], /03%20Nov%202026/);
  assert.strictEqual(out.result.pending, out.items.length);
  assert.strictEqual(out.items.length, 12);
  assert.match(out.source, /31 August 2026 \(auctions 25 August – 28 August 2026\)/);

  const cow = (await db.query(`SELECT * FROM price_proposal WHERE status = 'pending' AND species = 'Cattle' AND class = 'Cow'`)).rows[0];
  assert.strictEqual(Number(cow.price), 13666.5);
  assert.match(cow.note, /Cows Medium/);

  // dry run sends nothing to TFNN; an empty week sends nothing and is not an error; a wrong secret fails loudly
  const dryCalls = [];
  await agent.run({ env: {}, dryRun: true, fetchFn: fakeFetch({ calls: dryCalls }), toText: () => AUG_2026, log: () => {} });
  assert.ok(!dryCalls.some((u) => u.startsWith('https://tfnn.test')));
  const emptyCalls = [];
  const empty = await agent.run({ env, fetchFn: fakeFetch({ calls: emptyCalls }), toText: () => NOV_2026_EMPTY, log: () => {} });
  assert.strictEqual(empty.empty, true);
  assert.ok(!emptyCalls.some((u) => u.startsWith('https://tfnn.test')));
  await assert.rejects(agent.run({ env: { ...env, CRON_SECRET: 'wrong' }, fetchFn: fakeFetch({ calls: [] }), toText: () => AUG_2026, log: () => {} }), /refused the prices \(401\)/);
  await assert.rejects(agent.run({ env, fetchFn: fakeFetch({ calls: [] }), toText: () => 'no table here', log: () => {} }), /layout may have changed/);
  await db.query('DELETE FROM price_proposal');
});

test('a real PDF goes through pdftotext and comes out as the right rows', { skip: require('child_process').spawnSync('pdftotext', ['-v']).error ? 'pdftotext not installed' : false }, () => {
  const fs = require('fs');
  const pdf = fs.readFileSync(require('path').join(__dirname, 'fixtures', 'auction-table.pdf'));
  const read = agent.parseAuctionTable(agent.pdfToText(pdf));
  assert.strictEqual(read.report_date, '31 August 2026');
  assert.strictEqual(read.quotes.length, 14);
  assert.deepStrictEqual(read.quotes.find((q) => q.category === 'Cows with calves'), { category: 'Cows with calves', unit: 'head', average: 11631, min: 9930, max: 14300 });
  assert.strictEqual(read.quotes.find((q) => q.category === 'Slaughter Sheep Dorper').average, 39.93);
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
