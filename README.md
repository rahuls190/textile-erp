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
npm test                        # 79 tests, each file on a fresh database
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
| Guards: no self-access changes, never remove the last administrator; the admin role keeps user, role and access management and cannot be deleted | ✅ |
| HR: employee register (site-scoped, bank masked), departments, designations, shifts, holidays | ✅ |
| Attendance (P/A/H/L/LWP/WO/HOL, late/overtime from the shift), locked once payroll is approved | ✅ |
| Leave: yearly quota ledger (append-only), apply → line manager or HR approves (never yourself) | ✅ |
| Payroll: salary structures (propose ≠ approve), monthly run (draft → recalculate → approve by a different person), immutable payslips, employees see only their own | ✅ |

**Statutory payroll rates are defaults, not advice** (PF 12% on basic capped at ₹15,000, ESI 0.75%/3.25% up to ₹21,000 gross,
professional tax ₹200 from ₹25,000, overtime at double the basic hourly rate). They live in `PAYROLL_RULES` in `src/domain/hr.ts`.
Have your accountant confirm them for your state before paying anyone. Income-tax (TDS) is not handled.

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
| REST API + validation, clean errors, reads filtered by site scope | ✅ |

The blueprint's own worked example (p.55: 500 m → 480 accepted / 20 rejected → reserve 120 → 360 left) and the
acceptance tests for quality separation, concurrent allocation, replay safety, scope and separation of duties
are automated in `test/`.

## Not built yet

P01 planning · P03 vendor portal · W05 transfers · W07 split/slit · W08 supplier return/debit · W09 dead stock ·
J01–J03 subcontracting · F01–F08 production · S01–S03 sales · A01–A04 finance/GST/e-invoice/e-way bill ·
recruitment/appraisal/loans, maintenance, reports · **offline factory node + cloud sync** (the outbox and idempotency are the
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
