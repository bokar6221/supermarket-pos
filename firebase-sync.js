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
const $ = id => document.getElementById(id);
let activeUser = null;
let activeShopId = "";
let activeShopName = "";
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
  for (const store of SYNC_STORES) {
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
  let last = null;
  while (true) {
    const base = [recordsRef(shopId), orderBy("updatedAt"), orderBy(documentId())];
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
    if (!SYNC_STORES.includes(value.store) || typeof value.recordId !== "string") {
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
  showSignedIn(user, name);
  setStatus("تم إنشاء المحل السحابي. جارٍ رفع بيانات هذا الجهاز لأول مرة...", "info");
  const state = await initialUpload(newShop.id);
  startRealtimeListener(newShop.id);
  setStatus("تم إنشاء المحل ورفع البيانات الأولية إلى السحابة.", "success");
  return state;
}
async function connectExistingShop(user, shopId) {
  const member = await getDoc(memberRef(shopId, user.uid));
  if (!member.exists() || member.data().active !== true) throw new Error("هذا الحساب ليس عضوًا نشطًا في المحل المحدد.");
  const shop = await getDoc(shopRef(shopId));
  if (!shop.exists()) throw new Error("بيانات المحل غير موجودة في السحابة.");
  activeShopId = shopId;
  activeShopName = String(shop.data().name || "المحل");
  showSignedIn(user, activeShopName);
  startRealtimeListener(shopId);
  const oldState = readState();
  if (oldState && oldState.shopId === shopId) {
    const currentSnapshot = await window.POSDatabase.backupData();
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
        setStatus("لم يتم استبدال بيانات هذا الجهاز.", "warning");
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
  const base = [recordsRef(state.shopId), orderBy("updatedAt"), orderBy(documentId())];
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
      if (!SYNC_STORES.includes(remote.store) || typeof remote.recordId !== "string") continue;
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
  if (stopRecordsListener) {
    stopRecordsListener();
    stopRecordsListener = null;
  }
  const cloudQuery = query(recordsRef(shopId), orderBy("updatedAt"), orderBy(documentId()));
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
  if (!navigator.onLine) {
    setStatus("دون إنترنت. البيع محفوظ محليًا وستتم المزامنة عند عودة الاتصال.", "warning");
    return;
  }
  const state = readState();
  if (!activeUser || !activeShopId || !state || state.shopId !== activeShopId) {
    setStatus("سجّل الدخول واربط هذا الجهاز بالمحل أولًا.", "warning");
    return;
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
  await createShopForUser(credential.user, $("cloudShopName").value.trim());
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
      await createShopForUser(activeUser, $("cloudShopName").value.trim());
      return;
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
    await signOut(auth);
    activeShopId = "";
    activeShopName = "";
    showSignedIn(null, "");
    setStatus("تم تسجيل الخروج. ستظل البيانات المحلية محفوظة على هذا الجهاز.", "info");
  }));
}
function wrapLocalMutations() {
  if (!window.POSDatabase || window.POSDatabase.__cloudWrapped) return;
  const methods = [
    "saveProduct", "saveProducts", "deleteProduct", "saveInvoice",
    "saveSupplier", "saveSupplierPayment", "savePurchase", "saveStockAdjustment",
    "saveStocktake", "saveCustomer", "saveCustomerPayment", "saveReturn",
    "saveCashEntry", "saveShift", "saveSettings", "restoreData"
  ];
  methods.forEach(name => {
    const original = window.POSDatabase[name];
    if (typeof original !== "function") return;
    window.POSDatabase[name] = async function () {
      const result = await original.apply(this, arguments);
      scheduleSync();
      return result;
    };
  });
  window.POSDatabase.__cloudWrapped = true;
}

bindUI();
wrapLocalMutations();
onAuthStateChanged(auth, async user => {
  activeUser = user || null;
  if (!user) {
    if (stopRecordsListener) { stopRecordsListener(); stopRecordsListener = null; }
    activeShopId = "";
    activeShopName = "";
    showSignedIn(null, "");
    return;
  }
  const state = readState();
  try {
    const profile = await getDoc(userRef(user.uid));
    const shopId = profile.exists() ? String(profile.data().activeShopId || "") : "";
    if (!shopId) {
      showSignedIn(user, "");
      setStatus("الحساب مسجل. أكمل إنشاء المحل من زر إنشاء المحل.", "info");
      if ($("cloudCreateShop")) $("cloudCreateShop").hidden = false;
      return;
    }
    const member = await getDoc(memberRef(shopId, user.uid));
    if (!member.exists() || member.data().active !== true) throw new Error("لا توجد عضوية نشطة لهذا الحساب.");
    const shop = await getDoc(shopRef(shopId));
    activeShopId = shopId;
    activeShopName = shop.exists() ? String(shop.data().name || "المحل") : "المحل";
    showSignedIn(user, activeShopName);
    if (state && state.shopId === shopId) {
      startRealtimeListener(shopId);
      setStatus("المحل متصل. ستتم المزامنة تلقائيًا عند إجراء تعديل أو عودة الإنترنت.", "success");
      if (navigator.onLine) setTimeout(() => syncNow(false), 2500);
    } else {
      setStatus("سجّل الدخول على هذا الجهاز ثم اضغط مزامنة الآن لتنزيل بيانات المحل.", "info");
    }
  } catch (error) {
    showSignedIn(user, "");
    setStatus(firebaseError(error), "error");
  }
});
window.addEventListener("online", () => {
  if (activeUser && activeShopId) setTimeout(() => syncNow(true), 1200);
});
