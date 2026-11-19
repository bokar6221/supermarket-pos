/* Password-protected POS backup format.
   PBKDF2-SHA-256 derives an AES-256-GCM key. Passwords are never persisted. */
(()=>{
"use strict";
const FORMAT="supermarket-pos-encrypted-backup";
const VERSION=1;
const ITERATIONS=310000;
const MIN_ITERATIONS=250000;
const MAX_ITERATIONS=600000;
const enc=new TextEncoder();
const dec=new TextDecoder();
function cryptoApi(){
  if(!globalThis.crypto||!globalThis.crypto.subtle||typeof globalThis.crypto.getRandomValues!=="function")
    throw new Error("التشفير الآمن غير مدعوم في هذا المتصفح. افتح التطبيق من HTTPS أو إصدار Android حديث.");
  return globalThis.crypto;
}
function toBase64(bytes){
  let binary="";
  for(let i=0;i<bytes.length;i+=0x8000)
    binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+0x8000,bytes.length)));
  return btoa(binary);
}
function fromBase64(value){
  if(typeof value!=="string"||value.length>50000000)throw new Error("بيانات النسخة المشفرة غير صالحة.");
  const binary=atob(value),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}
function validatePassword(password){
  if(typeof password!=="string"||password.length<10)
    throw new Error("استخدم كلمة مرور للنسخة الاحتياطية من 10 أحرف على الأقل.");
  if(password.length>256)throw new Error("كلمة المرور طويلة أكثر من اللازم.");
}
async function deriveKey(password,salt,iterations){
  const api=cryptoApi();
  const material=await api.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveKey"]);
  return api.subtle.deriveKey(
    {name:"PBKDF2",salt,iterations,hash:"SHA-256"},
    material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]
  );
}
async function encrypt(payload,password){
  validatePassword(password);
  const api=cryptoApi();
  const salt=api.getRandomValues(new Uint8Array(16));
  const iv=api.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(password,salt,ITERATIONS);
  const plaintext=enc.encode(JSON.stringify(payload));
  const encrypted=await api.subtle.encrypt({name:"AES-GCM",iv,tagLength:128},key,plaintext);
  return {
    format:FORMAT,
    version:VERSION,
    cipher:"AES-256-GCM",
    kdf:"PBKDF2-SHA-256",
    iterations:ITERATIONS,
    salt:toBase64(salt),
    iv:toBase64(iv),
    ciphertext:toBase64(new Uint8Array(encrypted))
  };
}
function isEncrypted(value){
  return !!value&&typeof value==="object"&&!Array.isArray(value)&&value.format===FORMAT;
}
async function decrypt(envelope,password){
  validatePassword(password);
  if(!isEncrypted(envelope)||envelope.version!==VERSION||envelope.cipher!=="AES-256-GCM"||envelope.kdf!=="PBKDF2-SHA-256")
    throw new Error("صيغة النسخة المشفرة غير مدعومة.");
  const iterations=Number(envelope.iterations);
  if(!Number.isInteger(iterations)||iterations<MIN_ITERATIONS||iterations>MAX_ITERATIONS)
    throw new Error("إعدادات تشفير النسخة غير آمنة أو غير مدعومة.");
  const salt=fromBase64(envelope.salt),iv=fromBase64(envelope.iv),ciphertext=fromBase64(envelope.ciphertext);
  if(salt.length!==16||iv.length!==12||ciphertext.length<17)
    throw new Error("ملف النسخة المشفرة ناقص أو تالف.");
  try{
    const key=await deriveKey(password,salt,iterations);
    const plaintext=await cryptoApi().subtle.decrypt({name:"AES-GCM",iv,tagLength:128},key,ciphertext);
    return JSON.parse(dec.decode(plaintext));
  }catch(_){
    throw new Error("كلمة المرور غير صحيحة أو ملف النسخة المشفرة تالف.");
  }
}
globalThis.POSBackupCrypto={encrypt,decrypt,isEncrypted,iterations:ITERATIONS};
})();