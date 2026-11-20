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
const androidStrings = read("android-app/app/src/main/res/values/strings.xml");
const accessGate = read("access-gate.js");
const androidMainActivity = read("android-app/app/src/main/java/com/supermarket/pos/MainActivity.java");

for (const file of ["app.js", "db.js", "accounts.js", "catalog.js", "sw.js", "access-gate.js"]) {
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
assert.match(gradle, /versionName '1.12.0'/, "Cashiro Android version must match this commercial candidate");
assert.match(gradle, /versionCode 16/, "Cashiro Android version code must be incremented");
assert.match(gradle, /targetSdk 36/, "Cashiro must target Android 16");
assert.match(androidStrings, /name="app_name">Cashiro/, "Android launcher name must be Cashiro");
assert.match(manifest, /android:allowBackup="false"/, "Sensitive business data must not use automatic Android backup");
assert.match(manifest, /@drawable\/cashiro_launcher/, "Cashiro app icon must be configured");
assert.match(html, /id="requestAccountDeletion"/, "Signed-in users must be able to request account deletion");
assert.match(html, /href="privacy\.html"/, "Privacy policy must be accessible in the app");
assert.match(firebase, /accountDeletionRequests/, "Account deletion requests must use the protected collection");
assert.match(rules, /match \/accountDeletionRequests\/\{uid\}/, "Account deletion requests must be protected by Firestore rules");
assert.match(firebase, /EXPLICIT_SIGNOUT_KEY/, "Explicit sign-out must clear the saved local session");
assert.ok(fs.existsSync(path.join(__dirname, "..", "privacy.html")), "Cashiro privacy policy file must exist");
assert.match(accessGate, /function isManaged\(\)\{return true;\}/, "Every installation must pass the activation gate");
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
assert.match(firebase, /تنبيه تشغيلي: السماح بالأوفلاين مع عدة أجهزة/, "Admin must be warned about multi-device offline stock overselling");
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
assert.match(firebase, /if\(\$\("employeeOwnerPanel"\)\)\$\("employeeOwnerPanel"\)\.hidden=isPlatformAdmin\|\|role!==\"owner\"\|\|localMode/, "Only shop owners may see cloud employee invitations; platform admins stay separate");
assert.match(html, /id="localLicenseFile"/, "The local license import control must exist");
assert.match(html, /id="activateLocalLicense"/, "The local license activation control must exist");
assert.match(rules, /match \/devices\//, "Firestore must protect the registered cloud devices collection");
assert.match(rules, /match \/deviceSlots\//, "Firestore must protect allocated device slots");

assert.match(rules, /match \/platformAdmins\//, "Platform administrator collection must be protected");
assert.match(rules, /match \/licenses\//, "License records must be protected by Firestore rules");
assert.match(rules, /function canWriteStore/, "Firestore must enforce role-based data writes");


assert.match(accessGate, /TRIAL_DURATION_MS=7\*24\*60\*60\*1000/, "The device trial must last exactly seven days");
assert.match(accessGate, /function startTrial\(info\)/, "A first-run installation must be able to start a local device trial");
assert.match(accessGate, /function activateTrial\(shopId,role\)/, "A trial must be attachable to a shop without granting cloud sync");
assert.match(accessGate, /trialEntitlement\.consumed===true/, "A signed license must prevent reusing the free trial");
assert.match(firebase, /setPersistence\(auth,\s*browserLocalPersistence\)/, "Firebase Auth must explicitly use local persistence");
assert.match(firebase, /signInAnonymously\(auth\)/, "An unregistered device must be able to start a trial anonymously");
assert.match(rules, /match \/trialDevices\//, "The device trial must be recorded in Firestore");
assert.match(firebase, /auth\/network-request-failed/, "Network sign-in errors must have a clear user-facing message");
assert.match(androidMainActivity, /getTrialInfo\(\)/, "Android must provide a stable device identifier and first-run clock to the WebView");
assert.match(html, /id="trialStatusBanner"/, "Trial and license status must stay visible in the app header");
assert.match(html, /class="account-connected-panel"/, "Account details must remain visible after a successful sign-in");
assert.match(rules, /match \/trialDevices\//, "Trial device records must be protected by Firestore rules");
assert.match(rules, /allow update, delete: if false;/, "A client must not reset or delete a device's trial record");
assert.doesNotMatch(rules.slice(rules.indexOf("function canReadStore"), rules.indexOf("function canWriteStore")), /isPlatformAdmin\(\)/, "Platform admins must not bypass shop data read roles");


assert.match(accessGate, /function suspendTrial\(\)/, "Trial owner access must be suspended while verifying a signed-in account");
assert.match(accessGate, /session\.active!==false&&trialCheck\(\)\.ok/, "A suspended trial must not permit local operation");
assert.match(firebase, /window\.POSGate\.suspendTrial\(\)/, "A real Firebase user must suspend anonymous trial privileges before role verification");
assert.match(firebase, /const trialRole=activeMember&&activeMember\.role\|\|"owner";\s*await ensureTrialExperience\(activeUser,true,trialRole\)/, "Offline trial must use the verified member role");
assert.match(firebase, /if\(!pendingInviteCode\)await ensureTrialExperience\(user,true,"owner"\)/, "An employee invitation must not temporarily grant owner trial access");
assert.match(html, /id="cloudRetryVerification"/, "A signed-in account must have a retry action for role verification failures");
assert.match(firebase, /cloudRetryVerification.*verifyPlatformAdmin/s, "Retry must verify the platform-admin role before routing the account");

console.log("POS integrity checks passed: syntax, HTML IDs, assets, invoice integrity, product history, employees, signed licensing, Firestore role rules and release version, seven-day trial and platform-admin separation.");
