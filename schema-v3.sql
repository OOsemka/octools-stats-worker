-- v3: add category to tools_stats so the public catalog API can return it
ALTER TABLE tools_stats ADD COLUMN category TEXT;
