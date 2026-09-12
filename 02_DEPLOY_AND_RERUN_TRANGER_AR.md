# 02 - طريقة الديبلوي وإعادة تشغيل السيرفر

## الهدف

بعد أي تعديل في الكود، يجب أن يحدث الآتي:

1. الكود يتعمله push إلى GitHub.
2. السيرفر يسحب آخر نسخة من GitHub.
3. السيرفر يعمل restart أو redeploy.
4. البوت يعمل من السيرفر فقط.

## المستودع على GitHub

الرابط:

```text
https://github.com/MoEsmail-22/DataAnalysisTelegramBot.git
```

## إعدادات السيرفر المطلوبة

في لوحة تحكم السيرفر `cloud.tranger.xyz` تأكد من:

```text
Repository: https://github.com/MoEsmail-22/DataAnalysisTelegramBot.git
Branch: main
Build command: npm install
Start command: npm start
```

## Environment Variables

ضع هذه القيم في Environment / Variables داخل لوحة التحكم:

```env
BOT_TOKEN=telegram_bot_token
DATABASE_URL=supabase_postgres_connection_string
ADMIN_IDS=admin_telegram_id
ALLOWED_USER_IDS=allowed_user_id_1,allowed_user_id_2
```

لا تضع علامات تنصيص حول القيم.

## بعد تحديث GitHub

ادخل إلى:

```text
https://cloud.tranger.xyz/dashboard/bots
```

ثم افتح البوت واضغط الزر الموجود عندك حسب اللوحة:

- Redeploy
- Rebuild
- Restart
- Pull latest
- Update
- Stop ثم Start

اسم الزر يختلف حسب لوحة التحكم.

## لو ضغطت rerun ولم يحدث شيء

اتبع الخطوات بهذا الترتيب:

1. افتح صفحة Logs أو Console للبوت.
2. تأكد أن السيرفر يعرض آخر commit من GitHub.
3. تأكد أن Branch هي `main`.
4. اضغط Stop.
5. انتظر 10 ثواني.
6. اضغط Start.
7. لو لم يتغير شيء، اضغط Rebuild أو Redeploy بدل Restart.
8. لو ما زال لا يعمل، احذف البوت من لوحة التحكم وأنشئه من جديد من نفس GitHub repo.

## كيف تعرف أن السيرفر اشتغل

في اللوج يجب أن ترى:

```text
Bot is running. Database connection OK.
```

إذا ظهر خطأ في قاعدة البيانات، راجع `DATABASE_URL`.

إذا ظهر خطأ من Telegram، راجع `BOT_TOKEN`.

## مهم جدا

لا تشغل البوت في مكانين في نفس الوقت.

إذا كان يعمل على السيرفر، لا تشغله على جهازك المحلي في نفس الوقت.

لو شغلته محليا والسيرفر شغال، Telegram polling قد يعمل بمشاكل.

## كيف تختبر بعد الديبلوي

1. افتح Telegram.
2. أرسل للبوت:

```text
/start
```

3. أرسل:

```text
رقمي
```

4. تأكد أن رقمك موجود في `ADMIN_IDS`.
5. ارفع ملف Excel كأدمن.
6. ابحث برقم هاتف من الملف.

مثال:

```text
بحث 01022643566
```
