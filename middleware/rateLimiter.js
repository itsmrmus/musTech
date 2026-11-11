const {
  RateLimiterRedis,
  RateLimiterMemory,
} = require("rate-limiter-flexible");
const Redis = require("ioredis");

// ── CONNEXION REDIS ───────────────────────────────────────
let redisClient = null;

if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    enableOfflineQueue: false,
    lazyConnect: true,
  });

  redisClient.on("connect", () => console.log("✅ Redis connecté"));
  redisClient.on("error", (err) =>
    console.error("❌ Redis erreur:", err.message),
  );
}

// ── FACTORY ───────────────────────────────────────────────
function createLimiter(opts) {
  if (redisClient) {
    return new RateLimiterRedis({ storeClient: redisClient, ...opts });
  }
  console.warn(
    `⚠️  Rate limiter "${opts.keyPrefix}" en mode RAM (pas de Redis)`,
  );
  return new RateLimiterMemory(opts);
}

// ── LIMITERS ──────────────────────────────────────────────
const loginLimiter = createLimiter({
  keyPrefix: "rl_login",
  points: 10,
  duration: 15 * 60,
  blockDuration: 15 * 60,
});

const registerLimiter = createLimiter({
  keyPrefix: "rl_register",
  points: 5,
  duration: 60 * 60,
  blockDuration: 60 * 60,
});

const orderLimiter = createLimiter({
  keyPrefix: "rl_order",
  points: 5,
  duration: 60 * 60,
  blockDuration: 60 * 60,
});

// FIX: rate limit avis — 3 avis max par heure par IP
const ratingsLimiter = createLimiter({
  keyPrefix: "rl_ratings",
  points: 3,
  duration: 60 * 60,
  blockDuration: 60 * 60,
});

// Ajouts au panier — 30 événements max par minute par IP
const cartLimiter = createLimiter({
  keyPrefix: "rl_cart",
  points: 30,
  duration: 60,
  blockDuration: 60,
});

// ── MIDDLEWARE FACTORY ────────────────────────────────────
function makeMiddleware(limiter, errorMsg) {
  return async (req, res, next) => {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";
    try {
      await limiter.consume(ip);
      next();
    } catch {
      res.status(429).json({ error: errorMsg });
    }
  };
}

module.exports = {
  loginRateLimiter: makeMiddleware(
    loginLimiter,
    "Trop de tentatives de connexion. Réessayez dans 15 minutes.",
  ),
  registerRateLimiter: makeMiddleware(
    registerLimiter,
    "Trop de créations de compte. Réessayez dans une heure.",
  ),
  orderRateLimiter: makeMiddleware(
    orderLimiter,
    "Trop de commandes. Réessayez dans une heure.",
  ),
  cartRateLimiter: makeMiddleware(
    cartLimiter,
    "Trop de requêtes. Réessayez dans une minute.",
  ),
  ratingsRateLimiter: makeMiddleware(
    ratingsLimiter,
    "Trop d'avis envoyés. Réessayez dans une heure.",
  ),
};
