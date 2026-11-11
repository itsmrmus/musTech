const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      name        TEXT    NOT NULL,
      email       TEXT    NOT NULL UNIQUE,
      phone       TEXT,
      password    TEXT    NOT NULL,
      role        TEXT    NOT NULL DEFAULT 'user',
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id          SERIAL PRIMARY KEY,
      name        TEXT    NOT NULL UNIQUE,
      icon        TEXT    DEFAULT '🏷️',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id              SERIAL PRIMARY KEY,
      name            TEXT    NOT NULL,
      cat             TEXT    NOT NULL,
      price           INTEGER NOT NULL,
      old_price       INTEGER,
      icon            TEXT    DEFAULT '📦',
      img             TEXT,
      images          TEXT    DEFAULT '[]',
      rating          REAL    DEFAULT 5.0,
      reviews         INTEGER DEFAULT 0,
      variants        TEXT    NOT NULL DEFAULT '["Standard"]',
      variant_prices  TEXT    NOT NULL DEFAULT '[0]',
      variant_stocks  TEXT    NOT NULL DEFAULT '[0]',
      stock           INTEGER NOT NULL DEFAULT 0,
      badge           TEXT,
      description     TEXT,
      cost_price      INTEGER DEFAULT 0,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      order_ref   TEXT    NOT NULL UNIQUE,
      user_id     INTEGER REFERENCES users(id),
      customer    TEXT    NOT NULL,
      phone       TEXT    NOT NULL,
      wilaya      TEXT    NOT NULL,
      address     TEXT,
      items       TEXT    NOT NULL,
      subtotal    INTEGER NOT NULL,
      shipping    INTEGER NOT NULL DEFAULT 0,
      total       INTEGER NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending',
      notes       TEXT,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER,
      order_ref   TEXT,
      product_id  INTEGER,
      author_name TEXT,
      rating      INTEGER NOT NULL,
      comment     TEXT,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wilayas (
      id              INTEGER PRIMARY KEY,
      name            TEXT    NOT NULL,
      shipping_price  INTEGER NOT NULL DEFAULT 800,
      bureau_price    INTEGER NOT NULL DEFAULT 600,
      active          INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Add promo columns to orders if they don't exist (migration)
  await pool.query(
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code TEXT;`,
  );
  await pool.query(
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_discount INTEGER NOT NULL DEFAULT 0;`,
  );

  // Add variant_stocks column if it doesn't exist (migration)
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_stocks TEXT NOT NULL DEFAULT '[0]';
  `);

  // Add status column to products if it doesn't exist (migration)
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'in_stock';
  `);

  // ── NEW MIGRATION: Add pinned column to orders ──────────────────
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS pinned INTEGER NOT NULL DEFAULT 0;
  `);

  // ── MIGRATION: Add sort_order to products ────────────────────────
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER;
  `);
  // Initialize sort_order for existing products that don't have it yet
  await pool.query(`
    UPDATE products SET sort_order = id WHERE sort_order IS NULL;
  `);

  // ── MIGRATION: Add product_id + author_name to ratings (avis par produit) ──
  await pool.query(`
    ALTER TABLE ratings ADD COLUMN IF NOT EXISTS product_id INTEGER;
  `);
  await pool.query(`
    ALTER TABLE ratings ADD COLUMN IF NOT EXISTS author_name TEXT;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ratings_product_id ON ratings(product_id);
  `);

  // ── MIGRATION: Track whether stock was already deducted for an order ──
  // Le stock n'est plus décompté à la création de la commande, mais
  // seulement quand elle passe en "shipped" ou "delivered". Cette
  // colonne évite de décompter/restaurer le stock plusieurs fois.
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_deducted INTEGER NOT NULL DEFAULT 0;
  `);

  // ── MIGRATION: journal des "ajouts au panier" (notifications admin) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cart_events (
      id            SERIAL PRIMARY KEY,
      product_id    INTEGER NOT NULL,
      product_name  TEXT    NOT NULL,
      variant_label TEXT,
      qty           INTEGER NOT NULL DEFAULT 1,
      session_id    TEXT,
      user_id       INTEGER,
      user_name     TEXT,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_cart_events_created ON cart_events(created_at DESC);`,
  );

  // ── MIGRATION: infos client saisies quand il clique sur 🛒 (onglet admin Paniers) ──
  // Supprimées dès qu'il confirme sa commande (elles sont alors dans "Commandes").
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cart_leads (
      id            SERIAL PRIMARY KEY,
      session_id    TEXT NOT NULL UNIQUE,
      customer_name TEXT,
      phone         TEXT,
      wilaya        TEXT,
      address       TEXT,
      items         TEXT NOT NULL DEFAULT '[]',
      user_id       INTEGER,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_cart_leads_updated ON cart_leads(updated_at DESC);`,
  );

  // Sync status for existing products based on current stock
  await pool.query(`
    UPDATE products SET status = CASE WHEN stock <= 0 THEN 'out_of_stock' ELSE 'in_stock' END;
  `);

  // Seed categories if empty
  const { rows: catRows } = await pool.query(
    "SELECT COUNT(*) as c FROM categories",
  );
  if (parseInt(catRows[0].c) === 0) {
    const defaultCats = [
      ["Cosmétiques PC", "💄"],
      ["Écrans", "🖥️"],
      ["Souris", "🖱️"],
      ["Pâte Thermique", "🧪"],
    ];
    for (const [name, icon] of defaultCats) {
      await pool.query(
        "INSERT INTO categories (name, icon) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
        [name, icon],
      );
    }
    console.log("✅ Default categories seeded");
  }

  // ── SEED WILAYAS ─────────────────────────────────────────
  const { rows } = await pool.query("SELECT COUNT(*) as c FROM wilayas");
  if (parseInt(rows[0].c) === 0) {
    const ALL_WILAYAS = [
      [1, "Adrar", 1200, 900],
      [2, "Chlef", 900, 700],
      [3, "Laghouat", 1000, 750],
      [4, "Oum El Bouaghi", 900, 700],
      [5, "Batna", 900, 700],
      [6, "Béjaïa", 800, 600],
      [7, "Biskra", 1000, 750],
      [8, "Béchar", 1200, 900],
      [9, "Blida", 700, 500],
      [10, "Bouira", 750, 550],
      [11, "Tamanrasset", 1500, 1200],
      [12, "Tébessa", 1000, 750],
      [13, "Tlemcen", 1000, 750],
      [14, "Tiaret", 950, 700],
      [15, "Tizi Ouzou", 800, 600],
      [16, "Alger", 600, 400],
      [17, "Djelfa", 950, 700],
      [18, "Jijel", 850, 650],
      [19, "Sétif", 850, 650],
      [20, "Saïda", 1000, 750],
      [21, "Skikda", 900, 700],
      [22, "Sidi Bel Abbès", 1000, 750],
      [23, "Annaba", 900, 700],
      [24, "Guelma", 950, 700],
      [25, "Constantine", 850, 650],
      [26, "Médéa", 750, 550],
      [27, "Mostaganem", 950, 700],
      [28, "M'Sila", 900, 700],
      [29, "Mascara", 1000, 750],
      [30, "Ouargla", 1100, 850],
      [31, "Oran", 900, 700],
      [32, "El Bayadh", 1100, 850],
      [33, "Illizi", 1500, 1200],
      [34, "Bordj Bou Arréridj", 850, 650],
      [35, "Boumerdès", 700, 500],
      [36, "El Tarf", 950, 700],
      [37, "Tindouf", 1500, 1200],
      [38, "Tissemsilt", 950, 700],
      [39, "El Oued", 1100, 850],
      [40, "Khenchela", 950, 700],
      [41, "Souk Ahras", 950, 700],
      [42, "Tipaza", 700, 500],
      [43, "Mila", 900, 700],
      [44, "Aïn Defla", 800, 600],
      [45, "Naâma", 1100, 850],
      [46, "Aïn Témouchent", 1000, 750],
      [47, "Ghardaïa", 1100, 850],
      [48, "Relizane", 1000, 750],
      [49, "Timimoun", 1300, 1000],
      [50, "Bordj Badji Mokhtar", 1500, 1200],
      [51, "Ouled Djellal", 1100, 850],
      [52, "Béni Abbès", 1200, 900],
      [53, "In Salah", 1400, 1100],
      [54, "In Guezzam", 1500, 1200],
      [55, "Touggourt", 1100, 850],
      [56, "Djanet", 1500, 1200],
      [57, "El M'Ghair", 1100, 850],
      [58, "El Menia", 1200, 900],
      [59, "Ain Temouchent (Hassasna)", 1000, 750],
      [60, "El Eulma", 900, 700],
      [61, "Bir El Djir", 900, 700],
      [62, "Hammam Bou Hadjar", 1000, 750],
      [63, "Salah Bay", 900, 700],
      [64, "Ain Oussera", 950, 700],
      [65, "Robbah", 1100, 850],
      [66, "Mechraa Sfa", 950, 700],
      [67, "Sfizef", 1000, 750],
      [68, "Hadjout", 700, 500],
      [69, "El Amria", 1000, 750],
    ];
    for (const [id, name, sp, bp] of ALL_WILAYAS) {
      await pool.query(
        "INSERT INTO wilayas (id, name, shipping_price, bureau_price) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
        [id, name, sp, bp],
      );
    }
    console.log("✅ 69 wilayas seeded");
  }

  // ── SEED ADMIN ────────────────────────────────────────────
  const { rows: users } = await pool.query("SELECT COUNT(*) as c FROM users");
  if (parseInt(users[0].c) === 0) {
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
      throw new Error(
        "❌ ADMIN_EMAIL et ADMIN_PASSWORD doivent être définis dans les variables d'environnement.",
      );
    }
    const bcrypt = require("bcryptjs");
    const adminPass = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    await pool.query(
      "INSERT INTO users (name, email, phone, password, role) VALUES ($1,$2,$3,$4,$5)",
      [
        "Admin",
        process.env.ADMIN_EMAIL,
        process.env.ADMIN_PHONE || null,
        adminPass,
        "admin",
      ],
    );
    console.log("✅ Admin user created");
  }

  console.log("✅ PostgreSQL database ready");
}

initDB().catch((err) => {
  console.error("❌ DB init error:", err);
  process.exit(1);
});

module.exports = pool;

// Migration: add cost_price column if not exists
pool
  .query(
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price INTEGER DEFAULT 0",
  )
  .catch(() => {});
