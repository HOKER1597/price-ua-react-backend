require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Дозволено лише зображення'), false);
    }
    cb(null, true);
  },
});

const JWT_SECRET = process.env.JWT_SECRET || 'fc0432fb054d94da265cd6e565721b49f66d7a447cdaa76fe30d0214bf20b24220179d3fcd5eea298bedbead28c2636f3ca65baf668cd89ad679ef99b36f43db';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres.vycccrkohgfaqpqeymrn:vlados1597@aws-0-eu-north-1.pooler.supabase.com:5432/cosmetick_ua',
  ssl: { rejectUnauthorized: false },
  max: 20,
  connectionTimeoutMillis: 10000,
});

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

app.get('/cities', async (req, res) => {
  try {
    console.log('Отримання списку міст');
    const result = await pool.query('SELECT id, name_ua, name_en, latitude, longitude FROM cities ORDER BY name_ua ASC');
    console.log('Міста отримано:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('Помилка отримання міст:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/profile', authenticateToken, async (req, res) => {
  try {
    console.log('Отримання профілю користувача:', req.user.id);
    const result = await pool.query(
      'SELECT id, nickname, email, photo, gender, birth_date, is_admin FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      console.log('Користувача не знайдено:', req.user.id);
      return res.status(404).json({ error: 'Користувача не знайдено' });
    }
    console.log('Профіль отримано:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Помилка отримання профілю:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/admin/product', authenticateToken, isAdmin, upload.array('images', 10), async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('Початок створення товару:', {
      body: req.body,
      files: req.files ? req.files.length : 0,
    });

    await client.query('BEGIN');
    console.log('Транзакцію розпочато');

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

    let features = {};
    let store_prices = [];
    try {
      features = featuresJson ? JSON.parse(featuresJson) : {};
      store_prices = storePricesJson ? JSON.parse(storePricesJson) : [];
    } catch (err) {
      console.error('Помилка парсингу JSON:', { featuresJson, storePricesJson, error: err.message });
      throw new Error('Невалідний формат features або store_prices');
    }

    console.log('Дані з форми:', {
      category_id,
      brand_id,
      name,
      volume,
      code,
      description,
      description_full,
      composition,
      usage,
      features,
      store_prices,
    });

    if (!category_id || !brand_id || !name) {
      console.log('Відсутні обов’язкові поля:', { category_id, brand_id, name });
      throw new Error('Категорія, бренд і назва є обов’язковими');
    }

    const categoryCheck = await client.query('SELECT id FROM categories WHERE id = $1', [category_id]);
    if (categoryCheck.rows.length === 0) {
      console.log('Категорія не існує:', { category_id });
      throw new Error(`Категорія з ID ${category_id} не існує`);
    }

    const brandCheck = await client.query('SELECT id FROM brands WHERE id = $1', [brand_id]);
    if (brandCheck.rows.length === 0) {
      console.log('Бренд не існує:', { brand_id });
      throw new Error(`Бренд з ID ${brand_id} не існує`);
    }

    console.log('Категорія та бренд валідні');

    const maxIdResult = await client.query('SELECT MAX(id) FROM products');
    const maxId = maxIdResult.rows[0].max || 0;
    console.log('Максимальний ID у products:', { maxId });

    const seqResult = await client.query(
      "SELECT setval('products_id_seq', COALESCE($1, 0) + 1, false) AS seq_value",
      [maxId]
    );
    const nextId = parseInt(seqResult.rows[0].seq_value);
    console.log('Послідовність products_id_seq синхронізовано:', { nextId });

    const productResult = await client.query(
      `INSERT INTO products (category_id, brand_id, name, volume, type, rating, views, code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        category_id || null,
        brand_id || null,
        name || null,
        volume || null,
        features.type || null,
        0,
        0,
        code || null,
      ]
    );
    const productId = productResult.rows[0].id;
    console.log('Товар створено:', { productId });

    const imageUrls = [];
    if (req.files && req.files.length > 0) {
      console.log('Завантаження зображень у Cloudinary:', { fileCount: req.files.length });
      for (const file of req.files) {
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream({ folder: 'products' }, (error, result) => {
            if (error) {
              console.error('Помилка завантаження зображення:', error);
              reject(error);
            } else {
              console.log('Зображення завантажено:', result.secure_url);
              resolve(result);
            }
          }).end(file.buffer);
        });
        imageUrls.push(result.secure_url);
      }

      for (const imageUrl of imageUrls) {
        await client.query(
          `INSERT INTO product_images (product_id, image_url)
           VALUES ($1, $2)`,
          [productId, imageUrl || null]
        );
      }
      console.log('Зображення збережено в product_images:', imageUrls);
    } else {
      console.log('Зображення відсутні');
    }

    await client.query(
      `INSERT INTO product_details (product_id, description, composition, usage, description_full)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        productId,
        description || null,
        composition || null,
        usage || null,
        description_full || null,
      ]
    );
    console.log('Деталі товару збережено в product_details');

    if (Object.keys(features).length > 0) {
      const featureFields = [
        'brand',
        'country',
        'type',
        'class',
        'category',
        'purpose',
        'gender',
        'active_ingredients',
      ];
      const featureValues = featureFields.map((field) => features[field] || null);
      await client.query(
        `INSERT INTO product_features (product_id, brand, country, type, class, category, purpose, gender, active_ingredients)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [productId, ...featureValues]
      );
      console.log('Характеристики збережено в product_features:', featureValues);
    } else {
      console.log('Характеристики відсутні');
    }

    if (store_prices.length > 0) {
      console.log('Обробка цін магазинів:', store_prices);
      for (const store of store_prices) {
        if (!store.store_id || !store.price || isNaN(parseFloat(store.price))) {
          console.warn('Пропущено невалідну ціну магазину:', store);
          continue;
        }
        const storeCheck = await client.query('SELECT id FROM stores WHERE id = $1', [store.store_id]);
        if (storeCheck.rows.length === 0) {
          console.warn('Магазин не існує:', { store_id: store.store_id });
          throw new Error(`Магазин з ID ${store.store_id} не існує`);
        }
        await client.query(
          `INSERT INTO store_prices (product_id, store_id, price, link)
           VALUES ($1, $2, $3, $4)`,
          [
            productId,
            store.store_id,
            parseFloat(store.price),
            store.link || null,
          ]
        );
        console.log('Ціна магазину збережено:', { store_id: store.store_id, price: store.price });
      }
    } else {
      console.log('Ціни магазинів відсутні');
    }

    await client.query('COMMIT');
    console.log('Транзакцію успішно завершено');
    res.json({ message: 'Товар успішно створено', productId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Помилка створення товару:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      constraint: err.constraint,
      detail: err.detail,
    });
    res.status(500).json({ error: err.message || 'Помилка сервера' });
  } finally {
    client.release();
    console.log('Клієнт бази даних звільнено');
  }
});

app.post('/admin/brand', authenticateToken, isAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name } = req.body;

    if (!name || !name.trim()) {
      throw new Error('Назва бренду є обов’язковою');
    }

    const result = await client.query(
      'INSERT INTO brands (name) VALUES ($1) RETURNING id, name',
      [name.trim()]
    );
    await client.query('COMMIT');
    res.json({ message: 'Бренд успішно створено', brand: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      res.status(400).json({ error: 'Бренд з такою назвою вже існує' });
    } else {
      res.status(500).json({ error: err.message || 'Помилка сервера' });
    }
  } finally {
    client.release();
  }
});

app.put('/admin/brand/:brandId', authenticateToken, isAdmin, async (req, res) => {
  const { brandId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name } = req.body;

    if (!name || !name.trim()) {
      throw new Error('Назва бренду є обов’язковою');
    }

    const brandCheck = await client.query('SELECT id FROM brands WHERE id = $1', [brandId]);
    if (brandCheck.rows.length === 0) {
      throw new Error(`Бренд з ID ${brandId} не існує`);
    }

    const result = await client.query(
      'UPDATE brands SET name = $1 WHERE id = $2 RETURNING id, name',
      [name.trim(), brandId]
    );
    await client.query('COMMIT');
    res.json({ message: 'Бренд успішно оновлено', brand: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      res.status(400).json({ error: 'Бренд з такою назвою вже існує' });
    } else {
      res.status(500).json({ error: err.message || 'Помилка сервера' });
    }
  } finally {
    client.release();
  }
});

app.delete('/admin/brand/:brandId', authenticateToken, isAdmin, async (req, res) => {
  const { brandId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const brandCheck = await client.query('SELECT id FROM brands WHERE id = $1', [brandId]);
    if (brandCheck.rows.length === 0) {
      throw new Error(`Бренд з ID ${brandId} не існує`);
    }

    const productCheck = await client.query('SELECT id FROM products WHERE brand_id = $1', [brandId]);
    if (productCheck.rows.length > 0) {
      throw new Error('Неможливо видалити бренд, оскільки він використовується в продуктах');
    }

    await client.query('DELETE FROM brands WHERE id = $1', [brandId]);
    await client.query('COMMIT');
    res.json({ message: 'Бренд успішно видалено' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Помилка сервера' });
  } finally {
    client.release();
  }
});

app.post('/admin/store', authenticateToken, isAdmin, upload.single('logo'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, years_with_us, link } = req.body;

    if (!name || !name.trim()) {
      throw new Error('Назва магазину є обов’язковою');
    }

    let logoUrl = null;
    if (req.file) {
      console.log('Завантаження логотипу магазину у Cloudinary');
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'stores' }, (error, result) => {
          if (error) {
            console.error('Помилка завантаження логотипу:', error);
            reject(error);
          } else {
            console.log('Логотип завантажено:', result.secure_url);
            resolve(result);
          }
        }).end(req.file.buffer);
      });
      logoUrl = result.secure_url;
    }

    const result = await client.query(
      'INSERT INTO stores (name, logo, years_with_us, link) VALUES ($1, $2, $3, $4) RETURNING id, name, logo, years_with_us, link',
      [name.trim(), logoUrl || null, years_with_us ? parseInt(years_with_us) : null, link || null]
    );
    await client.query('COMMIT');
    res.json({ message: 'Магазин успішно створено', store: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      res.status(400).json({ error: 'Магазин з такою назвою вже існує' });
    } else {
      res.status(500).json({ error: err.message || 'Помилка сервера' });
    }
  } finally {
    client.release();
  }
});

app.put('/admin/store/:storeId', authenticateToken, isAdmin, upload.single('logo'), async (req, res) => {
  const { storeId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, years_with_us, link } = req.body;

    if (!name || !name.trim()) {
      throw new Error('Назва магазину є обов’язковою');
    }

    const storeCheck = await client.query('SELECT id, logo FROM stores WHERE id = $1', [storeId]);
    if (storeCheck.rows.length === 0) {
      throw new Error(`Магазин з ID ${storeId} не існує`);
    }

    let logoUrl = storeCheck.rows[0].logo;
    if (req.file) {
      console.log('Завантаження нового логотипу магазину у Cloudinary');
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'stores' }, (error, result) => {
          if (error) {
            console.error('Помилка завантаження логотипу:', error);
            reject(error);
          } else {
            console.log('Логотип завантажено:', result.secure_url);
            resolve(result);
          }
        }).end(req.file.buffer);
      });
      logoUrl = result.secure_url;

      if (storeCheck.rows[0].logo) {
        const publicId = storeCheck.rows[0].logo.split('/').pop().split('.')[0];
        await cloudinary.uploader.destroy(`stores/${publicId}`);
        console.log('Старий логотип видалено з Cloudinary');
      }
    }

    const result = await client.query(
      'UPDATE stores SET name = $1, logo = $2, years_with_us = $3, link = $4 WHERE id = $5 RETURNING id, name, logo, years_with_us, link',
      [name.trim(), logoUrl || null, years_with_us ? parseInt(years_with_us) : null, link || null, storeId]
    );
    await client.query('COMMIT');
    res.json({ message: 'Магазин успішно оновлено', store: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      res.status(400).json({ error: 'Магазин з такою назвою вже існує' });
    } else {
      res.status(500).json({ error: 'Помилка сервера' });
    }
  } finally {
    client.release();
  }
});

app.delete('/admin/store/:storeId', authenticateToken, isAdmin, async (req, res) => {
  const { storeId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const storeCheck = await client.query('SELECT id, logo FROM stores WHERE id = $1', [storeId]);
    if (storeCheck.rows.length === 0) {
      throw new Error(`Магазин з ID ${storeId} не існує`);
    }

    const priceCheck = await client.query('SELECT id FROM store_prices WHERE store_id = $1', [storeId]);
    if (priceCheck.rows.length > 0) {
      throw new Error('Неможливо видалити магазин, оскільки він використовується в цінах продуктів');
    }

    if (storeCheck.rows[0].logo) {
      const publicId = storeCheck.rows[0].logo.split('/').pop().split('.')[0];
      await cloudinary.uploader.destroy(`stores/${publicId}`);
      console.log('Логотип магазину видалено з Cloudinary');
    }

    await client.query('DELETE FROM stores WHERE id = $1', [storeId]);
    await client.query('COMMIT');
    res.json({ message: 'Магазин успішно видалено' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Помилка сервера' });
  } finally {
    client.release();
  }
});

app.get('/brands/:brandId', authenticateToken, async (req, res) => {
  const { brandId } = req.params;
  try {
    console.log('Отримання бренду:', { brandId });
    const result = await pool.query('SELECT id, name FROM brands WHERE id = $1', [brandId]);
    if (result.rows.length === 0) {
      console.log('Бренд не знайдено:', { brandId });
      return res.status(404).json({ error: 'Бренд не знайдено' });
    }
    console.log('Бренд отримано:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Помилка отримання бренду:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/stores/:storeId', authenticateToken, async (req, res) => {
  const { storeId } = req.params;
  try {
    console.log('Отримання магазину:', { storeId });
    const result = await pool.query('SELECT id, name, logo, years_with_us, link FROM stores WHERE id = $1', [storeId]);
    if (result.rows.length === 0) {
      console.log('Магазин не знайдено:', { storeId });
      return res.status(404).json({ error: 'Магазин не знайдено' });
    }
    console.log('Магазин отримано:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Помилка отримання магазину:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.put('/admin/product/:productId', authenticateToken, isAdmin, upload.array('images', 10), async (req, res) => {
  const { productId } = req.params;
  const client = await pool.connect();
  try {
    console.log('Початок оновлення товару:', { productId, body: req.body, files: req.files ? req.files.length : 0 });

    await client.query('BEGIN');
    console.log('Транзакцію розпочато');

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

    let features = {};
    let store_prices = [];
    let existing_images = [];
    try {
      features = featuresJson ? JSON.parse(featuresJson) : {};
      store_prices = storePricesJson ? JSON.parse(storePricesJson) : [];
      existing_images = existingImagesJson ? JSON.parse(existingImagesJson) : [];
      if (!Array.isArray(existing_images)) {
        existing_images = [existing_images];
      }
    } catch (err) {
      console.error('Помилка парсингу JSON:', { featuresJson, storePricesJson, existingImagesJson, error: err.message });
      throw new Error('Невалідний формат features, store_prices або existing_images');
    }

    console.log('Дані з форми:', {
      category_id,
      brand_id,
      name,
      volume,
      code,
      description,
      description_full,
      composition,
      usage,
      features,
      store_prices,
      existing_images,
    });

    if (!category_id || !brand_id || !name) {
      console.log('Відсутні обов’язкові поля:', { category_id, brand_id, name });
      throw new Error('Категорія, бренд і назва є обов’язковими');
    }

    const productCheck = await client.query('SELECT id FROM products WHERE id = $1', [productId]);
    if (productCheck.rows.length === 0) {
      console.log('Товар не існує:', { productId });
      throw new Error(`Товар з ID ${productId} не існує`);
    }

    const categoryCheck = await client.query('SELECT id FROM categories WHERE id = $1', [category_id]);
    if (categoryCheck.rows.length === 0) {
      console.log('Категорія не існує:', { category_id });
      throw new Error(`Категорія з ID ${category_id} не існує`);
    }

    const brandCheck = await client.query('SELECT id FROM brands WHERE id = $1', [brand_id]);
    if (brandCheck.rows.length === 0) {
      console.log('Бренд не існує:', { brand_id });
      throw new Error(`Бренд з ID ${brand_id} не існує`);
    }

    console.log('Товар, категорія та бренд валідні');

    await client.query(
      `UPDATE products
       SET category_id = $1, brand_id = $2, name = $3, volume = $4, type = $5, code = $6
       WHERE id = $7`,
      [
        category_id || null,
        brand_id || null,
        name || null,
        volume || null,
        features.type || null,
        code || null,
        productId,
      ]
    );
    console.log('Товар оновлено в products:', { productId });

    await client.query('DELETE FROM product_images WHERE product_id = $1', [productId]);
    console.log('Старі зображення видалено:', { productId });

    const imageUrls = [];
    const filteredExistingImages = existing_images.filter(url => url && !url.includes('placeholder.webp'));
    for (const imageUrl of filteredExistingImages) {
      if (imageUrl) {
        imageUrls.push(imageUrl);
        await client.query(
          `INSERT INTO product_images (product_id, image_url)
           VALUES ($1, $2)`,
          [productId, imageUrl]
        );
      }
    }

    if (req.files && req.files.length > 0) {
      console.log('Завантаження нових зображень у Cloudinary:', { fileCount: req.files.length });
      for (const file of req.files) {
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream({ folder: 'products' }, (error, result) => {
            if (error) {
              console.error('Помилка завантаження зображення:', error);
              reject(error);
            } else {
              console.log('Зображення завантажено:', result.secure_url);
              resolve(result);
            }
          }).end(file.buffer);
        });
        imageUrls.push(result.secure_url);
        await client.query(
          `INSERT INTO product_images (product_id, image_url)
           VALUES ($1, $2)`,
          [productId, result.secure_url]
        );
      }
    }
    console.log('Зображення збережено в product_images:', imageUrls);

    await client.query(
      `UPDATE product_details
       SET description = $1, composition = $2, usage = $3, description_full = $4
       WHERE product_id = $5`,
      [
        description || null,
        composition || null,
        usage || null,
        description_full || null,
        productId,
      ]
    );
    console.log('Деталі товару оновлено в product_details');

    await client.query('DELETE FROM product_features WHERE product_id = $1', [productId]);
    if (Object.keys(features).length > 0) {
      const featureFields = [
        'brand',
        'country',
        'type',
        'class',
        'category',
        'purpose',
        'gender',
        'active_ingredients',
      ];
      const featureValues = featureFields.map((field) => features[field] || null);
      await client.query(
        `INSERT INTO product_features (product_id, brand, country, type, class, category, purpose, gender, active_ingredients)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [productId, ...featureValues]
      );
      console.log('Характеристики оновлено в product_features:', featureValues);
    } else {
      console.log('Характеристики відсутні');
    }

    await client.query('DELETE FROM store_prices WHERE product_id = $1', [productId]);
    console.log('Старі ціни магазинів видалено:', { productId });
    if (store_prices.length > 0) {
      console.log('Обробка цін магазинів:', store_prices);
      for (const store of store_prices) {
        if (!store.store_id || !store.price || isNaN(parseFloat(store.price))) {
          console.warn('Пропущено невалідну ціну магазину:', store);
          continue;
        }
        const storeCheck = await client.query('SELECT id FROM stores WHERE id = $1', [store.store_id]);
        if (storeCheck.rows.length === 0) {
          console.warn('Магазин не існує:', { store_id: store.store_id });
          throw new Error(`Магазин з ID ${store.store_id} не існує`);
        }
        await client.query(
          `INSERT INTO store_prices (product_id, store_id, price, link)
           VALUES ($1, $2, $3, $4)`,
          [
            productId,
            store.store_id,
            parseFloat(store.price),
            store.link || null,
          ]
        );
        console.log('Ціна магазину оновлено:', { store_id: store.store_id, price: store.price });
      }
    } else {
      console.log('Ціни магазинів відсутні');
    }

    await client.query('COMMIT');
    console.log('Транзакцію успішно завершено');
    res.json({ message: 'Товар успішно оновлено', productId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Помилка оновлення товару:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      constraint: err.constraint,
      detail: err.detail,
    });
    res.status(500).json({ error: err.message || 'Помилка сервера' });
  } finally {
    client.release();
    console.log('Клієнт бази даних звільнено');
  }
});

app.delete('/admin/product/:productId', authenticateToken, isAdmin, async (req, res) => {
  const { productId } = req.params;
  const client = await pool.connect();
  try {
    console.log('Початок видалення товару:', { productId });

    await client.query('BEGIN');
    console.log('Транзакцію розпочато');

    const productCheck = await client.query('SELECT id FROM products WHERE id = $1', [productId]);
    if (productCheck.rows.length === 0) {
      console.log('Товар не існує:', { productId });
      throw new Error(`Товар з ID ${productId} не існує`);
    }

    await client.query('DELETE FROM product_images WHERE product_id = $1', [productId]);
    console.log('Зображення товару видалено:', { productId });

    await client.query('DELETE FROM store_prices WHERE product_id = $1', [productId]);
    console.log('Ціни магазинів видалено:', { productId });

    await client.query('DELETE FROM product_details WHERE product_id = $1', [productId]);
    console.log('Деталі товару видалено:', { productId });

    await client.query('DELETE FROM product_features WHERE product_id = $1', [productId]);
    console.log('Характеристики товару видалено:', { productId });

    await client.query('DELETE FROM saved_products WHERE product_id = $1', [productId]);
    console.log('Записи про збережені товари видалено:', { productId });

    await client.query('DELETE FROM products WHERE id = $1', [productId]);
    console.log('Товар видалено з таблиці products:', { productId });

    await client.query('COMMIT');
    console.log('Транзакцію успішно завершено');
    res.json({ message: 'Товар і всі пов’язані дані успішно видалено' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Помилка видалення товару:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      constraint: err.constraint,
      detail: err.detail,
    });
    res.status(500).json({ error: err.message || 'Помилка сервера' });
  } finally {
    client.release();
    console.log('Клієнт бази даних звільнено');
  }
});

app.delete('/categories/cleanup', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    console.log('Початок очищення безіменних категорій для користувача:', { userId });
    await client.query('BEGIN');

    const result = await client.query(
      `DELETE FROM saved_categories
       WHERE user_id = $1 AND (name IS NULL OR name = '' OR TRIM(name) = '')
       RETURNING id`,
      [userId]
    );
    console.log('Безіменні категорії видалено:', { count: result.rows.length });

    await client.query('COMMIT');
    res.json({ message: `Видалено ${result.rows.length} безіменних категорій` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Помилка очищення безіменних категорій:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  } finally {
    client.release();
    console.log('Клієнт бази даних звільнено');
  }
});

app.get('/categories', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    console.log('Отримання збережених категорій для користувача:', userId);
    const result = await pool.query(
      `SELECT id, name, created_at
       FROM saved_categories
       WHERE user_id = $1 AND name IS NOT NULL AND TRIM(name) != ''
       ORDER BY created_at ASC`,
      [userId]
    );
    console.log('Збережені категорії отримано:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('Помилка отримання збережених категорій:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/categories', authenticateToken, async (req, res) => {
  const { name } = req.body;
  const userId = req.user.id;
  if (!name || !name.trim()) {
    console.log('Назва категорії відсутня');
    return res.status(400).json({ error: 'Назва категорії обов’язкова' });
  }

  try {
    console.log('Створення нової категорії:', { name, userId });
    const result = await pool.query(
      `INSERT INTO saved_categories (user_id, name)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [userId, name.trim()]
    );
    console.log('Категорію створено:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Помилка створення категорії:', err.stack);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Категорія з такою назвою вже існує' });
    } else {
      res.status(500).json({ error: 'Помилка сервера' });
    }
  }
});

app.put('/categories/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const userId = req.user.id;
  if (!name || !name.trim()) {
    console.log('Назва категорії відсутня');
    return res.status(400).json({ error: 'Назва категорії обов’язкова' });
  }

  try {
    console.log('Оновлення категорії:', { id, name, userId });
    const result = await pool.query(
      `UPDATE saved_categories
       SET name = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, name, created_at`,
      [name.trim(), id, userId]
    );
    if (result.rows.length === 0) {
      console.log('Категорію не знайдено або немає доступу:', { id, userId });
      return res.status(404).json({ error: 'Категорію не знайдено або ви не маєте доступу' });
    }
    console.log('Категорію оновлено:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Помилка оновлення категорії:', err.stack);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Категорія з такою назвою вже існує' });
    } else {
      res.status(500).json({ error: 'Помилка сервера' });
    }
  }
});

app.delete('/categories/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  try {
    console.log('Видалення категорії:', { id, userId });
    const result = await pool.query(
      `DELETE FROM saved_categories
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId]
    );
    if (result.rows.length === 0) {
      console.log('Категорію не знайдено або немає доступу:', { id, userId });
      return res.status(404).json({ error: 'Категорію не знайдено або ви не маєте доступу' });
    }
    console.log('Категорію видалено');
    res.json({ message: 'Категорію видалено' });
  } catch (err) {
    console.error('Помилка видалення категорії:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.patch('/saved-products/:productId', authenticateToken, async (req, res) => {
  const { productId } = req.params;
  const { saved_category_id } = req.body;
  const userId = req.user.id;

  try {
    console.log('Оновлення категорії збереженого товару:', { productId, saved_category_id, userId });
    if (saved_category_id) {
      const categoryCheck = await pool.query(
        `SELECT id FROM saved_categories WHERE id = $1 AND user_id = $2`,
        [saved_category_id, userId]
      );
      if (categoryCheck.rows.length === 0) {
        console.log('Категорія не належить користувачу:', { saved_category_id, userId });
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
      console.log('Товар не знайдено у бажаному:', { productId, userId });
      return res.status(404).json({ error: 'Товар не знайдено у бажаному' });
    }

    console.log('Категорію товару оновлено:', result.rows[0]);
    res.json({ message: 'Категорію товару оновлено', saved_category_id: result.rows[0].saved_category_id });
  } catch (err) {
    console.error('Помилка оновлення категорії товару:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/register', async (req, res) => {
  const { nickname, email, password, photo, gender, birth_date } = req.body;
  try {
    console.log('Реєстрація користувача:', { nickname, email });
    if (!nickname || !email || !password) {
      console.log('Відсутні обов’язкові поля для реєстрації');
      return res.status(400).json({ error: 'Нікнейм, пошта та пароль обов’язкові' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (nickname, email, password, photo, gender, birth_date, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nickname, email, photo, gender, birth_date, is_admin`,
      [nickname || null, email || null, hashedPassword, photo || null, gender || null, birth_date || null, false]
    );

    const user = result.rows[0];
    console.log('Користувача зареєстровано:', { userId: user.id });
    const token = jwt.sign({ id: user.id, nickname: user.nickname, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, user });
  } catch (err) {
    console.error('Помилка реєстрації:', err.stack);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Нікнейм або пошта вже зайняті' });
    } else {
      res.status(500).json({ error: 'Помилка сервера' });
    }
  }
});

app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  try {
    console.log('Вхід користувача:', { identifier });
    if (!identifier || !password) {
      console.log('Відсутні ідентифікатор або пароль');
      return res.status(400).json({ error: 'Потрібні ідентифікатор і пароль' });
    }

    const result = await pool.query(
      `SELECT id, nickname, email, password, photo, gender, birth_date, is_admin FROM users WHERE nickname = $1 OR email = $1`,
      [identifier]
    );

    if (result.rows.length === 0) {
      console.log('Користувача не знайдено:', { identifier });
      return res.status(401).json({ error: 'Неправильний нікнейм/пошта або пароль' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.log('Неправильний пароль для:', { identifier });
      return res.status(401).json({ error: 'Неправильний нікнейм/пошта або пароль' });
    }

    console.log('Користувач увійшов:', { userId: user.id });
    const token = jwt.sign({ id: user.id, nickname: user.nickname, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, user });
  } catch (err) {
    console.error('Помилка входу:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/update-user', authenticateToken, async (req, res) => {
  const { email, gender, birth_date } = req.body;
  const userId = req.user.id;
  try {
    console.log('Оновлення даних користувача:', { userId, email, gender, birth_date });
    const result = await pool.query(
      `UPDATE users
       SET email = $1, gender = $2, birth_date = $3
       WHERE id = $4
       RETURNING id, nickname, email, photo, gender, birth_date, is_admin`,
      [email || null, gender || null, birth_date || null, userId]
    );

    if (result.rows.length === 0) {
      console.log('Користувача не знайдено:', { userId });
      return res.status(404).json({ error: 'Користувача не знайдено' });
    }

    console.log('Дані користувача оновлено:', result.rows[0]);
    const user = result.rows[0];
    res.json({ user });
  } catch (err) {
    console.error('Помилка оновлення:', err.stack);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Пошта вже зайнята' });
    } else {
      res.status(500).json({ error: 'Помилка сервера' });
    }
  }
});

app.get('/saved-products/:productId', authenticateToken, async (req, res) => {
  const { productId } = req.params;
  const userId = req.user.id;
  try {
    console.log('Перевірка збереженого товару:', { productId, userId });
    const result = await pool.query(
      `SELECT id FROM saved_products WHERE user_id = $1 AND product_id = $2`,
      [userId, productId]
    );
    res.json({ isSaved: result.rows.length > 0 });
  } catch (err) {
    console.error('Помилка перевірки збереженого товару:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/saved-products', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    console.log('Отримання збережених товарів для користувача:', userId);
    const result = await pool.query(
      `SELECT product_id, saved_category_id FROM saved_products WHERE user_id = $1`,
      [userId]
    );
    const savedProducts = result.rows.map(row => ({
      product_id: row.product_id,
      saved_category_id: row.saved_category_id
    }));
    console.log('Збережені товари отримано:', savedProducts.length);
    res.json({ savedProducts });
  } catch (err) {
    console.error('Помилка отримання збережених товарів:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/saved-products/bulk', authenticateToken, async (req, res) => {
  const { productIds } = req.body;
  const userId = req.user.id;
  try {
    console.log('Масова перевірка збережених товарів:', { productIds, userId });
    if (!Array.isArray(productIds) || productIds.length === 0) {
      console.log('Порожній масив productIds');
      return res.json({ savedProductIds: [] });
    }
    const result = await pool.query(
      `SELECT product_id FROM saved_products WHERE user_id = $1 AND product_id = ANY($2)`,
      [userId, productIds]
    );
    const savedProductIds = result.rows.map(row => row.product_id);
    console.log('Збережені товари:', savedProductIds);
    res.json({ savedProductIds });
  } catch (err) {
    console.error('Помилка масової перевірки збережених товарів:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/saved-products', authenticateToken, async (req, res) => {
  const { productId } = req.body;
  const userId = req.user.id;
  try {
    console.log('Додавання товару до збережених:', { productId, userId });
    const result = await pool.query(
      `INSERT INTO saved_products (user_id, product_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userId, productId]
    );
    if (result.rows.length === 0) {
      console.log('Товар уже додано до бажаного:', { productId });
      return res.status(400).json({ error: 'Товар уже додано до бажаного' });
    }
    console.log('Товар додано до бажаного');
    res.json({ message: 'Товар додано до бажаного' });
  } catch (err) {
    console.error('Помилка додавання до бажаного:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.delete('/saved-products/:productId', authenticateToken, async (req, res) => {
  const { productId } = req.params;
  const userId = req.user.id;
  try {
    console.log('Видалення товару зі збережених:', { productId, userId });
    const result = await pool.query(
      `DELETE FROM saved_products WHERE user_id = $1 AND product_id = $2
       RETURNING id`,
      [userId, productId]
    );
    if (result.rows.length === 0) {
      console.log('Товар не знайдено у бажаному:', { productId });
      return res.status(404).json({ error: 'Товар не знайдено у бажаному' });
    }
    console.log('Товар видалено з бажаного');
    res.json({ message: 'Товар видалено з бажаного' });
  } catch (err) {
    console.error('Помилка видалення з бажаного:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/products', async (req, res) => {
  try {
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
      hasRating
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

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
    else if (priceRanges) {
      const ranges = priceRanges.split(',');
      const rangeConditions = ranges.map((range, index) => {
        const [min, max] = range.includes('+') ? [1000, Infinity] : range.split('-').map(Number);
        if (max === Infinity) {
          return `sp.price >= $${values.length + 1}`;
        }
        return `sp.price BETWEEN $${values.length + 1} AND $${values.length + 2}`;
      });
      ranges.forEach((range) => {
        const [min, max] = range.includes('+') ? [1000, Infinity] : range.split('-').map(Number);
        values.push(min);
        if (max !== Infinity) values.push(max);
      });
      conditions.push(`(${rangeConditions.join(' OR ')})`);
    }

    if (volumes) {
      const volumeList = volumes.split(',');
      conditions.push(`p.volume = ANY($${values.length + 1})`);
      values.push(volumeList);
    }

    if (types) {
      const typeList = types.split(',');
      conditions.push(`pf.type = ANY($${values.length + 1})`);
      values.push(typeList);
    }

    if (hasRating === 'true') {
      conditions.push(`p.rating IS NOT NULL`);
    }

    let whereClause = '';
    if (conditions.length > 0) {
      whereClause = ` WHERE ${conditions.join(' AND ')}`;
      query += whereClause;
    }

    query += `
      GROUP BY p.id, c.name_ua, c.name_en, b.name, pd.description, pd.composition, pd.usage, pd.description_full,
               pf.brand, pf.country, pf.type, pf.class, pf.category, pf.purpose, pf.gender, pf.active_ingredients
    `;

    let countQuery = `
      SELECT COUNT(DISTINCT p.id) AS total
      FROM products p
      JOIN categories c ON p.category_id = c.id
      JOIN brands b ON p.brand_id = b.id
      LEFT JOIN product_details pd ON p.id = pd.product_id
      LEFT JOIN product_features pf ON p.id = pf.product_id
      LEFT JOIN store_prices sp ON p.id = sp.product_id
      ${whereClause}
    `;

    let searchResults = [];
    if (search || category) {
      const searchQuery = query + `
        ORDER BY p.id
      `;
      const searchResult = await pool.query(searchQuery, values);
      searchResults = searchResult.rows;
      console.log('Результати пошуку:', searchResults.length);
    } else {
      query += (random === 'true') ? ` ORDER BY RANDOM()` : ` ORDER BY p.id`;
      query += `
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `;
      values.push(parseInt(limit), offset);
      const result = await pool.query(query, values);
      searchResults = result.rows;
      console.log('Результати пагінації:', searchResults.length);
    }

    const countResult = await pool.query(countQuery, values.slice(0, search || category ? values.length : values.length - 2));
    console.log('Загальна кількість товарів:', countResult.rows[0].total);

    const groupedResults = searchResults.reduce((acc, product) => {
      const category = acc.find((cat) => cat.category === product.category_id);
      const productEntry = {
        id: product.id,
        name: product.name,
        specs: { volume: product.volume || 'Н/Д' },
      };
      if (category) {
        category.products.push(productEntry);
        category.count += 1;
      } else {
        acc.push({
          category: product.category_id,
          products: [productEntry],
          count: 1,
        });
      }
      return acc;
    }, []).sort((a, b) => b.count - a.count);

    res.json({
      products: searchResults.map(row => ({
        ...row,
        images: row.images ? row.images.filter(url => !url.includes('placeholder.webp')) : [],
        store_prices: row.store_prices || [],
        features: {
          brand: row.feature_brand,
          country: row.country,
          type: row.feature_type,
          class: row.class,
          hairType: row.feature_type,
          features: row.features,
          category: row.feature_category,
          purpose: row.purpose,
          gender: row.gender,
          activeIngredients: row.active_ingredients,
          description: row.description
        }
      })),
      total: parseInt(countResult.rows[0].total, 10),
      groupedResults: (search || category) ? groupedResults : [],
    });
  } catch (err) {
    console.error('Помилка запиту /products:', err.stack);
    res.status(500).send('Помилка сервера');
  }
});

app.get('/products/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    console.log('Отримання деталей товару:', { id });
    await client.query('BEGIN');

    // Increment views
    await client.query(
      `UPDATE products SET views = views + 1 WHERE id = $1`,
      [id]
    );
    console.log('Кількість переглядів оновлено:', { id });

    const result = await client.query(`
      SELECT p.id, p.name, p.volume, p.type, p.rating, p.views, p.code,
             c.id AS category_id, c.name_ua AS category_name, b.id AS brand_id, b.name AS brand_name,
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
      GROUP BY p.id, c.id, c.name_ua, b.id, b.name, pd.description, pd.composition, pd.usage, pd.description_full,
               pf.brand, pf.country, pf.type, pf.class, pf.category, pf.purpose, pf.gender, pf.active_ingredients
    `, [id]);

    if (result.rows.length === 0) {
      console.log('Продукт не знайдено:', { id });
      await client.query('ROLLBACK');
      return res.status(404).send('Продукт не знайдено');
    }

    const product = {
      ...result.rows[0],
      images: result.rows[0].images ? result.rows[0].images.filter(url => !url.includes('placeholder.webp')) : [],
      store_prices: result.rows[0].store_prices || [],
      features: {
        brand: result.rows[0].feature_brand,
        country: result.rows[0].country,
        type: result.rows[0].feature_type,
        class: result.rows[0].class,
        category: result.rows[0].feature_category,
        purpose: result.rows[0].purpose,
        gender: result.rows[0].gender,
        active_ingredients: result.rows[0].active_ingredients,
      }
    };
    console.log('Деталі товару отримано:', { id });
    await client.query('COMMIT');
    res.json(product);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Помилка запиту /products/:id:', err.stack);
    res.status(500).send('Помилка сервера');
  } finally {
    client.release();
  }
});

app.get('/store-locations', async (req, res) => {
  const { cityId, productId } = req.query;
  try {
    console.log('Fetching store locations:', { cityId, productId });

    if (!productId) {
      console.log('Missing productId');
      return res.status(400).json({ error: 'productId is required' });
    }

    let query = `
      SELECT sl.id, sl.store_id, s.name AS store_name, sl.city_id, sl.latitude, sl.longitude, 
             sl.address, sl.hours_mon_fri, sl.hours_sat, sl.hours_sun
      FROM store_locations sl
      JOIN stores s ON sl.store_id = s.id
      JOIN store_prices sp ON s.id = sp.store_id
      WHERE sp.product_id = $1
    `;
    const values = [parseInt(productId)];

    if (cityId) {
      query += ` AND sl.city_id = $2`;
      values.push(parseInt(cityId));
    }

    query += ` ORDER BY sl.id ASC`;

    const result = await pool.query(query, values);
    console.log('Store locations fetched:', result.rows.length);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching store locations:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/categories/public', async (req, res) => {
  try {
    console.log('Отримання категорій');
    const result = await pool.query('SELECT id, name_ua, name_en FROM categories ORDER BY name_ua ASC');
    console.log('Категорії отримано:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('Помилка отримання категорій:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/brands', async (req, res) => {
  try {
    console.log('Отримання брендів');
    const result = await pool.query('SELECT id, name FROM brands ORDER BY name ASC');
    console.log('Бренди отримано:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('Помилка отримання брендів:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/stores', async (req, res) => {
  try {
    console.log('Отримання магазинів');
    const result = await pool.query('SELECT id, name, logo, link FROM stores ORDER BY name ASC');
    console.log('Магазини отримано:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('Помилка отримання магазинів:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/admin/store-location', authenticateToken, isAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('Початок створення локації магазину:', req.body);
    await client.query('BEGIN');

    const {
      store_id,
      city_id,
      address,
      latitude,
      longitude,
      hours_mon_fri,
      hours_sat,
      hours_sun,
    } = req.body;

    if (!store_id || !city_id || !address || !latitude || !longitude) {
      console.log('Відсутні обов’язкові поля:', { store_id, city_id, address, latitude, longitude });
      throw new Error('Магазин, місто, адреса, широта та довгота є обов’язковими');
    }

    const storeCheck = await client.query('SELECT id FROM stores WHERE id = $1', [store_id]);
    if (storeCheck.rows.length === 0) {
      console.log('Магазин не існує:', { store_id });
      throw new Error(`Магазин з ID ${store_id} не існує`);
    }

    const cityCheck = await client.query('SELECT id FROM cities WHERE id = $1', [city_id]);
    if (cityCheck.rows.length === 0) {
      console.log('Місто не існує:', { city_id });
      throw new Error(`Місто з ID ${city_id} не існує`);
    }

    // Синхронізація послідовності store_locations_id_seq
    const maxIdResult = await client.query('SELECT MAX(id) FROM store_locations');
    const maxId = maxIdResult.rows[0].max || 0;
    console.log('Максимальний ID у store_locations:', { maxId });

    await client.query(
      "SELECT setval('store_locations_id_seq', COALESCE($1, 0) + 1, false)",
      [maxId]
    );
    console.log('Послідовність store_locations_id_seq синхронізовано');

    const result = await client.query(
      `INSERT INTO store_locations (store_id, city_id, address, latitude, longitude, hours_mon_fri, hours_sat, hours_sun)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, store_id, city_id, address, latitude, longitude, hours_mon_fri, hours_sat, hours_sun`,
      [
        store_id,
        city_id,
        address,
        parseFloat(latitude),
        parseFloat(longitude),
        hours_mon_fri || null,
        hours_sat || null,
        hours_sun || null,
      ]
    );

    await client.query('COMMIT');
    console.log('Локацію магазину створено:', result.rows[0]);
    res.json({ message: 'Локацію магазину успішно створено', location: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Помилка створення локації магазину:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      constraint: err.constraint,
      detail: err.detail,
    });
    if (err.code === '23505') {
      res.status(400).json({ error: 'Локація з такими даними вже існує' });
    } else {
      res.status(500).json({ error: err.message || 'Помилка сервера' });
    }
  } finally {
    client.release();
    console.log('Клієнт бази даних звільнено');
  }
});

app.get('/admin/store-location/last-hours', authenticateToken, isAdmin, async (req, res) => {
  const { store_id, city_id } = req.query;
  try {
    console.log('Отримання останніх годин роботи для магазину та міста:', { store_id, city_id });

    if (!store_id || !city_id) {
      console.log('Відсутні store_id або city_id');
      return res.status(400).json({ error: 'Потрібні store_id та city_id' });
    }

    const result = await pool.query(
      `SELECT hours_mon_fri, hours_sat, hours_sun
       FROM store_locations
       WHERE store_id = $1 AND city_id = $2
       ORDER BY id DESC
       LIMIT 1`,
      [parseInt(store_id), parseInt(city_id)]
    );

    if (result.rows.length === 0) {
      console.log('Локацій для магазину та міста не знайдено:', { store_id, city_id });
      return res.status(200).json({ hours_mon_fri: '', hours_sat: '', hours_sun: '' });
    }

    console.log('Останні години роботи отримано:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Помилка отримання годин роботи:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.delete('/admin/store-location/:locationId', authenticateToken, isAdmin, async (req, res) => {
  const { locationId } = req.params;
  const client = await pool.connect();
  try {
    console.log('Початок видалення локації магазину:', { locationId });

    await client.query('BEGIN');
    console.log('Транзакцію розпочато');

    const locationCheck = await client.query('SELECT id FROM store_locations WHERE id = $1', [locationId]);
    if (locationCheck.rows.length === 0) {
      console.log('Локація не існує:', { locationId });
      throw new Error(`Локація з ID ${locationId} не існує`);
    }

    await client.query('DELETE FROM store_locations WHERE id = $1', [locationId]);
    console.log('Локацію видалено з таблиці store_locations:', { locationId });

    await client.query('COMMIT');
    console.log('Транзакцію успішно завершено');
    res.json({ message: 'Локацію магазину успішно видалено' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Помилка видалення локації магазину:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      constraint: err.constraint,
      detail: err.detail,
    });
    res.status(500).json({ error: err.message || 'Помилка сервера' });
  } finally {
    client.release();
    console.log('Клієнт бази даних звільнено');
  }
});

app.put('/admin/store-location/:locationId', authenticateToken, isAdmin, async (req, res) => {
  const { locationId } = req.params;
  const client = await pool.connect();
  try {
    console.log('Початок оновлення локації магазину:', { locationId, body: req.body });

    await client.query('BEGIN');
    console.log('Транзакцію розпочато');

    const {
      store_id,
      city_id,
      address,
      latitude,
      longitude,
      hours_mon_fri,
      hours_sat,
      hours_sun,
    } = req.body;

    if (!store_id || !city_id || !address || !latitude || !longitude) {
      console.log('Відсутні обов’язкові поля:', { store_id, city_id, address, latitude, longitude });
      throw new Error('Магазин, місто, адреса, широта та довгота є обов’язковими');
    }

    const locationCheck = await client.query('SELECT id FROM store_locations WHERE id = $1', [locationId]);
    if (locationCheck.rows.length === 0) {
      console.log('Локація не існує:', { locationId });
      throw new Error(`Локація з ID ${locationId} не існує`);
    }

    const storeCheck = await client.query('SELECT id FROM stores WHERE id = $1', [store_id]);
    if (storeCheck.rows.length === 0) {
      console.log('Магазин не існує:', { store_id });
      throw new Error(`Магазин з ID ${store_id} не існує`);
    }

    const cityCheck = await client.query('SELECT id FROM cities WHERE id = $1', [city_id]);
    if (cityCheck.rows.length === 0) {
      console.log('Місто не існує:', { city_id });
      throw new Error(`Місто з ID ${city_id} не існує`);
    }

    const result = await client.query(
      `UPDATE store_locations
       SET store_id = $1, city_id = $2, address = $3, latitude = $4, longitude = $5,
           hours_mon_fri = $6, hours_sat = $7, hours_sun = $8
       WHERE id = $9
       RETURNING id, store_id, city_id, address, latitude, longitude, hours_mon_fri, hours_sat, hours_sun`,
      [
        store_id,
        city_id,
        address,
        parseFloat(latitude),
        parseFloat(longitude),
        hours_mon_fri || null,
        hours_sat || null,
        hours_sun || null,
        locationId,
      ]
    );

    await client.query('COMMIT');
    console.log('Локацію оновлено:', result.rows[0]);
    res.json({ message: 'Локацію магазину успішно оновлено', location: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Помилка оновлення локації магазину:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      constraint: err.constraint,
      detail: err.detail,
    });
    if (err.code === '23505') {
      res.status(400).json({ error: 'Локація з такими даними вже існує' });
    } else {
      res.status(500).json({ error: err.message || 'Помилка сервера' });
    }
  } finally {
    client.release();
    console.log('Клієнт бази даних звільнено');
  }
});

app.get('/admin/store-location/:locationId', authenticateToken, isAdmin, async (req, res) => {
  const { locationId } = req.params;
  try {
    console.log('Отримання деталей локації магазину:', { locationId });
    const result = await pool.query(`
      SELECT sl.id, sl.store_id, s.name AS store_name, sl.city_id, c.name_ua AS city_name,
             sl.latitude, sl.longitude, sl.address, 
             sl.hours_mon_fri, sl.hours_sat, sl.hours_sun
      FROM store_locations sl
      JOIN stores s ON sl.store_id = s.id
      JOIN cities c ON sl.city_id = c.id
      WHERE sl.id = $1
    `, [parseInt(locationId)]);
    if (result.rows.length === 0) {
      console.log('Локацію не знайдено:', { locationId });
      return res.status(404).json({ error: 'Локацію не знайдено' });
    }
    console.log('Деталі локації отримано:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Помилка отримання деталей локації:', {
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/admin/store-locations', authenticateToken, isAdmin, async (req, res) => {
  try {
    console.log('Отримання всіх локацій магазинів для адміна');
    const result = await pool.query(`
      SELECT sl.id, sl.store_id, s.name AS store_name, sl.city_id, c.name_ua AS city_name,
             sl.latitude, sl.longitude, sl.address, 
             sl.hours_mon_fri, sl.hours_sat, sl.hours_sun
      FROM store_locations sl
      JOIN stores s ON sl.store_id = s.id
      JOIN cities c ON sl.city_id = c.id
      ORDER BY sl.address ASC
    `);
    console.log('Локації отримано:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('Помилка отримання локацій магазинів:', {
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/upload-image', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      console.log('Зображення не надано');
      return res.status(400).json({ error: 'Зображення не надано' });
    }

    console.log('Завантаження зображення у Cloudinary');
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder: 'products' }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }).end(req.file.buffer);
    });

    const productId = req.body.productId;
    const imageUrl = result.secure_url;
    console.log('Зображення завантажено:', { productId, imageUrl });

    const dbResult = await pool.query(
      `INSERT INTO product_images (product_id, image_url)
       VALUES ($1, $2)
       RETURNING id, image_url`,
      [productId, imageUrl]
    );

    res.json({ message: 'Зображення успішно завантажено', imageUrl: dbResult.rows[0].image_url });
  } catch (err) {
    console.error('Помилка обробки завантаження:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/upload-avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      console.log('Аватарка не надана');
      return res.status(400).json({ error: 'Аватарка не надана' });
    }

    console.log('Завантаження аватарки у Cloudinary');
    const userId = req.user.id;
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'avatars', public_id: `user_${userId}` },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(req.file.buffer);
    });

    const photoUrl = result.secure_url;
    console.log('Аватарка завантажена:', { userId, photoUrl });

    const dbResult = await pool.query(
      `UPDATE users
       SET photo = $1
       WHERE id = $2
       RETURNING id, nickname, email, photo, gender, birth_date, is_admin`,
      [photoUrl, userId]
    );

    if (dbResult.rows.length === 0) {
      console.log('Користувача не знайдено:', { userId });
      return res.status(404).json({ error: 'Користувача не знайдено' });
    }

    res.json({
      message: 'Аватарку успішно завантажено',
      user: dbResult.rows[0],
    });
  } catch (err) {
    console.error('Помилка завантаження аватарки:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});