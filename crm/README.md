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
| **Admin** | Everything: edit, delete, settings, and changing team roles |
| **Staff** | Add and edit clients and orders. Cannot delete anything, change settings, or change roles |
| **Viewer** | See everything. Change nothing |

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
  notes, and a full measurement profile (bust, waist, hips, shoulder, sleeve,
  gown length, and 12 more). Enter measurements once, reuse them on every order.
- **Orders:** garment type, fabric (and who provided it), style description,
  price, order and due dates, urgent flag, and an order number (ORD-001...)
  assigned by the database so numbers never clash.
- **Progress pipeline:** New, Cutting, Sewing, Fitting, Adjustments,
  Ready for Pickup, Delivered. One tap moves an order to the next stage.
- **Payments:** record the deposit and every payment; the balance owed is
  always visible on the order and on the client.
- **Dashboard:** overdue orders and anything due in the next 7 days rise to
  the top, plus totals for active orders and outstanding balances.
- **Team:** the Admin manages who has what access from the Menu.
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
- **Removing a person completely** (not just making them a Viewer) is done in
  Authentication → Users → delete user.

## Customising

- Business name and currency symbol: Menu inside the app (Admin only).
- Garment type suggestions: edit the `GARMENTS` list in `js/app.js`.
- Measurement fields: edit the `MEASUREMENTS` list in `js/app.js`.
- Pipeline stages: edit the `STATUSES` list in `js/app.js` (also update the
  status check constraint on the `orders` table if you change the keys).
- Backend connection: `js/config.js` (Supabase URL and publishable key).
