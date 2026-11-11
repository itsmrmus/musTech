// ============================================================
//  Mus Tech — API Helper
//  Auth via cookie HttpOnly — le token n'est JAMAIS
//  accessible en JavaScript (protection XSS totale)
// ============================================================

// L'app est servie par le même serveur Express que l'API (server.js
// fait app.use(express.static(...)) sur ce même dossier "public").
// On utilise donc une URL relative "/api" : le frontend et l'API sont
// alors strictement "same-origin", ce qui évite le blocage du cookie
// de session par Safari iOS (Prevent Cross-Site Tracking / ITP bloque
// les cookies SameSite=None envoyés vers un domaine différent — c'est
// ce qui causait la déconnexion ~2s après la connexion admin sur iPhone).
const API_URL = "/api";

// ── AUTH STATE (en mémoire uniquement — pas de localStorage) ─
// On garde juste les infos non-sensibles de l'utilisateur
// pour afficher son nom/rôle dans l'UI.
// Le vrai token de sécurité est dans le cookie HttpOnly géré
// par le navigateur — JS ne peut pas y toucher.
const Auth = {
  _user: null,

  getUser: () => Auth._user,
  setUser: (u) => {
    Auth._user = u;
  },
  removeUser: () => {
    Auth._user = null;
  },
  isLoggedIn: () => !!Auth._user,

  // Compatibilité — plus de token côté JS
  getToken: () => null,
};

// ── BASE FETCH ────────────────────────────────────────────
// credentials: "include" envoie automatiquement le cookie
// HttpOnly avec chaque requête — sans que JS voie le token
async function apiFetch(endpoint, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };

  const res = await fetch(API_URL + endpoint, {
    ...options,
    headers,
    credentials: "include", // ← envoie le cookie HttpOnly automatiquement
    cache: "no-store", // ← toujours récupérer les données fraîches (prix, stock…)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erreur serveur");
  return data;
}

// ── AUTH API ──────────────────────────────────────────────
const AuthAPI = {
  async login(email, password) {
    const data = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    // Le cookie est posé par le serveur automatiquement
    // On garde juste les infos UI en mémoire
    Auth.setUser(data.user);
    return data.user;
  },

  async register(name, email, phone, password) {
    const data = await apiFetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, phone, password }),
    });
    Auth.setUser(data.user);
    return data.user;
  },

  async logout() {
    try {
      // Demande au serveur d'effacer le cookie HttpOnly
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {}
    Auth.removeUser();
  },

  // Vérifie la session au chargement de la page
  async checkSession() {
    try {
      const user = await apiFetch("/auth/me");
      Auth.setUser(user);
      return user;
    } catch {
      Auth.removeUser();
      return null;
    }
  },
};

// ── PRODUCTS API ──────────────────────────────────────────
const ProductsAPI = {
  getAll: (cat, search) => {
    const params = new URLSearchParams();
    if (cat) params.set("cat", cat);
    if (search) params.set("search", search);
    const qs = params.toString();
    return apiFetch("/products" + (qs ? "?" + qs : ""));
  },
  getOne: (id) => apiFetch("/products/" + id),

  async create(formData) {
    const res = await fetch(API_URL + "/products", {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erreur");
    return data;
  },

  async update(id, formData) {
    const res = await fetch(API_URL + "/products/" + id, {
      method: "PUT",
      credentials: "include",
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erreur");
    return data;
  },

  delete: (id) => apiFetch("/products/" + id, { method: "DELETE" }),

  reorder: (order) =>
    apiFetch("/products/reorder", {
      method: "PATCH",
      body: JSON.stringify({ order }),
    }),

  getAdminAll: () => apiFetch("/products/admin/all"),
};

// ── ORDERS API ────────────────────────────────────────────
const OrdersAPI = {
  place: (orderData) =>
    apiFetch("/orders", { method: "POST", body: JSON.stringify(orderData) }),
  myOrders: () => apiFetch("/orders/my"),
  getAll: (status, page, limit) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (page) params.set("page", page);
    if (limit) params.set("limit", limit);
    const qs = params.toString();
    return apiFetch("/orders" + (qs ? "?" + qs : ""));
  },
  updateStatus: (id, status) =>
    apiFetch("/orders/" + id + "/status", {
      method: "PUT",
      body: JSON.stringify({ status }),
    }),
  delete: (id) => apiFetch("/orders/" + id, { method: "DELETE" }),
};

// ── WILAYAS API ───────────────────────────────────────────
const WilayasAPI = {
  getAll: () => apiFetch("/wilayas"),
  update: (id, data) =>
    apiFetch("/wilayas/" + id, { method: "PUT", body: JSON.stringify(data) }),
};

// ── RATINGS API ───────────────────────────────────────────
const RatingsAPI = {
  submit: (rating, comment, order_ref, product_id, author_name) =>
    apiFetch("/ratings", {
      method: "POST",
      body: JSON.stringify({
        rating,
        comment,
        order_ref,
        product_id,
        author_name,
      }),
    }),
  getStats: () => apiFetch("/ratings/stats"),
  getByProduct: (productId) => apiFetch("/ratings/product/" + productId),
};

// ── STATS API ─────────────────────────────────────────────
const StatsAPI = {
  get: () => apiFetch("/stats"),
};

// ── CART TRACKING API ─────────────────────────────────────
// Prévient le serveur (donc l'admin) qu'un produit a été ajouté au panier.
// "Fire and forget" : n'interrompt jamais l'achat si ça échoue.
const CartAPI = {
  _sid() {
    try {
      let id = localStorage.getItem("mt_sid");
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem("mt_sid", id);
      }
      return id;
    } catch {
      return null;
    }
  },
  track(productId, variant, qty) {
    try {
      fetch(API_URL + "/cart-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        keepalive: true,
        body: JSON.stringify({
          product_id: productId,
          variant: variant || 0,
          qty: qty || 1,
          session_id: CartAPI._sid(),
        }),
      }).catch(() => {});
    } catch {}
  },
  getEvents: (after) =>
    apiFetch("/cart-events" + (after ? "?after=" + after : "")),
};
