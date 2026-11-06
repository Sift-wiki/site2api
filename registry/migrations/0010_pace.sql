-- A site's request budget (SiteContext.pace), as JSON: served with the site, bounded by the shared rules.
ALTER TABLE sites ADD COLUMN pace TEXT;
