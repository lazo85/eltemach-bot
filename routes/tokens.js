const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const PACKAGES = [
  { id: 'pack_10', tokens: 10, price_usd: 10, label: '10 tokens', sublabel: '$10 USD' },
  { id: 'pack_20', tokens: 20, price_usd: 15, label: '20 tokens', sublabel: '$15 USD', popular: true }
];

// GET /api/tokens/packages
router.get('/packages', (req, res) => {
  res.json(PACKAGES);
});

// POST /api/tokens/request
router.post('/request', authMiddleware, (req, res) => {
  const { packageId } = req.body;
  const pkg = PACKAGES.find(p => p.id === packageId);
  if (!pkg) return res.status(400).json({ error: 'Paquete no válido' });

  const db = getDb();

  // Evitar solicitudes duplicadas pendientes
  const pending = db.prepare(
    "SELECT id FROM purchase_requests WHERE user_id = ? AND status = 'pending'"
  ).get(req.user.id);
  if (pending)
    return res.status(409).json({ error: 'Ya tienes una solicitud pendiente. Espera a que sea procesada.' });

  db.prepare(
    'INSERT INTO purchase_requests (user_id, package_id, tokens, price_usd) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, pkg.id, pkg.tokens, pkg.price_usd);

  res.json({
    success: true,
    message: `Solicitud enviada. Recibirás ${pkg.tokens} tokens una vez confirmado el pago de $${pkg.price_usd} USD.`
  });
});

module.exports = router;
