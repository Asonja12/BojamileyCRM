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
- Everyone who signs up after that starts as a **Viewer** until the Admin
  upgrades them (Menu → Team).
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
- **Team:** the Admin manages who has what access from the Menu.
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
- Garment type suggestions: edit the `GARMENTS` list in `js/app.js`.
- Measurement fields: edit the `MEASUREMENTS` list in `js/app.js`.
- Pipeline stages: edit the `STATUSES` list in `js/app.js` (also update the
  status check constraint on the `orders` table if you change the keys).
- Backend connection: `js/config.js` (Supabase URL and publishable key).
