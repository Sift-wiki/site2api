-- The install funnel the public stats show (stats.ts `funnel`): installs seen, activated, sharing. Counting
-- it reads every key, and the stats are read far more often, so the counts are kept here and recounted at
-- most once an hour. Counts only: no key, no network.
CREATE TABLE snapshots (
  name TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  at TEXT NOT NULL
);

-- new installs per day
CREATE INDEX keys_first_seen ON keys (first_seen);
