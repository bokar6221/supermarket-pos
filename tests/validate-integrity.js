"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("index.html");
const app = read("app.js");
const accounts = read("accounts.js");
const db = read("db.js");
const gradle = read("android-app/app/build.gradle");
const firebase = read("firebase-sync.js");
const rules = read("firestore.rules");
const indexes = read("firestore.indexes.json");
const manifest = read("android-app/app/src/main/AndroidManifest.xml");
const accessGate = read("access-gate.js");
const backupCrypto = read("backup-crypto.js");
const serviceWorker = read("sw.js");
const debugWorkflow = read(".github/workflows/build-android-apk.yml");
const releaseWorkflow = read(".github/workflows/build-android-release.yml");
const androidMainActivity = read("android-app/app/src/main/java/com/supermarket/pos/MainActivity.java");

for (const file of ["app.js", "db.js", "accounts.js", "catalog.js", "sw.js", "access-gate.js", "backup-crypto.js"]) {
  const source = read(file);
  // Compile without executing browser-dependent code.
  new Function(source);
}

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicates)], [], "HTML must not contain duplicate IDs");

const dynamicIds = new Set([
  "openShiftForm", "openingCash", "shiftOpenNote", "closedShiftHistory",
  "closeShiftForm", "countedCash"
]);
const referencedIds = [...(app + "\n" + accounts + "\n" + firebase).matchAll(/\$\(["']([^"']+)["']\)/g)]
  .map(match => match[1]);
const missingIds = [...new Set(referencedIds)].filter(id => !ids.includes(id) && !dynamicIds.has(id));
assert.deepEqual(missingIds, [], "Every static JavaScript DOM reference must exist in index.html");

for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
  assert.ok(fs.existsSync(path.join(__dirname, "..", match[1])), "Missing script asset: " + match[1]);
}

