const jwt = require('jsonwebtoken');
const { getDb } = require('../database/db');

const JWT_SECRET = process.env.JWT_SECRET || 'eltemach-secret-changeme';

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getDb()
      .prepare('SELECT id, email, username, tokens, is_admin FROM users WHERE id = ?')
      .get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Acceso denegado' });
    next();
  });
}

module.exports = { authMiddleware, adminMiddleware, JWT_SECRET };
