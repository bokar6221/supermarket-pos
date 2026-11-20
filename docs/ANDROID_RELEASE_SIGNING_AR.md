# تجهيز APK تجاري موقّع — Cashiro

## حالة الإصدار
- اسم التطبيق: Cashiro
- نسخة التطبيق: 1.13.0
- Android: targetSdk 36 (Android 16)
- نوع التوزيع المستهدف: APK مباشر للمحلات، وليس Google Play حاليًا.
- مسار البناء: `.github/workflows/build-android-release.yml`

يستخدم الإصدار مفتاح توقيع Release دائمًا يملكه صاحب المشروع. لا يحتوي المستودع على ملف المفتاح أو كلمات مروره، ولا ينشئ Workflow مفتاحًا مؤقتًا. **لا يمكن إصدار APK تجاري قابل للتحديث قبل إعداد المفتاح والأسرار الأربعة.**

## 1. إنشاء مفتاح النشر مرة واحدة

على جهاز Windows الذي تملكه، افتح PowerShell في مجلد آمن خارج المشروع، ونفّذ:

```powershell
keytool -genkeypair -v -keystore cashiro-release.jks -alias cashiro-release -keyalg RSA -keysize 2048 -validity 10000
```

أدخل كلمة مرور قوية عند الطلب. لا ترسل كلمة المرور أو ملف المفتاح في المحادثات. احتفظ بنسختين مشفرتين من ملف `cashiro-release.jks` وكلمات المرور في مكانين آمنين. فقدان المفتاح قد يمنع إصدار تحديثات تقبلها الأجهزة التي تثبت هذه النسخة.

## 2. تحويل المفتاح إلى Base64

في PowerShell، من المجلد الذي يحتوي على الملف:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\cashiro-release.jks")) | Set-Clipboard
```

لا تحفظ قيمة Base64 داخل ملفات المشروع ولا ترسلها في المحادثة.

## 3. إضافة أسرار GitHub

افتح المستودع `bokar6221/supermarket-pos` ثم:
Settings → Secrets and variables → Actions → New repository secret

أنشئ الأسرار التالية:

| اسم السر | القيمة |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | قيمة Base64 المنسوخة من ملف JKS |
| `ANDROID_KEYSTORE_PASSWORD` | كلمة مرور ملف JKS |
| `ANDROID_KEY_ALIAS` | `cashiro-release` |
| `ANDROID_KEY_PASSWORD` | كلمة مرور المفتاح |

لا تضع هذه القيم في Issues أو ملفات Git أو داخل التطبيق.

## 4. بناء APK الموقّع

بعد إضافة الأسرار:
1. افتح Actions.
2. اختر **Build signed Android POS Release**.
3. اختر الفرع `cashiro-commercial-release-v1` ثم Run workflow.
4. انتظر نجاح اختبار Firestore Rules وبناء Release والتحقق من توقيع APK.
5. حمّل Artifact باسم `cashiro-android-release-1.13.0`.

يتحقق Workflow من:
- الحزمة `com.supermarket.pos`.
- `versionCode 17` و`versionName 1.13.0`.
- استهداف Android 16 / API 36.
- توقيع APK وملاءمة ZIP alignment.
- اختبارات قواعد Firestore واختبارات سلامة بيانات POS.

## 5. قواعد لا يجوز نسيانها

- لا تغيّر ملف JKS أو Alias بعد توزيع أول نسخة Release.
- مفتاح توقيع Android هذا مختلف عن مفتاح توقيع تراخيص Cashiro الخاص. لا تخلط بينهما.
- احتفظ بمفتاح JKS خارج GitHub وخارج APK. لا ترفعه إلى المستودع حتى لو كان خاصًا.
- النسخة Debug التي سبق تثبيتها على الهاتف تستخدم توقيع Debug مختلفًا. قبل الانتقال لأول Release، صدّر نسخة JSON وتأكد من نجاح استعادتها. قد تحتاج إلى إزالة Debug قبل تثبيت Release؛ لا تفعل ذلك قبل التأكد من النسخة الاحتياطية.
- نجاح CI لا يغني عن اختبار APK النهائي على أجهزة حقيقية: الدخول والخروج، الكاميرا، الطباعة، النسخ الاحتياطي والاستعادة، وإعادة فتح التطبيق.
- لا تعتبر طلب حذف الحساب حذفًا تلقائيًا؛ الطلب يُراجع يدويًا لحماية ملكية المحل والسجلات التجارية.
