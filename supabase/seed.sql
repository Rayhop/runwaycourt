-- Demo inventory for RunwayCourt.
--
-- Funds the agent with 5 USDFC and gives it a spread of files that will produce
-- an interesting trial: some hot and cheap, some cold and expensive.
--
-- Safe to re-run: it truncates the demo tables first.

truncate table verdicts, court_sessions, access_events, files restart identity cascade;

insert into agent_account (id, funds, debt, last_settled_at)
values (1, 5000000000000000000, 0, now())
on conflict (id) do update
  set funds = excluded.funds,
      debt = excluded.debt,
      last_settled_at = now();

-- cost_per_epoch values are atomic USDFC (18 dec). These are demo-scale numbers
-- chosen so the account burns visibly over a few minutes, not real pricing.
insert into files (name, piece_cid, size_bytes, cost_per_epoch, tier, priority, last_accessed_at) values
  ('client-invoices-2026.zip',   'bafkzcibcd4bdomn3tgwgrh3g532zopskstnbrd2n3sxfqbmiba', 184549376,  9000000000000, 'warm', 'critical', now() - interval '2 hours'),
  ('prod-db-snapshot.sql.gz',    'bafkzcibcp5xhtgy4uwr2vzqm7k6jd3nfyi4b6ycs2hnwqrjxka', 2147483648, 42000000000000, 'warm', 'critical', now() - interval '9 hours'),
  ('brand-assets-final.tar',     'bafkzcibch7v2mwlkq3ndsxjgpzt6ye4rmhbfu5cwoi2jaxq7da', 734003200,  17000000000000, 'warm', 'normal',   now() - interval '3 days'),
  ('user-uploads-2026-q1.tar',   'bafkzcibcjq4wtnbzr6dmxvck5f7ph2ygseoial3u4qkdnwbxma', 5368709120, 88000000000000, 'warm', 'normal',   now() - interval '1 day'),
  ('old-render-cache.mp4',       'bafkzcibcm2gvxyq7lzr4jpshte6dkanwbufoi3c5m4xdqzvjka', 8589934592, 140000000000000, 'warm', 'junk',    now() - interval '19 days'),
  ('training-run-47-ckpt.bin',   'bafkzcibcr3nfwqp5tzhdok2mgxeaibvsyu4jcl7d6mrnxaqzta', 12884901888, 210000000000000, 'warm', 'archive', now() - interval '31 days'),
  ('legal-retention-2019.pdf',   'bafkzcibcs6hqwmzt4vdxpnr2ekgjaocbfy5il3u7sdmxbqnwka', 12582912,   700000000000, 'warm', 'critical', now() - interval '46 days'),
  ('marketing-site-backup.zip',  'bafkzcibct8jvxpmwq3zrdnk5haeobgcfy2il6us4tdmxarqnja', 419430400,  11000000000000, 'warm', 'archive', now() - interval '12 days'),
  ('analytics-events-raw.parquet','bafkzcibcu9kwyqnxr4asdol6ibfpchgz3jm7vt5uenybsrpokb', 3221225472, 63000000000000, 'warm', 'normal',  now() - interval '6 hours'),
  ('scratch-experiment-b.tmp',   'bafkzcibcv2lxzronys5btepm7jcgqdih4kn8wu6vfozctsqplc', 1073741824, 26000000000000, 'warm', 'junk',    now() - interval '27 days');

-- Retrieval history: hot files get many recent hits, cold files get none.
insert into access_events (file_id, occurred_at)
select f.id, now() - (random() * interval '7 days')
from files f
cross join generate_series(1, 40)
where f.name = 'client-invoices-2026.zip';

insert into access_events (file_id, occurred_at)
select f.id, now() - (random() * interval '7 days')
from files f
cross join generate_series(1, 22)
where f.name = 'analytics-events-raw.parquet';

insert into access_events (file_id, occurred_at)
select f.id, now() - (random() * interval '7 days')
from files f
cross join generate_series(1, 14)
where f.name = 'prod-db-snapshot.sql.gz';

insert into access_events (file_id, occurred_at)
select f.id, now() - (random() * interval '7 days')
from files f
cross join generate_series(1, 6)
where f.name = 'user-uploads-2026-q1.tar';

insert into access_events (file_id, occurred_at)
select f.id, now() - (random() * interval '6 days')
from files f
cross join generate_series(1, 2)
where f.name = 'brand-assets-final.tar';