assert.match(db, /مجموع بنود الفاتورة لا يطابق الإجمالي قبل الخصم/, "Invoice line totals must reconcile");
assert.match(db, /seenIndexes/, "A return cannot repeat the same invoice line");
assert.match(db, /sold\.unit==="piece"&&!Number\.isInteger\(qty\)/, "Piece returns must be whole quantities");
assert.match(db, /رقم الهاتف مسجل بالفعل/, "Duplicate customer phones must be rejected");
assert.match(accounts, /savedLineTotal/, "Profit reports must use saved invoice line totals");
assert.match(gradle, /versionName '1.10.1'/, "Android version must match this release");
assert.match(gradle, /versionCode 15/, "Android version code must be incremented for this release");
assert.ok(html.includes('<script src="backup-crypto.js"></script>'), "Encrypted backup module must load before the app");
assert.ok(app.includes("POSBackupCrypto.encrypt"), "New backup exports must use authenticated encryption");
assert.ok(app.includes("POSBackupCrypto.decrypt"), "Encrypted backups must be decrypted before restore");
assert.ok(app.includes("نسخة احتياطية قديمة غير مشفرة"), "Legacy plaintext backups must require an explicit warning confirmation");
assert.ok(backupCrypto.includes("AES-256-GCM"), "Backup encryption must use AES-256-GCM");
assert.ok(backupCrypto.includes("PBKDF2-SHA-256"), "Backup keys must be derived using PBKDF2-SHA-256");
assert.ok(serviceWorker.includes("backup-crypto.js"), "Offline shell must cache the backup crypto module");
assert.ok(debugWorkflow.includes("backup-crypto.js"), "Debug APK must package the backup crypto module");
assert.ok(releaseWorkflow.includes("backup-crypto.js"), "Release APK must package the backup crypto module");
assert.ok(debugWorkflow.includes("tests/backup-crypto.test.cjs"), "Debug CI must run encryption tests");
assert.ok(releaseWorkflow.includes("tests/backup-crypto.test.cjs"), "Release CI must run encryption tests");
assert.ok(html.includes('import("./firebase-sync.js")'), "Cloud module must load dynamically after internet becomes available");
assert.ok(html.includes('window.addEventListener("online", loadCloudModule)'), "Cloud module must retry after reconnection");
assert.equal(html.includes('<script type="module" src="firebase-sync.js"></script>'), false, "Firebase module must not block cold offline startup");
assert.ok(accessGate.includes('const offlineAllowed=licenseType==="local"||(maxDevices===1&&p.offlineAllowed!==false);'), "Cloud offline mode must be restricted to a single-device license");
assert.ok(firebase.includes('offlineAllowed:type==="local"?true:(cap===1&&(!old||old.offlineAllowed!==false))'), "New cloud licenses must default to online-only when multi-device");
assert.ok(firebase.includes('if(offlineAllowed&&maxDevices>1)'), "Admin policy save must reject offline mode for multi-device cloud licenses");
assert.ok(firebase.includes("const occupiedSnapshot=await getDocs(slotCollection)"), "Device slot discovery must happen before the transaction");
assert.ok(firebase.includes("const slotSnapshot=await tx.get(selectedSlotRef)"), "The selected device slot must be rechecked inside the transaction");
assert.ok(firebase.includes("device/slot-taken"), "Concurrent device registration must retry on an occupied slot");
assert.equal(firebase.includes("for(const slot of slots)"), false, "Device registration must not read up to 500 slot documents in one transaction");
assert.match(accessGate, /يجب تفعيل البرنامج وربطه بمحل قبل الاستخدام/, "Unlinked installs must not receive an offline license");
assert.doesNotMatch(accessGate, /if\(method==="saveSettings"\)return true/, "No local business mutation may bypass initial activation");
assert.match(html, /id="licenseActivationButton"/, "Locked installs must have a visible route to activation");
assert.match(html, /accept="\*\/\*"/, "The PEM key picker must allow non-JSON files");
assert.match(androidMainActivity, /intent\.setType\("\*\/\*"/, "Android native file picker must not force JSON MIME type");


assert.match(firebase, /projectId: "supermarketpos-e448a"/, "Firebase project ID must match the registered web app");
assert.match(firebase, /firebasejs\/13\.2\.0/, "Firebase SDK version must be pinned");
assert.match(firebase, /applyCloudRecords/, "Cloud sync must use the guarded local database adapter");
assert.match(db, /async function applyCloudRecords/, "Local database must safely apply cloud changes");
assert.match(rules, /function isMember\(shopId\)/, "Firestore rules must enforce shop membership");
assert.match(rules, /allow get, list: if canReadStore\(shopId, resource\.data\.store\)/, "Cloud record reads must be restricted by employee role");
assert.match(html, /id="subtabsHost" class="subtabs-host"/, "Nested tab bar must be mounted directly below the main navigation");
assert.match(app, /function mountSubtabs\(viewName\)/, "Each main section must mount its own nested navigation");
assert.match(app, /document\.querySelectorAll\('\[data-subpanel-group=/, "Nested panels must remain connected after moving their tab bar");
assert.match(manifest, /android\.permission\.INTERNET/, "Android must have network permission");
assert.match(accessGate, /subtle\.verify/, "Offline licenses must be verified using the embedded public key");
assert.match(accessGate, /expiresAt/, "License expiry must be enforced locally");
assert.match(accessGate, /function canOperateLocally\(\)/, "Managed local operation must have a dedicated offline-policy check");
assert.match(accessGate, /offlineAllowed/, "Signed license must control offline local operation");
assert.match(accessGate, /cloudSyncEnabled/, "Signed license must control cloud sync separately");
assert.match(accessGate, /function assertMutation\(method\)/, "Local writes must still pass through the role and policy guard");
assert.match(accessGate, /setInterval\(recheckLocalLicenseExpiry,15000\)/, "An open app must re-check offline license expiry and policy");
assert.match(firebase, /async function saveShopPolicy\(/, "Platform admin must be able to save signed per-shop offline and cloud policies");
assert.match(firebase, /isCloudSyncEnabled\(\)/, "Cloud sync must respect the platform admin policy");
assert.match(firebase, /لم ننشئ محلًا تلقائيًا/, "Login must not silently create an unintended second shop");
assert.match(firebase, /async function createEmployeeInvite/, "Owner employee invitations must be implemented");
assert.match(firebase, /async function handleEmployeeRegister/, "Employees must be able to register with an invitation");
assert.match(firebase, /async function verifyPlatformAdmin/, "Project administrator authorization must be implemented");
assert.match(firebase, /function permittedSyncStores/, "Cloud sync must be scoped by employee role");
assert.match(firebase, /async function resolveSyncConflict\(/, "Managers must be able to resolve sync conflicts explicitly");
assert.match(firebase, /لا يمكن تفعيل البيع أوفلاين مع أكثر من جهاز/, "Admin must be blocked from enabling unsafe multi-device cloud offline mode");
assert.match(firebase, /اعتماد نسخة السحابة/, "Conflict UI must expose the cloud version choice");
assert.match(firebase, /اعتماد نسخة هذا الجهاز/, "Conflict UI must expose the local version choice");
assert.match(firebase, /\["owner","manager","accountant"\]\.includes\(activeMember\.role\)/, "Only authorized shop roles may resolve sync conflicts");
assert.match(html, /id="cloudConflictsPanel"/, "Cloud settings must expose a sync conflict review panel");
assert.match(firebase, /if\(role==="cashier"\)return \["products","invoices","movements","customers"\]/, "Cashiers must not download the full cash ledger");
assert.match(rules, /role == 'cashier'\s*&& store in \['products', 'invoices', 'movements', 'customers'\]/, "Cashiers must not write directly to the cash ledger");
assert.doesNotMatch(rules, /role == 'cashier'\s*&& store in \[[^\]]*'cashEntries'/, "Cashier role must not be granted direct cash ledger writes");
assert.match(firebase, /const localMode=!!\(gateSession&&gateSession\.local\)/, "Local license session must be recognized as the local shop owner");
assert.match(firebase, /window\.POSCloudRefreshAccessUI=applyRoleAccess/, "Local activation must be able to refresh role-based navigation");
assert.match(firebase, /الترخيص المحلي لا يدعم دعوات أو حسابات موظفين سحابية/, "Local license must explain why cloud employee invitations are unavailable");
assert.match(accessGate, /POSCloudRefreshAccessUI/, "Local license import must refresh the local owner UI");
assert.match(firebase, /where\("store","in",stores\)/, "Cloud queries must filter the stores permitted for the current role");
assert.match(firebase, /async function writeLicense/, "Project administrator must be able to issue and suspend licenses");
assert.match(firebase, /"7d".*7/, "Seven-day license plan must be available");
assert.match(firebase, /"3m".*3/, "Three-month license plan must be available");
assert.match(firebase, /"life".*lifetime:true/, "Lifetime license plan must be available");
assert.match(firebase, /maxDevices:cap/, "Each shop license must carry its device limit");
assert.match(firebase, /licenseType:type/, "Each shop license must distinguish local and cloud modes");
assert.match(firebase, /registerCurrentDevice/, "Cloud devices must be registered against the license limit");
assert.match(firebase, /وصل المحل إلى الحد الأقصى للأجهزة المسموح بها/, "A new cloud device must be rejected after reaching the limit");
assert.match(firebase, /unlinkShopDevice/, "Platform admin must be able to unlink a registered device");
assert.match(firebase, /platform-device-table/, "Platform admin must see devices in a structured table");
assert.match(firebase, /downloadLocalLicense/, "Platform admin must be able to export signed local licenses");
assert.match(accessGate, /localLicenseButton/, "Local license import must work independently of Firebase network modules");
assert.match(accessGate, /importLocalLicense/, "Local license activation must verify the signature on-device");
assert.match(accessGate, /licenseType==="local"/, "Local mode must initialize a local owner session without Firebase membership");
assert.match(accessGate, /isCloudLicense:/, "Cloud device registration must remain enforced when data sync is disabled");
assert.match(firebase, /const localMode=!!\(gateSession&&gateSession\.local\)/, "Local mode must be derived from the signed local access-gate session");
assert.match(firebase, /if\(\$\("employeeOwnerPanel"\)\)\$\("employeeOwnerPanel"\)\.hidden=role!==\"owner\"\|\|localMode/, "Local-only licenses must hide cloud employee invitations and management");
assert.match(html, /id="localLicenseFile"/, "The local license import control must exist");
assert.match(html, /id="activateLocalLicense"/, "The local license activation control must exist");
assert.match(rules, /match \/devices\//, "Firestore must protect the registered cloud devices collection");
assert.match(rules, /match \/deviceSlots\//, "Firestore must protect allocated device slots");

assert.match(rules, /match \/platformAdmins\//, "Platform administrator collection must be protected");
assert.match(rules, /match \/licenses\//, "License records must be protected by Firestore rules");
assert.match(rules, /function canWriteStore/, "Firestore must enforce role-based data writes");

console.log("POS integrity checks passed: syntax, HTML IDs, assets, invoice integrity, product history, employees, signed licensing, Firestore role rules and release version.");
