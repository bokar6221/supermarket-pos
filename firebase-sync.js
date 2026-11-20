import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  signInAnonymously,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  documentId,
  startAfter,
  limit,
  writeBatch,
  runTransaction,
  setDoc,
  serverTimestamp,
  Timestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

"use strict";

const firebaseConfig = {
  apiKey: "AIzaSyCPepE0egoHlInv4kydpdkBNcEAxcYaN-Q",
  authDomain: "supermarketpos-e448a.firebaseapp.com",
  projectId: "supermarketpos-e448a",
  storageBucket: "supermarketpos-e448a.firebasestorage.app",
  messagingSenderId: "858036866627",
  appId: "1:858036866627:web:177d899a852ff9a28d0ef6"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const authPersistenceReady = setPersistence(auth, browserLocalPersistence).catch(error => {
  console.warn("Firebase local auth persistence could not be initialized", error);
  return false;
});
const cloudDb = getFirestore(app);
const PAGE_SIZE = 250;
const SYNC_STORES = [
  "products", "invoices", "movements", "suppliers", "purchases",
  "supplierPayments", "stocktakes", "customers", "customerPayments",
  "returns", "cashEntries", "shifts", "settings"
];
const STATE_KEY = "supermarket-pos-cloud-sync-v1";
const DEVICE_KEY = "supermarket-pos-device-id-v1";
function permittedSyncStores(){
  const role=activeMember&&activeMember.role;
  if(role==="owner")return SYNC_STORES.slice();
  if(role==="manager")return SYNC_STORES.filter(store=>store!=="settings");
  if(role==="accountant")return [
    "products","invoices","movements","suppliers","purchases","supplierPayments",
    "stocktakes","customers","customerPayments","returns","cashEntries","shifts"
  ];
  if(role==="cashier")return ["products","invoices","movements","customers"];
  return [];
}
const $ = id => document.getElementById(id);
let activeUser = null;
let activeShopId = "";
let activeShopName = "";
let activeMember = null;
let isPlatformAdmin = false;
let licensePrivateKeyPem = "";
let stopMemberListener = null;
let stopLicenseListener = null;
let platformShops = [];
let syncBusy = false;
let syncTimer = null;
let suppressSync = false;
let stopRecordsListener = null;
let remoteChain = Promise.resolve();
let trialBootstrapPromise = null;
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const TRIAL_DEVICE_KEY = "supermarket-pos-trial-device-info-v2";
const LAST_REAL_UID_KEY = "supermarket-pos-last-real-auth-uid-v1";
const EXPLICIT_SIGNOUT_KEY = "supermarket-pos-explicit-signout-v1";

function randomId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return "d-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
function readState() {
  try {
    const value = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch (_) {
    return null;
  }
}
function writeState(state) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
}
async function digest(value) {
  if (!window.crypto || !window.crypto.subtle) throw new Error("يلزم تشغيل التطبيق من اتصال آمن HTTPS لإتمام المزامنة.");
  const bytes = new TextEncoder().encode(stable(value));
  const hash = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function rounded(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}
function docKey(store, id) {
  return store + "--" + encodeURIComponent(String(id));
}
function cleanValue(value) {
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value && typeof value === "object") {
    const output = {};
    Object.keys(value).forEach(key => {
      if (value[key] !== undefined) output[key] = cleanValue(value[key]);
    });
    return output;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}
function setStatus(message, kind) {
  const node = $("cloudSyncStatus");
  if (!node) return;
  node.textContent = message;
  node.dataset.state = kind || "info";
}
function setBusy(busy) {
  ["cloudRegister", "cloudLogin", "cloudCreateShop", "cloudSyncNow", "cloudSignOut", "cloudRetryVerification"].forEach(id => {
    const node = $(id);
    if (node) node.disabled = !!busy;
  });
}
function showSignedIn(user, shopName) {
  const signedIn = !!(user && !user.isAnonymous);
  activeUser = signedIn ? user : null;
  if ($("cloudAuthPanel")) $("cloudAuthPanel").hidden = signedIn;
  if ($("cloudConnectedPanel")) $("cloudConnectedPanel").hidden = !signedIn;
  if ($("cloudCreateShop")) $("cloudCreateShop").hidden = !(signedIn && !shopName && !isPlatformAdmin);
  if ($("cloudAccountEmail")) $("cloudAccountEmail").textContent = signedIn ? (user.email || "حساب Firebase") : "";
  if ($("cloudConnectedShop")) $("cloudConnectedShop").textContent = shopName || (signedIn ? "لم يتم ربط محل بهذا الحساب بعد" : "");
  if ($("cloudSyncNow")) $("cloudSyncNow").hidden = !(signedIn && !!shopName && !isPlatformAdmin);
  if ($("cloudSignOut")) $("cloudSignOut").hidden = !signedIn;
  if ($("cloudRetryVerification")) $("cloudRetryVerification").hidden = true;
  if ($("shopTitle") && signedIn && shopName) $("shopTitle").textContent = shopName;
}
function firebaseError(error) {
  const code = String(error && error.code || "");
  const messages = {
    "auth/email-already-in-use": "البريد الإلكتروني مستخدم بالفعل. اختر تسجيل الدخول.",
    "auth/invalid-email": "صيغة البريد الإلكتروني غير صحيحة.",
    "auth/weak-password": "كلمة المرور ضعيفة؛ استخدم 6 أحرف على الأقل.",
    "auth/invalid-credential": "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
    "auth/user-disabled": "تم تعطيل هذا الحساب.",
    "auth/too-many-requests": "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.",
    "auth/network-request-failed": "تعذر الوصول إلى خادم تسجيل الدخول. لم يتم حذف الحساب أو الترخيص؛ تحقق من اتصال التطبيق ثم اضغط تسجيل الدخول مرة أخرى.",
    "auth/user-not-found": "لا يوجد حساب بهذا البريد الإلكتروني. راجع البريد أو أنشئ حسابًا جديدًا.",
    "auth/wrong-password": "كلمة المرور غير صحيحة.",
    "permission-denied": "رفضت قواعد Firestore العملية. تأكد من نشر قواعد الحماية المرفقة.",
    "unavailable": "خدمة Firebase غير متاحة حاليًا. سيظل البيع المحلي يعمل.",
    "failed-precondition": "قاعدة Firestore غير جاهزة أو تحتاج إلى إعداد في لوحة Firebase."
  };
  return messages[code] || (error && error.message) || "حدث خطأ غير معروف أثناء الاتصال.";
}
function shopRef(shopId) {
  return doc(cloudDb, "shops", shopId);
}
function memberRef(shopId, uid) {
  return doc(cloudDb, "shops", shopId, "members", uid);
}
function recordsRef(shopId) {
  return collection(cloudDb, "shops", shopId, "records");
}
function userRef(uid) {
  return doc(cloudDb, "users", uid);
}
function readTrialDeviceInfo() {
  try {
    if (window.AndroidScanner && typeof window.AndroidScanner.getTrialInfo === "function") {
      const nativeInfo = JSON.parse(window.AndroidScanner.getTrialInfo() || "{}");
      if (nativeInfo.deviceId && Number(nativeInfo.firstRunAt) > 0) {
        return {
          deviceId: String(nativeInfo.deviceId),
          firstRunAt: Number(nativeInfo.firstRunAt),
          effectiveNow: Number(nativeInfo.effectiveNow) || Date.now()
        };
      }
    }
  } catch (error) {
    console.warn("Native trial metadata is unavailable; using browser storage", error);
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(TRIAL_DEVICE_KEY) || "null"); } catch (_) {}
  if (saved && saved.deviceId && Number(saved.firstRunAt) > 0) return saved;
  const now = Date.now();
  const info = { deviceId: "web-" + randomId(), firstRunAt: now, effectiveNow: now };
  try { localStorage.setItem(TRIAL_DEVICE_KEY, JSON.stringify(info)); } catch (_) {}
  return info;
}
async function claimServerTrialStart(user, info) {
  if (!user || !navigator.onLine || !info || !info.deviceId) return null;
  const ref = doc(cloudDb, "trialDevices", info.deviceId);
  let snapshot = await getDoc(ref);
  if (!snapshot.exists()) {
    try {
      await setDoc(ref, { deviceId: info.deviceId, uid: user.uid, createdAt: serverTimestamp() });
    } catch (error) {
      // An existing device claim is immutable; read it after a create race.
      if (!error || !["permission-denied", "already-exists"].includes(String(error.code || ""))) throw error;
    }
    snapshot = await getDoc(ref);
  }
  if (!snapshot.exists()) throw new Error("تعذر تثبيت تاريخ التجربة على الخادم.");
  const createdAt = snapshot.data().createdAt;
  const millis = createdAt && typeof createdAt.toMillis === "function" ? createdAt.toMillis() : 0;
  return millis > 0 ? millis : null;
}
function trialMessage() {
  const check = window.POSGate && window.POSGate.trialStatus ? window.POSGate.trialStatus() : null;
  if (!check || !check.ok) return check && check.reason || "التجربة المجانية غير متاحة.";
  const hours = Math.max(1, Math.ceil(check.remainingMs / 3600000));
  const days = Math.floor(hours / 24), rest = hours % 24;
  return days > 0 ? "التجربة المجانية سارية — متبقي " + days + " يوم و" + rest + " ساعة." : "التجربة المجانية سارية — متبقي " + hours + " ساعة.";
}
async function ensureTrialExperience(user, forceForUnlicensedShop = false, trialRole = "owner") {
  if (trialBootstrapPromise) return trialBootstrapPromise;
  trialBootstrapPromise = (async () => {
    await authPersistenceReady;
    const existing = window.POSGate && window.POSGate.getSession ? window.POSGate.getSession() : null;
    if (existing && existing.uid && !existing.trial && !forceForUnlicensedShop) return false;

    const info = readTrialDeviceInfo();
    let serverStart = null;
    let trialUser = user || auth.currentUser || null;
    if (!trialUser && navigator.onLine && !localStorage.getItem(LAST_REAL_UID_KEY)) {
      try {
        const anonymousCredential = await signInAnonymously(auth);
        trialUser = anonymousCredential.user;
      } catch (error) {
        // Offline or disabled Anonymous provider: use the native first-run clock.
        console.warn("Anonymous Firebase sign-in unavailable; starting local trial", error);
      }
    }
    if (navigator.onLine && trialUser) {
      try { serverStart = await claimServerTrialStart(trialUser, info); }
      catch (error) { console.warn("Server trial registration failed; retaining the local first-run date", error); }
    }
    const startedAt = serverStart ? Math.min(info.firstRunAt, serverStart) : info.firstRunAt;
    const check = window.POSGate.startTrial({
      deviceId: info.deviceId,
      startedAt,
      effectiveNow: info.effectiveNow,
      serverVerified: !!serverStart,
      role: trialRole
    });
    const banner = $("trialStatusBanner");
    if (banner) {
      banner.hidden = false;
      banner.textContent = trialMessage();
      banner.dataset.state = check.ok ? "warning" : "error";
    }
    if (check.ok) {
      setStatus(trialMessage() + (serverStart ? " تم تثبيت تاريخ البداية على الخادم." : " سيُثبت تاريخ البداية على الخادم عند عودة الاتصال."), "warning");
    } else {
      setStatus(check.reason || "انتهت التجربة المجانية.", "error");
    }
    return !!check.ok;
  })().finally(() => { trialBootstrapPromise = null; });
  return trialBootstrapPromise;
}
function localToCloudData(store, row, movementTotals) {
  const data = cleanValue(row);
  if (store === "products") {
    const movementSum = Number(movementTotals.get(String(row.id)) || 0);
    const base = row.cloudStockBase !== undefined
      ? Number(row.cloudStockBase)
      : Number(row.stock || 0) - movementSum;
    delete data.stock;
    data.cloudStockBase = rounded(base);
  }
  return data;
}
async function buildLocalRecords() {
  const backup = await window.POSDatabase.backupData();
  const data = backup.data || {};
  const movementTotals = new Map();
  (data.movements || []).forEach(movement => {
    const id = String(movement.productId || "");
    if (id) movementTotals.set(id, Number(movementTotals.get(id) || 0) + Number(movement.quantity || 0));
  });
  const map = new Map();
  for (const store of permittedSyncStores()) {
    const rows = Array.isArray(data[store]) ? data[store] : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const id = store === "settings" ? row.key : row.id;
      if (id === undefined || id === null || id === "") continue;
      if (store === "settings" && String(id).startsWith("__cloud")) continue;
      const recordId = String(id);
      const recordData = localToCloudData(store, row, movementTotals);
      const payload = { store, recordId, deleted: false, data: recordData };
      const key = docKey(store, recordId);
      if (key.length > 1400) throw new Error("معرّف سجل طويل جدًا ولا يمكن مزامنته: " + store);
      const serialized = JSON.stringify(payload);
      if (serialized.length > 850000) throw new Error("أحد السجلات أكبر من الحد الآمن للمزامنة: " + store + " / " + recordId);
      map.set(key, { key, store, recordId, data: recordData, deleted: false, hash: await digest(payload) });
    }
  }
  return map;
}
function cloudRecordPayload(store, recordId, data, deleted) {
  return { store, recordId, deleted: !!deleted, data: deleted ? null : data };
}
async function cloudHash(record) {
  return digest(cloudRecordPayload(record.store, record.recordId, record.data || null, !!record.deleted));
}
function cloudToLocalChange(record) {
  return {
    store: record.store,
    recordId: record.recordId,
    deleted: !!record.deleted,
    data: record.deleted ? null : cleanValue(record.data)
  };
}
function makeEmptyState(shopId) {
  return { version: 1, shopId, deviceId: deviceId(), records: {}, cursor: null, conflicts: [] };
}
function cursorFromDocument(snapshot) {
  const value = snapshot.data().updatedAt;
  if (!value || typeof value.toMillis !== "function") return null;
  return { seconds: value.seconds, nanoseconds: value.nanoseconds, id: snapshot.id };
}
async function allCloudDocuments(shopId) {
  const output = [];
  const stores=permittedSyncStores();
  if(!stores.length)return output;
  let last = null;
  while (true) {
    const base = [recordsRef(shopId), where("store","in",stores), orderBy("updatedAt"), orderBy(documentId())];
    const constraints = last ? [...base.slice(1), startAfter(last)] : base.slice(1);
    const page = await getDocs(query(base[0], ...constraints, limit(PAGE_SIZE)));
    output.push(...page.docs);
    if (page.size < PAGE_SIZE) return output;
    last = page.docs[page.docs.length - 1];
  }
}
function backupHasBusinessData(snapshot) {
  const data = snapshot && snapshot.data || {};
  return SYNC_STORES.some(name => Array.isArray(data[name]) && data[name].length > 0);
}
async function refreshLocalViews() {
  if (typeof window.POSRefreshAfterCloudSync === "function") {
    try { await window.POSRefreshAfterCloudSync(); } catch (error) { console.warn("POS refresh after cloud sync failed", error); }
  }
}
async function restoreFullShop(shopId) {
  const snapshots = await allCloudDocuments(shopId);
  const changes = [];
  const records = {};
  for (const snapshot of snapshots) {
    const value = snapshot.data();
    if (!permittedSyncStores().includes(value.store) || typeof value.recordId !== "string") {
      throw new Error("وجدنا سجلًا سحابيًا غير متوافق. أوقفنا الاستعادة لحماية البيانات.");
    }
    const hash = await cloudHash(value);
    records[snapshot.id] = { hash, deleted: !!value.deleted };
    changes.push(cloudToLocalChange(value));
  }
  suppressSync = true;
  try {
    await window.POSDatabase.applyCloudRecords(changes, true);
  } finally {
    suppressSync = false;
  }
  const last = snapshots.length ? cursorFromDocument(snapshots[snapshots.length - 1]) : null;
  const state = makeEmptyState(shopId);
  state.records = records;
  state.cursor = last;
  writeState(state);
  startRealtimeListener(shopId);
  await refreshLocalViews();
  scheduleSync();
  return state;
}
async function initialUpload(shopId) {
  const local = await buildLocalRecords();
  const entries = Array.from(local.values());
  let batch = writeBatch(cloudDb);
  let batchCount = 0;
  let batchBytes = 0;
  for (const entry of entries) {
    const writeData = {
      store: entry.store,
      recordId: entry.recordId,
      data: entry.data,
      deleted: false,
      deviceId: deviceId(),
      clientUpdatedAt: Date.now(),
      updatedAt: serverTimestamp()
    };
    const size = new TextEncoder().encode(JSON.stringify(writeData)).length;
    if (size > 850000) throw new Error("يوجد سجل كبير جدًا لا يمكن رفعه إلى Firestore.");
    if (batchCount >= 300 || batchBytes + size > 7 * 1024 * 1024) {
      await batch.commit();
      batch = writeBatch(cloudDb);
      batchCount = 0;
      batchBytes = 0;
    }
    batch.set(doc(recordsRef(shopId), entry.key), writeData);
    batchCount++;
    batchBytes += size;
  }
  if (batchCount) await batch.commit();
  const snapshots = await allCloudDocuments(shopId);
  const state = makeEmptyState(shopId);
  for (const snapshot of snapshots) {
    const value = snapshot.data();
    state.records[snapshot.id] = { hash: await cloudHash(value), deleted: !!value.deleted };
  }
  state.cursor = snapshots.length ? cursorFromDocument(snapshots[snapshots.length - 1]) : null;
  writeState(state);
  return state;
}
async function createShopForUser(user, shopName) {
  const settings = await window.POSDatabase.getSettings();
  const name = String(shopName || settings.shopName || "").trim();
  if (!name) throw new Error("اكتب اسم المحل أولًا.");
  const newShop = doc(collection(cloudDb, "shops"));
  const batch = writeBatch(cloudDb);
  batch.set(newShop, {
    ownerUid: user.uid,
    name,
    currency: "EGP",
    schemaVersion: 1,
    createdAt: serverTimestamp()
  });
  batch.set(memberRef(newShop.id, user.uid), {
    uid: user.uid,
    email: user.email || "",
    role: "owner",
    active: true,
    createdAt: serverTimestamp()
  });
  batch.set(userRef(user.uid), {
    activeShopId: newShop.id,
    email: user.email || "",
    displayName: user.displayName || "",
    updatedAt: serverTimestamp()
  });
  await batch.commit();

  activeShopId = newShop.id;
  activeShopName = name;
  activeMember = {uid:user.uid,email:user.email||"",role:"owner",active:true};
  localStorage.setItem(MANAGED_SHOP_KEY,newShop.id);
  setGateSession();
  showSignedIn(user, name);
  startMemberListener(newShop.id,user.uid);

  // Keep all business data local until the platform administrator issues a valid license.
  const licensed = await checkShopLicense(newShop.id);
  startLicenseListener(newShop.id);
  if (!licensed) return null;

  if (!window.POSGate || !window.POSGate.isCloudSyncEnabled()) {
    setStatus(trialMessage() + " بيانات التجربة محفوظة محليًا حتى إصدار ترخيص للمحل.", "warning");
    return null;
  }

  setStatus("تم التحقق من الترخيص. جارٍ رفع البيانات الأولية إلى السحابة...", "info");
  const state = await initialUpload(newShop.id);
  startRealtimeListener(newShop.id);
  setStatus("تم إنشاء المحل ورفع البيانات الأولية إلى السحابة.", "success");
  return state;
}
async function connectExistingShop(user, shopId) {
  const previousGateSession=window.POSGate&&window.POSGate.getSession?window.POSGate.getSession():null;
  const member = await getDoc(memberRef(shopId, user.uid));
  if (!member.exists() || member.data().active !== true) throw new Error("هذا الحساب ليس عضوًا نشطًا في المحل المحدد.");
  const shop = await getDoc(shopRef(shopId));
  if (!shop.exists()) throw new Error("بيانات المحل غير موجودة في السحابة.");
  activeShopId = shopId;
  activeShopName = String(shop.data().name || "المحل");
  activeMember = member.data();
  localStorage.setItem(MANAGED_SHOP_KEY,shopId);
  setGateSession();
  showSignedIn(user, activeShopName);
  applyRoleAccess();
  startMemberListener(shopId,user.uid);
  const licensed=await checkShopLicense(shopId);
  startLicenseListener(shopId);
  if(licensed&&window.POSGate&&window.POSGate.isCloudLicense())await registerCurrentDevice(shopId,user.uid);
  if(!licensed){setStatus("الحساب متصل لكن الترخيص أو سياسة التشغيل لا تسمح باستخدام هذا الجهاز.","error");return;}
  if(window.POSGate&&!window.POSGate.isCloudSyncEnabled()){
    setStatus("تم التحقق من الحساب. المزامنة السحابية موقوفة إداريًا؛ سيظل البيع محليًا وفق سياسة الأوفلاين.","warning");
    return;
  }
  startRealtimeListener(shopId);
  const oldState = readState();
  if (oldState && oldState.shopId === shopId) {
    const currentSnapshot = await window.POSDatabase.backupData();
    const identityChanged=!previousGateSession||previousGateSession.uid!==user.uid||previousGateSession.role!==activeMember.role;
    if(identityChanged){
      if(backupHasBusinessData(currentSnapshot)){
        const accepted=window.confirm("هذا الجهاز مرتبط بحساب أو دور مختلف. ستتم إعادة تحميل البيانات المسموح بها لهذا الدور من السحابة. صدّر نسخة احتياطية أولًا إن كنت تحتاجها. هل تريد المتابعة؟");
        if(!accepted){setStatus("تم إلغاء تبديل الحساب ولم يتم السماح بالوصول إلى بيانات الجهاز السابقة.", "warning");await signOut(auth);return;}
      }
      setStatus("جارٍ إعادة تحميل بيانات الدور الحالي وحذف البيانات غير المسموح بها من هذا الجهاز...", "info");
      await restoreFullShop(shopId);
      setStatus("تم ربط الحساب وتنزيل البيانات المسموح بها لهذا الدور.", "success");
      return;
    }
    if (!backupHasBusinessData(currentSnapshot) && Object.keys(oldState.records || {}).length > 0) {
      setStatus("لم نعثر على بيانات محلية محفوظة لهذا الجهاز. جارٍ استعادة نسخة المحل من السحابة...", "info");
      await restoreFullShop(shopId);
      setStatus("تمت استعادة بيانات المحل على هذا الجهاز.", "success");
    } else {
      setStatus("الحساب متصل. جارٍ فحص التغييرات...", "info");
      await syncNow();
    }
    return;
  }
  if (!oldState || oldState.shopId !== shopId) {
    const localSnapshot = await window.POSDatabase.backupData();
    if (backupHasBusinessData(localSnapshot)) {
      const accepted = window.confirm("هذا الجهاز يحتوي على بيانات محلية. عند ربطه بمحل موجود ستُستبدل بياناته ببيانات المحل السحابية. صدّر نسخة احتياطية أولًا إن كنت تحتاجها. هل تريد المتابعة؟");
      if (!accepted) {
        setStatus("تم إلغاء ربط المحل. لن تبقى جلسة الحساب الجديد مفتوحة على بيانات الجهاز السابقة.", "warning");
        await signOut(auth);
        return;
      }
    }
    setStatus("جارٍ تنزيل بيانات المحل وربط هذا الجهاز...", "info");
    await restoreFullShop(shopId);
    setStatus("تم ربط الجهاز وتنزيل بيانات المحل.", "success");
    return;
  }
  setStatus("الحساب متصل. جارٍ فحص التغييرات...", "info");
  await syncNow();
}
async function pullIncremental(state) {
  const stores=permittedSyncStores();
  if(!stores.length)throw new Error("لا توجد صلاحيات مزامنة لهذا الدور.");
  const base = [recordsRef(state.shopId), where("store","in",stores), orderBy("updatedAt"), orderBy(documentId())];
  let pages = 0;
  let applied = 0;
  while (true) {
    let pageQuery = query(base[0], ...base.slice(1), limit(PAGE_SIZE));
    if (state.cursor) {
      const cursorTimestamp = new Timestamp(state.cursor.seconds, state.cursor.nanoseconds);
      pageQuery = query(base[0], ...base.slice(1), startAfter(cursorTimestamp, state.cursor.id), limit(PAGE_SIZE));
    }
    const page = await getDocs(pageQuery);
    if (!page.size) break;
    const local = await buildLocalRecords();
    const changes = [];
    for (const snapshot of page.docs) {
      const remote = snapshot.data();
      if (!permittedSyncStores().includes(remote.store) || typeof remote.recordId !== "string") continue;
      const key = snapshot.id;
      const remoteHash = await cloudHash(remote);
      const baseline = state.records[key] || null;
      const localRecord = local.get(key) || null;
      if (baseline && baseline.hash === remoteHash) {
        state.records[key] = { hash: remoteHash, deleted: !!remote.deleted };
        continue;
      }
      if (localRecord && localRecord.hash === remoteHash) {
        state.records[key] = { hash: remoteHash, deleted: !!remote.deleted };
        continue;
      }
      const localUnchanged = baseline
        ? (!localRecord && baseline.deleted) || (localRecord && localRecord.hash === baseline.hash)
        : !localRecord;
      if (localUnchanged) {
        changes.push(cloudToLocalChange(remote));
        state.records[key] = { hash: remoteHash, deleted: !!remote.deleted };
        applied++;
      } else {
        const conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
        if (!conflicts.some(item => item.docId === key)) {
          conflicts.push({ docId: key, store: remote.store, recordId: remote.recordId, detectedAt: new Date().toISOString() });
        }
        state.conflicts = conflicts;
      }
    }
    if (changes.length) {
      suppressSync = true;
      try { await window.POSDatabase.applyCloudRecords(changes, false); }
      finally { suppressSync = false; }
    }
    state.cursor = cursorFromDocument(page.docs[page.docs.length - 1]) || state.cursor;
    writeState(state);
    pages++;
    if (page.size < PAGE_SIZE) break;
    if (pages > 100) throw new Error("المزامنة كبيرة جدًا في محاولة واحدة. حاول مرة أخرى بعد قليل.");
  }
  return applied;
}
function startRealtimeListener(shopId) {
  if(window.POSGate&&!window.POSGate.isCloudSyncEnabled()){
    if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}
    setStatus("المزامنة السحابية موقوفة من مدير المشروع. البيانات المحلية لم تتغير.","warning");
    return;
  }
  if (stopRecordsListener) {
    stopRecordsListener();
    stopRecordsListener = null;
  }
  const stores=permittedSyncStores();
  if(!stores.length){setStatus("لا توجد مجموعات بيانات مسموح بمزامنتها لهذا الدور.","warning");return;}
  const cloudQuery = query(recordsRef(shopId), where("store","in",stores), orderBy("updatedAt"), orderBy(documentId()));
  stopRecordsListener = onSnapshot(cloudQuery, snapshot => {
    const changed = snapshot.docChanges().map(change => change.doc);
    if (!changed.length) return;
    remoteChain = remoteChain
      .then(() => applyRealtimeDocuments(changed, shopId))
      .catch(error => setStatus("تعذر استقبال تحديثات المحل: " + firebaseError(error), "error"));
  }, error => setStatus("انقطع استقبال المزامنة اللحظية: " + firebaseError(error), "warning"));
}
async function applyRealtimeDocuments(snapshots, shopId) {
  const state = readState();
  if (!state || state.shopId !== shopId) return;
  const local = await buildLocalRecords();
  const changes = [];
  let conflictAdded = false;
  for (const snapshot of snapshots) {
    const remote = snapshot.data();
    if (!SYNC_STORES.includes(remote.store) || typeof remote.recordId !== "string") continue;
    const remoteHash = await cloudHash(remote);
    const baseline = state.records[snapshot.id] || null;
    const localRecord = local.get(snapshot.id) || null;
    if (baseline && baseline.hash === remoteHash) continue;
    if (localRecord && localRecord.hash === remoteHash) {
      state.records[snapshot.id] = { hash: remoteHash, deleted: !!remote.deleted };
      continue;
    }
    const localUnchanged = baseline
      ? (!localRecord && baseline.deleted) || (localRecord && localRecord.hash === baseline.hash)
      : !localRecord;
    if (localUnchanged) {
      changes.push(cloudToLocalChange(remote));
      state.records[snapshot.id] = { hash: remoteHash, deleted: !!remote.deleted };
    } else {
      state.conflicts = state.conflicts || [];
      if (!state.conflicts.some(item => item.docId === snapshot.id)) {
        state.conflicts.push({ docId: snapshot.id, store: remote.store, recordId: remote.recordId, detectedAt: new Date().toISOString() });
        conflictAdded = true;
      }
    }
    const cursor = cursorFromDocument(snapshot);
    if (cursor) {
      const previous = state.cursor;
      const newer = !previous || cursor.seconds > previous.seconds ||
        (cursor.seconds === previous.seconds && cursor.nanoseconds > previous.nanoseconds) ||
        (cursor.seconds === previous.seconds && cursor.nanoseconds === previous.nanoseconds && cursor.id > previous.id);
      if (newer) state.cursor = cursor;
    }
  }
  if (changes.length) {
    suppressSync = true;
    try { await window.POSDatabase.applyCloudRecords(changes, false); }
    finally { suppressSync = false; }
    await refreshLocalViews();
  }
  writeState(state);
  renderSyncConflicts();
  if(changes.length)scheduleSync();
  if (conflictAdded) {
    setStatus("وصل تحديث على سجل تم تعديله محليًا أيضًا. أوقفنا استبداله تلقائيًا لحماية البيانات؛ يلزم حل التعارض.", "warning");
  } else if (changes.length) {
    setStatus("تم استقبال " + changes.length + " تحديث من أجهزة المحل.", "success");
  }
}
async function pushLocalChanges(state) {
  const local = await buildLocalRecords();
  const candidates = [];
  for (const entry of local.values()) {
    const baseline = state.records[entry.key];
    if (!baseline || baseline.hash !== entry.hash) candidates.push(entry);
  }
  for (const [key, baseline] of Object.entries(state.records)) {
    if (!baseline.deleted && !local.has(key)) {
      const split = key.indexOf("--");
      if (split > 0) {
        candidates.push({
          key,
          store: key.slice(0, split),
          recordId: decodeURIComponent(key.slice(split + 2)),
          data: null,
          deleted: true,
          hash: await digest({ store: key.slice(0, split), recordId: decodeURIComponent(key.slice(split + 2)), deleted: true, data: null })
        });
      }
    }
  }
  let pushed = 0;
  for (const entry of candidates) {
    if ((state.conflicts || []).some(item => item.docId === entry.key)) continue;
    const base = state.records[entry.key] || null;
    const ref = doc(recordsRef(state.shopId), entry.key);
    const payload = cloudRecordPayload(entry.store, entry.recordId, entry.data, !!entry.deleted);
    const writeData = {
      store: entry.store,
      recordId: entry.recordId,
      data: entry.deleted ? null : entry.data,
      deleted: !!entry.deleted,
      deviceId: deviceId(),
      clientUpdatedAt: Date.now(),
      updatedAt: serverTimestamp()
    };
    try {
      await runTransaction(cloudDb, async transaction => {
        const remoteSnapshot = await transaction.get(ref);
        const remoteHash = remoteSnapshot.exists() ? await cloudHash(remoteSnapshot.data()) : null;
        const expectedHash = base ? base.hash : null;
        if (remoteHash !== expectedHash) {
          const conflict = new Error("SYNC_CONFLICT");
          conflict.code = "sync/conflict";
          throw conflict;
        }
        transaction.set(ref, writeData);
      });
      state.records[entry.key] = { hash: await digest(payload), deleted: !!entry.deleted };
      pushed++;
      writeState(state);
    } catch (error) {
      if (error && error.code === "sync/conflict") {
        state.conflicts = state.conflicts || [];
        if (!state.conflicts.some(item => item.docId === entry.key)) {
          state.conflicts.push({ docId: entry.key, store: entry.store, recordId: entry.recordId, detectedAt: new Date().toISOString() });
        }
        writeState(state);
        continue;
      }
      throw error;
    }
  }
  return pushed;
}
function conflictStoreLabel(store){
  return ({
    products:"منتج",invoices:"فاتورة",movements:"حركة مخزون",suppliers:"مورد",
    purchases:"فاتورة مشتريات",supplierPayments:"سداد مورد",stocktakes:"جرد",
    customers:"عميل",customerPayments:"تحصيل",returns:"مرتجع",cashEntries:"حركة خزينة",
    shifts:"وردية",settings:"إعدادات"
  })[store]||store;
}
function renderSyncConflicts(){
  const panel=$("cloudConflictsPanel"),root=$("cloudConflictsList");
  if(!panel||!root)return;
  const state=readState(),conflicts=Array.isArray(state&&state.conflicts)?state.conflicts:[];
  root.replaceChildren();
  panel.hidden=conflicts.length===0;
  if(!conflicts.length)return;
  const role=activeMember&&activeMember.role;
  const canResolve=!!activeUser&&["owner","manager","accountant"].includes(role)&&!!activeShopId;
  conflicts.forEach(conflict=>{
    const row=document.createElement("div");row.className="sync-conflict-row";
    const detail=document.createElement("span");
    detail.textContent=conflictStoreLabel(conflict.store)+" · "+String(conflict.recordId||conflict.docId)+" · "+new Date(conflict.detectedAt||Date.now()).toLocaleString("ar-EG");
    row.append(detail);
    if(canResolve){
      const actions=document.createElement("div");actions.className="sync-conflict-actions";
      const cloud=document.createElement("button");cloud.type="button";cloud.className="secondary";cloud.textContent="اعتماد نسخة السحابة";
      cloud.onclick=()=>clickAction(()=>resolveSyncConflict(conflict.docId,"cloud"));
      const local=document.createElement("button");local.type="button";local.className="primary";local.textContent="اعتماد نسخة هذا الجهاز";
      local.onclick=()=>clickAction(()=>resolveSyncConflict(conflict.docId,"local"));
      actions.append(cloud,local);row.append(actions);
    }
    root.append(row);
  });
  if(!canResolve){
    const note=document.createElement("p");note.className="hint";
    note.textContent="حل التعارضات متاح لصاحب المحل أو المدير أو المحاسب. اطلب من أحدهم مراجعتها من جهاز متصل بالإنترنت.";
    root.append(note);
  }
}
async function resolveSyncConflict(docId,choice){
  if(!navigator.onLine)throw new Error("يلزم الاتصال بالإنترنت لحل تعارض المزامنة.");
  if(!activeUser||!activeShopId||!activeMember||!["owner","manager","accountant"].includes(activeMember.role))
    throw new Error("حل تعارضات المزامنة متاح لصاحب المحل أو المدير أو المحاسب فقط.");
  if(window.POSGate&&!window.POSGate.isCloudSyncEnabled())throw new Error("المزامنة السحابية متوقفة حسب سياسة الترخيص.");
  if(!["cloud","local"].includes(choice))throw new Error("اختيار حل التعارض غير صحيح.");
  const state=readState();
  if(!state||state.shopId!==activeShopId)throw new Error("لا توجد حالة مزامنة للمحل الحالي.");
  const conflict=(state.conflicts||[]).find(item=>item.docId===docId);
  if(!conflict)throw new Error("هذا التعارض لم يعد موجودًا. حدّث حالة المزامنة.");
  const localMap=await buildLocalRecords();
  const localEntry=localMap.get(docId)||null;
  if(choice==="local"&&!confirm("سيتم اعتماد نسخة هذا الجهاز لهذا السجل ورفعها فوق النسخة السحابية الحالية. لا تستخدم هذا الخيار قبل مراجعة تفاصيل السجل. هل تريد المتابعة؟"))return false;
  if(choice==="cloud"&&!confirm("سيتم استبدال نسخة هذا الجهاز بالنسخة السحابية لهذا السجل. هل تريد المتابعة؟"))return false;
  const ref=doc(recordsRef(activeShopId),docId);
  const remoteSnapshot=await getDoc(ref);
  const remote=remoteSnapshot.exists()?remoteSnapshot.data():null;
  const expectedRemoteHash=remote?await cloudHash(remote):null;
  if(choice==="cloud"){
    const change=remote?cloudToLocalChange(remote):{
      store:conflict.store,recordId:conflict.recordId,deleted:true,data:null
    };
    suppressSync=true;
    try{await window.POSDatabase.applyCloudRecords([change],false);}
    finally{suppressSync=false;}
    if(remote)state.records[docId]={hash:expectedRemoteHash,deleted:!!remote.deleted};
    else delete state.records[docId];
  }else{
    const store=localEntry?localEntry.store:conflict.store;
    const recordId=localEntry?localEntry.recordId:conflict.recordId;
    const data=localEntry?localEntry.data:null;
    const deleted=!localEntry;
    const payload=cloudRecordPayload(store,recordId,data,deleted);
    const writeData={
      store,recordId,data:deleted?null:data,deleted,
      deviceId:deviceId(),clientUpdatedAt:Date.now(),updatedAt:serverTimestamp()
    };
    await runTransaction(cloudDb,async transaction=>{
      const current=await transaction.get(ref);
      const currentHash=current.exists()?await cloudHash(current.data()):null;
      if(currentHash!==expectedRemoteHash){
        const error=new Error("تغيرت النسخة السحابية أثناء حل التعارض. أعد تحميل البيانات وحاول مرة أخرى.");
        error.code="sync/conflict";
        throw error;
      }
      transaction.set(ref,writeData);
    });
    state.records[docId]={hash:await digest(payload),deleted};
  }
  state.conflicts=(state.conflicts||[]).filter(item=>item.docId!==docId);
  writeState(state);
  renderSyncConflicts();
  await refreshLocalViews();
  setStatus("تم حل التعارض واعتماد النسخة المختارة. راجع المخزون والتقارير بعد المزامنة.","success");
  return true;
}
async function syncNow(includePull) {
  if (syncBusy) return;
  if(window.POSGate&&!window.POSGate.isCloudSyncEnabled()){
    setStatus("المزامنة السحابية موقوفة من مدير المشروع. البيع المحلي متاح حسب سياسة الأوفلاين.","warning");
    return;
  }
  if (!navigator.onLine) {
    setStatus("دون إنترنت. البيع محفوظ محليًا وستتم المزامنة عند عودة الاتصال.", "warning");
    return;
  }
  const state = readState();
  if (!activeUser || !activeShopId || !state || state.shopId !== activeShopId) {
    setStatus("سجّل الدخول واربط هذا الجهاز بالمحل أولًا.", "warning");
    return;
  }
  if(window.POSGate&&!window.POSGate.isLicensed()){
    await checkShopLicense(activeShopId);
    if(!window.POSGate.isLicensed())return;
  }
  syncBusy = true;
  setBusy(true);
  try {
    setStatus("جارٍ استقبال التغييرات...", "info");
    const pulled = includePull === false ? 0 : await pullIncremental(state);
    const pushed = await pushLocalChanges(state);
    const pulledAfterWrite = includePull === false ? 0 : await pullIncremental(state);
    writeState(state);
    renderSyncConflicts();
    const conflictCount = (state.conflicts || []).length;
    const products = await window.POSDatabase.getProducts();
    const negativeStockCount = products.filter(product => product.trackStock && Number(product.stock || 0) < -0.001).length;
    if (negativeStockCount) {
      setStatus("المزامنة مكتملة، لكن يوجد " + negativeStockCount + " صنف برصيد سالب بسبب بيع متزامن من أجهزة كانت غير متصلة. راجع المخزون قبل متابعة البيع.", "error");
    } else if (conflictCount) {
      setStatus("اكتملت المزامنة مع وجود " + conflictCount + " تعارض يحتاج مراجعة. لم نستبدل بيانات متعارضة تلقائيًا.", "warning");
    } else {
      setStatus("المزامنة مكتملة. تغييرات مستلمة: " + (pulled + pulledAfterWrite) + "، تغييرات مرسلة: " + pushed + ".", "success");
    }
    if (pulled + pulledAfterWrite > 0) await refreshLocalViews();
  } catch (error) {
    setStatus("تعذرت المزامنة: " + firebaseError(error) + " البيع المحلي ما زال متاحًا.", "error");
  } finally {
    syncBusy = false;
    setBusy(false);
  }
}
function scheduleSync() {
  if (suppressSync || !activeUser || !activeShopId) return;
  if(window.POSGate&&!window.POSGate.isCloudSyncEnabled())return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(false), 1800);
}
async function handleLogin() {
  await authPersistenceReady;
  const email = $("cloudEmail").value.trim();
  const password = $("cloudPassword").value;
  if (!email || !password) throw new Error("اكتب البريد الإلكتروني وكلمة المرور.");
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const user = credential.user;
  activeUser = user;

  // Resolve platform-admin access before reading any shop profile or license.
  // This prevents the login button handler from racing the auth-state listener
  // and accidentally routing a platform administrator into shop registration.
  isPlatformAdmin = await verifyPlatformAdmin(user);
  if (window.POSGate) window.POSGate.setPlatformAdmin(isPlatformAdmin);
  if (isPlatformAdmin) {
    if (stopRecordsListener) { stopRecordsListener(); stopRecordsListener = null; }
    stopGovernanceListeners();
    activeShopId = "";
    activeShopName = "";
    activeMember = null;
    showSignedIn(user, "إدارة المنصة");
    if ($("cloudAuthPanel")) $("cloudAuthPanel").hidden = true;
    if ($("cloudConnectedPanel")) $("cloudConnectedPanel").hidden = false;
    if ($("cloudCreateShop")) $("cloudCreateShop").hidden = true;
    if ($("cloudSyncNow")) $("cloudSyncNow").hidden = true;
    applyRoleAccess();
    setStatus("تم التحقق من صلاحية مدير المنصة. إدارة المحلات والتراخيص متاحة دون ترخيص تشغيل على هذا الجهاز.", "success");
    await loadPlatformShops();
    return;
  }

  const profile = await getDoc(userRef(user.uid));
  const profileData = profile.exists() ? profile.data() : {};
  if (profileData.activeShopId) {
    await connectExistingShop(user, String(profileData.activeShopId));
    return;
  }
  const inviteCode = $("cloudInviteCode")?.value.trim();
  if (inviteCode) { await acceptEmployeeInvite(user, inviteCode); return; }
  showSignedIn(user, "");
  if ($("cloudCreateShop")) $("cloudCreateShop").hidden = false;
  setStatus("الحساب غير مرتبط بمحل. لم ننشئ محلًا تلقائيًا ولم نغيّر بيانات الجهاز. اضغط «إنشاء محل لهذا الحساب» فقط عند رغبتك في إنشاء محل جديد.", "warning");
}
async function handleEmployeeRegister(){
  await authPersistenceReady;
  const email=$("cloudEmail").value.trim(),password=$("cloudPassword").value,code=$("cloudInviteCode").value.trim();
  if(!email||!password||password.length<6||!code)throw new Error("اكتب البريد وكلمة المرور وكود الدعوة الصحيح.");
  const credential=await createUserWithEmailAndPassword(auth,email,password);activeUser=credential.user;await acceptEmployeeInvite(credential.user,code);
}
async function handleRegister() {
  await authPersistenceReady;
  const email = $("cloudEmail").value.trim();
  const password = $("cloudPassword").value;
  const name = $("cloudShopName").value.trim();
  if (!email || !password) throw new Error("اكتب البريد الإلكتروني وكلمة المرور.");
  if (password.length < 6) throw new Error("كلمة المرور يجب ألا تقل عن 6 أحرف.");
  if (!name) throw new Error("اكتب اسم المحل الذي ستنشئه.");
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  activeUser = credential.user;
  await createShopForUser(credential.user, name);
}
async function handleCreateShop() {
  if (!activeUser) throw new Error("سجّل الدخول أولًا.");
  const profile = await getDoc(userRef(activeUser.uid));
  if (profile.exists() && profile.data().activeShopId) throw new Error("هذا الحساب مرتبط بمحل بالفعل.");
  await createShopForUser(activeUser, $("cloudShopName").value.trim());
}
async function clickAction(action) {
  setBusy(true);
  try {
    await action();
  } catch (error) {
    setStatus(firebaseError(error), "error");
  } finally {
    setBusy(false);
  }
}

