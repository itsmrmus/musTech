const express = require("express");
const router = express.Router();
const db = require("../database");
const {
  authMiddleware,
  adminMiddleware,
  optionalAuth,
} = require("../middleware/auth");
// FIX #5: Rate limiter Redis (persistant entre redémarrages)
const { orderRateLimiter } = require("../middleware/rateLimiter");
const { sendEvent } = require("../utils/metaCapi");

// Normalise un numéro algérien vers 0XXXXXXXXX
// Accepte: 0558210430 / +213558210430 / +2130558210430
function normalizeAlgerianPhone(phone) {
  const p = phone.replace(/\s/g, "");
  if (/^\+2130[5-7]\d{8}$/.test(p)) return "0" + p.slice(4);
  if (/^\+213[5-7]\d{8}$/.test(p)) return "0" + p.slice(3);
  if (/^0[5-7]\d{8}$/.test(p)) return p;
  return null;
}

async function generateRef() {
  const { rows } = await db.query("SELECT COUNT(*) as c FROM orders");
  // FIX #3: Suffixe aléatoire pour éviter les refs prédictibles
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return "#MT-" + String(parseInt(rows[0].c) + 1).padStart(4, "0") + "-" + rand;
}

function validateOrderInput({ customer, phone, wilaya, items }) {
  if (!customer || typeof customer !== "string" || customer.trim().length < 2)
    return "Nom invalide (minimum 2 caractères).";
  // FIX #8: Filtrer les caractères spéciaux/HTML dans le nom client
  if (/<[^>]*>/.test(customer))
    return "Nom invalide (caractères non autorisés).";
  const phoneClean = normalizeAlgerianPhone(phone || "");
  if (!phoneClean)
    return "Numéro de téléphone invalide (ex: 0558210430, +213558210430 ou +2130558210430).";
  if (!wilaya || typeof wilaya !== "string" || wilaya.trim().length < 2)
    return "Wilaya invalide.";
  if (!Array.isArray(items) || items.length === 0 || items.length > 20)
    return "Panier invalide.";
  for (const item of items) {
    if (!Number.isInteger(Number(item.id)) || Number(item.id) < 1)
      return "Produit invalide.";
    if (
      !Number.isInteger(Number(item.qty)) ||
      Number(item.qty) < 1 ||
      Number(item.qty) > 99
    )
      return "Quantité invalide.";
  }
  return null;
}

