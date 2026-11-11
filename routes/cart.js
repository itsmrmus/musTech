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

// ── POST /api/cart-events/lead — public ───────────────────
// Appelé quand le client clique sur 🛒 alors qu'il a déjà rempli (une partie
// de) ses infos : elles apparaissent dans l'onglet "Paniers" de l'admin.
// 1 ligne par visiteur (session_id). Si { confirmed: true } : le client a
// confirmé sa commande → ses infos sont dans "Commandes", on supprime la ligne.
router.post("/lead", cartRateLimiter, optionalAuth, async (req, res) => {
  try {
    if (req.user?.role === "admin") return res.json({ ok: true, skipped: true });

    const clean = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const sessionId = clean(req.body.session_id, 40);
    if (!sessionId) return res.status(400).json({ error: "Session invalide" });

    if (req.body.confirmed === true) {
      await db.query("DELETE FROM cart_leads WHERE session_id = $1", [sessionId]);
      return res.json({ ok: true, removed: true });
    }

    const name = clean(req.body.name, 100);
    const phone = clean(req.body.phone, 20);
    if (!name && !phone)
      return res.status(400).json({ error: "Nom ou téléphone requis" });

    // Articles : les noms viennent de la base (jamais du client)
    const wanted = (Array.isArray(req.body.items) ? req.body.items : [])
      .slice(0, 20)
      .map((i) => ({
        id: Number(i?.id),
        variant: Number.isInteger(Number(i?.variant)) ? Number(i.variant) : 0,
        qty: Math.min(Math.max(parseInt(i?.qty) || 1, 1), 99),
      }))
      .filter((i) => Number.isInteger(i.id) && i.id > 0);

    let items = [];
    if (wanted.length) {
      const ids = [...new Set(wanted.map((i) => i.id))];
      const { rows } = await db.query(
        "SELECT id, name, variants FROM products WHERE id = ANY($1::int[]) AND active = 1",
        [ids],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      items = wanted
        .filter((i) => byId.has(i.id))
        .map((i) => {
          const p = byId.get(i.id);
          let variantLabel = null;
          try {
            variantLabel = JSON.parse(p.variants || "[]")[i.variant] || null;
          } catch {}
          return { name: p.name, variant: variantLabel, qty: i.qty };
        });
    }

    await db.query(
      `INSERT INTO cart_leads
         (session_id, customer_name, phone, wilaya, address, items, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (session_id) DO UPDATE SET
         customer_name = EXCLUDED.customer_name,
         phone         = EXCLUDED.phone,
         wilaya        = EXCLUDED.wilaya,
         address       = EXCLUDED.address,
         items         = EXCLUDED.items,
         user_id       = EXCLUDED.user_id,
         updated_at    = NOW()`,
      [
        sessionId,
        name || null,
        phone || null,
        clean(req.body.wilaya, 60) || null,
        clean(req.body.address, 300) || null,
        JSON.stringify(items),
        req.user?.id || null,
      ],
    );

    if (Math.random() < 0.01) {
      db.query(
        "DELETE FROM cart_leads WHERE updated_at < NOW() - INTERVAL '30 days'",
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
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const { rows } = await db.query(
      `SELECT id, product_id, product_name, variant_label, qty,
              session_id, user_id, user_name, created_at
       FROM cart_events
       WHERE id > $1
       ORDER BY id DESC
       LIMIT $2`,
      [after, limit],
    );
    const stats = await db.query(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT session_id) AS visitors
       FROM cart_events
       WHERE created_at >= date_trunc('day', NOW())`,
    );
    const top = await db.query(
      `SELECT product_name, SUM(qty) AS qty
       FROM cart_events
       WHERE created_at >= date_trunc('day', NOW())
       GROUP BY product_name
       ORDER BY qty DESC
       LIMIT 1`,
    );
    const latest = await db.query("SELECT COALESCE(MAX(id),0) AS m FROM cart_events");
    // Ne doit jamais empêcher l'onglet Paniers de s'afficher
    let leads = [];
    try {
      const leadsRes = await db.query(
        `SELECT id, customer_name, phone, wilaya, address, items,
                created_at, updated_at
         FROM cart_leads
         ORDER BY updated_at DESC
         LIMIT 100`,
      );
      leads = leadsRes.rows.map((l) => {
        let items = [];
        try {
          items = JSON.parse(l.items || "[]");
        } catch {}
        return { ...l, items };
      });
    } catch (e) {
      console.error("cart_leads:", e.message);
    }
    res.json({
      leads,
      events: rows,
      latest_id: parseInt(latest.rows[0].m),
      today_adds: parseInt(stats.rows[0].total),
      today_visitors: parseInt(stats.rows[0].visitors),
      today_top: top.rows[0]
        ? { name: top.rows[0].product_name, qty: parseInt(top.rows[0].qty) }
        : null,
    });
  } catch (err) {
    ERR(err, res);
  }
});

// ── DELETE /api/cart-events — admin : vider l'historique ───
router.delete("/", adminMiddleware, async (req, res) => {
  try {
    await db.query("DELETE FROM cart_events");
    await db.query("DELETE FROM cart_leads");
    res.json({ ok: true });
  } catch (err) {
    ERR(err, res);
  }
});

module.exports = router;