const EMPLOYEE_ROLES={owner:"صاحب المحل",manager:"مدير",cashier:"كاشير",accountant:"محاسب"};
const ROLE_VIEWS={
 owner:["sale","products","inventory","purchases","invoices","customers","cash","reports","backup","settings","employees"],
 manager:["sale","products","inventory","purchases","invoices","customers","cash","reports","backup"],
 cashier:["sale","invoices"],
 accountant:["sale","purchases","invoices","customers","cash","reports"]
};
const LICENSE_CACHE_PREFIX="supermarket-pos-signed-license-v1:";
const MANAGED_SHOP_KEY="supermarket-pos-managed-shop-v1";
function roleLabel(role){return EMPLOYEE_ROLES[role]||"غير محدد";}
function applyRoleAccess(){
 const gateSession=window.POSGate&&window.POSGate.getSession?window.POSGate.getSession():null;
 const localMode=!!(gateSession&&gateSession.local);
 const role=isPlatformAdmin?"":(activeMember&&activeMember.role||(localMode?"owner":""));
 const standalone=!activeMember&&!isPlatformAdmin&&!localMode,allowed=new Set(ROLE_VIEWS[role]||[]);
 document.querySelectorAll(".tabs [data-view]").forEach(button=>{const name=button.dataset.view;button.hidden=name==="platform"?!isPlatformAdmin:(isPlatformAdmin||(!standalone&&!allowed.has(name)));});
 if($("employeesTab"))$("employeesTab").hidden=isPlatformAdmin||role!=="owner"||localMode;
 if($("platformTab"))$("platformTab").hidden=!isPlatformAdmin;
 if($("cloudAccountRole"))$("cloudAccountRole").textContent=isPlatformAdmin?"مدير المنصة":(gateSession&&gateSession.trial?("تجربة مجانية — "+roleLabel(role)):(localMode?roleLabel(role)+" (محلي)":(activeMember?roleLabel(role):"غير مرتبط")));
 if($("cloudAccountUid"))$("cloudAccountUid").textContent=activeUser?activeUser.uid:"";
 if($("employeeOwnerPanel"))$("employeeOwnerPanel").hidden=isPlatformAdmin||role!=="owner"||localMode;
 if($("employeeAccessMessage"))$("employeeAccessMessage").textContent=localMode
  ?"الترخيص المحلي لا يدعم دعوات أو حسابات موظفين سحابية."
  :(role==="owner"?"يمكنك دعوة الموظفين وإيقاف حساباتهم وتغيير أدوارهم.":"إدارة الموظفين متاحة لصاحب المحل فقط.");
 if($("platformAdminEmail"))$("platformAdminEmail").textContent=activeUser&&activeUser.email||"";
 if($("platformAdminUid"))$("platformAdminUid").textContent=activeUser&&activeUser.uid||"";
 renderSyncConflicts();
 const current=document.querySelector(".tab.active");
 if(current&&!current.hidden)return;
 const first=document.querySelector('.tab[data-view="sale"]:not([hidden])')||document.querySelector('.tab:not([hidden])');
 if(first)first.click();
}
window.POSCloudRefreshAccessUI=applyRoleAccess;
function platformAdminRef(uid){return doc(cloudDb,"platformAdmins",uid);}
function employeeInviteRef(code){return doc(cloudDb,"employeeInvites",code);}
function licenseRef(shopId){return doc(cloudDb,"licenses",shopId);}
function memberCollection(shopId){return collection(cloudDb,"shops",shopId,"members");}
function stopGovernanceListeners(){if(stopMemberListener){stopMemberListener();stopMemberListener=null;}if(stopLicenseListener){stopLicenseListener();stopLicenseListener=null;}}
async function verifyPlatformAdmin(user){
 if(!user)return false;
 try{
  const snapshot=await getDoc(platformAdminRef(user.uid));
  return snapshot.exists()&&snapshot.data().active===true;
 }catch(error){
  console.error("Platform admin check failed",{
   uid:user.uid,projectId:firebaseConfig.projectId,
   code:error&&error.code||"unknown",message:error&&error.message||String(error)
  });
  const detail=error&&error.code?error.code:(error&&error.message||"خطأ غير معروف");
  throw new Error("PLATFORM_ADMIN_CHECK_FAILED: تعذر قراءة صلاحية مدير المنصة من Firebase ("+detail+"). لا تنشئ محلًا بهذا الحساب؛ راجع قواعد Firestore واتصال المشروع.");
 }
}
function setGateSession(){
 if(window.POSGate){
  if(activeUser&&activeShopId&&activeMember)window.POSGate.setSession({uid:activeUser.uid,shopId:activeShopId,role:activeMember.role,active:activeMember.active!==false});
  else if(!activeUser)window.POSGate.setSession(null);
 }
 applyRoleAccess();
}
async function checkShopLicense(shopId){
 if(!shopId)return false;
 let licenseDocument=null,onlineReadSucceeded=false;
 if(navigator.onLine){
  try{
   const snapshot=await getDoc(licenseRef(shopId));onlineReadSucceeded=true;
   if(!snapshot.exists()){
    localStorage.removeItem(LICENSE_CACHE_PREFIX+shopId);
    const trialRole=activeMember&&activeMember.role||"owner";
    if(window.POSGate&&activeUser)await ensureTrialExperience(activeUser,true,trialRole);
    if(window.POSGate&&window.POSGate.activateTrial(shopId,trialRole)){
     setStatus(trialMessage()+" لم يصدر ترخيص مدفوع لهذا المحل بعد؛ المزامنة السحابية متوقفة أثناء التجربة.","warning");
     return true;
    }
    const trialState=window.POSGate&&window.POSGate.trialStatus?window.POSGate.trialStatus():null;
    const reason=trialState&&!trialState.ok?trialState.reason:"لا يوجد ترخيص صادر لهذا المحل. تواصل مع مدير المنصة.";
    if(window.POSGate)window.POSGate.lock(reason);
    setStatus(reason,"error");return false;
   }
   licenseDocument=snapshot.data();
   if(licenseDocument.payload&&licenseDocument.payload.licenseType==="local"){if(window.POSGate)window.POSGate.lock("هذا المحل مرخص محليًا. استخدم ملف الترخيص المحلي دون تسجيل الدخول السحابي.");setStatus("الترخيص محلي ولا يقبل ربط حسابات أو أجهزة سحابية.","error");return false;}
  }catch(error){console.warn("Online license check failed; trying signed cached license",error);}
 }
 if(licenseDocument){
  const valid=await window.POSGate.applyLicense(licenseDocument,shopId,true,true);
  if(!valid){setStatus("البرنامج متوقف: حالة الترخيص أو تاريخ صلاحيته لا يسمحان بالتشغيل.","error");return false;}
  if(!window.POSGate.canOperateLocally()){
   window.POSGate.lock("سياسة مدير المشروع لا تسمح بالعمل دون اتصال. تعذر التحقق من الخادم؛ اتصل بالإنترنت.");
   setStatus("هذا المحل مضبوط على العمل أونلاين فقط.","error");return false;
  }
  setStatus("الترخيص ساري حتى "+new Date(licenseDocument.payload.expiresAt).toLocaleDateString("ar-EG")+".","success");
  return true;
 }
 let cached=null;try{cached=JSON.parse(localStorage.getItem(LICENSE_CACHE_PREFIX+shopId)||"null");}catch(_){}
 if(!cached&&activeUser&&window.POSGate){
  const trialRole=activeMember&&activeMember.role||"owner";
  await ensureTrialExperience(activeUser,true,trialRole);
  if(window.POSGate.activateTrial(shopId,trialRole)){
   setStatus(trialMessage()+" — لا يوجد ترخيص متاح حاليًا؛ تعمل بيانات المحل محليًا أثناء التجربة.","warning");
   return true;
  }
 }
 if(cached&&window.POSGate){
  const valid=await window.POSGate.applyLicense(cached,shopId,false,false);
  if(valid&&window.POSGate.canOperateLocally()){
   setStatus("يعمل التطبيق محليًا بترخيص محفوظ. سيصل أي إيقاف إداري عند عودة الاتصال.","warning");return true;
  }
 }
 if(window.POSGate)window.POSGate.lock(onlineReadSucceeded?"لا يوجد ترخيص فعال لهذا المحل.":"لا يوجد ترخيص محلي صالح أو أن مدير المشروع منع التشغيل دون اتصال.");
 return false;
}
function startMemberListener(shopId,uid){
 if(stopMemberListener){stopMemberListener();stopMemberListener=null;}
 stopMemberListener=onSnapshot(memberRef(shopId,uid),async snapshot=>{
  if(!snapshot.exists()||snapshot.data().active!==true){
   activeMember=null;if(window.POSGate){window.POSGate.setSession(null);window.POSGate.lock("تم إيقاف حساب الموظف من صاحب المحل. تواصل معه لإعادة التفعيل.");}
   showSignedIn(null,"");setStatus("تم إيقاف عضوية هذا الحساب.","error");signOut(auth).catch(()=>{});return;
  }
  const previousRole=activeMember&&activeMember.role;
  activeMember=snapshot.data();setGateSession();
  if(previousRole&&previousRole!==activeMember.role){
   if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}
   if(window.POSGate&&window.POSGate.isCloudSyncEnabled()){
    setStatus("تغير دور الحساب. جارٍ إعادة تحميل مجموعات البيانات المسموح بها...","warning");
    await restoreFullShop(shopId);
    setStatus("تم تطبيق الدور الجديد وتحديث بيانات هذا الجهاز.","success");
   }else{
    setStatus("تم تحديث الدور. المزامنة متوقفة؛ راجع صاحب المحل عند الحاجة لتحديث البيانات المحلية.","warning");
   }
  }
 },error=>setStatus("تعذر تحديث صلاحيات الموظف: "+firebaseError(error),"warning"));
}
function startLicenseListener(shopId){
 if(stopLicenseListener){stopLicenseListener();stopLicenseListener=null;}
 stopLicenseListener=onSnapshot(licenseRef(shopId),async snapshot=>{
  if(!snapshot.exists()){
   if(window.POSGate&&window.POSGate.hasActiveTrial()){
    setStatus(trialMessage()+" لم يصدر ترخيص للمحل بعد؛ بيانات التجربة محلية.", "warning");
    if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}
    return;
   }
   if(window.POSGate)window.POSGate.lock("لا يوجد ترخيص فعال والتجربة المجانية غير متاحة.");
   if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}
   setStatus("لا يوجد ترخيص فعال والتجربة المجانية غير متاحة.", "error");return;
  }
  const valid=await window.POSGate.applyLicense(snapshot.data(),shopId,true,true);
  if(valid&&activeMember&&activeMember.role==="owner"&&activeShopName&&window.POSDatabase){
   const localSettings=await window.POSDatabase.getSettings();
   if(String(localSettings.shopName||"")!==String(activeShopName))
    await window.POSDatabase.saveSettings({shopName:activeShopName});
  }
  if(!valid||!window.POSGate.isCloudSyncEnabled()){
   if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}
  }else{
   startRealtimeListener(shopId);
   const currentState=readState();
   if(activeUser&&navigator.onLine&&currentState&&currentState.shopId===shopId){
    setTimeout(()=>syncNow(false),800);
   }else if(activeUser&&navigator.onLine){
    setStatus("الترخيص أصبح ساريًا. بيانات الجهاز المحلية ما زالت محفوظة؛ اضغط «مزامنة الآن» لمراجعة ورفع البيانات إلى المحل.", "success");
   }
  }
  if(!valid)setStatus("الترخيص موقوف أو منتهي أو بياناته غير صالحة. راجع مدير المنصة.", "error");
 },error=>setStatus("تعذر تحديث حالة الترخيص: "+firebaseError(error),"warning"));
}
async function acceptEmployeeInvite(user,code){
 const cleanCode=String(code||"").trim();if(!cleanCode)throw new Error("أدخل كود الدعوة الذي أرسله صاحب المحل.");
 const inviteRef=employeeInviteRef(cleanCode),snapshot=await getDoc(inviteRef);
 if(!snapshot.exists())throw new Error("كود الدعوة غير صحيح أو غير موجود.");
 const invitation=snapshot.data(),email=String(user.email||"").trim().toLowerCase();
 if(invitation.active!==true)throw new Error("هذه الدعوة مستخدمة أو أوقفها صاحب المحل.");
 if(String(invitation.email||"").trim().toLowerCase()!==email)throw new Error("الدعوة مخصصة لبريد إلكتروني مختلف.");
 if(!["manager","cashier","accountant"].includes(invitation.role))throw new Error("الدور الوظيفي في الدعوة غير صحيح.");
 const shopId=String(invitation.shopId||"");if(!shopId)throw new Error("الدعوة لا تحتوي على معرّف محل صالح.");
 const batch=writeBatch(cloudDb);
 batch.set(memberRef(shopId,user.uid),{uid:user.uid,email,role:invitation.role,active:true,invitedBy:invitation.createdBy||"",inviteCode:cleanCode,joinedAt:serverTimestamp(),createdAt:serverTimestamp()});
 batch.update(inviteRef,{active:false,acceptedByUid:user.uid,acceptedAt:serverTimestamp()});
 batch.set(userRef(user.uid),{activeShopId:shopId,email,displayName:user.displayName||"",updatedAt:serverTimestamp()},{merge:true});
 await batch.commit();await connectExistingShop(user,shopId);
}
async function createEmployeeInvite(email,role){
 if(!activeUser||!activeShopId||!activeMember||activeMember.role!=="owner")throw new Error("هذه العملية متاحة لصاحب المحل فقط.");
 const cleanEmail=String(email||"").trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))throw new Error("اكتب بريدًا إلكترونيًا صحيحًا.");
 if(!["manager","cashier","accountant"].includes(role))throw new Error("اختر دورًا وظيفيًا صحيحًا.");
 const code=randomId().replace(/[^a-zA-Z0-9]/g,"").slice(0,22),batch=writeBatch(cloudDb);
 batch.set(employeeInviteRef(code),{code,shopId:activeShopId,shopName:activeShopName,email:cleanEmail,role,active:true,createdBy:activeUser.uid,createdAt:serverTimestamp()});
 await batch.commit();return code;
}
async function submitAccountDeletionRequest(){
  if(!activeUser||activeUser.isAnonymous||!activeUser.email)throw new Error("سجّل الدخول بحساب بريد إلكتروني أولًا.");
  if(isPlatformAdmin)throw new Error("طلب حذف حساب مدير المنصة يحتاج معالجة من مالك مشروع Firebase خارج التطبيق.");
  if(!navigator.onLine)throw new Error("يلزم الاتصال بالإنترنت لإرسال طلب حذف الحساب.");
  const requestRef=doc(cloudDb,"accountDeletionRequests",activeUser.uid);
  const existing=await getDoc(requestRef);
  if(existing.exists())throw new Error("يوجد طلب حذف سابق لهذا الحساب. تواصل مع مدير Cashiro لمتابعة حالته.");
  const payload={
    uid:activeUser.uid,
    email:activeUser.email,
    role:activeMember&&activeMember.role?activeMember.role:"unlinked",
    requestedAt:serverTimestamp(),
    status:"pending"
  };
  if(activeShopId)payload.shopId=activeShopId;
  await setDoc(requestRef,payload);
  const status=$("accountDeletionStatus");
  if(status)status.textContent="تم تسجيل طلب حذف الحساب. الطلب قيد المراجعة، ولم يتم حذف الحساب أو سجلات المحل حتى الآن.";
  setStatus("تم إرسال طلب حذف الحساب إلى إدارة Cashiro للمراجعة.","success");
}

