"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");

// Supabase URLs come in two flavors:
//   - direct:  ...db.PROJECT_REF.supabase.co:5432       (contains supabase.co)
//   - pooler :  ...pooler.supabase.com:6543             (contains supabase.com)
// Both require SSL when used from Vercel. The previous check only matched
// `supabase.co` so the recommended Transaction pooler URL (supabase.com)
// connected without SSL and could fail silently on some setups.
const databaseUrl = process.env.DATABASE_URL || "";
const isSupabase =
  databaseUrl.includes("supabase.co") ||
  databaseUrl.includes("supabase.com");

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
  // On Vercel serverless, each function invocation can be a fresh container.
  // A small idle pool avoids keeping connections open after the function ends.
  max: Number.parseInt(process.env.DB_POOL_MAX || "5", 10),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
  // Per-query timeout. If a SELECT hangs (e.g. bad connection from the
  // Supabase pooler), pg will give up after this many ms and throw. Without
  // this the webhook just sits at "جاري تجهيز ملف Excel..." forever.
  query_timeout: Number.parseInt(process.env.DB_QUERY_TIMEOUT_MS || "20000", 10),
});

function unique(values) {
  return [...new Set(values.flat().filter(Boolean))];
}

function makeHash(profile) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex");
}

async function ensureAccessTable() {
  await pool.query(`
    create table if not exists bot_access_users (
      telegram_id text primary key,
      role text not null check (role in ('user', 'data-entry', 'super_admin')),
      display_name text,
      added_by text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    alter table bot_access_users
    add column if not exists display_name text
  `);
  await pool.query(`
    alter table bot_access_users
    drop constraint if exists bot_access_users_role_check
  `);
  await pool.query(`
    alter table bot_access_users
    add constraint bot_access_users_role_check
    check (role in ('user', 'data-entry', 'super_admin'))
  `);
}

async function ensureAccessRequestsTable() {
  await pool.query(`
    create table if not exists access_requests (
      telegram_id text primary key,
      phone text,
      display_name text,
      status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
      granted_role text check (granted_role is null or granted_role in ('user', 'data-entry', 'super_admin')),
      requested_at timestamptz not null default now(),
      reviewed_by text,
      reviewed_at timestamptz
    )
  `);
  await pool.query(`
    create index if not exists access_requests_status_idx
      on access_requests (status)
  `);
}

