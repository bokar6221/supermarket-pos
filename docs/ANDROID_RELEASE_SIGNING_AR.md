# تجهيز APK تجاري موقّع

## الحالة
تم تجهيز Gradle وGitHub Actions لبناء إصدار Release موقّع باستخدام مفتاح خاص محفوظ في GitHub Actions Secrets. لا يحتوي المستودع على ملف المفتاح أو كلمات مروره، ولا يتم توليد مفتاح مؤقت تلقائيًا.

## إنشاء مفتاح النشر مرة واحدة على جهاز المالك
باستخدام JDK 17 أو أحدث، افتح PowerShell في مجلد آمن خارج مجلد المشروع ونفّذ:

```powershell
keytool -genkeypair -v -keystore supermarket-pos-release.jks -alias supermarket-pos -keyalg RSA -keysize 2048 -validity 10000
```

احتفظ بملف `supermarket-pos-release.jks` وكلمات المرور واسم Alias في مكانين آمنين مع نسخة احتياطية مشفرة. فقدان هذا المفتاح قد يمنع تحديث التطبيق المثبت بنفس هوية التوقيع. لا تضعه في Git أو داخل APK أو في محادثة عامة.

## إضافة أسرار المستودع
من GitHub افتح:
Settings → Secrets and variables → Actions → New repository secret

أنشئ الأسرار التالية:

- `ANDROID_KEYSTORE_BASE64`: محتوى ملف JKS بعد تحويله إلى Base64.
- `ANDROID_KEYSTORE_PASSWORD`: كلمة مرور ملف JKS.
- `ANDROID_KEY_ALIAS`: في المثال أعلاه `supermarket-pos`.
- `ANDROID_KEY_PASSWORD`: كلمة مرور المفتاح.

لنسخ قيمة Base64 إلى الحافظة من PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\supermarket-pos-release.jks")) | Set-Clipboard
```

الصق القيمة في السر `ANDROID_KEYSTORE_BASE64`. لا ترسل قيمة Base64 أو كلمات المرور في المحادثات أو Issues أو ملفات المشروع.

## بناء APK
بعد حفظ الأسرار، افتح تبويب Actions وشغّل Workflow باسم **Build signed Android POS Release** باستخدام Run workflow، أو ادفع Tag يبدأ بـ `v`. عند نجاح التحقق يظهر Artifact باسم `supermarket-pos-android-release`.

يتحقق Workflow من توقيع APK واسم الحزمة ورقم الإصدار. إذا لم تكن الأسرار الأربعة موجودة، يتوقف بوضوح ولا ينتج APK تجاريًا غير موقّع.

## تنبيهات ما قبل التوزيع
- لا تغيّر ملف JKS أو Alias بعد توزيع النسخة الأولى.
- لا ترفع مفتاح التوقيع الخاص إلى المستودع حتى لو كان Private.
- احتفظ بنسخة من ملف JKS خارج جهاز التطوير.
- نجاح التوقيع والبناء لا يغني عن اختبار التثبيت والتحديث والطباعة والماسح على أجهزة حقيقية.
- الإصدار 1.10.0 الحالي ما زال يحتاج إغلاق مراجعة وظائف POS، ونشر قواعد Firebase بعد موافقة المالك، واختبارات تشغيل فعلية قبل اعتباره إصدارًا تجاريًا معتمدًا.
