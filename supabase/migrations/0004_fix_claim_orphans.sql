-- Fix claim_orphan_rows for the case where the user already has an account.
--
-- Run AFTER 0003_multi_tenant.sql. Safe to re-run.
--
-- The original version tried to claim EVERY orphaned agent_account row. If the
-- user had already signed in, getScope() had created one for them, and the
-- update collided with agent_account_user_unique:
--
--   duplicate key value violates unique constraint "agent_account_user_unique"
--
-- Accounts are one-per-user; files and sessions are many-per-user. Only the
-- account needs special handling.

-- The return signature changes, so replace rather than redefine.
drop function if exists claim_orphan_rows(uuid);

create function claim_orphan_rows(new_owner uuid)
returns table (
  claimed_account  int,
  claimed_files    int,
  claimed_sessions int,
  skipped_accounts int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  a int := 0;
  f int := 0;
  s int := 0;
  skipped int := 0;
  has_account boolean;
begin
  select exists (select 1 from agent_account where user_id = new_owner) into has_account;

  if has_account then
    -- Already has an account from first sign-in. Adopting an orphan would
    -- violate the one-account-per-user constraint, so leave orphans be: they
    -- are invisible under RLS and can be deleted by hand once you are happy
    -- nothing was lost. Deleting them here would silently discard a balance.
    select count(*) into skipped from agent_account where user_id is null;
  else
    -- Adopt exactly one orphan; extras stay orphaned and are reported.
    update agent_account
       set user_id = new_owner
     where id = (select id from agent_account where user_id is null order by id limit 1);
    get diagnostics a = row_count;

    select count(*) into skipped from agent_account where user_id is null;
  end if;

  -- Files and sessions have no per-user uniqueness, so these always work.
  update files set user_id = new_owner where user_id is null;
  get diagnostics f = row_count;

  update court_sessions set user_id = new_owner where user_id is null;
  get diagnostics s = row_count;

  return query select a, f, s, skipped;
end $$;

comment on function claim_orphan_rows is
  'Assigns pre-multi-tenancy rows to a user. Run once, then drop or revoke it.';
