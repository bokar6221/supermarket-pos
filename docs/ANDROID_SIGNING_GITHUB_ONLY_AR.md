# إنشاء مفتاح توقيع Android من GitHub فقط

هذا الإجراء لا يحتاج تثبيت Java أو Android Studio على جهازك.

## إنشاء المفتاح مرة واحدة
1. افتح تبويب **Actions** في مستودع المشروع.
2. اختر **Generate Android release signing key (one time)**.
3. اضغط **Run workflow** ثم **Run workflow** مرة أخرى.
4. افتح العملية بعد اكتمالها، ثم نزّل الـ Artifact باسم `supermarket-pos-signing-package`.
5. افتح الملف المضغوط باستخدام مستخرج Windows، ثم افتح `github-secrets.txt` ببرنامج Notepad.

## حفظ القيم في GitHub
من **Settings → Secrets and variables → Actions → New repository secret** أضف أربعة أسرار، كل واحد على حدة، بالاسم والقيمة المطابقين لما في الملف:
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

لا ترسل هذه القيم في محادثة أو Issue أو Pull Request، ولا تضعها في ملفات المشروع.

## حماية المفتاح
- هذا إجراء لمرة واحدة فقط. لا تعِد تشغيله بعد إصدار النسخة التجارية؛ المفتاح الجديد لن يوقّع تحديثات متوافقة مع النسخة السابقة.
- ملف الـ Artifact يتضمن المفتاح وكلمات المرور، ويمكن لأعضاء المستودع الذين لديهم صلاحية قراءة تنزيله خلال فترة صلاحيته. لذلك احتفظ به في مكان آمن، وبعد إضافة الأسرار إلى GitHub احذف الـ Artifact من صفحة العملية.
- احتفظ بنسخة احتياطية آمنة من ملف `supermarket-pos-release.jks` وكلمات مروره. فقدان المفتاح يعني تعذّر توقيع تحديث متوافق مع النسخة المنشورة.
- يحتفظ GitHub بالـ Artifact ليوم واحد فقط تلقائيًا.

بعد حفظ الأسرار، شغّل سير عمل **Build signed Android POS Release** لإنتاج APK الموقّع.
