-- Link files to the real Filecoin objects that get paid for.
--
-- Run AFTER 0001_init.sql. Safe to re-run.
--
-- A file only becomes actionable onchain once it has a data_set_id: that is
-- what terminateService() takes when the court hands down a DROP. Rows without
-- one are simulator-only and report "not settled" in synapse mode.

alter table files add column if not exists data_set_id   numeric(78,0);
alter table files add column if not exists pdp_rail_id   numeric(78,0);
alter table files add column if not exists cdn_rail_id   numeric(78,0);
alter table files add column if not exists provider      text;
alter table files add column if not exists synced_at     timestamptz;

create index if not exists files_data_set_idx on files (data_set_id);

comment on column files.data_set_id is
  'FWSS data set id. Required by terminateService() to execute a DROP onchain.';
comment on column files.pdp_rail_id is
  'Filecoin Pay rail settling the PDP storage charge for this data set.';
