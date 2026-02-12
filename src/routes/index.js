const express = require('express');
const authRoutes = require('./auth.routes');
const productRoutes = require('./product.routes');
const wishlistRoutes = require('./wishlist.routes');
const adminRoutes = require('./admin.routes');
const publicRoutes = require('./public.routes');

const router = express.Router();

// Mount routes
router.use('/', authRoutes);
router.use('/products', productRoutes);
router.use('/saved-products', wishlistRoutes);
router.use('/admin', adminRoutes);
router.use('/', publicRoutes);

module.exports = router;
