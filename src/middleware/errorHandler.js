/**
 * Global error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    code: err.code,
  });

  // Handle Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Файл занадто великий (максимум 25MB)' });
  }

  if (err.message === 'Дозволено лише зображення') {
    return res.status(400).json({ error: err.message });
  }

  // Handle PostgreSQL unique constraint violation
  if (err.code === '23505') {
    return res.status(400).json({ error: 'Запис з такими даними вже існує' });
  }

  // Handle PostgreSQL foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Пов\'язаний запис не існує' });
  }

  // Default error
  res.status(err.status || 500).json({
    error: err.message || 'Помилка сервера',
  });
};

/**
 * Async handler wrapper
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  errorHandler,
  asyncHandler,
};
