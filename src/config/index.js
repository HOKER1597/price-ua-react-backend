const { pool } = require('./database');
const { cloudinary, upload } = require('./cloudinary');

const JWT_SECRET = process.env.JWT_SECRET || 'fc0432fb054d94da265cd6e565721b49f66d7a447cdaa76fe30d0214bf20b24220179d3fcd5eea298bedbead28c2636f3ca65baf668cd89ad679ef99b36f43db';

module.exports = {
  pool,
  cloudinary,
  upload,
  JWT_SECRET,
};