async function loadEmployeeWorkspace(){
 if(!activeShopId||!activeMember||activeMember.role!=="owner")return;
 const [membersSnapshot,invitesSnapshot]=await Promise.all([getDocs(memberCollection(activeShopId)),getDocs(query(collection(cloudDb,"employeeInvites"),where("shopId","==",activeShopId)))]);
 const members=$("employeeMembers"),invites=$("employeeInvites");members.replaceChildren();invites.replaceChildren();
 const staff=membersSnapshot.docs.map(x=>({uid:x.id,...x.data()})).filter(x=>x.role!=="owner");
 if(!staff.length)members.innerHTML='<p class="empty">لم تتم إضافة موظفين بعد.</p>';
 staff.forEach(member=>{
  const row=document.createElement("div");row.className="employee-row";const main=document.createElement("div");main.className="employee-row-main";
  const name=document.createElement("strong");name.textContent=member.email||member.uid;
  const meta=document.createElement("small");meta.textContent=roleLabel(member.role)+" · "+(member.active?"نشط":"موقوف");main.append(name,meta);
  const actions=document.createElement("div");actions.className="employee-row-actions";const role=document.createElement("select");
  [["cashier","كاشير"],["accountant","محاسب"],["manager","مدير"]].forEach(([value,label])=>{const option=document.createElement("option");option.value=value;option.textContent=label;role.append(option);});role.value=member.role||"cashier";
  const save=document.createElement("button");save.type="button";save.className="secondary";save.textContent="حفظ الدور";
  save.onclick=async()=>{try{const batch=writeBatch(cloudDb);batch.set(memberRef(activeShopId,member.uid),{...member,role:role.value,updatedAt:serverTimestamp()});await batch.commit();await loadEmployeeWorkspace();setStatus("تم تحديث دور الموظف.","success");}catch(error){setStatus("تعذر تحديث الدور: "+firebaseError(error),"error");}};
  const toggle=document.createElement("button");toggle.type="button";toggle.className=member.active?"remove":"primary";toggle.textContent=member.active?"إيقاف":"تفعيل";
  toggle.onclick=async()=>{try{const batch=writeBatch(cloudDb);batch.set(memberRef(activeShopId,member.uid),{...member,active:!member.active,updatedAt:serverTimestamp()});await batch.commit();await loadEmployeeWorkspace();setStatus(member.active?"تم إيقاف حساب الموظف.":"تم تفعيل حساب الموظف.","success");}catch(error){setStatus("تعذر تغيير حالة الموظف: "+firebaseError(error),"error");}};
  actions.append(role,save,toggle);row.append(main,actions);members.append(row);
 });
 const pending=invitesSnapshot.docs.map(x=>({id:x.id,...x.data()})).filter(x=>x.active===true);
 if(!pending.length)invites.innerHTML='<p class="empty">لا توجد دعوات معلقة.</p>';
 pending.forEach(invitation=>{
  const row=document.createElement("div");row.className="employee-row";const main=document.createElement("div");main.className="employee-row-main";
  const email=document.createElement("strong");email.textContent=invitation.email||"";const meta=document.createElement("small");meta.textContent=roleLabel(invitation.role)+" · كود: "+invitation.code;main.append(email,meta);
  const cancel=document.createElement("button");cancel.type="button";cancel.className="remove";cancel.textContent="إلغاء الدعوة";
  cancel.onclick=async()=>{try{const batch=writeBatch(cloudDb);batch.set(employeeInviteRef(invitation.code),{...invitation,active:false,cancelledAt:serverTimestamp()});await batch.commit();await loadEmployeeWorkspace();}catch(error){setStatus("تعذر إلغاء الدعوة: "+firebaseError(error),"error");}};
  row.append(main,cancel);invites.append(row);
 });
}
function addCalendarMonths(date,months){
 const source=new Date(date),day=source.getUTCDate();source.setUTCDate(1);source.setUTCMonth(source.getUTCMonth()+months);
 const last=new Date(Date.UTC(source.getUTCFullYear(),source.getUTCMonth()+1,0)).getUTCDate();source.setUTCDate(Math.min(day,last));return source;
}
let platformKeyPromise=null;
async function importLicenseSigningKey(pem){
 const base64=String(pem||"").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,"");
 if(!base64)throw new Error("ملف مفتاح التوقيع الخاص فارغ أو ليس بصيغة PKCS#8 PEM.");
 const raw=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
 platformKeyPromise=crypto.subtle.importKey("pkcs8",raw,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);await platformKeyPromise;licensePrivateKeyPem=pem;
}
async function signLicensePayload(payload){
 if(!licensePrivateKeyPem||!platformKeyPromise)throw new Error("ارفع ملف مفتاح التوقيع الخاص أولًا.");
 const signature=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},await platformKeyPromise,new TextEncoder().encode(stable(payload)));
 return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
