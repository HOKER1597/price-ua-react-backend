const express = require('express');
const { pool, cloudinary, upload } = require('../config');
const { authenticateToken, isAdmin, asyncHandler } = require('../middleware');

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken, isAdmin);

// === PRODUCT MANAGEMENT ===

/**
 * POST /admin/product - Create product
 */
router.post('/product', upload.array('images', 10), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('Створення товару:', { body: req.body, files: req.files?.length || 0 });

    await client.query('BEGIN');

    const {
      category_id,
      brand_id,
      name,
      volume,
      code,
      description,
      description_full,
      composition,
      usage,
      features: featuresJson,
      store_prices: storePricesJson,
    } = req.body;

    const features = featuresJson ? JSON.parse(featuresJson) : {};
    const store_prices = storePricesJson ? JSON.parse(storePricesJson) : [];

    if (!category_id || !brand_id || !name) {
      throw new Error('Категорія, бренд і назва є обов\'язковими');
    }

    // Validate category and brand
    const [categoryCheck, brandCheck] = await Promise.all([
      client.query('SELECT id FROM categories WHERE id = $1', [category_id]),
      client.query('SELECT id FROM brands WHERE id = $1', [brand_id]),
    ]);

    if (categoryCheck.rows.length === 0) {
      throw new Error(`Категорія з ID ${category_id} не існує`);
    }
    if (brandCheck.rows.length === 0) {
      throw new Error(`Бренд з ID ${brand_id} не існує`);
    }

    // Create product
    const productResult = await client.query(
      `INSERT INTO products (category_id, brand_id, name, volume, type, rating, views, code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [category_id, brand_id, name, volume || null, features.type || null, 0, 0, code || null]
    );
    const productId = productResult.rows[0].id;

    // Upload images
    const imageUrls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream({ folder: 'products' }, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }).end(file.buffer);
        });
        imageUrls.push(result.secure_url);
        await client.query(
          'INSERT INTO product_images (product_id, image_url) VALUES ($1, $2)',
          [productId, result.secure_url]
        );
      }
    }

    // Save product details
    await client.query(
      `INSERT INTO product_details (product_id, description, composition, usage, description_full)
       VALUES ($1, $2, $3, $4, $5)`,
      [productId, description || null, composition || null, usage || null, description_full || null]
    );

    // Save features
    if (Object.keys(features).length > 0) {
      const featureFields = ['brand', 'country', 'type', 'class', 'category', 'purpose', 'gender', 'active_ingredients'];
      const featureValues = featureFields.map((f) => features[f] || null);
      await client.query(
        `INSERT INTO product_features (product_id, brand, country, type, class, category, purpose, gender, active_ingredients)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [productId, ...featureValues]
      );
    }

    // Save store prices
    for (const store of store_prices) {
      if (!store.store_id || !store.price || isNaN(parseFloat(store.price))) continue;

      const storeCheck = await client.query('SELECT id FROM stores WHERE id = $1', [store.store_id]);
      if (storeCheck.rows.length === 0) {
        throw new Error(`Магазин з ID ${store.store_id} не існує`);
      }

      await client.query(
        'INSERT INTO store_prices (product_id, store_id, price, link) VALUES ($1, $2, $3, $4)',
        [productId, store.store_id, parseFloat(store.price), store.link || null]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Товар успішно створено', productId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * PUT /admin/product/:productId - Update product
 */
router.put('/product/:productId', upload.array('images', 10), asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const client = await pool.connect();
  try {
    console.log('Оновлення товару:', { productId });

    await client.query('BEGIN');

    const {
      category_id,
      brand_id,
      name,
      volume,
      code,
      description,
      description_full,
      composition,
      usage,
      features: featuresJson,
      store_prices: storePricesJson,
      existing_images: existingImagesJson,
    } = req.body;

    const features = featuresJson ? JSON.parse(featuresJson) : {};
    const store_prices = storePricesJson ? JSON.parse(storePricesJson) : [];
    let existing_images = existingImagesJson ? JSON.parse(existingImagesJson) : [];
    if (!Array.isArray(existing_images)) existing_images = [existing_images];

    if (!category_id || !brand_id || !name) {
      throw new Error('Категорія, бренд і назва є обов\'язковими');
    }

    // Validate
    const productCheck = await client.query('SELECT id FROM products WHERE id = $1', [productId]);
    if (productCheck.rows.length === 0) {
      throw new Error(`Товар з ID ${productId} не існує`);
    }

    // Update product
    await client.query(
      `UPDATE products SET category_id = $1, brand_id = $2, name = $3, volume = $4, type = $5, code = $6
       WHERE id = $7`,
      [category_id, brand_id, name, volume || null, features.type || null, code || null, productId]
    );

    // Handle images
    await client.query('DELETE FROM product_images WHERE product_id = $1', [productId]);

    const filteredExisting = existing_images.filter((url) => url && !url.includes('placeholder.webp'));
    for (const url of filteredExisting) {
      await client.query('INSERT INTO product_images (product_id, image_url) VALUES ($1, $2)', [productId, url]);
    }

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream({ folder: 'products' }, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }).end(file.buffer);
        });
        await client.query('INSERT INTO product_images (product_id, image_url) VALUES ($1, $2)', [productId, result.secure_url]);
      }
    }

    // Update details
    await client.query(
      `UPDATE product_details SET description = $1, composition = $2, usage = $3, description_full = $4
       WHERE product_id = $5`,
      [description || null, composition || null, usage || null, description_full || null, productId]
    );

    // Update features
    await client.query('DELETE FROM product_features WHERE product_id = $1', [productId]);
    if (Object.keys(features).length > 0) {
      const featureFields = ['brand', 'country', 'type', 'class', 'category', 'purpose', 'gender', 'active_ingredients'];
      const featureValues = featureFields.map((f) => features[f] || null);
      await client.query(
        `INSERT INTO product_features (product_id, brand, country, type, class, category, purpose, gender, active_ingredients)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [productId, ...featureValues]
      );
    }

    // Update store prices
    await client.query('DELETE FROM store_prices WHERE product_id = $1', [productId]);
    for (const store of store_prices) {
      if (!store.store_id || !store.price || isNaN(parseFloat(store.price))) continue;
      await client.query(
        'INSERT INTO store_prices (product_id, store_id, price, link) VALUES ($1, $2, $3, $4)',
        [productId, store.store_id, parseFloat(store.price), store.link || null]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Товар успішно оновлено', productId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * DELETE /admin/product/:productId - Delete product
 */
router.delete('/product/:productId', asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tables = ['product_images', 'store_prices', 'product_details', 'product_features', 'saved_products'];
    for (const table of tables) {
      await client.query(`DELETE FROM ${table} WHERE product_id = $1`, [productId]);
    }
    await client.query('DELETE FROM products WHERE id = $1', [productId]);

    await client.query('COMMIT');
    res.json({ message: 'Товар успішно видалено' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// === BRAND MANAGEMENT ===

/**
 * POST /admin/brand - Create brand
 */
router.post('/brand', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) throw new Error('Назва бренду є обов\'язковою');

  const result = await pool.query(
    'INSERT INTO brands (name) VALUES ($1) RETURNING id, name',
    [name.trim()]
  );
  res.json({ message: 'Бренд успішно створено', brand: result.rows[0] });
}));

/**
 * PUT /admin/brand/:brandId - Update brand
 */
router.put('/brand/:brandId', asyncHandler(async (req, res) => {
  const { brandId } = req.params;
  const { name } = req.body;
  if (!name?.trim()) throw new Error('Назва бренду є обов\'язковою');

  const result = await pool.query(
    'UPDATE brands SET name = $1 WHERE id = $2 RETURNING id, name',
    [name.trim(), brandId]
  );
  if (result.rows.length === 0) throw new Error(`Бренд з ID ${brandId} не існує`);

  res.json({ message: 'Бренд успішно оновлено', brand: result.rows[0] });
}));

/**
 * DELETE /admin/brand/:brandId - Delete brand
 */
router.delete('/brand/:brandId', asyncHandler(async (req, res) => {
  const { brandId } = req.params;

  const productCheck = await pool.query('SELECT id FROM products WHERE brand_id = $1 LIMIT 1', [brandId]);
  if (productCheck.rows.length > 0) {
    throw new Error('Неможливо видалити бренд, оскільки він використовується в продуктах');
  }

  await pool.query('DELETE FROM brands WHERE id = $1', [brandId]);
  res.json({ message: 'Бренд успішно видалено' });
}));

// === STORE MANAGEMENT ===

/**
 * POST /admin/store - Create store
 */
router.post('/store', upload.single('logo'), asyncHandler(async (req, res) => {
  const { name, years_with_us, link } = req.body;
  if (!name?.trim()) throw new Error('Назва магазину є обов\'язковою');

  let logoUrl = null;
  if (req.file) {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder: 'stores' }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }).end(req.file.buffer);
    });
    logoUrl = result.secure_url;
  }

  const result = await pool.query(
    'INSERT INTO stores (name, logo, years_with_us, link) VALUES ($1, $2, $3, $4) RETURNING *',
    [name.trim(), logoUrl, years_with_us ? parseInt(years_with_us) : null, link || null]
  );
  res.json({ message: 'Магазин успішно створено', store: result.rows[0] });
}));

/**
 * PUT /admin/store/:storeId - Update store
 */
router.put('/store/:storeId', upload.single('logo'), asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  const { name, years_with_us, link } = req.body;
  if (!name?.trim()) throw new Error('Назва магазину є обов\'язковою');

  const storeCheck = await pool.query('SELECT logo FROM stores WHERE id = $1', [storeId]);
  if (storeCheck.rows.length === 0) throw new Error(`Магазин з ID ${storeId} не існує`);

  let logoUrl = storeCheck.rows[0].logo;
  if (req.file) {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder: 'stores' }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }).end(req.file.buffer);
    });
    logoUrl = result.secure_url;
  }

  const result = await pool.query(
    'UPDATE stores SET name = $1, logo = $2, years_with_us = $3, link = $4 WHERE id = $5 RETURNING *',
    [name.trim(), logoUrl, years_with_us ? parseInt(years_with_us) : null, link || null, storeId]
  );
  res.json({ message: 'Магазин успішно оновлено', store: result.rows[0] });
}));

/**
 * DELETE /admin/store/:storeId - Delete store
 */
router.delete('/store/:storeId', asyncHandler(async (req, res) => {
  const { storeId } = req.params;

  const priceCheck = await pool.query('SELECT id FROM store_prices WHERE store_id = $1 LIMIT 1', [storeId]);
  if (priceCheck.rows.length > 0) {
    throw new Error('Неможливо видалити магазин, оскільки він використовується в цінах продуктів');
  }

  const storeCheck = await pool.query('SELECT logo FROM stores WHERE id = $1', [storeId]);
  if (storeCheck.rows[0]?.logo) {
    const publicId = storeCheck.rows[0].logo.split('/').pop().split('.')[0];
    await cloudinary.uploader.destroy(`stores/${publicId}`);
  }

  await pool.query('DELETE FROM stores WHERE id = $1', [storeId]);
  res.json({ message: 'Магазин успішно видалено' });
}));

// === STORE LOCATION MANAGEMENT ===

/**
 * POST /admin/store-location - Create store location
 */
router.post('/store-location', asyncHandler(async (req, res) => {
  const { store_id, city_id, address, latitude, longitude, hours_mon_fri, hours_sat, hours_sun } = req.body;

  if (!store_id || !city_id || !address || !latitude || !longitude) {
    throw new Error('Магазин, місто, адреса і координати є обов\'язковими');
  }

  const result = await pool.query(
    `INSERT INTO store_locations (store_id, city_id, address, latitude, longitude, hours_mon_fri, hours_sat, hours_sun)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [store_id, city_id, address, latitude, longitude, hours_mon_fri || null, hours_sat || null, hours_sun || null]
  );

  res.json({ message: 'Локацію створено', location: result.rows[0] });
}));

/**
 * PUT /admin/store-location/:locationId - Update store location
 */
router.put('/store-location/:locationId', asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  const { store_id, city_id, address, latitude, longitude, hours_mon_fri, hours_sat, hours_sun } = req.body;

  const result = await pool.query(
    `UPDATE store_locations
     SET store_id = $1, city_id = $2, address = $3, latitude = $4, longitude = $5,
         hours_mon_fri = $6, hours_sat = $7, hours_sun = $8
     WHERE id = $9
     RETURNING *`,
    [store_id, city_id, address, latitude, longitude, hours_mon_fri, hours_sat, hours_sun, locationId]
  );

  if (result.rows.length === 0) throw new Error(`Локацію з ID ${locationId} не знайдено`);

  res.json({ message: 'Локацію оновлено', location: result.rows[0] });
}));

/**
 * DELETE /admin/store-location/:locationId - Delete store location
 */
router.delete('/store-location/:locationId', asyncHandler(async (req, res) => {
  const { locationId } = req.params;

  await pool.query('DELETE FROM store_locations WHERE id = $1', [locationId]);
  res.json({ message: 'Локацію видалено' });
}));

module.exports = router;
