-- v4: add tool metadata columns so the public catalog API can return
--     description, display_name, href, icon, and git alongside stats.
--     Existing rows get NULL (no backfill needed; seed.js re-posts with data).
ALTER TABLE tools_stats ADD COLUMN description TEXT;
ALTER TABLE tools_stats ADD COLUMN display_name TEXT;
ALTER TABLE tools_stats ADD COLUMN href TEXT;
ALTER TABLE tools_stats ADD COLUMN icon TEXT;
ALTER TABLE tools_stats ADD COLUMN git TEXT;