const LICENSE_PLANS = {
 "7d": {label:"7 أيام", days:7},
 "1m": {label:"شهر", months:1},
 "3m": {label:"3 أشهر", months:3},
 "6m": {label:"6 أشهر", months:6},
 "1y": {label:"سنة", months:12},
 "life": {label:"مدى الحياة", lifetime:true}
};
function addLicensePlan(start,plan){
 const spec=LICENSE_PLANS[plan];if(!spec)throw new Error("مدة الترخيص غير معروفة.");
 if(spec.lifetime)return new Date("9999-12-31T23:59:59.999Z");
 if(spec.days)return new Date(start.getTime()+spec.days*86400000);
 return addCalendarMonths(start,spec.months);
}
async function writeLicense(shop,plan,status,maxDevices,licenseType,renew){
 if(!isPlatformAdmin)throw new Error("ليس لديك صلاحية مدير المشروع.");
 if(!licensePrivateKeyPem)throw new Error("ارفع ملف مفتاح التوقيع الخاص أولًا.");
 const spec=LICENSE_PLANS[plan];if(!spec)throw new Error("اختر مدة ترخيص صحيحة.");
 const cap=Math.max(1,Math.min(500,Math.floor(Number(maxDevices)||1)));
 const type=licenseType==="local"?"local":"cloud";
 const activeDevicesSnapshot=await getDocs(query(deviceCollectionRef(shop.id),where("active","==",true)));
 if(type==="local"&&activeDevicesSnapshot.size)throw new Error("ألغِ ربط الأجهزة السحابية أولًا قبل تحويل المحل إلى ترخيص محلي.");
 if(type==="cloud"&&cap<activeDevicesSnapshot.size)throw new Error("لا يمكن خفض الحد إلى أقل من عدد الأجهزة المرتبطة حاليًا ("+activeDevicesSnapshot.size+"). ألغِ ربط الأجهزة الزائدة أولًا.");
 const now=new Date(),nowIso=now.toISOString(),oldSnapshot=await getDoc(licenseRef(shop.id)),old=oldSnapshot.exists()?oldSnapshot.data().payload:null;
 let expires=new Date(old&&old.expiresAt||nowIso);
 if(status==="active"){
  if(old&&old.status==="active"&&old.plan===plan&&renew===true&&Date.parse(old.expiresAt)>now.getTime())expires=addLicensePlan(new Date(old.expiresAt),plan);
  else if(old&&old.status==="active"&&old.plan===plan&&renew!==true&&Date.parse(old.expiresAt)>now.getTime())expires=new Date(old.expiresAt);
  else expires=addLicensePlan(now,plan);
 }
 const payload={schema:2,shopId:shop.id,shopName:String(shop.name||"المحل"),ownerUid:String(shop.ownerUid||""),status,plan,planLabel:spec.label,planMonths:spec.months||0,licenseType:type,maxDevices:cap,issuedAt:nowIso,validFrom:status==="active"?nowIso:old&&old.validFrom||nowIso,expiresAt:spec.lifetime&&status==="active"?"9999-12-31T23:59:59.999Z":expires.toISOString(),offlineAllowed:type==="local"?true:(old?old.offlineAllowed!==false:true),cloudSyncEnabled:type==="cloud"?(old&&old.licenseType==="cloud"?old.cloudSyncEnabled!==false:true):false,issuerUid:activeUser.uid};
 const signature=await signLicensePayload(payload),batch=writeBatch(cloudDb);
 batch.set(licenseRef(shop.id),{payload,signature,updatedAt:serverTimestamp()});await batch.commit();
 setStatus(status==="active"?"تم تحديث الترخيص وإعداداته بنجاح.":"تم تعليق الترخيص مركزيًا.","success");await loadPlatformShops();
}
async function saveShopPolicy(shop,offlineAllowed,cloudSyncEnabled){
 if(!isPlatformAdmin)throw new Error("ليس لديك صلاحية مدير المشروع.");
 if(!licensePrivateKeyPem)throw new Error("ارفع ملف مفتاح التوقيع الخاص أولًا.");
 const snapshot=await getDoc(licenseRef(shop.id));
 if(!snapshot.exists()||!snapshot.data().payload)throw new Error("فعّل ترخيص المحل أولًا قبل ضبط سياسة الاتصال.");
 if(snapshot.data().payload.licenseType==="local")throw new Error("الترخيص المحلي يعمل دون اتصال ولا يقبل إعدادات المزامنة السحابية.");
 const payload={...snapshot.data().payload,offlineAllowed:!!offlineAllowed,cloudSyncEnabled:!!cloudSyncEnabled,policyUpdatedAt:new Date().toISOString(),issuerUid:activeUser.uid};
 const signature=await signLicensePayload(payload),batch=writeBatch(cloudDb);
 batch.set(licenseRef(shop.id),{payload,signature,updatedAt:serverTimestamp()});await batch.commit();
 setStatus("تم حفظ سياسة الأوفلاين والأونلاين للمحل وإعادة توقيع الترخيص.","success");
 await loadPlatformShops();
}
function deviceCollectionRef(shopId){return collection(cloudDb,"shops",shopId,"devices");}
function deviceRef(shopId,id){return doc(cloudDb,"shops",shopId,"devices",id);}
function deviceSlotRef(shopId,index){return doc(cloudDb,"shops",shopId,"deviceSlots",String(index));}
let stopOwnDeviceListener=null;
async function registerCurrentDevice(shopId,uid){
 if(!navigator.onLine)throw new Error("يلزم الاتصال بالإنترنت للتحقق من حد الأجهزة عند ربط جهاز جديد.");
 const id=deviceId(),ref=deviceRef(shopId,id),licenseSnapshot=await getDoc(licenseRef(shopId));
 if(!licenseSnapshot.exists())throw new Error("لا يوجد ترخيص لهذا المحل.");
 const payload=licenseSnapshot.data().payload||{};
 if(payload.licenseType!=="cloud")throw new Error("هذا الترخيص محلي ولا يسمح بربط أجهزة أو مزامنة سحابية.");
 const cap=Math.max(1,Math.min(500,Number(payload.maxDevices)||1));
 const slots=Array.from({length:cap},(_,i)=>deviceSlotRef(shopId,i));
 await runTransaction(cloudDb,async tx=>{
  const lic=await tx.get(licenseRef(shopId)),own=await tx.get(ref);
  if(!lic.exists()||lic.data().payload.status!=="active")throw new Error("الترخيص غير نشط.");
  const current=lic.data().payload;
  if(current.licenseType!=="cloud")throw new Error("نوع الترخيص لا يسمح بالربط السحابي.");
  if(own.exists()&&own.data().active===true){
   tx.update(ref,{lastSeenAt:serverTimestamp(),uid,active:true});
   return;
  }
  const slotSnapshots=[];
  for(const slot of slots)slotSnapshots.push(await tx.get(slot));
  const free=slotSnapshots.findIndex(s=>!s.exists()||s.data().active!==true);
  if(free<0)throw new Error("وصل المحل إلى الحد الأقصى للأجهزة المسموح بها ("+cap+"). اطلب من مدير المنصة زيادة الحد أو إلغاء ربط جهاز قديم.");
  const record={deviceId:id,uid,label:"جهاز "+id.slice(0,8),platform:/Android/i.test(navigator.userAgent)?"Android":"متصفح",userAgent:String(navigator.userAgent||"").slice(0,180),active:true,slot:String(free),linkedAt:serverTimestamp(),lastSeenAt:serverTimestamp()};
  tx.set(ref,record);tx.set(slots[free],{deviceId:id,uid,active:true,updatedAt:serverTimestamp()});
 });
 if(stopOwnDeviceListener)stopOwnDeviceListener();
 stopOwnDeviceListener=onSnapshot(ref,snapshot=>{
  if(!snapshot.exists()||snapshot.data().active!==true){
   if(window.POSGate)window.POSGate.lock("تم إلغاء ربط هذا الجهاز من مدير المنصة. تواصل مع إدارة البرنامج.");
   if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}
   setStatus("تم إلغاء ربط هذا الجهاز؛ تم إيقاف المزامنة.","error");
  }
 });
}
async function downloadLocalLicense(shop){
 if(!isPlatformAdmin)throw new Error("ليس لديك صلاحية مدير المنصة.");
 const snapshot=await getDoc(licenseRef(shop.id));
 if(!snapshot.exists()||!snapshot.data().payload||snapshot.data().payload.licenseType!=="local")throw new Error("لا يوجد ترخيص محلي صادر لهذا المحل.");
 const blob=new Blob([JSON.stringify(snapshot.data(),null,2)],{type:"application/json"});
 const url=URL.createObjectURL(blob),a=document.createElement("a");
 a.href=url;a.download="local-license-"+shop.id+".json";document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url);
 setStatus("تم تجهيز ملف الترخيص المحلي. أرسله للعميل ليستورده على جهازه.","success");
}
async function loadShopDevices(shop){
 const snapshot=await getDocs(query(deviceCollectionRef(shop.id),orderBy("linkedAt","desc")));
 const devices=[];
 for(const d of snapshot.docs){
  const device={id:d.id,...d.data()};
  if(device.uid){try{const member=await getDoc(memberRef(shop.id,device.uid));device.email=member.exists()?String(member.data().email||""):"";}catch(_){device.email="";}}
  devices.push(device);
 }
 return devices;
}
async function unlinkShopDevice(shop,device){
 if(!isPlatformAdmin)throw new Error("ليس لديك صلاحية مدير المنصة.");
 const ref=deviceRef(shop.id,device.id),slot=device.slot;
 await runTransaction(cloudDb,async tx=>{
  const current=await tx.get(ref);if(!current.exists()||current.data().active!==true)return;
  const sr=slot!==undefined&&slot!==null?deviceSlotRef(shop.id,String(slot)):null;
  const ss=sr?await tx.get(sr):null;
  tx.update(ref,{active:false,unlinkedAt:serverTimestamp(),unlinkedBy:activeUser.uid});
  if(ss&&ss.exists()&&ss.data().deviceId===device.id)tx.delete(sr);
 });
 setStatus("تم إلغاء ربط الجهاز. يمكن الآن ربط جهاز بديل.","success");await loadPlatformShops();
}
function formatLicenseState(value){
 if(!value)return "لا يوجد ترخيص";const p=value.payload||{};if(p.status==="suspended")return "موقوف";
 const expiry=Date.parse(p.expiresAt||"");if(!Number.isFinite(expiry))return "ترخيص غير صالح";
 return expiry<=Date.now()?"منتهي":"ساري حتى "+new Date(expiry).toLocaleDateString("ar-EG");
}
async function loadPlatformShops(){
 if(!isPlatformAdmin)return;const root=$("platformShopList");root.innerHTML='<p class="empty">جارٍ تحميل المحلات...</p>';
 try{
  const snapshot=await getDocs(query(collection(cloudDb,"shops"),orderBy("createdAt","desc"),limit(200)));platformShops=[];
  for(const shopDoc of snapshot.docs){const shop={id:shopDoc.id,...shopDoc.data()},licenseSnapshot=await getDoc(licenseRef(shop.id));shop.license=licenseSnapshot.exists()?licenseSnapshot.data():null;platformShops.push(shop);}
  renderPlatformShops();
 }catch(error){root.innerHTML='<p class="empty">تعذر تحميل المحلات: '+firebaseError(error)+'</p>';}
}
function renderPlatformShops(){
 const root=$("platformShopList");if(!root)return;root.replaceChildren();const q=($("platformShopSearch")?.value||"").trim().toLowerCase();
 const rows=platformShops.filter(shop=>(String(shop.name||"")+" "+shop.id+" "+String(shop.ownerUid||"")).toLowerCase().includes(q));
 if(!rows.length){root.innerHTML='<p class="empty">لا توجد محلات مطابقة.</p>';return;}
 rows.forEach(shop=>{
  const row=document.createElement("div");row.className="platform-shop-row";
  const main=document.createElement("div");main.className="platform-shop-main";
  const name=document.createElement("strong");name.textContent=shop.name||"محل بدون اسم";
  const payload=shop.license&&shop.license.payload||null;
  const meta=document.createElement("small");meta.textContent="Shop ID: "+shop.id+" · "+formatLicenseState(shop.license);main.append(name,meta);
  const actions=document.createElement("div");actions.className="platform-shop-actions";
  const policy=document.createElement("div");policy.className="platform-policy";
  const offlineLabel=document.createElement("label"),offline=document.createElement("input");offline.type="checkbox";offline.checked=!payload||payload.offlineAllowed!==false;offline.disabled=!payload||payload.licenseType==="local";
  offlineLabel.append(offline,document.createTextNode(" السماح بالبيع أوفلاين"));
  const cloudLabel=document.createElement("label"),cloud=document.createElement("input");cloud.type="checkbox";cloud.checked=!payload||payload.cloudSyncEnabled!==false;cloud.disabled=!payload||payload.licenseType==="local";
  cloudLabel.append(cloud,document.createTextNode(" تفعيل المزامنة أونلاين"));
  policy.append(offlineLabel,cloudLabel);
  const savePolicy=document.createElement("button");savePolicy.type="button";savePolicy.className="secondary";savePolicy.textContent="حفظ سياسة الاتصال";savePolicy.disabled=!payload||payload.licenseType==="local";
  savePolicy.onclick=async()=>{try{savePolicy.disabled=true;await saveShopPolicy(shop,offline.checked,cloud.checked);}catch(error){$("platformMessage").textContent="تعذر حفظ السياسة: "+firebaseError(error);}finally{savePolicy.disabled=false;}};
  const duration=document.createElement("select");
  [["7d","7 أيام"],["1m","شهر"],["3m","3 أشهر"],["6m","6 أشهر"],["1y","سنة"],["life","مدى الحياة"]].forEach(([v,l])=>{const o=document.createElement("option");o.value=v;o.textContent=l;duration.append(o);});
  const deviceLimit=document.createElement("input");deviceLimit.type="number";deviceLimit.min="1";deviceLimit.max="500";deviceLimit.step="1";deviceLimit.value=String(payload&&payload.maxDevices||1);deviceLimit.title="الحد الأقصى للأجهزة";deviceLimit.setAttribute("aria-label","الحد الأقصى للأجهزة");const deviceLimitLabel=document.createElement("label");deviceLimitLabel.textContent="الحد الأقصى للأجهزة";deviceLimitLabel.append(deviceLimit);
  const licenseType=document.createElement("select");[["cloud","سحابي"],["local","محلي"]].forEach(([v,l])=>{const o=document.createElement("option");o.value=v;o.textContent=l;licenseType.append(o);});licenseType.value=payload&&payload.licenseType||"cloud";
   const offlineRisk=document.createElement("p");offlineRisk.className="hint";
   const updateOfflineRisk=()=>{
    const risky=offline.checked&&licenseType.value==="cloud"&&Number(deviceLimit.value)>1;
    offlineRisk.textContent=risky
     ?"تنبيه تشغيلي: السماح بالأوفلاين مع عدة أجهزة قد يؤدي إلى بيع متزامن من أرصدة قديمة ورصيد سالب بعد المزامنة. لا تسمح بأكثر من جهاز يبيع دون اتصال في الوقت نفسه، أو أوقف الأوفلاين."
     :"";
    offlineRisk.hidden=!risky;
   };
   offline.addEventListener("change",updateOfflineRisk);
   deviceLimit.addEventListener("input",updateOfflineRisk);
   licenseType.addEventListener("change",updateOfflineRisk);
   updateOfflineRisk();
  const activate=document.createElement("button");activate.type="button";activate.className="primary";activate.textContent=payload&&payload.status==="active"?"تجديد/تمديد":"تفعيل";
  if(payload&&payload.plan)duration.value=payload.plan;
  activate.onclick=async()=>{try{await writeLicense(shop,duration.value,"active",Number(deviceLimit.value),licenseType.value,true);}catch(error){$("platformMessage").textContent="تعذر إصدار الترخيص: "+firebaseError(error);}};
  const updateLicense=document.createElement("button");updateLicense.type="button";updateLicense.className="secondary";updateLicense.textContent="حفظ تعديل الترخيص";updateLicense.onclick=async()=>{try{await writeLicense(shop,duration.value,"active",Number(deviceLimit.value),licenseType.value,false);}catch(error){$("platformMessage").textContent="تعذر تعديل الترخيص: "+firebaseError(error);}};
  const suspend=document.createElement("button");suspend.type="button";suspend.className="remove";suspend.textContent="إيقاف";suspend.disabled=!shop.license;
  suspend.onclick=async()=>{if(!confirm("سيتم تعليق ترخيص "+(shop.name||shop.id)+" عند اتصال أجهزته بالإنترنت. الجهاز المنفصل تمامًا لن يستقبل أمر الإيقاف حتى يعود الاتصال. هل تتابع؟"))return;try{await writeLicense(shop,duration.value,"suspended",Number(deviceLimit.value),licenseType.value);}catch(error){$("platformMessage").textContent="تعذر إيقاف الترخيص: "+firebaseError(error);}};
  const exportLocal=document.createElement("button");exportLocal.type="button";exportLocal.className="secondary";exportLocal.textContent="تصدير الترخيص المحلي";exportLocal.hidden=!(payload&&payload.licenseType==="local");exportLocal.onclick=()=>downloadLocalLicense(shop).catch(e=>{$("platformMessage").textContent="تعذر تصدير الترخيص: "+firebaseError(e);});
  actions.append(policy,offlineRisk,savePolicy,duration,deviceLimitLabel,licenseType,updateLicense,activate,suspend,exportLocal);row.append(main,actions);root.append(row);
  const devicePanel=document.createElement("div");devicePanel.className="platform-device-panel";devicePanel.textContent="جارٍ تحميل الأجهزة...";root.append(devicePanel);
  loadShopDevices(shop).then(devices=>{const table=document.createElement("table");table.className="platform-device-table";table.innerHTML="<thead><tr><th>الجهاز</th><th>المستخدم</th><th>النظام</th><th>الحالة</th><th>آخر اتصال</th><th>إجراء</th></tr></thead>";const body=document.createElement("tbody");devices.forEach(device=>{const tr=document.createElement("tr");const cells=[device.label||device.id,device.email||device.uid||"",device.platform||"",device.active?"مرتبط":"غير مرتبط",device.lastSeenAt&&device.lastSeenAt.toDate?device.lastSeenAt.toDate().toLocaleString("ar-EG"):"—"];cells.forEach(v=>{const td=document.createElement("td");td.textContent=String(v);tr.append(td);});const action=document.createElement("td");if(device.active){const b=document.createElement("button");b.type="button";b.className="remove";b.textContent="إلغاء الربط";b.onclick=async()=>{if(!confirm("إلغاء ربط هذا الجهاز؟"))return;try{b.disabled=true;await unlinkShopDevice(shop,device);}catch(e){$("platformMessage").textContent="تعذر إلغاء الربط: "+firebaseError(e);b.disabled=false;}};action.append(b);}else action.textContent="—";tr.append(action);body.append(tr);});table.append(body);devicePanel.replaceChildren(table);const count=document.createElement("p");count.textContent="الأجهزة المرتبطة: "+devices.filter(d=>d.active).length+" / "+(payload&&payload.maxDevices||1);devicePanel.append(count);}).catch(e=>{devicePanel.textContent="تعذر تحميل الأجهزة: "+firebaseError(e);});
 });
 $("platformMessage").textContent="عدد المحلات: "+rows.length+" · إعدادات الأوفلاين والمزامنة موقعة داخل الترخيص؛ المفتاح الخاص لا يُحفظ في التطبيق.";
}
function bindGovernanceUI(){
 if($("cloudEmployeeRegister"))$("cloudEmployeeRegister").addEventListener("click",()=>clickAction(handleEmployeeRegister));
 if($("employeeInviteForm"))$("employeeInviteForm").addEventListener("submit",async event=>{
  event.preventDefault();try{const code=await createEmployeeInvite($("employeeInviteEmail").value,$("employeeInviteRole").value);$("employeeInviteCode").textContent=code;$("employeeInviteCodeBox").hidden=false;$("employeeInviteMessage").textContent="تم إنشاء الدعوة. أرسل الكود والبريد المحدد للموظف.";await loadEmployeeWorkspace();}
  catch(error){$("employeeInviteMessage").textContent="تعذر إنشاء الدعوة: "+firebaseError(error);}
 });
 if($("copyEmployeeInvite"))$("copyEmployeeInvite").onclick=async()=>{try{await navigator.clipboard.writeText($("employeeInviteCode").textContent);$("employeeInviteMessage").textContent="تم نسخ كود الدعوة.";}catch(_){$("employeeInviteMessage").textContent="انسخ كود الدعوة يدويًا.";}};
 if($("licensePrivateKeyFile"))$("licensePrivateKeyFile").addEventListener("change",async event=>{
  const file=event.target.files&&event.target.files[0];if(!file)return;
  try{await importLicenseSigningKey(await file.text());$("licenseKeyStatus").textContent="تم تحميل مفتاح التوقيع لهذه الجلسة فقط. لن يُحفظ داخل التطبيق.";}
  catch(error){licensePrivateKeyPem="";platformKeyPromise=null;$("licenseKeyStatus").textContent="فشل تحميل المفتاح: "+error.message;}
  event.target.value="";
 });
 if($("refreshPlatformShops"))$("refreshPlatformShops").onclick=loadPlatformShops;
 if($("platformShopSearch"))$("platformShopSearch").oninput=renderPlatformShops;
 document.addEventListener("click",event=>{const tab=event.target.closest('[data-view="employees"]');if(tab)setTimeout(loadEmployeeWorkspace,0);});
}

