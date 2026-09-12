const path = require("path");
const os = require("os");
const fs = require("fs").promises;
const XLSX = require("xlsx");
const {
  countCustomerProfiles,
  findCustomerProfile,
  findCustomerProfiles,
  getAllCustomerProfiles,
  getDatabaseStatus,
  getBotAccessUser,
  listBotAccessUsers,
  removeBotAccessUser,
  upsertBotAccessUser,
  upsertCustomerProfiles,
  deleteCustomerProfilesNotInHashes,
  findBotAccessUsersByName,
  findBotAccessUserByPhone,
  getAccessRequest,
  upsertAccessRequest,
  listPendingAccessRequests,
  approveAndGrantAccess,
  rejectAccessRequest,
} = require("./db");
const { normalizePhone, parseCustomerProfilesFromExcel } = require("./excel");
const { adminIds } = require("./config");
const { formatCustomerProfile, helpText, statsText } = require("./messages");

const managementStates = new Map();

function isMainAdminId(telegramId) {
  return adminIds.has(String(telegramId));
}

async function getRole(msg) {
  const telegramId = String(msg.from?.id || "");

  if (isMainAdminId(telegramId)) {
    return "main_admin";
  }

  const accessUser = await getBotAccessUser(telegramId);
  return accessUser?.role || "none";
}

function canSearch(role) {
  return (
    role === "main_admin" ||
    role === "super_admin" ||
    role === "data-entry" ||
    role === "user"
  );
}

function canImport(role) {
  return (
    role === "main_admin" || role === "super_admin" || role === "data-entry"
  );
}

function canManage(role) {
  return role === "main_admin" || role === "super_admin";
}

function keyboardForRole(role) {
  const rows = [];

  if (canSearch(role)) {
    rows.push([{ text: "بحث" }]);
  }

  if (canImport(role)) {
    rows.push([{ text: "رفع ملف Excel" }, { text: "إحصائيات" }]);
    rows.push([{ text: "تحميل نسخة من البيانات" }]);
  }

  rows.push([{ text: "مساعدة" }, { text: "رقمي" }]);

  if (canManage(role)) {
    rows.push([{ text: "إدارة المستخدمين" }]);
  }

  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      is_persistent: true,
      one_time_keyboard: false,
      input_field_placeholder: "اكتب رقم الهاتف أو اسم العميل",
    },
  };
}

function managementKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "طلبات الصلاحية" }, { text: "إضافة" }],
        [{ text: "ترقيه" }, { text: "حذف" }],
        [{ text: "قائمة الصلاحيات" }, { text: "رجوع" }],
      ],
      resize_keyboard: true,
      is_persistent: true,
      one_time_keyboard: false,
      input_field_placeholder: "اختر إجراء إدارة المستخدمين",
    },
  };
}

function roleSelectionKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "مستخدم" }, { text: "مدخل بيانات" }, { text: "مدير" }],
        [{ text: "رجوع" }],
      ],
      resize_keyboard: true,
      is_persistent: true,
      one_time_keyboard: false,
      input_field_placeholder: "اختر الصلاحية",
    },
  };
}

function reviewRequestKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "مستخدم" }, { text: "مدخل بيانات" }, { text: "مدير" }],
        [{ text: "رفض" }, { text: "إلغاء" }],
      ],
      resize_keyboard: true,
      is_persistent: true,
      one_time_keyboard: false,
      input_field_placeholder: "اختر الصلاحية أو ارفض",
    },
  };
}

function unauthorizedKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: "طلب صلاحية", request_contact: true }]],
      resize_keyboard: true,
      is_persistent: true,
      one_time_keyboard: false,
      input_field_placeholder: "اضغط على زر طلب صلاحية",
    },
  };
}

function isTelegramId(value) {
  return /^\d{4,20}$/.test(String(value || "").trim());
}

async function requireSearchAccess(bot, msg, role) {
  if (canSearch(role)) {
    return true;
  }

  await bot.sendMessage(
    msg.chat.id,
    [
      "غير مسموح لك باستخدام البحث في هذا البوت.",
      `رقم حسابك في تيليجرام: ${msg.from?.id}`,
      "اطلب من المدير إضافتك من زر إدارة المستخدمين.",
    ].join("\n"),
    keyboardForRole(role),
  );
  return false;
}

async function requireImportAccess(bot, msg, role) {
  if (canImport(role)) {
    return true;
  }

  await bot.sendMessage(
    msg.chat.id,
    [
      "رفع ملف Excel متاح لمدخل بيانات والمدير فقط.",
      `رقم حسابك في تيليجرام: ${msg.from?.id}`,
    ].join("\n"),
    keyboardForRole(role),
  );
  return false;
}

async function requireManagementAccess(bot, msg, role) {
  if (canManage(role)) {
    return true;
  }

  await bot.sendMessage(
    msg.chat.id,
    "إدارة المستخدمين متاحة للـ main admins و المديرين فقط.",
    keyboardForRole(role),
  );
  return false;
}

