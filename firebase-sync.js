import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth,
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
  ["cloudRegister", "cloudLogin", "cloudCreateShop", "cloudSyncNow", "cloudSignOut"].forEach(id => {
    const node = $(id);
    if (node) node.disabled = !!busy;
  });
}
function showSignedIn(user, shopName) {
  activeUser = user;
  if ($("cloudAuthPanel")) $("cloudAuthPanel").hidden = !!(user && shopName);
  if ($("cloudConnectedPanel")) $("cloudConnectedPanel").hidden = !(user && shopName);
  if ($("cloudCreateShop")) $("cloudCreateShop").hidden = !(user && !shopName);
  if ($("cloudAccountEmail")) $("cloudAccountEmail").textContent = user ? (user.email || "حساب Google/Firebase") : "";
  if ($("cloudConnectedShop")) $("cloudConnectedShop").textContent = shopName || "";
  if ($("shopTitle") && user && shopName) $("shopTitle").textContent = shopName;
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
  await window.POSDatabase.saveSettings({ shopName: name });
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
  setStatus("تم إنشاء المحل السحابي. جارٍ رفع بيانات هذا الجهاز لأول مرة...", "info");
  const state = await initialUpload(newShop.id);
  startRealtimeListener(newShop.id);
  startMemberListener(newShop.id,user.uid);
  const licensed=await checkShopLicense(newShop.id);
  if(licensed)startLicenseListener(newShop.id);
  setStatus(licensed?"تم إنشاء المحل ورفع البيانات الأولية إلى السحابة.":"تم إنشاء المحل؛ ينتظر إصدار الترخيص من مدير المشروع.","warning");
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
  if(licensed)startLicenseListener(shopId);
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
  const email = $("cloudEmail").value.trim();
  const password = $("cloudPassword").value;
  if (!email || !password) throw new Error("اكتب البريد الإلكتروني وكلمة المرور.");
  const credential = await signInWithEmailAndPassword(auth, email, password);
  activeUser = credential.user;
  const profile = await getDoc(userRef(credential.user.uid));
  const profileData = profile.exists() ? profile.data() : {};
  if (profileData.activeShopId) {
    await connectExistingShop(credential.user, String(profileData.activeShopId));
    return;
  }
  const inviteCode=$("cloudInviteCode")?.value.trim();
  if(inviteCode){await acceptEmployeeInvite(credential.user,inviteCode);return;}
  showSignedIn(credential.user,"");
  if($("cloudCreateShop"))$("cloudCreateShop").hidden=false;
  setStatus("الحساب غير مرتبط بمحل. لم ننشئ محلًا تلقائيًا ولم نغيّر بيانات الجهاز. اضغط «إنشاء محل لهذا الحساب» فقط عند رغبتك في إنشاء محل جديد.","warning");
}
async function handleEmployeeRegister(){
  const email=$("cloudEmail").value.trim(),password=$("cloudPassword").value,code=$("cloudInviteCode").value.trim();
  if(!email||!password||password.length<6||!code)throw new Error("اكتب البريد وكلمة المرور وكود الدعوة الصحيح.");
  const credential=await createUserWithEmailAndPassword(auth,email,password);activeUser=credential.user;await acceptEmployeeInvite(credential.user,code);
}
async function handleRegister() {
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
 const role=activeMember&&activeMember.role||"",allowed=new Set(ROLE_VIEWS[role]||[]);
 document.querySelectorAll(".tabs [data-view]").forEach(button=>{const name=button.dataset.view;button.hidden=name==="platform"?!isPlatformAdmin:!allowed.has(name);});
 if($("employeesTab"))$("employeesTab").hidden=role!=="owner";
 if($("platformTab"))$("platformTab").hidden=!isPlatformAdmin;
 if($("cloudAccountRole"))$("cloudAccountRole").textContent=activeMember?roleLabel(role):(isPlatformAdmin?"مدير المشروع":"غير مرتبط");
 if($("cloudAccountUid"))$("cloudAccountUid").textContent=activeUser?activeUser.uid:"";
 if($("employeeOwnerPanel"))$("employeeOwnerPanel").hidden=role!=="owner";
 if($("employeeAccessMessage"))$("employeeAccessMessage").textContent=role==="owner"?"يمكنك دعوة الموظفين وإيقاف حساباتهم وتغيير أدوارهم.":"إدارة الموظفين متاحة لصاحب المحل فقط.";
 if($("platformAdminEmail"))$("platformAdminEmail").textContent=activeUser&&activeUser.email||"";
 if($("platformAdminUid"))$("platformAdminUid").textContent=activeUser&&activeUser.uid||"";
 const current=document.querySelector(".tab.active");
 if(current&&!current.hidden)return;
 const first=document.querySelector('.tab[data-view="sale"]:not([hidden])')||document.querySelector('.tab:not([hidden])');
 if(first)first.click();
}
function platformAdminRef(uid){return doc(cloudDb,"platformAdmins",uid);}
function employeeInviteRef(code){return doc(cloudDb,"employeeInvites",code);}
function licenseRef(shopId){return doc(cloudDb,"licenses",shopId);}
function memberCollection(shopId){return collection(cloudDb,"shops",shopId,"members");}
function stopGovernanceListeners(){if(stopMemberListener){stopMemberListener();stopMemberListener=null;}if(stopLicenseListener){stopLicenseListener();stopLicenseListener=null;}}
async function verifyPlatformAdmin(user){
 if(!user)return false;
 try{const snapshot=await getDoc(platformAdminRef(user.uid));return snapshot.exists()&&snapshot.data().active===true;}
 catch(error){console.warn("Platform admin check unavailable",error);return false;}
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
    if(window.POSGate)window.POSGate.lock("لا يوجد ترخيص صادر لهذا المحل. تواصل مع مدير المشروع لإصدار ترخيص.");
    setStatus("لا يوجد ترخيص ساري لهذا المحل. التشغيل المحلي المستقل يظل متاحًا قبل ربط المحل.","error");return false;
   }
   licenseDocument=snapshot.data();
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
   if(window.POSGate)window.POSGate.lock("تم سحب الترخيص أو لم يعد موجودًا. اتصل بمدير المشروع.");
   if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}
   setStatus("الترخيص غير موجود؛ تم إيقاف الاستخدام.","error");return;
  }
  const valid=await window.POSGate.applyLicense(snapshot.data(),shopId,true,true);
  if(!valid||!window.POSGate.isCloudSyncEnabled()){
   if(stopRecordsListener){stopRecordsListener();stopRecordsListener=null;}
  }else{
   startRealtimeListener(shopId);
   if(activeUser&&navigator.onLine)setTimeout(()=>syncNow(false),800);
  }
  setStatus(valid?"تم تحديث الترخيص وسياسة الاتصال مركزيًا.":"أوقف مدير المشروع الترخيص أو انتهت مدته.",valid?"success":"error");
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
async function writeLicense(shop,months,status){
 if(!isPlatformAdmin)throw new Error("ليس لديك صلاحية مدير المشروع.");
 if(!licensePrivateKeyPem)throw new Error("ارفع ملف مفتاح التوقيع الخاص أولًا.");
 const now=new Date(),nowIso=now.toISOString(),oldSnapshot=await getDoc(licenseRef(shop.id)),old=oldSnapshot.exists()?oldSnapshot.data().payload:null;
 let start=new Date(now);
 if(status==="active"&&old&&old.status==="active"&&Date.parse(old.expiresAt)>now.getTime())start=new Date(old.expiresAt);
 let expires=status==="active"?addCalendarMonths(start,months):new Date(old&&old.expiresAt||nowIso);
 if(status==="active"&&expires.getTime()<=now.getTime())expires=addCalendarMonths(now,months);
 const payload={schema:1,shopId:shop.id,shopName:String(shop.name||"المحل"),ownerUid:String(shop.ownerUid||""),status,planMonths:Number(months)||0,issuedAt:nowIso,validFrom:status==="active"?nowIso:old&&old.validFrom||nowIso,expiresAt:expires.toISOString(),offlineAllowed:old?old.offlineAllowed!==false:true,cloudSyncEnabled:old?old.cloudSyncEnabled!==false:true,issuerUid:activeUser.uid};
 const signature=await signLicensePayload(payload),batch=writeBatch(cloudDb);
 batch.set(licenseRef(shop.id),{payload,signature,updatedAt:serverTimestamp()});await batch.commit();
 setStatus(status==="active"?"تم إصدار/تجديد الترخيص بنجاح.":"تم تعليق الترخيص مركزيًا.","success");await loadPlatformShops();
}
async function saveShopPolicy(shop,offlineAllowed,cloudSyncEnabled){
 if(!isPlatformAdmin)throw new Error("ليس لديك صلاحية مدير المشروع.");
 if(!licensePrivateKeyPem)throw new Error("ارفع ملف مفتاح التوقيع الخاص أولًا.");
 const snapshot=await getDoc(licenseRef(shop.id));
 if(!snapshot.exists()||!snapshot.data().payload)throw new Error("فعّل ترخيص المحل أولًا قبل ضبط سياسة الاتصال.");
 const payload={...snapshot.data().payload,offlineAllowed:!!offlineAllowed,cloudSyncEnabled:!!cloudSyncEnabled,policyUpdatedAt:new Date().toISOString(),issuerUid:activeUser.uid};
 const signature=await signLicensePayload(payload),batch=writeBatch(cloudDb);
 batch.set(licenseRef(shop.id),{payload,signature,updatedAt:serverTimestamp()});await batch.commit();
 setStatus("تم حفظ سياسة الأوفلاين والأونلاين للمحل وإعادة توقيع الترخيص.","success");
 await loadPlatformShops();
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
  const offlineLabel=document.createElement("label"),offline=document.createElement("input");offline.type="checkbox";offline.checked=!payload||payload.offlineAllowed!==false;offline.disabled=!payload;
  offlineLabel.append(offline,document.createTextNode(" السماح بالبيع أوفلاين"));
  const cloudLabel=document.createElement("label"),cloud=document.createElement("input");cloud.type="checkbox";cloud.checked=!payload||payload.cloudSyncEnabled!==false;cloud.disabled=!payload;
  cloudLabel.append(cloud,document.createTextNode(" تفعيل المزامنة أونلاين"));
  policy.append(offlineLabel,cloudLabel);
  const savePolicy=document.createElement("button");savePolicy.type="button";savePolicy.className="secondary";savePolicy.textContent="حفظ سياسة الاتصال";savePolicy.disabled=!payload;
  savePolicy.onclick=async()=>{try{savePolicy.disabled=true;await saveShopPolicy(shop,offline.checked,cloud.checked);}catch(error){$("platformMessage").textContent="تعذر حفظ السياسة: "+firebaseError(error);}finally{savePolicy.disabled=false;}};
  const duration=document.createElement("select");
  [[1,"شهر واحد"],[6,"6 شهور"],[12,"سنة كاملة"]].forEach(([v,l])=>{const o=document.createElement("option");o.value=String(v);o.textContent=l;duration.append(o);});
  const activate=document.createElement("button");activate.type="button";activate.className="primary";activate.textContent=payload&&payload.status==="active"?"تجديد/تمديد":"تفعيل";
  activate.onclick=async()=>{try{await writeLicense(shop,Number(duration.value),"active");}catch(error){$("platformMessage").textContent="تعذر إصدار الترخيص: "+firebaseError(error);}};
  const suspend=document.createElement("button");suspend.type="button";suspend.className="remove";suspend.textContent="إيقاف";suspend.disabled=!shop.license;
  suspend.onclick=async()=>{if(!confirm("سيتم تعليق ترخيص "+(shop.name||shop.id)+" عند اتصال أجهزته بالإنترنت. الجهاز المنفصل تمامًا لن يستقبل أمر الإيقاف حتى يعود الاتصال. هل تتابع؟"))return;try{await writeLicense(shop,Number(duration.value),"suspended");}catch(error){$("platformMessage").textContent="تعذر إيقاف الترخيص: "+firebaseError(error);}};
  actions.append(policy,savePolicy,duration,activate,suspend);row.append(main,actions);root.append(row);
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
    if (stopRecordsListener) { stopRecordsListener(); stopRecordsListener = null; }
    stopGovernanceListeners();
    await signOut(auth);
    const saved=window.POSGate&&window.POSGate.getSession?window.POSGate.getSession():null;
    activeShopId=saved?saved.shopId:"";
    activeMember=saved&&saved.active?saved:null;
    activeShopName="";
    showSignedIn(null,"");applyRoleAccess();
    setStatus("تم فصل الحساب السحابي مع الاحتفاظ بصلاحية التشغيل المحلية وبيانات الجهاز. إيقاف الموظف إداريًا يصل إلى هذا الجهاز عند عودة الاتصال.","info");
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
onAuthStateChanged(auth, async user => {
  activeUser = user || null;
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
      setStatus("وضع التشغيل المحلي مفعل. بيانات هذا الجهاز محفوظة، وسيتم الاتصال السحابي عند تسجيل الدخول إذا كانت المزامنة مسموحة.","warning");
    }else if(window.POSGate&&window.POSGate.isManaged()){
      setStatus("لا توجد جلسة تشغيل محلية صالحة لهذا المحل. اتصل بالإنترنت للتحقق من الحساب والسياسة.","error");
    }
    return;
  }
  const state = readState();
  const previousGateSession=window.POSGate&&window.POSGate.getSession?window.POSGate.getSession():null;
  try {
    isPlatformAdmin=await verifyPlatformAdmin(user);
    if(window.POSGate)window.POSGate.setPlatformAdmin(isPlatformAdmin);
    if(isPlatformAdmin){
      showSignedIn(user,"إدارة المنصة");
      if($("cloudAuthPanel"))$("cloudAuthPanel").hidden=true;
      if($("cloudConnectedPanel"))$("cloudConnectedPanel").hidden=false;
      if($("cloudSyncNow"))$("cloudSyncNow").hidden=true;
      applyRoleAccess();loadPlatformShops();
    }
    const profile = await getDoc(userRef(user.uid));
    const shopId = profile.exists() ? String(profile.data().activeShopId || "") : "";
    if (!shopId) {
      if(isPlatformAdmin){if($("cloudCreateShop"))$("cloudCreateShop").hidden=true;applyRoleAccess();return;}
      showSignedIn(user, "");setStatus("الحساب مسجل. أكمل إنشاء المحل أو استخدم كود دعوة الموظف.", "info");
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
    const licensed=await checkShopLicense(shopId);if(licensed)startLicenseListener(shopId);if(!licensed)return;
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
    showSignedIn(user, "");
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
  if (activeUser && activeShopId && (!window.POSGate||window.POSGate.isCloudSyncEnabled())) setTimeout(() => syncNow(true), 1200);
});
