# توقيع إصدار Android التجاري بطريقة آمنة

## تنبيه أمني مهم

تم إيقاف سير العمل القديم الذي كان ينشئ ملف JKS وكلمات المرور ثم يرفعها داخل Artifact قابل للتنزيل. لا تستخدم أي مفتاح ناتج من ذلك الإجراء لتوقيع إصدار تجاري جديد؛ تعامل معه على أنه مكشوف، لأن المستودع عام وكان Artifact متاحًا خلال فترة الاحتفاظ به.

إذا كان قد تم بالفعل توزيع تطبيق تجاري موقّع بذلك المفتاح، فلا تغيّر المفتاح دون خطة ترقية؛ اختلاف شهادة التوقيع قد يمنع تحديث التطبيق المثبت. يجب أولًا تحديد ما إذا كان قد تم نشر APK فعليًا وما شهادة توقيعه.

## إنشاء مفتاح جديد خارج GitHub

1. استخدم جهازًا موثوقًا عليه JDK 17 أو أحدث.
2. أنشئ المفتاح في مجلد آمن خارج مجلد المشروع:

```powershell
keytool -genkeypair -v -keystore supermarket-pos-release.jks -alias supermarket-pos -keyalg RSA -keysize 2048 -validity 10000
```

3. احتفظ بملف JKS وكلمات المرور واسم Alias في نسخة احتياطية مشفرة خارج GitHub.
4. حوّل ملف JKS إلى Base64 في PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\\supermarket-pos-release.jks")) | Set-Clipboard
```

5. افتح GitHub: **Settings → Secrets and variables → Actions**، ثم أضف الأسرار التالية:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

لا تضع ملف JKS أو كلمات المرور أو قيمة Base64 في المستودع أو Artifacts أو Issues أو Pull Requests أو المحادثات.

## بناء الإصدار

بعد إضافة الأسرار، استخدم Workflow **Build signed Android POS Release**. يتوقف البناء إذا كان أي سر مطلوبًا مفقودًا. يجب التحقق من توقيع APK وتثبيته وتحديثه على جهاز اختبار قبل التوزيع.

راجع أيضًا `docs/ANDROID_RELEASE_SIGNING_AR.md` للتفاصيل.

## سياسة الاحتفاظ بالمفتاح

- لا تنشئ مفتاحًا جديدًا لكل إصدار.
- احتفظ بنسختين احتياطيتين مشفرتين في مكانين آمنين.
- لا تنشر مفتاح التوقيع الخاص حتى لو كان المستودع Private.
- نجاح التوقيع لا يعني أن التطبيق اجتاز الاختبار الميداني أو أصبح معتمدًا تجاريًا.
