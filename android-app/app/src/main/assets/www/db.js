/* IndexedDB persistence. Version 2 keeps the original stores and adds settings and stock movements. */
(function(){
  const DB_NAME="supermarket_pos", DB_VERSION=2;
  function openDB(){return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result, tx=req.transaction;
      if(!db.objectStoreNames.contains("products")){
        const s=db.createObjectStore("products",{keyPath:"id"});
        s.createIndex("barcode","barcode",{unique:false});s.createIndex("name","name",{unique:false});
      }else{
        const s=tx.objectStore("products");
        if(!s.indexNames.contains("barcode"))s.createIndex("barcode","barcode",{unique:false});
        if(!s.indexNames.contains("name"))s.createIndex("name","name",{unique:false});
      }
      if(!db.objectStoreNames.contains("invoices")){
        const s=db.createObjectStore("invoices",{keyPath:"id"});s.createIndex("createdAt","createdAt",{unique:false});
      }else if(!tx.objectStore("invoices").indexNames.contains("createdAt"))tx.objectStore("invoices").createIndex("createdAt","createdAt",{unique:false});
      if(!db.objectStoreNames.contains("settings"))db.createObjectStore("settings",{keyPath:"key"});
      if(!db.objectStoreNames.contains("movements")){const s=db.createObjectStore("movements",{keyPath:"id"});s.createIndex("createdAt","createdAt",{unique:false});}
    };
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });}
  function requestResult(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
  async function all(store){const db=await openDB();try{return await requestResult(db.transaction(store,"readonly").objectStore(store).getAll());}finally{db.close();}}
  async function getProducts(){return all("products");}
  async function getInvoices(){return all("invoices");}
  async function getProductByBarcode(code){const db=await openDB();try{return await requestResult(db.transaction("products","readonly").objectStore("products").index("barcode").get(code));}finally{db.close();}}
  async function saveProduct(product){
    const db=await openDB();try{return await new Promise((resolve,reject)=>{const tx=db.transaction("products","readwrite");tx.objectStore("products").put(product);tx.oncomplete=()=>resolve(product);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
  async function saveProducts(products){
    if(!Array.isArray(products))throw new Error("قائمة المنتجات غير صحيحة.");
    const db=await openDB();try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction("products","readwrite"),store=tx.objectStore("products");
      for(const product of products)store.put(product);
      tx.oncomplete=()=>resolve(products.length);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
  }
  async function deleteProduct(id){
    const db=await openDB();try{return await new Promise((resolve,reject)=>{const tx=db.transaction("products","readwrite");tx.objectStore("products").delete(id);tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);});}finally{db.close();}
  }
  async function saveInvoice(invoice){
    const db=await openDB();try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction(["invoices","products","movements"],"readwrite"), ps=tx.objectStore("products"), ms=tx.objectStore("movements");
      for(const item of invoice.items){
        if(!item.productId)continue;
        const req=ps.get(item.productId);
        req.onsuccess=()=>{
          const p=req.result;if(!p)return;
          if(p.trackStock){
            const next=Number(p.stock||0)-Number(item.stockQuantity||item.quantity||0);
            if(next<0){tx.abort();return;}
            p.stock=next;ps.put(p);
            ms.add({id:crypto.randomUUID(),productId:p.id,productName:p.name,type:"sale",quantity:-Number(item.stockQuantity||item.quantity||0),invoiceId:invoice.id,createdAt:invoice.createdAt});
          }
        };
      }
      tx.objectStore("invoices").add(invoice);
      tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(new Error("تعذر حفظ الفاتورة. قد تكون الكمية غير كافية أو حدث خطأ في قاعدة البيانات."));
    });}finally{db.close();}
  }
  async function backupData(){
    const [products,invoices,movements,settings]=await Promise.all([all("products"),all("invoices"),all("movements"),all("settings")]);
    return {app:"supermarket-pos",schemaVersion:2,exportedAt:new Date().toISOString(),data:{products,invoices,movements,settings}};
  }
  async function restoreData(payload){
    if(!payload||payload.app!=="supermarket-pos"||!payload.data||!Array.isArray(payload.data.products)||!Array.isArray(payload.data.invoices))throw new Error("ملف النسخة الاحتياطية غير صحيح.");
    const db=await openDB();try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction(["products","invoices","movements","settings"],"readwrite");
      for(const name of ["products","invoices","movements","settings"])tx.objectStore(name).clear();
      for(const name of ["products","invoices","movements","settings"])for(const row of (payload.data[name]||[]))tx.objectStore(name).put(row);
      tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
  }
  async function getSettings(){
    const rows=await all("settings"),result={};
    for(const row of rows){if(row&&typeof row.key==="string")result[row.key]=row.value;}
    return result;
  }
  async function saveSettings(values){
    if(!values||typeof values!=="object"||Array.isArray(values))throw new Error("إعدادات المحل غير صحيحة.");
    const db=await openDB();
    try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction("settings","readwrite"),store=tx.objectStore("settings"),updatedAt=new Date().toISOString();
      for(const [key,value] of Object.entries(values)){
        if(!key)continue;
        store.put({key,value,updatedAt});
      }
      tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
  }
  window.POSDatabase={getProducts,getInvoices,getProductByBarcode,saveProduct,saveProducts,deleteProduct,saveInvoice,backupData,restoreData,getSettings,saveSettings};
})();