// Auto-create the customer_profiles table on first connect. Previously this
// table was NOT created by testConnection() — only by running schema.sql
// manually in Supabase. So a freshly deployed bot would fail every search
// and every import with `relation "customer_profiles" does not exist`.
async function ensureCustomerProfilesTable() {
  await pool.query(`
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
    )
  `);

  // --- One-time migration from old schema -------------------------------
  // Older deployments had a UNIQUE constraint/index on `source_hash`.
  // The current schema uses `primary_phone` as the upsert conflict key
  // (see `upsertCustomerProfilesChunk`'s `on conflict (primary_phone)`).
  // Without this migration, `ON CONFLICT (primary_phone)` raises:
  //   "there is no unique or exclusion constraint matching the ON CONFLICT"
  //
  // Drop the constraint first (which also drops its underlying index), then
  // DROP INDEX IF EXISTS as a fallback for a standalone index. Order matters
  // because DROP INDEX on a constraint-owned index raises an ERROR, not a
  // NOTICE — `IF EXISTS` only suppresses the "doesn't exist" case.
  await pool.query(`
    alter table customer_profiles
      drop constraint if exists customer_profiles_source_hash_key
  `);
  await pool.query(`
    drop index if exists customer_profiles_source_hash_key
  `);

  // --- Ensure primary_phone uniqueness (idempotent) ---------------------
  // If the unique index is missing (fresh table OR old schema that only had
  // source_hash), we may have duplicate primary_phones. Clean them up inside
  // a transaction, then create the index. If the index already exists, this
  // whole block is a no-op.
  const { rows } = await pool.query(`
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = 'customer_profiles_primary_phone_key'
      and n.nspname = current_schema()
      and c.relkind = 'i'
    limit 1
  `);

  if (rows.length === 0) {
    const client = await pool.connect();
    try {
      await client.query("begin");

      // Belt-and-suspenders: drop any leftover constraint/index of the same
      // name (e.g. created by an older version of this code) before recreating.
      await client.query(`
        alter table customer_profiles
          drop constraint if exists customer_profiles_primary_phone_key
      `);
      await client.query(`
        drop index if exists customer_profiles_primary_phone_key
      `);

      // Keep the oldest row for each primary_phone. Rows with NULL
      // primary_phone are NOT treated as duplicates (matches schema.sql).
      await client.query(`
        delete from customer_profiles cp
        using customer_profiles older
        where cp.primary_phone is not null
          and older.primary_phone = cp.primary_phone
          and older.id < cp.id
      `);

      await client.query(`
        create unique index customer_profiles_primary_phone_key
          on customer_profiles (primary_phone)
      `);

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  // --- Search indexes --------------------------------------------------
  await pool.query(`
    create index if not exists customer_profiles_phones_gin_idx
      on customer_profiles using gin (phones)
  `);
  await pool.query(`
    create index if not exists customer_profiles_addresses_gin_idx
      on customer_profiles using gin (addresses)
  `);
  await pool.query(`
    create index if not exists customer_profiles_customer_name_idx
      on customer_profiles (customer_name)
  `);
  await pool.query(`
    create index if not exists customer_profiles_zone_idx
      on customer_profiles (zone)
  `);
  await pool.query(`
    create index if not exists customer_profiles_area_idx
      on customer_profiles (area)
  `);
}

async function testConnection() {
  await pool.query("select 1");
  await ensureAccessTable();
  await ensureAccessRequestsTable();
  await ensureCustomerProfilesTable();
}

async function upsertCustomerProfiles(profiles) {
  if (!profiles.length) return;

  const groupedProfiles = new Map();
  let nullKeyCounter = 0;

  for (const profile of profiles) {
    const key = profile.sourceHash || `__NULL__${nullKeyCounter++}`;
    const existing = groupedProfiles.get(key);

    if (!existing) {
      groupedProfiles.set(key, { ...profile });
      continue;
    }

    existing.customerName = existing.customerName || profile.customerName;
    existing.duplicateCheckPhone =
      existing.duplicateCheckPhone || profile.duplicateCheckPhone;
    existing.phones = unique([...existing.phones, ...profile.phones]);
    existing.governorate = existing.governorate || profile.governorate;
    existing.zone = existing.zone || profile.zone;
    existing.area = existing.area || profile.area;
    existing.addresses = unique([...existing.addresses, ...profile.addresses]);
    existing.notes = existing.notes || profile.notes;
    existing.rawData = { ...existing.rawData, ...profile.rawData };
    existing.sourceHash = makeHash(existing);
  }

  const normalizedProfiles = Array.from(groupedProfiles.values());
  const chunkSize = Math.max(
    1,
    Number.parseInt(process.env.DB_UPSERT_CHUNK_SIZE || "250", 10),
  );

  for (let index = 0; index < normalizedProfiles.length; index += chunkSize) {
    await upsertCustomerProfilesChunk(
      normalizedProfiles.slice(index, index + chunkSize),
    );
  }
}

async function upsertCustomerProfilesChunk(profiles) {
  const values = [];
  const placeholders = [];

  profiles.forEach((profile, index) => {
    const base = index * 11;

    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},
        $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, now())`,
    );

    values.push(
      profile.sourceHash,
      profile.customerName,
      profile.primaryPhone,
      profile.duplicateCheckPhone,
      profile.phones,
      profile.governorate,
      profile.zone,
      profile.area,
      profile.addresses,
      profile.notes,
      profile.rawData,
    );
  });

  const query = `
  insert into customer_profiles (
    source_hash,
    customer_name,
    primary_phone,
    duplicate_check_phone,
    phones,
    governorate,
    zone,
    area,
    addresses,
    notes,
    raw_data,
    updated_at
  )
  values ${placeholders.join(",")}
  on conflict (primary_phone)
  do nothing;
`;

  await pool.query(query, values);
}

async function findCustomerProfiles(query) {
  const value = query.trim();

  const result = await pool.query(
    `
      select *
      from customer_profiles
      where phones @> array[$1]::text[]
        or duplicate_check_phone = $1
        or customer_name ilike $2
      order by updated_at desc
      limit 10
    `,
    [value, `%${value}%`],
  );

  return result.rows;
}

async function findCustomerProfile(query) {
  const rows = await findCustomerProfiles(query);
  return rows[0] || null;
}

async function countCustomerProfiles() {
  const result = await pool.query(`
    select
      count(*)::int as total_customers,
      coalesce(sum(cardinality(phones)), 0)::int as total_phone_numbers,
      coalesce(sum(cardinality(addresses)), 0)::int as total_addresses
    from customer_profiles
  `);

  return result.rows[0];
}

async function getAllCustomerProfiles(limit) {
  const rowLimit = Math.max(1, Number.parseInt(limit, 10) || 0);
  const limitClause = rowLimit > 0 ? `limit ${rowLimit}` : "";
  const result = await pool.query(`
    select
      customer_name,
      primary_phone,
      duplicate_check_phone,
      phones,
      governorate,
      zone,
      area,
      addresses,
      notes,
      updated_at
    from customer_profiles
    order by updated_at desc, customer_name asc
    ${limitClause}
  `);

  return result.rows;
}

// Quick health probe used by /dbstatus. Returns total rows + sample of one
// phone so the user can verify the bot is actually connected to the right
// database. Throws if the table is missing or the query times out.
async function getDatabaseStatus() {
  const result = await pool.query(`
    select
      count(*)::int as total_rows
    from customer_profiles
  `);
  const totalRows = result.rows[0]?.total_rows ?? 0;

  let sample = null;
  if (totalRows > 0) {
    const sampleResult = await pool.query(`
      select customer_name, primary_phone
      from customer_profiles
      where primary_phone is not null
      order by id desc
      limit 1
    `);
    sample = sampleResult.rows[0] || null;
  }

  return { totalRows, sample };
}

async function getBotAccessUser(telegramId) {
  await ensureAccessTable();

  const result = await pool.query(
    `
      select telegram_id, role, display_name, added_by, created_at, updated_at
      from bot_access_users
      where telegram_id = $1
      limit 1
    `,
    [String(telegramId)],
  );

  return result.rows[0] || null;
}

async function upsertBotAccessUser(
  telegramId,
  role,
  addedBy,
  displayName = null,
) {
  await ensureAccessTable();

  const result = await pool.query(
    `
      insert into bot_access_users (telegram_id, role, display_name, added_by, updated_at)
      values ($1, $2, $3, $4, now())
      on conflict (telegram_id)
      do update set
        role = excluded.role,
        display_name = coalesce(excluded.display_name, bot_access_users.display_name),
        added_by = excluded.added_by,
        updated_at = now()
      returning telegram_id, role, display_name
    `,
    [String(telegramId), role, displayName, addedBy ? String(addedBy) : null],
  );

  return result.rows[0];
}

async function removeBotAccessUser(telegramId, role = null) {
  await ensureAccessTable();

  const result = await pool.query(
    `
      delete from bot_access_users
      where telegram_id = $1
        and ($2::text is null or role = $2)
      returning telegram_id, role
    `,
    [String(telegramId), role],
  );

  return result.rows[0] || null;
}

async function listBotAccessUsers() {
  await ensureAccessTable();

  const result = await pool.query(
    `
      select telegram_id, role, display_name, added_by, updated_at
      from bot_access_users
      order by role, telegram_id
    `,
  );

  return result.rows;
}

async function findBotAccessUsersByName(name) {
  await ensureAccessTable();
  const value = String(name || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!value) return [];

  const result = await pool.query(
    `
      select telegram_id, role, display_name, added_by, created_at, updated_at
      from bot_access_users
      where lower(trim(coalesce(display_name, ''))) = lower($1)
      order by role, telegram_id
      limit 20
    `,
    [value],
  );

  return result.rows;
}

async function findBotAccessUserByPhone(phone) {
  await ensureAccessTable();
  await ensureAccessRequestsTable();

  const result = await pool.query(
    `
      select ba.telegram_id, ba.role, ba.display_name, ba.added_by, ba.created_at, ba.updated_at
      from bot_access_users ba
      join access_requests ar on ba.telegram_id = ar.telegram_id
      where ar.phone = $1
      limit 1
    `,
    [String(phone)],
  );

  return result.rows[0] || null;
}

async function getAccessRequest(telegramId) {
  await ensureAccessRequestsTable();
  const result = await pool.query(
    `select * from access_requests where telegram_id = $1`,
    [String(telegramId)],
  );
  return result.rows[0] || null;
}

async function upsertAccessRequest(telegramId, phone, displayName) {
  await ensureAccessRequestsTable();
  const existing = await getAccessRequest(telegramId);

  if (existing && existing.status === "pending") {
    return { request: existing, isNew: false };
  }
  if (existing && existing.status === "approved") {
    return { request: existing, isNew: false };
  }

  const result = await pool.query(
    `
      insert into access_requests (telegram_id, phone, display_name, status, requested_at)
      values ($1, $2, $3, 'pending', now())
      on conflict (telegram_id)
      do update set
        phone = excluded.phone,
        display_name = excluded.display_name,
        status = 'pending',
        granted_role = null,
        reviewed_by = null,
        reviewed_at = null,
        requested_at = now()
      returning *
    `,
    [String(telegramId), phone, displayName],
  );
  return { request: result.rows[0], isNew: true };
}

async function listPendingAccessRequests() {
  await ensureAccessRequestsTable();
  const result = await pool.query(
    `
      select telegram_id, phone, display_name, requested_at
      from access_requests
      where status = 'pending'
      order by requested_at asc
    `,
  );
  return result.rows;
}

async function approveAndGrantAccess(telegramId, role, reviewedBy) {
  await ensureAccessRequestsTable();
  await ensureAccessTable();

  const client = await pool.connect();
  try {
    await client.query("begin");

    const reqResult = await client.query(
      `
        update access_requests
        set status = 'approved', granted_role = $2, reviewed_by = $3, reviewed_at = now()
        where telegram_id = $1 and status = 'pending'
        returning telegram_id, phone, display_name, granted_role
      `,
      [String(telegramId), role, String(reviewedBy)],
    );

    if (reqResult.rows.length === 0) {
      await client.query("rollback");
      return null;
    }

    const req = reqResult.rows[0];

    await client.query(
      `
        insert into bot_access_users (telegram_id, role, display_name, added_by, updated_at)
        values ($1, $2, $3, $4, now())
        on conflict (telegram_id)
        do update set
          role = excluded.role,
          display_name = coalesce(excluded.display_name, bot_access_users.display_name),
          added_by = excluded.added_by,
          updated_at = now()
      `,
      [String(telegramId), role, req.display_name, String(reviewedBy)],
    );

    await client.query("commit");
    return req;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function rejectAccessRequest(telegramId, reviewedBy) {
  await ensureAccessRequestsTable();
  const result = await pool.query(
    `
      update access_requests
      set status = 'rejected', reviewed_by = $2, reviewed_at = now()
      where telegram_id = $1 and status = 'pending'
      returning telegram_id, phone, display_name
    `,
    [String(telegramId), String(reviewedBy)],
  );
  return result.rows[0] || null;
}

async function deleteCustomerProfilesNotInHashes(sourceHashes) {
  if (!Array.isArray(sourceHashes) || sourceHashes.length === 0) {
    return 0;
  }

  const result = await pool.query(
    `
      delete from customer_profiles
      where not (source_hash = any($1::text[]))
    `,
    [sourceHashes],
  );

  return result.rowCount || 0;
}

module.exports = {
  pool,
  testConnection,
  upsertCustomerProfiles,
  findCustomerProfile,
  findCustomerProfiles,
  countCustomerProfiles,
  getAllCustomerProfiles,
  getDatabaseStatus,
  deleteCustomerProfilesNotInHashes,
  getBotAccessUser,
  upsertBotAccessUser,
  removeBotAccessUser,
  listBotAccessUsers,
  findBotAccessUsersByName,
  findBotAccessUserByPhone,
  getAccessRequest,
  upsertAccessRequest,
  listPendingAccessRequests,
  approveAndGrantAccess,
  rejectAccessRequest,
};
