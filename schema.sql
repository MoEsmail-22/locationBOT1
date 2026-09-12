-- Customer profiles table
-- =======================
-- This file is now OPTIONAL. The bot's health check (api/health.js ->
-- testConnection -> ensureCustomerProfilesTable) creates the table, the
-- search indexes, and the primary_phone unique index automatically.
--
-- You only need to run this file manually if you want to recreate the
-- indexes or you are repairing an old database that has a unique constraint
-- on `source_hash` (the old schema) which the bot can't drop on its own.

create table if not exists customer_profiles (
  id bigserial primary key,
  source_hash text not null,
  customer_name text,
  primary_phone text,
  duplicate_check_phone text,
  phones text[] not null default '{}',
  governorate text,
  zone text,
  area text,
  addresses text[] not null default '{}',
  notes text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One-time migration from old schema: drop the source_hash uniqueness.
-- Order matters: drop the CONSTRAINT first (which also drops its index),
-- then DROP INDEX IF EXISTS as a fallback for a standalone CREATE INDEX.
alter table customer_profiles
  drop constraint if exists customer_profiles_source_hash_key;
drop index if exists customer_profiles_source_hash_key;

-- Drop any existing primary_phone uniqueness so the dedup DELETE can run.
-- (If a unique constraint is already in place there are no duplicates and
-- this block is a no-op anyway.)
alter table customer_profiles
  drop constraint if exists customer_profiles_primary_phone_key;
drop index if exists customer_profiles_primary_phone_key;

-- Keep the first row for each duplicate primary phone, then enforce uniqueness.
-- Rows without primary_phone are not treated as duplicates.
delete from customer_profiles cp
using customer_profiles older
where cp.primary_phone is not null
  and older.primary_phone = cp.primary_phone
  and older.id < cp.id;

create unique index if not exists customer_profiles_primary_phone_key
  on customer_profiles (primary_phone);

create index if not exists customer_profiles_phones_gin_idx
  on customer_profiles using gin (phones);

create index if not exists customer_profiles_addresses_gin_idx
  on customer_profiles using gin (addresses);

create index if not exists customer_profiles_customer_name_idx
  on customer_profiles (customer_name);

create index if not exists customer_profiles_zone_idx
  on customer_profiles (zone);

create index if not exists customer_profiles_area_idx
  on customer_profiles (area);
