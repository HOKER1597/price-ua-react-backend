const express = require('express');
const { pool } = require('../config');
const { asyncHandler } = require('../middleware');

const router = express.Router();

/**
 * GET /products - Get products with filtering
 */
router.get('/', asyncHandler(async (req, res) => {
  console.log('Отримання списку товарів:', req.query);

  const {
    page = 1,
    limit = 'all',
    search,
    category,
    brands,
    priceFrom,
    priceTo,
    priceRanges,
    volumes,
    types,
    random,
    hasRating,
  } = req.query;

  const offset = limit !== 'all' ? (parseInt(page) - 1) * parseInt(limit) : 0;

  let query = `
    SELECT p.id, p.name, p.volume, p.type, p.rating, p.views, p.code,
           c.name_ua AS category_name, c.name_en AS category_id, b.name AS brand_name,
           pd.description, pd.composition, pd.usage, pd.description_full,
           pf.brand AS feature_brand, pf.country, pf.type AS feature_type,
           pf.class, pf.category AS feature_category, pf.purpose, pf.gender, pf.active_ingredients,
           array_agg(DISTINCT pi.image_url) FILTER (WHERE pi.image_url IS NOT NULL) AS images,
           (SELECT json_agg(json_build_object(
             'store_id', sp.store_id,
             'name', s.name,
             'price', sp.price,
             'logo', s.logo,
             'delivery', 'по Києву',
             'link', sp.link
           )) FILTER (WHERE sp.id IS NOT NULL)
            FROM store_prices sp
            JOIN stores s ON sp.store_id = s.id
            WHERE sp.product_id = p.id) AS store_prices
    FROM products p
    JOIN categories c ON p.category_id = c.id
    JOIN brands b ON p.brand_id = b.id
    LEFT JOIN product_details pd ON p.id = pd.product_id
    LEFT JOIN product_features pf ON p.id = pf.product_id
    LEFT JOIN product_images pi ON p.id = pi.product_id
  `;

  const conditions = [];
  const values = [];

  if (search) {
    conditions.push(`p.name ILIKE $${values.length + 1}`);
    values.push(`%${search}%`);
  }

  if (category) {
    const categories = category.split(',');
    conditions.push(`c.name_en = ANY($${values.length + 1})`);
    values.push(categories);
  }

  if (brands) {
    const brandList = brands.split(',');
    conditions.push(`b.name = ANY($${values.length + 1})`);
    values.push(brandList);
  }

  if (priceFrom && priceTo) {
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM store_prices sp2
        WHERE sp2.product_id = p.id
        AND sp2.price BETWEEN $${values.length + 1} AND $${values.length + 2}
      )
    `);
    values.push(parseFloat(priceFrom), parseFloat(priceTo));
  }

  if (volumes) {
    const volumeList = volumes.split(',');
    conditions.push(`p.volume = ANY($${values.length + 1})`);
    values.push(volumeList);
  }

  if (types) {
    const typeList = types.split(',');
    conditions.push(`p.type = ANY($${values.length + 1})`);
    values.push(typeList);
  }

  if (hasRating === 'true') {
    conditions.push('p.rating > 0');
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ` GROUP BY p.id, c.name_ua, c.name_en, b.name, pd.description, pd.composition, pd.usage, pd.description_full,
             pf.brand, pf.country, pf.type, pf.class, pf.category, pf.purpose, pf.gender, pf.active_ingredients`;

  if (random === 'true') {
    query += ' ORDER BY RANDOM()';
  } else {
    query += ' ORDER BY p.id DESC';
  }

  const countValues = [...values];

  if (limit !== 'all') {
    query += ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
    values.push(parseInt(limit), offset);
  }

  const result = await pool.query(query, values);

  // Get total count
  let countQuery = `
    SELECT COUNT(DISTINCT p.id)
    FROM products p
    JOIN categories c ON p.category_id = c.id
    JOIN brands b ON p.brand_id = b.id
  `;

  if (conditions.length > 0) {
    countQuery += ' WHERE ' + conditions.join(' AND ');
  }

  const countResult = await pool.query(countQuery, countValues);
  const total = parseInt(countResult.rows[0].count);

  // Format products
  const products = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    volume: row.volume,
    type: row.type,
    rating: row.rating,
    views: row.views,
    code: row.code,
    category_id: row.category_id,
    category_name: row.category_name,
    brand_name: row.brand_name,
    description: row.description,
    description_full: row.description_full,
    composition: row.composition,
    usage: row.usage,
    images: row.images || [],
    store_prices: row.store_prices || [],
    features: {
      brand: row.feature_brand,
      country: row.country,
      type: row.feature_type,
      class: row.class,
      category: row.feature_category,
      purpose: row.purpose,
      gender: row.gender,
      active_ingredients: row.active_ingredients,
    },
  }));

  console.log('Товари отримано:', { count: products.length, total });
  res.json({ products, total, page: parseInt(page), limit: limit === 'all' ? total : parseInt(limit) });
}));

/**
 * GET /products/:productId - Get single product
 */
router.get('/:productId', asyncHandler(async (req, res) => {
  const { productId } = req.params;
  console.log('Отримання товару:', { productId });

  const query = `
    SELECT p.id, p.name, p.volume, p.type, p.rating, p.views, p.code,
           c.name_ua AS category_name, c.name_en AS category_id, b.name AS brand_name,
           pd.description, pd.composition, pd.usage, pd.description_full,
           pf.brand AS feature_brand, pf.country, pf.type AS feature_type,
           pf.class, pf.category AS feature_category, pf.purpose, pf.gender, pf.active_ingredients,
           array_agg(DISTINCT pi.image_url) FILTER (WHERE pi.image_url IS NOT NULL) AS images,
           (SELECT json_agg(json_build_object(
             'store_id', sp.store_id,
             'name', s.name,
             'price', sp.price,
             'logo', s.logo,
             'delivery', 'по Києву',
             'link', sp.link
           )) FILTER (WHERE sp.id IS NOT NULL)
            FROM store_prices sp
            JOIN stores s ON sp.store_id = s.id
            WHERE sp.product_id = p.id) AS store_prices
    FROM products p
    JOIN categories c ON p.category_id = c.id
    JOIN brands b ON p.brand_id = b.id
    LEFT JOIN product_details pd ON p.id = pd.product_id
    LEFT JOIN product_features pf ON p.id = pf.product_id
    LEFT JOIN product_images pi ON p.id = pi.product_id
    WHERE p.id = $1
    GROUP BY p.id, c.name_ua, c.name_en, b.name, pd.description, pd.composition, pd.usage, pd.description_full,
             pf.brand, pf.country, pf.type, pf.class, pf.category, pf.purpose, pf.gender, pf.active_ingredients
  `;

  const result = await pool.query(query, [productId]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Товар не знайдено' });
  }

  const row = result.rows[0];
  const product = {
    id: row.id,
    name: row.name,
    volume: row.volume,
    type: row.type,
    rating: row.rating,
    views: row.views,
    code: row.code,
    category_id: row.category_id,
    category_name: row.category_name,
    brand_name: row.brand_name,
    description: row.description,
    description_full: row.description_full,
    composition: row.composition,
    usage: row.usage,
    images: row.images || [],
    store_prices: row.store_prices || [],
    features: {
      brand: row.feature_brand,
      country: row.country,
      type: row.feature_type,
      class: row.class,
      category: row.feature_category,
      purpose: row.purpose,
      gender: row.gender,
      active_ingredients: row.active_ingredients,
    },
  };

  console.log('Товар отримано:', { productId: product.id });
  res.json(product);
}));

module.exports = router;
