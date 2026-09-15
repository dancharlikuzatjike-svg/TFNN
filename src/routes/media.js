const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const REF_TYPES = ['animal', 'animal_event'];
const KINDS = ['photo', 'voice'];
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;   // 3MB
const MAX_VOICE_BYTES = 1.5 * 1024 * 1024; // 1.5MB - keep voice notes short

// Returns metadata columns only - never the blob - for list responses
const METADATA_COLUMNS = 'media_id, ref_type, ref_id, kind, mime_type, size_bytes, created_at';

// A photo/voice note can only be attached to (or viewed on) something the
// current farmer actually owns.
async function verifyMediaOwnership(refType, refId, ownerId) {
  if (refType === 'animal') {
    const r = await db.query('SELECT 1 FROM animal WHERE animal_id = $1 AND owner_id = $2', [refId, ownerId]);
    return r.rows.length > 0;
  }
  if (refType === 'animal_event') {
    const r = await db.query(
      `SELECT 1 FROM animal_event e JOIN animal a ON a.animal_id = e.animal_id
       WHERE e.event_id = $1 AND a.owner_id = $2`,
      [refId, ownerId]
    );
    return r.rows.length > 0;
  }
  return false;
}

// GET /api/v1/media?ref_type=&ref_id= - list attachments for one animal or event (metadata only)
router.get('/', async (req, res, next) => {
  try {
    const { ref_type, ref_id } = req.query;
    if (!ref_type || !ref_id) {
      return res.status(400).json({ error: 'ref_type and ref_id are required' });
    }

    const owned = await verifyMediaOwnership(ref_type, ref_id, req.auth.user_id);
    if (!owned) return res.status(404).json({ error: `${ref_type} not found` });

    const result = await db.query(
      `SELECT ${METADATA_COLUMNS} FROM media WHERE ref_type = $1 AND ref_id = $2 ORDER BY created_at DESC`,
      [ref_type, ref_id]
    );
    res.json({ media: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/media - body: { ref_type, ref_id, kind, mime_type, data (base64), client_id? }
router.post('/', async (req, res, next) => {
  try {
    const { ref_type, ref_id, kind, mime_type, data, client_id } = req.body;

    if (!ref_type || !ref_id || !kind || !mime_type || !data) {
      return res.status(400).json({ error: 'ref_type, ref_id, kind, mime_type and data are required' });
    }
    if (!REF_TYPES.includes(ref_type)) {
      return res.status(400).json({ error: `ref_type must be one of: ${REF_TYPES.join(', ')}` });
    }
    if (!KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` });
    }

    if (client_id) {
      const existing = await db.query(`SELECT ${METADATA_COLUMNS} FROM media WHERE client_id = $1`, [client_id]);
      if (existing.rows.length > 0) {
        return res.status(200).json({ media: existing.rows[0] });
      }
    }

    const owned = await verifyMediaOwnership(ref_type, ref_id, req.auth.user_id);
    if (!owned) return res.status(404).json({ error: `${ref_type} not found` });

    let buffer;
    try {
      buffer = Buffer.from(data, 'base64');
    } catch {
      return res.status(400).json({ error: 'data must be a valid base64 string' });
    }

    const limit = kind === 'photo' ? MAX_PHOTO_BYTES : MAX_VOICE_BYTES;
    if (buffer.length > limit) {
      return res.status(413).json({
        error: `${kind} exceeds the ${(limit / (1024 * 1024)).toFixed(1)}MB limit — please compress before uploading`,
      });
    }

    const result = await db.query(
      `INSERT INTO media (owner_id, ref_type, ref_id, kind, mime_type, data, size_bytes, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${METADATA_COLUMNS}`,
      [req.auth.user_id, ref_type, ref_id, kind, mime_type, buffer, buffer.length, client_id || null]
    );
    res.status(201).json({ media: result.rows[0] });
  } catch (err) {
    if (err.code === '23505' && req.body.client_id) {
      const existing = await db.query(`SELECT ${METADATA_COLUMNS} FROM media WHERE client_id = $1`, [req.body.client_id]);
      if (existing.rows.length > 0) return res.status(200).json({ media: existing.rows[0] });
    }
    next(err);
  }
});

// GET /api/v1/media/:id - returns the raw file itself (for <img src> / <audio src>), not JSON
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM media WHERE media_id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Media not found' });
    const item = result.rows[0];

    const owned = await verifyMediaOwnership(item.ref_type, item.ref_id, req.auth.user_id);
    if (!owned) return res.status(404).json({ error: 'Media not found' });

    res.set('Content-Type', item.mime_type);
    res.send(item.data);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/media/:id - hard delete. Unlike the rest of the system, media is
// not kept forever: the underlying record (the event/note) survives regardless,
// and holding deleted files permanently isn't worth it on a storage-limited free tier.
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query('SELECT ref_type, ref_id FROM media WHERE media_id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Media not found' });
    const item = result.rows[0];

    const owned = await verifyMediaOwnership(item.ref_type, item.ref_id, req.auth.user_id);
    if (!owned) return res.status(404).json({ error: 'Media not found' });

    await db.query('DELETE FROM media WHERE media_id = $1', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
