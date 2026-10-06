require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const animalRoutes = require('./routes/animals');
const eventRoutes = require('./routes/events');
const taskRoutes = require('./routes/tasks');
const feedRoutes = require('./routes/feed');
const vetRoutes = require('./routes/vet');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/users');
const marketRoutes = require('./routes/market');
const alertRoutes = require('./routes/alerts');
const salesRoutes = require('./routes/sales');
const expenseRoutes = require('./routes/expenses');
const valuationRoutes = require('./routes/valuation');
const mediaRoutes = require('./routes/media');
const statementRoutes = require('./routes/statement');
const marketplaceRoutes = require('./routes/marketplace');
const notificationRoutes = require('./routes/notifications');
const jobsRoutes = require('./routes/jobs');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json({ limit: '6mb' })); // base64 photo/voice uploads need more than the 100kb default

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ---- Frontend (PWA) served from this same service ----
// Only this fixed allow-list is served, so nothing else in the repo (src/, .env, ...) can leak.
const path = require('path');
const FRONTEND_FILES = ['app.html', 'index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'emblem.png', 'logo.png'];
const sendFrontend = (file) => (req, res, next) => {
  res.set('Cache-Control', 'no-cache'); // always revalidate so fixes reach users immediately
  res.sendFile(path.join(__dirname, '..', file), (err) => { if (err) next(); });
};
FRONTEND_FILES.forEach((f) => app.get('/' + f, sendFrontend(f)));
app.get('/', sendFrontend('app.html'));

// Jobs use their own secret, so mount before the routers that apply login to everything under /api/v1
app.use('/api/v1/jobs', jobsRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/animals', animalRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/tasks', taskRoutes);
app.use('/api/v1', feedRoutes);   // feed.js defines /feed-listings and /feed-orders internally
app.use('/api/v1', vetRoutes);    // vet.js defines /vets and /vet-requests internally
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/market-prices', marketRoutes);
app.use('/api/v1/alerts', alertRoutes);
app.use('/api/v1/sales', salesRoutes);
app.use('/api/v1/expenses', expenseRoutes);
app.use('/api/v1/valuation', valuationRoutes);
app.use('/api/v1/media', mediaRoutes);
app.use('/api/v1/statement', statementRoutes);
app.use('/api/v1/marketplace', marketplaceRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// 404 for anything unmatched - must stay LAST, after every real route above
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use(errorHandler);

// Only actually start listening when this file is run directly (npm start).
// When required by the test suite, we just want the app object to hand to
// supertest - not a real port bound and left open.
if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`TFNN backend listening on port ${PORT}`);
  });
}

module.exports = app;
