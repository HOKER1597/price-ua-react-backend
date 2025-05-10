const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Налаштування підключення до PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://cosmetick_ua_7v96_user:wqrSsi3lDg8ZztkxXlVvlrQq3MyCYK5M@dpg-d0erudmmcj7s7385nb1g-a.oregon-postgres.render.com/cosmetick_ua',
  ssl: { rejectUnauthorized: false },
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

    // Базовий SQL-запит
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

    // Фільтр за пошуковим запитом
    if (search) {
      conditions.push(`p.name ILIKE $${values.length + 1}`);
      values.push(`%${search}%`);
    }

    // Фільтр за категорією
    if (category) {
      const categories = category.split(',');
      conditions.push(`c.name_en = ANY($${values.length + 1})`);
      values.push(categories);
    }

    // Фільтр за брендами
    if (brands) {
      const brandList = brands.split(',');
      conditions.push(`b.name = ANY($${values.length + 1})`);
      values.push(brandList);
    }

    // Фільтр за кастомним діапазоном цін
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
    // Фільтр за стандартними діапазонами цін
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

    // Фільтр за об’ємами
    if (volumes) {
      const volumeList = volumes.split(',');
      conditions.push(`p.volume = ANY($${values.length + 1})`);
      values.push(volumeList);
    }

    // Фільтр за типами
    if (types) {
      const typeList = types.split(',');
      conditions.push(`pf.type = ANY($${values.length + 1})`);
      values.push(typeList);
    }

    // Фільтр за наявністю рейтингу
    if (hasRating === 'true') {
      conditions.push(`p.rating IS NOT NULL`);
    }

    // Додавання умов до запиту
    let whereClause = '';
    if (conditions.length > 0) {
      whereClause = ` WHERE ${conditions.join(' AND ')}`;
      query += whereClause;
    }

    // Групування
    query += `
      GROUP BY p.id, c.name_ua, c.name_en, b.name, pd.description, pd.composition, pd.usage, pd.description_full,
               pf.brand, pf.country, pf.type, pf.class, pf.category, pf.purpose, pf.gender, pf.active_ingredients
    `;

    // Запит для підрахунку загальної кількості продуктів
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

    // Виконання запитів
    let searchResults = [];
    if (search || category) {
      // Для пошуку або категорії: отримати всі продукти для групування
      const searchQuery = query + `
        ORDER BY p.id
      `;
      const searchResult = await pool.query(searchQuery, values);
      searchResults = searchResult.rows;
    } else {
      // Виконання основного запиту з пагінацією
      query += (random === 'true') ? ` ORDER BY RANDOM()` : ` ORDER BY p.id`;
      query += `
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `;
      values.push(parseInt(limit), offset);
      const result = await pool.query(query, values);
      searchResults = result.rows;
    }

    // Виконання запиту для підрахунку
    const countResult = await pool.query(countQuery, values.slice(0, search || category ? values.length : values.length - 2));

    // Групування результатів за категоріями
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

    // Форматування відповіді
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