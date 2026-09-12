require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");

const { BOT_TOKEN, WEBHOOK_URL, TELEGRAM_WEBHOOK_SECRET } = process.env;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing.");
  process.exit(1);
}

if (!WEBHOOK_URL) {
  console.error("WEBHOOK_URL is missing. Example: https://your-app.vercel.app/api/webhook");
  process.exit(1);
}

if (!/^[A-Za-z0-9_-]{1,256}$/.test(String(TELEGRAM_WEBHOOK_SECRET || ""))) {
  console.error("TELEGRAM_WEBHOOK_SECRET is missing or invalid. Use letters, numbers, _ or - only.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

bot
  .setWebHook(WEBHOOK_URL, { secret_token: TELEGRAM_WEBHOOK_SECRET })
  .then(() => {
    console.log(`Webhook set to: ${WEBHOOK_URL}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
