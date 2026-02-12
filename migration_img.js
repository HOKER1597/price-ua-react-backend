require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

// Налаштування Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Налаштування підключення до PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://cosmetick_ua_7v96_user:wqrSsi3lDg8ZztkxXlVvlrQq3MyCYK5M@dpg-d0erudmmcj7s7385nb1g-a.oregon-postgres.render.com/cosmetick_ua',
  ssl: { rejectUnauthorized: false },
});

async function migrateImages() {
  const imagesDir = 'C:/Users/pushy/Desktop/Work/ek/price-ua/cosmetick-frontend/public/img'; // Шлях до папки із зображеннями
  const imageUrlPrefix = '/img/'; // Префікс для image_url у базі

  // Отримуємо всі записи з таблиці product_images
  let imageRecords;
  try {
    const result = await pool.query('SELECT product_id, image_url FROM product_images');
    imageRecords = result.rows;
    console.log(`Знайдено ${imageRecords.length} записів у таблиці product_images`);
    console.log('Записи в product_images:');
    imageRecords.forEach(record => {
      console.log(`product_id=${record.product_id}, image_url=${record.image_url}`);
    });
  } catch (err) {
    console.error('Помилка отримання записів із product_images:', err);
    await pool.end();
    process.exit(1);
  }

  // Створюємо мапу для зіставлення імені файлу з масивом product_id
  const imageMap = {};
  for (const record of imageRecords) {
    if (record.image_url.startsWith('https://res.cloudinary.com')) {
      console.log(`Пропущено: image_url=${record.image_url} для product_id=${record.product_id} (вже в Cloudinary)`);
      continue;
    }
    const fileName = record.image_url.split('/').pop();
    if (fileName) {
      if (!imageMap[fileName]) {
        imageMap[fileName] = [];
      }
      imageMap[fileName].push(record.product_id);
    } else {
      console.warn(`Некоректний image_url: ${record.image_url} для product_id=${record.product_id}`);
    }
  }
  console.log('imageMap:', imageMap);

  // Зчитуємо файли з папки
  let files;
  try {
    files = fs.readdirSync(imagesDir);
    console.log(`Знайдено ${files.length} файлів у папці ${imagesDir}:`, files);
  } catch (err) {
    console.error('Помилка читання папки зображень:', err);
    await pool.end();
    process.exit(1);
  }

  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const file of files) {
    // Перевіряємо, чи відповідає ім’я файлу формату product1_<image_number>.webp
    const match = file.match(/^product1_(\d+)\.webp$/);
    if (!match) {
      console.log(`Пропущено: Файл ${file} не відповідає формату product1_<image_number>.webp`);
      skippedCount++;
      continue;
    }

    const imageNumber = parseInt(match[1], 10);

    // Перевіряємо, чи image_number від 1 до 7
    if (imageNumber < 1 || imageNumber > 7) {
      console.log(`Пропущено: Файл ${file} має недопустимий номер зображення (${imageNumber})`);
      skippedCount++;
      continue;
    }

    // Отримуємо список product_id із imageMap
    const productIds = imageMap[file];
    if (!productIds || productIds.length === 0) {
      console.log(`Пропущено: Зображення ${file} не знайдено в базі (image_url не містить ${imageUrlPrefix}${file})`);
      skippedCount++;
      continue;
    }

    const filePath = path.join(imagesDir, file);

    try {
      // Завантаження зображення в Cloudinary
      const result = await cloudinary.uploader.upload(filePath, {
        folder: 'products',
        public_id: `product1_${imageNumber}`,
        overwrite: true,
      });

      const newImageUrl = result.secure_url;

      // Оновлення всіх записів для цього image_url
      for (const productId of productIds) {
        const oldImageUrl = `${imageUrlPrefix}${file}`;

        const dbResult = await pool.query(
          `UPDATE product_images
           SET image_url = $1
           WHERE product_id = $2 AND image_url = $3
           RETURNING id, image_url`,
          [newImageUrl, productId, oldImageUrl]
        );

        if (dbResult.rows.length > 0) {
          console.log(`Успіх: Зображення ${file} перенесено для product_id=${productId}: ${newImageUrl}`);
          migratedCount++;
        } else {
          console.log(`Пропущено: Зображення ${file} не оновлено: не знайдено запису з image_url=${oldImageUrl} для product_id=${productId}`);
          skippedCount++;
        }
      }
    } catch (err) {
      console.error(`Помилка перенесення зображення ${file}:`, err.message);
      errorCount++;
    }
  }

  console.log(`\nМіграція завершена: `);
  console.log(`- Перенесено: ${migratedCount} зображень`);
  console.log(`- Пропущено: ${skippedCount} зображень`);
  console.log(`- Помилок: ${errorCount}`);
  await pool.end();
}

migrateImages().catch(err => {
  console.error('Критична помилка виконання міграції:', err);
  process.exit(1);
});