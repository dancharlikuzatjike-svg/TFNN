const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The PDF reader lives in app.html (it runs in the farmer's browser). Pull the parser out and test it on
// made-up statements shaped like the NamLITS "Herd Statement - Tagged List" report. No real herd data here.
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const code = html.split('// BEGIN NAMLITS PARSER')[1].split('// END NAMLITS PARSER')[0];
const parse = new Function(code + '; return parseNamlitsPages;')();

const X = { herd: 19, owner: 72, type: 197, cls: 264, breed: 326, prod: 388, head: 472, tag: 494 };
const it = (str, x, y) => ({ str, x, y });
const heading = (y) => [it('Herd', X.herd, y), it('Owner Name', X.owner, y), it('Animal Type', X.type, y), it('Class', X.cls, y),
  it('Breed', X.breed, y), it('Prdtn Type', X.prod, y), it('Head Cnt Tag-ID', 451, y)];
const group = (y, type, cls, breed, prod, head, firstTag) => [it(type, X.type, y), it(cls, X.cls, y), it(breed, X.breed, y),
  ...(prod ? [it(prod, X.prod, y)] : []), it(String(head), X.head, y), it(firstTag, X.tag, y)];
const tags = (y, list) => list.map((t, i) => it(t, X.tag, y - 12 * i));
const footer = (y, n) => [it(`Animal Total: ${n}`, 100, y), it('Printed: 01/01/2030 10:00', 0, 18)];

const PAGE1 = [
  it('Herd Statement - Tagged List', 43, 779), it('Livestock Keeper: HQ000000 TEST KEEPER', 106, 724),
  ...heading(700),
  ...group(676, 'Cattle', 'Cow', 'Bonsmara', 'Beef', 3, '10000001'), ...tags(664, ['10000002', '10000003']),
  ...group(640, 'Cattle', 'Cow', 'Beef Crossbr Beef', null, 2, '20000001'), ...tags(628, ['20000002']),
];
const PAGE2 = [
  ...heading(724),
  ...group(700, 'Cattle', 'Calf - Male', 'Brahman', 'Beef', 3, '30000001'), ...tags(688, ['30000002']), // the 3rd tag runs onto this page
  ...tags(664, ['30000003']),
  ...group(640, 'Cattle', 'Ox', 'Brahman', 'Beef', 1, '40000001'),
  ...group(616, 'Goat', 'Doe', 'Boer', 'Meat', 1, '50000001'),
  ...footer(590, 10),
];

test('reads groups, tags, and a group that runs over a page break', () => {
  const r = parse([PAGE1, PAGE2]);
  assert.strictEqual(r.rows.length, 10);
  assert.strictEqual(r.declared, 10);
  assert.strictEqual(r.groups, 5);
  assert.deepStrictEqual(r.problems, []);
  assert.deepStrictEqual(r.rows[0], ['10000001', 'Cattle', 'Cow', 'Bonsmara', 'Beef']);
  assert.deepStrictEqual(r.rows[2], ['10000003', 'Cattle', 'Cow', 'Bonsmara', 'Beef']);
  assert.strictEqual(new Set(r.rows.map((x) => x[0])).size, 10);
});

test('a long breed name that runs into the production column is split back apart', () => {
  const r = parse([PAGE1, PAGE2]);
  assert.deepStrictEqual(r.rows.find((x) => x[0] === '20000001'), ['20000001', 'Cattle', 'Cow', 'Beef Crossbreed', 'Beef']);
});

test('NamLITS class names become TFNN classes', () => {
  const r = parse([PAGE1, PAGE2]);
  assert.strictEqual(r.rows.find((x) => x[0] === '30000001')[2], 'Calf'); // "Calf - Male"
  assert.strictEqual(r.rows.find((x) => x[0] === '40000001')[2], 'Steer'); // "Ox"
  assert.deepStrictEqual(r.rows.find((x) => x[0] === '50000001'), ['50000001', 'Goat', 'Doe', 'Boer', 'Meat']);
});

test('a head count that does not match the tags listed is reported', () => {
  const short = [PAGE1[0], ...heading(700), ...group(676, 'Cattle', 'Cow', 'Bonsmara', 'Beef', 5, '10000001'), ...tags(664, ['10000002'])];
  const r = parse([short]);
  assert.strictEqual(r.rows.length, 2);
  assert.ok(r.problems.some((p) => p.includes('says 5 head but lists 2')), JSON.stringify(r.problems));
});

test('a PDF that is not a herd statement gives no rows', () => {
  assert.strictEqual(parse([[it('Some other document', 50, 700), it('12345678', 50, 680)]]).rows.length, 0);
  assert.strictEqual(parse([]).rows.length, 0);
});
