-- Multi-tenancy: a court per user.
--
-- Run AFTER 0001_init.sql and 0002_filecoin_links.sql. Safe to re-run.
--
-- Every row becomes owned by an auth.users id. RLS is rewritten so a signed-in
-- user sees only their own account, files, sessions and verdicts -- the service
-- role still bypasses it for the agent's own writes.
--
-- EXISTING DATA: rows created before this migration have user_id = null and are
-- invisible to everyone except the service role. Claim them with:
--
--   select claim_orphan_rows('<your-auth-user-id>');

-- ---------------------------------------------------------------------------
-- Ownership columns
-- ---------------------------------------------------------------------------
alter table agent_account  add column if not exists user_id uuid references auth.users (id) on delete cascade;
alter table files          add column if not exists user_id uuid references auth.users (id) on delete cascade;
alter table court_sessions add column if not exists user_id uuid references auth.users (id) on delete cascade;

create index if not exists agent_account_user_idx  on agent_account  (user_id);
create index if not exists files_user_idx          on files          (user_id);
create index if not exists court_sessions_user_idx on court_sessions (user_id);

-- One account per user, instead of one account globally.
alter table agent_account drop constraint if exists agent_account_singleton;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_account_user_unique'
  ) then
    alter table agent_account add constraint agent_account_user_unique unique (user_id);
  end if;
end $$;

-- The id column was a singleton pin; make it a real surrogate key so multiple
-- accounts can exist.
do $$
begin
  if not exists (
    select 1 from pg_class where relname = 'agent_account_id_seq'
  ) then
    create sequence agent_account_id_seq owned by agent_account.id;
    perform setval('agent_account_id_seq', coalesce((select max(id) from agent_account), 1));
    alter table agent_account alter column id set default nextval('agent_account_id_seq');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Wallet identity + delegated authority
--
-- The agent never holds a user's private key. Instead the user's wallet calls
-- the session key registry's login(signer, permission, expiry), authorising a
-- signer address the agent controls. That signer is DERIVED from a server
-- secret plus the user id, so no key material is ever stored here -- only the
-- public address, and what it was authorised to do.
-- ---------------------------------------------------------------------------
alter table agent_account add column if not exists wallet_address        text;
alter table agent_account add column if not exists session_key_address   text;
alter table agent_account add column if not exists session_key_expires_at timestamptz;
alter table agent_account add column if not exists session_key_permissions text[] not null default '{}';
alter table agent_account add column if not exists session_key_tx        text;

create index if not exists agent_account_wallet_idx on agent_account (lower(wallet_address));

comment on column agent_account.wallet_address is
  'EVM address proved via Sign-In With Ethereum (EIP-4361).';
comment on column agent_account.session_key_address is
  'Agent-controlled signer authorised by the user via the session key registry. Derived, never stored as a secret.';
comment on column agent_account.session_key_expires_at is
  'When the delegated authority lapses. After this the agent can no longer act.';

-- ---------------------------------------------------------------------------
-- Row Level Security: own rows only.
--
-- 0001 granted blanket public read. That is wrong once data belongs to people,
-- so those policies are replaced outright.
-- ---------------------------------------------------------------------------
drop policy if exists public_read on agent_account;
drop policy if exists public_read on files;
drop policy if exists public_read on access_events;
drop policy if exists public_read on court_sessions;
drop policy if exists public_read on verdicts;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'agent_account' and policyname = 'own_account') then
    create policy own_account on agent_account
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'files' and policyname = 'own_files') then
    create policy own_files on files
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'court_sessions' and policyname = 'own_sessions') then
    create policy own_sessions on court_sessions
      for select using (auth.uid() = user_id);
  end if;

  -- Children are scoped through their parent.
  if not exists (select 1 from pg_policies where tablename = 'access_events' and policyname = 'own_access_events') then
    create policy own_access_events on access_events
      for select using (
        exists (select 1 from files f where f.id = access_events.file_id and f.user_id = auth.uid())
      );
  end if;

  if not exists (select 1 from pg_policies where tablename = 'verdicts' and policyname = 'own_verdicts') then
    create policy own_verdicts on verdicts
      for select using (
        exists (select 1 from court_sessions s where s.id = verdicts.session_id and s.user_id = auth.uid())
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Claim pre-multi-tenant rows.
-- ---------------------------------------------------------------------------
-- NOTE: superseded by 0004_fix_claim_orphans.sql, which handles the case
-- where the user already has an account from first sign-in. Kept here only so
-- the migration history reads in order; 0004 replaces it outright.
