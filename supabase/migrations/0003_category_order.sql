-- Persist the order of variant categories.
--
-- `categories` is jsonb, and jsonb does not preserve object key order — it
-- normalizes keys (by length, then bytewise). The app derives the Variants
-- panel's display order from key order, so dragging a category into place
-- looked like it saved but came back re-sorted on the next load.
--
-- Order is real user intent, so it gets its own column rather than riding on
-- a serialization side effect. A jsonb ARRAY is safe here: only object keys
-- are reordered, array element order is preserved.
alter table public.resumes
  add column if not exists category_order jsonb not null default '[]'::jsonb;
