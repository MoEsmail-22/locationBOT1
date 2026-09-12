// Centralized bot factory.
// Creates a TelegramBot wired for webhook mode with safe timeouts on every
// outgoing HTTP call to the Telegram API. Without `request.timeout` the
// library default is 0 = wait forever, which is why "تحميل نسخة من البيانات"
// can sit at "جاري تجهيز ملف Excel..." indefinitely — bot.sendDocument
// hangs on a stalled connection and Vercel eventually kills the function
// before any error is logged.
const TelegramBot = require("node-telegram-bot-api");

function createBot(token) {
  return new TelegramBot(token, {
    polling: false,
    // Per-request timeout (ms). Applies to sendMessage, sendDocument,
    // editMessageText, downloadFile, etc. If the Telegram API doesn't
    // respond within this window, the call rejects with an error.
    request: {
      timeout: Number.parseInt(process.env.TELEGRAM_REQUEST_TIMEOUT_MS || "15000", 10),
    },
  });
}

module.exports = { createBot };
