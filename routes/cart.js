const express = require("express");
const router = express.Router();
const db = require("../database");
const { adminMiddleware, optionalAuth } = require("../middleware/auth");
const { cartRateLimiter } = require("../middleware/rateLimiter");

const ERR = (err, res) =>
  res.status(500).json({
    error:
      process.env.NODE_ENV === "production"
        ? "Erreur serveur interne"
        : err.message,
  });

// ── POST /api/cart-events — public ────────────────────────
// Appelé par la boutique à chaque "Ajouter au panier".
// Le nom du produit vient de la base (jamais du client).
router.post("/", cartRateLimiter, optionalAuth, async (req, res) => {
  try {
    // Les tests de l'admin ne déclenchent pas de notification
    if (req.user?.role === "admin") return res.json({ ok: true, skipped: true });

    const productId = Number(req.body.product_id);
    const variant = Number.isInteger(Number(req.body.variant))
      ? Number(req.body.variant)
      : 0;
    const qty = Number(req.body.qty);
    const sessionId =
      typeof req.body.session_id === "string"
        ? req.body.session_id.slice(0, 40)
        : null;

    if (!Number.isInteger(productId) || productId < 1)
      return res.status(400).json({ error: "Produit invalide" });
    if (!Number.isInteger(qty) || qty < 1 || qty > 99)
      return res.status(400).json({ error: "Quantité invalide" });

    const { rows } = await db.query(
      "SELECT id, name, variants FROM products WHERE id = $1 AND active = 1",
      [productId],
    );
    if (!rows.length) return res.status(404).json({ error: "Produit introuvable" });

    let variantLabel = null;
    try {
      const variants = JSON.parse(rows[0].variants || "[]");
      variantLabel = variants[variant] || null;
    } catch {}

    let userName = null;
    if (req.user?.id) {
      const u = await db.query("SELECT name FROM users WHERE id = $1", [
        req.user.id,
      ]);
      userName = u.rows[0]?.name || null;
    }

    await db.query(
      `INSERT INTO cart_events
         (product_id, product_name, variant_label, qty, session_id, user_id, user_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        productId,
        rows[0].name,
        variantLabel,
        qty,
        sessionId,
        req.user?.id || null,
        userName,
      ],
    );

    // Nettoyage occasionnel : on garde 30 jours d'historique
    if (Math.random() < 0.01) {
      db.query(
        "DELETE FROM cart_events WHERE created_at < NOW() - INTERVAL '30 days'",
      ).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    ERR(err, res);
  }
});

// ── GET /api/cart-events — admin ──────────────────────────
// ?after=<id> : ne renvoie que les événements plus récents que cet id
router.get("/", adminMiddleware, async (req, res) => {
  try {
    const after = parseInt(req.query.after) || 0;
    const { rows } = await db.query(
      `SELECT id, product_id, product_name, variant_label, qty,
              session_id, user_id, user_name, created_at
       FROM cart_events
       WHERE id > $1
       ORDER BY id DESC
       LIMIT 50`,
      [after],
    );
    const stats = await db.query(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT session_id) AS visitors
       FROM cart_events
       WHERE created_at >= date_trunc('day', NOW())`,
    );
    const latest = await db.query("SELECT COALESCE(MAX(id),0) AS m FROM cart_events");
    res.json({
      events: rows,
      latest_id: parseInt(latest.rows[0].m),
      today_adds: parseInt(stats.rows[0].total),
      today_visitors: parseInt(stats.rows[0].visitors),
    });
  } catch (err) {
    ERR(err, res);
  }
});

module.exports = router;
