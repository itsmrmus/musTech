// ============================================================
//  Mus Tech — Notifications "Ajout au panier" (ADMIN uniquement)
//  - Interroge /api/cart-events toutes les 15 s quand l'admin est connecté
//  - Cloche flottante 🛒 + compteur + panneau d'historique
//  - Toast + notification navigateur (si autorisée) à chaque nouvel ajout
//  Les visiteurs normaux ne font AUCUNE requête (le script reste inactif).
// ============================================================
(function () {
  const POLL_MS = 15000;
  const SEEN_KEY = "mt_cart_last_seen";
  let lastId = null; // dernier id déjà reçu
  let unread = 0;
  let events = []; // historique affiché (plus récent d'abord)
  let timer = null;
  let ui = null;
  const MAX = 200;
  let stats = { adds: 0, visitors: 0, top: null };
  // Sur admin.html : onglet "Paniers" dans le menu → pas de cloche flottante
  const embedded = () => !!document.getElementById("admin-carts");
  const tabOpen = () => {
    const t = document.getElementById("admin-carts");
    return !!t && t.style.display !== "none";
  };

  const isAdmin = () => {
    try {
      return Auth.getUser()?.role === "admin";
    } catch {
      return false;
    }
  };
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const ago = (d) => {
    const s = Math.max(
      0,
      Math.floor(
        (Date.now() - new Date(d + (/Z|\+/.test(d) ? "" : "Z")).getTime()) /
          1000,
      ),
    );
    if (s < 60) return "à l'instant";
    if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
    return `il y a ${Math.floor(s / 86400)} j`;
  };

  function injectBadgeCss() {
    if (document.getElementById("mt-cart-badge-css")) return;
    const st = document.createElement("style");
    st.id = "mt-cart-badge-css";
    st.textContent =
      ".mt-cart-badge{display:none;margin-left:6px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;align-items:center;justify-content:center;vertical-align:middle;line-height:1}";
    document.head.appendChild(st);
  }
  // Sur la boutique : pastille sur le bouton "Admin" du menu du haut
  function ensureAuthBadge() {
    if (embedded()) return;
    const btn = document.getElementById("auth-btn");
    if (btn && !btn.querySelector(".mt-cart-badge")) {
      const b = document.createElement("span");
      b.className = "mt-cart-badge";
      btn.appendChild(b);
      render();
    }
  }

  function buildUI() {
    if (ui) return;
    injectBadgeCss();
    const wrap = document.createElement("div");
    wrap.id = "mt-cart-notify";

    wrap.innerHTML = `
      <style>
        #mt-cart-notify{position:fixed;left:16px;bottom:16px;z-index:9999;font-family:inherit}
        #mt-cn-btn{position:relative;width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;
          background:#111;color:#fff;font-size:22px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
        #mt-cn-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;
          background:#ef4444;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center}
        #mt-cn-panel{display:none;position:absolute;left:0;bottom:62px;width:min(340px,calc(100vw - 32px));max-height:60vh;
          overflow:auto;background:#fff;color:#111;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);border:1px solid #eee}
        #mt-cn-panel header{padding:12px 14px;border-bottom:1px solid #eee;font-weight:700;font-size:14px;
          display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#fff}
        #mt-cn-panel .sub{font-weight:500;font-size:12px;color:#6b7280}
        .mt-cn-item{padding:10px 14px;border-bottom:1px solid #f3f4f6;font-size:13px;line-height:1.35}
        .mt-cn-item.new{background:#fff7ed}
        .mt-cn-item .t{color:#6b7280;font-size:11px}
        .mt-cn-empty{padding:24px 14px;text-align:center;color:#6b7280;font-size:13px}
        #mt-cn-btn,#mt-cn-panel{display:none!important}
        #mt-cn-toast{position:fixed;left:16px;bottom:80px;z-index:10000;background:#111;color:#fff;padding:12px 16px;
          border-radius:12px;font-size:13px;max-width:300px;box-shadow:0 8px 24px rgba(0,0,0,.3);
          opacity:0;transform:translateY(10px);pointer-events:none;transition:.25s}
        #mt-cn-toast.show{opacity:1;transform:none}
      </style>
      <div id="mt-cn-panel">
        <header><span>🛒 Ajouts au panier</span><span class="sub" id="mt-cn-sub"></span></header>
        <div id="mt-cn-list"></div>
      </div>
      <button id="mt-cn-btn" title="Ajouts au panier" aria-label="Ajouts au panier">🛒<span id="mt-cn-badge"></span></button>
      <div id="mt-cn-toast"></div>`;
    document.body.appendChild(wrap);
    ui = {
      btn: wrap.querySelector("#mt-cn-btn"),
      badge: wrap.querySelector("#mt-cn-badge"),
      panel: wrap.querySelector("#mt-cn-panel"),
      list: wrap.querySelector("#mt-cn-list"),
      sub: wrap.querySelector("#mt-cn-sub"),
      toast: wrap.querySelector("#mt-cn-toast"),
    };
    ui.btn.addEventListener("click", () => {
      const open = ui.panel.style.display === "block";
      ui.panel.style.display = open ? "none" : "block";
      if (!open) {
        unread = 0;
        render();
        // demande la permission de notification au 1er clic (geste utilisateur)
        if ("Notification" in window && Notification.permission === "default") {
          Notification.requestPermission().catch(() => {});
        }
      }
    });
  }

  function renderTab(newIds) {
    const body = document.getElementById("admin-carts-body");
    if (!body) return;
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    set("carts-stat-adds", stats.adds);
    set("carts-stat-visitors", stats.visitors);
    set("carts-stat-top", stats.top ? stats.top.name : "—");
    set(
      "carts-stat-top-sub",
      stats.top ? `${stats.top.qty} unité(s) aujourd'hui` : "",
    );
    if (!events.length) {
      body.innerHTML =
        '<tr><td colspan="5" style="text-align:center;color:#6b7280;padding:1.5rem">Aucun ajout au panier pour le moment.</td></tr>';
      return;
    }
    body.innerHTML = events
      .map((e) => {
        const isNew = newIds && newIds.has(e.id);
        const who = e.user_name
          ? `<b>${esc(e.user_name)}</b>`
          : `Visiteur${e.session_id ? ` <span style="color:#9ca3af;font-size:11px">#${esc(e.session_id.slice(-4))}</span>` : ""}`;
        const exact = new Date(
          e.created_at + (/Z|\+/.test(e.created_at) ? "" : "Z"),
        );
        return `<tr${isNew ? ' style="background:#fff7ed"' : ""}>
          <td title="${esc(exact.toLocaleString())}">${ago(e.created_at)}</td>
          <td><b>${esc(e.product_name)}</b></td>
          <td>${e.variant_label ? esc(e.variant_label) : "—"}</td>
          <td>× ${e.qty}</td>
          <td>${who}</td></tr>`;
      })
      .join("");
  }

  function render(newIds) {
    if (!ui) return;
    document.querySelectorAll(".mt-cart-badge").forEach((b) => {
      b.textContent = unread > 99 ? "99+" : unread;
      b.style.display = unread > 0 ? "inline-flex" : "none";
    });
    renderTab(newIds);
    ui.badge.textContent = unread > 99 ? "99+" : unread;
    ui.badge.style.display = unread > 0 ? "flex" : "none";
    if (!events.length) {
      ui.list.innerHTML =
        '<div class="mt-cn-empty">Aucun ajout au panier pour le moment.</div>';
      return;
    }
    ui.list.innerHTML = events
      .map((e) => {
        const who = e.user_name ? esc(e.user_name) : "Visiteur";
        const v = e.variant_label
          ? ` <span class="t">(${esc(e.variant_label)})</span>`
          : "";
        return `<div class="mt-cn-item ${newIds && newIds.has(e.id) ? "new" : ""}">
          <b>${esc(e.product_name)}</b>${v} × ${e.qty}<br>
          <span class="t">${who} · ${ago(e.created_at)}</span></div>`;
      })
      .join("");
  }

  function notify(fresh) {
    const e = fresh[0];
    const extra =
      fresh.length > 1
        ? ` (+${fresh.length - 1} autre${fresh.length > 2 ? "s" : ""})`
        : "";
    const msg = `🛒 ${e.user_name || "Un visiteur"} a ajouté « ${e.product_name} » au panier${extra}`;
    ui.toast.textContent = msg;
    ui.toast.classList.add("show");
    setTimeout(() => ui.toast.classList.remove("show"), 5000);
    try {
      if (
        "Notification" in window &&
        Notification.permission === "granted" &&
        document.hidden
      ) {
        new Notification("Mus Tech — Panier", { body: msg });
      }
    } catch {}
  }

  async function poll() {
    if (!isAdmin()) return;
    buildUI();
    ensureAuthBadge();
    try {
      const url = "/cart-events" + (lastId !== null ? `?after=${lastId}` : "");
      const data = await apiFetch(url);
      ui.sub.textContent = `Aujourd'hui : ${data.today_adds} ajout(s) · ${data.today_visitors} visiteur(s)`;
      stats = {
        adds: data.today_adds,
        visitors: data.today_visitors,
        top: data.today_top || null,
      };
      if (lastId === null) {
        // 1er chargement : historique sans alerte
        events = data.events;
        unread = 0;
        render();
      } else if (data.events.length) {
        // seulement les nouveaux (id > lastId)
        // on ignore les événements déjà connus (évite les doublons si
        // deux requêtes se croisent)
        const known = new Set(events.map((x) => x.id));
        const fresh = data.events.filter((x) => !known.has(x.id));
        if (!fresh.length) {
          lastId = data.latest_id;
          render();
          return;
        }
        events = fresh.concat(events).slice(0, MAX);
        unread += tabOpen() ? 0 : fresh.length;
        render(new Set(fresh.map((x) => x.id)));
        notify(fresh);
      }
      lastId = data.latest_id;
      if (!data.events.length) render(); // rafraîchit stats + "il y a X min"
    } catch (e) {
      // session expirée / non-admin : on s'arrête sans bruit
      if (/401|403|authentifi|réservé|invalide|expiré/i.test(e.message)) stop();
    }
  }

  function start() {
    if (timer) return;
    poll();
    timer = setInterval(poll, POLL_MS);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
    lastId = null;
    const el = document.getElementById("mt-cart-notify");
    if (el) el.remove();
    document
      .querySelectorAll("#auth-btn .mt-cart-badge")
      .forEach((b) => b.remove());
    ui = null;
  }

  // Appelé par admin.html quand on ouvre l'onglet "Paniers"
  window.MtCartNotify = {
    async clear() {
      if (!confirm("Vider tout l'historique des ajouts au panier ?")) return;
      try {
        await apiFetch("/cart-events", { method: "DELETE" });
        events = [];
        unread = 0;
        stats = { adds: 0, visitors: 0, top: null };
        lastId = 0;
        render();
      } catch (e) {
        alert("Impossible de vider l'historique : " + e.message);
      }
    },
    async onTabOpen() {
      if (!isAdmin()) return;
      buildUI();
      unread = 0;
      render();
      try {
        const data = await apiFetch(`/cart-events?limit=${MAX}`);
        events = data.events;
        stats = {
          adds: data.today_adds,
          visitors: data.today_visitors,
          top: data.today_top || null,
        };
        lastId = data.latest_id;
        render();
      } catch {}
    },
  };

  // Le rôle admin est connu après checkSession()/login : on surveille l'état.
  setInterval(() => {
    if (isAdmin() && ui) ensureAuthBadge();
    if (isAdmin() && !timer) start();
    else if (!isAdmin() && timer) stop();
  }, 2000);
})();
