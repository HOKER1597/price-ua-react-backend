require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const routes = require('./routes');
const { errorHandler } = require('./middleware');

const app = express();

// Middleware
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/', routes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Маршрут не знайдено' });
});

// Global error handler
app.use(errorHandler);

module.exports = app;
