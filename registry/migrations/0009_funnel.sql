-- The install funnel the public stats show (stats.ts `funnel`): installs seen, activated, sharing. Counting
-- it reads every key, and the stats are read far more often, so the counts are kept here and recounted at
-- most once an hour. Counts only: no key, no network. `lease`: until when one request holds the recount,
-- so concurrent readers serve the previous body instead of each recounting.
CREATE TABLE snapshots (
  name TEXT PRIMARY KEY,
  body TEXT,
  at TEXT,
  lease TEXT
);

-- new installs per day
CREATE INDEX keys_first_seen ON keys (first_seen);

-- When the key's first ok report was accepted. Set once and never cleared: `reports` keeps only each
-- install's latest outcome per version and loses rows with a purged version, so it cannot say whether an
-- install ever made a call that worked.
ALTER TABLE keys ADD COLUMN activated_at TEXT;
-- From what is left: the earliest ok row each key still holds. `calls` has no key, so it adds nothing here.
UPDATE keys SET activated_at = (SELECT MIN(r.at) FROM reports r WHERE r.key = keys.key AND r.outcome = 'ok');
CREATE INDEX keys_activated_at ON keys (activated_at) WHERE activated_at IS NOT NULL;
