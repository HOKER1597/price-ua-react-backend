const express = require('express');
const { pool } = require('../config');
const { authenticateToken, asyncHandler } = require('../middleware');

const router = express.Router();

// === CITIES ===

/**
 * GET /cities - Get all cities
 */
router.get('/cities', asyncHandler(async (req, res) => {
  console.log('Отримання списку міст');
  const result = await pool.query('SELECT id, name_ua, name_en, latitude, longitude FROM cities ORDER BY name_ua ASC');
  res.json(result.rows);
}));

// === STORES ===

/**
 * GET /stores - Get all stores
 */
router.get('/stores', asyncHandler(async (req, res) => {
  console.log('Отримання списку магазинів');
  const result = await pool.query('SELECT id, name, logo, years_with_us, link FROM stores ORDER BY name ASC');
  res.json(result.rows);
}));

/**
 * GET /stores/:storeId - Get single store
 */
router.get('/stores/:storeId', authenticateToken, asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  const result = await pool.query('SELECT id, name, logo, years_with_us, link FROM stores WHERE id = $1', [storeId]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Магазин не знайдено' });
  }

  res.json(result.rows[0]);
}));

// === BRANDS ===

/**
 * GET /brands - Get all brands
 */
router.get('/brands', asyncHandler(async (req, res) => {
  console.log('Отримання списку брендів');
  const result = await pool.query('SELECT id, name FROM brands ORDER BY name ASC');
  res.json(result.rows);
}));

/**
 * GET /brands/:brandId - Get single brand
 */
router.get('/brands/:brandId', authenticateToken, asyncHandler(async (req, res) => {
  const { brandId } = req.params;
  const result = await pool.query('SELECT id, name FROM brands WHERE id = $1', [brandId]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Бренд не знайдено' });
  }

  res.json(result.rows[0]);
}));

// === CATEGORIES ===

/**
 * GET /categories/public - Get all product categories
 */
router.get('/categories/public', asyncHandler(async (req, res) => {
  console.log('Отримання публічних категорій');
  const result = await pool.query('SELECT id, name_ua, name_en, parent_id FROM categories ORDER BY name_ua ASC');
  res.json(result.rows);
}));

// === STORE LOCATIONS ===

/**
 * GET /store-locations - Get store locations
 */
router.get('/store-locations', asyncHandler(async (req, res) => {
  const { productId } = req.query;
  console.log('Отримання локацій магазинів:', { productId });

  let query = `
    SELECT sl.id, sl.store_id, s.name AS store_name, sl.city_id, c.name_ua AS city_name,
           sl.address, sl.latitude, sl.longitude, sl.hours_mon_fri, sl.hours_sat, sl.hours_sun
    FROM store_locations sl
    JOIN stores s ON sl.store_id = s.id
    JOIN cities c ON sl.city_id = c.id
  `;
  const values = [];

  if (productId) {
    query += `
      WHERE sl.store_id IN (
        SELECT DISTINCT store_id FROM store_prices WHERE product_id = $1
      )
    `;
    values.push(productId);
  }

  query += ' ORDER BY s.name ASC, c.name_ua ASC';

  const result = await pool.query(query, values);
  res.json(result.rows);
}));

/**
 * GET /store-locations/:locationId - Get single store location
 */
router.get('/store-locations/:locationId', asyncHandler(async (req, res) => {
  const { locationId } = req.params;

  const result = await pool.query(
    `SELECT sl.id, sl.store_id, s.name AS store_name, sl.city_id, c.name_ua AS city_name,
            sl.address, sl.latitude, sl.longitude, sl.hours_mon_fri, sl.hours_sat, sl.hours_sun
     FROM store_locations sl
     JOIN stores s ON sl.store_id = s.id
     JOIN cities c ON sl.city_id = c.id
     WHERE sl.id = $1`,
    [locationId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Локацію не знайдено' });
  }

  res.json(result.rows[0]);
}));

// === FILTER OPTIONS ===

/**
 * GET /filter-options - Get available filter options
 */
router.get('/filter-options', asyncHandler(async (req, res) => {
  const { category } = req.query;
  console.log('Отримання опцій фільтрів:', { category });

  let baseCondition = '';
  const values = [];

  if (category) {
    const categories = category.split(',');
    baseCondition = 'WHERE c.name_en = ANY($1)';
    values.push(categories);
  }

  const [brandsResult, volumesResult, typesResult, pricesResult] = await Promise.all([
    pool.query(`
      SELECT DISTINCT b.name
      FROM products p
      JOIN brands b ON p.brand_id = b.id
      JOIN categories c ON p.category_id = c.id
      ${baseCondition}
      ORDER BY b.name ASC
    `, values),
    pool.query(`
      SELECT DISTINCT p.volume
      FROM products p
      JOIN categories c ON p.category_id = c.id
      ${baseCondition}
      ORDER BY p.volume ASC
    `, values),
    pool.query(`
      SELECT DISTINCT p.type
      FROM products p
      JOIN categories c ON p.category_id = c.id
      ${baseCondition}
      ORDER BY p.type ASC
    `, values),
    pool.query(`
      SELECT MIN(sp.price) as min_price, MAX(sp.price) as max_price
      FROM store_prices sp
      JOIN products p ON sp.product_id = p.id
      JOIN categories c ON p.category_id = c.id
      ${baseCondition}
    `, values),
  ]);

  res.json({
    brands: brandsResult.rows.map((r) => r.name).filter(Boolean),
    volumes: volumesResult.rows.map((r) => r.volume).filter(Boolean),
    types: typesResult.rows.map((r) => r.type).filter(Boolean),
    priceRange: {
      min: pricesResult.rows[0]?.min_price || 0,
      max: pricesResult.rows[0]?.max_price || 10000,
    },
  });
}));

module.exports = router;
