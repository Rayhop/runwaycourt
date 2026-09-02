# RunwayCourt

**Where your data pleads its case to stay alive.**

An autonomous agent that manages its own Filecoin storage budget. It reads its real
runway from Filecoin Pay, and when funds get tight it convenes a **court session**:
every stored file is scored, ranked, and has to justify its rail. The agent hands down
KEEP / DOWNGRADE / DROP verdicts, acts on them, and narrates every one in plain English
to a public Case Log.

---

## The decision, in one screen

```
score = access·hits₇d  +  recency·decay  +  priority·tag  −  cost·rate
```

Two tests, in order:

1. **Merit** — a negative score means the file costs more than its access, recency and
   priority justify. Dropped regardless of budget, so cheap junk can never outlive a
   file that scored above it.
2. **Budget** — survivors are funded top-down. When the full warm rate no longer fits,
   single-copy storage at 40% is tried before dropping.

Verified output against the seed inventory:

```
budget/epoch : 0.00017361 USDFC
burn before  : 0.00060670 USDFC/epoch -> 2.9 days
spend after  : 0.00017130 USDFC/epoch -> 10.1 days

 1. KEEP        126.9  client-invoices-2026.zip
     Kept client-invoices-2026.zip (40 retrievals this week, cheap to hold).
 5. KEEP         50.2  legal-retention-2019.pdf
     Kept legal-retention-2019.pdf (untouched 46 days, cheap to hold).
 6. DOWNGRADE    40.8  user-uploads-2026-q1.tar
     Downgraded to single-copy storage (last touched 1 day ago, expensive to hold)
     — 40% of the rate keeps it alive inside the budget.
 8. DROP        -17.5  scratch-experiment-b.tmp
     Dropped (untouched 27 days, tagged junk) — score -17.5 went negative, so it
     could not justify its rail at any budget.

Session #1 — Runway at 2.9 days triggered a review. Court kept 5, downgraded 2,
dropped 3. Runway extended to 10.1 days.
```

Reproduce it yourself, with no database and no wallet:

```bash
npx tsx scripts/verify-court.ts
```

---

## Running it

### 1. Supabase schema

Create a project, then open **SQL Editor** in the dashboard and run exactly two files,
**in this order**:

| # | File | What it does |
| --- | --- | --- |
| 1 | [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) | Creates the 5 tables, indexes and RLS policies. Run once. |
| 2 | [`supabase/seed.sql`](supabase/seed.sql) | Loads 10 demo files, funds the agent with 5 USDFC, and backfills retrieval history. Re-runnable — it truncates first. |

Paste the whole contents of each into a new query and hit **Run**. Both are idempotent,
so re-running is safe. Ignore the `supabase_realtime publication not found` notice if it
appears — realtime is optional, the dashboard polls.

Prefer the CLI? `supabase db push` applies the migration; the seed still needs to be run
manually.

### 2. Environment

```bash
cp .env.example .env.local
```

Supabase renamed its API keys. Map what the dashboard shows you under
**Project Settings → API Keys**:

| Dashboard | `.env.local` |
| --- | --- |
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| Publishable key (`sb_publishable_…`) | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| Secret key (`sb_secret_…`) | `SUPABASE_SECRET_KEY` |
| JWKS URL | **not used** — see below |

Older projects show **anon** and **service_role** instead; those still work, as
`NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` respectively.

The **JWKS URL is not needed**. It exists to verify end-user JWTs, and RunwayCourt has no
user login — the agent is the only writer, and it authenticates with the secret key.

`SUPABASE_SECRET_KEY` bypasses Row Level Security and deliberately has no
`NEXT_PUBLIC_` prefix. Never expose it to the browser or commit it.

### 3. Run

```bash
npm install
npm run dev
```

---

## Chain layer

Selected with `RUNWAYCOURT_CHAIN`:

| Mode | Reads | Writes |
| --- | --- | --- |
| `simulator` *(default)* | Runway derived from the live file inventory and real elapsed time at 30s/epoch. | Updates Supabase; dropping a file genuinely lowers burn and extends runway. |
| `synapse` | **Live** — `getAccountSummary`, `getPriceList`, `getClientDataSets` off Filecoin Pay / FWSS. | `DROP` → real `terminateService()` tx. `KEEP` is a no-op. `DOWNGRADE` is advisory. |

Both sit behind one interface — [`lib/filecoin/types.ts`](lib/filecoin/types.ts). Scoring,
verdicts, narration and the dashboard are identical either way.

### Prove the chain reads are live

No funds, no wallet, no database needed — reads work with an RPC endpoint alone:

```bash
npm run verify:filecoin
```

Verified output against Calibration:

