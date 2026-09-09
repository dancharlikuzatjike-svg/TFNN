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
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/animals', animalRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/tasks', taskRoutes);
app.use('/api/v1', feedRoutes);   // feed.js defines /feed-listings and /feed-orders internally
app.use('/api/v1', vetRoutes);    // vet.js defines /vets and /vet-requests internally
app.use('/api/v1/admin', adminRoutes);

// 404 for anything unmatched
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`TFNN backend listening on port ${PORT}`);
});

module.exports = app;
