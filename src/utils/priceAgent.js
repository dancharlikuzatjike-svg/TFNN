// Market price agent, server side. The agent (a scheduled job outside this server) reads the
// weekly Namibian livestock price reports and submits what it found. This file turns each
// quote into a price per head, checks it for mistakes, and holds it for admin approval.
const db = require('../db');
const { SPECIES, setReferencePrices } = require('./herdValue');

const CLASSES = {
  Cattle: ['Cow', 'Bull', 'Heifer', 'Steer', 'Calf'],
  Sheep: ['Ewe', 'Ram', 'Wether', 'Lamb'],
  Goat: ['Doe', 'Buck', 'Wether', 'Kid'],
};

// Typical live weights in kg, used when a price is quoted per kg. Starting estimates only -
// the admin can change any of them on the Prices tab.
const DEFAULT_WEIGHTS = {
  Cattle: { Cow: 450, Bull: 700, Heifer: 350, Steer: 400, Calf: 220 },
  Sheep: { Ewe: 50, Ram: 70, Wether: 45, Lamb: 35 },
  Goat: { Doe: 40, Buck: 55, Wether: 40, Kid: 20 },
};

// A proposed price per head outside these is almost certainly a misread number.
const PLAUSIBLE = { Cattle: [1000, 200000], Sheep: [200, 20000], Goat: [200, 20000] };
const MAX_CHANGE = 0.25; // a move of more than 25% against the current market price is flagged

const autoApprove = () => String(process.env.PRICE_AGENT_AUTO_APPROVE || '').toLowerCase() === 'true';

async function getWeights() {
  const saved = await db.query('SELECT species, class, weight_kg FROM class_weight');
  const out = [];
  for (const species of SPECIES) {
    for (const cls of CLASSES[species]) {
      const row = saved.rows.find((r) => r.species === species && r.class === cls);
      out.push({ species, class: cls, weight_kg: row ? Number(row.weight_kg) : DEFAULT_WEIGHTS[species][cls], is_default: !row });
    }
  }
  return out;
}

// weights: [{ species, class, weight_kg }]. weight_kg null/'' goes back to the default.
async function setWeights(input) {
  if (!Array.isArray(input) || !input.length) return { error: 'weights must be a non-empty list' };
  const rows = [];
  for (const w of input) {
    if (!w || !CLASSES[w.species] || !CLASSES[w.species].includes(w.class)) return { error: 'Unknown species or class in weights' };
    if (w.weight_kg === null || w.weight_kg === '' || w.weight_kg === undefined) { rows.push({ ...w, weight_kg: null }); continue; }
    const kg = Number(w.weight_kg);
    if (!Number.isFinite(kg) || kg <= 0 || kg > 2000) return { error: `Weight for ${w.class} must be between 1 and 2000 kg` };
    rows.push({ species: w.species, class: w.class, weight_kg: Math.round(kg * 100) / 100 });
  }
  for (const w of rows) {
    if (w.weight_kg === null) await db.query('DELETE FROM class_weight WHERE species = $1 AND class = $2', [w.species, w.class]);
    else await db.query(
      `INSERT INTO class_weight (species, class, weight_kg) VALUES ($1, $2, $3)
       ON CONFLICT (species, class) DO UPDATE SET weight_kg = EXCLUDED.weight_kg, updated_at = now()`,
      [w.species, w.class, w.weight_kg]);
  }
  return { saved: rows.length };
}

