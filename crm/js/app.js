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

  // Standard dress sizes from the studio size chart. Stored as
  // measurements.size, alongside (or instead of) detailed measurements.
  var SIZES = ["6", "8", "10", "12", "14", "16", "18", "20"];

  // Inventory categories and units of measure (suggestions; free text allowed).
  var CATEGORIES = [
    "Fabric", "Lace", "Lining", "Interfacing", "Trim & Ribbon", "Thread",
    "Beads & Stones", "Zippers", "Buttons", "Hooks & Fasteners", "Accessory",
    "Finished Piece", "Packaging", "Other"
  ];
  var UNITS = ["yards", "meters", "pieces", "rolls", "spools", "sets", "packs", "metres"];
  // Reasons for a stock movement (quick-pick; free text allowed).
  var STOCK_IN_REASONS = ["Received from supplier", "Returned to stock", "Stock count correction", "Opening stock"];
  var STOCK_OUT_REASONS = ["Used for an order", "Damaged / wastage", "Sample / giveaway", "Stock count correction"];

  // What an order photo shows. Inventory photos are always "other".
  var PHOTO_KINDS = [
    ["style", "Style reference"],
    ["fabric", "Fabric"],
    ["fitting", "Fitting"],
    ["finished", "Finished piece"],
    ["other", "Other"]
  ];
  var PHOTO_MAX_EDGE = 1280;   // longest edge after compression
  var PHOTO_QUALITY = 0.8;     // JPEG quality

  /* ---------- State ---------- */

  var db = { settings: { businessName: "Bojamiley", currency: "₦" }, clients: [], orders: [], profiles: [], inventory: [], photos: [], invoices: [], invoiceSettings: null };
  var me = null; // my profile row: { id, email, fullName, role }
  var ui = { tab: "dashboard", orderFilter: "active", orderSearch: "", clientSearch: "", anMonth: null, invSearch: "", invCat: "all", invoiceSearch: "" };

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

  // unit_cost is admin-only on inventory_items (served via inventory_costs view).
  var ITEM_COLS = "id,name,category,color,unit,quantity,reorder_level,supplier,notes,created_at,updated_at";

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

  function rowToItem(r) {
    return {
      id: r.id, name: r.name, category: r.category, color: r.color,
      unit: r.unit, quantity: Number(r.quantity || 0),
      reorderLevel: Number(r.reorder_level || 0),
      supplier: r.supplier, notes: r.notes,
      unitCost: null, // filled from inventory_costs view for admins
      createdAt: r.created_at, updatedAt: r.updated_at
    };
  }

  function rowToPhoto(r) {
    return {
      id: r.id, orderId: r.order_id, itemId: r.item_id, path: r.path,
      kind: r.kind, caption: r.caption, createdAt: r.created_at, createdBy: r.created_by
    };
  }

  function rowToInvoice(r) {
    return {
      id: r.id, number: r.number, clientId: r.client_id, orderIds: r.order_ids || [],
      clientName: r.client_name, clientPhone: r.client_phone, clientAddress: r.client_address,
      issueDate: r.issue_date, dueDate: r.due_date, items: r.items || [],
      subtotal: Number(r.subtotal || 0), discount: Number(r.discount || 0),
      total: Number(r.total || 0), amountPaid: Number(r.amount_paid || 0),
      balance: Number(r.balance || 0), notes: r.notes, status: r.status,
      createdAt: r.created_at
    };
  }

  function rowToInvSettings(r) {
    if (!r) return null;
    return {
      businessPhone: r.business_phone, businessAddress: r.business_address,
      businessEmail: r.business_email, bankName: r.bank_name,
      bankAccountName: r.bank_account_name, bankAccountNumber: r.bank_account_number,
      defaultNotes: r.default_notes
    };
  }

  function itemToRow(it) {
    var row = {
      name: it.name, category: it.category, color: it.color, unit: it.unit,
      reorder_level: it.reorderLevel, supplier: it.supplier, notes: it.notes
    };
    if (it.unitCost !== undefined && it.unitCost !== null) row.unit_cost = it.unitCost;
    return row;
  }

  /* ---------- Data loading ---------- */

  function loadAll() {
    return Promise.all([
      sb.from("settings").select("*").eq("id", 1).single(),
      sb.from("clients").select(CLIENT_COLS).order("name"),
      sb.from("orders").select(ORDER_COLS).order("created_at"),
      sb.from("profiles").select("*").order("created_at"),
      sb.from("client_contacts").select("*"), // rows only come back for admins
      sb.from("order_money").select("*"),     // rows only come back for admins
      sb.from("inventory_items").select(ITEM_COLS).order("name"),
      sb.from("inventory_costs").select("*"),  // rows only come back for admins
      sb.from("photos").select("*").order("created_at"),
      // both admin-only: non-admins get zero rows, never an error
      sb.from("invoices").select("*").order("created_at", { ascending: false }),
      sb.from("invoice_settings").select("*")
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
      db.inventory = res[6].data.map(rowToItem);
      var costs = {};
      (res[7].data || []).forEach(function (r) { costs[r.id] = r; });
      db.inventory.forEach(function (it) {
        var k = costs[it.id];
        it.unitCost = k ? Number(k.unit_cost || 0) : null; // null = hidden from this user
      });
      db.photos = (res[8].data || []).map(rowToPhoto);
      db.invoices = (res[9].data || []).map(rowToInvoice);
      db.invoiceSettings = rowToInvSettings((res[10].data || [])[0]);
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
      db.clients = []; db.orders = []; db.profiles = []; db.inventory = []; db.photos = [];
      db.invoices = []; db.invoiceSettings = null;
      signedCache = {};
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
    $all("[data-needs-edit]").forEach(function (el) { el.style.display = canEdit() ? "" : "none"; });
    $("#analyticsTab").hidden = !isAdmin();
    $("#invoicesTab").hidden = !isAdmin();
    renderDashboard();
    renderOrders();
    renderClients();
    renderInventory();
    renderInvoices();
    if (isAdmin()) renderAnalytics();
  }

  /* ---------- Inventory ---------- */

  function isLowStock(it) {
    return it.reorderLevel > 0 && it.quantity <= it.reorderLevel;
  }

  function itemValue(it) {
    return it.unitCost == null ? null : it.quantity * it.unitCost;
  }

  function fmtQty(n) {
    var v = Number(n || 0);
    return (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function renderInventory() {
    var view = $("#view-inventory");
    if (!view) return;

    var list = db.inventory.slice();
    var cats = {};
    db.inventory.forEach(function (it) { cats[it.category] = (cats[it.category] || 0) + 1; });
    var catList = Object.keys(cats).sort();

    if (ui.invCat !== "all") list = list.filter(function (it) { return it.category === ui.invCat; });
    if (ui.invSearch) {
      var q = ui.invSearch.toLowerCase();
      list = list.filter(function (it) {
        return (it.name + " " + it.category + " " + it.color + " " + it.supplier + " " + it.notes).toLowerCase().indexOf(q) !== -1;
      });
    }
    list.sort(function (a, b) {
      var la = isLowStock(a) ? 0 : 1, lb = isLowStock(b) ? 0 : 1;
      return la - lb || a.name.localeCompare(b.name);
    });

    var low = db.inventory.filter(isLowStock);

    var html =
      '<div class="view-head"><h2>Inventory</h2>' +
        (canEdit() ? '<button class="btn btn-primary" data-action="new-item">+ Add Item</button>' : "") + "</div>";

    if (low.length) {
      html += '<div class="notice" style="background:var(--red-soft);border-color:#eecfca;color:var(--red)">' +
        "⚠ <strong>" + low.length + " item" + (low.length === 1 ? "" : "s") + " low on stock.</strong> " +
        esc(low.slice(0, 4).map(function (it) { return it.name; }).join(", ")) +
        (low.length > 4 ? " and " + (low.length - 4) + " more" : "") + ".</div>";
    }

    html +=
      '<div class="toolbar">' +
        '<input class="search-input" id="invSearch" type="search" placeholder="Search fabric, colour, supplier…" value="' + esc(ui.invSearch) + '">' +
        '<div class="chip-row">' +
          '<button class="chip ' + (ui.invCat === "all" ? "active" : "") + '" data-inv-cat="all">All</button>' +
          catList.map(function (c) {
            return '<button class="chip ' + (ui.invCat === c ? "active" : "") + '" data-inv-cat="' + esc(c) + '">' + esc(c) + " (" + cats[c] + ")</button>";
          }).join("") +
        "</div>" +
      "</div>";

    if (list.length) {
      html += '<div class="card-list">' + list.map(itemCard).join("") + "</div>";
    } else if (db.inventory.length === 0) {
      html += '<div class="empty"><span class="empty-icon">🧵</span><h3>No stock items yet</h3>' +
        "<p>Track your fabrics, linings, trims, thread, beads and accessories so you always know what you have and what to reorder.</p>" +
        (canEdit() ? '<button class="btn btn-primary" data-action="new-item">+ Add Item</button>' : "") + "</div>";
    } else {
      html += '<div class="empty"><span class="empty-icon">🔍</span><h3>No items match</h3><p>Try a different search or category.</p></div>';
    }

    view.innerHTML = html;
  }

  function itemCard(it) {
    var low = isLowStock(it);
    var val = itemValue(it);
    return (
      '<div class="item-card" data-open-item="' + it.id + '">' +
        '<div class="card-top">' +
          '<div><div class="card-title">' + esc(it.name) + (it.color ? ' <span class="ref" style="text-transform:none">' + esc(it.color) + "</span>" : "") + "</div>" +
          '<div class="card-sub">' + esc(it.category) + (it.supplier ? " · " + esc(it.supplier) : "") + "</div></div>" +
          '<div class="card-badges">' +
            (low ? '<span class="due-badge due-overdue">Low stock</span>' : "") +
          "</div>" +
        "</div>" +
        '<div class="card-foot">' +
          '<div class="qty-display"><span class="qty-num' + (low ? " low" : "") + '">' + fmtQty(it.quantity) + '</span> <span class="qty-unit">' + esc(it.unit) + "</span>" +
            (it.reorderLevel > 0 ? ' <span class="qty-reorder">reorder at ' + fmtQty(it.reorderLevel) + "</span>" : "") + "</div>" +
          (val != null ? '<span class="balance-chip" style="color:var(--accent-dark)">' + money(val) + " value</span>" : "") +
        "</div>" +
      "</div>"
    );
  }

  function itemById(id) {
    for (var i = 0; i < db.inventory.length; i++) if (db.inventory[i].id === id) return db.inventory[i];
    return null;
  }

  function showItemForm(itemId) {
    if (!canEdit()) return;
    var it = itemId ? itemById(itemId) : null;
    var isNew = !it;

    var catOpts = CATEGORIES.map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");
    var unitOpts = UNITS.map(function (u) {
      return '<option value="' + esc(u) + '"' + (it && it.unit === u ? " selected" : (!it && u === "yards" ? " selected" : "")) + ">" + esc(u) + "</option>";
    }).join("");

    openModal(
      modalHead(it ? "Edit Item" : "Add Stock Item", it ? esc(it.name) : "Fabric, lining, trim, thread, beads, accessories — whatever you keep in stock.") +
      '<div class="modal-body"><form id="itemForm" data-item-id="' + (it ? it.id : "") + '">' +
        '<div class="form-grid">' +
          '<div class="field full"><label for="i_name">Item name *</label><input id="i_name" required value="' + esc(it ? it.name : "") + '" placeholder="e.g. Ivory French Lace"></div>' +
          '<div class="field"><label for="i_category">Category</label><input id="i_category" list="catList" value="' + esc(it ? it.category : "Fabric") + '" placeholder="Fabric"><datalist id="catList">' + catOpts + "</datalist></div>" +
          '<div class="field"><label for="i_color">Colour</label><input id="i_color" value="' + esc(it ? it.color : "") + '" placeholder="e.g. Ivory"></div>' +
          '<div class="field"><label for="i_unit">Unit</label><select id="i_unit">' + unitOpts + "</select></div>" +
          (isNew ? '<div class="field"><label for="i_qty">Opening quantity</label><input id="i_qty" type="number" min="0" step="any" inputmode="decimal" value="0"></div>'
                 : '<div class="field"><label>In stock now</label><input value="' + esc(fmtQty(it.quantity) + " " + it.unit) + '" disabled><div class="hint">Use Stock in / out to change this.</div></div>') +
          '<div class="field"><label for="i_reorder">Reorder level (low-stock alert)</label><input id="i_reorder" type="number" min="0" step="any" inputmode="decimal" value="' + esc(it ? it.reorderLevel : "") + '" placeholder="e.g. 5"></div>' +
          (isAdmin() ? '<div class="field"><label for="i_cost">Cost per ' + esc(it ? it.unit : "unit") + '</label><input id="i_cost" type="number" min="0" step="any" inputmode="decimal" value="' + esc(it && it.unitCost != null ? it.unitCost : "") + '" placeholder="0"></div>'
                     : '<div class="field full"><div class="notice" style="margin-bottom:0">Cost is managed by the Admin.</div></div>') +
          '<div class="field"><label for="i_supplier">Supplier</label><input id="i_supplier" value="' + esc(it ? it.supplier : "") + '" placeholder="Where to reorder"></div>' +
          '<div class="field full"><label for="i_notes">Notes</label><textarea id="i_notes" placeholder="Anything to remember…">' + esc(it ? it.notes : "") + "</textarea></div>" +
        "</div>" +
        '<div class="modal-actions">' +
          (it && isAdmin() ? '<button type="button" class="btn btn-danger btn-sm" data-delete-item="' + it.id + '">Delete</button>' : "") +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
          '<button type="submit" class="btn btn-primary">' + (it ? "Save Changes" : "Add Item") + "</button>" +
        "</div>" +
      "</form></div>"
    );
    $("#i_name").focus();
  }

  function submitItemForm(form) {
    var id = form.getAttribute("data-item-id");
    var isNew = !id;
    var it = {
      name: $("#i_name").value.trim(),
      category: $("#i_category").value.trim() || "Other",
      color: $("#i_color").value.trim(),
      unit: $("#i_unit").value,
      reorderLevel: Number($("#i_reorder").value || 0),
      supplier: $("#i_supplier").value.trim(),
      notes: $("#i_notes").value.trim()
    };
    if ($("#i_cost")) it.unitCost = Number($("#i_cost").value || 0);

    busy("#itemForm", true);
    var q = isNew
      ? sb.from("inventory_items").insert(itemToRow(it)).select(ITEM_COLS).single()
      : sb.from("inventory_items").update(itemToRow(it)).eq("id", id).select(ITEM_COLS).single();

    q.then(function (res) {
      if (res.error) { busy("#itemForm", false); return fail(res.error, "Could not save item"); }
      var saved = rowToItem(res.data);
      var prev = id ? itemById(id) : null;
      // unit_cost never comes back from ITEM_COLS; carry over what we know
      saved.unitCost = $("#i_cost") ? it.unitCost : (prev ? prev.unitCost : null);
      var opening = isNew ? Number(($("#i_qty") && $("#i_qty").value) || 0) : 0;

      function finish() {
        if (isNew) db.inventory.push(saved);
        else db.inventory = db.inventory.map(function (x) { return x.id === saved.id ? saved : x; });
        renderAll();
        toast(isNew ? "Item added ✓" : "Item saved ✓");
        showItemDetail(saved.id);
      }
      if (isNew && opening > 0) {
        sb.rpc("adjust_stock", { p_item: saved.id, p_delta: opening, p_reason: "Opening stock" }).then(function (r2) {
          if (!r2.error) saved.quantity = Number(r2.data);
          finish();
        });
      } else {
        finish();
      }
    });
  }

  function showItemDetail(id) {
    var it = itemById(id);
    if (!it) return;
    var low = isLowStock(it);
    var val = itemValue(it);

    openModal(
      modalHead(esc(it.name), esc(it.category) + (it.color ? " · " + esc(it.color) : "")) +
      '<div class="modal-body">' +
        '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px">' +
          '<span class="qty-num' + (low ? " low" : "") + '" style="font-size:30px">' + fmtQty(it.quantity) + '</span>' +
          '<span class="qty-unit" style="font-size:16px">' + esc(it.unit) + " in stock</span>" +
          (low ? '<span class="due-badge due-overdue">Low stock</span>' : "") +
        "</div>" +
        '<div class="detail-grid">' +
          detail("Reorder level", it.reorderLevel > 0 ? fmtQty(it.reorderLevel) + " " + esc(it.unit) : "Not set") +
          detail("Supplier", it.supplier ? esc(it.supplier) : "-") +
          (isAdmin() ? detail("Cost per " + esc(it.unit), it.unitCost != null ? money(it.unitCost) : "-") : "") +
          (val != null ? detail("Stock value", money(val), true) : "") +
          (it.notes ? '<div class="detail-item full"><div class="dt">Notes</div><div class="dd">' + esc(it.notes) + "</div></div>" : "") +
        "</div>" +

        photoStrip({ itemId: it.id }) +

        (canEdit()
          ? '<h3 class="section-title">Adjust stock</h3>' +
            '<div class="stock-actions">' +
              '<button class="btn btn-subtle" data-stock-in="' + it.id + '">＋ Stock in</button>' +
              '<button class="btn btn-subtle" data-stock-out="' + it.id + '">－ Stock out</button>' +
            "</div>"
          : "") +

        '<h3 class="section-title">History</h3>' +
        '<div id="moveList"><p style="color:var(--muted);font-size:14px">Loading…</p></div>' +

        '<div class="modal-actions">' +
          (canEdit() ? '<button class="btn btn-ghost" data-edit-item="' + it.id + '">✎ Edit</button>' : "") +
          '<span class="spacer"></span>' +
          '<button class="btn btn-ghost" data-action="close-modal">Close</button>' +
        "</div>" +
      "</div>"
    );

    loadMovements(id);
    hydratePhotos();
  }

  function loadMovements(itemId) {
    sb.from("inventory_movements").select("*").eq("item_id", itemId)
      .order("created_at", { ascending: false }).limit(50)
      .then(function (res) {
        var el = $("#moveList");
        if (!el) return;
        if (res.error) { el.innerHTML = '<p style="color:var(--muted);font-size:14px">Could not load history.</p>'; return; }
        var rows = res.data || [];
        if (!rows.length) { el.innerHTML = '<p style="color:var(--muted);font-size:14px">No stock movements yet.</p>'; return; }
        var who = {};
        db.profiles.forEach(function (p) { who[p.id] = p.fullName || p.email; });
        el.innerHTML = '<table class="pay-table"><tbody>' + rows.map(function (m) {
          var inn = Number(m.delta) >= 0;
          return "<tr><td>" + esc(fmtDateShort(m.created_at)) +
            (m.reason ? " · " + esc(m.reason) : "") +
            (who[m.created_by] ? ' <span style="color:var(--muted)">by ' + esc(who[m.created_by]) + "</span>" : "") +
            '</td><td style="color:' + (inn ? "var(--green)" : "var(--red)") + '">' +
            (inn ? "+" : "") + fmtQty(m.delta) + "</td></tr>";
        }).join("") + "</tbody></table>";
      });
  }

  function stockDialog(itemId, dir) {
    var it = itemById(itemId);
    if (!it || !canEdit()) return;
    var isIn = dir === "in";
    var reasons = isIn ? STOCK_IN_REASONS : STOCK_OUT_REASONS;
    openModal(
      modalHead((isIn ? "Stock in" : "Stock out") + " · " + esc(it.name), fmtQty(it.quantity) + " " + esc(it.unit) + " in stock now") +
      '<div class="modal-body"><form id="stockForm" data-item-id="' + it.id + '" data-dir="' + dir + '">' +
        '<div class="field"><label for="st_qty">Quantity to ' + (isIn ? "add" : "remove") + ' (' + esc(it.unit) + ') *</label>' +
          '<input id="st_qty" type="number" min="0" step="any" inputmode="decimal" required autofocus placeholder="0"></div>' +
        '<div class="field" style="margin-top:10px"><label for="st_reason">Reason</label>' +
          '<input id="st_reason" list="reasonList" placeholder="' + esc(reasons[0]) + '">' +
          '<datalist id="reasonList">' + reasons.map(function (r) { return '<option value="' + esc(r) + '">'; }).join("") + "</datalist></div>" +
        '<div class="modal-actions"><span class="spacer"></span>' +
          '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
          '<button type="submit" class="btn btn-primary">' + (isIn ? "Add to stock" : "Remove from stock") + "</button>" +
        "</div>" +
      "</form></div>"
    );
  }

  function submitStock(form) {
    var it = itemById(form.getAttribute("data-item-id"));
    if (!it || !canEdit()) return;
    var isIn = form.getAttribute("data-dir") === "in";
    var qty = Number($("#st_qty").value || 0);
    if (!(qty > 0)) { toast("Enter a quantity greater than zero", true); return; }
    if (!isIn && qty > it.quantity && !confirm("You're removing more than the " + fmtQty(it.quantity) + " " + it.unit + " in stock. Continue? (stock will go negative)")) return;
    var delta = isIn ? qty : -qty;
    var reason = $("#st_reason").value.trim() || (isIn ? "Stock in" : "Stock out");
    busy("#stockForm", true);
    sb.rpc("adjust_stock", { p_item: it.id, p_delta: delta, p_reason: reason }).then(function (res) {
      if (res.error) { busy("#stockForm", false); return fail(res.error, "Could not adjust stock"); }
      it.quantity = Number(res.data);
      db.inventory = db.inventory.map(function (x) { return x.id === it.id ? it : x; });
      renderAll();
      toast((isIn ? "Added " : "Removed ") + fmtQty(qty) + " " + it.unit + " ✓");
      showItemDetail(it.id);
    });
  }

  function deleteItem(id) {
    if (!isAdmin()) return;
    var it = itemById(id);
    if (!it) return;
    if (!confirm("Delete “" + it.name + "” and its whole stock history? This cannot be undone.")) return;
    var pics = photosForItem(id);
    purgePhotoFiles(pics).then(function () {
      return sb.from("inventory_items").delete().eq("id", id);
    }).then(function (res) {
      if (res.error) return fail(res.error, "Could not delete item");
      db.inventory = db.inventory.filter(function (x) { return x.id !== id; });
      db.photos = db.photos.filter(function (p) { return p.itemId !== id; });
      renderAll();
      closeModal();
      toast("Item deleted");
    });
  }

  /* ============================================================
     PHOTOS (orders + inventory items)
     Files live in the private "photos" storage bucket; the photos
     table holds the metadata. Visible to the whole signed-in team.
     ============================================================ */

  var signedCache = {}; // path -> { url, expires }

  function randId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function photosForOrder(orderId) {
    return db.photos.filter(function (p) { return p.orderId === orderId; });
  }

  function photosForItem(itemId) {
    return db.photos.filter(function (p) { return p.itemId === itemId; });
  }

  function kindLabel(k) {
    for (var i = 0; i < PHOTO_KINDS.length; i++) if (PHOTO_KINDS[i][0] === k) return PHOTO_KINDS[i][1];
    return "Photo";
  }

  function photoById(id) {
    for (var i = 0; i < db.photos.length; i++) if (db.photos[i].id === id) return db.photos[i];
    return null;
  }

  function canDeletePhoto(p) {
    return isAdmin() || (me && p.createdBy === me.id);
  }

  // Shrink a phone photo (often 3-8 MB) to ~150-250 KB before upload.
  // Keeps uploads quick on mobile data and the free storage tier usable.
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Could not read that file")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("That file is not a readable image")); };
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight;
          var scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = cw; canvas.height = ch;
          canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error("Could not process that image"));
          }, "image/jpeg", PHOTO_QUALITY);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Batch-sign paths for a private bucket, memoised until they near expiry.
  function signedUrls(paths) {
    var now = Date.now();
    var missing = paths.filter(function (p) {
      var c = signedCache[p];
      return !c || c.expires < now + 60000;
    });
    if (!missing.length) return Promise.resolve(signedCache);
    return sb.storage.from("photos").createSignedUrls(missing, 3600).then(function (res) {
      if (res.error) return signedCache;
      (res.data || []).forEach(function (row) {
        var p = row.path || row.signedUrl;
        if (row.signedUrl && row.path) {
          signedCache[row.path] = { url: row.signedUrl, expires: now + 3600000 };
        }
      });
      return signedCache;
    }).catch(function () { return signedCache; });
  }

  // Thumbs render empty, then get their src filled in by hydratePhotos(),
  // the same way showItemDetail fills its history list.
  function photoStrip(subject) {
    var list = subject.orderId ? photosForOrder(subject.orderId) : photosForItem(subject.itemId);
    var addBtn = canEdit()
      ? '<button class="photo-add no-print" data-add-photo="' +
          (subject.orderId ? "order:" + subject.orderId : "item:" + subject.itemId) +
        '"><span>＋</span>Add photo</button>'
      : "";
    if (!list.length && !addBtn) return "";
    return (
      '<h3 class="section-title">📷 Photos</h3>' +
      '<div class="photo-strip">' +
        list.map(function (p) {
          return '<button class="photo-thumb" data-open-photo="' + p.id + '" title="' + esc(kindLabel(p.kind)) + '">' +
            '<img alt="' + esc(p.caption || kindLabel(p.kind)) + '" data-photo-path="' + esc(p.path) + '">' +
            (subject.orderId ? '<span class="photo-kind-tag">' + esc(kindLabel(p.kind)) + "</span>" : "") +
          "</button>";
        }).join("") +
        addBtn +
      "</div>"
    );
  }

  function hydratePhotos(root) {
    var imgs = $all("img[data-photo-path]", root || document);
    if (!imgs.length) return;
    var paths = imgs.map(function (i) { return i.getAttribute("data-photo-path"); });
    signedUrls(paths).then(function (cache) {
      imgs.forEach(function (i) {
        var c = cache[i.getAttribute("data-photo-path")];
        if (c) i.src = c.url;
        else i.parentNode && i.parentNode.classList.add("photo-broken");
      });
    });
  }

  function showPhotoUpload(subjectKey) {
    if (!canEdit()) return;
    var isOrder = subjectKey.indexOf("order:") === 0;
    var subjectId = subjectKey.slice(subjectKey.indexOf(":") + 1);
    openModal(
      modalHead("Add photo", isOrder ? "Style reference, fabric, fitting or the finished piece." : "A picture of this stock item.") +
      '<div class="modal-body"><form id="photoForm" data-subject="' + esc(subjectKey) + '">' +
        '<div class="field"><label for="ph_file">Choose a photo</label>' +
          '<input id="ph_file" type="file" accept="image/*" required></div>' +
        '<img id="ph_preview" class="photo-preview" hidden alt="Selected photo">' +
        (isOrder
          ? '<div class="field" style="margin-top:10px"><label for="ph_kind">What does it show?</label><select id="ph_kind">' +
            PHOTO_KINDS.map(function (k) {
              return '<option value="' + k[0] + '"' + (k[0] === "style" ? " selected" : "") + ">" + k[1] + "</option>";
            }).join("") + "</select></div>"
          : "") +
        '<div class="field" style="margin-top:10px"><label for="ph_caption">Caption (optional)</label>' +
          '<input id="ph_caption" placeholder="e.g. Neckline detail"></div>' +
        '<div class="hint" style="margin-top:8px">Photos are shrunk automatically before upload, so they stay quick on mobile data.</div>' +
        '<div class="modal-actions"><span class="spacer"></span>' +
          '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
          '<button type="submit" class="btn btn-primary">Upload</button>' +
        "</div>" +
      "</form></div>"
    );
  }

  function submitPhoto(form) {
    var subjectKey = form.getAttribute("data-subject");
    var isOrder = subjectKey.indexOf("order:") === 0;
    var subjectId = subjectKey.slice(subjectKey.indexOf(":") + 1);
    var file = $("#ph_file").files[0];
    if (!file) { toast("Choose a photo first", true); return; }

    var kind = $("#ph_kind") ? $("#ph_kind").value : "other";
    var caption = $("#ph_caption").value.trim();
    busy("#photoForm", true);
    toast("Uploading photo…");

    compressImage(file).then(function (blob) {
      var path = (isOrder ? "orders/" : "inventory/") + subjectId + "/" + randId() + ".jpg";
      return sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" })
        .then(function (up) {
          if (up.error) throw up.error;
          var row = { path: path, kind: kind, caption: caption, created_by: myUserId };
          if (isOrder) row.order_id = subjectId; else row.item_id = subjectId;
          return sb.from("photos").insert(row).select("*").single();
        });
    }).then(function (res) {
      if (res.error) throw res.error;
      db.photos.push(rowToPhoto(res.data));
      toast("Photo added ✓");
      if (isOrder) showOrderDetail(subjectId);
      else showItemDetail(subjectId);
    }).catch(function (e) {
      busy("#photoForm", false);
      fail(e, "Could not upload photo");
    });
  }

  function showPhotoLightbox(id) {
    var p = photoById(id);
    if (!p) return;
    var backTo = p.orderId ? "order:" + p.orderId : "item:" + p.itemId;
    openModal(
      modalHead(esc(p.caption || kindLabel(p.kind)), p.orderId ? esc(kindLabel(p.kind)) + " · " + esc(fmtDate(p.createdAt)) : esc(fmtDate(p.createdAt))) +
      '<div class="modal-body">' +
        '<img class="photo-full" alt="' + esc(p.caption || kindLabel(p.kind)) + '" data-photo-path="' + esc(p.path) + '">' +
        '<div class="modal-actions">' +
          (canDeletePhoto(p) ? '<button class="btn btn-danger btn-sm" data-delete-photo="' + p.id + '">Delete</button>' : "") +
          '<span class="spacer"></span>' +
          '<button class="btn btn-ghost" data-back-to="' + backTo + '">Back</button>' +
        "</div>" +
      "</div>"
    );
    hydratePhotos();
  }

  function deletePhoto(id) {
    var p = photoById(id);
    if (!p || !canDeletePhoto(p)) return;
    if (!confirm("Delete this photo? This cannot be undone.")) return;
    var backTo = p.orderId ? "order:" + p.orderId : "item:" + p.itemId;
    sb.from("photos").delete().eq("id", id).then(function (res) {
      if (res.error) return fail(res.error, "Could not delete photo");
      return sb.storage.from("photos").remove([p.path]).then(function () {
        db.photos = db.photos.filter(function (x) { return x.id !== id; });
        delete signedCache[p.path];
        toast("Photo deleted");
        if (p.orderId) showOrderDetail(p.orderId); else showItemDetail(p.itemId);
      });
    });
  }

  // Remove the stored files for a subject before its record is deleted;
  // the photos rows cascade, but storage objects would be orphaned.
  function purgePhotoFiles(list) {
    if (!list.length) return Promise.resolve();
    var paths = list.map(function (p) { return p.path; });
    paths.forEach(function (p) { delete signedCache[p]; });
    return sb.storage.from("photos").remove(paths).catch(function () { /* best effort */ });
  }

  /* ============================================================
     INVOICES (admin only)
     Amounts and client details are snapshot when the invoice is
     created, so an issued document never changes underneath you.
     ============================================================ */

  var INV_STATUS = {
    unpaid: ["Unpaid", "st-cancelled"],
    partly_paid: ["Part paid", "st-adjustments"],
    paid: ["Paid", "st-ready"],
    cancelled: ["Cancelled", "st-delivered"]
  };

  function invoiceById(id) {
    for (var i = 0; i < db.invoices.length; i++) if (db.invoices[i].id === id) return db.invoices[i];
    return null;
  }

  function invStatusPill(inv) {
    var s = INV_STATUS[inv.status] || INV_STATUS.unpaid;
    return '<span class="pill ' + s[1] + '">' + s[0] + "</span>";
  }

  function statusForAmounts(total, paid) {
    if (paid <= 0) return "unpaid";
    if (paid + 0.001 >= total) return "paid";
    return "partly_paid";
  }

  function renderInvoices() {
    var view = $("#view-invoices");
    if (!view) return;
    if (!isAdmin()) { view.innerHTML = ""; return; }

    var list = db.invoices.slice();
    if (ui.invoiceSearch) {
      var q = ui.invoiceSearch.toLowerCase();
      list = list.filter(function (v) {
        return (v.number + " " + v.clientName + " " + v.status).toLowerCase().indexOf(q) !== -1;
      });
    }

    var owed = db.invoices.reduce(function (t, v) {
      return t + (v.status === "cancelled" ? 0 : Math.max(0, v.balance));
    }, 0);

    var html =
      '<div class="view-head"><h2>Invoices</h2>' +
        '<button class="btn btn-primary" data-action="new-invoice">+ New Invoice</button></div>' +
      '<div class="stats-grid" style="margin-bottom:12px">' +
        statCard("Invoices", db.invoices.length, "") +
        statCard("Outstanding", money(owed), "stat-money") +
      "</div>" +
      '<div class="toolbar">' +
        '<input class="search-input" id="invoiceSearch" type="search" placeholder="Search by number or client…" value="' + esc(ui.invoiceSearch) + '">' +
      "</div>";

    if (list.length) {
      html += '<div class="card-list">' + list.map(function (v) {
        return (
          '<div class="item-card" data-open-invoice="' + v.id + '">' +
            '<div class="card-top">' +
              '<div><div class="card-title"><span class="ref">' + esc(v.number) + "</span>" + esc(v.clientName || "(client removed)") + "</div>" +
              '<div class="card-sub">' + esc(fmtDateShort(v.issueDate)) + " · " + v.items.length + " item" + (v.items.length === 1 ? "" : "s") + "</div></div>" +
              '<div class="card-badges">' + invStatusPill(v) + "</div>" +
            "</div>" +
            '<div class="card-foot">' +
              '<span class="balance-chip" style="color:var(--accent-dark)">' + money(v.total) + " total</span>" +
              (v.balance > 0 && v.status !== "cancelled"
                ? '<span class="balance-chip balance-owed">' + money(v.balance) + " due</span>"
                : '<span class="balance-chip balance-paid">Settled ✓</span>') +
            "</div>" +
          "</div>"
        );
      }).join("") + "</div>";
    } else if (!db.invoices.length) {
      html += '<div class="empty"><span class="empty-icon">🧾</span><h3>No invoices yet</h3>' +
        "<p>Create an invoice from an order or a client, then print it or send it on WhatsApp.</p>" +
        '<button class="btn btn-primary" data-action="new-invoice">+ New Invoice</button></div>';
    } else {
      html += '<div class="empty"><span class="empty-icon">🔍</span><h3>No invoices match</h3><p>Try a different search.</p></div>';
    }

    view.innerHTML = html;
  }

  // ---- builder ----------------------------------------------------------

  function lineRow(i, it) {
    return (
      '<tr class="inv-line" data-line="' + i + '">' +
        '<td><input class="inv-desc" value="' + esc(it.description) + '" placeholder="Description"></td>' +
        '<td><input class="inv-qty" type="number" min="0" step="any" inputmode="decimal" value="' + esc(it.qty) + '"></td>' +
        '<td><input class="inv-price" type="number" min="0" step="any" inputmode="decimal" value="' + esc(it.unit_price) + '"></td>' +
        '<td class="inv-line-amt">' + money(Number(it.qty || 0) * Number(it.unit_price || 0)) + "</td>" +
        '<td><button type="button" class="btn btn-ghost btn-sm" data-del-line="' + i + '" title="Remove line">✕</button></td>' +
      "</tr>"
    );
  }

  function showInvoiceBuilder(opts) {
    if (!isAdmin()) return;
    opts = opts || {};
    var client = opts.clientId ? clientById(opts.clientId) : null;
    var order = opts.orderId ? orderById(opts.orderId) : null;
    if (order && !client) client = clientById(order.clientId);

    // Choosing a client first when we have neither
    if (!client) {
      var opts2 = db.clients.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
        .map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + "</option>"; }).join("");
      openModal(
        modalHead("New Invoice", "Who is this invoice for?") +
        '<div class="modal-body">' +
          (db.clients.length
            ? '<div class="field"><label for="inv_client">Client</label><select id="inv_client"><option value="">Choose client</option>' + opts2 + "</select></div>" +
              '<div class="modal-actions"><span class="spacer"></span>' +
              '<button class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
              '<button class="btn btn-primary" data-pick-invoice-client>Continue</button></div>'
            : '<div class="notice">Add a client first, then you can invoice her.</div>' +
              '<div class="modal-actions"><span class="spacer"></span><button class="btn btn-ghost" data-action="close-modal">Close</button></div>') +
        "</div>"
      );
      return;
    }

    // Which orders to bill
    var clientOrders = ordersForClient(client.id).filter(function (o) { return o.status !== "cancelled"; });
    var chosen = order ? [order] : clientOrders.filter(function (o) { return balanceOf(o) > 0; });
    if (!chosen.length) chosen = clientOrders.slice(0, 1);

    var lines = chosen.map(function (o) {
      return { description: (o.garment || "Garment") + (o.fabric ? " — " + o.fabric : "") + " (" + o.ref + ")", qty: 1, unit_price: Number(o.price || 0) };
    });
    if (!lines.length) lines = [{ description: "", qty: 1, unit_price: 0 }];
    var paid = chosen.reduce(function (t, o) { return t + paidTotal(o); }, 0);

    var pickList = order ? "" :
      '<div class="field full"><label>Orders to include</label>' +
      (clientOrders.length
        ? clientOrders.map(function (o) {
            var on = chosen.indexOf(o) !== -1;
            return '<label class="inv-pick"><input type="checkbox" data-inv-order="' + o.id + '"' + (on ? " checked" : "") + ">" +
              "<span>" + esc(o.ref) + " · " + esc(o.garment || "Order") + " — " + money(o.price) +
              (balanceOf(o) > 0 ? ' <span style="color:var(--red)">' + money(balanceOf(o)) + " due</span>" : ' <span style="color:var(--green)">paid</span>') +
              "</span></label>";
          }).join("")
        : '<p style="color:var(--muted);font-size:14px">This client has no orders yet — add lines by hand below.</p>') +
      "</div>";

    var notes = (db.invoiceSettings && db.invoiceSettings.defaultNotes) || "";

    openModal(
      modalHead("New Invoice", "for <strong>" + esc(client.name) + "</strong>") +
      '<div class="modal-body"><form id="invoiceForm" data-client-id="' + client.id + '" data-orders="' + esc(chosen.map(function (o) { return o.id; }).join(",")) + '">' +
        (pickList ? '<div class="form-grid">' + pickList + "</div>" : "") +
        '<h3 class="section-title">Items</h3>' +
        '<div class="inv-lines-wrap"><table class="inv-lines"><thead><tr>' +
          "<th>Description</th><th>Qty</th><th>Price</th><th>Amount</th><th></th>" +
        '</tr></thead><tbody id="invLines">' + lines.map(function (l, i) { return lineRow(i, l); }).join("") + "</tbody></table></div>" +
        '<button type="button" class="btn btn-subtle btn-sm" data-add-line style="margin-top:8px">+ Add line</button>' +
        '<div class="form-grid" style="margin-top:14px">' +
          '<div class="field"><label for="inv_discount">Discount</label><input id="inv_discount" type="number" min="0" step="any" inputmode="decimal" value="0"></div>' +
          '<div class="field"><label for="inv_paid">Already paid</label><input id="inv_paid" type="number" min="0" step="any" inputmode="decimal" value="' + esc(paid) + '"></div>' +
          '<div class="field"><label for="inv_issue">Invoice date</label><input id="inv_issue" type="date" value="' + esc(todayISO()) + '"></div>' +
          '<div class="field full"><label for="inv_notes">Notes / terms</label><textarea id="inv_notes" placeholder="e.g. 50% deposit required. Balance due on collection.">' + esc(notes) + "</textarea></div>" +
        "</div>" +
        '<div class="inv-totals-live" id="invTotals"></div>' +
        '<div class="modal-actions"><span class="spacer"></span>' +
          '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
          '<button type="submit" class="btn btn-primary">Create Invoice</button>' +
        "</div>" +
      "</form></div>"
    );
    recalcInvoice();
  }

  function readLines() {
    return $all("#invLines .inv-line").map(function (tr) {
      return {
        description: $(".inv-desc", tr).value.trim(),
        qty: Number($(".inv-qty", tr).value || 0),
        unit_price: Number($(".inv-price", tr).value || 0)
      };
    });
  }

  function recalcInvoice() {
    if (!$("#invLines")) return;
    var lines = readLines();
    var subtotal = 0;
    $all("#invLines .inv-line").forEach(function (tr, i) {
      var amt = Number(lines[i].qty || 0) * Number(lines[i].unit_price || 0);
      subtotal += amt;
      $(".inv-line-amt", tr).textContent = money(amt);
    });
    var discount = Number($("#inv_discount").value || 0);
    var paid = Number($("#inv_paid").value || 0);
    var total = Math.max(0, subtotal - discount);
    var balance = total - paid;
    $("#invTotals").innerHTML =
      '<div class="inv-total-row"><span>Subtotal</span><span>' + money(subtotal) + "</span></div>" +
      (discount > 0 ? '<div class="inv-total-row"><span>Discount</span><span>−' + money(discount) + "</span></div>" : "") +
      '<div class="inv-total-row inv-total-main"><span>Total</span><span>' + money(total) + "</span></div>" +
      (paid > 0 ? '<div class="inv-total-row"><span>Paid</span><span style="color:var(--green)">' + money(paid) + "</span></div>" : "") +
      '<div class="inv-total-row inv-total-main"><span>Balance due</span><span style="color:' + (balance > 0 ? "var(--red)" : "var(--green)") + '">' + money(balance) + "</span></div>";
  }

  function submitInvoice(form) {
    if (!isAdmin()) return;
    var client = clientById(form.getAttribute("data-client-id"));
    var lines = readLines().filter(function (l) { return l.description || l.unit_price > 0; });
    if (!lines.length) { toast("Add at least one item", true); return; }

    lines = lines.map(function (l) {
      return { description: l.description, qty: l.qty, unit_price: l.unit_price, amount: l.qty * l.unit_price };
    });
    var subtotal = lines.reduce(function (t, l) { return t + l.amount; }, 0);
    var discount = Number($("#inv_discount").value || 0);
    var paid = Number($("#inv_paid").value || 0);
    var total = Math.max(0, subtotal - discount);
    var orderIds = (form.getAttribute("data-orders") || "").split(",").filter(Boolean);

    var row = {
      client_id: client ? client.id : null,
      order_ids: orderIds,
      client_name: client ? client.name : "",
      client_phone: client ? (client.phone || "") : "",
      client_address: client ? (client.address || "") : "",
      issue_date: $("#inv_issue").value || todayISO(),
      due_date: null,
      items: lines,
      subtotal: subtotal, discount: discount, total: total,
      amount_paid: paid, balance: total - paid,
      notes: $("#inv_notes").value.trim(),
      status: statusForAmounts(total, paid)
    };

    busy("#invoiceForm", true);
    sb.from("invoices").insert(row).select("*").single().then(function (res) {
      if (res.error) { busy("#invoiceForm", false); return fail(res.error, "Could not create invoice"); }
      var saved = rowToInvoice(res.data);
      db.invoices.unshift(saved);
      renderAll();
      toast("Invoice " + saved.number + " created ✓");
      showInvoiceDoc(saved.id);
    });
  }

  // ---- the document -----------------------------------------------------

  function showInvoiceDoc(id) {
    var v = invoiceById(id);
    if (!v || !isAdmin()) return;
    var s = db.invoiceSettings || {};
    var wa = phoneDigits(v.clientPhone);

    var payBlock = (s.bankName || s.bankAccountNumber)
      ? '<div class="inv-pay-details"><div class="inv-pay-title">Payment details</div>' +
          (s.bankName ? "<div>" + esc(s.bankName) + "</div>" : "") +
          (s.bankAccountName ? "<div>" + esc(s.bankAccountName) + "</div>" : "") +
          (s.bankAccountNumber ? '<div class="inv-acct">' + esc(s.bankAccountNumber) + "</div>" : "") +
        "</div>"
      : "";

    openModal(
      '<div class="modal-head no-print"><div><h2>' + esc(v.number) + "</h2>" +
        '<div class="modal-sub">' + esc(v.clientName) + " · " + invStatusPill(v) + "</div></div>" +
        '<button class="modal-close" data-action="close-modal" aria-label="Close">✕</button></div>' +
      '<div class="modal-body">' +
        '<div class="invoice-doc">' +
          '<div class="inv-head">' +
            '<div class="inv-brand"><img src="img/logo.svg" alt="" class="inv-logo">' +
              "<div><div class=\"inv-biz\">" + esc(db.settings.businessName) + "</div>" +
              (s.businessAddress ? '<div class="inv-biz-line">' + esc(s.businessAddress) + "</div>" : "") +
              (s.businessPhone ? '<div class="inv-biz-line">' + esc(s.businessPhone) + "</div>" : "") +
              (s.businessEmail ? '<div class="inv-biz-line">' + esc(s.businessEmail) + "</div>" : "") +
              "</div></div>" +
            '<div class="inv-meta"><div class="inv-word">INVOICE</div>' +
              "<div><strong>" + esc(v.number) + "</strong></div>" +
              "<div>Date: " + esc(fmtDateShort(v.issueDate)) + "</div>" +
            "</div>" +
          "</div>" +

          '<div class="inv-party"><div class="inv-party-label">Billed to</div>' +
            '<div class="inv-party-name">' + esc(v.clientName || "-") + "</div>" +
            (v.clientPhone ? "<div>" + esc(v.clientPhone) + "</div>" : "") +
            (v.clientAddress ? "<div>" + esc(v.clientAddress) + "</div>" : "") +
          "</div>" +

          '<table class="inv-items"><thead><tr>' +
            "<th>Description</th><th class=\"num\">Qty</th><th class=\"num\">Price</th><th class=\"num\">Amount</th>" +
          "</tr></thead><tbody>" +
            v.items.map(function (l) {
              return "<tr><td>" + esc(l.description) + '</td><td class="num">' + esc(l.qty) +
                '</td><td class="num">' + money(l.unit_price) + '</td><td class="num">' + money(l.amount) + "</td></tr>";
            }).join("") +
          "</tbody></table>" +

          '<div class="inv-totals">' +
            '<div class="inv-total-row"><span>Subtotal</span><span>' + money(v.subtotal) + "</span></div>" +
            (v.discount > 0 ? '<div class="inv-total-row"><span>Discount</span><span>−' + money(v.discount) + "</span></div>" : "") +
            '<div class="inv-total-row inv-total-main"><span>Total</span><span>' + money(v.total) + "</span></div>" +
            (v.amountPaid > 0 ? '<div class="inv-total-row"><span>Paid</span><span>' + money(v.amountPaid) + "</span></div>" : "") +
            '<div class="inv-total-row inv-total-main"><span>Balance due</span><span>' + money(v.balance) + "</span></div>" +
          "</div>" +

          (v.notes ? '<div class="inv-notes">' + esc(v.notes) + "</div>" : "") +
          payBlock +
          '<div class="inv-thanks">Thank you for your patronage.</div>' +
        "</div>" +

        (payBlock ? "" :
          '<div class="notice no-print" style="margin-top:12px">Your bank account is not set, so clients cannot see where to pay. ' +
          '<button class="btn btn-subtle btn-sm" data-action="invoice-settings" style="margin-top:6px">Set it now</button></div>') +

        '<div class="modal-actions no-print">' +
          '<button class="btn btn-ghost btn-sm" data-download-invoice="' + v.id + '">⬇ Download PDF</button>' +
          '<button class="btn btn-ghost btn-sm" data-print-order>🖨 Print</button>' +
          '<button class="btn btn-ghost btn-sm" data-delete-invoice="' + v.id + '">Delete</button>' +
          (v.status !== "paid"
            ? '<button class="btn btn-ghost btn-sm" data-invoice-paid="' + v.id + '">✓ Mark paid</button>'
            : '<button class="btn btn-ghost btn-sm" data-invoice-unpaid="' + v.id + '">Mark unpaid</button>') +
          (wa ? '<button class="btn btn-primary" data-share-invoice="' + v.id + '">💬 Send PDF on WhatsApp</button>' : "") +
        "</div>" +
      "</div>"
    );
  }

  /* ---- PDF ----------------------------------------------------------
     Drawn with jsPDF rather than screenshotting the page, so the text
     stays crisp and selectable and the file stays small (~10 KB).
     -------------------------------------------------------------------- */

  function invoicePdf(v) {
    var jsPDFctor = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDFctor) return null;
    var s = db.invoiceSettings || {};
    var doc = new jsPDFctor({ unit: "mm", format: "a4" });
    var L = 15, R = 195, y = 18;

    // jsPDF's built-in fonts are WinAnsi-encoded and have no ₦ (or ₵) glyph:
    // printing it raw comes out as "¦". Fall back to the ISO code for those.
    var PDF_CUR = { "₦": "NGN ", "₵": "GHS ", "GH₵": "GHS ", "₹": "INR ", "₱": "PHP " };
    var rawCur = db.settings.currency || "";
    var cur = PDF_CUR[rawCur] !== undefined ? PDF_CUR[rawCur]
            : (/^[\x20-\x7E£€¥]*$/.test(rawCur) ? rawCur : rawCur.replace(/[^\x20-\x7E£€¥]/g, "") + " ");

    function amt(n) {
      return cur + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
    }
    function line() { doc.setDrawColor(232, 221, 210); doc.line(L, y, R, y); }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(17);
    doc.setTextColor(185, 106, 7);
    doc.text(db.settings.businessName || "Bojamiley", L, y);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(138, 125, 114);
    var by = y + 5;
    [s.businessAddress, s.businessPhone, s.businessEmail].forEach(function (t) {
      if (t) { doc.text(String(t), L, by); by += 4; }
    });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.setTextColor(185, 106, 7);
    doc.text("INVOICE", R, y, { align: "right" });
    doc.setFontSize(10);
    doc.setTextColor(43, 35, 32);
    doc.text(v.number, R, y + 6, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(138, 125, 114);
    doc.text(fmtDateShort(v.issueDate), R, y + 11, { align: "right" });

    y = Math.max(by, y + 15) + 3;
    doc.setDrawColor(244, 151, 33);
    doc.setLineWidth(0.6);
    doc.line(L, y, R, y);
    doc.setLineWidth(0.2);
    y += 8;

    doc.setFontSize(8);
    doc.setTextColor(138, 125, 114);
    doc.text("BILLED TO", L, y);
    y += 5;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(43, 35, 32);
    doc.text(v.clientName || "-", L, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(90, 80, 72);
    [v.clientPhone, v.clientAddress].forEach(function (t) {
      if (t) { y += 4.5; doc.text(String(t), L, y); }
    });

    // items table
    y += 9;
    doc.setFontSize(8);
    doc.setTextColor(138, 125, 114);
    doc.text("DESCRIPTION", L, y);
    doc.text("QTY", 130, y, { align: "right" });
    doc.text("PRICE", 158, y, { align: "right" });
    doc.text("AMOUNT", R, y, { align: "right" });
    y += 2.5; line(); y += 5;

    doc.setFontSize(10);
    doc.setTextColor(43, 35, 32);
    (v.items || []).forEach(function (it) {
      var wrapped = doc.splitTextToSize(String(it.description || ""), 108);
      if (y > 250) { doc.addPage(); y = 20; }
      doc.text(wrapped, L, y);
      doc.text(String(it.qty), 130, y, { align: "right" });
      doc.text(amt(it.unit_price), 158, y, { align: "right" });
      doc.text(amt(it.amount), R, y, { align: "right" });
      y += Math.max(wrapped.length * 4.6, 5) + 2.5;
      line(); y += 5;
    });

    // totals
    var tx = 130, ty = y + 2;
    function row(label, value, bold) {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(bold ? 11 : 10);
      doc.text(label, tx, ty);
      doc.text(value, R, ty, { align: "right" });
      ty += bold ? 6.5 : 5.5;
    }
    row("Subtotal", amt(v.subtotal));
    if (v.discount > 0) row("Discount", "-" + amt(v.discount));
    row("Total", amt(v.total), true);
    if (v.amountPaid > 0) row("Paid", amt(v.amountPaid));
    row("Balance due", amt(v.balance), true);
    y = ty + 4;

    if (v.notes) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(138, 125, 114);
      var nl = doc.splitTextToSize(String(v.notes), R - L);
      doc.text(nl, L, y);
      y += nl.length * 4.2 + 4;
    }

    if (s.bankName || s.bankAccountNumber) {
      doc.setFillColor(253, 238, 221);
      var boxH = 10 + (s.bankName ? 5 : 0) + (s.bankAccountName ? 5 : 0) + (s.bankAccountNumber ? 6 : 0);
      doc.roundedRect(L, y, R - L, boxH, 2, 2, "F");
      var byy = y + 6;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(185, 106, 7);
      doc.text("PAYMENT DETAILS", L + 4, byy);
      doc.setTextColor(43, 35, 32);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      if (s.bankName) { byy += 5; doc.text(String(s.bankName), L + 4, byy); }
      if (s.bankAccountName) { byy += 5; doc.text(String(s.bankAccountName), L + 4, byy); }
      if (s.bankAccountNumber) {
        byy += 6;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.text(String(s.bankAccountNumber), L + 4, byy);
      }
      y += boxH + 6;
    }

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(138, 125, 114);
    doc.text("Thank you for your patronage.", 105, Math.min(y + 2, 285), { align: "center" });

    return doc;
  }

  function invoiceFileName(v) {
    return (v.number + "-" + (v.clientName || "invoice")).replace(/[^\w\-]+/g, "-") + ".pdf";
  }

  // WhatsApp's link API cannot carry a file, so we hand the real PDF to the
  // phone's native share sheet (which lists WhatsApp). Desktop and older
  // browsers fall back to downloading the PDF plus a prefilled chat.
  function shareInvoice(id) {
    var v = invoiceById(id);
    if (!v) return;
    var doc = invoicePdf(v);
    if (!doc) { toast("PDF engine did not load", true); return; }

    var blob = doc.output("blob");
    var file = null;
    try {
      file = new File([blob], invoiceFileName(v), { type: "application/pdf" });
    } catch (e) { /* File constructor unavailable */ }

    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      navigator.share({
        files: [file],
        title: v.number,
        text: invoiceMessage(v)
      }).catch(function () { /* user dismissed the sheet */ });
      return;
    }

    // fallback: save the file, then open WhatsApp so it can be attached
    downloadInvoice(id);
    var wa = phoneDigits(v.clientPhone);
    toast("PDF saved. Attach it in WhatsApp.");
    if (wa) {
      window.open("https://wa.me/" + wa + "?text=" + encodeURIComponent(invoiceMessage(v)), "_blank", "noopener");
    }
  }

  function downloadInvoice(id) {
    var v = invoiceById(id);
    if (!v) return;
    var doc = invoicePdf(v);
    if (!doc) { toast("PDF engine did not load", true); return; }
    doc.save(invoiceFileName(v));
  }

  function invoiceMessage(v) {
    var s = db.invoiceSettings || {};
    var lines = [
      "Hello " + String(v.clientName || "").split(" ")[0] + ", here is your invoice from " + db.settings.businessName + ".",
      "",
      "Invoice: " + v.number,
      "Total: " + money(v.total)
    ];
    if (v.amountPaid > 0) lines.push("Paid: " + money(v.amountPaid));
    lines.push("Balance due: " + money(v.balance));
    if (s.bankName || s.bankAccountNumber) {
      lines.push("", "Payment details:");
      if (s.bankName) lines.push(s.bankName);
      if (s.bankAccountName) lines.push(s.bankAccountName);
      if (s.bankAccountNumber) lines.push(s.bankAccountNumber);
    }
    lines.push("", "Thank you!");
    return lines.join("\n");
  }

  function setInvoicePaid(id, paidInFull) {
    var v = invoiceById(id);
    if (!v || !isAdmin()) return;
    var paid = paidInFull ? v.total : 0;
    sb.from("invoices").update({
      amount_paid: paid, balance: v.total - paid,
      status: statusForAmounts(v.total, paid)
    }).eq("id", id).select("*").single().then(function (res) {
      if (res.error) return fail(res.error, "Could not update invoice");
      var saved = rowToInvoice(res.data);
      db.invoices = db.invoices.map(function (x) { return x.id === saved.id ? saved : x; });
      renderAll();
      toast(paidInFull ? "Marked paid ✓" : "Marked unpaid");
      showInvoiceDoc(id);
    });
  }

  function deleteInvoice(id) {
    var v = invoiceById(id);
    if (!v || !isAdmin()) return;
    if (!confirm("Delete invoice " + v.number + "? This cannot be undone.")) return;
    sb.from("invoices").delete().eq("id", id).then(function (res) {
      if (res.error) return fail(res.error, "Could not delete invoice");
      db.invoices = db.invoices.filter(function (x) { return x.id !== id; });
      renderAll();
      closeModal();
      toast("Invoice deleted");
    });
  }

  function showInvoiceSettings() {
    if (!isAdmin()) return;
    var s = db.invoiceSettings || {};
    openModal(
      modalHead("Invoice details", "Printed on every invoice you give a client.") +
      '<div class="modal-body"><form id="invSettingsForm">' +
        '<div class="form-grid">' +
          '<div class="field full"><label for="is_address">Business address</label><input id="is_address" value="' + esc(s.businessAddress || "") + '"></div>' +
          '<div class="field"><label for="is_phone">Business phone</label><input id="is_phone" value="' + esc(s.businessPhone || "") + '"></div>' +
          '<div class="field"><label for="is_email">Business email</label><input id="is_email" value="' + esc(s.businessEmail || "") + '"></div>' +
          '<div class="field"><label for="is_bank">Bank name</label><input id="is_bank" value="' + esc(s.bankName || "") + '" placeholder="e.g. GTBank"></div>' +
          '<div class="field"><label for="is_acctname">Account name</label><input id="is_acctname" value="' + esc(s.bankAccountName || "") + '"></div>' +
          '<div class="field full"><label for="is_acctno">Account number</label><input id="is_acctno" value="' + esc(s.bankAccountNumber || "") + '" inputmode="numeric"></div>' +
          '<div class="field full"><label for="is_notes">Default notes / terms</label><textarea id="is_notes" placeholder="e.g. 50% deposit required. Balance due on collection.">' + esc(s.defaultNotes || "") + "</textarea></div>" +
        "</div>" +
        '<div class="modal-actions"><span class="spacer"></span>' +
          '<button type="button" class="btn btn-ghost" data-action="open-settings">Back</button>' +
          '<button type="submit" class="btn btn-primary">Save</button></div>' +
      "</form></div>"
    );
  }

  function saveInvoiceSettings() {
    var row = {
      business_address: $("#is_address").value.trim(),
      business_phone: $("#is_phone").value.trim(),
      business_email: $("#is_email").value.trim(),
      bank_name: $("#is_bank").value.trim(),
      bank_account_name: $("#is_acctname").value.trim(),
      bank_account_number: $("#is_acctno").value.trim(),
      default_notes: $("#is_notes").value.trim(),
      updated_at: new Date().toISOString()
    };
    sb.from("invoice_settings").update(row).eq("id", 1).select("*").single().then(function (res) {
      if (res.error) return fail(res.error, "Could not save invoice details");
      db.invoiceSettings = rowToInvSettings(res.data);
      toast("Invoice details saved ✓");
      closeModal();
    });
  }

  /* ---------- Analytics (admin only) ---------- */

  function mkOf(s) { return s ? String(s).slice(0, 7) : ""; }

  function mkShift(mk, delta) {
    var p = mk.split("-");
    var d = new Date(+p[0], +p[1] - 1 + delta, 1);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1);
  }

  function mkLabel(mk, short) {
    var p = mk.split("-");
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString(undefined,
      short ? { month: "short" } : { month: "long", year: "numeric" });
  }

  function monthStats(mk) {
    var received = 0;
    db.orders.forEach(function (o) {
      (o.payments || []).forEach(function (p) {
        if (mkOf(p.date) === mk) received += Number(p.amount || 0);
      });
    });
    var taken = db.orders.filter(function (o) { return mkOf(o.orderDate) === mk && o.status !== "cancelled"; });
    var cancelled = db.orders.filter(function (o) { return mkOf(o.orderDate) === mk && o.status === "cancelled"; });
    var delivered = db.orders.filter(function (o) { return mkOf(o.deliveredAt) === mk; });
    var withDue = delivered.filter(function (o) { return o.dueDate; });
    var onTime = withDue.filter(function (o) { return o.deliveredAt <= o.dueDate; });
    var booked = taken.reduce(function (s, o) { return s + Number(o.price || 0); }, 0);
    return {
      received: received,
      taken: taken.length,
      cancelled: cancelled.length,
      delivered: delivered.length,
      withDue: withDue.length,
      onTime: onTime.length,
      booked: booked,
      avg: taken.length ? booked / taken.length : 0,
      newClients: db.clients.filter(function (c) { return mkOf(c.createdAt) === mk; }).length
    };
  }

  function miniChart(months, values, fmt) {
    var max = Math.max.apply(null, values.concat([1]));
    var maxIdx = values.indexOf(Math.max.apply(null, values));
    return '<div class="mini-chart">' + months.map(function (mk, i) {
      var h = Math.round((values[i] / max) * 100);
      var showVal = values[i] > 0 && (i === maxIdx || i === months.length - 1);
      return (
        '<div class="mini-col" title="' + mkLabel(mk) + ": " + esc(fmt(values[i])) + '">' +
          // the label row is always present so every bar competes for the
          // same vertical space and heights stay comparable
          '<div class="mini-val">' + (showVal ? esc(fmt(values[i])) : "&nbsp;") + "</div>" +
          '<div class="mini-bar' + (mk === ui.anMonth ? " selected" : "") + '" style="height:' + h + '%"></div>' +
          '<div class="mini-x">' + mkLabel(mk, true) + "</div>" +
        "</div>"
      );
    }).join("") + "</div>";
  }

  function renderAnalytics() {
    var view = $("#view-analytics");
    if (!isAdmin()) { view.innerHTML = ""; return; }

    var nowMk = todayISO().slice(0, 7);
    if (!ui.anMonth) ui.anMonth = nowMk;
    var mk = ui.anMonth;
    var s = monthStats(mk);

    // six months ending at the selected month
    var months = [];
    for (var i = 5; i >= 0; i--) months.push(mkShift(mk, -i));
    var trendMoney = months.map(function (m) { return monthStats(m).received; });
    var trendOrders = months.map(function (m) { return monthStats(m).taken; });

    // who owes money (all time, open + delivered orders)
    var owedBy = {};
    db.orders.forEach(function (o) {
      if (o.status === "cancelled") return;
      var bal = balanceOf(o);
      if (bal > 0) {
        if (!owedBy[o.clientId]) owedBy[o.clientId] = { owed: 0, n: 0 };
        owedBy[o.clientId].owed += bal;
        owedBy[o.clientId].n++;
      }
    });
    var debtors = Object.keys(owedBy).map(function (cid) {
      return { name: clientName(cid), owed: owedBy[cid].owed, n: owedBy[cid].n };
    }).sort(function (a, b) { return b.owed - a.owed; });
    var totalOwed = debtors.reduce(function (t, d) { return t + d.owed; }, 0);

    // top clients by money actually received (all time)
    var paidBy = {};
    db.orders.forEach(function (o) {
      var paid = paidTotal(o);
      if (paid > 0) {
        if (!paidBy[o.clientId]) paidBy[o.clientId] = { paid: 0, n: 0 };
        paidBy[o.clientId].paid += paid;
        paidBy[o.clientId].n++;
      }
    });
    var topClients = Object.keys(paidBy).map(function (cid) {
      return { name: clientName(cid), paid: paidBy[cid].paid, n: paidBy[cid].n };
    }).sort(function (a, b) { return b.paid - a.paid; }).slice(0, 5);

    // most requested garments (all time, not cancelled)
    var garmentCount = {};
    db.orders.forEach(function (o) {
      if (o.status === "cancelled" || !o.garment) return;
      var g = o.garment.trim();
      garmentCount[g] = (garmentCount[g] || 0) + 1;
    });
    var garments = Object.keys(garmentCount).map(function (g) {
      return { g: g, n: garmentCount[g] };
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, 6);
    var gMax = garments.length ? garments[0].n : 1;

    var onTimeTxt = s.withDue ? Math.round((s.onTime / s.withDue) * 100) + "%" : "-";

    view.innerHTML =
      '<div class="view-head"><h2>Analytics</h2>' +
        '<div class="month-nav">' +
          '<button data-an-shift="-1" aria-label="Previous month">◀</button>' +
          '<span class="month-label">' + mkLabel(mk) + "</span>" +
          '<button data-an-shift="1" aria-label="Next month"' + (mk === nowMk ? " disabled" : "") + ">▶</button>" +
        "</div></div>" +

      '<div class="stats-grid">' +
        statCard("Orders received", s.taken, "") +
        statCard("Money received", money(s.received), "stat-money") +
        statCard("New clients", s.newClients, "") +
        statCard("Booked value", money(s.booked), "stat-money") +
        statCard("Avg order value", money(Math.round(s.avg)), "") +
        statCard("Delivered on time", onTimeTxt + (s.withDue ? " <span style=\"font-size:13px;color:var(--muted)\">(" + s.onTime + "/" + s.withDue + ")</span>" : ""), s.withDue && s.onTime < s.withDue ? "stat-warn" : "") +
      "</div>" +
      (s.cancelled ? '<p style="margin-top:8px;font-size:13.5px;color:var(--muted)">' + s.cancelled + " order" + (s.cancelled === 1 ? "" : "s") + " cancelled this month.</p>" : "") +

      '<div class="an-cards">' +
        '<div class="chart-card"><h4>Money received, last 6 months</h4>' +
          '<div class="chart-sub">Payments recorded in each month</div>' +
          miniChart(months, trendMoney, function (v) { return money(v); }) +
        "</div>" +
        '<div class="chart-card"><h4>Orders received, last 6 months</h4>' +
          '<div class="chart-sub">New orders taken in each month</div>' +
          miniChart(months, trendOrders, function (v) { return String(v); }) +
        "</div>" +
      "</div>" +

      '<div class="an-cards">' +
        '<div class="chart-card"><h4>Who owes money</h4>' +
          '<div class="chart-sub">Total outstanding: <strong style="color:' + (totalOwed > 0 ? "var(--red)" : "var(--green)") + '">' + money(totalOwed) + "</strong></div>" +
          (debtors.length
            ? debtors.slice(0, 8).map(function (d) {
                return '<div class="list-row"><span class="lr-name">' + esc(d.name) +
                  ' <span class="lr-sub">' + d.n + " order" + (d.n === 1 ? "" : "s") + '</span></span>' +
                  '<span class="lr-value owed">' + money(d.owed) + "</span></div>";
              }).join("")
            : '<p style="color:var(--muted);font-size:14px;margin-top:8px">Nobody owes you anything right now. 🎉</p>') +
        "</div>" +
        '<div class="chart-card"><h4>Top clients by money received</h4>' +
          '<div class="chart-sub">All time. Your best clients deserve your best service.</div>' +
          (topClients.length
            ? topClients.map(function (t) {
                return '<div class="list-row"><span class="lr-name">' + esc(t.name) +
                  ' <span class="lr-sub">' + t.n + " order" + (t.n === 1 ? "" : "s") + '</span></span>' +
                  '<span class="lr-value">' + money(t.paid) + "</span></div>";
              }).join("")
            : '<p style="color:var(--muted);font-size:14px;margin-top:8px">No payments recorded yet.</p>') +
        "</div>" +
      "</div>" +

      '<div class="an-cards">' +
        '<div class="chart-card"><h4>Most requested garments</h4>' +
          '<div class="chart-sub">All time. What to showcase and stock fabric for.</div>' +
          (garments.length
            ? garments.map(function (g) {
                return '<div class="hbar-row" title="' + esc(g.g) + ": " + g.n + ' orders">' +
                  '<span class="hbar-label">' + esc(g.g) + "</span>" +
                  '<span class="hbar-track"><span class="hbar-fill" style="width:' + Math.round((g.n / gMax) * 100) + '%"></span></span>' +
                  '<span class="hbar-count">' + g.n + "</span></div>";
              }).join("")
            : '<p style="color:var(--muted);font-size:14px;margin-top:8px">No orders yet.</p>') +
        "</div>" +
      "</div>" +

      // Inventory money view for the admin: capital tied up in stock + reorder list
      (function () {
        if (!db.inventory.length) return "";
        var invValue = db.inventory.reduce(function (t, it) {
          return t + (it.unitCost != null ? it.quantity * it.unitCost : 0);
        }, 0);
        var lowItems = db.inventory.filter(isLowStock);
        return '<h3 class="section-title">🧵 Inventory</h3>' +
          '<div class="stats-grid">' +
            statCard("Stock value", money(invValue), "stat-money") +
            statCard("Items tracked", db.inventory.length, "") +
            statCard("Low on stock", lowItems.length, lowItems.length ? "stat-alert" : "") +
          "</div>" +
          '<div class="an-cards"><div class="chart-card"><h4>Reorder soon</h4>' +
            '<div class="chart-sub">Items at or below their reorder level.</div>' +
            (lowItems.length
              ? lowItems.sort(function (a, b) { return a.quantity - b.quantity; }).slice(0, 8).map(function (it) {
                  return '<div class="list-row"><span class="lr-name">' + esc(it.name) +
                    ' <span class="lr-sub">' + esc(it.category) + "</span></span>" +
                    '<span class="lr-value owed">' + fmtQty(it.quantity) + " " + esc(it.unit) + "</span></div>";
                }).join("")
              : '<p style="color:var(--muted);font-size:14px;margin-top:8px">Everything is well stocked. 🎉</p>') +
          "</div></div>";
      })();
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
        '<h3 class="section-title" style="margin-top:18px">Size &amp; Measurements</h3>' +
        '<div class="field" style="max-width:220px"><label for="c_size">Standard size (from size chart)</label>' +
          '<select id="c_size"><option value="">— Not set —</option>' +
          SIZES.map(function (s) {
            return '<option value="' + s + '"' + (m.size === s ? " selected" : "") + ">Size " + s + "</option>";
          }).join("") + "</select>" +
          '<div class="hint">Pick a size if she already knows it. You can still fill in detailed measurements below, or leave them blank.</div>' +
        "</div>" +
        '<div class="measure-grid" style="margin-top:12px">' + measureInputs + "</div>" +
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
    var sz = $("#c_size").value;
    if (sz) c.measurements.size = sz;

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
        '<h3 class="section-title">📏 Size &amp; Measurements</h3>' +
        (m.size ? '<div class="size-badge">Size <strong>' + esc(m.size) + "</strong></div>" : "") +
        (tiles ? '<div class="measure-view">' + tiles + "</div>" : "") +
        (!tiles && !m.size ? '<p style="color:var(--muted)">No size or measurements saved yet.' + (canEdit() ? " Tap Edit to add them." : "") + "</p>" : "") +
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
          (isAdmin() ? '<button class="btn btn-danger btn-sm" data-delete-client="' + c.id + '">Delete</button>' : "") +
          (isAdmin() ? '<button class="btn btn-ghost btn-sm" data-invoice-client="' + c.id + '">🧾 Invoice</button>' : "") +
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

        photoStrip({ orderId: o.id }) +

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
          (isAdmin() ? '<button class="btn btn-ghost btn-sm" data-invoice-order="' + o.id + '">🧾 Invoice</button>' : "") +
          (isOpen(o) && canEdit() ? '<button class="btn btn-ghost btn-sm" data-set-status="cancelled" data-order="' + o.id + '">Cancel order</button>' : "") +
          '<span class="spacer"></span>' +
          (canEdit() ? '<button class="btn btn-ghost" data-edit-order="' + o.id + '">✎ Edit</button>' : "") +
          (o.status === "ready" && canEdit() ? '<button class="btn btn-primary" data-set-status="delivered" data-order="' + o.id + '">✓ Mark Delivered</button>' : "") +
        "</div>" +
      "</div>"
    );
    hydratePhotos();
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
    if (!tiles && !m.size) return "";
    return '<h3 class="section-title">📏 ' + esc(c.name.split(" ")[0]) + "'s size &amp; measurements</h3>" +
      (m.size ? '<div class="size-badge">Size <strong>' + esc(m.size) + "</strong></div>" : "") +
      (tiles ? '<div class="measure-view">' + tiles + "</div>" : "") +
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
    var pics = photosForOrder(id);
    purgePhotoFiles(pics).then(function () {
      return sb.from("orders").delete().eq("id", id);
    }).then(function (res) {
      if (res.error) return fail(res.error, "Could not delete");
      db.orders = db.orders.filter(function (x) { return x.id !== id; });
      db.photos = db.photos.filter(function (p) { return p.orderId !== id; });
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
      var removeBtn = isAdmin() && !isSelf
        ? '<button class="btn btn-ghost btn-sm" data-delete-user="' + p.id + '" title="Delete this account">✕</button>'
        : "";
      return (
        '<div class="team-row">' +
          "<div><div class=\"t-name\">" + esc(p.fullName || "(no name)") + (isSelf ? " (you)" : "") + '</div>' +
          '<div class="t-email">' + esc(p.email) + "</div></div>" +
          '<div style="display:flex;align-items:center;gap:6px">' + select + removeBtn + "</div>" +
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
            '<button type="submit" class="btn btn-primary btn-sm">Save Settings</button></div></form>' +
            '<button class="btn btn-subtle btn-sm" data-action="invoice-settings">🧾 Invoice details &amp; bank account</button>'
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

  function deleteUser(userId) {
    if (!isAdmin()) return;
    var p = null;
    db.profiles.forEach(function (x) { if (x.id === userId) p = x; });
    if (!p) return;
    if (!confirm("Delete " + (p.fullName || p.email) + "'s account? They will no longer be able to sign in. Clients and orders they created stay in the system.")) return;
    sb.rpc("admin_delete_user", { target: userId }).then(function (res) {
      if (res.error) return fail(res.error, "Could not delete user");
      db.profiles = db.profiles.filter(function (x) { return x.id !== userId; });
      toast("Account deleted");
      showSettings();
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

    var el = t.closest("[data-tab],[data-action],[data-order-filter],[data-open-order],[data-open-client],[data-advance-order],[data-edit-client],[data-delete-client],[data-new-order-for],[data-edit-order],[data-delete-order],[data-set-status],[data-del-payment],[data-print-order],[data-modal-overlay],[data-an-shift],[data-delete-user],[data-inv-cat],[data-open-item],[data-edit-item],[data-delete-item],[data-stock-in],[data-stock-out],[data-add-photo],[data-open-photo],[data-delete-photo],[data-back-to],[data-open-invoice],[data-invoice-order],[data-invoice-client],[data-pick-invoice-client],[data-add-line],[data-del-line],[data-delete-invoice],[data-invoice-paid],[data-invoice-unpaid],[data-share-invoice],[data-download-invoice]");
    if (!el) return;

    if (el.hasAttribute("data-open-invoice")) { showInvoiceDoc(el.getAttribute("data-open-invoice")); return; }
    if (el.hasAttribute("data-invoice-order")) { showInvoiceBuilder({ orderId: el.getAttribute("data-invoice-order") }); return; }
    if (el.hasAttribute("data-invoice-client")) { showInvoiceBuilder({ clientId: el.getAttribute("data-invoice-client") }); return; }
    if (el.hasAttribute("data-pick-invoice-client")) {
      var pc = $("#inv_client").value;
      if (pc) showInvoiceBuilder({ clientId: pc }); else toast("Choose a client first", true);
      return;
    }
    if (el.hasAttribute("data-add-line")) {
      var tb = $("#invLines");
      var n = $all("#invLines .inv-line").length;
      tb.insertAdjacentHTML("beforeend", lineRow(n, { description: "", qty: 1, unit_price: 0 }));
      recalcInvoice();
      return;
    }
    if (el.hasAttribute("data-del-line")) {
      var rows = $all("#invLines .inv-line");
      if (rows.length > 1) el.closest(".inv-line").remove();
      else toast("An invoice needs at least one line", true);
      recalcInvoice();
      return;
    }
    if (el.hasAttribute("data-share-invoice")) { shareInvoice(el.getAttribute("data-share-invoice")); return; }
    if (el.hasAttribute("data-download-invoice")) { downloadInvoice(el.getAttribute("data-download-invoice")); return; }
    if (el.hasAttribute("data-delete-invoice")) { deleteInvoice(el.getAttribute("data-delete-invoice")); return; }
    if (el.hasAttribute("data-invoice-paid")) { setInvoicePaid(el.getAttribute("data-invoice-paid"), true); return; }
    if (el.hasAttribute("data-invoice-unpaid")) { setInvoicePaid(el.getAttribute("data-invoice-unpaid"), false); return; }

    if (el.hasAttribute("data-add-photo")) { showPhotoUpload(el.getAttribute("data-add-photo")); return; }
    if (el.hasAttribute("data-open-photo")) { showPhotoLightbox(el.getAttribute("data-open-photo")); return; }
    if (el.hasAttribute("data-delete-photo")) { deletePhoto(el.getAttribute("data-delete-photo")); return; }
    if (el.hasAttribute("data-back-to")) {
      var bk = el.getAttribute("data-back-to");
      var bid = bk.slice(bk.indexOf(":") + 1);
      if (bk.indexOf("order:") === 0) showOrderDetail(bid); else showItemDetail(bid);
      return;
    }

    if (el.hasAttribute("data-delete-user")) {
      deleteUser(el.getAttribute("data-delete-user"));
      return;
    }

    if (el.hasAttribute("data-inv-cat")) { ui.invCat = el.getAttribute("data-inv-cat"); renderInventory(); return; }
    if (el.hasAttribute("data-open-item")) { showItemDetail(el.getAttribute("data-open-item")); return; }
    if (el.hasAttribute("data-edit-item")) { showItemForm(el.getAttribute("data-edit-item")); return; }
    if (el.hasAttribute("data-delete-item")) { deleteItem(el.getAttribute("data-delete-item")); return; }
    if (el.hasAttribute("data-stock-in")) { stockDialog(el.getAttribute("data-stock-in"), "in"); return; }
    if (el.hasAttribute("data-stock-out")) { stockDialog(el.getAttribute("data-stock-out"), "out"); return; }

    if (el.hasAttribute("data-an-shift")) {
      var nowMk = todayISO().slice(0, 7);
      var next = mkShift(ui.anMonth || nowMk, Number(el.getAttribute("data-an-shift")));
      if (next > nowMk) next = nowMk;
      ui.anMonth = next;
      renderAnalytics();
      return;
    }

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
      case "new-item": showItemForm(null); break;
      case "new-invoice": showInvoiceBuilder({}); break;
      case "invoice-settings": showInvoiceSettings(); break;
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

    // ticking an order in the invoice builder rebuilds the line items
    if (e.target.hasAttribute && e.target.hasAttribute("data-inv-order")) {
      var form = $("#invoiceForm");
      if (form) {
        var ids = $all("[data-inv-order]").filter(function (cb) { return cb.checked; })
          .map(function (cb) { return cb.getAttribute("data-inv-order"); });
        form.setAttribute("data-orders", ids.join(","));
        var lines = ids.map(function (oid) {
          var o = orderById(oid);
          return o
            ? { description: (o.garment || "Garment") + (o.fabric ? " — " + o.fabric : "") + " (" + o.ref + ")", qty: 1, unit_price: Number(o.price || 0) }
            : null;
        }).filter(Boolean);
        if (!lines.length) lines = [{ description: "", qty: 1, unit_price: 0 }];
        $("#invLines").innerHTML = lines.map(function (l, i) { return lineRow(i, l); }).join("");
        $("#inv_paid").value = ids.reduce(function (t, oid) {
          var o = orderById(oid);
          return t + (o ? paidTotal(o) : 0);
        }, 0);
        recalcInvoice();
      }
      return;
    }

    if (e.target.id === "ph_file") {
      var f = e.target.files[0];
      var prev = $("#ph_preview");
      if (f && prev) {
        var r = new FileReader();
        r.onload = function () { prev.src = r.result; prev.hidden = false; };
        r.readAsDataURL(f);
      } else if (prev) {
        prev.hidden = true;
      }
    }
  });

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (form.id === "clientForm") { e.preventDefault(); submitClientForm(form); }
    else if (form.id === "orderForm") { e.preventDefault(); submitOrderForm(form); }
    else if (form.id === "itemForm") { e.preventDefault(); submitItemForm(form); }
    else if (form.id === "stockForm") { e.preventDefault(); submitStock(form); }
    else if (form.id === "photoForm") { e.preventDefault(); submitPhoto(form); }
    else if (form.id === "invoiceForm") { e.preventDefault(); submitInvoice(form); }
    else if (form.id === "invSettingsForm") { e.preventDefault(); saveInvoiceSettings(); }
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
    else if (e.target.id === "invSearch") { ui.invSearch = e.target.value; renderInvPreservingFocus(); }
    else if (e.target.id === "invoiceSearch") { ui.invoiceSearch = e.target.value; renderInvoicesPreservingFocus(); }
    else if (e.target.closest && e.target.closest("#invoiceForm")) recalcInvoice();
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

  function renderInvPreservingFocus() {
    var pos = $("#invSearch").selectionStart;
    renderInventory();
    var inp = $("#invSearch");
    inp.focus();
    inp.setSelectionRange(pos, pos);
  }

  function renderInvoicesPreservingFocus() {
    var pos = $("#invoiceSearch").selectionStart;
    renderInvoices();
    var inp = $("#invoiceSearch");
    inp.focus();
    inp.setSelectionRange(pos, pos);
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });
})();
