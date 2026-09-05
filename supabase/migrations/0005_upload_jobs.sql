-- Asynchronous uploads.
--
-- Run AFTER 0003_multi_tenant.sql. Safe to re-run.
--
-- Storing a file on Warm Storage takes ~80s: the bytes go to the storage
-- provider quickly, then the provider broadcasts createDataSetAndAddPieces and
-- the chain has to confirm it. That is far longer than a serverless request may
-- run, so the work is split across requests and its progress lives here.
--
--   committing  bytes are with the provider, the commit has been submitted
--   confirming  waiting for the chain to confirm the data set / pieces
--   done        confirmed and enrolled as a defendant (file_id is set)
--   failed      gave up; error says why
--
-- A row is a receipt, not a queue entry: nothing polls this table server-side.
-- The client polls the status route, and each poll advances one job one step.

create table if not exists upload_jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,
  priority     text not null default 'normal',
  size_bytes   bigint not null default 0,
  state        text not null default 'committing',

  -- Filled in as the upload progresses.
  piece_cid    text,
  provider     text,
  service_url  text,
  -- Where the provider reports commit progress. The only handle we have on an
  -- in-flight commit once the request that started it has ended.
  status_url   text,
  tx_hash      text,
  data_set_id  text,
  -- Set when the commit went to an EXISTING data set, which is confirmed
  -- through a different provider endpoint than a freshly created one.
  added_to_existing boolean not null default false,

  file_id      uuid references files (id) on delete set null,
  error        text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint upload_jobs_state_check
    check (state in ('committing', 'confirming', 'done', 'failed'))
);

create index if not exists upload_jobs_user_idx on upload_jobs (user_id, created_at desc);

alter table upload_jobs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'upload_jobs' and policyname = 'own_upload_jobs') then
    create policy own_upload_jobs on upload_jobs
      for select using (auth.uid() = user_id);
  end if;
end $$;
