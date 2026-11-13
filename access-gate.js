/* Offline-first local role and signed policy gate.
   Local shop data remains on-device. The signed license controls offline and cloud policy. */
(()=>{
"use strict";
const PUBLIC_KEY_DER_B64="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEPuijo+wZrb2mJgKw3jNYT1CNYqFavMDiVPAfxDdbozaSB82ht9jlsiVtAmJrYovIpv6FRVteyTlf0184t4moZA==";
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
let session=null,license=null,licenseReady=false,initialized=false,platformAdminSession=false,licenseOnlineVerified=false;
try{session=JSON.parse(localStorage.getItem(SESSION_KEY)||"null");}catch(_){session=null;}
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
  if(!publicKeyPromise)publicKeyPromise=crypto.subtle.importKey("spki",bytesFromBase64(PUBLIC_KEY_DER_B64),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  return publicKeyPromise;
}
async function verifyDocument(document){
  try{
    if(!document||!document.payload||typeof document.signature!=="string")return false;
    const payload=document.payload;
    if(payload.schema!==1||!payload.shopId||!["active","suspended"].includes(payload.status))return false;
    return await crypto.subtle.verify(
      {name:"ECDSA",hash:"SHA-256"},await publicKey(),bytesFromBase64(document.signature),
      new TextEncoder().encode(stable(payload))
    );
  }catch(error){console.warn("License signature verification failed",error);return false;}
}
function cachedLicense(shopId){
  try{return JSON.parse(localStorage.getItem(LICENSE_PREFIX+shopId)||"null");}catch(_){return null;}
}
function showLock(title,message){
  const node=$("licenseLockScreen");if(!node)return;
  node.hidden=false;
  const heading=$("licenseLockTitle"),detail=$("licenseLockMessage");
  if(heading)heading.textContent=title||"التشغيل متوقف";
  if(detail)detail.textContent=message||"تحقق من اتصال الجهاز وسياسة تشغيل المحل.";
  document.body.classList.add("license-locked");
}
function hideLock(){
  const node=$("licenseLockScreen");if(node)node.hidden=true;
  document.body.classList.remove("license-locked","license-activation-only");
}
function openActivation(){
  const settingsTab=document.querySelector('.tabs [data-view="settings"]');
  if(settingsTab)settingsTab.click();
  const cloudTab=document.querySelector('#view-settings [data-subtab="cloud"]');
  if(cloudTab)cloudTab.click();
  document.body.classList.add("license-activation-only");
  const node=$("licenseLockScreen");if(node)node.hidden=true;
  document.body.classList.remove("license-locked");
  const email=$("cloudEmail");if(email)email.focus();
}
async function importLocalLicense(doc){
  if(!doc||!doc.payload||doc.payload.licenseType!=="local")throw new Error("هذا الملف ليس ترخيصًا محليًا.");
  const shopId=String(doc.payload.shopId||"");
  if(!shopId)throw new Error("ملف الترخيص لا يحتوي معرّف المحل.");
  const valid=await verifyDocument(doc);
  if(!valid)throw new Error("التوقيع الرقمي للترخيص غير صحيح.");
  const ok=await applyLicense(doc,shopId,true,false);
  if(!ok)throw new Error("الترخيص المحلي منتهي أو موقوف أو لم يبدأ بعد.");
  setSession({uid:"local-"+shopId,shopId,role:"owner",active:true,local:true});
  hideLock();
  return true;
}
function licenseCheck(doc,shopId){
  if(!doc||!doc.payload)return {ok:false,reason:"لا يوجد ترخيص لهذا المحل."};
  const p=doc.payload,now=Date.now();
  if(p.shopId!==shopId)return {ok:false,reason:"الترخيص لا يخص هذا المحل."};
  if(p.status!=="active")return {ok:false,reason:"تم إيقاف ترخيص هذا المحل بواسطة إدارة البرنامج."};
  const start=Date.parse(p.validFrom||p.issuedAt||""),end=Date.parse(p.expiresAt||"");
  if(!Number.isFinite(start)||!Number.isFinite(end))return {ok:false,reason:"بيانات مدة الترخيص غير صحيحة."};
  if(now<start)return {ok:false,reason:"لم يبدأ سريان الترخيص بعد."};
  if(now>=end)return {ok:false,reason:"انتهت مدة الترخيص. يرجى التواصل مع إدارة البرنامج للتجديد."};
  return {ok:true,expiresAt:p.expiresAt,offlineAllowed:p.offlineAllowed!==false,cloudSyncEnabled:p.cloudSyncEnabled!==false};
}
function isManaged(){return true;}
function currentLicenseCheck(){
  const shopId=localStorage.getItem(MANAGED_KEY);
  return shopId?licenseCheck(license||cachedLicense(shopId),shopId):{ok:false,reason:"يجب تفعيل البرنامج وربطه بمحل قبل الاستخدام.",offlineAllowed:false,cloudSyncEnabled:false};
}
function canOperateLocally(){
  if(platformAdminSession)return false;
  const shopId=localStorage.getItem(MANAGED_KEY);
  if(!shopId||!session||!session.uid||!session.active||session.shopId!==shopId)return false;
  const check=currentLicenseCheck();
  if(!check.ok||!licenseReady)return false;
  return check.offlineAllowed||(navigator.onLine&&licenseOnlineVerified);
}
async function applyLicense(doc,shopId,persist=true,verifiedOnline=persist){
  const validSignature=await verifyDocument(doc);
  if(!validSignature){
    licenseReady=false;license=null;licenseOnlineVerified=false;
    showLock("تعذر التحقق من الترخيص","التوقيع الرقمي غير صحيح أو ملف الترخيص غير معتمد.");
    return false;
  }
  const check=licenseCheck(doc,shopId);
  license=doc;licenseReady=!!check.ok;licenseOnlineVerified=!!(check.ok&&verifiedOnline);
  if(persist)localStorage.setItem(LICENSE_PREFIX+shopId,JSON.stringify(doc));
  if(!check.ok){
    showLock("البرنامج متوقف",check.reason);
    return false;
  }
  if(check.offlineAllowed||licenseOnlineVerified)hideLock();
  else showLock("الاتصال بالإنترنت مطلوب","مدير المشروع أوقف التشغيل دون إنترنت لهذا المحل. اتصل بالإنترنت للتحقق من الترخيص.");
  return true;
}
function roleCan(method){
  if(platformAdminSession||!session||!session.active)return false;
  const allowed=ROLE_METHODS[String(session.role||"")]||[];
  return allowed.includes("*")||allowed.includes(method);
}
function assertMutation(method){
  if(platformAdminSession)throw new Error("حساب مدير المشروع مخصص لإدارة التراخيص ولا يستخدم لتشغيل محل.");
  const shopId=localStorage.getItem(MANAGED_KEY);
  if(!shopId){
    throw new Error("البرنامج غير مفعل. اتصل بالإنترنت وسجّل الدخول أو أنشئ حسابًا واربط المحل أولًا.");
  }
  if(!session||!session.uid||!session.active||session.shopId!==shopId)
    throw new Error("لا توجد صلاحية محلية محفوظة لهذا الجهاز. اتصل بالإنترنت وسجّل الدخول بحساب المحل.");
  const check=currentLicenseCheck();
  if(!check.ok||!licenseReady)throw new Error((check.reason||"تعذر التحقق من الترخيص.")+" لا يمكن تنفيذ العملية.");
  if(!check.offlineAllowed&&(!navigator.onLine||!licenseOnlineVerified))
    throw new Error("مدير المشروع أوقف التشغيل دون إنترنت لهذا المحل. اتصل بالإنترنت أولًا.");
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
    if(isManaged())showLock("تم إيقاف صلاحية هذا الجهاز","سجّل الدخول بحساب موظف نشط لهذا المحل.");
  }
}
function setPlatformAdmin(enabled){
  platformAdminSession=!!enabled;
  if(platformAdminSession)hideLock();
  else if(!document.body.classList.contains("license-activation-only")&&!canOperateLocally())showLock("يلزم تفعيل البرنامج","سجّل الدخول بحساب المحل وتحقق من الترخيص قبل الاستخدام.");
}
function lock(reason){
  licenseReady=false;licenseOnlineVerified=false;
  showLock("البرنامج متوقف",reason||"تم إيقاف الوصول إلى هذا المحل.");
}
async function initialize(){
  if(initialized)return;initialized=true;
  const shopId=localStorage.getItem(MANAGED_KEY);
  if(!shopId){showLock("البرنامج غير مفعل","يجب تسجيل الدخول أو إنشاء حساب وربط المحل والتحقق من الترخيص قبل استخدام نقاط البيع.");return;}
  try{session=JSON.parse(localStorage.getItem(SESSION_KEY)||"null");}catch(_){session=null;}
  const doc=cachedLicense(shopId);
  if(doc&&doc.payload&&doc.payload.licenseType==="local"&&(!session||!session.uid)){
    session={uid:"local-"+shopId,shopId,role:"owner",active:true,local:true};
    localStorage.setItem(SESSION_KEY,JSON.stringify(session));
  }
  if(!session||!session.uid||!session.active||session.shopId!==shopId){
    showLock("يلزم التحقق من الحساب","هذا الجهاز مرتبط بمحل. اتصل بالإنترنت وسجّل الدخول بحساب موظف نشط.");return;
  }
  if(!doc){showLock("يلزم التحقق من الترخيص","لا توجد رخصة موقعة محفوظة على هذا الجهاز. اتصل بالإنترنت للتحقق.");return;}
  await applyLicense(doc,shopId,false,false);
}
function recheckLocalLicenseExpiry(){
  if(platformAdminSession||!isManaged())return;
  const check=currentLicenseCheck();
  if(!check.ok){licenseReady=false;showLock("البرنامج متوقف",check.reason);return;}
  if(!check.offlineAllowed&&!licenseOnlineVerified){
    showLock("الاتصال بالإنترنت مطلوب","سياسة هذا المحل لا تسمح بالتشغيل دون إنترنت.");return;
  }
  if(licenseReady)hideLock();
}
window.addEventListener("focus",recheckLocalLicenseExpiry);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)recheckLocalLicenseExpiry();});
setInterval(recheckLocalLicenseExpiry,15000);
function installMutationGuards(){
  if(!window.POSDatabase||window.POSDatabase.__localRoleGuarded)return;
  const methods=["saveProduct","saveProducts","deleteProduct","setProductActive","saveInvoice","saveSupplier","saveSupplierPayment","savePurchase","saveStockAdjustment","saveStocktake","saveCustomer","saveCustomerPayment","saveReturn","saveCashEntry","saveShift","saveSettings","restoreData"];
  methods.forEach(method=>{
    const original=window.POSDatabase[method];if(typeof original!=="function")return;
    window.POSDatabase[method]=function(){assertMutation(method);return original.apply(this,arguments);};
  });
  window.POSDatabase.__localRoleGuarded=true;
}
window.POSGate={
  setSession,setPlatformAdmin,applyLicense,importLocalLicense,verifyDocument,licenseCheck,assertMutation,roleCan,lock,
  getSession:()=>session,getLicense:()=>license,
  isManaged, isLicensed:()=>licenseReady&&currentLicenseCheck().ok,
  isOfflineAllowed:()=>{const c=currentLicenseCheck();return !isManaged()||!!(c.ok&&c.offlineAllowed);},
  isCloudSyncEnabled:()=>{const c=currentLicenseCheck();return !!(isManaged()&&licenseReady&&c.ok&&c.cloudSyncEnabled);},
  canOperateLocally,
  roleLabel:role=>ROLE_LABELS[role]||"غير محدد"
};
installMutationGuards();
const localLicenseInput=$("localLicenseFile"),localLicenseButton=$("activateLocalLicense"),localLicenseStatus=$("localLicenseStatus");
if(localLicenseButton)localLicenseButton.addEventListener("click",async()=>{
  try{
    const file=localLicenseInput&&localLicenseInput.files&&localLicenseInput.files[0];
    if(!file)throw new Error("اختر ملف الترخيص المحلي أولًا.");
    const parsed=JSON.parse(await file.text());
    await importLocalLicense(parsed);
    if(localLicenseStatus){localLicenseStatus.textContent="تم تفعيل الترخيص المحلي بنجاح. لا يلزم تسجيل الدخول السحابي.";localLicenseStatus.dataset.state="success";}
    if($("cloudAuthPanel"))$("cloudAuthPanel").hidden=true;
    if($("cloudConnectedPanel"))$("cloudConnectedPanel").hidden=true;
    document.body.classList.remove("license-activation-only");
  }catch(error){if(localLicenseStatus){localLicenseStatus.textContent="تعذر تفعيل الترخيص: "+String(error.message||error);localLicenseStatus.dataset.state="error";}}
});
const activationButton=$("licenseActivationButton");
if(activationButton)activationButton.addEventListener("click",openActivation);
document.addEventListener("DOMContentLoaded",initialize);
initialize();
})();