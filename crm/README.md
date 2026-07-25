# Bojamiley CRM

A team CRM for Bojamiley, a custom fashion / tailoring business. It keeps
clients, measurements, orders and payments in one place so nothing gets
mixed up and nothing is delivered late.

The app is a static web page (no server of its own), backed by a Supabase
cloud database. All data is stored centrally, shared by the whole team, and
protected by sign-in with per-role permissions enforced by the database.

## Accounts and roles

Everyone signs in with email and password. There are three access tiers:

| Role | What they can do |
|------|------------------|
| **Admin** | Everything: edit, delete, settings, changing team roles, and client contact details |
| **Staff** | Add and edit clients and orders. Cannot delete anything, change settings, or change roles |
| **Viewer** | See the work. Change nothing |

**Client contact details (phone, email, address) are visible to the Admin
only.** Staff and viewers see client names, measurements and style notes,
which they need for the work, but the database refuses to give them contact
columns, so client contacts cannot be copied out even with technical tricks.
Staff can still type in contact details when first registering a new client;
they just cannot read them back afterwards.

**All money is visible to the Admin only.** Prices, payments and balances
never reach staff or viewer accounts: the database refuses to serve the
money columns, the dashboard money card and all balance chips are hidden,
and a database trigger ignores any price or payment a non-admin tries to
write, so balances cannot be tampered with either. Setting prices and
recording payments are Admin tasks.

- The **first account ever created becomes the Admin** automatically.
- **Everyone who signs up after that is locked out until an Admin approves them.**
  A new sign-up lands in a *pending* state: they can sign in, but the database
  returns them no clients, orders, photos, inventory, settings or invoices at
  all, and the app shows a "waiting for approval" screen. The Admin sees a red
  count on the Menu button and approves (as Staff, Viewer or Admin) or rejects
  them in Menu → Team. This stops anyone who finds the web address from
  registering and reading your client list.
- These rules are enforced by row-level security in the database, not just
  by hiding buttons, so they hold even outside the app.

## How to open it

**Option A (from a computer/phone):** open `crm/index.html` in any browser.
Internet is required since data lives in the cloud.

**Option B (recommended): host it free with GitHub Pages.**

1. On GitHub go to the repository, then **Settings, Pages**.
2. Under *Source* choose **Deploy from a branch**, pick `main` and `/ (root)`, save.
3. After a minute the CRM is live at `https://<username>.github.io/<repo>/crm/`.
4. Open that link on a phone, then browser menu, **Add to Home Screen**. It now
   opens like an app.

## What it does

- **Clients:** name, phone (with one-tap Call / WhatsApp), address, style
  notes, a standard size from the size chart (6–20), and a full measurement
  profile (bust, waist, hips, shoulder, sleeve, gown length, and 12 more).
  Use the size on its own when she already knows it, the detailed
  measurements, or both. Enter once, reuse on every order.
- **Orders:** garment type, fabric (and who provided it), style description,
  price, order and due dates, urgent flag, and an order number (ORD-001...)
  assigned by the database so numbers never clash.
- **Progress pipeline:** New, Cutting, Sewing, Fitting, Adjustments,
  Ready for Pickup, Delivered. One tap moves an order to the next stage.
- **Payments:** record the deposit and every payment; the balance owed is
  always visible on the order and on the client.
- **Dashboard:** overdue orders and anything due in the next 7 days rise to
  the top, plus totals for active orders and outstanding balances.
- **Inventory:** track fabrics, lace, linings, trims, thread, beads, zippers,
  accessories and finished pieces. Each item has a category, colour, unit
  (yards/meters/pieces/rolls/spools/…), quantity on hand, a reorder level that
  triggers a **low-stock alert**, supplier, and unit cost. Stock changes go
  through **Stock in / Stock out** with a reason, and every change is kept in a
  **movement history** so you can see what came in, what was used, and when.
  Quantities are visible to everyone (staff need them to work); **cost and
  stock value are Admin-only**, enforced by the database exactly like order
  prices. Staff can add/edit items and adjust stock; only the Admin deletes.
