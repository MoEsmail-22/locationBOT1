require("dotenv").config();

const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { commands } = require("./config");
const { pool, testConnection } = require("./db");
const { registerHandlers } = require("./registerHandlers");

const { BOT_TOKEN } = process.env;

if (!BOT_TOKEN) {
  console.error(
    "EFATAL: BOT_TOKEN is missing. Create .env and set BOT_TOKEN=...",
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(
    "EFATAL: DATABASE_URL is missing. Use the PostgreSQL connection string, not the Supabase REST URL.",
  );
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

registerHandlers(bot, {
  downloadsDir: path.join(__dirname, "..", "downloads"),
});

bot.setMyCommands(commands).catch((error) => {
  console.error("Failed to set Telegram commands:", error.message);
});

process.once("SIGINT", async () => {
  await bot.stopPolling();
  await pool.end();
  process.exit(0);
});

process.once("SIGTERM", async () => {
  await bot.stopPolling();
  await pool.end();
  process.exit(0);
});

testConnection()
  .then(() => {
    console.log("Bot is running. Database connection OK.");
    console.log("Data source: Excel file upload.");
  })
  .catch((error) => {
    console.error("Database connection failed.");
    console.error("Code:", error.code || "unknown");
    console.error("Message:", error.message || error.toString());
    if (error.detail) console.error("Detail:", error.detail);
    if (error.hint) console.error("Hint:", error.hint);
    process.exit(1);
  });
