const express = require('express');
const router = express.Router();
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { getDb } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const PACKAGES = {
  pack_10: { tokens: 10, price_usd: 10, label: '10 Tokens — ElTemAIch' },
  pack_20: { tokens: 20, price_usd: 15, label: '20 Tokens — ElTemAIch' }
};

function getMpClient() {
  return new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN
  });
}

function getBaseUrl() {
  return process.env.APP_URL || 'http://localhost:3001';
}

// POST /api/payments/create — crea preferencia de pago
router.post('/create', authMiddleware, async (req, res) => {
  const { packageId } = req.body;
  const pkg = PACKAGES[packageId];
  if (!pkg) return res.status(400).json({ error: 'Paquete no válido' });

  if (!process.env.MERCADOPAGO_ACCESS_TOKEN)
    return res.status(503).json({ error: 'MercadoPago no configurado' });

  const baseUrl = getBaseUrl();

  try {
    const preference = new Preference(getMpClient());
    const response = await preference.create({
      body: {
        items: [{
          id: packageId,
          title: pkg.label,
          quantity: 1,
          unit_price: pkg.price_usd,
          currency_id: 'USD'
        }],
        payer: {
          email: req.user.email
        },
        back_urls: {
          success: `${baseUrl}/payment/success`,
          failure: `${baseUrl}/payment/failure`,
          pending: `${baseUrl}/payment/pending`
        },
        auto_return: 'approved',
        notification_url: `${baseUrl}/api/payments/webhook`,
        metadata: {
          user_id: req.user.id,
          package_id: packageId,
          tokens: pkg.tokens
        },
        external_reference: `${req.user.id}:${packageId}:${Date.now()}`
      }
    });

    // Guardar preferencia pendiente
    getDb().prepare(
      'INSERT INTO payments (user_id, mp_preference_id, package_id, tokens, amount_usd) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, response.id, packageId, pkg.tokens, pkg.price_usd);

    res.json({
      preferenceId: response.id,
      initPoint: response.init_point,       // producción
      sandboxInitPoint: response.sandbox_init_point // pruebas
    });
  } catch (err) {
    console.error('[MercadoPago] Error creando preferencia:', err.message);
    res.status(500).json({ error: 'Error al crear el pago' });
  }
});

// POST /api/payments/webhook — MercadoPago notifica aquí
router.post('/webhook', express.json(), async (req, res) => {
  const { type, data } = req.body;

  if (type !== 'payment') return res.sendStatus(200);

  try {
    const payment = new Payment(getMpClient());
    const paymentData = await payment.get({ id: data.id });

    if (paymentData.status !== 'approved') return res.sendStatus(200);

    const db = getDb();
    const existing = db.prepare('SELECT id FROM payments WHERE mp_payment_id = ?').get(String(data.id));
    if (existing) return res.sendStatus(200); // ya procesado

    const { user_id, package_id, tokens } = paymentData.metadata || {};
    if (!user_id || !tokens) return res.sendStatus(200);

    // Acreditar tokens
    db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?').run(tokens, user_id);
    db.prepare(
      'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)'
    ).run(user_id, 'purchase', tokens, `Compra MercadoPago — ${package_id} (${tokens} tokens)`);

    // Actualizar estado del pago
    db.prepare(
      'UPDATE payments SET mp_payment_id = ?, status = ? WHERE mp_preference_id = ? AND user_id = ?'
    ).run(String(data.id), 'approved', paymentData.preference_id, user_id);

    console.log(`[MercadoPago] Pago aprobado: user ${user_id} +${tokens} tokens`);
    res.sendStatus(200);
  } catch (err) {
    console.error('[MercadoPago] Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// GET /api/payments/history
router.get('/history', authMiddleware, (req, res) => {
  const payments = getDb().prepare(
    'SELECT package_id, tokens, amount_usd, status, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
  ).all(req.user.id);
  res.json(payments);
});

module.exports = router;