- **Photos:** attach pictures to an order (style reference, fabric, fitting,
  finished piece — each tagged) and to inventory items. The tailor can see
  exactly what to make instead of working from memory, and finished shots build
  up a portfolio you can reuse on Instagram. Photos are shrunk automatically
  before upload so they stay quick on mobile data, are stored in a **private**
  bucket (served only through short-lived signed links), and print on the job
  card. Visible to the whole team — staff need the reference to sew. Staff can
  add photos and remove their own; the Admin can remove any.
- **Invoices (Admin only):** build an invoice straight from an order, or from a
  client by ticking which of her orders to combine onto one bill. Lines are
  editable, with optional discount, deposit already paid, due date and terms.
  Each invoice gets a number (INV-001...) from the database and **snapshots** the
  amounts and client details, so an invoice already given to a client never
  changes if the order is edited later. **Download a real PDF**, print it, or
  **send the PDF on WhatsApp**: on a phone this opens the native share sheet with
  the file attached; on desktop the PDF downloads and WhatsApp opens with the
  message ready, since WhatsApp links cannot carry a file on their own.
  Your business address and bank account are set once in
  Menu → 🧾 Invoice details and print on every invoice; they live in an Admin-only
  table, so staff never see them. Amounts print as `NGN 35,000` in the PDF because
  the PDF fonts have no ₦ glyph.
- **Team:** the Admin manages who has what access from the Menu.
- **Dark mode:** Menu → 🌒 Appearance, with Light, Dark and System. System follows
  the phone's or computer's own setting and switches over live when it changes
  (for example at sunset on a phone set to automatic). The choice is saved on that
  device, not to the account, so each person on the team picks their own without
  affecting anyone else. Invoices and job cards stay on white paper in both
  themes, on screen and when printed.
- **Analytics (Admin only):** a per-month view of orders received, money
  received, new clients, booked value, average order value and on-time
  delivery rate; 6-month trends for money and orders; who owes money and
  how much; top clients by money received; most requested garments; plus
  inventory stock value and a "reorder soon" list. Since non-admins never
  receive money data from the database, there is nothing for them to see
  here even in theory, so the tab is theirs alone.
- **Job card printing:** open an order, *Print job card*, and pin the slip
  to the garment.
- **Search and filters:** find any order or client by name, fabric, garment or
  order number.

## Data safety

- Data is stored in a Supabase Postgres database (project `bojamiley-crm`),
  not on any single phone. Losing or switching a device loses nothing.
- The app refreshes automatically when you return to its tab, so phones
  stay in sync.
- Admins can also download a JSON copy of everything anytime (Menu →
  Download data copy).

## Administration notes

The Supabase dashboard for the project is at supabase.com (sign in with the
account that owns the `bojamiley-crm` project). Two settings worth knowing:

- **Email confirmation:** by default, new sign-ups must click a confirmation
  link. Supabase's built-in email service only sends a couple of emails per
  hour. For a small team the simplest fix is Authentication → Sign In /
  Providers → Email → turn off "Confirm email". Then new team members can
  sign in immediately.
- **Removing a person completely** is built into the app: Menu → Team → the
  ✕ next to their name (Admin only). It deletes their sign-in account; the
  clients and orders they created stay in the system. Admins cannot delete
  their own account, so the studio can never lock itself out.

## Customising

- Business name and currency symbol: Menu inside the app (Admin only).
- Theme colours: the two token blocks at the top of `css/crm.css` (`:root` for
  light, `:root[data-theme="dark"]` for dark). Everything else in the stylesheet
  refers to those tokens, so changing a colour in one place changes it
  everywhere. The dark block sits inside `@media screen` on purpose: printing
  falls back to the light tokens so paper is never dark.
- Garment type suggestions: edit the `GARMENTS` list in `js/app.js`.
- Measurement fields: edit the `MEASUREMENTS` list in `js/app.js`.
- Pipeline stages: edit the `STATUSES` list in `js/app.js` (also update the
  status check constraint on the `orders` table if you change the keys).
- Backend connection: `js/config.js` (Supabase URL and publishable key).