function bindUI() {
  if ($("cloudRegister")) $("cloudRegister").addEventListener("click", () => clickAction(handleRegister));
  if ($("cloudLogin")) $("cloudLogin").addEventListener("click", () => clickAction(handleLogin));
  if ($("cloudCreateShop")) $("cloudCreateShop").addEventListener("click", () => clickAction(handleCreateShop));
  if ($("cloudRetryVerification")) $("cloudRetryVerification").addEventListener("click", () => clickAction(async () => {
    const user = auth.currentUser;
    if (!user || user.isAnonymous) throw new Error("لا توجد جلسة حساب مسجلة لإعادة التحقق.");
    isPlatformAdmin = await verifyPlatformAdmin(user);
    if (window.POSGate) window.POSGate.setPlatformAdmin(isPlatformAdmin);
    if (isPlatformAdmin) {
      if (stopRecordsListener) { stopRecordsListener(); stopRecordsListener = null; }
      stopGovernanceListeners();
      activeShopId = ""; activeShopName = ""; activeMember = null;
      showSignedIn(user, "إدارة المنصة"); applyRoleAccess();
      await loadPlatformShops();
      setStatus("تم التحقق من الحساب كمدير منصة.", "success");
      return;
    }
    const profile = await getDoc(userRef(user.uid));
    const shopId = profile.exists() ? String(profile.data().activeShopId || "") : "";
    if (shopId) {
      await connectExistingShop(user, shopId);
      return;
    }
    const inviteCode = $("cloudInviteCode") && $("cloudInviteCode").value.trim();
    if (inviteCode) {
      await acceptEmployeeInvite(user, inviteCode);
      return;
    }
    await ensureTrialExperience(user, true, "owner");
    showSignedIn(user, "");
    if ($("cloudCreateShop")) $("cloudCreateShop").hidden = false;
    applyRoleAccess();
    setStatus("الحساب متصل، ولم يُربط بمحل بعد. يمكنك إنشاء محل لهذا الحساب.", "info");
  }));
  if ($("cloudSyncNow")) $("cloudSyncNow").addEventListener("click", () => clickAction(async () => {
    if (!activeUser) throw new Error("سجّل الدخول أولًا.");
    const state = readState();
    if (!activeShopId) {
      const profile = await getDoc(userRef(activeUser.uid));
      if (profile.exists() && profile.data().activeShopId) activeShopId = String(profile.data().activeShopId);
    }
    if (!activeShopId) {
      throw new Error("الحساب غير مرتبط بمحل. استخدم زر «إنشاء محل لهذا الحساب» لإنشاء محل جديد صراحةً.");
    }
    if (!state || state.shopId !== activeShopId) {
      const member = await getDoc(memberRef(activeShopId, activeUser.uid));
      const firstPage = await getDocs(query(recordsRef(activeShopId), limit(1)));
      if (firstPage.empty && member.exists() && member.data().role === "owner") {
        const localSnapshot = await window.POSDatabase.backupData();
        if (backupHasBusinessData(localSnapshot) &&
            !window.confirm("المحل السحابي لا يحتوي سجلات حتى الآن. هل تريد رفع بيانات هذا الجهاز لتكون بداية المحل؟")) return;
        const newState = await initialUpload(activeShopId);
        startRealtimeListener(activeShopId);
        const shop = await getDoc(shopRef(activeShopId));
        activeShopName = shop.exists() ? String(shop.data().name || "المحل") : "المحل";
        showSignedIn(activeUser, activeShopName);
        setStatus("تم رفع البيانات الأولية وربط هذا الجهاز بالمحل.", "success");
        return;
      }
      await connectExistingShop(activeUser, activeShopId);
      return;
    }
    await syncNow(true);
  }));
  if ($("cloudSignOut")) $("cloudSignOut").addEventListener("click", () => clickAction(async () => {
    if (!activeUser && !auth.currentUser) throw new Error("لا يوجد حساب مسجل للخروج منه.");
    if (!window.confirm("سيتم تسجيل الخروج وقفل الوصول المحلي حتى تسجل الدخول مجددًا. بيانات المحل لن تُحذف. هل تريد المتابعة؟")) return;
    localStorage.setItem(EXPLICIT_SIGNOUT_KEY,"1");
    if (stopRecordsListener) { stopRecordsListener(); stopRecordsListener = null; }
    stopGovernanceListeners();
    await signOut(auth);
    if(window.POSGate)window.POSGate.setSession(null);
    activeUser=null;activeShopId="";activeShopName="";activeMember=null;
    showSignedIn(null,"");applyRoleAccess();
    setStatus("تم تسجيل الخروج بأمان. بيانات المحل ما زالت محفوظة على الجهاز، لكنها مقفولة حتى تعيد تسجيل الدخول.","info");
  }));
  if ($("requestAccountDeletion")) $("requestAccountDeletion").addEventListener("click", () => clickAction(async () => {
    if(!window.confirm("سيتم إرسال طلب حذف الحساب إلى إدارة Cashiro لمراجعته. لن تُحذف بيانات المحل أو الفواتير تلقائيًا. هل تريد المتابعة؟")) return;
    const button=$("requestAccountDeletion");button.disabled=true;
    try { await submitAccountDeletionRequest();button.textContent="تم إرسال طلب الحذف"; }
    catch(error) { button.disabled=false;throw error; }
  }));
}
function wrapLocalMutations() {
  if (!window.POSDatabase || window.POSDatabase.__cloudWrapped) return;
  const methods = [
    "saveProduct", "saveProducts", "deleteProduct", "setProductActive", "saveInvoice",
    "saveSupplier", "saveSupplierPayment", "savePurchase", "saveStockAdjustment",
    "saveStocktake", "saveCustomer", "saveCustomerPayment", "saveReturn",
    "saveCashEntry", "saveShift", "saveSettings", "restoreData"
  ];
  methods.forEach(name => {
    const original = window.POSDatabase[name];
    if (typeof original !== "function") return;
    window.POSDatabase[name] = async function () {
      if(window.POSGate)window.POSGate.assertMutation(name);
      const result = await original.apply(this, arguments);
      scheduleSync();
      return result;
    };
  });
  window.POSDatabase.__cloudWrapped = true;
}

