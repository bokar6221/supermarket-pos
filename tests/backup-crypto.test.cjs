"use strict";
const assert=require("node:assert/strict");
if(!globalThis.crypto||!globalThis.crypto.subtle)Object.defineProperty(globalThis,"crypto",{value:require("node:crypto").webcrypto,configurable:true});
require("../backup-crypto.js");
async function run(){
  const payload={
    app:"supermarket-pos",schemaVersion:4,
    data:{
      products:[{id:"p-1",name:"منتج اختبار",price:12.5,stock:4}],
      invoices:[{id:"i-1",total:25,paymentMethod:"cash"}],
      customers:[{id:"c-1",name:"عميل اختبار",phone:"01000000000"}]
    }
  };
  const password="POS-backup-2026-Strong!";
  const envelope=await POSBackupCrypto.encrypt(payload,password);
  assert.equal(POSBackupCrypto.isEncrypted(envelope),true);
  assert.equal(envelope.cipher,"AES-256-GCM");
  assert.equal(envelope.kdf,"PBKDF2-SHA-256");
  assert.notEqual(envelope.ciphertext,Buffer.from(JSON.stringify(payload)).toString("base64"));
  assert.deepEqual(await POSBackupCrypto.decrypt(envelope,password),payload);
  await assert.rejects(POSBackupCrypto.decrypt(envelope,"wrong-password-123"),/كلمة المرور غير صحيحة/);
  const tampered={...envelope,ciphertext:envelope.ciphertext.slice(0,-4)+"AAAA"};
  await assert.rejects(POSBackupCrypto.decrypt(tampered,password),/كلمة المرور غير صحيحة/);
  await assert.rejects(POSBackupCrypto.encrypt(payload,"short"),/10 أحرف على الأقل/);
  await assert.rejects(POSBackupCrypto.decrypt({...envelope,iterations:1},password),/إعدادات تشفير/);
  console.log("PASS: AES-256-GCM backup encryption, password verification, tamper detection and KDF bounds.");
}
run().catch(error=>{console.error(error);process.exitCode=1;});
