// How a live animal gets its value. The first of these that is set wins:
//   1. animal.estimated_value - the farmer's own figure for that one animal   (source 'animal')
//   2. class_price            - the farmer's own price per head for its class (source 'class')
//   3. reference_price        - the TFNN market reference price               (source 'market')
// An animal with none of the three has value NULL (source NULL) and counts as "unpriced".
//
// An animal with no class recorded is assumed to be the adult female of its species (Cow, Ewe
// or Doe) for steps 2 and 3, unless the farmer has set a price for "no class" animals, which
// wins. value_assumed_class says when that assumption was used.
const db = require('../db');

// The species that have TFNN market reference prices (the weekly price agent covers these three).
const SPECIES = ['Cattle', 'Sheep', 'Goat'];
const MAX_PRICE = 99999999;

// Any animal can be recorded. These common names are tidied to one spelling; anything else is
// kept as typed, in title case (e.g. "guinea fowl" becomes "Guinea Fowl").
const SPECIES_ALIASES = {
  cattle: 'Cattle', cow: 'Cattle', cows: 'Cattle', sheep: 'Sheep', goat: 'Goat', goats: 'Goat',
  pig: 'Pig', pigs: 'Pig', horse: 'Horse', horses: 'Horse', donkey: 'Donkey', donkeys: 'Donkey',
  chicken: 'Chicken', chickens: 'Chicken',
};
function normaliseSpecies(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!s || s.length > 40) return null;
  const known = SPECIES_ALIASES[s.toLowerCase()];
  if (known) return known;
  return s.toLowerCase().replace(/(^|[\s\-\/])([a-z])/g, (m, before, c) => before + c.toUpperCase());
}

// The adult female of each species, used for animals with no class recorded.
const ADULT_CLASS = { Cattle: 'Cow', Sheep: 'Ewe', Goat: 'Doe', Pig: 'Sow', Horse: 'Mare', Donkey: 'Jenny', Chicken: 'Hen' };
// Classes that count as breeding females, and classes that count as young animals.
const BREEDING_FEMALE = ['Cow', 'Ewe', 'Doe', 'Sow', 'Mare', 'Jenny', 'Hen'];
const YOUNG_CLASS = ['Calf', 'Lamb', 'Kid', 'Piglet', 'Weaner', 'Foal', 'Chick'];
// SQL: the adult class for the species in speciesColumn, or NULL for a species we don't know.
const adultOf = (speciesColumn) =>
  `CASE ${speciesColumn} ${Object.entries(ADULT_CLASS).map(([sp, c]) => `WHEN '${sp}' THEN '${c}'`).join(' ')} END`;

// SELECT fragments, for an `animal a` already in the FROM clause.
//   cp  = the farmer's price for the animal's own class ('' when it has none)
//   cpa = the farmer's price for the assumed adult class (only for animals with no class)
//   rp  = the market price for the animal's class, or for the assumed adult class
const VALUE_JOINS = `
  LEFT JOIN class_price cp ON cp.owner_id = a.owner_id AND cp.species = a.species AND cp.class = COALESCE(a.class, '')
  LEFT JOIN class_price cpa ON COALESCE(a.class, '') = '' AND cpa.owner_id = a.owner_id AND cpa.species = a.species AND cpa.class = ${adultOf('a.species')}
  LEFT JOIN reference_price rp ON rp.species = a.species AND rp.class = COALESCE(NULLIF(a.class, ''), ${adultOf('a.species')})`;
// A price is per head. The value of a record is that price times its head count (a flock is many heads).
const UNIT_PRICE = 'COALESCE(a.estimated_value, cp.price, cpa.price, rp.price)';
const VALUE_EXPR = `(${UNIT_PRICE} * a.head_count)`;
const VALUE_COLUMNS = `
  ${VALUE_EXPR} AS value,
  CASE WHEN a.estimated_value IS NOT NULL THEN 'animal'
       WHEN cp.price IS NOT NULL OR cpa.price IS NOT NULL THEN 'class'
       WHEN rp.price IS NOT NULL THEN 'market' END AS value_source,
  CASE WHEN COALESCE(a.class, '') = '' AND a.estimated_value IS NULL AND cp.price IS NULL
            AND (cpa.price IS NOT NULL OR rp.price IS NOT NULL) THEN ${adultOf('a.species')} END AS value_assumed_class`;

// Returns a clean number, null (meaning "clear it"), or undefined when the input is not a valid price.
function parsePrice(raw) {
  if (raw === null || raw === '' || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return undefined;
  return Math.round(n * 100) / 100;
}

// Validates [{ species, class, price, source? }]. Returns { rows } or { error }.
function parsePriceRows(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: 'prices must be a non-empty list' };
  if (input.length > 100) return { error: 'Too many prices in one request' };
  const rows = [];
  for (const p of input) {
    const species = p ? normaliseSpecies(p.species) : null;
    if (!species) return { error: 'species is required (up to 40 letters)' };
    const cls = p.class == null ? '' : String(p.class).trim();
    if (cls.length > 20) return { error: 'class is too long' };
    const price = parsePrice(p.price);
    if (price === undefined) return { error: `Price for ${species} ${cls} must be a number, 0 or more`.replace('  ', ' ') };
    rows.push({ species, class: cls, price, source: p.source ? String(p.source).slice(0, 200) : null });
  }
  return { rows };
}

async function herdTotals(ownerId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(v.head_count), 0)::int AS animal_count,
            COALESCE(SUM(v.value), 0)::numeric AS total,
            COUNT(*) FILTER (WHERE v.value IS NULL)::int AS unpriced_count,
            COUNT(*) FILTER (WHERE v.value_source = 'market')::int AS market_priced_count,
            COUNT(*) FILTER (WHERE v.value_assumed_class IS NOT NULL)::int AS assumed_class_count
     FROM (SELECT ${VALUE_COLUMNS}, a.head_count FROM animal a ${VALUE_JOINS}
           WHERE a.owner_id = $1 AND a.status = 'Active') v`,
    [ownerId]
  );
  return r.rows[0];
}

// Sets (or, when price is null, removes) TFNN market reference prices.
async function setReferencePrices(rows) {
  let updated = 0, removed = 0;
  for (const p of rows) {
    if (p.price === null) {
      const r = await db.query('DELETE FROM reference_price WHERE species = $1 AND class = $2', [p.species, p.class]);
      removed += r.rowCount;
    } else {
      await db.query(
        `INSERT INTO reference_price (species, class, price, source) VALUES ($1, $2, $3, $4)
         ON CONFLICT (species, class) DO UPDATE SET price = EXCLUDED.price, source = EXCLUDED.source, updated_at = now()`,
        [p.species, p.class, p.price, p.source]);
      updated += 1;
    }
  }
  return { updated, removed };
}

async function listReferencePrices() {
  const r = await db.query('SELECT species, class, price, source, updated_at FROM reference_price ORDER BY species, class');
  return r.rows.map((p) => ({ ...p, price: Number(p.price) }));
}

module.exports = { SPECIES, ADULT_CLASS, BREEDING_FEMALE, YOUNG_CLASS, normaliseSpecies, adultOf, VALUE_JOINS, VALUE_COLUMNS, VALUE_EXPR, parsePrice, parsePriceRows, herdTotals, setReferencePrices, listReferencePrices };
