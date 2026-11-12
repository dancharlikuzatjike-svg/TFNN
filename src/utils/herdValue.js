// How a live animal gets its value. The first of these that is set wins:
//   1. animal.estimated_value - the farmer's own figure for that one animal   (source 'animal')
//   2. class_price            - the farmer's own price per head for its class (source 'class')
//   3. reference_price        - the TFNN market reference price               (source 'market')
// An animal with none of the three has value NULL (source NULL) and counts as "unpriced".
const db = require('../db');

const SPECIES = ['Cattle', 'Sheep', 'Goat'];
const MAX_PRICE = 99999999;

// SELECT fragments, for an `animal a` already in the FROM clause.
const VALUE_JOINS = `
  LEFT JOIN class_price cp ON cp.owner_id = a.owner_id AND cp.species = a.species AND cp.class = COALESCE(a.class, '')
  LEFT JOIN reference_price rp ON rp.species = a.species AND rp.class = COALESCE(a.class, '')`;
const VALUE_COLUMNS = `
  COALESCE(a.estimated_value, cp.price, rp.price) AS value,
  CASE WHEN a.estimated_value IS NOT NULL THEN 'animal'
       WHEN cp.price IS NOT NULL THEN 'class'
       WHEN rp.price IS NOT NULL THEN 'market' END AS value_source`;

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
    if (!p || !SPECIES.includes(p.species)) return { error: 'species must be one of: ' + SPECIES.join(', ') };
    const cls = p.class == null ? '' : String(p.class).trim();
    if (cls.length > 20) return { error: 'class is too long' };
    const price = parsePrice(p.price);
    if (price === undefined) return { error: `Price for ${p.species} ${cls} must be a number, 0 or more`.replace('  ', ' ') };
    rows.push({ species: p.species, class: cls, price, source: p.source ? String(p.source).slice(0, 200) : null });
  }
  return { rows };
}

async function herdTotals(ownerId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS animal_count,
            COALESCE(SUM(v.value), 0)::numeric AS total,
            COUNT(*) FILTER (WHERE v.value IS NULL)::int AS unpriced_count,
            COUNT(*) FILTER (WHERE v.value_source = 'market')::int AS market_priced_count
     FROM (SELECT ${VALUE_COLUMNS} FROM animal a ${VALUE_JOINS}
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

module.exports = { SPECIES, VALUE_JOINS, VALUE_COLUMNS, parsePrice, parsePriceRows, herdTotals, setReferencePrices, listReferencePrices };