```
network        : calibration (chain 314159)
filecoinPay    : 0x09a0fDc2723fAd1A7b8e3e00eE5DF73841df55a0
fwssView       : 0x9BF9e67e83EC8613883FDdDec4D3b38AEE937177
USDFC          : 0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0
head epoch     : 4018622

== Warm Storage pricing (live) ==
storage / TiB / month : 2.500000 USDFC
storage / TiB / epoch : 0.000028935185 USDFC
dataset fee / month   : 0.024000 USDFC
```

Add `FILECOIN_ADDRESS=0x…` to also print live runway, burn rate and data sets for a
specific account.

### Going live end to end

1. **Fund a Calibration wallet** with tFIL (gas) and tUSDFC from the faucet.
2. **Upload something through Warm Storage.** Until a data set exists there is no rail,
   nothing is being paid for, and `runwayInEpochs` comes back as `uint256` max —
   correctly rendered as *unlimited*, but there is nothing to put on trial.
3. **Apply [`0002_filecoin_links.sql`](supabase/migrations/0002_filecoin_links.sql)**, which
   adds `data_set_id` / `pdp_rail_id` to `files`.
4. **`npm run sync:filecoin`** — pulls your real data sets into Supabase. Cost and size are
   both read off chain, not estimated:
   - `cost_per_epoch` = summed `paymentRate` of the set's PDP / CDN / cache-miss rails
   - `size_bytes` = `getDataSetLeafCount(dataSetId) x 32`

   It then reconciles the summed rail rates against the account's own
   `lockupRatePerEpoch` and warns if they disagree — a mismatch means the account is
   paying for rails the court cannot see, so dropping everything would not take runway
   to zero.
5. Set `RUNWAYCOURT_CHAIN=synapse` and `FILECOIN_PRIVATE_KEY`, restart.

A `DROP` verdict now submits `terminateService(dataSetId)` and the Case Log records the
transaction hash.

### What is and isn't proven

| | Status |
| --- | --- |
| `getAccountSummary` (runway, burn, debt) | **Verified live** on Calibration |
| `getPriceList` (Warm Storage pricing) | **Verified live** on Calibration |
| `getClientDataSets` (data sets + rail ids) | **Verified live** (0 rows for an empty account) |
| `getRail` (real per-epoch payment rate) | **Verified live** — rail 1 returns `paymentRate=11789`, `lockupPeriod=86400` |
| `getDataSetLeafCount` (real size) | **Verified live** — data set 1 returns 602,394 leaves = 18.4 MB |
| `terminateService` on DROP | **Written, never executed** — needs a funded wallet with a real data set |
| `DOWNGRADE` onchain | **Not possible today.** FWSS exposes no cheaper tier via `getPriceList`, so it reports `ok:false` rather than pretending. Advisory only in synapse mode. |

Two things worth knowing before a demo:

- **Use the SDK's chain object, not viem's.** `@filoz/synapse-core/chains` exports
  `calibration` / `mainnet` carrying the contract addresses every helper resolves through
  `asChain()`. viem's plain `filecoinCalibration` has no `contracts` entry and every call
  fails. This bit the first version of the adapter.
- **Zero burn means unbounded runway.** With no active rails, Filecoin Pay returns
  `type(uint256).max`, not `0`. Treating that as a number gives `1.15e77`.

## Layout

```
lib/
  epochs.ts              30s/epoch, 86,400 epochs/month, USDFC formatting
  filecoin/
    types.ts             the adapter seam
    simulator.ts         runway from inventory + elapsed time
    synapse.ts           real Filecoin Pay reads
  court/
    scoring.ts           Survival Score
    verdicts.ts          the KEEP/DOWNGRADE/DROP rule (pure, testable)
    session.ts           full trial loop, writes to Supabase
    preview.ts           what the court WOULD do, for the live panel
    narrate.ts           plain-English Case Log copy
app/api/
  court/                 GET vitals + live ranking
  court/session/         POST convene (force, or no-op above threshold)
  case-log/              GET past sessions + verdicts
  files/access/          POST record a retrieval
supabase/
  migrations/0001_init.sql
  seed.sql
scripts/verify-court.ts  engine verification, no deps
```

## Epoch facts the code relies on

- 1 epoch = 30 seconds; 1 "month" = exactly **86,400 epochs** (30 days).
- The SDK returns `runwayInEpochs` directly — never hand-calculate it from balance and
  burn rate.
- Prices are quoted per-month onchain but rails settle per-epoch. All internal maths is
  per-epoch; conversion happens once, at the edge.
- At zero runway the account enters **deficit**: uploads fail and providers can terminate
  rails and claim against the lockup. That is the outcome RunwayCourt exists to avoid,
  and the Vitals panel calls it out in red.
