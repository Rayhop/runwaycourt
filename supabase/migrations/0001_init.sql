-- RunwayCourt schema
--
-- Run against your Supabase project:
--   supabase db push
-- or paste into the SQL editor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- The agent's own account.
--
-- Single row (id = 1). In simulator mode this IS the account: runway is derived
-- from `funds` minus the burn accrued since `last_settled_at`. In synapse mode
-- these columns are ignored for vitals (we read the chain instead) and only
-- `runway_threshold_epochs` is used.
-- ---------------------------------------------------------------------------
create table if not exists agent_account (
  id                       int primary key default 1,
  -- Atomic USDFC (18 decimals). numeric(78,0) holds any uint256.
  funds                    numeric(78,0) not null default 0,
  debt                     numeric(78,0) not null default 0,
  last_settled_at          timestamptz   not null default now(),
  -- Open a court session when runway drops below this. Default 3 days.
  runway_threshold_epochs  bigint        not null default 8640,
  -- Court aims to leave this much runway after a session. Default 10 days.
  target_runway_epochs     bigint        not null default 28800,
  created_at               timestamptz   not null default now(),
  constraint agent_account_singleton check (id = 1)
);

-- ---------------------------------------------------------------------------
-- Stored files -- the defendants.
-- ---------------------------------------------------------------------------
create table if not exists files (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  piece_cid        text,
  size_bytes       bigint not null default 0,
  -- Atomic USDFC per epoch at the file's CURRENT tier.
  cost_per_epoch   numeric(78,0) not null default 0,
  tier             text not null default 'warm'
                     check (tier in ('warm', 'cold')),
  priority         text not null default 'normal'
                     check (priority in ('critical', 'normal', 'archive', 'junk')),
  status           text not null default 'active'
                     check (status in ('active', 'downgraded', 'dropped')),
  last_accessed_at timestamptz,
  created_at       timestamptz not null default now(),
  dropped_at       timestamptz
);

create index if not exists files_status_idx on files (status);
create index if not exists files_last_accessed_idx on files (last_accessed_at desc nulls last);

-- ---------------------------------------------------------------------------
-- Retrieval log. Feeds accesses_last_7d and recency_factor in the score.
-- ---------------------------------------------------------------------------
create table if not exists access_events (
  id          bigserial primary key,
  file_id     uuid not null references files (id) on delete cascade,
  occurred_at timestamptz not null default now()
);

create index if not exists access_events_file_time_idx
  on access_events (file_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Court sessions.
-- ---------------------------------------------------------------------------
create table if not exists court_sessions (
  id                      bigserial primary key,
  opened_at               timestamptz not null default now(),
  closed_at               timestamptz,
  status                  text not null default 'open'
                            check (status in ('open', 'closed', 'failed')),
  -- Vitals at the moment the session was triggered.
  trigger_runway_epochs   bigint,
  runway_before_epochs    bigint,
  runway_after_epochs     bigint,
  -- Atomic USDFC per epoch the court was allowed to keep spending.
  budget_per_epoch        numeric(78,0),
  spend_per_epoch         numeric(78,0),
  kept_count              int not null default 0,
  downgraded_count        int not null default 0,
  dropped_count           int not null default 0,
  -- One-paragraph plain-English summary. This is the Case Log entry.
  narration               text,
  chain_source            text not null default 'simulator'
);

create index if not exists court_sessions_opened_idx on court_sessions (opened_at desc);

-- ---------------------------------------------------------------------------
-- Per-file verdicts within a session.
-- ---------------------------------------------------------------------------
create table if not exists verdicts (
  id              bigserial primary key,
  session_id      bigint not null references court_sessions (id) on delete cascade,
  file_id         uuid references files (id) on delete set null,
  file_name       text not null,
  verdict         text not null check (verdict in ('KEEP', 'DOWNGRADE', 'DROP')),
  rank            int not null,
  score           double precision not null,
  -- The individual score terms, so the dashboard can show the maths.
  score_breakdown jsonb not null default '{}'::jsonb,
  rationale       text not null,
  tx_hash         text,
  executed        boolean not null default false,
  execution_note  text,
  created_at      timestamptz not null default now()
);

create index if not exists verdicts_session_idx on verdicts (session_id, rank);

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- The dashboard reads with the anon key; all writes go through the server using
-- the service role key, which bypasses RLS. So: public read, no public write.
-- ---------------------------------------------------------------------------
alter table agent_account  enable row level security;
alter table files          enable row level security;
alter table access_events  enable row level security;
alter table court_sessions enable row level security;
alter table verdicts       enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'agent_account' and policyname = 'public_read') then
    create policy public_read on agent_account for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'files' and policyname = 'public_read') then
    create policy public_read on files for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'access_events' and policyname = 'public_read') then
    create policy public_read on access_events for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'court_sessions' and policyname = 'public_read') then
    create policy public_read on court_sessions for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'verdicts' and policyname = 'public_read') then
    create policy public_read on verdicts for select using (true);
  end if;
end $$;

-- Let the dashboard stream new verdicts live.
do $$
begin
  -- Self-hosted and some project templates have no supabase_realtime
  -- publication. Realtime is optional here (the dashboard polls), so skip
  -- rather than failing the whole migration.
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not found; skipping realtime setup.';
    return;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'court_sessions'
  ) then
    alter publication supabase_realtime add table court_sessions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'verdicts'
  ) then
    alter publication supabase_realtime add table verdicts;
  end if;
end $$;
