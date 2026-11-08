/* Local persistence for the single-device MVP. */
(function(){
  const DB_NAME = "supermarket_pos";
  const DB_VERSION = 1;
  function openDB(){
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,DB_VERSION);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains("products")){
          const store=db.createObjectStore("products",{keyPath:"id"});
          store.createIndex("barcode","barcode",{unique:false});
        }
        if(!db.objectStoreNames.contains("invoices")){
          db.createObjectStore("invoices",{keyPath:"id"});
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
  }
  async function addInvoice(invoice){
    const db=await openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction("invoices","readwrite");
      tx.objectStore("invoices").add(invoice);
      tx.oncomplete=()=>{db.close();resolve(true)};
      tx.onerror=()=>{db.close();reject(tx.error)};
    });
  }
  async function getInvoices(){
    const db=await openDB();
    return new Promise((resolve,reject)=>{
      const req=db.transaction("invoices","readonly").objectStore("invoices").getAll();
      req.onsuccess=()=>{db.close();resolve(req.result||[])};
      req.onerror=()=>{db.close();reject(req.error)};
    });
  }
  window.POSDatabase={addInvoice,getInvoices};
})();