# Textile ERP — foundation, stock core, admin console and HR (slices 1–2)

Built from *Textile ERP — Detailed process & system architecture* (design draft 1.0, 14 Oct 2026).
This is the first real, database-backed slice: the platform rules every other module depends on, plus the
purchase → receipt → quality → stock path. **Single node only** (no factory/cloud sync yet — see "Not built yet").

## Run it

Needs Node 20+ and PostgreSQL 16 (Docker is easiest).

```bash
docker compose up -d            # PostgreSQL on :5433
cp .env.example .env            # or set DATABASE_URL / PG_ADMIN_URL in your shell
npm install
npm run migrate                 # create the schema
npm run seed:demo               # demo company, site, roles, users (password: Demo-Passw0rd!  — dev only)
npm start                       # API on http://localhost:3000
npm test                        # 220 tests, each file on a fresh database
```

Try it: `POST /api/login` → use the token as `Authorization: Bearer …`. **Every write needs an `Idempotency-Key`
header** (any unique string, 8–100 chars); repeating a key returns the original result and changes nothing.

## Browser demo (no server needed)

`docs/` is a complete clickable demo: the real engine and rules running on PostgreSQL-in-the-browser (PGlite).
Data lives in the visitor's own browser; "Reset demo data" starts over. Rebuild with
`node ui/build.mjs && cp ui/index.html ui/out/index.html` (needs the dev dependencies), then copy `ui/out/*` to `docs/`.
Demo logins use the password above; the login screen has one-click person chips.

## Admin console and HR (slice 2)

| Area | Status |
|---|---|
| Real login: password strength, **lockout after 5 failures (15 min)**, forced change after a reset, sign-in log, session list, change own password (ends other sessions) | ✅ |
| Users: create, edit, suspend/reactivate, unlock, reset password (ends sessions) | ✅ |
| Roles are data: assign per site with amount limit and expiry, revoke with reason, **edit role permissions and descriptions** (reason required), add custom roles, delete unused roles | ✅ |
| Per-user appearance (theme, colour, layout, density), saved on the account and applied on any device | ✅ |
| **Owner desk**: one visual page, every process end to end (buying → receiving → quality → stock; people → attendance → leave → payroll), what is waiting and how long | ✅ |
| **Escalation ladder** for urgent approvals: approver → senior management → owner. Urgent climbs by itself if nobody acts; critical goes straight to the owner; items that wait past their limit are raised automatically | ✅ |
| **Owner override**: approve or reject any pending item (PO, stock adjustment, leave, salary, payroll) past the approver's limit and the separation-of-duties rule. A written reason is required, the record shows the owner decided, and it goes in an append-only log shown on the owner desk | ✅ |
| **Barcodes**: Code 128 labels for every roll (its lot label, the same code on every reprint) and every shelf (`L:` + code), printable in two sizes. **Scan** a roll or shelf to see what and where it is (keyboard-style USB scanners, or the camera where the browser supports it). **Move forward**: scan the roll, then the next place; stock moves along Receiving → Store → Rack through the normal putaway rules, so held or rejected rolls are refused, backwards moves are refused, and each move is audited and leaves a balanced ledger entry | ✅ |
| **Overview**: a short greeting, what is waiting for you, and animated charts (stock ring, order pipeline, quality pass rate, material received over 14 days, attendance today), each shown only if your role can see that data | ✅ |
| **Reports**: 13 reports (purchase register, vendor performance, stock position, quality, approvals waiting, headcount, attendance, leave balances, payroll register, PF/ESI/tax summary, overrides & escalations, access review, audit activity). Each is shown only to roles holding its permission, limited to the person's sites in the query itself, with date/month/year filters, summary tiles, a bar chart, and CSV copy/download. **Every run is written to the audit log** (who, which report, filters, rows); payroll reports are marked sensitive | ✅ |
| **AI custom reports**: describe a report in plain words ("net pay by department last month", "top 5 employees by late minutes this month"); the assistant turns it into a structured spec, shows how it read the request, and runs it. Specs can be saved, kept private or shared. **The AI never writes SQL**: it can only name the datasets and columns in a fixed catalogue (`src/domain/custom-reports.ts`), the dataset's permission and the person's site scope are enforced on every run, all values are query parameters, and each run is audited with the spec and the original question. A payroll-type request from someone without payroll rights is refused | ✅ |
| Guards: no self-access changes, never remove the last administrator; the admin role keeps user, role and access management and cannot be deleted | ✅ |
| HR: employee register (site-scoped, bank masked), departments, designations, shifts, holidays | ✅ |
| Attendance (P/A/H/L/LWP/WO/HOL, late/overtime from the shift), locked once payroll is approved | ✅ |
| Leave: yearly quota ledger (append-only), apply → line manager or HR approves (never yourself) | ✅ |
| Payroll: salary structures (propose ≠ approve), monthly run (draft → recalculate → approve by a different person), immutable payslips, employees see only their own | ✅ |