async function editStatus(bot, message, text, role) {
  if (!message) return;

  try {
    await bot.editMessageText(text, {
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
  } catch (error) {
    console.error("Could not edit status message:", error.message);

    if (
      String(error.message).toLowerCase().includes("message is not modified")
    ) {
      return;
    }

    if (message.chat?.id) {
      try {
        await bot.sendMessage(message.chat.id, text, keyboardForRole(role));
      } catch (sendError) {
        console.error(
          "Failed to send fallback status message:",
          sendError.message,
        );
      }
    }
  }
}

async function sendStats(bot, chatId, role) {
  const stats = await countCustomerProfiles();
  await bot.sendMessage(chatId, statsText(stats), keyboardForRole(role));
}

// async function searchAndReply(bot, chatId, query, role) {
//   const normalizedQuery = normalizePhone(query);

//   let searchQuery = normalizedQuery;

//   if (!searchQuery) {
//     const nameWords = String(query || "")
//       .replace(/\s+/g, " ")
//       .trim()
//       .split(" ")
//       .filter(Boolean);

//     if (nameWords.length < 2) {
//       await bot.sendMessage(
//         chatId,
//         "للبحث بالاسم اكتب أول اسمين على الأقل، مثال: محمد أحمد",
//         keyboardForRole(role),
//       );
//       return;
//     }

//     searchQuery = nameWords.slice(0, 2).join(" ");
//   }

//   const profile = await findCustomerProfile(searchQuery);

//   if (!profile) {
//     await bot.sendMessage(
//       chatId,
//       "لا توجد بيانات لهذا الرقم أو الاسم.",
//       keyboardForRole(role),
//     );
//     return;
//   }

//   await bot.sendMessage(
//     chatId,
//     formatCustomerProfile(profile),
//     keyboardForRole(role),
//   );
// }

async function searchAndReply(bot, chatId, query, role) {
  const normalizedQuery = normalizePhone(query);

  let searchQuery = normalizedQuery;

  if (!searchQuery) {
    const nameWords = String(query || "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);

    if (nameWords.length < 2) {
      await bot.sendMessage(
        chatId,
        "للبحث بالاسم اكتب أول اسمين على الأقل، مثال: محمد أحمد",
        keyboardForRole(role),
      );
      return;
    }

    searchQuery = nameWords.slice(0, 2).join(" ");
  }

  console.log("[search] query:", JSON.stringify(searchQuery));
  const tSearch = Date.now();
  const profiles = await findCustomerProfiles(searchQuery);
  console.log(
    `[search] returned ${profiles.length} rows in ${Date.now() - tSearch}ms`,
  );

  if (!profiles || profiles.length === 0) {
    await bot.sendMessage(
      chatId,
      "لا توجد بيانات لهذا الرقم أو الاسم.",
      keyboardForRole(role),
    );
    return;
  }

  if (profiles.length === 1) {
    await bot.sendMessage(
      chatId,
      formatCustomerProfile(profiles[0]),
      keyboardForRole(role),
    );
    return;
  }

  const names = [
    ...new Set(profiles.map((p) => (p.customer_name || "").trim())),
  ];

  if (names.length === 1) {
    await bot.sendMessage(
      chatId,
      formatCustomerProfile(profiles[0]),
      keyboardForRole(role),
    );
    return;
  }

  const lines = profiles.map((p, i) => {
    const name = p.customer_name || "بدون اسم";
    const phones = Array.isArray(p.phones)
      ? p.phones.filter(Boolean).join(" | ")
      : "";
    const area = [p.governorate, p.zone, p.area].filter(Boolean).join(" - ");
    return [
      `${i + 1}. ${name}`,
      phones ? `الأرقام: ${phones}` : null,
      area ? `المكان: ${area}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });

  await bot.sendMessage(
    chatId,
    [
      `تم العثور على ${profiles.length} نتائج بأسماء مختلفة:`,
      "",
      lines.join("\n\n"),
    ].join("\n"),
    keyboardForRole(role),
  );
}

async function showAccessManagement(bot, msg) {
  await bot.sendMessage(
    msg.chat.id,
    [
      "إدارة المستخدمين:",
      "",
      "طلبات الصلاحية: مراجعة طلبات المستخدمين الجدد والموافقة عليهم.",
      "إضافة: اختر الصلاحية (مستخدم/مدخل بيانات/مدير) ثم أرسل Telegram ID.",
      "  • مستخدم: يستطيع البحث فقط.",
      "  • مدخل بيانات: يستطيع البحث ورفع ملفات Excel.",
      "  • مدير: كل الصلاحيات + إدارة المستخدمين (مثل main admin لكن يمكن حذفه).",
      "ترقيه: تغيير صلاحية مستخدم موجود (من مستخدم إلى مدخل بيانات أو مدير، أو العكس).",
      "حذف: تظهر قائمة بكل المستخدمين، ثم أرسل ID أو اسم للحذف.",
      "",
      "الـ main admins الموجودون في ADMIN_IDS لا يمكن حذفهم من هنا.",
    ].join("\n"),
    managementKeyboard(),
  );
}

async function sendAccessList(bot, msg) {
  const users = await listBotAccessUsers();
  const mainAdmins = [...adminIds].map((id) => `main_admin: ${id}`);
  const dbUsers = users.map((user) => {
    const name = user.display_name ? ` (${user.display_name})` : "";
    return `${user.role}: ${user.telegram_id}${name}`;
  });
  const lines = [...mainAdmins, ...dbUsers];

  await bot.sendMessage(
    msg.chat.id,
    lines.length
      ? lines.join("\n")
      : "لا توجد صلاحيات محفوظة في قاعدة البيانات.",
    managementKeyboard(),
  );
}

async function resolveBotUser(input) {
  const text = String(input || "").trim();
  if (!text) return { status: "empty" };

  if (isTelegramId(text)) {
    const user = await getBotAccessUser(text);
    if (user) return { status: "found", user };
    return { status: "not_found", source: "telegram_id" };
  }

  const normalizedPhone = normalizePhone(text);
  if (normalizedPhone) {
    const user = await findBotAccessUserByPhone(normalizedPhone);
    if (user) return { status: "found", user };
  }

  const matches = await findBotAccessUsersByName(text);
  if (matches.length === 1) return { status: "found", user: matches[0] };
  if (matches.length > 1) return { status: "multiple", users: matches };
  return { status: "not_found", source: "name" };
}

async function handleManagementState(bot, msg, text) {
  const state = managementStates.get(String(msg.from.id));
  if (!state) return false;

  if (/^(رجوع|إلغاء|الغاء)$/i.test(text)) {
    managementStates.delete(String(msg.from.id));
    const role = await getRole(msg);
    await bot.sendMessage(msg.chat.id, "تم الإلغاء.", keyboardForRole(role));
    return true;
  }

  if (state.step === "awaiting_promotion_target") {
    const resolved = await resolveBotUser(text);

    if (resolved.status === "found") {
      const user = resolved.user;
      if (isMainAdminId(user.telegram_id)) {
        await bot.sendMessage(
          msg.chat.id,
          "لا يمكن تعديل صلاحية main admin لأنه موجود في ADMIN_IDS.",
          managementKeyboard(),
        );
        managementStates.delete(String(msg.from.id));
        return true;
      }
      managementStates.set(String(msg.from.id), {
        step: "choosing_new_role",
        targetId: user.telegram_id,
        targetName: user.display_name,
        currentRole: user.role,
      });
      const roleLabels = {
        user: "مستخدم",
        "data-entry": "مدخل بيانات",
        super_admin: "مدير",
      };
      await bot.sendMessage(
        msg.chat.id,
        [
          "تغيير صلاحية:",
          "",
          `الاسم: ${user.display_name || "غير محدد"}`,
          `Telegram ID: ${user.telegram_id}`,
          `الصلاحية الحالية: ${roleLabels[user.role] || user.role}`,
          "",
          "اختر الصلاحية الجديدة:",
        ].join("\n"),
        roleSelectionKeyboard(),
      );
      return true;
    }

    if (resolved.status === "multiple") {
      managementStates.set(String(msg.from.id), {
        step: "selecting_promotion_target",
        users: resolved.users,
      });
      const list = resolved.users
        .map((u, i) => {
          const roleLabels = {
            user: "مستخدم",
            "data-entry": "مدخل بيانات",
            super_admin: "مدير",
          };
          const name = u.display_name ? ` (${u.display_name})` : "";
          return `${i + 1}. ${u.telegram_id}${name} — ${roleLabels[u.role] || u.role}`;
        })
        .join("\n");
      await bot.sendMessage(
        msg.chat.id,
        [
          "يوجد عدة مستخدمين بنفس الاسم. اختر الرقم:",
          "",
          list,
          "",
          "أرسل رقم الاختيار، أو اكتب إلغاء.",
        ].join("\n"),
        managementKeyboard(),
      );
      return true;
    }

    await bot.sendMessage(
      msg.chat.id,
      "لم يتم العثور على المستخدم. أرسل Telegram ID أو رقم هاتف أو اسم، أو اكتب إلغاء.",
      managementKeyboard(),
    );
    return true;
  }

  if (state.step === "selecting_promotion_target") {
    const match = text.match(/^\s*(\d+)\s*$/);
    if (match) {
      const index = parseInt(match[1], 10) - 1;
      if (index >= 0 && index < state.users.length) {
        const user = state.users[index];
        if (isMainAdminId(user.telegram_id)) {
          await bot.sendMessage(
            msg.chat.id,
            "لا يمكن تعديل صلاحية main admin.",
            managementKeyboard(),
          );
          managementStates.delete(String(msg.from.id));
          return true;
        }
        managementStates.set(String(msg.from.id), {
          step: "choosing_new_role",
          targetId: user.telegram_id,
          targetName: user.display_name,
          currentRole: user.role,
        });
        const roleLabels = {
          user: "مستخدم",
          "data-entry": "مدخل بيانات",
          super_admin: "مدير",
        };
        await bot.sendMessage(
          msg.chat.id,
          [
            "تغيير صلاحية:",
            "",
            `الاسم: ${user.display_name || "غير محدد"}`,
            `Telegram ID: ${user.telegram_id}`,
            `الصلاحية الحالية: ${roleLabels[user.role] || user.role}`,
            "",
            "اختر الصلاحية الجديدة:",
          ].join("\n"),
          roleSelectionKeyboard(),
        );
        return true;
      }
    }
    await bot.sendMessage(
      msg.chat.id,
      "رقم غير صحيح. أرسل رقم صحيح، أو اكتب إلغاء.",
      managementKeyboard(),
    );
    return true;
  }

  if (state.step === "choosing_new_role") {
    const { targetId, targetName, currentRole } = state;
    let newRole = null;
    let roleLabel = "";

    if (/^مستخدم$/i.test(text)) {
      newRole = "user";
      roleLabel = "مستخدم";
    } else if (/^مدخل بيانات$/i.test(text)) {
      newRole = "data-entry";
      roleLabel = "مدخل بيانات";
    } else if (/^مدير$/i.test(text)) {
      newRole = "super_admin";
      roleLabel = "مدير";
    }

    if (newRole) {
      if (newRole === currentRole) {
        await bot.sendMessage(
          msg.chat.id,
          `المستخدم لديه بالفعل صلاحية ${roleLabel}. اختر صلاحية أخرى أو اكتب إلغاء.`,
          roleSelectionKeyboard(),
        );
        return true;
      }
      await upsertBotAccessUser(targetId, newRole, msg.from.id, null);
      managementStates.delete(String(msg.from.id));
      const nameSuffix = targetName ? ` (${targetName})` : "";
      await bot.sendMessage(
        msg.chat.id,
        `تم تغيير صلاحية ${targetId}${nameSuffix} إلى ${roleLabel}.`,
        managementKeyboard(),
      );
      return true;
    }

    await bot.sendMessage(
      msg.chat.id,
      "اختر مستخدم أو مدخل بيانات أو مدير، أو اكتب إلغاء.",
      roleSelectionKeyboard(),
    );
    return true;
  }

  if (state.step === "reviewing_requests") {
    const match = text.match(/^\s*(\d+)\s*$/);
    if (match) {
      const index = parseInt(match[1], 10) - 1;
      if (index >= 0 && index < state.requests.length) {
        const request = state.requests[index];
        managementStates.set(String(msg.from.id), {
          step: "choosing_role_for_request",
          request,
        });
        await bot.sendMessage(
          msg.chat.id,
          [
            "مراجعة طلب صلاحية:",
            "",
            `الاسم: ${request.display_name || "غير محدد"}`,
            `الهاتف: ${request.phone || "غير محدد"}`,
            `Telegram ID: ${request.telegram_id}`,
            "",
            "اختر الصلاحية (مستخدم / مدخل بيانات / مدير):",
          ].join("\n"),
          reviewRequestKeyboard(),
        );
        return true;
      }
    }
    await bot.sendMessage(
      msg.chat.id,
      "رقم غير صحيح. أرسل رقم طلب صحيح، أو اكتب إلغاء.",
      managementKeyboard(),
    );
    return true;
  }

  if (state.step === "choosing_role_for_request") {
    const request = state.request;

    if (/^مستخدم$/i.test(text)) {
      const result = await approveAndGrantAccess(
        request.telegram_id,
        "user",
        msg.from.id,
      );
      managementStates.delete(String(msg.from.id));
      if (result) {
        try {
          await bot.sendMessage(
            request.telegram_id,
            "تمت الموافقة على طلبك! يمكنك الآن استخدام البوت. أرسل /start للبدء.",
          );
        } catch (e) {
          console.error("Could not notify user:", e.message);
        }
        await bot.sendMessage(
          msg.chat.id,
          `تمت الموافقة على طلب ${result.display_name || request.telegram_id} ومنحه صلاحية user.`,
          managementKeyboard(),
        );
      } else {
        await bot.sendMessage(
          msg.chat.id,
          "تعذّرت الموافقة على الطلب (ربما تمت مراجعته بالفعل).",
          managementKeyboard(),
        );
      }
      return true;
    }

    if (/^مدخل بيانات$/i.test(text)) {
      const result = await approveAndGrantAccess(
        request.telegram_id,
        "data-entry",
        msg.from.id,
      );
      managementStates.delete(String(msg.from.id));
      if (result) {
        try {
          await bot.sendMessage(
            request.telegram_id,
            "تمت الموافقة على طلبك كمدخل بيانات! يمكنك الآن استخدام البوت. أرسل /start للبدء.",
          );
        } catch (e) {
          console.error("Could not notify user:", e.message);
        }
        await bot.sendMessage(
          msg.chat.id,
          `تمت الموافقة على طلب ${result.display_name || request.telegram_id} ومنحه صلاحية مدخل بيانات.`,
          managementKeyboard(),
        );
      } else {
        await bot.sendMessage(
          msg.chat.id,
          "تعذّرت الموافقة على الطلب (ربما تمت مراجعته بالفعل).",
          managementKeyboard(),
        );
      }
      return true;
    }

    if (/^مدير$/i.test(text)) {
      const result = await approveAndGrantAccess(
        request.telegram_id,
        "super_admin",
        msg.from.id,
      );
      managementStates.delete(String(msg.from.id));
      if (result) {
        try {
          await bot.sendMessage(
            request.telegram_id,
            "تمت الموافقة على طلبك كمدير! لديك كل الصلاحيات. أرسل /start للبدء.",
          );
        } catch (e) {
          console.error("Could not notify user:", e.message);
        }
        await bot.sendMessage(
          msg.chat.id,
          `تمت الموافقة على طلب ${result.display_name || request.telegram_id} ومنحه صلاحية super_admin (مدير).`,
          managementKeyboard(),
        );
      } else {
        await bot.sendMessage(
          msg.chat.id,
          "تعذّرت الموافقة على الطلب (ربما تمت مراجعته بالفعل).",
          managementKeyboard(),
        );
      }
      return true;
    }

    if (/^رفض$/i.test(text)) {
      const result = await rejectAccessRequest(
        request.telegram_id,
        msg.from.id,
      );
      managementStates.delete(String(msg.from.id));
      if (result) {
        try {
          await bot.sendMessage(
            request.telegram_id,
            "تم رفض طلب الصلاحية. للاستفسار، تواصل مع المدير.",
          );
        } catch (e) {
          console.error("Could not notify user:", e.message);
        }
        await bot.sendMessage(
          msg.chat.id,
          `تم رفض طلب ${result.display_name || request.telegram_id}.`,
          managementKeyboard(),
        );
      } else {
        await bot.sendMessage(
          msg.chat.id,
          "تعذّر رفض الطلب (ربما تمت مراجعته بالفعل).",
          managementKeyboard(),
        );
      }
      return true;
    }

    await bot.sendMessage(
      msg.chat.id,
      "اختر مستخدم أو مدخل بيانات أو مدير، أو اكتب إلغاء.",
      reviewRequestKeyboard(),
    );
    return true;
  }

  if (state.step === "awaiting_role") {
    if (/^مستخدم$/i.test(text)) {
      managementStates.set(String(msg.from.id), { action: "add_user" });
      await bot.sendMessage(
        msg.chat.id,
        "أرسل Telegram ID للمستخدم:",
        managementKeyboard(),
      );
      return true;
    }
    if (/^مدخل بيانات$/i.test(text)) {
      managementStates.set(String(msg.from.id), { action: "add_admin" });
      await bot.sendMessage(
        msg.chat.id,
        "أرسل Telegram ID لمدخل بيانات:",
        managementKeyboard(),
      );
      return true;
    }
    if (/^مدير$/i.test(text)) {
      managementStates.set(String(msg.from.id), { action: "add_super_admin" });
      await bot.sendMessage(
        msg.chat.id,
        "أرسل Telegram ID للمدير:",
        managementKeyboard(),
      );
      return true;
    }
    await bot.sendMessage(
      msg.chat.id,
      "اختر مستخدم أو مدخل بيانات أو مدير، أو اكتب إلغاء.",
      roleSelectionKeyboard(),
    );
    return true;
  }

  if (!isTelegramId(text)) {
    await bot.sendMessage(
      msg.chat.id,
      "أرسل Telegram ID صحيحا كأرقام فقط، أو اكتب رجوع للإلغاء.",
      managementKeyboard(),
    );
    return true;
  }

  const targetId = text.trim();
  let message;

  if (state.action === "add_user") {
    await upsertBotAccessUser(targetId, "user", msg.from.id);
    message = `تمت إضافة المستخدم ${targetId} للبحث فقط.`;
  }

  if (state.action === "add_admin") {
    await upsertBotAccessUser(targetId, "data-entry", msg.from.id);
    message = `تمت إضافة مدخل بيانات ${targetId}. يستطيع البحث ورفع ملفات Excel وتحديث البيانات.`;
  }

  if (state.action === "add_super_admin") {
    await upsertBotAccessUser(targetId, "super_admin", msg.from.id);
    message = `تمت إضافة المدير ${targetId}. لديه كل الصلاحيات بما فيها إدارة المستخدمين.`;
  }

  if (state.action === "remove") {
    if (isMainAdminId(targetId)) {
      message = "لا يمكن حذف main admin من هنا لأنه موجود في ADMIN_IDS.";
    } else {
      const accessUser = await getBotAccessUser(targetId);
      if (!accessUser) {
        message = `لم يتم العثور على ${targetId} في قائمة الصلاحيات.`;
      } else {
        await removeBotAccessUser(targetId);
        const existingName = accessUser.display_name
          ? ` (${accessUser.display_name})`
          : "";
        message = `تم حذف ${accessUser.role} ${targetId}${existingName}.`;
      }
    }
  }

  managementStates.delete(String(msg.from.id));
  await bot.sendMessage(msg.chat.id, message, managementKeyboard());
  return true;
}

function valueAt(values, index) {
  return Array.isArray(values) ? values[index] || "" : "";
}

async function exportLatestData(bot, chatId, role) {
  // Cap the export so it always fits inside Vercel's function timeout
  // (60s on Hobby, 300s on Pro). Default 5000 rows is roughly a 1-3MB xlsx
  // that uploads to Telegram in a few seconds. Override with
  // EXPORT_ROW_LIMIT in env. Set to 0 to disable the limit (NOT recommended
  // on Vercel Hobby — large exports will hit the 60s cap and die mid-upload,
  // which is exactly the "stuck at جاري تجهيز ملف Excel" symptom).
  const rowLimit = Number.parseInt(process.env.EXPORT_ROW_LIMIT || "5000", 10);
  const capped = rowLimit > 0;

  console.log("[export] start — limit:", rowLimit || "unlimited");
  const t0 = Date.now();

  // Step 1: fetch from DB
  const profiles = await getAllCustomerProfiles(capped ? rowLimit : 0);
  console.log(`[export] fetched ${profiles.length} rows in ${Date.now() - t0}ms`);

  // Step 2: build xlsx in memory
  const tBuild = Date.now();
  const rows = [
    ["1", "2", "3", "0", "5", "6", "7", "8", "9", "10", "11", ""],
    [
      "الهاتف 001",
      "اسم العميل",
      "الهاتف 0012",
      "الهاتف 002",
      "الهاتف 003",
      "المحافظة",
      "Zone",
      "Area",
      "العنوان",
      "العنوان 02",
      "العنوان 03",
      "ملحوظة",
    ],
    ...profiles.map((profile) => {
      const phones = Array.isArray(profile.phones) ? profile.phones : [];
      const addresses = Array.isArray(profile.addresses)
        ? profile.addresses
        : [];
      const dupPhone = profile.duplicate_check_phone;
      const otherPhones = phones.filter((p) => p && p !== dupPhone);
      return [
        profile.primary_phone || "",
        profile.customer_name || "",
        profile.duplicate_check_phone || profile.primary_phone || "",
        valueAt(otherPhones, 0),
        valueAt(otherPhones, 1),
        profile.governorate || "",
        profile.zone || "",
        profile.area || "",
        valueAt(addresses, 0),
        valueAt(addresses, 1),
        valueAt(addresses, 2),
        profile.notes || "",
      ];
    }),
  ];
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 16 }, { wch: 28 }, { wch: 16 }, { wch: 16 }, { wch: 16 },
    { wch: 18 }, { wch: 20 }, { wch: 20 }, { wch: 70 }, { wch: 45 },
    { wch: 45 }, { wch: 30 },
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, "Data");
  const filePath = path.join(os.tmpdir(), `latest-customers-${Date.now()}.xlsx`);
  XLSX.writeFile(workbook, filePath);
  console.log(`[export] built xlsx in ${Date.now() - tBuild}ms -> ${filePath}`);

  let fileSize = 0;
  try {
    fileSize = (await fs.stat(filePath)).size;
    console.log(`[export] file size: ${fileSize} bytes`);
  } catch (e) {
    console.error("[export] could not stat file:", e.message);
  }

  const captionParts = [`تم تصدير ${profiles.length} عميل.`];
  if (capped && profiles.length === rowLimit) {
    captionParts.push(
      `⚠️ تم اقتصار التصدير على أول ${rowLimit} صف. للتصدير الكامل اضبط EXPORT_ROW_LIMIT في Vercel.`,
    );
  }

  // Step 3: upload to Telegram. This is the slow part. The TelegramBot
  // request timeout (set in src/bot.js) protects us from a stalled upload.
  try {
    const tSend = Date.now();
    await bot.sendDocument(chatId, filePath, {
      caption: captionParts.join("\n"),
      ...keyboardForRole(role),
    });
    console.log(`[export] sent document in ${Date.now() - tSend}ms`);
  } catch (err) {
    console.error(`[export] sendDocument failed after ${Date.now() - t0}ms:`, err);
    // Tell the user something useful instead of leaving them stuck.
    try {
      await bot.sendMessage(
        chatId,
        `⚠️ تعذّر إرسال الملف: ${String(err?.message || err).slice(0, 200)}`,
        keyboardForRole(role),
      );
    } catch (_) {
      // Even the error fallback failed — nothing more we can do.
    }
  } finally {
    await fs.rm(filePath, { force: true });
  }
  console.log(`[export] total: ${Date.now() - t0}ms`);
}

function registerHandlers(bot, options = {}) {
  const downloadsDir =
    options.downloadsDir || path.join(os.tmpdir(), "telegram-sales-bot");

  bot.onText(/^\/start$/, async (msg) => {
    const role = await getRole(msg);
    if (role === "none") {
      const existingRequest = await getAccessRequest(String(msg.from.id));
      let message;
      if (existingRequest?.status === "pending") {
        message = "طلبك قيد المراجعة من المدير. سيتم إعلامك عند الموافقة.";
      } else if (existingRequest?.status === "approved") {
        message = "تمت الموافقة على طلبك بالفعل. أرسل /start لتحديث القائمة.";
      } else {
        message = [
          "مرحباً! أنت غير مصرح لك باستخدام هذا البوت.",
          "",
          "اضغط على زر «طلب صلاحية» لمشاركة جهة اتصالك وإرسال طلب للمدير.",
        ].join("\n");
      }
      await bot.sendMessage(msg.chat.id, message, unauthorizedKeyboard());
      return;
    }
    await bot.sendMessage(msg.chat.id, helpText(), keyboardForRole(role));
  });

  bot.onText(/^\/help$/, async (msg) => {
    const role = await getRole(msg);
    await bot.sendMessage(msg.chat.id, helpText(), keyboardForRole(role));
  });

  bot.onText(/^\/myid$/, async (msg) => {
    const role = await getRole(msg);
    await bot.sendMessage(
      msg.chat.id,
      `رقم حسابك في تيليجرام: ${msg.from.id}`,
      keyboardForRole(role),
    );
  });

  bot.onText(/^\/ping$/, async (msg) => {
    console.log(`[ping] received from ${msg.from?.id} chat ${msg.chat?.id}`);
    try {
      await bot.sendMessage(msg.chat.id, "pong", keyboardForRole(await getRole(msg)));
      console.log(`[ping] sendMessage OK, message_id: sent`);
    } catch (err) {
      console.error(`[ping] sendMessage FAILED:`, err.message);
    }
  });

  bot.onText(/^\/whoami$/, async (msg) => {
    console.log(`[whoami] received from ${msg.from?.id}`);
    const info = [
      `from.id: ${msg.from?.id}`,
      `chat.id: ${msg.chat?.id}`,
      `chat.type: ${msg.chat?.type}`,
      `text: ${msg.text}`,
    ].join("\n");
    try {
      await bot.sendMessage(msg.chat.id, info, keyboardForRole(await getRole(msg)));
      console.log(`[whoami] sendMessage OK`);
    } catch (err) {
      console.error(`[whoami] sendMessage FAILED:`, err.message);
    }
  });

  bot.onText(/^\/dbstatus$/, async (msg) => {
    const role = await getRole(msg);
    if (!(await requireImportAccess(bot, msg, role))) return;

    try {
      const status = await getDatabaseStatus();
      const lines = [
        "حالة قاعدة البيانات:",
        `عدد الصفوف: ${status.totalRows}`,
      ];
      if (status.sample) {
        lines.push(
          `آخر صف: ${status.sample.customer_name || "بدون اسم"} — ${status.sample.primary_phone || "بدون رقم"}`,
        );
      } else {
        lines.push("⚠️ قاعدة البيانات فارغة — ارفع ملف Excel أولا.");
      }
      await bot.sendMessage(msg.chat.id, lines.join("\n"), keyboardForRole(role));
    } catch (error) {
      console.error("/dbstatus failed:", error);
      await bot.sendMessage(
        msg.chat.id,
        `فشل الاتصال بقاعدة البيانات: ${error.message}`,
        keyboardForRole(role),
      );
    }
  });

  bot.onText(/^\/search(?:\s+(.+))?$/, async (msg, match) => {
    const role = await getRole(msg);
    const chatId = msg.chat.id;
    const query = match?.[1]?.trim();

    if (!(await requireSearchAccess(bot, msg, role))) return;

    if (!query) {
      await bot.sendMessage(
        chatId,
        "اكتب /search ثم رقم الهاتف أو اسم العميل.",
        keyboardForRole(role),
      );
      return;
    }

    console.log("[handler] /search:", JSON.stringify(query));
    try {
      await searchAndReply(bot, chatId, query, role);
    } catch (error) {
      console.error("[handler] /search failed:", error);
      try {
        await bot.sendMessage(
          chatId,
          `⚠️ فشل البحث: ${String(error?.message || error).slice(0, 200)}`,
          keyboardForRole(role),
        );
      } catch (_) {}
    }
  });

  bot.onText(/^\/stats$/, async (msg) => {
    const role = await getRole(msg);
    if (!(await requireImportAccess(bot, msg, role))) return;

    try {
      await sendStats(bot, msg.chat.id, role);
    } catch (error) {
      console.error(error);
      await bot.sendMessage(
        msg.chat.id,
        "تعذر تحميل الإحصائيات. راجع سجلات السيرفر.",
        keyboardForRole(role),
      );
    }
  });

  bot.on("document", async (msg) => {
    const role = await getRole(msg);
    if (!(await requireImportAccess(bot, msg, role))) return;

    const chatId = msg.chat.id;
    const document = msg.document;
    const fileName = document.file_name || "";
    const ext = path.extname(fileName).toLowerCase();

    if (![".xlsx", ".xls", ".csv"].includes(ext)) {
      await bot.sendMessage(
        chatId,
        "من فضلك ارفع ملف Excel بصيغة .xlsx أو .xls أو .csv",
        keyboardForRole(role),
      );
      return;
    }

    await fs.mkdir(downloadsDir, { recursive: true });

    let downloadedPath;
    let statusMessage;
    try {
      statusMessage = await bot.sendMessage(
        chatId,
        "جاري تحميل الملف وقراءة البيانات...",
        keyboardForRole(role),
      );

      downloadedPath = await bot.downloadFile(document.file_id, downloadsDir);
      await editStatus(
        bot,
        statusMessage,
        "تم تحميل الملف. جاري تحليل ملف Excel...",
        role,
      );

      const profiles = parseCustomerProfilesFromExcel(downloadedPath);

      if (profiles.length === 0) {
        await editStatus(
          bot,
          statusMessage,
          "لم يتم العثور على صفوف صالحة. تأكد من وجود أعمدة الهاتف واسم العميل والعنوان.",
          role,
        );
        return;
      }

      await editStatus(
        bot,
        statusMessage,
        `تم العثور على ${profiles.length} عميل. جاري الحفظ في قاعدة البيانات...`,
        role,
      );

      await upsertCustomerProfiles(profiles);

      // Delete customers that are no longer in the new Excel file
      // This gives the "replace" behavior: new file completely replaces old data
      const sourceHashes = profiles.map((p) => p.sourceHash);
      await deleteCustomerProfilesNotInHashes(sourceHashes);

      await editStatus(
        bot,
        statusMessage,
        `تم حفظ ${profiles.length} عميل بنجاح.`,
        role,
      );
    } catch (error) {
      const errorMessage = String(error?.message || error || "Unknown error");
      console.error("Import error:", errorMessage);
      console.error(error.stack || error);

      if (statusMessage) {
        await editStatus(
          bot,
          statusMessage,
          `فشل الاستيراد: ${errorMessage}`,
          role,
        );
        return;
      }

      await bot.sendMessage(
        chatId,
        `فشل الاستيراد: ${errorMessage}`,
        keyboardForRole(role),
      );
    } finally {
      if (downloadedPath) {
        await fs.rm(downloadedPath, { force: true });
      }
    }
  });

  bot.on("contact", async (msg) => {
    const contact = msg.contact;
    if (!contact) return;

    if (String(contact.user_id) !== String(msg.from.id)) {
      await bot.sendMessage(
        msg.chat.id,
        "يمكنك فقط مشاركة جهة اتصالك الخاصة.",
        unauthorizedKeyboard(),
      );
      return;
    }

    const displayName =
      [contact.first_name, contact.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || null;
    const phone = normalizePhone(contact.phone_number);

    const { request, isNew } = await upsertAccessRequest(
      String(contact.user_id),
      phone,
      displayName,
    );

    if (isNew) {
      await bot.sendMessage(
        msg.chat.id,
        [
          "تم استلام طلبك بنجاح! ✅",
          "",
          `الاسم: ${displayName || "غير محدد"}`,
          `الهاتف: ${phone || "غير محدد"}`,
          "",
          "سيتم مراجعة طلبك من المدير. سيصلك إشعار عند الموافقة.",
        ].join("\n"),
        unauthorizedKeyboard(),
      );

      for (const adminId of adminIds) {
        try {
          await bot.sendMessage(
            adminId,
            [
              "📥 طلب صلاحية جديد:",
              "",
              `الاسم: ${displayName || "غير محدد"}`,
              `الهاتف: ${phone || "غير محدد"}`,
              `Telegram ID: ${contact.user_id}`,
              "",
              "لمراجعة الطلبات: إدارة المستخدمين ← طلبات الصلاحية",
            ].join("\n"),
          );
        } catch (e) {
          console.error(`Could not notify admin ${adminId}:`, e.message);
        }
      }
    } else if (request.status === "pending") {
      await bot.sendMessage(
        msg.chat.id,
        "طلبك قيد المراجعة بالفعل. سيتم إعلامك عند الموافقة.",
        unauthorizedKeyboard(),
      );
    } else if (request.status === "approved") {
      await bot.sendMessage(
        msg.chat.id,
        "تمت الموافقة على طلبك بالفعل. أرسل /start لتحديث القائمة.",
        keyboardForRole(await getRole(msg)),
      );
    }
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();

    if (!text || text.startsWith("/") || msg.document) return;

    try {
      const role = await getRole(msg);

      if (await handleManagementState(bot, msg, text)) return;

      const arabicSearch = text.match(/^بحث\s+(.+)$/i);
      if (arabicSearch) {
        if (!(await requireSearchAccess(bot, msg, role))) return;
        await searchAndReply(bot, chatId, arabicSearch[1].trim(), role);
        return;
      }

      if (/^(help|مساعدة)$/i.test(text)) {
        await bot.sendMessage(chatId, helpText(), keyboardForRole(role));
        return;
      }

      if (/^(myid|رقمي)$/i.test(text)) {
        await bot.sendMessage(
          chatId,
          `رقم حسابك في تيليجرام: ${msg.from.id}`,
          keyboardForRole(role),
        );
        return;
      }

      if (/^(إدارة المستخدمين|ادارة المستخدمين)$/i.test(text)) {
        if (!(await requireManagementAccess(bot, msg, role))) return;
        await showAccessManagement(bot, msg);
        return;
      }

      if (/^طلبات الصلاحية$/i.test(text)) {
        if (!(await requireManagementAccess(bot, msg, role))) return;
        const requests = await listPendingAccessRequests();
        if (requests.length === 0) {
          await bot.sendMessage(
            msg.chat.id,
            "لا توجد طلبات صلاحية معلقة.",
            managementKeyboard(),
          );
          return;
        }
        managementStates.set(String(msg.from.id), {
          step: "reviewing_requests",
          requests,
        });
        const list = requests
          .map((req, index) => {
            const name = req.display_name ? ` (${req.display_name})` : "";
            return `${index + 1}. ${req.telegram_id}${name} — ${req.phone || "بدون هاتف"}`;
          })
          .join("\n");
        await bot.sendMessage(
          msg.chat.id,
          [
            "الطلبات المعلقة:",
            "",
            list,
            "",
            "أرسل رقم الطلب لمراجعته، أو اكتب إلغاء.",
          ].join("\n"),
          managementKeyboard(),
        );
        return;
      }

      if (/^إضافة$/i.test(text)) {
        if (!(await requireManagementAccess(bot, msg, role))) return;
        managementStates.set(String(msg.from.id), { step: "awaiting_role" });
        await bot.sendMessage(
          msg.chat.id,
          "اختر الصلاحية:",
          roleSelectionKeyboard(),
        );
        return;
      }

      if (/^ترقيه$/i.test(text)) {
        if (!(await requireManagementAccess(bot, msg, role))) return;
        managementStates.set(String(msg.from.id), {
          step: "awaiting_promotion_target",
        });
        await bot.sendMessage(
          msg.chat.id,
          [
            "أرسل Telegram ID أو رقم هاتف أو اسم المستخدم الذي تريد تغيير صلاحيته:",
            "",
            "أو اكتب إلغاء للرجوع.",
          ].join("\n"),
          managementKeyboard(),
        );
        return;
      }

      if (/^حذف$/i.test(text)) {
        if (!(await requireManagementAccess(bot, msg, role))) return;
        managementStates.set(String(msg.from.id), { action: "remove" });

        const users = await listBotAccessUsers();
        const mainAdmins = [...adminIds].map(
          (id) => `main_admin: ${id} (لا يمكن حذفه)`,
        );
        const dbUsers = users.map((user) => {
          const name = user.display_name ? ` (${user.display_name})` : "";
          return `${user.role}: ${user.telegram_id}${name}`;
        });
        const lines = [...mainAdmins, ...dbUsers];

        await bot.sendMessage(
          msg.chat.id,
          [
            "قائمة الصلاحيات الحالية:",
            "",
            ...(lines.length ? lines : ["لا يوجد مستخدمون."]),
            "",
            "أرسل Telegram ID للحذف، أو اكتب إلغاء.",
          ].join("\n"),
          managementKeyboard(),
        );
        return;
      }

      if (/^قائمة الصلاحيات$/i.test(text)) {
        if (!(await requireManagementAccess(bot, msg, role))) return;
        await sendAccessList(bot, msg);
        return;
      }

      if (/^رجوع$/i.test(text)) {
        await bot.sendMessage(
          chatId,
          "تم الرجوع للقائمة الرئيسية.",
          keyboardForRole(role),
        );
        return;
      }

      if (/^(search|بحث)$/i.test(text)) {
        if (!(await requireSearchAccess(bot, msg, role))) return;
        await bot.sendMessage(
          chatId,
          "اكتب رقم الهاتف أو اسم العميل الذي تريد البحث عنه.",
          keyboardForRole(role),
        );
        return;
      }

      if (/^(stats|إحصائيات)$/i.test(text)) {
        if (!(await requireImportAccess(bot, msg, role))) return;
        await sendStats(bot, chatId, role);
        return;
      }

      if (
        /^(تحميل نسخة من البيانات|تحميل نسخه من البيانات|export)$/i.test(text)
      ) {
        if (!(await requireImportAccess(bot, msg, role))) return;
        try {
          await bot.sendMessage(
            chatId,
            "جاري تجهيز ملف Excel...",
            keyboardForRole(role),
          );
          await exportLatestData(bot, chatId, role);
        } catch (error) {
          console.error(error);
          await bot.sendMessage(
            chatId,
            "فشل تصدير البيانات. راجع سجلات السيرفر.",
            keyboardForRole(role),
          );
        }
        return;
      }

      if (/^(رفع ملف Excel|تحدتث البينات|تحدث البيانات)$/i.test(text)) {
        if (!(await requireImportAccess(bot, msg, role))) return;
        await bot.sendMessage(
          chatId,
          [
            "لتحديث البيانات، أرسل ملف Excel (.xlsx) في هذه المحادثة.",
            "",
            "سيتم قراءة الملف وحفظ بيانات العملاء في قاعدة البيانات.",
          ].join("\n"),
          keyboardForRole(role),
        );
        return;
      }

      if (!(await requireSearchAccess(bot, msg, role))) return;
      console.log("[handler] plain-text search:", JSON.stringify(text));
      try {
        await searchAndReply(bot, chatId, text, role);
      } catch (err) {
        console.error("[handler] search failed:", err);
        try {
          await bot.sendMessage(
            chatId,
            `⚠️ فشل البحث: ${String(err?.message || err).slice(0, 200)}`,
            keyboardForRole(role),
          );
        } catch (_) {}
      }
    } catch (error) {
      console.error("[handler] message handler failed:", error);
      const role = await getRole(msg).catch(() => "none");
      try {
        await bot.sendMessage(
          chatId,
          `⚠️ فشل تنفيذ الطلب: ${String(error?.message || error).slice(0, 200)}`,
          keyboardForRole(role),
        );
      } catch (_) {}
    }
  });
}

module.exports = {
  registerHandlers,
};
