# Capture guide

Six screenshots, referenced from the root `README.md`. Take them, drop the PNGs
in this folder using the exact filenames below, then uncomment the table in the
root README.

## Before anything else: do not photograph real clients

The live app holds real names, phone numbers, addresses and prices. A public
portfolio repository is a bad place for any of that, and a reviewer who spots it
will read it as carelessness rather than thoroughness.

Scrub the page before capturing. Open the browser console on the running app,
fill in your real values on the left, and run this:

```js
(function () {
  // your real values  ->  what should appear in the screenshot
  var swap = {
    "Real Client Name":  "Adaeze Okonkwo",
    "Another Real Name": "Chioma Nwosu",
    "A Third Real Name": "Folake Adeyemi",
    "yourstudio@gmail.com": "studio@bojamiley.com"
  };

  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode())) {
    var t = node.nodeValue;
    Object.keys(swap).forEach(function (real) { t = t.split(real).join(swap[real]); });
    // safety net for anything missed
    t = t.replace(/\+?\d[\d\s\-()]{8,}\d/g, "+234 803 123 4567");
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "adaeze@example.com");
    node.nodeValue = t;
  }
  // links carry the same details
  document.querySelectorAll('a[href^="tel:"],a[href^="mailto:"],a[href*="wa.me"]')
    .forEach(function (a) { a.removeAttribute("href"); });
})();
```

Re-run it after navigating, since each screen re-renders.

## Settings

- **Desktop shots** — browser at **1280 × 800**, zoom 100%
- **Phone shots** — device toolbar, **iPhone 14 Pro** or any 390 × 844 preset
- Capture the viewport only, not the whole browser chrome
- Save as **PNG**, and keep each file under about 400 KB

## The six

| file | screen | what should be on it |
|---|---|---|
| `01-dashboard.png` | Studio dashboard, desktop | Overdue and due-soon cards, the stat row, a few orders. The most representative single view. |
| `02-order-detail.png` | An order, desktop | The stage pipeline, a photo or two, and the payments block — this is where the app does the most at once. |
| `03-client-portal.png` | Client portal home, **phone** | The greeting, an order card, and the stage journey. Shot on a phone frame because that is where clients use it. |
| `04-measurements.png` | Client measurements, **phone** | The size selector and the measurement grid, part-filled. |
| `05-invoice.png` | An invoice, desktop | The full document with the payment details block. Use a fictional bank account. |
| `06-dark-mode.png` | Studio dashboard again, dark | Same view as `01` so the two read as a pair. |

## Two worth getting right

**`03` sells the project.** A client watching her wedding dress move through
cutting, fitting and finishing is the idea in one picture. Give it an order in a
middle stage — *Fitting* reads better than *New*.

**`06` should match `01` exactly.** Same scroll position, same data. A pair that
differs only in theme demonstrates the token system; two unrelated views just
look like two screenshots.
