const express = require('express');
const { pool } = require('../config');
const { authenticateToken, asyncHandler } = require('../middleware');

const router = express.Router();

/**
 * GET /saved-products - Get all saved products for user
 */
router.get('/', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  console.log('Отримання збережених товарів для користувача:', userId);

  const result = await pool.query(
    `SELECT product_id, saved_category_id FROM saved_products WHERE user_id = $1`,
    [userId]
  );

  const savedProducts = result.rows.map((row) => ({
    product_id: row.product_id,
    saved_category_id: row.saved_category_id,
  }));

  console.log('Збережені товари отримано:', savedProducts.length);
  res.json({ savedProducts });
}));

/**
 * GET /saved-products/:productId - Check if product is saved
 */
router.get('/:productId', authenticateToken, asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const userId = req.user.id;

  console.log('Перевірка збереженого товару:', { productId, userId });

  const result = await pool.query(
    `SELECT id FROM saved_products WHERE user_id = $1 AND product_id = $2`,
    [userId, productId]
  );

  res.json({ isSaved: result.rows.length > 0 });
}));

/**
 * POST /saved-products - Add product to wishlist
 */
router.post('/', authenticateToken, asyncHandler(async (req, res) => {
  const { productId } = req.body;
  const userId = req.user.id;

  console.log('Додавання товару до збережених:', { productId, userId });

  const result = await pool.query(
    `INSERT INTO saved_products (user_id, product_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, productId]
  );

  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Товар уже додано до бажаного' });
  }

  res.json({ message: 'Товар додано до бажаного' });
}));

/**
 * POST /saved-products/bulk - Bulk check saved products
 */
router.post('/bulk', authenticateToken, asyncHandler(async (req, res) => {
  const { productIds } = req.body;
  const userId = req.user.id;

  console.log('Масова перевірка збережених товарів:', { productIds, userId });

  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.json({ savedProductIds: [] });
  }

  const result = await pool.query(
    `SELECT product_id FROM saved_products WHERE user_id = $1 AND product_id = ANY($2)`,
    [userId, productIds]
  );

  const savedProductIds = result.rows.map((row) => row.product_id);
  res.json({ savedProductIds });
}));

/**
 * PATCH /saved-products/:productId - Update saved product category
 */
router.patch('/:productId', authenticateToken, asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const { saved_category_id } = req.body;
  const userId = req.user.id;

  console.log('Оновлення категорії збереженого товару:', { productId, saved_category_id, userId });

  if (saved_category_id) {
    const categoryCheck = await pool.query(
      `SELECT id FROM saved_categories WHERE id = $1 AND user_id = $2`,
      [saved_category_id, userId]
    );

    if (categoryCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Категорія не належить користувачу' });
    }
  }

  const result = await pool.query(
    `UPDATE saved_products
     SET saved_category_id = $1
     WHERE product_id = $2 AND user_id = $3
     RETURNING product_id, saved_category_id`,
    [saved_category_id || null, productId, userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Товар не знайдено у бажаному' });
  }

  res.json({ message: 'Категорію товару оновлено', saved_category_id: result.rows[0].saved_category_id });
}));

/**
 * DELETE /saved-products/:productId - Remove product from wishlist
 */
router.delete('/:productId', authenticateToken, asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const userId = req.user.id;

  console.log('Видалення товару зі збережених:', { productId, userId });

  const result = await pool.query(
    `DELETE FROM saved_products WHERE user_id = $1 AND product_id = $2
     RETURNING id`,
    [userId, productId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Товар не знайдено у бажаному' });
  }

  res.json({ message: 'Товар видалено з бажаного' });
}));

// === SAVED CATEGORIES ===

/**
 * GET /categories - Get user's saved categories
 */
router.get('/categories/list', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  console.log('Отримання збережених категорій для користувача:', userId);

  const result = await pool.query(
    `SELECT id, name, created_at
     FROM saved_categories
     WHERE user_id = $1 AND name IS NOT NULL AND TRIM(name) != ''
     ORDER BY created_at ASC`,
    [userId]
  );

  res.json(result.rows);
}));

/**
 * POST /categories - Create saved category
 */
router.post('/categories', authenticateToken, asyncHandler(async (req, res) => {
  const { name } = req.body;
  const userId = req.user.id;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Назва категорії обов\'язкова' });
  }

  const result = await pool.query(
    `INSERT INTO saved_categories (user_id, name)
     VALUES ($1, $2)
     RETURNING id, name, created_at`,
    [userId, name.trim()]
  );

  res.json(result.rows[0]);
}));

/**
 * PUT /categories/:id - Update saved category
 */
router.put('/categories/:id', authenticateToken, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const userId = req.user.id;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Назва категорії обов\'язкова' });
  }

  const result = await pool.query(
    `UPDATE saved_categories
     SET name = $1
     WHERE id = $2 AND user_id = $3
     RETURNING id, name, created_at`,
    [name.trim(), id, userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Категорію не знайдено або ви не маєте доступу' });
  }

  res.json(result.rows[0]);
}));

/**
 * DELETE /categories/:id - Delete saved category
 */
router.delete('/categories/:id', authenticateToken, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const result = await pool.query(
    `DELETE FROM saved_categories
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [id, userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Категорію не знайдено або ви не маєте доступу' });
  }

  res.json({ message: 'Категорію видалено' });
}));

module.exports = router;
