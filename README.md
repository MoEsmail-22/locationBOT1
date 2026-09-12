# Telegram Arabic Customer Data Bot

Telegram bot that lets admins upload customer data from an Excel file into Supabase/PostgreSQL and allows searching customer delivery information by phone number or name.

## What It Stores

Each customer can have:

- Arabic customer name
- Up to 3 phone numbers
- Governorate
- Zone
- Area
- Up to 3 addresses
- Notes
- Full original row stored in `raw_data`

The bot replies in Arabic.

## Environment

Create `.env` locally, or add these environment variables in your hosting dashboard:

```env
BOT_TOKEN=your_new_bot_token
DATABASE_URL=your_supabase_postgres_connection_string
ADMIN_IDS=123456789,987654321
TELEGRAM_WEBHOOK_SECRET=use_a_random_private_value_here

# Optional tuning
DB_UPSERT_CHUNK_SIZE=250
STORE_RAW_DATA=false
```

`ADMIN_IDS` is a comma-separated list of Telegram user IDs. Admins can upload Excel files and view stats. Normal users can search only.

## Install

```bash
npm install
```

## Database

Run `schema.sql` in Supabase SQL Editor before starting the bot.

## Start Locally

```bash
npm start
```

## Bot Commands

- `/start` - فتح القائمة
- `/help` - عرض المساعدة
- `/myid` - إظهار رقم حسابك
- `/search phone_or_name` - بحث برقم الهاتف أو الاسم
- `/stats` - إحصائيات البيانات

The bot also shows Arabic shortcut buttons:

- بحث
- رفع ملف Excel
- إحصائيات
- مساعدة
- رقمي

## Excel File Upload

Admins upload customer data by sending an `.xlsx` file directly in the Telegram chat. The bot downloads the file, parses the rows, and saves them to the database.

### Excel Column Format

Your Excel file must have these columns (can be in any order, headers can be on row 1 or 2):

- `الهاتف 001` - main phone number (primary key for updates)
- `اسم العميل` - customer name
- `الهاتف 0012` - duplicate-check phone
- `الهاتف 002` - second phone
- `الهاتف 003` - third phone
- `المحافظة` - governorate
- `Zone` - zone
- `Area` - area
- `العنوان` - first address
- `العنوان 02` - second address
- `العنوان 03` - third address
- `ملحوظة` - notes

### How Upload Works

1. Admin taps **رفع ملف Excel** or just sends a `.xlsx` file directly
2. Bot downloads the file and parses all rows
3. Data is normalized (Egyptian phone format `01xxxxxxxxx`, Arabic digit conversion)
4. Database is updated using the primary phone number (`الهاتف 001`) as the key
5. Bot replies with the count of saved customers
6. The downloaded file is deleted from the server after processing

## Deployment

### Vercel webhook deployment

This bot can run on Vercel without polling. Add `BOT_TOKEN`, `DATABASE_URL`, `ADMIN_IDS`, and `TELEGRAM_WEBHOOK_SECRET` as Production environment variables. Deploy the project, then set `WEBHOOK_URL` locally to `https://your-domain.vercel.app/api/webhook` and run `npm run set-webhook`.

Use `GET /api/health` to confirm that the Vercel deployment can reach the database. Do not run `npm start` at the same time as the Vercel webhook, otherwise Telegram will report a conflict.

## Troubleshooting

- "لم يتم العثور على صفوف صالحة": check the header row in your Excel file — the bot expects the columns listed above (aliases are flexible but must match one of the known headers).
- `ETELEGRAM: 409 Conflict`: indicates another bot instance is running (or webhook/polling conflict). Stop other node processes or disable the webhook before starting the bot locally.
- Phone numbers not matching: ensure phones are in the `الهاتف 001` column. Egyptian numbers are auto-normalized (`+20...`, `20...`, `1xxxxxxxxx` all become `01xxxxxxxxx`).

## Webhook / database notes (important)

- The webhook in `api/webhook.js` wraps `bot.emit` and `bot.onText` so the
  Promises returned by async handlers are tracked. The handler then awaits
  all those Promises (with a safety timeout) before returning `200` to
  Telegram. Without this, Vercel would kill the function before the DB
  queries / `sendMessage` calls finish — the symptom is "webhook returns
  200 but the bot doesn't actually reply and DB never gets called".
- `customer_profiles` is auto-created by `testConnection()` (same as the
  access tables). You no longer have to run `schema.sql` manually — but it is
  still safe to run it to recreate the indexes.
- SSL is enabled automatically when `DATABASE_URL` contains `supabase.co`
  (direct connection) **or** `supabase.com` (Transaction pooler). Use the
  Transaction pooler URL on port 6543 for Vercel.
- `vercel.json` sets `maxDuration: 60` for `api/webhook.js` so Excel imports
  have room to complete. Vercel Hobby caps at 60s; if you upload very large
  Excel files, upgrade to Pro for a longer limit.

## Security Notes

- Keep your `BOT_TOKEN` and `DATABASE_URL` secret. Do not commit `.env` to version control.
- The `ADMIN_IDS` list controls who has admin access. Only main admins can manage users.
