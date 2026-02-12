const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║      CosmetickUA Backend API          ║
  ╠═══════════════════════════════════════╣
  ║  Server running on port ${PORT}          ║
  ║  Environment: ${process.env.NODE_ENV || 'development'}       ║
  ╚═══════════════════════════════════════╝
  `);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