// ── POST /api/orders ──────────────────────────────────────
router.post("/", orderRateLimiter, optionalAuth, async (req, res) => {
  try {
    const {
      customer,
      phone,
      wilaya,
      wilaya_id,
      address,
      notes,
      items,
      shipping,
      promo_code,
      promo_discount,
    } = req.body;

    const validationError = validateOrderInput({
      customer,
      phone,
      wilaya,
      items,
    });
    if (validationError)
      return res.status(400).json({ error: validationError });

    let calculatedSubtotal = 0;
    const enrichedItems = [];

    for (const item of items) {
      const { rows } = await db.query(
        "SELECT * FROM products WHERE id = $1 AND active = 1",
        [parseInt(item.id)],
      );
      const product = rows[0];
      if (!product)
        return res
          .status(400)
          .json({ error: `Produit #${item.id} introuvable.` });

      const prices = JSON.parse(product.variant_prices);
      const variants = JSON.parse(product.variants);
      const variantStocks = JSON.parse(product.variant_stocks || "[]");
      const variantIndex = parseInt(item.variant) || 0;
      const price = prices[variantIndex] ?? prices[0];
      const qty = Math.min(99, Math.max(1, parseInt(item.qty) || 1));

      // Check stock for this specific variant
      const availableStock = variantStocks[variantIndex] ?? 0;
      // Allow order even if out of stock — admin will be notified

      calculatedSubtotal += price * qty;
      enrichedItems.push({
        id: product.id,
        name: product.name,
        variant: variants[variantIndex] || variants[0],
        variantIndex,
        price,
        qty,
        total: price * qty,
        outOfStock: availableStock < qty,
      });
    }

    const { rows: wRows } = await db.query(
      "SELECT * FROM wilayas WHERE id = $1",
      [wilaya_id],
    );
    const shippingPrice = wRows[0]
      ? wRows[0].shipping_price
      : parseInt(shipping) || 0;
    const validPromoDiscount = Math.min(
      parseInt(promo_discount) || 0,
      calculatedSubtotal,
    );
    const total =
      Math.max(0, calculatedSubtotal - validPromoDiscount) + shippingPrice;
    const orderRef = await generateRef();

    let userId = null;
    if (req.user) {
      const { rows: uRows } = await db.query(
        "SELECT id FROM users WHERE id = $1",
        [req.user.id],
      );
      if (uRows[0]) userId = uRows[0].id;
    }

    const { rows: inserted } = await db.query(
      `INSERT INTO orders (order_ref,user_id,customer,phone,wilaya,address,items,subtotal,shipping,total,notes,promo_code,promo_discount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        orderRef,
        userId,
        customer.trim().substring(0, 100),
        normalizeAlgerianPhone(phone) || phone.replace(/\s/g, ""),
        wilaya.trim().substring(0, 100),
        address ? address.trim().substring(0, 300) : null,
        JSON.stringify(enrichedItems),
        calculatedSubtotal,
        shippingPrice,
        total,
        notes ? notes.trim().substring(0, 500) : null,
        promo_code ? promo_code.trim().toUpperCase().substring(0, 20) : null,
        validPromoDiscount,
      ],
    );

    // FIX: le stock n'est plus décompté à la création de la commande
    // (status "pending") — il est décompté seulement quand l'admin
    // passe la commande en "Expédiée" ou "Livrée" (voir PUT /:id/status
    // plus bas), et restauré automatiquement si la commande est annulée.

    const order = inserted[0];

    // Meta Conversions API — Purchase (event_id = order_ref, identique au Pixel navigateur)
    sendEvent({
      eventName: "Purchase",
      eventId: orderRef,
      req,
      user: { name: customer, phone, city: wilaya },
      custom: {
        value: total,
        currency: "DZD",
        content_type: "product",
        content_ids: enrichedItems.map((i) => String(i.id)),
        num_items: enrichedItems.reduce((a, i) => a + i.qty, 0),
      },
    });
    res.status(201).json({
      ...order,
      items: JSON.parse(order.items),
      order_ref: orderRef,
      total_formatted: total.toLocaleString("fr-DZ") + " DA",
    });
  } catch (err) {
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Erreur serveur interne"
          : err.message,
    });
  }
});

// ── GET /api/orders/track/:ref ── public ─────────────────
router.get("/track/:ref", async (req, res) => {
  try {
    const raw = decodeURIComponent(req.params.ref).toUpperCase();
    const ref = raw.startsWith("#") ? raw : "#" + raw;
    const { rows } = await db.query(
      "SELECT id, order_ref, customer, wilaya, status, total, shipping, items, created_at, pinned FROM orders WHERE UPPER(order_ref) = $1",
      [ref],
    );
    if (!rows[0])
      return res.status(404).json({
        error: "Commande introuvable. Vérifiez le numéro (ex: #MT-0001).",
      });
    const o = rows[0];
    res.json({ ...o, items: JSON.parse(o.items) });
  } catch (err) {
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Erreur serveur interne"
          : err.message,
    });
  }
});

// ── GET /api/orders/my ────────────────────────────────────
// UPDATED: Now sorted by pinned DESC, then created_at DESC
router.get("/my", authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM orders WHERE user_id = $1 ORDER BY pinned DESC, created_at DESC",
      [req.user.id],
    );
    res.json(rows.map((o) => ({ ...o, items: JSON.parse(o.items) })));
  } catch (err) {
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Erreur serveur interne"
          : err.message,
    });
  }
});

// ── GET /api/orders ── admin ──────────────────────────────
// UPDATED: Now sorted by pinned DESC, then created_at DESC
router.get("/", adminMiddleware, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const params = [];
    let where = "";
    if (status) {
      params.push(status);
      where = `WHERE status = $${params.length}`;
    }
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    const { rows } = await db.query(
      `SELECT * FROM orders ${where} ORDER BY pinned DESC, created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) as c FROM orders ${status ? "WHERE status = $1" : ""}`,
      status ? [status] : [],
    );
    const total = parseInt(countRows[0].c);
    res.json({
      orders: rows.map((o) => ({ ...o, items: JSON.parse(o.items) })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Erreur serveur interne"
          : err.message,
    });
  }
});

router.get("/:id", adminMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM orders WHERE id = $1", [
      req.params.id,
    ]);
    if (!rows[0])
      return res.status(404).json({ error: "Commande non trouvée" });
    res.json({ ...rows[0], items: JSON.parse(rows[0].items) });
  } catch (err) {
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Erreur serveur interne"
          : err.message,
    });
  }
});

router.put("/:id/status", adminMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ["pending", "shipped", "delivered", "cancelled"];
    if (!allowed.includes(status))
      return res.status(400).json({ error: "Statut invalide" });

    const { rows } = await db.query(
      "SELECT id, status, items, stock_deducted FROM orders WHERE id = $1",
      [req.params.id],
    );
    if (!rows[0])
      return res.status(404).json({ error: "Commande non trouvée" });

    const order = rows[0];
    const items = JSON.parse(order.items);

    // FIX: le stock est décompté seulement quand la commande passe en
    // "Expédiée" ou "Livrée", et restauré dès qu'elle en sort (ex:
    // annulation). "stock_deducted" évite tout double-décompte/restauration
    // si on jongle entre les statuts (ex: shipped → delivered ne touche
    // pas le stock car déjà décompté une fois).
    const deductingStatuses = ["shipped", "delivered"];
    const wasDeducting = deductingStatuses.includes(order.status);
    const willBeDeducting = deductingStatuses.includes(status);

    if (!wasDeducting && willBeDeducting && !order.stock_deducted) {
      // Entrée en "Expédiée"/"Livrée" → décompter le stock
      for (const item of items) {
        const { rows: pRows } = await db.query(
          "SELECT variant_stocks FROM products WHERE id = $1",
          [item.id],
        );
        if (!pRows[0]) continue;

        const stocks = JSON.parse(pRows[0].variant_stocks || "[]");
        stocks[item.variantIndex] = (stocks[item.variantIndex] || 0) - item.qty;
        const totalStock = stocks.reduce((a, b) => a + b, 0);
        const newProductStatus = totalStock <= 0 ? "out_of_stock" : "in_stock";

        await db.query(
          "UPDATE products SET variant_stocks = $1, stock = $2, status = $3 WHERE id = $4",
          [JSON.stringify(stocks), totalStock, newProductStatus, item.id],
        );
      }
      await db.query("UPDATE orders SET stock_deducted = 1 WHERE id = $1", [
        req.params.id,
      ]);
    } else if (wasDeducting && !willBeDeducting && order.stock_deducted) {
      // Sortie de "Expédiée"/"Livrée" (ex: annulation, ou retour en attente) → restaurer le stock
      for (const item of items) {
        const { rows: pRows } = await db.query(
          "SELECT variant_stocks FROM products WHERE id = $1",
          [item.id],
        );
        if (!pRows[0]) continue;

        const stocks = JSON.parse(pRows[0].variant_stocks || "[]");
        stocks[item.variantIndex] = (stocks[item.variantIndex] || 0) + item.qty;
        const totalStock = stocks.reduce((a, b) => a + b, 0);
        const newProductStatus = totalStock <= 0 ? "out_of_stock" : "in_stock";

        await db.query(
          "UPDATE products SET variant_stocks = $1, stock = $2, status = $3 WHERE id = $4",
          [JSON.stringify(stocks), totalStock, newProductStatus, item.id],
        );
      }
      await db.query("UPDATE orders SET stock_deducted = 0 WHERE id = $1", [
        req.params.id,
      ]);
    }

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
      status,
      req.params.id,
    ]);
    res.json({ message: "Statut mis à jour", status });
  } catch (err) {
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Erreur serveur interne"
          : err.message,
    });
  }
});

// ── NEW ENDPOINT: PUT /api/orders/:id/pin ── admin ──────
// Toggle pin status for an order
router.put("/:id/pin", adminMiddleware, async (req, res) => {
  try {
    const { pinned } = req.body; // true to pin, false to unpin

    // Validate if order exists
    const { rows } = await db.query(
      "SELECT id, pinned FROM orders WHERE id = $1",
      [req.params.id],
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Commande non trouvée" });
    }

    const currentPinnedStatus = rows[0].pinned;
    const newPinnedStatus = pinned ? 1 : 0;

    // Only update if status is different
    if (currentPinnedStatus === newPinnedStatus) {
      return res.json({
        message: `Commande déjà ${pinned ? "épinglée" : "désépinglée"}`,
        pinned: newPinnedStatus,
      });
    }

    // Update the pinned status
    await db.query("UPDATE orders SET pinned = $1 WHERE id = $2", [
      newPinnedStatus,
      req.params.id,
    ]);

    res.json({
      message: `Commande ${pinned ? "épinglée" : "désépinglée"} avec succès`,
      pinned: newPinnedStatus,
    });
  } catch (err) {
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Erreur serveur interne"
          : err.message,
    });
  }
});

router.delete("/:id", adminMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT id FROM orders WHERE id = $1", [
      req.params.id,
    ]);
    if (!rows[0])
      return res.status(404).json({ error: "Commande non trouvée" });
    await db.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
    res.json({ message: "Commande supprimée" });
  } catch (err) {
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Erreur serveur interne"
          : err.message,
    });
  }
});

module.exports = router;
