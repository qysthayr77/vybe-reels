# Vybe Reels — تشغيل مجاني على GitHub Actions

يسحب ريلز (YouTube Shorts / TikTok) كل 30 دقيقة، يكتبها في Firebase، وينظّف القديم.
الواجهة (`vybe-auth.html`) تُنشر مجاناً على GitHub Pages.

## كيف يعمل "24 ساعة"؟
GitHub Actions **لا يشغّل سيرفر ثابت** (أي job ينتهي خلال 6 ساعات كحد أقصى، وتشغيل سيرفر دائم مخالف للشروط).
البديل الصحيح: workflow مجدول يشغّل `node server.js --once` كل 30 دقيقة، وهذا يعطي نفس النتيجة
لأن التطبيق يقرأ من Firebase مباشرة وليس من السيرفر.

## الخطوات

1. أنشئ مستودع **Public** جديد على GitHub (الـ Public = دقائق Actions مجانية بلا حد).
   > الأسرار لا تُكتب بالكود، فلا خطر من كونه عاماً.
2. ارفع محتويات هذا المجلد (بدون `serviceAccount.json` و`.env` — الـ `.gitignore` يمنعهما).
3. من **Settings → Secrets and variables → Actions → New repository secret** أضف:

   | الاسم | القيمة |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT_JSON` | محتوى ملف serviceAccount.json كامل (الصقه كما هو) |
   | `FIREBASE_STORAGE_BUCKET` | `vybe-iq.firebasestorage.app` |
   | `APIFY_TOKEN` | توكن Apify (اختياري، لتيك توك) |
   | `YTDLP_COOKIES_TXT` | كوكيز يوتيوب بصيغة Netscape (اختياري، انظر الملاحظة أدناه) |

4. (اختياري) من تبويب **Variables** أضف: `ENABLE_TIKTOK_APIFY=true`، `IRAQ_CHANNELS=@a,@b`، `IRAQ_TIKTOK_USERS=@x`، `PER_TAG`، `MAX_REELS`، `KEEP_DAYS`.
5. تبويب **Actions** → فعّل الـ workflows → شغّل **Vybe Reels Collector** يدوياً (Run workflow) للتجربة.
6. للواجهة: **Settings → Pages → Source: GitHub Actions**، ثم شغّل **Deploy web app**.

## ملاحظات مهمة

- **يوتيوب قد يحجب IP الخاص بـ GitHub** (رسالة "Sign in to confirm you're not a bot"). الحل: ضع كوكيز في `YTDLP_COOKIES_TXT`.
  استخدم حساب ثانوي وليس حسابك الأساسي.
- GitHub يوقف الـ workflows المجدولة تلقائياً بعد **60 يوم بدون أي نشاط** في المستودع؛ اعمل أي commit صغير أو فعّلها يدوياً.
- الجدولة ليست دقيقة؛ قد تتأخر الدورة 5–15 دقيقة وقت الضغط.
- Apify ليس مجانياً بلا حدود (رصيد شهري محدود)؛ إن نفد، أوقف `ENABLE_TIKTOK_APIFY`.

## 🔐 أمنياً (مهم)
المفاتيح التالية كانت داخل الملف الذي رفعته، فاعتبرها مكشوفة وجدّدها:
- توكن Apify (كان مكتوباً داخل `server.js`) → ولّد توكن جديد من لوحة Apify.
- مفتاح حساب الخدمة في Firebase → Project settings → Service accounts → Generate new private key، ثم احذف المفتاح القديم.
- لا تضع `ADMIN_KEY` أو أي سر داخل الكود أبداً.