**Statutory payroll rates are defaults, not advice** (PF 12% on basic capped at ₹15,000, ESI 0.75%/3.25% up to ₹21,000 gross,
professional tax ₹200 from ₹25,000, overtime at double the basic hourly rate). They live in `PAYROLL_RULES` in `src/domain/hr.ts`.
Have your accountant confirm them for your state before paying anyone. Income-tax (TDS) is not handled.

**About the AI:** with `ANTHROPIC_API_KEY` set on the server, requests are read by a Claude model (only the question and the list of columns the person may use are sent, never business data; `AI_MODEL` overrides the model). Without a key, and in the browser demo, a built-in keyword reader handles common requests, so the feature works with no outside service but is less flexible. The demo makes no calls to any AI service.

The escalation time limits (24 h for orders, adjustments and leave; 72 h salary; 48 h payroll; 4 h per rung) are defaults in
`ESCALATION_RULES` in `src/domain/owner.ts`. The check runs when someone presses the button in the demo; in real use it must be scheduled
(call `sweepEscalations` every few minutes). Notifications by SMS/WhatsApp/email are not built: people see escalations when they open the app.

## What is built (blueprint IDs)

| Area | Status |
|---|---|
| Platform: identity, sessions, roles, **action + site scope + validity + approval band**, deny-by-default | ✅ |
| Separation of duties (creator ≠ approver) on items, partners, rates, POs, amendments, adjustments | ✅ |
| Append-only audit log and stock ledger (enforced by database triggers) | ✅ |
| Idempotent commands (one transaction each) + transactional outbox events | ✅ |
| Per-site document numbering | ✅ |
| M01 company, sites, locations (simplified: no draft/approve state flow yet) | ◐ |
| M02 items & variants (approve flow), M03 partners (bank verified by finance, masked fields), M04 effective-dated rates, snapshots on PO lines | ✅ |
| P02 PO: draft → submit → approve → **release** (separate rights), amendments with independent approval and kept versions, cancel / short-close | ✅ |
| W01 receipt → QC **HOLD** (arrival never makes usable stock); excess, duplicate challan, wrong unit/vendor blocked | ✅ |
| W02 inspection → disposition by quality authority only; accept / reject / partial; PO reopens on rejection | ✅ |
| W03 ledger-derived balances, putaway rules (held stock can't enter an allocation pool) | ✅ |
| W04 reservations with atomic availability (concurrent requests cannot over-commit) | ✅ (reservations only) |
| W06 adjustments: propose → independent approve (band) → post; never type over a balance | ◐ (no count workflow) |
| **CRM + sales**: leads → follow-ups → quotation (max 10% discount without extra right, 15-day validity) → order (banded approval, creator ≠ approver, credit-limit check) → stock hold → dispatch by storekeeper (immutable dispatch note, consumes the hold, posts the stock ledger) | ✅ (no invoice or payment yet) |
| **Master data**: material types (what each type must record, code letters, tracking), materials with HSN / GST / reorder level and type-driven attributes (draft → independent approval, switch off only when nothing uses it), vendors and clients with GSTIN/PAN checks, contacts, billing and shipping addresses (same-as-billing, a default per type, full list of 36 states and territories), payment days, suspend/reactivate (bank or GSTIN change sends an approved party back for checking), vendor price lists, units, and all-or-nothing CSV bulk add | ✅ |
| **Barcode registry and label designer**: every code is a row with its own id and a unique code that is never reused (rolls, shelves, materials and staff are registered automatically; cartons, assets and spare roll labels are issued in numbered series, safe when many people issue at once). Attach a spare code to a roll, cancel a code with a reason, see what it is stuck on. Label layouts in millimetres with Code 128 and QR, drag-to-move designer, default layout per kind, sheet or label-printer output. Every print and reprint is logged (a reprint needs a reason) | ✅ |
| **Products and BOM**: a style has sizes and colours; one SKU (a finished-goods item with its own barcode) per size and colour. Versioned BOMs: lines can apply to every size and colour or only some, change quantity by size, and add wastage; submitted by one person, approved by another (the old version retires, SKUs become ready). Cost per SKU from approved vendor prices; a requirements calculator turns pieces per SKU into materials needed against stock and open orders. **Packs**: a final box made of several SKUs plus packing materials | ✅ |
| **Six master lists** (Vendors, Distributors, Retailers, SKUs, Materials, Finished goods): each has edit, **Add several** (a grid that runs through the same all-or-nothing checker as the import), **Import CSV** (a row with an existing code changes that record, an empty code adds one), and **Export CSV** in the same columns, so a file can be edited and loaded back. Customers are distributors or retailers (old customers become retailers) | ✅ |
| **Production plan** (six months ahead): finished pieces to make each month from average sales (or typed sales, or a figure for one month) plus a minimum stock of average sales × days of cover; materials from the approved BOM with size quantities, wastage and **cutting yield**; finished fabric made from grey fabric with the **loss in finishing**; month-by-month balance for every material against stock and open orders; shortages become **purchase requests** (one per vendor, dated by needed-by and order-by from the lead time), never asked for twice, which the buyer turns into a draft PO | ✅ |
| **Work orders** (finishing and cutting): grey fabric goes out to your own unit or a job-work vendor and comes back as finished fabric (loss recorded) on QC hold; accepted fabric is split into shade lots; a cutting order takes BOM materials (fabric by colour and shade, divided by the cutting yield) and records the pieces actually cut. Pieces cut below plan go through QC again and the shortfall returns to the production plan. Plan counts open orders and QC-hold pieces as on the way, so nothing is planned or bought twice. | `production.*` |
| **AI model registry** (owner/administrator only): add, edit, remove providers (Anthropic, OpenAI, Google, any OpenAI-compatible endpoint) and models, store API keys sealed with AES-GCM (only last 4 shown, never returned or audited), assign a primary and fallback model per job (assistant, reports), test a model, append-only call log | ✅ |
| **AI assistant** with voice: floating helper that answers from the user's own permissions, opens screens, and prepares changes (leads, vendors, etc.) that only run after the user says yes (button or voice). Uses the assigned model, or a built-in reader when none is set | ✅ |
| REST API + validation, clean errors, reads filtered by site scope | ✅ |

The blueprint's own worked example (p.55: 500 m → 480 accepted / 20 rejected → reserve 120 → 360 left) and the
acceptance tests for quality separation, concurrent allocation, replay safety, scope and separation of duties
are automated in `test/`.

## Not built yet

Gate-in/out scanning, scanning for issue to production (needs F01–F08), cycle counts by scan, inter-site transfers (W05) ·
P01 planning · P03 vendor portal · W05 transfers · W07 split/slit · W08 supplier return/debit · W09 dead stock ·
J01–J03 subcontracting · F01–F08 production · S-series invoicing, returns and receipts · sales orders are not yet in the owner-desk escalation or override · A01–A04 finance/GST/e-invoice/e-way bill ·
recruitment/appraisal/loans, maintenance, scheduled or emailed reports, PDF/Excel export (CSV only), finance reports (need A01–A04) · **offline factory node + cloud sync** (the outbox and idempotency are the
foundation for it) · data migration tooling. (The browser demo is a prototype interface; a production front end is not built.)

## Decisions I made (change any of them)

* Stack: Node + TypeScript, Fastify, PostgreSQL 16 (the blueprint is stack-neutral and asks for a proof-of-capability).
* Master data (items, partners, rates) is company-level: the role may be held at any site. Transactions are site-scoped.
* Adjustment approval bands use **quantity** until valuation (A03) exists to give a currency value.
* Units: only the item's stock unit is accepted; conversions are refused until M04 conversions are built.
* Receipt is one step (STO posts); a separate gate-entry record (GATE role) comes later.
* Money = NUMERIC, 2 dp half-up; quantities = NUMERIC(18,4). No floating point anywhere.

## Before real factory use (not done)

Network rate limiting, TLS termination, email/SMS password reset (today an administrator issues a temporary password), secrets management, backups + restore rehearsal (RPO 15 min / RTO 4 h targets),
load testing from the site survey, and statutory validation with your CA — all listed in the blueprint's decision register (p.61).

## AI models and assistant: notes

* Set `AI_KEY_SECRET` on the server (used to seal provider keys). Live model calls need the server to reach the provider; the browser demo cannot, so it uses the built-in reader.
* Voice uses the browser Web Speech API: Chrome or Edge on a normal web address (GitHub Pages works). The microphone is blocked inside the Claude artifact view.
* Check the seeded model names against each provider's own model list before switching a provider on.


### Automatic daily run
Set `PLAN_AUTORUN_USER=<planner username>` (and optionally `PLAN_AUTORUN_HOUR`, default 6, server time) and the server raises purchase requests and drafts cutting orders once a day. The same run is the **Run the plan now** button on the Production plan screen.
