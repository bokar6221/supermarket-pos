/* IndexedDB persistence: version 3 adds suppliers, purchases, payments and stocktakes.
   Existing products, invoices, settings and movements are retained during upgrade. */
(function(){
  "use strict";
  const DB_NAME="supermarket_pos", DB_VERSION=3;
  const STORE_NAMES=["products","invoices","settings","movements","suppliers","purchases","supplierPayments","stocktakes"];

  function ensureIndex(store,name,keyPath,options){
    if(!store.indexNames.contains(name))store.createIndex(name,keyPath,options||{unique:false});
  }
  function openDB(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded=()=>{
        const db=req.result,tx=req.transaction;
        let products;
        if(!db.objectStoreNames.contains("products")){
          products=db.createObjectStore("products",{keyPath:"id"});
        }else products=tx.objectStore("products");
        ensureIndex(products,"barcode","barcode");
        ensureIndex(products,"name","name");

        let invoices;
        if(!db.objectStoreNames.contains("invoices"))invoices=db.createObjectStore("invoices",{keyPath:"id"});
        else invoices=tx.objectStore("invoices");
        ensureIndex(invoices,"createdAt","createdAt");

        if(!db.objectStoreNames.contains("settings"))db.createObjectStore("settings",{keyPath:"key"});

        let movements;
        if(!db.objectStoreNames.contains("movements"))movements=db.createObjectStore("movements",{keyPath:"id"});
        else movements=tx.objectStore("movements");
        ensureIndex(movements,"createdAt","createdAt");
        ensureIndex(movements,"productId","productId");
        ensureIndex(movements,"type","type");

        let suppliers;
        if(!db.objectStoreNames.contains("suppliers"))suppliers=db.createObjectStore("suppliers",{keyPath:"id"});
        else suppliers=tx.objectStore("suppliers");
        ensureIndex(suppliers,"name","name");

        let purchases;
        if(!db.objectStoreNames.contains("purchases"))purchases=db.createObjectStore("purchases",{keyPath:"id"});
        else purchases=tx.objectStore("purchases");
        ensureIndex(purchases,"createdAt","createdAt");
        ensureIndex(purchases,"supplierId","supplierId");

        let payments;
        if(!db.objectStoreNames.contains("supplierPayments"))payments=db.createObjectStore("supplierPayments",{keyPath:"id"});
        else payments=tx.objectStore("supplierPayments");
        ensureIndex(payments,"createdAt","createdAt");
        ensureIndex(payments,"supplierId","supplierId");

        let stocktakes;
        if(!db.objectStoreNames.contains("stocktakes"))stocktakes=db.createObjectStore("stocktakes",{keyPath:"id"});
        else stocktakes=tx.objectStore("stocktakes");
        ensureIndex(stocktakes,"createdAt","createdAt");
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
  }

  function requestResult(req){
    return new Promise((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
  }
  async function all(store){
    const db=await openDB();
    try{return await requestResult(db.transaction(store,"readonly").objectStore(store).getAll());}
    finally{db.close();}
  }
  function transact(names,work){
    return openDB().then(db=>new Promise((resolve,reject)=>{
      let tx;
      try{tx=db.transaction(names,"readwrite");work(tx);}
      catch(error){try{tx&&tx.abort();}catch(e){}db.close();reject(error);return;}
      tx.oncomplete=()=>{db.close();resolve(true);};
      tx.onerror=()=>{const error=tx.error||new Error("حدث خطأ في قاعدة البيانات.");db.close();reject(error);};
      tx.onabort=()=>{const error=tx.error||new Error("تم إلغاء العملية ولم تُحفظ التغييرات.");db.close();reject(error);};
    }));
  }

  async function getProducts(){return all("products");}
  async function getInvoices(){return all("invoices");}
  async function getMovements(){return all("movements");}
  async function getSuppliers(){return all("suppliers");}
  async function getPurchases(){return all("purchases");}
  async function getSupplierPayments(){return all("supplierPayments");}
  async function getStocktakes(){return all("stocktakes");}

  async function getProductByBarcode(code){
    const db=await openDB();
    try{return await requestResult(db.transaction("products","readonly").objectStore("products").index("barcode").get(code));}
    finally{db.close();}
  }
  async function saveProduct(product){
    const clean={...product,minStock:Math.max(0,Number(product.minStock)||0)};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction("products","readwrite");
        tx.objectStore("products").put(clean);
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(tx.error);
      });
      return clean;
    }finally{db.close();}
  }
  async function saveProducts(products){
    if(!Array.isArray(products))throw new Error("قائمة المنتجات غير صحيحة.");
    const db=await openDB();
    try{
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction("products","readwrite"),store=tx.objectStore("products");
        for(const product of products)store.put({...product,minStock:Math.max(0,Number(product.minStock)||0)});
        tx.oncomplete=()=>resolve(products.length);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(tx.error);
      });
    }finally{db.close();}
  }
  async function deleteProduct(id){
    const db=await openDB();
    try{
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction("products","readwrite");
        tx.objectStore("products").delete(id);
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(tx.error);
      });
    }finally{db.close();}
  }

  async function saveInvoice(invoice){
    const db=await openDB();
    try{
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction(["invoices","products","movements"],"readwrite");
        const ps=tx.objectStore("products"),ms=tx.objectStore("movements");
        for(const item of invoice.items||[]){
          if(!item.productId)continue;
          const req=ps.get(item.productId);
          req.onsuccess=()=>{
            const p=req.result;
            if(!p)return;
            if(p.trackStock){
              const quantity=Number(item.stockQuantity||item.quantity||0);
              const next=Number(p.stock||0)-quantity;
              if(!Number.isFinite(quantity)||quantity<0||next< -0.000001){try{tx.abort();}catch(e){}return;}
              p.stock=Math.max(0,next);
              p.updatedAt=invoice.createdAt;
              ps.put(p);
              ms.add({
                id:crypto.randomUUID(),productId:p.id,productName:p.name,type:"sale",
                quantity:-quantity,unit:p.unit,referenceId:invoice.id,referenceNumber:invoice.id,
                createdAt:invoice.createdAt,note:"بيع"
              });
            }
          };
        }
        tx.objectStore("invoices").add(invoice);
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error("تعذر حفظ الفاتورة. قد تكون الكمية غير كافية أو حدث خطأ في قاعدة البيانات."));
      });
    }finally{db.close();}
  }

  async function saveSupplier(supplier){
    if(!supplier||!String(supplier.name||"").trim())throw new Error("اكتب اسم المورد.");
    const clean={
      ...supplier,name:String(supplier.name).trim(),phone:String(supplier.phone||"").trim(),
      openingBalance:Math.max(0,Number(supplier.openingBalance)||0),
      updatedAt:new Date().toISOString(),active:supplier.active!==false
    };
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction("suppliers","readwrite");
        tx.objectStore("suppliers").put(clean);
        tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
      return clean;
    }finally{db.close();}
  }
  async function saveSupplierPayment(payment){
    const amount=Number(payment&&payment.amount);
    if(!payment||!payment.supplierId||!Number.isFinite(amount)||amount<=0)throw new Error("بيانات دفعة المورد غير صحيحة.");
    const clean={...payment,amount,createdAt:payment.createdAt||new Date().toISOString()};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["supplierPayments","suppliers"],"readwrite");
        const supplierReq=tx.objectStore("suppliers").get(clean.supplierId);
        supplierReq.onsuccess=()=>{
          if(!supplierReq.result){try{tx.abort();}catch(e){}return;}
          tx.objectStore("supplierPayments").add(clean);
        };
        tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error("تعذر تسجيل دفعة المورد."));
      });
    }finally{db.close();}
  }

  async function savePurchase(purchase){
    if(!purchase||!Array.isArray(purchase.items)||!purchase.items.length)throw new Error("أضف صنفًا واحدًا على الأقل للمشتريات.");
    const total=Number(purchase.total),paid=Number(purchase.paidAmount||0);
    if(!Number.isFinite(total)||total<=0||!Number.isFinite(paid)||paid<0||paid>total+0.000001)throw new Error("راجع إجمالي المشتريات والمبلغ المدفوع.");
    const ids=new Set();
    for(const item of purchase.items){
      if(!item.productId||ids.has(item.productId))throw new Error("لا تكرر الصنف في نفس فاتورة الشراء.");
      ids.add(item.productId);
      if(!(Number(item.quantity)>0)||!(Number(item.unitCost)>=0))throw new Error("راجع كمية وتكلفة كل صنف.");
    }
    const clean={...purchase,total,paidAmount:paid,balance:Math.max(0,total-paid),createdAt:purchase.createdAt||new Date().toISOString()};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["purchases","products","movements"],"readwrite");
        const products=tx.objectStore("products"),movements=tx.objectStore("movements");
        tx.objectStore("purchases").add(clean);
        for(const item of clean.items){
          const req=products.get(item.productId);
          req.onsuccess=()=>{
            const p=req.result;
            if(!p){try{tx.abort();}catch(e){}return;}
            const qty=Number(item.quantity),unitCost=Number(item.unitCost);
            const oldQty=p.trackStock?Number(p.stock||0):0;
            const oldCost=Number(p.cost||0);
            const nextQty=oldQty+qty;
            p.trackStock=true;
            p.stock=nextQty;
            p.cost=nextQty>0?((oldQty*oldCost)+(qty*unitCost))/nextQty:unitCost;
            p.updatedAt=clean.createdAt;
            products.put(p);
            movements.add({
              id:crypto.randomUUID(),productId:p.id,productName:p.name,type:"purchase",
              quantity:qty,unit:p.unit,unitCost,totalCost:qty*unitCost,
              referenceId:clean.id,referenceNumber:clean.number||clean.id,
              supplierId:clean.supplierId||null,supplierName:clean.supplierName||"",
              createdAt:clean.createdAt,note:"شراء بضاعة"
            });
          };
        }
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error("تعذر حفظ فاتورة الشراء. لم يتم اعتماد أي كمية."));
      });
    }finally{db.close();}
  }

  async function saveStockAdjustment(adjustment){
    if(!adjustment||!adjustment.productId)throw new Error("اختر الصنف.");
    const delta=Number(adjustment.delta);
    if(!Number.isFinite(delta)||Math.abs(delta)<0.0000001)throw new Error("أدخل كمية تسوية صحيحة.");
    if(!String(adjustment.reason||"").trim())throw new Error("اكتب سبب التسوية.");
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["products","movements"],"readwrite");
        const store=tx.objectStore("products"),req=store.get(adjustment.productId);
        req.onsuccess=()=>{
          const p=req.result;
          if(!p){try{tx.abort();}catch(e){}return;}
          const current=p.trackStock?Number(p.stock||0):0,next=current+delta;
          if(next< -0.000001){try{tx.abort();}catch(e){}return;}
          p.trackStock=true;p.stock=Math.max(0,next);p.updatedAt=new Date().toISOString();store.put(p);
          tx.objectStore("movements").add({
            id:crypto.randomUUID(),productId:p.id,productName:p.name,type:"adjustment",
            quantity:delta,unit:p.unit,createdAt:p.updatedAt,note:String(adjustment.reason).trim()
          });
        };
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error("تعذر تنفيذ التسوية. تأكد من الكمية والرصيد."));
      });
    }finally{db.close();}
  }

  async function saveStocktake(stocktake){
    if(!stocktake||!Array.isArray(stocktake.items)||!stocktake.items.length)throw new Error("لا توجد أصناف في الجرد.");
    const ids=new Set();
    for(const item of stocktake.items){
      if(!item.productId||ids.has(item.productId)||!Number.isFinite(Number(item.countedQty))||Number(item.countedQty)<0)throw new Error("راجع الكميات المسجلة في الجرد.");
      ids.add(item.productId);
    }
    const clean={...stocktake,status:"completed",createdAt:stocktake.createdAt||new Date().toISOString()};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["stocktakes","products","movements"],"readwrite");
        const products=tx.objectStore("products"),movements=tx.objectStore("movements");
        tx.objectStore("stocktakes").add(clean);
        for(const item of clean.items){
          const req=products.get(item.productId);
          req.onsuccess=()=>{
            const p=req.result;
            if(!p){try{tx.abort();}catch(e){}return;}
            const before=p.trackStock?Number(p.stock||0):0;
            const counted=Number(item.countedQty),difference=counted-before;
            p.trackStock=true;p.stock=counted;p.updatedAt=clean.createdAt;products.put(p);
            if(Math.abs(difference)>0.0000001){
              movements.add({
                id:crypto.randomUUID(),productId:p.id,productName:p.name,type:"stocktake",
                quantity:difference,unit:p.unit,createdAt:clean.createdAt,
                referenceId:clean.id,referenceNumber:clean.number||clean.id,
                note:"تسوية ناتجة عن الجرد الفعلي"
              });
            }
          };
        }
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error("تعذر اعتماد الجرد. لم يتم تغيير أرصدة المنتجات."));
      });
    }finally{db.close();}
  }

  async function backupData(){
    const values=await Promise.all(STORE_NAMES.map(name=>all(name)));
    const data={};
    STORE_NAMES.forEach((name,index)=>data[name]=values[index]);
    return {app:"supermarket-pos",schemaVersion:3,exportedAt:new Date().toISOString(),data};
  }
  async function restoreData(payload){
    if(!payload||payload.app!=="supermarket-pos"||!payload.data||!Array.isArray(payload.data.products)||!Array.isArray(payload.data.invoices))throw new Error("ملف النسخة الاحتياطية غير صحيح.");
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORE_NAMES,"readwrite");
        for(const name of STORE_NAMES)tx.objectStore(name).clear();
        for(const name of STORE_NAMES){
          const rows=payload.data[name]||[];
          if(Array.isArray(rows))for(const row of rows)tx.objectStore(name).put(row);
        }
        tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
    }finally{db.close();}
  }
  async function getSettings(){
    const rows=await all("settings"),result={};
    for(const row of rows){if(row&&typeof row.key==="string")result[row.key]=row.value;}
    return result;
  }
  async function saveSettings(values){
    if(!values||typeof values!=="object"||Array.isArray(values))throw new Error("إعدادات المحل غير صحيحة.");
    const db=await openDB();
    try{
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction("settings","readwrite"),store=tx.objectStore("settings"),updatedAt=new Date().toISOString();
        for(const [key,value] of Object.entries(values))if(key)store.put({key,value,updatedAt});
        tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
    }finally{db.close();}
  }

  window.POSDatabase={
    getProducts,getInvoices,getProductByBarcode,saveProduct,saveProducts,deleteProduct,saveInvoice,
    getMovements,getSuppliers,getPurchases,getSupplierPayments,getStocktakes,
    saveSupplier,saveSupplierPayment,savePurchase,saveStockAdjustment,saveStocktake,
    backupData,restoreData,getSettings,saveSettings
  };
})();