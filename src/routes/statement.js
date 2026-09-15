const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function money(n){ return 'N$' + Number(n || 0).toLocaleString(); }
function dateStr(d){ return d ? new Date(d).toISOString().slice(0, 10) : ''; }

// GET /api/v1/statement?from=&to=&format=json
// Downloads a PDF farm statement by default (herd value, sales, expenses, totals
// for the period). Pass format=json for the same data unrendered, e.g. for a
// frontend preview screen before download.
router.get('/', async (req, res, next) => {
  try {
    const { from, to, format } = req.query;

    const farmerResult = await db.query('SELECT name, farm_location FROM users WHERE user_id = $1', [req.auth.user_id]);
    const farmer = farmerResult.rows[0];

    const herdResult = await db.query(
      `SELECT tag_number, species, breed, estimated_value FROM animal
       WHERE owner_id = $1 AND status = 'Active' ORDER BY species, tag_number`,
      [req.auth.user_id]
    );

    const salesConditions = ['seller_id = $1', 'deleted_at IS NULL', `payment_status != 'Cancelled'`];
    const salesParams = [req.auth.user_id];
    if (from) { salesParams.push(from); salesConditions.push(`sale_date >= $${salesParams.length}`); }
    if (to) { salesParams.push(to); salesConditions.push(`sale_date <= $${salesParams.length}`); }
    const salesResult = await db.query(
      `SELECT s.sale_date, s.buyer_name, s.price, s.payment_status, a.tag_number
       FROM sale s JOIN animal a ON a.animal_id = s.animal_id
       WHERE ${salesConditions.join(' AND ')} ORDER BY s.sale_date DESC`,
      salesParams
    );

    const expenseConditions = ['farmer_id = $1', 'deleted_at IS NULL'];
    const expenseParams = [req.auth.user_id];
    if (from) { expenseParams.push(from); expenseConditions.push(`expense_date >= $${expenseParams.length}`); }
    if (to) { expenseParams.push(to); expenseConditions.push(`expense_date <= $${expenseParams.length}`); }
    const expenseResult = await db.query(
      `SELECT expense_date, category, description, amount FROM expense
       WHERE ${expenseConditions.join(' AND ')} ORDER BY expense_date DESC`,
      expenseParams
    );

    const herdValue = herdResult.rows.reduce((sum, a) => sum + Number(a.estimated_value || 0), 0);
    const salesTotal = salesResult.rows.reduce((sum, s) => sum + Number(s.price), 0);
    const expenseTotal = expenseResult.rows.reduce((sum, e) => sum + Number(e.amount), 0);
    const net = salesTotal - expenseTotal;

    if (format === 'json') {
      return res.json({
        farmer,
        period: { from: from || null, to: to || null },
        generated_at: new Date().toISOString(),
        live_herd: herdResult.rows,
        sales: salesResult.rows,
        expenses: expenseResult.rows,
        totals: { herd_value: herdValue, sales_income: salesTotal, expenses: expenseTotal, net_cash_position: net },
      });
    }

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const filename = `farm-statement-${from || 'all'}-to-${to || 'present'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    doc.fontSize(18).text('Farm Statement');
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#555')
      .text(`${farmer.name}${farmer.farm_location ? ' — ' + farmer.farm_location : ''}`)
      .text(`Period: ${from || 'inception'} to ${to || 'present'}`)
      .text(`Generated: ${dateStr(new Date())}`);
    doc.fillColor('#000').moveDown(1);

    function sectionHeader(title) {
      doc.moveDown(0.5).fontSize(13).text(title);
      doc.moveDown(0.3);
      doc.moveTo(doc.x, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.4).fontSize(9).fillColor('#000');
    }

    sectionHeader('Live Herd');
    if (herdResult.rows.length === 0) {
      doc.text('No active animals on record.');
    } else {
      herdResult.rows.forEach(a => {
        doc.text(`${a.tag_number}   ${a.breed || ''} ${a.species}   ${money(a.estimated_value)}`);
      });
    }

    sectionHeader('Sales');
    if (salesResult.rows.length === 0) {
      doc.text('No sales recorded in this period.');
    } else {
      salesResult.rows.forEach(s => {
        doc.text(`${dateStr(s.sale_date)}   ${s.tag_number}   ${s.buyer_name}   ${money(s.price)}   ${s.payment_status}`);
      });
    }

    sectionHeader('Expenses');
    if (expenseResult.rows.length === 0) {
      doc.text('No expenses recorded in this period.');
    } else {
      expenseResult.rows.forEach(e => {
        doc.text(`${dateStr(e.expense_date)}   ${e.category || ''}   ${e.description || ''}   ${money(e.amount)}`);
      });
    }

    sectionHeader('Summary');
    doc.fontSize(10);
    doc.text(`Live herd value:      ${money(herdValue)}`);
    doc.text(`Sales income:         ${money(salesTotal)}`);
    doc.text(`Expenses:             ${money(expenseTotal)}`);
    doc.font('Helvetica-Bold').text(`Net cash position:    ${money(net)}`);
    doc.font('Helvetica');

    doc.moveDown(1.5).fontSize(8).fillColor('#777').text(
      'This statement is generated from farmer-entered records in the TFNN system and has not been independently audited.',
      { width: 495 }
    );

    doc.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
