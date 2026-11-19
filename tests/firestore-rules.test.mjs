import fs from "node:fs";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  writeBatch
} from "firebase/firestore";

const projectId = "demo-supermarket-pos";
const shopId = "shop-a";
const otherShopId = "shop-b";
const testEnv = await initializeTestEnvironment({
  projectId,
  firestore: { rules: fs.readFileSync("firestore.rules", "utf8") }
});

function recordRef(db, targetShopId, id) {
  return doc(db, "shops", targetShopId, "records", id);
}
function recordData(store, recordId) {
  return {
    store,
    recordId,
    data: { id: recordId, name: "اختبار" },
    deleted: false,
    deviceId: "rules-test-device",
    clientUpdatedAt: Date.now(),
    updatedAt: serverTimestamp()
  };
}
async function seed() {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "shops", shopId), {
      ownerUid: "owner",
      name: "محل الاختبار",
      currency: "EGP",
      schemaVersion: 1
    });
    await setDoc(doc(db, "shops", otherShopId), {
      ownerUid: "other-owner",
      name: "محل آخر",
      currency: "EGP",
      schemaVersion: 1
    });
    for (const [uid, role] of [
      ["owner", "owner"],
      ["manager", "manager"],
      ["cashier", "cashier"],
      ["accountant", "accountant"]
    ]) {
      await setDoc(doc(db, "shops", shopId, "members", uid), {
        uid, email: uid + "@example.test", role, active: true
      });
    }
    await setDoc(doc(db, "shops", otherShopId, "members", "other-owner"), {
      uid: "other-owner", role: "owner", active: true
    });
    await setDoc(doc(db, "licenses", shopId), {
      payload: { licenseType: "cloud", maxDevices: 2, status: "active" },
      signature: "test-only"
    });
    await setDoc(doc(db, "platformAdmins", "platform-admin"), { active: true });
    await setDoc(recordRef(db, shopId, "products--p1"), {
      ...recordData("products", "p1"),
      updatedAt: new Date()
    });
    await setDoc(recordRef(db, shopId, "cashEntries--c1"), {
      ...recordData("cashEntries", "c1"),
      updatedAt: new Date()
    });
    await setDoc(recordRef(db, otherShopId, "products--secret"), {
      ...recordData("products", "secret"),
      updatedAt: new Date()
    });
  });
}

async function test() {
  try {
    await seed();
    const anonymous = testEnv.unauthenticatedContext().firestore();
    const owner = testEnv.authenticatedContext("owner").firestore();
    const manager = testEnv.authenticatedContext("manager").firestore();
    const cashier = testEnv.authenticatedContext("cashier").firestore();
    const accountant = testEnv.authenticatedContext("accountant").firestore();
    const platformAdmin = testEnv.authenticatedContext("platform-admin").firestore();
    const outsider = testEnv.authenticatedContext("outsider").firestore();

    await assertFails(getDoc(recordRef(anonymous, shopId, "products--p1")));
    await assertSucceeds(getDoc(recordRef(owner, shopId, "products--p1")));
    await assertFails(getDoc(recordRef(outsider, shopId, "products--p1")));
    await assertFails(getDoc(recordRef(accountant, otherShopId, "products--secret")));

    await assertSucceeds(setDoc(
      recordRef(cashier, shopId, "invoices--cashier-sale"),
      recordData("invoices", "cashier-sale")
    ));
    await assertSucceeds(getDoc(recordRef(cashier, shopId, "products--p1")));
    await assertFails(getDoc(recordRef(cashier, shopId, "cashEntries--c1")));
    await assertFails(setDoc(
      recordRef(cashier, shopId, "cashEntries--forbidden"),
      recordData("cashEntries", "forbidden")
    ));

    await assertSucceeds(getDoc(recordRef(accountant, shopId, "cashEntries--c1")));
    await assertSucceeds(setDoc(
      recordRef(accountant, shopId, "cashEntries--accountant"),
      recordData("cashEntries", "accountant")
    ));
    await assertFails(getDoc(recordRef(manager, shopId, "settings--private")));
    await assertSucceeds(setDoc(
      recordRef(manager, shopId, "products--manager-product"),
      recordData("products", "manager-product")
    ));

    await assertFails(setDoc(
      doc(cashier, "licenses", shopId),
      { payload: { status: "active" }, signature: "forged" }
    ));
    await assertSucceeds(getDoc(doc(platformAdmin, "licenses", shopId)));
    await assertSucceeds(setDoc(
      doc(platformAdmin, "licenses", shopId),
      { payload: { licenseType: "cloud", maxDevices: 2, status: "active" }, signature: "new-test-signature" }
    ));

    const validDeviceBatch = writeBatch(owner);
    validDeviceBatch.set(doc(owner, "shops", shopId, "devices", "device-1"), {
      uid: "owner", deviceId: "device-1", active: true, slot: "0"
    });
    validDeviceBatch.set(doc(owner, "shops", shopId, "deviceSlots", "0"), {
      uid: "owner", deviceId: "device-1", active: true
    });
    await assertSucceeds(validDeviceBatch.commit());

    const overLimitBatch = writeBatch(owner);
    overLimitBatch.set(doc(owner, "shops", shopId, "devices", "device-3"), {
      uid: "owner", deviceId: "device-3", active: true, slot: "2"
    });
    overLimitBatch.set(doc(owner, "shops", shopId, "deviceSlots", "2"), {
      uid: "owner", deviceId: "device-3", active: true
    });
    await assertFails(overLimitBatch.commit());

    console.log("PASS: Firestore rules isolate shops, enforce employee roles, protect licenses, and enforce the cloud device cap.");
  } finally {
    await testEnv.cleanup();
  }
}

await test();
