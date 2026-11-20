$ErrorActionPreference = "Stop"

$tool = Get-Command keytool -ErrorAction SilentlyContinue
if (-not $tool) {
    throw "لم يتم العثور على keytool. ثبّت JDK 17 أو افتح PowerShell على جهاز يحتوي على JDK."
}

$path = Join-Path (Get-Location) "cashiro-release.jks"
if (Test-Path $path) {
    throw "الملف cashiro-release.jks موجود بالفعل. لن أستبدل مفتاحًا موجودًا."
}

Write-Host ""
Write-Host "سيتم إنشاء مفتاح توقيع Cashiro الدائم في:" -ForegroundColor Cyan
Write-Host $path
Write-Host "استخدم كلمة مرور قوية واحتفظ بها. لا ترسل الملف أو كلمة المرور في المحادثة."
Write-Host ""

& $tool.Source -genkeypair -v -storetype JKS -keystore $path -alias cashiro-release -keyalg RSA -keysize 2048 -validity 10000
if ($LASTEXITCODE -ne 0) {
    throw "فشل إنشاء مفتاح التوقيع. لم يتم نسخ أي قيمة إلى الحافظة."
}
if (-not (Test-Path $path) -or (Get-Item $path).Length -lt 1000) {
    throw "ملف المفتاح غير موجود أو حجمه غير متوقع."
}

$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
Set-Clipboard -Value $base64

Write-Host ""
Write-Host "تم إنشاء cashiro-release.jks ونسخ قيمة Base64 إلى الحافظة." -ForegroundColor Green
Write-Host "في GitHub أنشئ السر ANDROID_KEYSTORE_BASE64 والصق القيمة."
Write-Host "ثم أنشئ الأسرار ANDROID_KEYSTORE_PASSWORD وANDROID_KEY_ALIAS وANDROID_KEY_PASSWORD."
Write-Host "قيمة ANDROID_KEY_ALIAS هي: cashiro-release"
Write-Host "احتفظ بنسختين مشفرتين من ملف JKS وكلمات المرور خارج GitHub."
