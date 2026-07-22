/* ============================================================
   Bojamiley CRM
   Team CRM for a custom fashion business, backed by Supabase
   (Postgres + auth). Data is stored centrally; permissions are
   enforced by row-level security in the database:
     admin  - full access, settings, team roles, deletes
     staff  - create and edit clients/orders, no deletes
     viewer - read-only
   ============================================================ */

(function () {
  "use strict";

  var sb = window.supabase.createClient(window.CRM_CONFIG.url, window.CRM_CONFIG.key);

  /* ---------- Domain constants ---------- */

  var STATUSES = [
    { key: "new",         label: "New",              progress: 5   },
    { key: "cutting",     label: "Cutting",          progress: 25  },
    { key: "sewing",      label: "Sewing",           progress: 50  },
    { key: "fitting",     label: "Fitting",          progress: 70  },
    { key: "adjustments", label: "Adjustments",      progress: 85  },
    { key: "ready",       label: "Ready for Pickup", progress: 95  },
    { key: "delivered",   label: "Delivered",        progress: 100 }
  ];
  var CANCELLED = { key: "cancelled", label: "Cancelled", progress: 0 };

  var GARMENTS = [
    "Gown", "Dress", "Wedding Dress", "Aso-Ebi", "Skirt & Blouse", "Blouse",
    "Top", "Skirt", "Trousers", "Jumpsuit", "Two-Piece Set", "Corset Dress",
    "Kaftan", "Boubou", "Agbada", "Kimono", "Jacket", "Suit"
  ];

  var MEASUREMENTS = [
    ["bust", "Bust"],
    ["underbust", "Under Bust"],
    ["waist", "Waist"],
    ["hips", "Hips"],
    ["shoulder", "Shoulder"],
    ["sleeve", "Sleeve Length"],
    ["roundSleeve", "Round Sleeve"],
    ["bustPoint", "Bust Point"],
    ["halfLength", "Half Length"],
    ["topLength", "Top Length"],
    ["gownLength", "Gown Length"],
    ["skirtLength", "Skirt Length"],
    ["trouserLength", "Trouser Length"],
    ["thigh", "Thigh"],
    ["knee", "Knee"],
    ["ankle", "Ankle / Bottom"],
    ["neck", "Neck"],
    ["wrist", "Wrist"]
  ];

  var ROLES = [
    ["admin", "Admin (full access)"],
    ["staff", "Staff (can add and edit)"],
    ["viewer", "Viewer (read only)"]
  ];

  /* ---------- State ---------- */

  var db = { settings: { businessName: "Bojamiley", currency: "₦" }, clients: [], orders: [], profiles: [] };
  var me = null; // my profile row: { id, email, fullName, role }
  var ui = { tab: "dashboard", orderFilter: "active", orderSearch: "", clientSearch: "" };

  function isAdmin() { return !!me && me.role === "admin"; }
  function canEdit() { return !!me && (me.role === "admin" || me.role === "staff"); }

  /* ---------- Helpers ---------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function parseISO(s) {
    if (!s) return null;
    var p = String(s).slice(0, 10).split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function fmtDate(s) {
    var d = parseISO(s);
    if (!d) return "-";
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }

  function fmtDateShort(s) {
    var d = parseISO(s);
    if (!d) return "-";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function daysUntil(s) {
    var d = parseISO(s);
    if (!d) return null;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((d - today) / 86400000);
  }

  function money(n) {
    var v = Number(n || 0);
    return db.settings.currency + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function statusOf(order) {
    if (order.status === "cancelled") return CANCELLED;
    for (var i = 0; i < STATUSES.length; i++) {
      if (STATUSES[i].key === order.status) return STATUSES[i];
    }
    return STATUSES[0];
  }

  function statusIndex(key) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].key === key) return i;
    return -1;
  }

  function isOpen(order) {
    return order.status !== "delivered" && order.status !== "cancelled";
  }

  function paidTotal(order) {
    return (order.payments || []).reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
  }

  function balanceOf(order) {
    return Number(order.price || 0) - paidTotal(order);
  }

  function clientById(id) {
    for (var i = 0; i < db.clients.length; i++) if (db.clients[i].id === id) return db.clients[i];
    return null;
  }

  function orderById(id) {
    for (var i = 0; i < db.orders.length; i++) if (db.orders[i].id === id) return db.orders[i];
    return null;
  }

  function clientName(id) {
    var c = clientById(id);
    return c ? c.name : "(deleted client)";
  }

  function ordersForClient(clientId) {
    return db.orders.filter(function (o) { return o.clientId === clientId; });
  }

  function phoneDigits(phone) {
    return String(phone || "").replace(/[^\d+]/g, "").replace(/^\+/, "");
  }

  function toast(msg, isError) {
    var root = $("#toastRoot");
    var el = document.createElement("div");
    el.className = "toast";
    if (isError) el.style.background = "var(--red)";
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, isError ? 4200 : 2600);
  }

  function fail(error, context) {
    var msg = (error && (error.message || error.error_description)) || "Something went wrong";
    toast((context ? context + ": " : "") + msg, true);
  }

  /* ---------- Row mappers (DB snake_case <-> app camelCase) ---------- */

  // Contact columns (phone, email, address) are admin-only in the database;
  // everyone else can only read these columns of the clients table.
  var CLIENT_COLS = "id,name,notes,measure_notes,measurements,created_at";

  // Money columns (price, payments) are admin-only in the database;
  // everyone else can only read these columns of the orders table.
  var ORDER_COLS = "id,ref,client_id,garment,fabric,fabric_by,urgent,description,notes,status,order_date,due_date,delivered_at,created_at,updated_at";

  function rowToClient(r) {
    return {
      id: r.id, name: r.name,
      phone: r.phone || "", email: r.email || "", address: r.address || "",
      notes: r.notes, measureNotes: r.measure_notes,
      measurements: r.measurements || {}, createdAt: r.created_at
    };
  }

  function clientToRow(c) {
    var row = {
      name: c.name, notes: c.notes,
      measure_notes: c.measureNotes, measurements: c.measurements
    };
    if (c.phone !== undefined) {
      row.phone = c.phone;
      row.email = c.email;
      row.address = c.address;
    }
    return row;
  }

  function rowToOrder(r) {
    return {
      id: r.id, ref: r.ref, clientId: r.client_id, garment: r.garment,
      fabric: r.fabric, fabricBy: r.fabric_by, urgent: r.urgent,
      description: r.description, notes: r.notes, status: r.status,
      orderDate: r.order_date, dueDate: r.due_date, deliveredAt: r.delivered_at,
      price: Number(r.price || 0), payments: r.payments || [],
      createdAt: r.created_at, updatedAt: r.updated_at
    };
  }

  function rowToProfile(r) {
    return { id: r.id, email: r.email, fullName: r.full_name, role: r.role, createdAt: r.created_at };
  }

  /* ---------- Data loading ---------- */

  function loadAll() {
    return Promise.all([
      sb.from("settings").select("*").eq("id", 1).single(),
      sb.from("clients").select(CLIENT_COLS).order("name"),
      sb.from("orders").select(ORDER_COLS).order("created_at"),
      sb.from("profiles").select("*").order("created_at"),
      sb.from("client_contacts").select("*"), // rows only come back for admins
      sb.from("order_money").select("*")      // rows only come back for admins
    ]).then(function (res) {
      var errs = res.filter(function (r) { return r.error; });
      if (errs.length) throw errs[0].error;
      db.settings = { businessName: res[0].data.business_name, currency: res[0].data.currency };
      db.clients = res[1].data.map(rowToClient);
      db.orders = res[2].data.map(rowToOrder);
      db.profiles = res[3].data.map(rowToProfile);
      var contacts = {};
      (res[4].data || []).forEach(function (r) { contacts[r.id] = r; });
      db.clients.forEach(function (c) {
        var k = contacts[c.id];
        if (k) { c.phone = k.phone || ""; c.email = k.email || ""; c.address = k.address || ""; }
      });
      var moneyRows = {};
      (res[5].data || []).forEach(function (r) { moneyRows[r.id] = r; });
      db.orders.forEach(function (o) {
        var k = moneyRows[o.id];
        if (k) { o.price = Number(k.price || 0); o.payments = k.payments || []; }
      });
      me = null;
      for (var i = 0; i < db.profiles.length; i++) {
        if (db.profiles[i].id === myUserId) me = db.profiles[i];
      }
    });
  }

  /* ---------- Auth flow ---------- */

  var myUserId = null;

  function show(id) {
    ["loadingView", "authView", "app"].forEach(function (v) {
      document.getElementById(v).hidden = v !== id;
    });
  }

  function enterApp(session) {
    myUserId = session.user.id;
    loadAll().then(function () {
      show("app");
      renderAll();
    }).catch(function (e) {
      show("authView");
      fail(e, "Could not load data");
    });
  }

  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "SIGNED_OUT") {
      me = null; myUserId = null;
      db.clients = []; db.orders = []; db.profiles = [];
      closeModal();
      show("authView");
    }
  });

  sb.auth.getSession().then(function (res) {
    var session = res.data ? res.data.session : null;
    if (session) enterApp(session);
    else show("authView");
  });

  // refresh silently when the tab regains focus, so phones stay in sync
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && myUserId && !$("#app").hidden) {
      loadAll().then(renderAll).catch(function () { /* offline; keep showing what we have */ });
    }
  });

  function doSignIn(form) {
    var btn = $("#signinBtn"), err = $("#signinError");
    err.hidden = true;
    btn.disabled = true; btn.textContent = "Signing in…";
    sb.auth.signInWithPassword({ email: $("#si_email").value.trim(), password: $("#si_password").value })
      .then(function (res) {
        if (res.error) { err.textContent = res.error.message; err.hidden = false; return; }
        show("loadingView");
        enterApp(res.data.session);
      })
      .finally(function () { btn.disabled = false; btn.textContent = "Sign In"; });
  }

  function doSignUp(form) {
    var btn = $("#signupBtn"), err = $("#signupError"), info = $("#signupInfo");
    err.hidden = true; info.hidden = true;
    btn.disabled = true; btn.textContent = "Creating account…";
    sb.auth.signUp({
      email: $("#su_email").value.trim(),
      password: $("#su_password").value,
      options: { data: { full_name: $("#su_name").value.trim() } }
    }).then(function (res) {
      if (res.error) { err.textContent = res.error.message; err.hidden = false; return; }
      if (res.data.session) {
        show("loadingView");
        enterApp(res.data.session);
      } else {
        info.textContent = "Account created. Check your email for a confirmation link, then come back and sign in.";
        info.hidden = false;
      }
    }).finally(function () { btn.disabled = false; btn.textContent = "Create Account"; });
  }

  function signOut() {
    sb.auth.signOut().then(function () { toast("Signed out"); });
  }

  /* ============================================================
     RENDERING
     ============================================================ */

  function renderAll() {
    $("#brandName").textContent = db.settings.businessName || "Bojamiley";
    document.title = (db.settings.businessName || "Bojamiley") + " CRM";
    $("#ordersCount").textContent = db.orders.filter(isOpen).length || "";
    $("#clientsCount").textContent = db.clients.length || "";
    $all("[data-needs-edit]").forEach(function (el) { el.style.display = canEdit() ? "" : "none"; });
    renderDashboard();
    renderOrders();
    renderClients();
  }

  /* ---------- Dashboard ---------- */

  function renderDashboard() {
    var view = $("#view-dashboard");
    var open = db.orders.filter(isOpen);
    var overdue = open.filter(function (o) { var d = daysUntil(o.dueDate); return d !== null && d < 0; });
    var dueSoon = open.filter(function (o) { var d = daysUntil(o.dueDate); return d !== null && d >= 0 && d <= 7; });
    var outstanding = db.orders
      .filter(function (o) { return o.status !== "cancelled"; })
      .reduce(function (s, o) { return s + Math.max(0, balanceOf(o)); }, 0);

    var html = "";

    if (me) {
      var roleLabel = { admin: "Admin", staff: "Staff", viewer: "Viewer" }[me.role] || me.role;
      html += '<p style="color:var(--muted);font-size:13.5px;margin-bottom:12px">Signed in as <strong>' +
        esc(me.fullName || me.email) + '</strong> <span class="role-badge role-' + esc(me.role) + '">' + roleLabel + "</span></p>";
    }

    if (db.clients.length === 0 && db.orders.length === 0) {
      html +=
        '<div class="welcome-card">' +
          "<h2>Welcome to " + esc(db.settings.businessName) + " CRM</h2>" +
          "<p>Keep every client, measurement, order and payment in one place, " +
          "so nothing gets mixed up and nothing is delivered late. Everything is saved securely in the cloud and shared with your team." +
          (canEdit() ? " Start by adding a client.</p>" +
          '<button class="btn" data-action="new-client">+ Add your first client</button>'
          : " Ask the Admin to upgrade your role to start adding clients and orders.</p>") +
        "</div>";
    }

    html +=
      '<div class="stats-grid">' +
        statCard("Active orders", open.length, "") +
        statCard("Overdue", overdue.length, overdue.length ? "stat-alert" : "") +
        statCard("Due in 7 days", dueSoon.length, dueSoon.length ? "stat-warn" : "") +
        (isAdmin() ? statCard("Balance owed", money(outstanding), "stat-money") : "") +
      "</div>";

    var attention = overdue.concat(dueSoon).sort(function (a, b) {
      return (daysUntil(a.dueDate) - daysUntil(b.dueDate)) || 0;
    });

    html += '<h3 class="section-title">⚠ Needs attention</h3>';
    if (attention.length) {
      html += '<div class="card-list">' + attention.map(orderCard).join("") + "</div>";
    } else {
      html += '<div class="empty"><span class="empty-icon">✅</span><h3>Nothing urgent</h3><p>No overdue orders and nothing due in the next 7 days.</p></div>';
    }

    var working = open
      .filter(function (o) { return attention.indexOf(o) === -1; })
      .sort(function (a, b) { return (a.dueDate || "9999") < (b.dueDate || "9999") ? -1 : 1; });

    if (working.length) {
      html += '<h3 class="section-title">🧵 In progress</h3>';
      html += '<div class="card-list">' + working.slice(0, 6).map(orderCard).join("") + "</div>";
      if (working.length > 6) {
        html += '<p style="margin-top:10px"><button class="btn btn-subtle btn-sm" data-action="go-orders">See all ' + working.length + " active orders →</button></p>";
      }
    }

    view.innerHTML = html;
  }

  function statCard(label, value, cls) {
    return '<div class="stat-card ' + cls + '"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + "</div></div>";
  }

  /* ---------- Orders ---------- */

  function renderOrders() {
    var view = $("#view-orders");
    var filters = [
      ["active", "Active"], ["overdue", "Overdue"], ["new", "New"], ["cutting", "Cutting"],
      ["sewing", "Sewing"], ["fitting", "Fitting"], ["adjustments", "Adjustments"],
      ["ready", "Ready"], ["delivered", "Delivered"], ["all", "All"]
    ];

    var list = db.orders.slice();

    if (ui.orderFilter === "active") list = list.filter(isOpen);
    else if (ui.orderFilter === "overdue") list = list.filter(function (o) { var d = daysUntil(o.dueDate); return isOpen(o) && d !== null && d < 0; });
    else if (ui.orderFilter !== "all") list = list.filter(function (o) { return o.status === ui.orderFilter; });

    if (ui.orderSearch) {
      var q = ui.orderSearch.toLowerCase();
      list = list.filter(function (o) {
        return (o.ref + " " + clientName(o.clientId) + " " + (o.garment || "") + " " + (o.description || "") + " " + (o.fabric || "")).toLowerCase().indexOf(q) !== -1;
      });
    }

    list.sort(function (a, b) {
      if (a.status === "delivered" && b.status === "delivered") return (b.updatedAt || "") < (a.updatedAt || "") ? -1 : 1;
      var da = a.dueDate || "9999-12-31", dbb = b.dueDate || "9999-12-31";
      return da < dbb ? -1 : da > dbb ? 1 : 0;
    });

    var html =
      '<div class="view-head"><h2>Orders</h2>' +
      (canEdit() ? '<button class="btn btn-primary" data-action="new-order">+ New Order</button>' : "") + "</div>" +
      '<div class="toolbar">' +
        '<input class="search-input" id="orderSearch" type="search" placeholder="Search by client, garment, fabric or order number…" value="' + esc(ui.orderSearch) + '">' +
        '<div class="chip-row">' + filters.map(function (f) {
          return '<button class="chip ' + (ui.orderFilter === f[0] ? "active" : "") + '" data-order-filter="' + f[0] + '">' + f[1] + "</button>";
        }).join("") + "</div>" +
      "</div>";

    if (list.length) {
      html += '<div class="card-list">' + list.map(orderCard).join("") + "</div>";
    } else if (db.orders.length === 0) {
      html += '<div class="empty"><span class="empty-icon">📋</span><h3>No orders yet</h3><p>Create your first order and track it from cutting to delivery.</p>' +
        (canEdit() ? '<button class="btn btn-primary" data-action="new-order">+ New Order</button>' : "") + "</div>";
    } else {
      html += '<div class="empty"><span class="empty-icon">🔍</span><h3>No orders match</h3><p>Try a different filter or search.</p></div>';
    }

    view.innerHTML = html;
  }

  function orderCard(o) {
    var st = statusOf(o);
    var bal = balanceOf(o);
    var next = nextStatus(o);
    return (
      '<div class="item-card" data-open-order="' + o.id + '">' +
        '<div class="card-top">' +
          '<div><div class="card-title"><span class="ref">' + esc(o.ref) + "</span>" + esc(o.garment || "Order") + '</div>' +
          '<div class="card-sub">for <strong>' + esc(clientName(o.clientId)) + "</strong>" +
            (o.fabric ? " · " + esc(o.fabric) : "") + "</div></div>" +
          '<div class="card-badges">' +
            (o.urgent && isOpen(o) ? '<span class="badge-urgent">URGENT</span>' : "") +
            dueBadge(o) +
            '<span class="pill st-' + st.key + '"><span class="pill-dot"></span>' + st.label + "</span>" +
          "</div>" +
        "</div>" +
        '<div class="card-foot">' +
          '<div class="progress"><div class="progress-fill' + (st.key === "delivered" ? " done" : "") + '" style="width:' + st.progress + '%"></div></div>' +
          (isAdmin()
            ? '<span class="balance-chip ' + (bal > 0 ? "balance-owed" : "balance-paid") + '">' +
              (bal > 0 ? "Owes " + money(bal) : "Fully paid ✓") + "</span>"
            : "") +
          (next && isOpen(o) && canEdit() ? '<button class="btn btn-subtle btn-sm" data-advance-order="' + o.id + '">Move to ' + next.label + " →</button>" : "") +
        "</div>" +
      "</div>"
    );
  }

  function nextStatus(o) {
    var i = statusIndex(o.status);
    if (i === -1 || i >= STATUSES.length - 1) return null;
    return STATUSES[i + 1];
  }

  function dueBadge(order) {
    if (!isOpen(order)) return "";
    if (!order.dueDate) return '<span class="due-badge due-ok">No due date</span>';
    var d = daysUntil(order.dueDate);
    if (d < 0)  return '<span class="due-badge due-overdue">Overdue by ' + (-d) + (d === -1 ? " day" : " days") + "</span>";
    if (d === 0) return '<span class="due-badge due-soon">Due today</span>';
    if (d === 1) return '<span class="due-badge due-soon">Due tomorrow</span>';
    if (d <= 7)  return '<span class="due-badge due-soon">Due in ' + d + " days</span>";
    return '<span class="due-badge due-ok">Due ' + esc(fmtDateShort(order.dueDate)) + "</span>";
  }

  /* ---------- Clients ---------- */

  function renderClients() {
    var view = $("#view-clients");
    var list = db.clients.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });

    if (ui.clientSearch) {
      var q = ui.clientSearch.toLowerCase();
      list = list.filter(function (c) {
        return (c.name + " " + (c.phone || "") + " " + (c.notes || "")).toLowerCase().indexOf(q) !== -1;
      });
    }

    var html =
      '<div class="view-head"><h2>Clients</h2>' +
      (canEdit() ? '<button class="btn btn-primary" data-action="new-client">+ New Client</button>' : "") + "</div>" +
      '<div class="toolbar">' +
        '<input class="search-input" id="clientSearch" type="search" placeholder="Search clients by name or phone…" value="' + esc(ui.clientSearch) + '">' +
      "</div>";

    if (list.length) {
      html += '<div class="card-list">' + list.map(clientCard).join("") + "</div>";
    } else if (db.clients.length === 0) {
      html += '<div class="empty"><span class="empty-icon">👗</span><h3>No clients yet</h3><p>Add a client with her measurements once. After that, every order for her is two taps away.</p>' +
        (canEdit() ? '<button class="btn btn-primary" data-action="new-client">+ New Client</button>' : "") + "</div>";
    } else {
      html += '<div class="empty"><span class="empty-icon">🔍</span><h3>No clients match</h3><p>Try a different search.</p></div>';
    }

    view.innerHTML = html;
  }

  function clientCard(c) {
    var orders = ordersForClient(c.id);
    var open = orders.filter(isOpen);
    var owed = orders.filter(function (o) { return o.status !== "cancelled"; })
      .reduce(function (s, o) { return s + Math.max(0, balanceOf(o)); }, 0);
    return (
      '<div class="item-card" data-open-client="' + c.id + '">' +
        '<div class="card-top">' +
          '<div><div class="card-title">' + esc(c.name) + "</div>" +
          '<div class="card-sub">' + (c.phone ? esc(c.phone) + " · " : "") + orders.length + " order" + (orders.length === 1 ? "" : "s") +
          (open.length ? " · <strong>" + open.length + " active</strong>" : "") + "</div></div>" +
          '<div class="card-badges">' +
            (owed > 0 ? '<span class="balance-chip balance-owed">Owes ' + money(owed) + "</span>" : "") +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  /* ============================================================
     MODALS
     ============================================================ */

  function openModal(html) {
    var root = $("#modalRoot");
    root.innerHTML =
      '<div class="modal-overlay" data-modal-overlay>' +
        '<div class="modal-card" role="dialog" aria-modal="true">' + html + "</div>" +
      "</div>";
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    $("#modalRoot").innerHTML = "";
    document.body.style.overflow = "";
  }

  function modalHead(title, sub) {
    return (
      '<div class="modal-head"><div><h2>' + title + "</h2>" +
      (sub ? '<div class="modal-sub">' + sub + "</div>" : "") + "</div>" +
      '<button class="modal-close" data-action="close-modal" aria-label="Close">✕</button></div>'
    );
  }

  function busy(formSel, on) {
    var f = $(formSel);
    if (!f) return;
    $all("button", f).forEach(function (b) { b.disabled = on; });
  }

  /* ---------- Client form ---------- */

  function showClientForm(clientId, opts) {
    if (!canEdit()) return;
    var c = clientId ? clientById(clientId) : null;
    var m = (c && c.measurements) || {};
    var afterOrder = opts && opts.thenOrder;

    var measureInputs = MEASUREMENTS.map(function (mm) {
      return (
        '<div class="field"><label for="m_' + mm[0] + '">' + mm[1] + '</label>' +
        '<input id="m_' + mm[0] + '" type="text" inputmode="decimal" value="' + esc(m[mm[0]] || "") + '" placeholder="-"></div>'
      );
    }).join("");

    // Contact fields: admins always; staff only while creating a new client.
    // On staff edits the fields are left out entirely so existing contact
    // details can never be read back or wiped.
    var showContacts = isAdmin() || !c;
    var contactFields = showContacts
      ? '<div class="field"><label for="c_phone">Phone / WhatsApp</label><input id="c_phone" type="tel" value="' + esc(c ? c.phone : "") + '" placeholder="e.g. +234 803 123 4567"></div>' +
        '<div class="field"><label for="c_email">Email</label><input id="c_email" type="email" value="' + esc(c ? c.email : "") + '"></div>' +
        '<div class="field full"><label for="c_address">Address</label><input id="c_address" value="' + esc(c ? c.address : "") + '"></div>'
      : '<div class="field full"><div class="notice" style="margin-bottom:0">Contact details (phone, email, address) are managed by the Admin.</div></div>';

    openModal(
      modalHead(c ? "Edit Client" : "New Client", c ? esc(c.name) : "Save her details and measurements once, then reuse them on every order.") +
      '<div class="modal-body"><form id="clientForm" data-client-id="' + (c ? c.id : "") + '" data-then-order="' + (afterOrder ? "1" : "") + '">' +
        '<div class="form-grid">' +
          '<div class="field full"><label for="c_name">Full name *</label><input id="c_name" required value="' + esc(c ? c.name : "") + '" placeholder="e.g. Amaka Obi"></div>' +
          contactFields +
          '<div class="field full"><label for="c_notes">Style notes</label><textarea id="c_notes" placeholder="Preferences, fit notes, colours she loves…">' + esc(c ? c.notes : "") + "</textarea></div>" +
        "</div>" +
        '<h3 class="section-title" style="margin-top:18px">Measurements <span style="font-weight:400;color:var(--muted);font-size:13px">(inches or cm, just be consistent)</span></h3>' +
        '<div class="measure-grid">' + measureInputs + "</div>" +
        '<div class="field" style="margin-top:12px"><label for="c_mnotes">Other measurements / notes</label><input id="c_mnotes" value="' + esc(c && c.measureNotes ? c.measureNotes : "") + '" placeholder="e.g. Slit length 20, prefers loose waist"></div>' +
        '<div class="modal-actions">' +
          (c && isAdmin() ? '<button type="button" class="btn btn-danger btn-sm" data-delete-client="' + c.id + '">Delete</button>' : "") +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
          '<button type="submit" class="btn btn-primary">' + (c ? "Save Changes" : afterOrder ? "Save & Continue to Order" : "Save Client") + "</button>" +
        "</div>" +
      "</form></div>"
    );
    $("#c_name").focus();
  }

  function submitClientForm(form) {
    var id = form.getAttribute("data-client-id");
    var thenOrder = form.getAttribute("data-then-order") === "1";
    var isNew = !id;

    var c = {
      name: $("#c_name").value.trim(),
      notes: $("#c_notes").value.trim(),
      measureNotes: $("#c_mnotes").value.trim(),
      measurements: {}
    };
    var hasContacts = !!$("#c_phone");
    if (hasContacts) {
      c.phone = $("#c_phone").value.trim();
      c.email = $("#c_email").value.trim();
      c.address = $("#c_address").value.trim();
    }
    MEASUREMENTS.forEach(function (mm) {
      var v = $("#m_" + mm[0]).value.trim();
      if (v) c.measurements[mm[0]] = v;
    });

    busy("#clientForm", true);
    var q = isNew
      ? sb.from("clients").insert(clientToRow(c)).select(CLIENT_COLS).single()
      : sb.from("clients").update(clientToRow(c)).eq("id", id).select(CLIENT_COLS).single();

    q.then(function (res) {
      if (res.error) { busy("#clientForm", false); return fail(res.error, "Could not save client"); }
      var saved = rowToClient(res.data);
      // contact columns never come back from the database; carry them over
      // from what was just typed, or from what we already had
      var prev = id ? clientById(id) : null;
      saved.phone = hasContacts ? c.phone : (prev ? prev.phone : "");
      saved.email = hasContacts ? c.email : (prev ? prev.email : "");
      saved.address = hasContacts ? c.address : (prev ? prev.address : "");
      if (isNew) db.clients.push(saved);
      else db.clients = db.clients.map(function (x) { return x.id === saved.id ? saved : x; });
      renderAll();
      toast(isNew ? "Client added ✓" : "Client saved ✓");
      if (thenOrder) showOrderForm(null, saved.id);
      else if (isNew) closeModal();
      else showClientDetail(saved.id);
    });
  }

  /* ---------- Client detail ---------- */

  function showClientDetail(id) {
    var c = clientById(id);
    if (!c) return;
    var orders = ordersForClient(id).sort(function (a, b) {
      return (b.orderDate || "") < (a.orderDate || "") ? -1 : 1;
    });
    var m = c.measurements || {};
    var tiles = MEASUREMENTS.filter(function (mm) { return m[mm[0]]; }).map(function (mm) {
      return '<div class="measure-tile"><div class="m-label">' + mm[1] + '</div><div class="m-value">' + esc(m[mm[0]]) + "</div></div>";
    }).join("");

    var wa = phoneDigits(c.phone);

    openModal(
      modalHead(esc(c.name), "Client since " + fmtDate(c.createdAt)) +
      '<div class="modal-body">' +
        (isAdmin()
          ? '<div class="contact-row">' +
              (c.phone ? '<a class="contact-link" href="tel:' + esc(c.phone) + '">📞 ' + esc(c.phone) + "</a>" : "") +
              (wa ? '<a class="contact-link whatsapp" href="https://wa.me/' + wa + '" target="_blank" rel="noopener">💬 WhatsApp</a>' : "") +
              (c.email ? '<a class="contact-link" href="mailto:' + esc(c.email) + '">✉ ' + esc(c.email) + "</a>" : "") +
            "</div>"
          : '<p style="color:var(--muted);font-size:13px;margin:6px 0 10px">🔒 Contact details are visible to the Admin only.</p>') +
        (isAdmin() && c.address ? '<div class="detail-item"><div class="dt">Address</div><div class="dd">' + esc(c.address) + "</div></div>" : "") +
        (c.notes ? '<div class="detail-item" style="margin-top:8px"><div class="dt">Style notes</div><div class="dd">' + esc(c.notes) + "</div></div>" : "") +
        '<h3 class="section-title">📏 Measurements</h3>' +
        (tiles ? '<div class="measure-view">' + tiles + "</div>"
               : '<p style="color:var(--muted)">No measurements saved yet.' + (canEdit() ? " Tap Edit to add them." : "") + "</p>") +
        (c.measureNotes ? '<p style="margin-top:8px;font-size:14px;color:var(--muted)"><strong>Notes:</strong> ' + esc(c.measureNotes) + "</p>" : "") +
        '<h3 class="section-title">🛍 Orders (' + orders.length + ")</h3>" +
        (orders.length ? orders.map(function (o) {
          var st = statusOf(o);
          return (
            '<div class="mini-order" data-open-order="' + o.id + '">' +
              "<div><div class=\"mo-title\">" + esc(o.ref) + " · " + esc(o.garment || "Order") + '</div>' +
              '<div class="mo-sub">' + (o.dueDate ? "Due " + fmtDateShort(o.dueDate) : "") + (isAdmin() ? (o.dueDate ? " · " : "") + money(o.price) : "") + "</div></div>" +
              '<span class="pill st-' + st.key + '">' + st.label + "</span>" +
            "</div>"
          );
        }).join("") : '<p style="color:var(--muted)">No orders yet for this client.</p>') +
        '<div class="modal-actions">' +
          (canEdit() ? '<button class="btn btn-ghost" data-edit-client="' + c.id + '">✎ Edit Client</button>' : "") +
          '<span class="spacer"></span>' +
          (canEdit() ? '<button class="btn btn-primary" data-new-order-for="' + c.id + '">+ New Order for ' + esc(c.name.split(" ")[0]) + "</button>" : "") +
        "</div>" +
      "</div>"
    );
  }

  function deleteClient(id) {
    if (!isAdmin()) return;
    var c = clientById(id);
    if (!c) return;
    var n = ordersForClient(id).length;
    var msg = n
      ? "Delete client “" + c.name + "” AND her " + n + " order(s)? This cannot be undone."
      : "Delete client “" + c.name + "”? This cannot be undone.";
    if (!confirm(msg)) return;
    sb.from("clients").delete().eq("id", id).then(function (res) {
      if (res.error) return fail(res.error, "Could not delete");
      db.clients = db.clients.filter(function (x) { return x.id !== id; });
      db.orders = db.orders.filter(function (o) { return o.clientId !== id; });
      renderAll();
      closeModal();
      toast("Client deleted");
    });
  }

  /* ---------- Order form ---------- */

  function showOrderForm(orderId, presetClientId) {
    if (!canEdit()) return;
    var o = orderId ? orderById(orderId) : null;

    if (!o && db.clients.length === 0) {
      openModal(
        modalHead("New Order", "") +
        '<div class="modal-body">' +
          '<div class="notice">An order belongs to a client. Add the client first (with her measurements), then the order takes seconds.</div>' +
          '<div class="modal-actions"><span class="spacer"></span>' +
          '<button class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
          '<button class="btn btn-primary" data-action="new-client-then-order">+ Add Client First</button></div>' +
        "</div>"
      );
      return;
    }

    var clientOpts = db.clients.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
      .map(function (c) {
        var sel = (o ? o.clientId : presetClientId) === c.id ? " selected" : "";
        return '<option value="' + c.id + '"' + sel + ">" + esc(c.name) + "</option>";
      }).join("");

    var garmentOpts = GARMENTS.map(function (g) { return '<option value="' + esc(g) + '">'; }).join("");

    openModal(
      modalHead(o ? "Edit Order " + esc(o.ref) : "New Order", "") +
      '<div class="modal-body"><form id="orderForm" data-order-id="' + (o ? o.id : "") + '">' +
        '<div class="form-grid">' +
          '<div class="field full"><label for="o_client">Client *</label><select id="o_client" required>' +
            '<option value="">Choose client</option>' + clientOpts + "</select></div>" +
          '<div class="field"><label for="o_garment">Garment / outfit *</label><input id="o_garment" required list="garmentList" value="' + esc(o ? o.garment : "") + '" placeholder="e.g. Gown"><datalist id="garmentList">' + garmentOpts + "</datalist></div>" +
          '<div class="field"><label for="o_fabric">Fabric</label><input id="o_fabric" value="' + esc(o ? o.fabric : "") + '" placeholder="e.g. Blue Ankara, 4 yards"></div>' +
          '<div class="field"><label for="o_fabricBy">Fabric provided by</label><select id="o_fabricBy">' +
            '<option value="client"' + (o && o.fabricBy === "client" ? " selected" : "") + ">Client</option>" +
            '<option value="studio"' + (o && o.fabricBy === "studio" ? " selected" : "") + ">Us (studio)</option>" +
          "</select></div>" +
          '<div class="checkbox-field"><input type="checkbox" id="o_urgent"' + (o && o.urgent ? " checked" : "") + '><label for="o_urgent">Urgent order</label></div>' +
          '<div class="field full"><label for="o_desc">Style description</label><textarea id="o_desc" placeholder="Neckline, sleeves, length, embellishments, reference style…">' + esc(o ? o.description : "") + "</textarea></div>" +
          '<div class="field"><label for="o_orderDate">Order date</label><input id="o_orderDate" type="date" value="' + esc(o ? o.orderDate || "" : todayISO()) + '"></div>' +
          '<div class="field"><label for="o_dueDate">Due date</label><input id="o_dueDate" type="date" value="' + esc(o ? o.dueDate || "" : "") + '"></div>' +
          (isAdmin() ? '<div class="field"><label for="o_price">Total price</label><input id="o_price" type="number" min="0" step="any" inputmode="decimal" value="' + esc(o ? o.price : "") + '" placeholder="0"></div>' : "") +
          (isAdmin() && !o ? '<div class="field"><label for="o_deposit">Deposit paid now</label><input id="o_deposit" type="number" min="0" step="any" inputmode="decimal" placeholder="0"></div>' : "") +
          (isAdmin() ? "" : '<div class="field full"><div class="notice" style="margin-bottom:0">Pricing and payments are managed by the Admin.</div></div>') +
          '<div class="field full"><label for="o_notes">Notes</label><textarea id="o_notes" placeholder="Anything else to remember…">' + esc(o ? o.notes : "") + "</textarea></div>" +
        "</div>" +
        '<div class="modal-actions">' +
          (o && isAdmin() ? '<button type="button" class="btn btn-danger btn-sm" data-delete-order="' + o.id + '">Delete</button>' : "") +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
          '<button type="submit" class="btn btn-primary">' + (o ? "Save Changes" : "Create Order") + "</button>" +
        "</div>" +
      "</form></div>"
    );
  }

  function submitOrderForm(form) {
    var id = form.getAttribute("data-order-id");
    var isNew = !id;

    var row = {
      client_id: $("#o_client").value,
      garment: $("#o_garment").value.trim(),
      fabric: $("#o_fabric").value.trim(),
      fabric_by: $("#o_fabricBy").value,
      urgent: $("#o_urgent").checked,
      description: $("#o_desc").value.trim(),
      order_date: $("#o_orderDate").value || null,
      due_date: $("#o_dueDate").value || null,
      notes: $("#o_notes").value.trim()
    };
    if ($("#o_price")) row.price = Number($("#o_price").value || 0);

    if (isNew) {
      var dep = Number(($("#o_deposit") && $("#o_deposit").value) || 0);
      if ($("#o_price")) row.payments = dep > 0 ? [{ amount: dep, date: row.order_date || todayISO(), note: "Deposit" }] : [];
      row.status = "new";
    }

    busy("#orderForm", true);
    var q = isNew
      ? sb.from("orders").insert(row).select(ORDER_COLS).single()
      : sb.from("orders").update(row).eq("id", id).select(ORDER_COLS).single();

    q.then(function (res) {
      if (res.error) { busy("#orderForm", false); return fail(res.error, "Could not save order"); }
      var saved = rowToOrder(res.data);
      // money columns never come back from the database; carry them over
      var prevO = id ? orderById(id) : null;
      saved.price = row.price !== undefined ? row.price : (prevO ? prevO.price : 0);
      saved.payments = row.payments !== undefined ? row.payments : (prevO ? prevO.payments : []);
      if (isNew) db.orders.push(saved);
      else db.orders = db.orders.map(function (x) { return x.id === saved.id ? saved : x; });
      renderAll();
      toast(isNew ? "Order " + saved.ref + " created ✓" : "Order saved ✓");
      showOrderDetail(saved.id);
    });
  }

  /* ---------- Order detail ---------- */

  function showOrderDetail(id) {
    var o = orderById(id);
    if (!o) return;
    var c = clientById(o.clientId);
    var st = statusOf(o);
    var paid = paidTotal(o);
    var bal = balanceOf(o);
    var wa = c ? phoneDigits(c.phone) : "";

    var stepper = STATUSES.map(function (s, i) {
      var cls = s.key === o.status ? "current" : statusIndex(o.status) > i ? "done" : "";
      return canEdit()
        ? '<button class="step-btn ' + cls + '" data-set-status="' + s.key + '" data-order="' + o.id + '">' + s.label + "</button>"
        : '<span class="step-btn ' + cls + '">' + s.label + "</span>";
    }).join("");

    var payRows = (o.payments || []).map(function (p, i) {
      return "<tr><td>" + esc(fmtDateShort(p.date)) + (p.note ? " · " + esc(p.note) : "") + "</td>" +
        "<td>" + money(p.amount) +
        (isAdmin() ? ' <button class="btn btn-ghost btn-sm no-print" data-del-payment="' + i + '" data-order="' + o.id + '" title="Remove payment">✕</button>' : "") +
        "</td></tr>";
    }).join("");

    openModal(
      modalHead(
        esc(o.ref) + " · " + esc(o.garment || "Order"),
        'for <strong>' + esc(c ? c.name : "(deleted client)") + "</strong>" + (o.urgent && isOpen(o) ? ' &nbsp;<span class="badge-urgent">URGENT</span>' : "")
      ) +
      '<div class="modal-body">' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">' +
          '<span class="pill st-' + st.key + '"><span class="pill-dot"></span>' + st.label + "</span>" + dueBadge(o) +
        "</div>" +
        (o.status !== "cancelled"
          ? '<div class="stepper">' + stepper + "</div>"
          : '<div class="notice">This order was cancelled.' + (canEdit() ? ' <button class="btn btn-subtle btn-sm" data-set-status="new" data-order="' + o.id + '">Reopen</button>' : "") + "</div>") +

        '<div class="detail-grid">' +
          detail("Order date", fmtDate(o.orderDate)) +
          detail("Due date", fmtDate(o.dueDate)) +
          detail("Fabric", esc(o.fabric || "-") + (o.fabricBy ? " (" + (o.fabricBy === "client" ? "client's fabric" : "our fabric") + ")" : "")) +
          (isAdmin() ? detail("Price", money(o.price), true) : "") +
          (o.description ? '<div class="detail-item full"><div class="dt">Style description</div><div class="dd">' + esc(o.description) + "</div></div>" : "") +
          (o.notes ? '<div class="detail-item full"><div class="dt">Notes</div><div class="dd">' + esc(o.notes) + "</div></div>" : "") +
        "</div>" +

        (c && (c.phone || wa)
          ? '<div class="contact-row no-print">' +
              (c.phone ? '<a class="contact-link" href="tel:' + esc(c.phone) + '">📞 Call</a>' : "") +
              (wa ? '<a class="contact-link whatsapp" href="https://wa.me/' + wa + '" target="_blank" rel="noopener">💬 WhatsApp ' + esc(c.name.split(" ")[0]) + "</a>" : "") +
            "</div>"
          : "") +

        clientMeasureBlock(c) +

        (isAdmin()
          ? '<h3 class="section-title">💰 Payments</h3>' +
            (payRows ? '<table class="pay-table"><tbody>' + payRows + "</tbody></table>" : '<p style="color:var(--muted);font-size:14px">No payments recorded yet.</p>') +
            '<div class="pay-summary"><span>Paid: <span style="color:var(--green)">' + money(paid) + "</span></span>" +
              "<span>Balance: <span style=\"color:" + (bal > 0 ? "var(--red)" : "var(--green)") + '">' + money(bal) + "</span></span></div>" +
            '<form class="pay-form" id="paymentForm" data-order-id="' + o.id + '">' +
              '<input type="number" min="0.01" step="any" inputmode="decimal" id="p_amount" placeholder="Amount" required>' +
              '<button type="submit" class="btn btn-primary btn-sm">+ Add Payment</button>' +
            "</form>"
          : "") +

        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-sm" data-print-order>🖨 Print job card</button>' +
          (isOpen(o) && canEdit() ? '<button class="btn btn-ghost btn-sm" data-set-status="cancelled" data-order="' + o.id + '">Cancel order</button>' : "") +
          '<span class="spacer"></span>' +
          (canEdit() ? '<button class="btn btn-ghost" data-edit-order="' + o.id + '">✎ Edit</button>' : "") +
          (o.status === "ready" && canEdit() ? '<button class="btn btn-primary" data-set-status="delivered" data-order="' + o.id + '">✓ Mark Delivered</button>' : "") +
        "</div>" +
      "</div>"
    );
  }

  function detail(dt, dd, big) {
    return '<div class="detail-item"><div class="dt">' + dt + '</div><div class="dd' + (big ? " big" : "") + '">' + dd + "</div></div>";
  }

  function clientMeasureBlock(c) {
    if (!c) return "";
    var m = c.measurements || {};
    var tiles = MEASUREMENTS.filter(function (mm) { return m[mm[0]]; }).map(function (mm) {
      return '<div class="measure-tile"><div class="m-label">' + mm[1] + '</div><div class="m-value">' + esc(m[mm[0]]) + "</div></div>";
    }).join("");
    if (!tiles) return "";
    return '<h3 class="section-title">📏 ' + esc(c.name.split(" ")[0]) + "'s measurements</h3>" +
      '<div class="measure-view">' + tiles + "</div>" +
      (c.measureNotes ? '<p style="margin-top:8px;font-size:14px;color:var(--muted)"><strong>Notes:</strong> ' + esc(c.measureNotes) + "</p>" : "");
  }

  function persistOrderPatch(orderId, patch, onDone) {
    sb.from("orders").update(patch).eq("id", orderId).select(ORDER_COLS).single().then(function (res) {
      if (res.error) return fail(res.error, "Could not update order");
      var saved = rowToOrder(res.data);
      // money columns never come back from the database; carry them over
      var prev = orderById(orderId);
      saved.price = patch.price !== undefined ? patch.price : (prev ? prev.price : 0);
      saved.payments = patch.payments !== undefined ? patch.payments : (prev ? prev.payments : []);
      db.orders = db.orders.map(function (x) { return x.id === saved.id ? saved : x; });
      renderAll();
      if (onDone) onDone(saved);
    });
  }

  function setStatus(orderId, status) {
    if (!canEdit()) return;
    var o = orderById(orderId);
    if (!o) return;
    if (status === "cancelled" && !confirm("Cancel order " + o.ref + "?")) return;
    var patch = { status: status };
    if (status === "delivered") patch.delivered_at = todayISO();
    persistOrderPatch(orderId, patch, function (saved) {
      toast(saved.ref + " → " + (status === "cancelled" ? "Cancelled" : statusOf(saved).label));
      if ($("#modalRoot").innerHTML) showOrderDetail(orderId);
    });
  }

  function deleteOrder(id) {
    if (!isAdmin()) return;
    var o = orderById(id);
    if (!o) return;
    if (!confirm("Delete order " + o.ref + " permanently? This cannot be undone.")) return;
    sb.from("orders").delete().eq("id", id).then(function (res) {
      if (res.error) return fail(res.error, "Could not delete");
      db.orders = db.orders.filter(function (x) { return x.id !== id; });
      renderAll();
      closeModal();
      toast("Order deleted");
    });
  }

  /* ---------- Menu: settings, team, backup, sign out ---------- */

  function showSettings() {
    var roleLabel = { admin: "Admin", staff: "Staff", viewer: "Viewer" }[me ? me.role : "viewer"];

    var teamRows = db.profiles.map(function (p) {
      var isSelf = me && p.id === me.id;
      var select = isAdmin()
        ? '<select data-role-for="' + p.id + '"' + (isSelf ? " disabled title=\"You cannot change your own role\"" : "") + ">" +
            ROLES.map(function (r) {
              return '<option value="' + r[0] + '"' + (p.role === r[0] ? " selected" : "") + ">" + r[1] + "</option>";
            }).join("") + "</select>"
        : '<span class="role-badge role-' + esc(p.role) + '">' + esc(p.role) + "</span>";
      return (
        '<div class="team-row">' +
          "<div><div class=\"t-name\">" + esc(p.fullName || "(no name)") + (isSelf ? " (you)" : "") + '</div>' +
          '<div class="t-email">' + esc(p.email) + "</div></div>" + select +
        "</div>"
      );
    }).join("");

    openModal(
      modalHead("Menu", 'Signed in as <strong>' + esc(me ? (me.fullName || me.email) : "") + '</strong> · <span class="role-badge role-' + esc(me ? me.role : "viewer") + '">' + roleLabel + "</span>") +
      '<div class="modal-body">' +

        (isAdmin()
          ? '<form id="settingsForm"><div class="form-grid">' +
              '<div class="field"><label for="s_name">Business name</label><input id="s_name" value="' + esc(db.settings.businessName) + '"></div>' +
              '<div class="field"><label for="s_currency">Currency symbol</label><input id="s_currency" value="' + esc(db.settings.currency) + '" maxlength="4"><div class="hint">e.g. ₦, $, £, GH₵</div></div>' +
            "</div>" +
            '<div class="modal-actions" style="border:none;margin-top:10px;padding-top:0"><span class="spacer"></span>' +
            '<button type="submit" class="btn btn-primary btn-sm">Save Settings</button></div></form>'
          : "") +

        '<h3 class="section-title">👥 Team</h3>' +
        (isAdmin()
          ? '<p style="font-size:13.5px;color:var(--muted);margin-bottom:6px">New sign-ups start as Viewers. Set each person\'s access level here; changes apply immediately.</p>'
          : '<p style="font-size:13.5px;color:var(--muted);margin-bottom:6px">Only the Admin can change roles.</p>') +
        teamRows +

        (isAdmin()
          ? '<h3 class="section-title">💾 Backup</h3>' +
            '<p style="font-size:14px;color:var(--muted);margin-bottom:10px">Your data lives in the cloud database and is backed up by Supabase. You can also download a copy anytime.</p>' +
            '<button class="btn btn-subtle" data-action="export-data">⬇ Download data copy</button>'
          : "") +

        '<div class="modal-actions">' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-danger" data-action="sign-out">Sign Out</button>' +
        "</div>" +
      "</div>"
    );
  }

  function saveSettings() {
    var name = $("#s_name").value.trim() || "Bojamiley";
    var cur = $("#s_currency").value || "₦";
    sb.from("settings").update({ business_name: name, currency: cur }).eq("id", 1).then(function (res) {
      if (res.error) return fail(res.error, "Could not save settings");
      db.settings.businessName = name;
      db.settings.currency = cur;
      renderAll();
      toast("Settings saved ✓");
    });
  }

  function changeRole(userId, role) {
    sb.from("profiles").update({ role: role }).eq("id", userId).select().single().then(function (res) {
      if (res.error) return fail(res.error, "Could not change role");
      var saved = rowToProfile(res.data);
      db.profiles = db.profiles.map(function (p) { return p.id === saved.id ? saved : p; });
      toast((saved.fullName || saved.email) + " is now " + saved.role);
      showSettings();
    });
  }

  function exportData() {
    var blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bojamiley-crm-backup-" + todayISO() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    toast("Data copy downloaded ✓");
  }

  /* ============================================================
     EVENTS
     ============================================================ */

  function switchTab(tab) {
    ui.tab = tab;
    $all(".tab").forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === tab); });
    $all(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + tab); });
  }

  document.addEventListener("click", function (e) {
    var t = e.target;

    var el = t.closest("[data-tab],[data-action],[data-order-filter],[data-open-order],[data-open-client],[data-advance-order],[data-edit-client],[data-delete-client],[data-new-order-for],[data-edit-order],[data-delete-order],[data-set-status],[data-del-payment],[data-print-order],[data-modal-overlay]");
    if (!el) return;

    if (el.hasAttribute("data-modal-overlay")) {
      if (e.target === el) closeModal();
      return;
    }

    if (el.hasAttribute("data-tab")) { switchTab(el.getAttribute("data-tab")); return; }

    if (el.hasAttribute("data-order-filter")) {
      ui.orderFilter = el.getAttribute("data-order-filter");
      renderOrders();
      return;
    }

    if (el.hasAttribute("data-advance-order")) {
      e.stopPropagation();
      var ao = orderById(el.getAttribute("data-advance-order"));
      var ns = ao && nextStatus(ao);
      if (ns) setStatus(ao.id, ns.key);
      return;
    }

    if (el.hasAttribute("data-open-order")) { showOrderDetail(el.getAttribute("data-open-order")); return; }
    if (el.hasAttribute("data-open-client")) { showClientDetail(el.getAttribute("data-open-client")); return; }
    if (el.hasAttribute("data-edit-client")) { showClientForm(el.getAttribute("data-edit-client")); return; }
    if (el.hasAttribute("data-delete-client")) { deleteClient(el.getAttribute("data-delete-client")); return; }
    if (el.hasAttribute("data-new-order-for")) { showOrderForm(null, el.getAttribute("data-new-order-for")); return; }
    if (el.hasAttribute("data-edit-order")) { showOrderForm(el.getAttribute("data-edit-order")); return; }
    if (el.hasAttribute("data-delete-order")) { deleteOrder(el.getAttribute("data-delete-order")); return; }
    if (el.hasAttribute("data-print-order")) { window.print(); return; }

    if (el.hasAttribute("data-set-status")) {
      setStatus(el.getAttribute("data-order"), el.getAttribute("data-set-status"));
      return;
    }

    if (el.hasAttribute("data-del-payment")) {
      if (!isAdmin()) return;
      var oid = el.getAttribute("data-order");
      var ord = orderById(oid);
      var idx = Number(el.getAttribute("data-del-payment"));
      if (ord && ord.payments[idx] && confirm("Remove this payment of " + money(ord.payments[idx].amount) + "?")) {
        var next = ord.payments.slice();
        next.splice(idx, 1);
        persistOrderPatch(oid, { payments: next }, function () { showOrderDetail(oid); });
      }
      return;
    }

    var action = el.getAttribute("data-action");
    switch (action) {
      case "close-modal": closeModal(); break;
      case "new-order": showOrderForm(null, null); break;
      case "new-client": showClientForm(null); break;
      case "new-client-then-order": showClientForm(null, { thenOrder: true }); break;
      case "open-settings": showSettings(); break;
      case "export-data": exportData(); break;
      case "sign-out": signOut(); break;
      case "go-orders": switchTab("orders"); break;
      case "show-signup":
        e.preventDefault();
        $("#signinForm").hidden = true;
        $("#signupForm").hidden = false;
        $("#authSub").textContent = "Create your account";
        break;
      case "show-signin":
        e.preventDefault();
        $("#signupForm").hidden = true;
        $("#signinForm").hidden = false;
        $("#authSub").textContent = "Sign in to your studio workspace";
        break;
    }
  });

  document.addEventListener("change", function (e) {
    var el = e.target.closest("[data-role-for]");
    if (el && isAdmin()) changeRole(el.getAttribute("data-role-for"), el.value);
  });

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (form.id === "clientForm") { e.preventDefault(); submitClientForm(form); }
    else if (form.id === "orderForm") { e.preventDefault(); submitOrderForm(form); }
    else if (form.id === "signinForm") { e.preventDefault(); doSignIn(form); }
    else if (form.id === "signupForm") { e.preventDefault(); doSignUp(form); }
    else if (form.id === "settingsForm") { e.preventDefault(); saveSettings(); }
    else if (form.id === "paymentForm") {
      e.preventDefault();
      if (!isAdmin()) return;
      var o = orderById(form.getAttribute("data-order-id"));
      var amt = Number($("#p_amount").value || 0);
      if (o && amt > 0) {
        var next = (o.payments || []).concat([{ amount: amt, date: todayISO(), note: "" }]);
        persistOrderPatch(o.id, { payments: next }, function (saved) {
          toast("Payment of " + money(amt) + " recorded ✓");
          showOrderDetail(saved.id);
        });
      }
    }
  });

  document.addEventListener("input", function (e) {
    if (e.target.id === "orderSearch") { ui.orderSearch = e.target.value; renderOrdersPreservingFocus(); }
    else if (e.target.id === "clientSearch") { ui.clientSearch = e.target.value; renderClientsPreservingFocus(); }
  });

  function renderOrdersPreservingFocus() {
    var pos = $("#orderSearch").selectionStart;
    renderOrders();
    var inp = $("#orderSearch");
    inp.focus();
    inp.setSelectionRange(pos, pos);
  }

  function renderClientsPreservingFocus() {
    var pos = $("#clientSearch").selectionStart;
    renderClients();
    var inp = $("#clientSearch");
    inp.focus();
    inp.setSelectionRange(pos, pos);
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });
})();
