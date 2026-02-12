const jwt = require('jsonwebtoken');
const { pool, JWT_SECRET } = require('../config');

/**
 * Middleware to authenticate JWT token
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    console.log('Токен відсутній');
    return res.status(401).json({ error: 'Токен відсутній' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('Недійсний токен:', err.message);
      return res.status(403).json({ error: 'Недійсний токен' });
    }
    req.user = user;
    next();
  });
};

/**
 * Middleware to check if user is admin
 */
const isAdmin = async (req, res, next) => {
  try {
    console.log('Перевірка адмінських прав для користувача:', req.user.id);
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);

    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      console.log('Доступ заборонено: користувач не адмін');
      return res.status(403).json({ error: 'Доступ дозволено лише адміністраторам' });
    }

    console.log('Адмінські права підтверджено');
    next();
  } catch (err) {
    console.error('Помилка перевірки адмінських прав:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
};

/**
 * Optional authentication - doesn't fail if no token
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      req.user = null;
    } else {
      req.user = user;
    }
    next();
  });
};

module.exports = {
  authenticateToken,
  isAdmin,
  optionalAuth,
};