bindUI();
wrapLocalMutations();
bindGovernanceUI();
window.POSCloudPrepareLocalMode=async()=>{if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}stopGovernanceListeners();if(window.POSGate)window.POSGate.setSession(null);if(auth.currentUser)await signOut(auth);activeUser=null;activeShopId="";activeShopName="";activeMember=null;applyRoleAccess();};
onAuthStateChanged(auth, async user => {
  if (user && user.isAnonymous) {
    activeUser = null;
    try { await ensureTrialExperience(user); }
    catch (error) { setStatus("تعذر بدء التجربة: " + firebaseError(error), "warning"); }
    showSignedIn(null, "");
    applyRoleAccess();
    return;
  }
  activeUser = user || null;
  if (user) localStorage.removeItem(EXPLICIT_SIGNOUT_KEY);
  if (user && window.POSGate && typeof window.POSGate.suspendTrial === "function") {
    window.POSGate.suspendTrial();
  }
  if (!user) {
    if (stopRecordsListener) { stopRecordsListener(); stopRecordsListener = null; }
    stopGovernanceListeners();
    isPlatformAdmin = false;
    if(window.POSGate)window.POSGate.setPlatformAdmin(false);
    const savedSession=window.POSGate&&window.POSGate.getSession?window.POSGate.getSession():null;
    activeMember=savedSession&&savedSession.active?savedSession:null;
    activeShopId=activeMember?activeMember.shopId:"";
    activeShopName="";
    showSignedIn(null,"");
    applyRoleAccess();
    if(activeShopId&&window.POSDatabase){
      try{const settings=await window.POSDatabase.getSettings();activeShopName=settings.shopName||"المحل";}catch(_){activeShopName="المحل";}
      if($("shopTitle"))$("shopTitle").textContent=activeShopName;
    }
    if(window.POSGate&&window.POSGate.canOperateLocally()){
      const saved=window.POSGate.getSession();
      setStatus(saved&&saved.trial?trialMessage():"وضع التشغيل المحلي مفعل. بيانات هذا الجهاز محفوظة، وسيتم الاتصال السحابي عند تسجيل الدخول إذا كانت المزامنة مسموحة.","warning");
    }else if(!savedSession&&!localStorage.getItem(LAST_REAL_UID_KEY)){
      try { await ensureTrialExperience(null); }
      catch(error){ setStatus("تعذر بدء التجربة المجانية: "+firebaseError(error),"warning"); }
    }else if(window.POSGate&&window.POSGate.isManaged()){
      const explicitlySignedOut=localStorage.getItem(EXPLICIT_SIGNOUT_KEY)==="1";
      setStatus(explicitlySignedOut
        ? "تم تسجيل الخروج. بيانات المحل محفوظة على الجهاز لكنها مقفولة حتى تسجل الدخول مرة أخرى."
        : "لا توجد جلسة تشغيل محلية صالحة لهذا المحل. اتصل بالإنترنت للتحقق من الحساب والسياسة.",
        explicitlySignedOut?"info":"error");
    }
    return;
  }
  localStorage.setItem(LAST_REAL_UID_KEY,user.uid);
  const state = readState();
  const previousGateSession=window.POSGate&&window.POSGate.getSession?window.POSGate.getSession():null;
  try {
    isPlatformAdmin=await verifyPlatformAdmin(user);
    if(window.POSGate)window.POSGate.setPlatformAdmin(isPlatformAdmin);
    if(isPlatformAdmin){
      // Platform administrators are not shop members and must never enter
      // the shop license / device activation flow.
      if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}
      stopGovernanceListeners();
      activeShopId="";
      activeShopName="";
      activeMember=null;
      showSignedIn(user,"إدارة المنصة");
      if($("cloudAuthPanel"))$("cloudAuthPanel").hidden=true;
      if($("cloudConnectedPanel"))$("cloudConnectedPanel").hidden=false;
      if($("cloudCreateShop"))$("cloudCreateShop").hidden=true;
      if($("cloudSyncNow"))$("cloudSyncNow").hidden=true;
      applyRoleAccess();
      setStatus("تم التحقق من صلاحية مدير المنصة. إدارة المحلات والتراخيص متاحة دون ترخيص تشغيل على هذا الجهاز.","success");
      await loadPlatformShops();
      return;
    }
    const profile = await getDoc(userRef(user.uid));
    const shopId = profile.exists() ? String(profile.data().activeShopId || "") : "";
    if (!shopId) {
      if(isPlatformAdmin){if($("cloudCreateShop"))$("cloudCreateShop").hidden=true;applyRoleAccess();return;}
      const pendingInviteCode=$("cloudInviteCode")&&$("cloudInviteCode").value.trim();
      // Do not grant a temporary owner session while an employee invitation
      // is being accepted; the employee role is applied after membership lookup.
      if(!pendingInviteCode)await ensureTrialExperience(user,true,"owner");
      showSignedIn(user, "");setStatus(pendingInviteCode?"الحساب جاهز لقبول دعوة الموظف. أدخل كود الدعوة واضغط إنشاء حساب موظف وقبول الدعوة.":"الحساب مسجل. أكمل إنشاء المحل أو استخدم كود دعوة الموظف.", "info");
      if ($("cloudCreateShop")) $("cloudCreateShop").hidden = false;return;
    }
    const member = await getDoc(memberRef(shopId, user.uid));
    if (!member.exists() || member.data().active !== true) throw new Error("لا توجد عضوية نشطة لهذا الحساب.");
    const shop = await getDoc(shopRef(shopId));
    activeShopId = shopId;
    activeShopName = shop.exists() ? String(shop.data().name || "المحل") : "المحل";
    activeMember=member.data();localStorage.setItem(MANAGED_SHOP_KEY,shopId);
    const identityChanged=!previousGateSession||previousGateSession.uid!==user.uid||previousGateSession.shopId!==shopId||previousGateSession.role!==activeMember.role;
    setGateSession();
    showSignedIn(user, activeShopName);applyRoleAccess();
    startMemberListener(shopId,user.uid);
    const licensed=await checkShopLicense(shopId);startLicenseListener(shopId);if(!licensed)return;if(window.POSGate&&window.POSGate.isCloudLicense())await registerCurrentDevice(shopId,user.uid);
    if(window.POSGate&&!window.POSGate.isCloudSyncEnabled()){
      setStatus("الحساب والترخيص تم التحقق منهما. المزامنة السحابية موقوفة من مدير المشروع؛ لن يتم تنزيل أو رفع بيانات.","warning");
      return;
    }
    const localSnapshot=await window.POSDatabase.backupData();
    const localDataExists=backupHasBusinessData(localSnapshot);
    const stateHasRecords=!!(state&&Object.keys(state.records||{}).length);
    const localDataWasCleared=!localDataExists&&stateHasRecords;
    if(!state||state.shopId!==shopId||identityChanged||localDataWasCleared){
      if(localDataExists&&(identityChanged||!state||state.shopId!==shopId)){
        const accepted=window.confirm("هذا الجهاز يحتوي بيانات لحساب أو محل سابق. سيتم استبدالها بالبيانات المسموح بها للحساب الحالي. صدّر نسخة احتياطية أولًا إن كنت تحتاجها. هل تريد المتابعة؟");
        if(!accepted){setStatus("تم إلغاء تبديل الحساب. لن يبقى الحساب الجديد متصلًا ببيانات الجهاز السابقة.","warning");await signOut(auth);return;}
      }
      setStatus("جارٍ تنزيل البيانات المسموح بها لهذا الدور وحذف بيانات الأدوار الأخرى من الجهاز...", "info");
      await restoreFullShop(shopId);
      setStatus("تم ربط الحساب وتنزيل بيانات الدور الحالي.", "success");
    } else {
      startRealtimeListener(shopId);
      setStatus("المحل متصل. ستتم المزامنة تلقائيًا عند إجراء تعديل أو عودة الإنترنت.", "success");
      if (navigator.onLine) setTimeout(() => syncNow(false), 2500);
    }
  } catch (error) {
    if(error&&String(error.message||"").includes("PLATFORM_ADMIN_CHECK_FAILED")){
      showSignedIn(user,"");
      if($("cloudCreateShop"))$("cloudCreateShop").hidden=true;
      if($("cloudRetryVerification"))$("cloudRetryVerification").hidden=false;
      if(window.POSGate)window.POSGate.setPlatformAdmin(false);
      setStatus("الحساب مسجل الدخول بالفعل، لكن تعذر التحقق من صلاحياته بسبب الاتصال بقاعدة البيانات. لا تنشئ حسابًا جديدًا؛ اضغط «إعادة التحقق من الحساب والصلاحيات» عند عودة الاتصال.", "warning");
      return;
    }
    showSignedIn(user, "");
    if($("cloudRetryVerification")&&user)$("cloudRetryVerification").hidden=false;
    if(window.POSGate&&window.POSGate.canOperateLocally()){
      const saved=window.POSGate.getSession();
      if(saved){activeShopId=saved.shopId;activeMember=saved;applyRoleAccess();}
      setStatus(firebaseError(error)+" سيستمر التشغيل المحلي وفق سياسة المحل.","warning");
    }else{
      if(window.POSGate&&window.POSGate.isManaged())window.POSGate.lock("تعذر التحقق من الحساب أو سياسة الترخيص. اتصل بالإنترنت.");
      setStatus(firebaseError(error), "error");
    }
  }
});
window.addEventListener("online", () => {
  if (auth.currentUser && auth.currentUser.isAnonymous) {
    ensureTrialExperience(auth.currentUser).catch(error=>setStatus("تعذر تحديث تاريخ التجربة: "+firebaseError(error),"warning"));
    return;
  }
  if (!auth.currentUser && !localStorage.getItem(LAST_REAL_UID_KEY)) {
    ensureTrialExperience(null).catch(error=>setStatus("تعذر تثبيت تاريخ التجربة: "+firebaseError(error),"warning"));
    return;
  }
  if (activeUser && activeShopId && (!window.POSGate||window.POSGate.isCloudSyncEnabled())) setTimeout(() => syncNow(true), 1200);
});
