require("dotenv").config();

const { commands } = require("../src/config");
const { registerHandlers } = require("../src/registerHandlers");
const { testConnection } = require("../src/db");
const { createBot } = require("../src/bot");

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing.");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing.");
}

// ---------------------------------------------------------------------------
// Why this file exists
// ---------------------------------------------------------------------------
// `node-telegram-bot-api`'s `processUpdate()` is synchronous — it fires
// `this.emit('message', ...)` and `reg.callback(...)` but does NOT await
// the Promises returned by async handlers. On Vercel serverless, the webhook
// would return 200 to Telegram immediately and Vercel would then kill the
// function before the handlers finished their DB queries / sendMessage calls.
//
// Fix: wrap `bot.emit` and `bot.onText` so every async listener's Promise is
// tracked in `pendingHandlers`. After `processUpdate`, the webhook awaits
// all those Promises (with a hard safety deadline) before returning 200.
// ---------------------------------------------------------------------------

let bot;
let commandsReady = false;
let databaseReady;

const pendingHandlers = new Set();

function track(promise) {
  if (!promise || typeof promise.then !== "function") return;
  pendingHandlers.add(promise);
  promise
    .catch((err) => console.error("[webhook] handler rejected:", err))
    .finally(() => pendingHandlers.delete(promise));
}

function wrapBotForAsyncTracking(botInstance) {
  // Wrap emit so async listeners get their Promises tracked.
  botInstance.emit = function emitWithTracking(event, ...args) {
    // `bot.listeners(event)` is the live array — copy it so a listener
    // removing itself during dispatch doesn't break iteration.
    const listeners = botInstance.listeners(event).slice();
    for (const listener of listeners) {
      try {
        const result = listener.apply(botInstance, args);
        track(result);
      } catch (err) {
        console.error(`[webhook] sync handler error in "${event}":`, err);
      }
    }
    return true;
  };

  // Wrap onText so async callbacks get their Promises tracked.
  const originalOnText = botInstance.onText.bind(botInstance);
  botInstance.onText = function onTextWithTracking(regexp, callback) {
    const wrapped = function (msg, match) {
      try {
        const result = callback(msg, match);
        track(result);
      } catch (err) {
        console.error("[webhook] sync handler error in onText:", err);
      }
    };
    return originalOnText(regexp, wrapped);
  };
}

function getBot() {
  if (!bot) {
    bot = createBot(process.env.BOT_TOKEN);
    wrapBotForAsyncTracking(bot);
    registerHandlers(bot);
  }
  return bot;
}

async function ensureDatabaseReady() {
  if (!databaseReady) {
    databaseReady = testConnection().catch((error) => {
      databaseReady = null;
      throw error;
    });
  }
  await databaseReady;
}

async function waitForPendingHandlers(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let pending = Array.from(pendingHandlers);
  if (pending.length === 0) return;

  while (pending.length > 0 && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, remaining)),
    ]);
    pending = Array.from(pendingHandlers);
  }

  if (pendingHandlers.size > 0) {
    console.warn(
      `[webhook] ${pendingHandlers.size} handler(s) still running at deadline — Vercel may kill them.`,
    );
  }
}

function describeSecret(secret) {
  if (!secret) return "(empty)";
  const s = String(secret);
  return `len=${s.length} prefix=${s.slice(0, 8)} suffix=${s.slice(-7)}`;
}

function getDebugParam(req) {
  if (req.query && typeof req.query.debug !== "undefined") {
    return String(req.query.debug);
  }
  try {
    const url = String(req.url || "");
    const qIndex = url.indexOf("?");
    if (qIndex >= 0) {
      const params = new URLSearchParams(url.slice(qIndex + 1));
      const v = params.get("debug");
      if (v !== null) return v;
    }
  } catch (_) {}
  return null;
}

// Hard deadline for the whole handler. Tuned for the 60s `maxDuration` set in
// vercel.json. Leaves 5s of headroom for Vercel to clean up.
const HANDLER_DEADLINE_MS = Number.parseInt(
  process.env.WEBHOOK_HANDLER_WAIT_MS || "55000",
  10,
);

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const debug = getDebugParam(req);
    if (debug === "1") {
      const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];
      return res.status(200).json({
        ok: true,
        diagnostic: true,
        expected: describeSecret(expectedSecret),
        received: describeSecret(receivedSecret),
        match: !!expectedSecret && expectedSecret === receivedSecret,
        hasExpected: !!expectedSecret,
        hasReceived: !!receivedSecret,
        hasBotToken: !!process.env.BOT_TOKEN,
        botTokenLen: String(process.env.BOT_TOKEN || "").length,
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        deployment: process.env.VERCEL_ENV || "unknown",
        region: process.env.VERCEL_REGION || "fra1",
      });
    }
    if (debug === "getme") {
      const token = process.env.BOT_TOKEN;
      if (!token) {
        return res.status(500).json({ ok: false, error: "BOT_TOKEN missing in Vercel" });
      }
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const data = await r.json();
        return res.status(200).json({ ok: true, diagnostic: "getme", status: r.status, result: data });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err?.message || err) });
      }
    }
    return res.status(200).json({ ok: true, service: "telegram-webhook" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error("[webhook] FATAL: TELEGRAM_WEBHOOK_SECRET env var is missing/empty in Vercel");
    console.error("[webhook] TELEGRAM_WEBHOOK_SECRET is missing or invalid");
    return res.status(500).json({ ok: false, error: "webhook_not_configured" });
  }

  const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];
  console.log(
    `[webhook] secret check — expected len=${String(expectedSecret).length} prefix="${String(expectedSecret).slice(0, 8)}..." received len=${String(receivedSecret || "").length} prefix="${String(receivedSecret || "").slice(0, 8)}..."`,
  );
  if (receivedSecret !== expectedSecret) {
    console.error("[webhook] 401 — secret mismatch. See prefix/length comparison above.");
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const updateId = req.body?.update_id ?? "unknown";
  const fromId = req.body?.message?.from?.id ?? req.body?.edited_message?.from?.id ?? "?";
  const textPreview = (req.body?.message?.text || "").slice(0, 40);
  console.log(
    `[webhook] update ${updateId} from ${fromId} text="${textPreview}"`,
  );
  try {
    console.log("[webhook] raw body:", JSON.stringify(req.body).slice(0, 3000));
  } catch (_) {}

  const tStart = Date.now();

  try {
    if (!commandsReady) {
      await getBot().setMyCommands(commands);
      commandsReady = true;
    }

    await ensureDatabaseReady();

    // Fire async handlers (they are tracked via the wrapped emit/onText).
    getBot().processUpdate(req.body);

    // Wait for handlers to actually finish their DB work + sendMessage.
    await waitForPendingHandlers(HANDLER_DEADLINE_MS);

    console.log(
      `[webhook] update ${updateId} done in ${Date.now() - tStart}ms`,
    );
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(
      `[webhook] update ${updateId} FAILED in ${Date.now() - tStart}ms:`,
      error,
    );
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
};
