const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { adminMiddleware } = require('../middleware/auth');

// GET /api/admin/users
router.get('/users', adminMiddleware, (req, res) => {
  const db = getDb();
  const users = db.prepare(
    'SELECT id, email, username, tokens, is_admin, created_at FROM users ORDER BY created_at DESC'
  ).all();
  res.json(users);
});

// POST /api/admin/add-tokens
router.post('/add-tokens', adminMiddleware, (req, res) => {
  const { userId, amount, description } = req.body;
  if (!userId || !amount || amount <= 0)
    return res.status(400).json({ error: 'userId y amount (positivo) requeridos' });

  const db = getDb();
  const user = db.prepare('SELECT id, username, tokens FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?').run(amount, userId);
  db.prepare(
    'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)'
  ).run(userId, 'admin_grant', amount, description || `Admin agregó ${amount} tokens`);

  const updated = db.prepare('SELECT tokens FROM users WHERE id = ?').get(userId);
  res.json({ success: true, username: user.username, newBalance: updated.tokens });
});

// GET /api/admin/purchases
router.get('/purchases', adminMiddleware, (req, res) => {
  const db = getDb();
  const requests = db.prepare(`
    SELECT pr.id, pr.package_id, pr.tokens, pr.price_usd, pr.status, pr.created_at,
           u.username, u.email
    FROM purchase_requests pr
    JOIN users u ON pr.user_id = u.id
    ORDER BY pr.created_at DESC
  `).all();
  res.json(requests);
});

// POST /api/admin/approve-purchase
router.post('/approve-purchase', adminMiddleware, (req, res) => {
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: 'requestId requerido' });

  const db = getDb();
  const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ? AND status = ?').get(requestId, 'pending');
  if (!pr) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });

  db.prepare('UPDATE purchase_requests SET status = ? WHERE id = ?').run('approved', requestId);
  db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?').run(pr.tokens, pr.user_id);
  db.prepare(
    'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)'
  ).run(pr.user_id, 'purchase', pr.tokens, `Compra aprobada — paquete ${pr.package_id} (${pr.tokens} tokens)`);

  res.json({ success: true });
});

// POST /api/admin/reject-purchase
router.post('/reject-purchase', adminMiddleware, (req, res) => {
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: 'requestId requerido' });

  const db = getDb();
  const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ? AND status = ?').get(requestId, 'pending');
  if (!pr) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });

  db.prepare('UPDATE purchase_requests SET status = ? WHERE id = ?').run('rejected', requestId);
  res.json({ success: true });
});

// GET /api/admin/stats
router.get('/stats', adminMiddleware, (req, res) => {
  const db = getDb();
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 0').get().c;
  const pendingPurchases = db.prepare("SELECT COUNT(*) as c FROM purchase_requests WHERE status = 'pending'").get().c;
  const totalTokensSold = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE type = 'purchase'").get().t;
  res.json({ totalUsers, pendingPurchases, totalTokensSold });
});

module.exports = router;
