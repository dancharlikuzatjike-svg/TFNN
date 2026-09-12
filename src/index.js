require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const animalRoutes = require('./routes/animals');
const eventRoutes = require('./routes/events');
const taskRoutes = require('./routes/tasks');
const feedRoutes = require('./routes/feed');
const vetRoutes = require('./routes/vet');
const adminRoutes = require('./routes/admin');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/animals', animalRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/tasks', taskRoutes);
app.use('/api/v1', feedRoutes);
app.use('/api/v1', vetRoutes);
app.use('/api/v1/admin', adminRoutes);

// The farmer portal is served by the same app as the API. This avoids a second
// deployment and lets the frontend use secure same-origin /api/v1 requests.
const publicDirectory = path.join(__dirname, '..', 'public');
app.use(express.static(publicDirectory));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(publicDirectory, 'index.html'));
});

// 404 for unmatched API requests.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`TFNN backend and farmer portal listening on port ${PORT}`);
});

module.exports = app;
