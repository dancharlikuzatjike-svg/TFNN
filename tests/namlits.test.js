const test = require('node:test');
const assert = require('node:assert');
const N = require('../namlits.js');

// Same layout as a real NamLITS "Herd Statement - Tagged List", with made-up names and tags.
const STATEMENT = `
              Herd Statement - Tagged List

   Selection:Establishment: HQ000001 Test Farm / Sample
   Livestock Keeper: HQ000002 SAMPLE KEEPER NAME

   Herd        Owner Name                Animal Type     Class       Breed       Prdtn Type   Head Cnt Tag-ID

   HQ000003    SAMPLE KEEPER NAME        Cattle          Cow         Beef Crossbr Beef            3     10000001
                                                                                                        10000002
                                                                                                        10000003
                                         Cattle          Cow         Brahman     Beef             2     20000001
                                                                                                        20000002
                                         Cattle          Bull        Brahman     Beef             1     30000001
                                         Animal Total:                                            6

                                         Sheep Group   *             Sheep       Mutton          12     O000111M
                                         Animal Total:                                           12

                                         Goat Group    *             Goat        Meat             4     O000111M
                                         Animal Total:                                            4

                                         Grand Total:                                            22

   Total number of rows in report: 9
                                                  *** END OF REPORT ***

Printed: 07/10/2026 16:17   By: NamLITS Online                                                  Page:     1 of 1
`;

test('reads the keeper and establishment', () => {
  const p = N.parse(STATEMENT);
  assert.strictEqual(p.establishment, 'HQ000001 Test Farm / Sample');
  assert.strictEqual(p.keeper, 'HQ000002 SAMPLE KEEPER NAME');
  assert.strictEqual(p.grandTotal, 22);
  assert.strictEqual(p.herds.length, 5);
});

test('individually tagged cattle keep their real tags, class and breed', () => {
  const r = N.toAnimals(N.parse(STATEMENT));
  const cattle = r.animals.filter((a) => a.species === 'Cattle');
  assert.strictEqual(cattle.length, 6);
  assert.deepStrictEqual(cattle.slice(0, 3).map((a) => a.tag_number), ['10000001', '10000002', '10000003']);
  assert.strictEqual(cattle[0].breed, 'Beef Crossbred');
  assert.strictEqual(cattle[0].class, 'Cow');
  assert.strictEqual(cattle[3].breed, 'Brahman');
  assert.strictEqual(cattle[5].class, 'Bull');
});

test('groups sharing one tag become numbered animals', () => {
  const r = N.toAnimals(N.parse(STATEMENT));
  const sheep = r.animals.filter((a) => a.species === 'Sheep');
  const goats = r.animals.filter((a) => a.species === 'Goat');
  assert.strictEqual(sheep.length, 12);
  assert.strictEqual(goats.length, 4);
  assert.strictEqual(sheep[0].tag_number, 'O000111M-S01');
  assert.strictEqual(sheep[11].tag_number, 'O000111M-S12');
  assert.strictEqual(goats[0].tag_number, 'O000111M-G01');
  // sheep and goats share the base tag O000111M, but every final tag must be unique
  const tags = r.animals.map((a) => a.tag_number);
  assert.strictEqual(new Set(tags).size, 22);
});

test('generic "Sheep"/"Goat" breed and "*" class are left blank', () => {
  const r = N.toAnimals(N.parse(STATEMENT));
  const sheep = r.animals.find((a) => a.species === 'Sheep');
  assert.strictEqual(sheep.breed, undefined);
  assert.strictEqual(sheep.class, undefined);
});

test('total matches the statement', () => {
  const r = N.toAnimals(N.parse(STATEMENT));
  assert.strictEqual(r.total, 22);
  assert.strictEqual(r.animals.length, 22);
  assert.strictEqual(r.totalMatches, true);
});

test('works on single-spaced text, as rebuilt from a PDF in the browser', () => {
  const flat = STATEMENT.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n');
  const r = N.toAnimals(N.parse(flat));
  assert.strictEqual(r.animals.length, 22);
  assert.strictEqual(r.totalMatches, true);
});

test('linesFromItems rebuilds lines from positioned PDF text', () => {
  const items = [
    { str: '10000001', x: 400, y: 700 },
    { str: 'Cattle', x: 100, y: 701 },
    { str: 'Cow', x: 160, y: 700.5 },
    { str: '3', x: 380, y: 700 },
    { str: '10000002', x: 400, y: 685 },
  ];
  assert.deepStrictEqual(N.linesFromItems(items), ['Cattle Cow 3 10000001', '10000002']);
});

test('a mismatch between head count and tags is reported, not hidden', () => {
  const text = 'Cattle Cow Brahman Beef 3 10000001\n10000002\nGrand Total: 3';
  const r = N.toAnimals(N.parse(text));
  assert.strictEqual(r.animals.length, 2);
  assert.ok(r.warnings.some((w) => /lists 2 tags/.test(w)));
});

test('recognises a NamLITS statement', () => {
  assert.strictEqual(N.looksLikeNamlits(STATEMENT), true);
  assert.strictEqual(N.looksLikeNamlits('tag,species\n1,Cattle'), false);
});
