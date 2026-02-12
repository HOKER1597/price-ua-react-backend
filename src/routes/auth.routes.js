const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool, JWT_SECRET } = require('../config');
const { authenticateToken, asyncHandler } = require('../middleware');

const router = express.Router();

/**
 * POST /register - Register new user
 */
router.post('/register', asyncHandler(async (req, res) => {
  const { nickname, email, password, photo, gender, birth_date } = req.body;

  console.log('Реєстрація користувача:', { nickname, email });

  if (!nickname || !email || !password) {
    return res.status(400).json({ error: 'Нікнейм, пошта та пароль обов\'язкові' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const result = await pool.query(
    `INSERT INTO users (nickname, email, password, photo, gender, birth_date, is_admin)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, nickname, email, photo, gender, birth_date, is_admin`,
    [nickname, email, hashedPassword, photo || null, gender || null, birth_date || null, false]
  );

  const user = result.rows[0];
  console.log('Користувача зареєстровано:', { userId: user.id });

  const token = jwt.sign(
    { id: user.id, nickname: user.nickname, is_admin: user.is_admin },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  res.json({ token, user });
}));

/**
 * POST /login - Login user
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;

  console.log('Вхід користувача:', { identifier });

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Потрібні ідентифікатор і пароль' });
  }

  const result = await pool.query(
    `SELECT id, nickname, email, password, photo, gender, birth_date, is_admin
     FROM users WHERE nickname = $1 OR email = $1`,
    [identifier]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Неправильний нікнейм/пошта або пароль' });
  }

  const user = result.rows[0];
  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    return res.status(401).json({ error: 'Неправильний нікнейм/пошта або пароль' });
  }

  console.log('Користувач увійшов:', { userId: user.id });

  const token = jwt.sign(
    { id: user.id, nickname: user.nickname, is_admin: user.is_admin },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Remove password from response
  delete user.password;
  res.json({ token, user });
}));

/**
 * GET /profile - Get current user profile
 */
router.get('/profile', authenticateToken, asyncHandler(async (req, res) => {
  console.log('Отримання профілю користувача:', req.user.id);

  const result = await pool.query(
    'SELECT id, nickname, email, photo, gender, birth_date, is_admin FROM users WHERE id = $1',
    [req.user.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Користувача не знайдено' });
  }

  res.json(result.rows[0]);
}));

/**
 * POST /update-user - Update user profile
 */
router.post('/update-user', authenticateToken, asyncHandler(async (req, res) => {
  const { email, gender, birth_date } = req.body;
  const userId = req.user.id;

  console.log('Оновлення даних користувача:', { userId, email, gender, birth_date });

  const result = await pool.query(
    `UPDATE users
     SET email = $1, gender = $2, birth_date = $3
     WHERE id = $4
     RETURNING id, nickname, email, photo, gender, birth_date, is_admin`,
    [email || null, gender || null, birth_date || null, userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Користувача не знайдено' });
  }

  res.json({ user: result.rows[0] });
}));

module.exports = router;
