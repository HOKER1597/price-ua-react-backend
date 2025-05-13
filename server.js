const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key'; // Змініть на безпечний ключ у продакшені

// Налаштування підключення до PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://cosmetick_ua_7v96_user:wqrSsi3lDg8ZztkxXlVvlrQq3MyCYK5M@dpg-d0erudmmcj7s7385nb1g-a.oregon-postgres.render.com/cosmetick_ua',
  ssl: { rejectUnauthorized: false },
});

// Middleware для перевірки токена
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Токен відсутній' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Недійсний токен' });
    req.user = user;
    next();
  });
};

// Ендпоінт для отримання всіх категорій користувача
app.get('/categories', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query(
      `SELECT id, name, created_at
       FROM saved_categories
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Помилка отримання категорій:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Ендпоінт для створення нової категорії
app.post('/categories', authenticateToken, async (req, res) => {
  const { name } = req.body;
  const userId = req.user.id;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Назва категорії обов’язкова' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO saved_categories (user_id, name)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [userId, name.trim()]
    );
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

// Ендпоінт для оновлення назви категорії
app.put('/categories/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const userId = req.user.id;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Назва категорії обов’язкова' });
  }

  try {
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
  } catch (err) {
    console.error('Помилка оновлення категорії:', err.stack);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Категорія з такою назвою вже існує' });
    } else {
      res.status(500).json({ error: 'Помилка сервера' });
    }
  }
});

// Ендпоінт для видалення категорії
app.delete('/categories/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  try {
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
  } catch (err) {
    console.error('Помилка видалення категорії:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Ендпоінт для реєстрації
app.post('/register', async (req, res) => {
  const { nickname, email, password, photo, gender, birth_date } = req.body;
  try {
    if (!nickname || !email || !password) {
      return res.status(400).json({ error: 'Нікнейм, пошта та пароль обов’язкові' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (nickname, email, password, photo, gender, birth_date, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nickname, email, gender, birth_date`,
      [nickname || null, email || null, hashedPassword, photo || null, gender || null, birth_date || null, false]
    );

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, nickname: user.nickname }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, user: { id: user.id, nickname: user.nickname, email: user.email, gender: user.gender, birth_date: user.birth_date } });
  } catch (err) {
    console.error('Помилка реєстрації:', err.stack);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Нікнейм або пошта вже зайняті' });
    } else {
      res.status(500).json({ error: 'Помилка сервера' });
    }
  }
});

// Ендпоінт для входу
app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  try {
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Потрібні ідентифікатор і пароль' });
    }

    const result = await pool.query(
      `SELECT id, nickname, email, password, gender, birth_date FROM users WHERE nickname = $1 OR email = $1`,
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

    const token = jwt.sign({ id: user.id, nickname: user.nickname }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, user: { id: user.id, nickname: user.nickname, email: user.email, gender: user.gender, birth_date: user.birth_date } });
  } catch (err) {
    console.error('Помилка входу:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Ендпоінт для оновлення даних користувача
app.post('/update-user', authenticateToken, async (req, res) => {
  const { email, gender, birth_date } = req.body;
  const userId = req.user.id;
  try {
    const result = await pool.query(
      `UPDATE users
       SET email = $1, gender = $2, birth_date = $3
       WHERE id = $4
       RETURNING id, nickname, email, gender, birth_date`,
      [email || null, gender || null, birth_date || null, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Користувача не знайдено' });
    }

    const user = result.rows[0];
    res.json({ user: { id: user.id, nickname: user.nickname, email: user.email, gender: user.gender, birth_date: user.birth_date } });
  } catch (err) {
    console.error('Помилка оновлення:', err.stack);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Пошта вже зайнята' });
    } else {
      res.status(500).json({ error: 'Помилка сервера' });
    }
  }
});

// Ендпоінт для перевірки, чи товар збережено
app.get('/saved-products/:productId', authenticateToken, async (req, res) => {
  const { productId } = req.params;
  const userId = req.user.id;
  try {
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

// Ендпоінт для отримання всіх збережених товарів користувача
app.get('/saved-products', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query(
      `SELECT product_id FROM saved_products WHERE user_id = $1`,
      [userId]
    );
    const savedProductIds = result.rows.map(row => row.product_id);
    res.json({ savedProductIds });
  } catch (err) {
    console.error('Помилка отримання збережених товарів:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Ендпоінт для масової перевірки збережених товарів
app.post('/saved-products/bulk', authenticateToken, async (req, res) => {
  const { productIds } = req.body;
  const userId = req.user.id;
  try {
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.json({ savedProductIds: [] });
    }
    const result = await pool.query(
      `SELECT product_id FROM saved_products WHERE user_id = $1 AND product_id = ANY($2)`,
      [userId, productIds]
    );
    const savedProductIds = result.rows.map(row => row.product_id);
    res.json({ savedProductIds });
  } catch (err) {
    console.error('Помилка масової перевірки збережених товарів:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Ендпоінт для додавання товару до бажаного
app.post('/saved-products', authenticateToken, async (req, res) => {
  const { productId } = req.body;
  const userId = req.user.id;
  try {
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
  } catch (err) {
    console.error('Помилка додавання до бажаного:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Ендпоінт для видалення товару з бажаного
app.delete('/saved-products/:productId', authenticateToken, async (req, res) => {
  const { productId } = req.params;
  const userId = req.user.id;
  try {
    const result = await pool.query(
      `DELETE FROM saved_products WHERE user_id = $1 AND product_id = $2
       RETURNING id`,
      [userId, productId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Товар не знайдено у бажаному' });
    }
    res.json({ message: 'Товар видалено з бажаного' });
  } catch (err) {
    console.error('Помилка видалення з бажаного:', err.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Ендпоінт для отримання списку продуктів із пагінацією та фільтрами
app.get('/products', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 24,
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
               'yearsWithUs', s.years_with_us,
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
    } else {
      query += (random === 'true') ? ` ORDER BY RANDOM()` : ` ORDER BY p.id`;
      query += `
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `;
      values.push(parseInt(limit), offset);
      const result = await pool.query(query, values);
      searchResults = result.rows;
    }

    const countResult = await pool.query(countQuery, values.slice(0, search || category ? values.length : values.length - 2));

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
        images: row.images || [],
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

// Ендпоінт для отримання деталей продукту
app.get('/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
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
               'yearsWithUs', s.years_with_us,
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
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).send('Продукт не знайдено');
    }

    const product = {
      ...result.rows[0],
      images: result.rows[0].images || [],
      store_prices: result.rows[0].store_prices || [],
      features: {
        brand: result.rows[0].feature_brand,
        country: result.rows[0].country,
        type: result.rows[0].feature_type,
        class: result.rows[0].class,
        hairType: result.rows[0].feature_type,
        features: result.rows[0].features,
        category: result.rows[0].feature_category,
        purpose: result.rows[0].purpose,
        gender: result.rows[0].gender,
        activeIngredients: result.rows[0].active_ingredients,
        description: result.rows[0].description
      }
    };
    res.json(product);
  } catch (err) {
    console.error('Помилка запиту /products/:id:', err.stack);
    res.status(500).send('Помилка сервера');
  }
});

// Запуск сервера
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});