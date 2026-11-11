/* Offline-first license and local role gate.
   The embedded key is public. The signing key is provisioned to the project manager separately. */
(()=>{
"use strict";
const PUBLIC_KEY_DER_B64="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEz2qz5cIgqE/ZljxEjxcbCNJRty1X8++QPa9L7Ltpu1r2HZrbhCTYnJ+xH9nkL5GMXrNY0CvCNDCX4c/brsuKYQ==";
const MANAGED_KEY="supermarket-pos-managed-shop-v1";
const SESSION_KEY="supermarket-pos-member-session-v1";
const LICENSE_PREFIX="supermarket-pos-signed-license-v1:";
const ROLE_LABELS={owner:"صاحب المحل",manager:"مدير",cashier:"كاشير",accountant:"محاسب"};
const ROLE_METHODS={
  owner:["*"],
  manager:["saveProduct","saveProducts","deleteProduct","setProductActive","saveInvoice","saveSupplier","saveSupplierPayment","savePurchase","saveStockAdjustment","saveStocktake","saveCustomer","saveCustomerPayment","saveReturn","saveCashEntry","saveShift","restoreData"],
  cashier:["saveInvoice","saveCustomer"],
  accountant:["saveInvoice","saveSupplier","saveSupplierPayment","savePurchase","saveCustomer","saveCustomerPayment","saveReturn","saveCashEntry","saveShift"]
};
let session=null,license=null,licenseReady=false,initialized=false,platformAdminSession=false;
let publicKeyPromise=null;
const $=id=>document.getElementById(id);
function bytesFromBase64(value){
  const raw=atob(value),out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}
function stable(value){
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return "["+value.map(stable).join(",")+"]";
  return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stable(value[key])).join(",")+"}";
}
function publicKey(){
  if(!publicKeyPromise){
    publicKeyPromise=crypto.subtle.importKey(
      "spki",bytesFromBase64(PUBLIC_KEY_DER_B64),
      {name:"ECDSA",namedCurve:"P-256"},false,["verify"]
    );
  }
  return publicKeyPromise;
}
async function verifyDocument(document){
  try{
    if(!document||!document.payload||typeof document.signature!=="string")return false;
    const payload=document.payload;
    if(payload.schema!==1||!payload.shopId||!["active","suspended"].includes(payload.status))return false;
    const key=await publicKey();
    return await crypto.subtle.verify(
      {name:"ECDSA",hash:"SHA-256"},key,bytesFromBase64(document.signature),
      new TextEncoder().encode(stable(payload))
    );
  }catch(error){
    console.warn("License signature verification failed",error);
    return false;
  }
}
function cachedLicense(shopId){
  try{return JSON.parse(localStorage.getItem(LICENSE_PREFIX+shopId)||"null");}
  catch(_){return null;}
}
function showLock(title,message){
  const node=$("licenseLockScreen");
  if(!node)return;
  node.hidden=false;
  const heading=$("licenseLockTitle"),detail=$("licenseLockMessage");
  if(heading)heading.textContent=title||"البرنامج غير مفعل";
  if(detail)detail.textContent=message||"تواصل مع إدارة البرنامج لتفعيل الترخيص.";
  document.body.classList.add("license-locked");
}
function hideLock(){
  const node=$("licenseLockScreen");
  if(node)node.hidden=true;
  document.body.classList.remove("license-locked");
}
function licenseCheck(doc,shopId){
  if(!doc||!doc.payload)return {ok:false,reason:"لا يوجد ترخيص لهذا المحل."};
  const p=doc.payload,now=Date.now();
  if(p.shopId!==shopId)return {ok:false,reason:"الترخيص لا يخص هذا المحل."};
  if(p.status!=="active")return {ok:false,reason:"تم إيقاف ترخيص هذا المحل بواسطة إدارة البرنامج."};
  const start=Date.parse(p.validFrom||p.issuedAt||"");
  const end=Date.parse(p.expiresAt||"");
  if(!Number.isFinite(start)||!Number.isFinite(end))return {ok:false,reason:"بيانات مدة الترخيص غير صحيحة."};
  if(now<start)return {ok:false,reason:"لم يبدأ سريان الترخيص بعد."};
  if(now>=end)return {ok:false,reason:"انتهت مدة الترخيص. يرجى التواصل مع إدارة البرنامج للتجديد."};
  return {ok:true,expiresAt:p.expiresAt};
}
async function applyLicense(doc,shopId,persist=true){
  const validSignature=await verifyDocument(doc);
  if(!validSignature){
    licenseReady=false;license=null;
    showLock("تعذر التحقق من الترخيص","التوقيع الرقمي غير صحيح أو ملف الترخيص غير معتمد. اتصل بإدارة البرنامج.");
    return false;
  }
  const check=licenseCheck(doc,shopId);
  if(!check.ok){
    licenseReady=false;license=doc;
    showLock("البرنامج متوقف",check.reason);
    if(persist)localStorage.setItem(LICENSE_PREFIX+shopId,JSON.stringify(doc));
    return false;
  }
  license=doc;licenseReady=true;
  if(persist)localStorage.setItem(LICENSE_PREFIX+shopId,JSON.stringify(doc));
  hideLock();
  return true;
}
function roleCan(method){
  if(!localStorage.getItem(MANAGED_KEY))return true;
  if(!session||!session.active)return false;
  const role=String(session.role||"");
  const allowed=ROLE_METHODS[role]||[];
  return allowed.includes("*")||allowed.includes(method);
}
function assertMutation(method){
  if(platformAdminSession)throw new Error("حساب مدير المشروع مخصص لإدارة التراخيص ولا يستخدم لتشغيل محل.");
  const managedShop=localStorage.getItem(MANAGED_KEY);
  if(!managedShop)return true;
  if(!session||!session.uid||!session.active||session.shopId!==managedShop)
    throw new Error("يجب تسجيل الدخول بحساب موظف نشط لهذا المحل.");
  if(!licenseReady){
    const check=licenseCheck(license,managedShop);
    showLock("البرنامج متوقف",check.ok?"يلزم إعادة التحقق من الترخيص.":check.reason);
    throw new Error("البرنامج غير مفعل. لا يمكن تنفيذ العمليات.");
  }
  if(!roleCan(method))throw new Error("ليس لديك صلاحية لتنفيذ هذه العملية. راجع صاحب المحل.");
  return true;
}
function setSession(value){
  session=value&&value.shopId?{...value,active:value.active!==false}:null;
  if(session){
    localStorage.setItem(MANAGED_KEY,session.shopId);
    localStorage.setItem(SESSION_KEY,JSON.stringify(session));
  }else{
    localStorage.removeItem(SESSION_KEY);
    if(localStorage.getItem(MANAGED_KEY))showLock("تم تسجيل الخروج","سجّل الدخول بحساب الموظف المصرح لهذا المحل.");
  }
}
function setPlatformAdmin(enabled){
  platformAdminSession=!!enabled;
  if(platformAdminSession)hideLock();
  else if(localStorage.getItem(MANAGED_KEY))showLock("يلزم التحقق من الحساب","سجّل الدخول بحساب المحل المصرح.");
}
function lock(reason){
  licenseReady=false;
  showLock("البرنامج متوقف",reason||"تم إيقاف الوصول إلى هذا المحل.");
}
async function initialize(){
  if(initialized)return;
  initialized=true;
  const shopId=localStorage.getItem(MANAGED_KEY);
  if(!shopId)return;
  try{session=JSON.parse(localStorage.getItem(SESSION_KEY)||"null");}catch(_){session=null;}
  showLock("جارٍ التحقق من الترخيص","يتم التحقق من بيانات التفعيل المحفوظة على هذا الجهاز.");
  const doc=cachedLicense(shopId);
  if(!session||!session.uid||!session.active||session.shopId!==shopId){
    showLock("يلزم تسجيل الدخول","هذا الجهاز مرتبط بمحل له حسابات مستخدمين. سجّل الدخول بحسابك.");
    return;
  }
  if(!doc){
    showLock("البرنامج غير مفعل","لا توجد نسخة ترخيص موقعة محفوظة على هذا الجهاز. اتصل بإدارة البرنامج أثناء الاتصال بالإنترنت.");
    return;
  }
  await applyLicense(doc,shopId,false);
}
function installMutationGuards(){
  if(!window.POSDatabase||window.POSDatabase.__localRoleGuarded)return;
  const methods=["saveProduct","saveProducts","deleteProduct","setProductActive","saveInvoice","saveSupplier","saveSupplierPayment","savePurchase","saveStockAdjustment","saveStocktake","saveCustomer","saveCustomerPayment","saveReturn","saveCashEntry","saveShift","saveSettings","restoreData"];
  methods.forEach(method=>{
    const original=window.POSDatabase[method];
    if(typeof original!=="function")return;
    window.POSDatabase[method]=function(){
      assertMutation(method);
      return original.apply(this,arguments);
    };
  });
  window.POSDatabase.__localRoleGuarded=true;
}
window.POSGate={
  setSession,setPlatformAdmin,applyLicense,verifyDocument,licenseCheck,assertMutation,roleCan,lock,
  getSession:()=>session,getLicense:()=>license,
  isManaged:()=>!!localStorage.getItem(MANAGED_KEY),
  isLicensed:()=>licenseReady,
  roleLabel:role=>ROLE_LABELS[role]||"غير محدد"
};
installMutationGuards();
document.addEventListener("DOMContentLoaded",initialize);
initialize();
})();