// items: [{ species, class, basis: 'kg' | 'head', price, note? }], source: where the agent read them.
// Each valid item becomes a pending proposal (replacing any older pending one for that class).
// Items that cannot be used are returned in `skipped` with the reason, never silently dropped.
async function submitProposals({ items, source }) {
  if (!Array.isArray(items) || !items.length) return { error: 'items must be a non-empty list' };
  if (items.length > 50) return { error: 'Too many items in one request' };
  const src = source ? String(source).slice(0, 200) : null;
  const weights = await getWeights();
  const current = await db.query('SELECT species, class, price FROM reference_price');
  const created = [], skipped = [], applied = [];

  for (const it of items) {
    const label = `${it && it.species} ${it && it.class}`;
    if (!it || !CLASSES[it.species] || !CLASSES[it.species].includes(it.class)) { skipped.push({ item: label, reason: 'unknown species or class' }); continue; }
    if (it.basis !== 'kg' && it.basis !== 'head') { skipped.push({ item: label, reason: "basis must be 'kg' or 'head'" }); continue; }
    const quoted = Number(it.price);
    if (!Number.isFinite(quoted) || quoted <= 0) { skipped.push({ item: label, reason: 'price is not a positive number' }); continue; }

    const weight = it.basis === 'kg' ? weights.find((w) => w.species === it.species && w.class === it.class).weight_kg : null;
    const price = Math.round((it.basis === 'kg' ? quoted * weight : quoted) * 100) / 100;
    const prevRow = current.rows.find((r) => r.species === it.species && r.class === it.class);
    const previous = prevRow ? Number(prevRow.price) : null;

    const [lo, hi] = PLAUSIBLE[it.species];
    let flag = null;
    if (price < lo || price > hi) flag = `N$${price} per head is outside the normal range for ${it.species.toLowerCase()}`;
    else if (previous && Math.abs(price - previous) / previous > MAX_CHANGE) {
      flag = `Changes the market price by ${Math.round(((price - previous) / previous) * 100)}% (more than ${MAX_CHANGE * 100}%)`;
    }

    await db.query(`UPDATE price_proposal SET status = 'replaced', decided_at = now() WHERE status = 'pending' AND species = $1 AND class = $2`, [it.species, it.class]);
    const willApply = autoApprove() && !flag;
    const r = await db.query(
      `INSERT INTO price_proposal (species, class, basis, quoted_price, weight_kg, price, previous_price, flag_reason, source, note, status, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [it.species, it.class, it.basis, quoted, weight, price, previous, flag, src, it.note ? String(it.note).slice(0, 300) : null,
       willApply ? 'approved' : 'pending', willApply ? new Date() : null]);
    if (willApply) {
      await setReferencePrices([{ species: it.species, class: it.class, price, source: src }]);
      applied.push(r.rows[0]);
    } else created.push(r.rows[0]);
  }
  return {
    pending: created.length,
    flagged: created.filter((p) => p.flag_reason).length,
    applied: applied.length,
    skipped,
  };
}

const tidy = (p) => ({
  ...p,
  quoted_price: Number(p.quoted_price), price: Number(p.price),
  weight_kg: p.weight_kg == null ? null : Number(p.weight_kg),
  previous_price: p.previous_price == null ? null : Number(p.previous_price),
});

async function listPending() {
  const r = await db.query(`SELECT * FROM price_proposal WHERE status = 'pending' ORDER BY species, class`);
  return r.rows.map(tidy);
}

// action: 'approve' puts the proposed price live as the market price; 'reject' discards it.
async function decideProposals(ids, action) {
  if (!Array.isArray(ids) || !ids.length || !ids.every((i) => Number.isInteger(Number(i)))) return { error: 'ids must be a list of proposal ids' };
  if (action !== 'approve' && action !== 'reject') return { error: "action must be 'approve' or 'reject'" };
  const r = await db.query(
    `UPDATE price_proposal SET status = $1, decided_at = now()
     WHERE status = 'pending' AND proposal_id = ANY($2::int[]) RETURNING *`,
    [action === 'approve' ? 'approved' : 'rejected', ids.map(Number)]);
  if (action === 'approve' && r.rows.length) {
    await setReferencePrices(r.rows.map((p) => ({ species: p.species, class: p.class, price: Number(p.price), source: p.source })));
  }
  return { decided: r.rows.length, action };
}

module.exports = { CLASSES, DEFAULT_WEIGHTS, getWeights, setWeights, submitProposals, listPending, decideProposals };
