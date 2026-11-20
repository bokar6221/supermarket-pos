/* IndexedDB persistence: version 4 adds customers, returns, cash entries and shifts.
   Earlier products, invoices, suppliers and stock records are retained during upgrade. */
(function(){
  "use strict";
  const DB_NAME="supermarket_pos", DB_VERSION=4;
  const STORE_NAMES=["products","invoices","settings","movements","suppliers","purchases","supplierPayments","stocktakes","customers","customerPayments","returns","cashEntries","shifts"];

  function ensureIndex(store,name,keyPath,options){
    if(!store.indexNames.contains(name))store.createIndex(name,keyPath,options||{unique:false});
  }
  function openDB(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded=event=>{
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

        let customers;
        if(!db.objectStoreNames.contains("customers"))customers=db.createObjectStore("customers",{keyPath:"id"});
        else customers=tx.objectStore("customers");
        ensureIndex(customers,"name","name");ensureIndex(customers,"phone","phone");

        let customerPayments;
        if(!db.objectStoreNames.contains("customerPayments"))customerPayments=db.createObjectStore("customerPayments",{keyPath:"id"});
        else customerPayments=tx.objectStore("customerPayments");
        ensureIndex(customerPayments,"createdAt","createdAt");ensureIndex(customerPayments,"customerId","customerId");

        let returns;
        if(!db.objectStoreNames.contains("returns"))returns=db.createObjectStore("returns",{keyPath:"id"});
        else returns=tx.objectStore("returns");
        ensureIndex(returns,"createdAt","createdAt");ensureIndex(returns,"invoiceId","invoiceId");

        let cashEntries;
        if(!db.objectStoreNames.contains("cashEntries"))cashEntries=db.createObjectStore("cashEntries",{keyPath:"id"});
        else cashEntries=tx.objectStore("cashEntries");
        ensureIndex(cashEntries,"createdAt","createdAt");ensureIndex(cashEntries,"type","type");ensureIndex(cashEntries,"method","method");

        let shifts;
        if(!db.objectStoreNames.contains("shifts"))shifts=db.createObjectStore("shifts",{keyPath:"id"});
        else shifts=tx.objectStore("shifts");
        ensureIndex(shifts,"openedAt","openedAt");ensureIndex(shifts,"status","status");

        // Upgrade legacy v3 financial data once, without deleting or rewriting old sales.
        if(event.oldVersion<4){
          const normalizePhone=value=>{
            let digits=String(value||"").replace(/\\D/g,"");
            if(digits.startsWith("0020"))digits="0"+digits.slice(4);
            else if(digits.startsWith("20")&&digits.length===12)digits="0"+digits.slice(2);
            return digits;
          };
          const invoiceCursor=invoices.openCursor();
          invoiceCursor.onsuccess=()=>{
            const cursor=invoiceCursor.result;if(!cursor)return;
            const invoice=cursor.value||{},createdAt=invoice.createdAt||new Date().toISOString();
            if(invoice.paymentMethod==="cash"||invoice.paymentMethod==="electronic"){
              const amount=Number(invoice.total||0);
              if(amount>0)cashEntries.add({id:"migration-sale-"+String(invoice.id),type:"income",category:"sale",amount,method:invoice.paymentMethod,referenceId:invoice.id,note:"مبيعات سابقة "+String(invoice.id||""),createdAt});
            }
            if(invoice.paymentMethod==="credit"&&String(invoice.customerName||"").trim()){
              const phone=normalizePhone(invoice.customerPhone);
              const customerId=phone?"legacy-customer-"+phone:"legacy-customer-"+String(invoice.id);
              invoice.customerId=invoice.customerId||customerId;
              cursor.update(invoice);
              customers.put({id:invoice.customerId,name:String(invoice.customerName).trim(),phone:phone||String(invoice.customerPhone||""),openingBalance:0,active:true,note:"تم ترحيله من فواتير الإصدار السابق",createdAt,updatedAt:createdAt});
            }
            cursor.continue();
          };
          const purchaseCursor=purchases.openCursor();
          purchaseCursor.onsuccess=()=>{
            const cursor=purchaseCursor.result;if(!cursor)return;
            const purchase=cursor.value||{},amount=Number(purchase.paidAmount||0);
            if(amount>0)cashEntries.add({id:"migration-purchase-"+String(purchase.id),type:"expense",category:"purchase",amount,method:purchase.paymentMethod||"cash",referenceId:purchase.id,note:"مدفوع مشتريات سابقة "+String(purchase.number||""),createdAt:purchase.createdAt||new Date().toISOString()});
            cursor.continue();
          };
          const supplierPaymentCursor=payments.openCursor();
          supplierPaymentCursor.onsuccess=()=>{
            const cursor=supplierPaymentCursor.result;if(!cursor)return;
            const payment=cursor.value||{},amount=Number(payment.amount||0);
            if(amount>0)cashEntries.add({id:"migration-supplier-payment-"+String(payment.id),type:"expense",category:"supplier_payment",amount,method:payment.method||"cash",referenceId:payment.id,note:"سداد مورد سابق "+String(payment.supplierName||""),createdAt:payment.createdAt||new Date().toISOString()});
            cursor.continue();
          };
        }
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
  async function getCustomers(){return all("customers");}
  async function getCustomerPayments(){return all("customerPayments");}
  async function getReturns(){return all("returns");}
  async function getCashEntries(){return all("cashEntries");}
  async function getShifts(){return all("shifts");}

  async function getProductByBarcode(code){
    const db=await openDB();
    try{return await requestResult(db.transaction("products","readonly").objectStore("products").index("barcode").get(code));}
    finally{db.close();}
  }
  async function saveProduct(product){
    const clean={...product,active:product.active!==false,minStock:Math.max(0,Number(product.minStock)||0)};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["products","movements"],"readwrite");
        const store=tx.objectStore("products"),req=store.get(clean.id);
        let failure="";
        req.onsuccess=()=>{
          const existing=req.result||null;
          const oldTracked=!!(existing&&existing.trackStock);
          const oldQty=oldTracked?Number(existing.stock||0):0;
          if(oldTracked&&!clean.trackStock&&oldQty>0.000001){
            failure="لا يمكن إيقاف تتبع المخزون لصنف له رصيد. سجّل تسوية أو جردًا حتى يصبح الرصيد صفرًا أولًا.";
            try{tx.abort();}catch(e){}
            return;
          }
          const newTracked=!!clean.trackStock,newQty=newTracked?Number(clean.stock||0):0;
          if(newTracked&&(!oldTracked||Math.abs(newQty-oldQty)>0.000001)){
            const delta=newQty-oldQty;
            if(Math.abs(delta)>0.000001){
              tx.objectStore("movements").add({
                id:crypto.randomUUID(),productId:clean.id,productName:clean.name,
                type:oldTracked?"adjustment":"opening",quantity:delta,unit:clean.unit,
                createdAt:clean.updatedAt||new Date().toISOString(),
                note:oldTracked?"تعديل الرصيد من بطاقة المنتج":"رصيد افتتاحي عند تسجيل الصنف"
              });
            }
          }
          store.put(clean);
        };
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error(failure||"تعذر حفظ المنتج."));
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
        for(const product of products)store.put({...product,active:product.active!==false,minStock:Math.max(0,Number(product.minStock)||0)});
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
        const tx=db.transaction(["products","movements","invoices","purchases","returns"],"readwrite");
        const ps=tx.objectStore("products"),req=ps.get(id);
        let failure="",result={deleted:false,archived:false};
        req.onsuccess=()=>{
          const product=req.result;
          if(!product){result={deleted:true,archived:false};return;}
          const movementReq=tx.objectStore("movements").getAll();
          const invoiceReq=tx.objectStore("invoices").getAll();
          const purchaseReq=tx.objectStore("purchases").getAll();
          const returnReq=tx.objectStore("returns").getAll();
          let ready=0,movements,invoices,purchases,returns;
          const finish=()=>{
            if(++ready!==4)return;
            const referenced=(movements||[]).some(x=>x.productId===id)
              ||(invoices||[]).some(x=>(x.items||[]).some(item=>item.productId===id))
              ||(purchases||[]).some(x=>(x.items||[]).some(item=>item.productId===id))
              ||(returns||[]).some(x=>(x.items||[]).some(item=>item.productId===id));
            const hasStock=product.trackStock&&Number(product.stock||0)>0.000001;
            if(referenced||hasStock){
              product.active=false;
              product.archivedAt=new Date().toISOString();
              product.updatedAt=product.archivedAt;
              ps.put(product);
              result={deleted:false,archived:true};
            }else{
              ps.delete(id);
              result={deleted:true,archived:false};
            }
          };
          movementReq.onsuccess=()=>{movements=movementReq.result;finish();};
          invoiceReq.onsuccess=()=>{invoices=invoiceReq.result;finish();};
          purchaseReq.onsuccess=()=>{purchases=purchaseReq.result;finish();};
          returnReq.onsuccess=()=>{returns=returnReq.result;finish();};
        };
        req.onerror=()=>{failure="تعذر قراءة الصنف.";try{tx.abort();}catch(e){}};
        tx.oncomplete=()=>resolve(result);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error(failure||"تعذر حذف أو أرشفة الصنف."));
      });
    }finally{db.close();}
  }
  async function setProductActive(id,active){
    const db=await openDB();
    try{
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction("products","readwrite"),store=tx.objectStore("products"),req=store.get(id);
        let failure="";
        req.onsuccess=()=>{
          const product=req.result;
          if(!product){failure="الصنف غير موجود.";try{tx.abort();}catch(e){}return;}
          product.active=!!active;
          product.updatedAt=new Date().toISOString();
          if(active)delete product.archivedAt;
          else product.archivedAt=product.updatedAt;
          store.put(product);
        };
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error(failure||"تعذر تحديث حالة الصنف."));
      });
    }finally{db.close();}
  }
  async function saveInvoice(invoice){
    if(!invoice||!String(invoice.id||"").trim()||!Array.isArray(invoice.items)||!invoice.items.length)throw new Error("بيانات الفاتورة غير مكتملة.");
    const subtotal=Number(invoice.subtotal),discount=Number(invoice.discount||0),total=Number(invoice.total);
    if(!Number.isFinite(subtotal)||subtotal<0||!Number.isFinite(discount)||discount<0||discount>subtotal+0.000001||
       !Number.isFinite(total)||total<0||Math.abs(total-Math.round((subtotal-discount)*100)/100)>0.02||
       !["cash","electronic","credit"].includes(invoice.paymentMethod))throw new Error("راجع إجمالي الفاتورة والخصم وطريقة الدفع.");
    const paidAmount=invoice.paidAmount===undefined||invoice.paidAmount===null
      ?(invoice.paymentMethod==="credit"?0:total):Number(invoice.paidAmount);
    const remainingAmount=invoice.remainingAmount===undefined||invoice.remainingAmount===null
      ?Math.max(0,Math.round((total-paidAmount)*100)/100):Number(invoice.remainingAmount);
    const paidMethod=invoice.paidMethod|| (invoice.paymentMethod==="electronic"?"electronic":"cash");
    if(!Number.isFinite(paidAmount)||paidAmount<0||paidAmount>total+0.005||
       !Number.isFinite(remainingAmount)||remainingAmount<0||
       Math.abs(Math.round((paidAmount+remainingAmount-total)*100)/100)>0.02||
       !["cash","electronic"].includes(paidMethod)||
       (remainingAmount>0.005&&invoice.paymentMethod!=="credit"))
      throw new Error("راجع المبلغ المدفوع والباقي وطريقة استلام المبلغ.");
    invoice.paidAmount=Math.round(paidAmount*100)/100;
    invoice.remainingAmount=Math.round(remainingAmount*100)/100;
    invoice.paidMethod=paidMethod;
    const quantities=new Map();
    let linesTotal=0;
    for(const item of invoice.items){
      if(!item||!String(item.name||"").trim())throw new Error("يوجد بند غير صحيح في الفاتورة.");
      const quantity=Number(item.stockQuantity??item.quantity),price=Number(item.unitPrice);
      const lineTotal=Number(item.total??(quantity*price));
      if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(price)||price<0||
         !Number.isFinite(lineTotal)||lineTotal<0||
         (item.unit==="piece"&&!Number.isInteger(quantity)))
        throw new Error("راجع كمية وسعر وإجمالي كل بند في الفاتورة.");
      linesTotal+=lineTotal;
      if(item.productId)quantities.set(item.productId,(quantities.get(item.productId)||0)+quantity);
    }
    if(Math.abs(linesTotal-subtotal)>0.02)throw new Error("مجموع بنود الفاتورة لا يطابق الإجمالي قبل الخصم.");
    const db=await openDB();
    try{
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction(["invoices","products","movements","cashEntries"],"readwrite");
        const ps=tx.objectStore("products"),ms=tx.objectStore("movements");
        let failure="";
        for(const [productId,quantity] of quantities){
          const req=ps.get(productId);
          req.onsuccess=()=>{
            if(failure)return;
            const p=req.result;
            if(!p){failure="يوجد صنف غير موجود ضمن هذه الفاتورة.";try{tx.abort();}catch(e){}return;}
            if(p.active===false){failure="هذا الصنف مؤرشف ولا يمكن بيعه قبل إعادة تفعيله.";try{tx.abort();}catch(e){}return;}
            if(p.unit==="piece"&&!Number.isInteger(quantity)){failure="كمية القطعة يجب أن تكون عددًا صحيحًا.";try{tx.abort();}catch(e){}return;}
            if(!p.trackStock)return;
            const next=Number(p.stock||0)-quantity;
            if(!Number.isFinite(next)||next< -0.000001){failure="الكمية المتاحة لا تكفي لإتمام الفاتورة.";try{tx.abort();}catch(e){}return;}
            p.stock=Math.max(0,next);p.updatedAt=invoice.createdAt;ps.put(p);
            ms.add({id:crypto.randomUUID(),productId:p.id,productName:p.name,type:"sale",quantity:-quantity,unit:p.unit,
              referenceId:invoice.id,referenceNumber:invoice.id,createdAt:invoice.createdAt,note:"بيع"});
          };
        }
        tx.objectStore("invoices").add(invoice);
        if(paidAmount>0.005){
          tx.objectStore("cashEntries").add({id:crypto.randomUUID(),type:"income",category:"sale",amount:Math.round(paidAmount*100)/100,
            method:paidMethod,referenceId:invoice.id,note:"مدفوع فاتورة مبيعات "+String(invoice.id||""),
            createdAt:invoice.createdAt||new Date().toISOString()});
        }
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error||new Error(failure||"تعذر حفظ الفاتورة. لم يتم تغيير الأرصدة."));
        tx.onabort=()=>reject(new Error(failure||"تعذر حفظ الفاتورة. لم يتم تغيير الأرصدة."));
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
    const amount=Number(payment&&payment.amount),method=payment&&payment.method||"cash";
    if(!payment||!payment.id||!payment.supplierId||!Number.isFinite(amount)||amount<=0||!["cash","electronic"].includes(method))
      throw new Error("بيانات دفعة المورد غير صحيحة.");
    const clean={...payment,amount,method,createdAt:payment.createdAt||new Date().toISOString()};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["supplierPayments","suppliers","purchases","cashEntries"],"readwrite");
        const supplierReq=tx.objectStore("suppliers").get(clean.supplierId);
        const purchasesReq=tx.objectStore("purchases").getAll();
        const paymentsReq=tx.objectStore("supplierPayments").getAll();
        let supplier=null,purchases=null,payments=null,failure="";
        const commit=()=>{
          if(!supplier||!purchases||!payments)return;
          const balance=Number(supplier.openingBalance||0)
            +purchases.filter(x=>x.supplierId===clean.supplierId).reduce((sum,x)=>sum+Number(x.total||0)-Number(x.paidAmount||0),0)
            -payments.filter(x=>x.supplierId===clean.supplierId).reduce((sum,x)=>sum+Number(x.amount||0),0);
          if(amount>balance+0.005){failure="مبلغ السداد أكبر من رصيد المورد المستحق: "+balance.toFixed(2)+" جنيه.";try{tx.abort();}catch(e){}return;}
          clean.supplierName=supplier.name;
          tx.objectStore("supplierPayments").add(clean);
          tx.objectStore("cashEntries").add({id:crypto.randomUUID(),type:"expense",category:"supplier_payment",amount,method,
            referenceId:clean.id,note:"سداد المورد "+String(clean.supplierName||""),createdAt:clean.createdAt});
        };
        supplierReq.onsuccess=()=>{supplier=supplierReq.result;if(!supplier){failure="المورد غير موجود.";try{tx.abort();}catch(e){}return;}commit();};
        purchasesReq.onsuccess=()=>{purchases=purchasesReq.result;commit();};
        paymentsReq.onsuccess=()=>{payments=paymentsReq.result;commit();};
        tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error(failure||"تعذر تسجيل دفعة المورد."));
      });
    }finally{db.close();}
  }

  async function savePurchase(purchase){
    if(!purchase||!Array.isArray(purchase.items)||!purchase.items.length)throw new Error("أضف صنفًا واحدًا على الأقل للمشتريات.");
    const total=Number(purchase.total),paid=Number(purchase.paidAmount||0),method=purchase.paymentMethod||"cash";
    if(!Number.isFinite(total)||total<=0||!Number.isFinite(paid)||paid<0||paid>total+0.000001||!["cash","electronic"].includes(method))throw new Error("راجع إجمالي المشتريات والمبلغ المدفوع وطريقة الدفع.");
    const ids=new Set();let calculatedTotal=0;
    for(const item of purchase.items){
      if(!item.productId||ids.has(item.productId))throw new Error("لا تكرر الصنف في نفس فاتورة الشراء.");
      ids.add(item.productId);
      const quantity=Number(item.quantity),unitCost=Number(item.unitCost);
      if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitCost)||unitCost<0||(item.unit==="piece"&&!Number.isInteger(quantity)))throw new Error("راجع كمية وتكلفة كل صنف؛ كمية القطعة يجب أن تكون عددًا صحيحًا.");
      calculatedTotal+=quantity*unitCost;
    }
    if(!Number.isFinite(calculatedTotal)||Math.abs(calculatedTotal-total)>0.02)throw new Error("إجمالي فاتورة الشراء لا يطابق مجموع كميات الأصناف مضروبًا في تكلفة الوحدة.");
    const clean={...purchase,total,paidAmount:paid,paymentMethod:method,balance:Math.max(0,total-paid),createdAt:purchase.createdAt||new Date().toISOString()};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["purchases","products","movements","cashEntries"],"readwrite");
        const products=tx.objectStore("products"),movements=tx.objectStore("movements");
        tx.objectStore("purchases").add(clean);
        if(paid>0)tx.objectStore("cashEntries").add({
          id:crypto.randomUUID(),type:"expense",category:"purchase",amount:paid,
          method:clean.paymentMethod||"cash",referenceId:clean.id,note:"مدفوع فاتورة مشتريات "+String(clean.number||""),
          createdAt:clean.createdAt
        });
        for(const item of clean.items){
          const req=products.get(item.productId);
          req.onsuccess=()=>{
            const p=req.result;
            if(!p){try{tx.abort();}catch(e){}return;}
            const qty=Number(item.quantity),unitCost=Number(item.unitCost);
            if(p.unit==="piece"&&!Number.isInteger(qty)){try{tx.abort();}catch(e){}return;}
            const oldQty=p.trackStock?Number(p.stock||0):0;
            const oldCost=Number(p.cost||0);
            const nextQty=oldQty+qty;
            p.trackStock=true;
            p.stock=nextQty;
            p.cost=nextQty>0?((oldQty*oldCost)+(qty*unitCost))/nextQty:unitCost;
            p.costKnown=true;
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
          if((p.unit==="piece"&&!Number.isInteger(delta))||next< -0.000001){try{tx.abort();}catch(e){}return;}
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
      if(!item.productId||ids.has(item.productId)||!Number.isFinite(Number(item.countedQty))||Number(item.countedQty)<0||(item.unit==="piece"&&!Number.isInteger(Number(item.countedQty))))throw new Error("راجع الكميات المسجلة في الجرد؛ كمية القطعة يجب أن تكون عددًا صحيحًا.");
      ids.add(item.productId);
    }
    const clean={...stocktake,status:"completed",createdAt:stocktake.createdAt||new Date().toISOString()};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["stocktakes","products","movements"],"readwrite");
        const products=tx.objectStore("products"),movements=tx.objectStore("movements");
        let completed=0,failed=false;
        for(const item of clean.items){
          const req=products.get(item.productId);
          req.onsuccess=()=>{
            const p=req.result;
            if(!p){failed=true;try{tx.abort();}catch(e){}return;}
            const counted=Number(item.countedQty);
            if(p.unit==="piece"&&!Number.isInteger(counted)){failed=true;try{tx.abort();}catch(e){}return;}
            const before=p.trackStock?Number(p.stock||0):0;
            const difference=counted-before;
            item.systemQtyAtCommit=before;
            item.difference=difference;
            p.trackStock=true;p.stock=counted;p.updatedAt=clean.createdAt;products.put(p);
            if(Math.abs(difference)>0.0000001){
              movements.add({
                id:crypto.randomUUID(),productId:p.id,productName:p.name,type:"stocktake",
                quantity:difference,unit:p.unit,createdAt:clean.createdAt,
                referenceId:clean.id,referenceNumber:clean.number||clean.id,
                note:"تسوية ناتجة عن الجرد الفعلي"
              });
            }
            completed++;
            if(completed===clean.items.length)tx.objectStore("stocktakes").add(clean);
          };
          req.onerror=()=>{failed=true;try{tx.abort();}catch(e){}};
        }
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error(failed?"تعذر العثور على صنف من أصناف الجرد. لم يتم تعديل الأرصدة.":"تعذر اعتماد الجرد. لم يتم تغيير أرصدة المنتجات."));
      });
    }finally{db.close();}
  }


  async function saveCustomer(customer){
    if(!customer||!String(customer.name||"").trim())throw new Error("اكتب اسم العميل.");
    const normalizePhone=value=>{
      let digits=String(value||"")
        .replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
        .replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
        .replace(/\D/g,"");
      if(digits.startsWith("0020"))digits="0"+digits.slice(4);
      else if(digits.startsWith("20")&&digits.length===12)digits="0"+digits.slice(2);
      return digits;
    };
    const phone=normalizePhone(customer.phone);
    if(phone&&(phone.length<8||phone.length>15))throw new Error("رقم هاتف العميل غير صحيح.");
    const clean={...customer,name:String(customer.name).trim(),phone,openingBalance:Math.max(0,Number(customer.openingBalance)||0),active:customer.active!==false,updatedAt:new Date().toISOString()};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction("customers","readwrite"),store=tx.objectStore("customers");
        let failure="";
        if(clean.phone){
          const req=store.getAll();
          req.onsuccess=()=>{
            const duplicate=req.result.find(old=>old.id!==clean.id&&normalizePhone(old.phone)===clean.phone);
            if(duplicate){failure="رقم الهاتف مسجل بالفعل للعميل: "+duplicate.name;try{tx.abort();}catch(e){}return;}
            store.put(clean);
          };
        }else store.put(clean);
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error(failure||"تعذر حفظ بيانات العميل."));
      });
      return clean;
    }finally{db.close();}
  }
  async function saveCustomerPayment(payment){
    const amount=Number(payment&&payment.amount),method=payment&&payment.method||"cash";
    if(!payment||!payment.id||!payment.customerId||!Number.isFinite(amount)||amount<=0||!["cash","electronic"].includes(method))
      throw new Error("بيانات تحصيل العميل غير صحيحة.");
    const clean={...payment,amount,method,createdAt:payment.createdAt||new Date().toISOString()};
    const normalizePhone=value=>{
      let digits=String(value||"").replace(/\D/g,"");
      if(digits.startsWith("0020"))digits="0"+digits.slice(4);
      else if(digits.startsWith("20")&&digits.length===12)digits="0"+digits.slice(2);
      return digits;
    };
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["customerPayments","customers","invoices","returns","cashEntries"],"readwrite");
        const customerReq=tx.objectStore("customers").get(clean.customerId);
        const invoicesReq=tx.objectStore("invoices").getAll();
        const paymentsReq=tx.objectStore("customerPayments").getAll();
        const returnsReq=tx.objectStore("returns").getAll();
        let customer=null,invoices=null,payments=null,returns=null,failure="";
        const commit=()=>{
          if(!customer||!invoices||!payments||!returns)return;
          const matches=invoice=>invoice.customerId===customer.id||
            (!!customer.phone&&normalizePhone(invoice.customerPhone)===normalizePhone(customer.phone));
          const sales=invoices.filter(x=>x.paymentMethod==="credit"&&matches(x)).reduce((sum,x)=>
            sum+(Number.isFinite(Number(x.remainingAmount))?Number(x.remainingAmount):Number(x.total||0)),0);
          const collected=payments.filter(x=>x.customerId===customer.id).reduce((sum,x)=>sum+Number(x.amount||0),0);
          const credited=returns.filter(x=>invoices.some(inv=>inv.id===x.invoiceId&&matches(inv)))
            .reduce((sum,x)=>{
              const credit=Number.isFinite(Number(x.creditReductionAmount))
                ?Number(x.creditReductionAmount):(x.refundMethod==="credit"?Number(x.amount||0):0);
              return sum+Math.max(0,credit);
            },0);
          const balance=Number(customer.openingBalance||0)+sales-collected-credited;
          if(amount>balance+0.005){failure="مبلغ التحصيل أكبر من مديونية العميل: "+balance.toFixed(2)+" جنيه.";try{tx.abort();}catch(e){}return;}
          clean.customerName=customer.name;
          tx.objectStore("customerPayments").add(clean);
          tx.objectStore("cashEntries").add({id:crypto.randomUUID(),type:"income",category:"customer_collection",amount,method,
            referenceId:clean.id,note:"تحصيل من "+String(clean.customerName||""),createdAt:clean.createdAt});
        };
        customerReq.onsuccess=()=>{customer=customerReq.result;if(!customer){failure="العميل غير موجود.";try{tx.abort();}catch(e){}return;}commit();};
        invoicesReq.onsuccess=()=>{invoices=invoicesReq.result;commit();};
        paymentsReq.onsuccess=()=>{payments=paymentsReq.result;commit();};
        returnsReq.onsuccess=()=>{returns=returnsReq.result;commit();};
        tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error(failure||"تعذر تسجيل التحصيل."));
      });
    }finally{db.close();}
  }

  function calculateDiscountedLineTotals(invoice){
    const items=Array.isArray(invoice&&invoice.items)?invoice.items:[];
    if(!items.length)return [];
    const gross=items.map(item=>{
      const saved=item&&item.total;
      const amount=saved!==undefined&&saved!==null&&Number.isFinite(Number(saved))
        ?Number(saved):Number(item&&item.quantity||0)*Number(item&&item.unitPrice||0);
      return Math.max(0,Number.isFinite(amount)?amount:0);
    });
    const grossTotal=gross.reduce((sum,value)=>sum+value,0);
    const invoiceTotal=Number(invoice&&invoice.total);
    const subtotal=Number(invoice&&invoice.subtotal);
    const discount=Number(invoice&&invoice.discount||0);
    const netTotal=Number.isFinite(invoiceTotal)?invoiceTotal:
      Math.max(0,(Number.isFinite(subtotal)?subtotal:grossTotal)-discount);
    const targetCents=Math.max(0,Math.round((netTotal+1e-9)*100));
    if(grossTotal<=0){
      const fallback=items.map(()=>0);
      fallback[fallback.length-1]=targetCents/100;
      return fallback;
    }
    const rawCents=gross.map(value=>value/grossTotal*targetCents);
    const allocated=rawCents.map(value=>Math.floor(value+1e-9));
    let remainder=targetCents-allocated.reduce((sum,value)=>sum+value,0);
    const order=rawCents.map((value,index)=>({index,fraction:value-Math.floor(value+1e-9)}))
      .sort((a,b)=>b.fraction-a.fraction||a.index-b.index);
    for(let i=0;remainder>0;i=(i+1)%order.length,remainder--)allocated[order[i].index]++;
    for(let i=0;remainder<0;i=(i+1)%order.length){
      const target=order[order.length-1-i%order.length].index;
      if(allocated[target]>0){allocated[target]--;remainder++;}
    }
    return allocated.map(value=>value/100);
  }

  async function saveReturn(record){
    if(!record||!record.invoiceId||!Array.isArray(record.items)||!record.items.length)throw new Error("بيانات المرتجع غير مكتملة.");
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(["returns","invoices","products","movements","cashEntries","customers","customerPayments"],"readwrite");
        const rs=tx.objectStore("returns"),is=tx.objectStore("invoices"),ps=tx.objectStore("products"),ms=tx.objectStore("movements");
        const invoiceReq=is.get(record.invoiceId);let failed=false;
        invoiceReq.onsuccess=()=>{
          const invoice=invoiceReq.result;
          if(!invoice){failed=true;try{tx.abort();}catch(e){}return;}
          const paidAmount=invoice.paidAmount!==undefined&&invoice.paidAmount!==null
            ?Number(invoice.paidAmount):(invoice.paymentMethod==="credit"?0:Number(invoice.total||0));
          const isPartiallyPaid=invoice.paymentMethod==="credit"&&paidAmount>0.005;
          const allowedMethods=invoice.paymentMethod==="credit"?["credit","cash","electronic"]:
            [invoice.paymentMethod==="electronic"?"electronic":"cash"];
          if(!allowedMethods.includes(record.refundMethod)){failed=true;try{tx.abort();}catch(e){}return;}

          const existingReq=rs.getAll(),allInvoicesReq=is.getAll(),
            allPaymentsReq=tx.objectStore("customerPayments").getAll(),
            allCustomersReq=tx.objectStore("customers").getAll();
          let allReturns=null,allInvoices=null,allPayments=null,allCustomers=null,processed=false;
          const processReturn=()=>{
            if(processed||allReturns===null||allInvoices===null||allPayments===null||allCustomers===null)return;
            processed=true;
            const prior=allReturns.filter(x=>x.invoiceId===record.invoiceId);
            const normalizePhone=value=>{
              let digits=String(value||"").replace(/[^0-9]/g,"");
              if(digits.startsWith("0020"))digits="0"+digits.slice(4);
              else if(digits.startsWith("20")&&digits.length===12)digits="0"+digits.slice(2);
              return digits;
            };
            const invoicePhone=normalizePhone(invoice.customerPhone);
            const customer=allCustomers.find(x=>
              (invoice.customerId&&x.id===invoice.customerId)||
              (invoicePhone&&normalizePhone(x.phone)===invoicePhone)
            );
            const customerId=invoice.customerId||(customer&&customer.id)||"";
            const matchesCustomer=other=>
              !!customerId&&other.customerId===customerId ||
              !!invoicePhone&&normalizePhone(other.customerPhone)===invoicePhone;
            const customerInvoices=allInvoices
              .filter(x=>x.paymentMethod==="credit"&&matchesCustomer(x))
              .sort((x,y)=>String(x.createdAt||"").localeCompare(String(y.createdAt||"")));
            if(!customerInvoices.some(x=>x.id===invoice.id))customerInvoices.push(invoice);
            let collected=allPayments
              .filter(x=>x.customerId===customerId)
              .reduce((sum,x)=>sum+Number(x.amount||0),0);
            // Customer collections are allocated FIFO: clear the opening balance,
            // then the oldest unpaid invoices first. This prevents a return from
            // reducing debt already settled by a later customer collection.
            const opening=Math.max(0,Number(customer&&customer.openingBalance||0));
            collected=Math.max(0,collected-Math.min(opening,collected));
            let invoiceOutstanding=0;
            for(const customerInvoice of customerInvoices){
              const priorCredits=allReturns
                .filter(x=>x.invoiceId===customerInvoice.id)
                .reduce((sum,x)=>{
                  const credit=Number.isFinite(Number(x.creditReductionAmount))
                    ?Number(x.creditReductionAmount)
                    :x.refundMethod==="credit"?Number(x.amount||0):0;
                  return sum+Math.max(0,credit);
                },0);
              const baseDue=Number.isFinite(Number(customerInvoice.remainingAmount))
                ?Number(customerInvoice.remainingAmount)
                :(customerInvoice.paymentMethod==="credit"?Number(customerInvoice.total||0):0);
              const due=Math.max(0,baseDue-priorCredits);
              const settled=Math.min(due,collected);
              const outstanding=Math.max(0,due-settled);
              collected=Math.max(0,collected-settled);
              if(customerInvoice.id===invoice.id)invoiceOutstanding=outstanding;
            }

            const discountedLineTotals=calculateDiscountedLineTotals(invoice);
            let amount=0;const lines=[],seenIndexes=new Set(),returnedInRequest=new Map();
            for(const line of record.items){
              const index=Number(line.itemIndex),sold=(invoice.items||[])[index];
              if(!Number.isInteger(index)||index<0||!sold||seenIndexes.has(index)){failed=true;try{tx.abort();}catch(e){}return;}
              seenIndexes.add(index);
              const priorLines=prior.flatMap(r=>(r.items||[]).filter(x=>Number(x.itemIndex)===index));
              const returned=priorLines.reduce((sum,x)=>sum+Number(x.quantity||0),0);
              const priorRefundedAmount=priorLines.reduce((sum,x)=>sum+
                (x.amount!==undefined&&x.amount!==null&&Number.isFinite(Number(x.amount))?Number(x.amount):0),0);
              const qty=Number(line.quantity),alreadyRequested=returnedInRequest.get(index)||0;
              const soldQuantity=Number(sold.quantity||0);
              const remaining=soldQuantity-returned-alreadyRequested;
              if(!Number.isFinite(qty)||qty<=0||qty>remaining+0.000001||(sold.unit==="piece"&&!Number.isInteger(qty))){failed=true;try{tx.abort();}catch(e){}return;}
              returnedInRequest.set(index,alreadyRequested+qty);
              const cumulativeQuantity=Math.min(soldQuantity,returned+alreadyRequested+qty);
              const netLineTotal=Number(discountedLineTotals[index]||0);
              const cumulativeRefund=Math.round((netLineTotal*cumulativeQuantity/Math.max(soldQuantity,0.000001)+1e-9)*100)/100;
              const lineAmount=Math.max(0,Math.round((cumulativeRefund-priorRefundedAmount+1e-9)*100)/100);
              amount+=lineAmount;
              lines.push({itemIndex:index,productId:sold.productId||null,name:sold.name,unit:sold.unit,quantity:qty,unitPrice:Number(sold.unitPrice||0),
                cost:sold.cost!==undefined&&sold.cost!==null&&Number.isFinite(Number(sold.cost))?Number(sold.cost):null,
                costKnown:sold.costKnown===true||(sold.cost!==undefined&&sold.cost!==null&&Number(sold.cost)>0),amount:lineAmount});
            }
            amount=Math.round(amount*100)/100;
            const creditReductionAmount=Math.min(amount,Math.max(0,invoiceOutstanding));
            const paidRefundAmount=Math.max(0,Math.round((amount-creditReductionAmount)*100)/100);
            const paidRefundMethod=paidRefundAmount>0.005
              ?(record.refundMethod==="cash"||record.refundMethod==="electronic"?record.refundMethod:(invoice.paidMethod||"cash"))
              :(invoice.paidMethod||record.refundMethod);
            const clean={...record,items:lines,amount,creditReductionAmount:Math.round(creditReductionAmount*100)/100,
              paidRefundAmount,paidRefundMethod,createdAt:record.createdAt||new Date().toISOString()};
            rs.add(clean);
            for(const line of lines){
              if(!line.productId)continue;
              const req=ps.get(line.productId);
              req.onsuccess=()=>{
                const p=req.result;if(!p)return;
                if(p.trackStock){
                  p.stock=Number(p.stock||0)+line.quantity;p.updatedAt=clean.createdAt;ps.put(p);
                  ms.add({id:crypto.randomUUID(),productId:p.id,productName:p.name,type:"return",quantity:line.quantity,unit:p.unit,referenceId:clean.id,referenceNumber:clean.invoiceId,createdAt:clean.createdAt,note:"مرتجع مبيعات"});
                }
              };
            }
            if(clean.paidRefundAmount>0.005){
              tx.objectStore("cashEntries").add({id:crypto.randomUUID(),type:"expense",category:"sales_return",
                amount:clean.paidRefundAmount,method:clean.paidRefundMethod,referenceId:clean.id,
                note:"رد الجزء المدفوع من مرتجع فاتورة",createdAt:clean.createdAt});
            }
          };
          existingReq.onsuccess=()=>{allReturns=existingReq.result||[];processReturn();};
          allInvoicesReq.onsuccess=()=>{allInvoices=allInvoicesReq.result||[];processReturn();};
          allPaymentsReq.onsuccess=()=>{allPayments=allPaymentsReq.result||[];processReturn();};
          allCustomersReq.onsuccess=()=>{allCustomers=allCustomersReq.result||[];processReturn();};
        };
        tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(new Error(failed?"كمية المرتجع أكبر من الكمية المتبقية أو بيانات الفاتورة غير صحيحة.":"تعذر حفظ المرتجع."));
      });
    }finally{db.close();}
  }

  async function saveCashEntry(entry){
    const amount=Number(entry&&entry.amount),method=entry&&entry.method||"cash";
    if(!entry||!Number.isFinite(amount)||amount<=0||!["income","expense"].includes(entry.type)||!["cash","electronic"].includes(method))
      throw new Error("راجع نوع وقيمة الحركة المالية وطريقة الدفع.");
    const clean={...entry,amount,method,category:String(entry.category||"other"),note:String(entry.note||"").trim(),createdAt:entry.createdAt||new Date().toISOString()};
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction("cashEntries","readwrite");tx.objectStore("cashEntries").add(clean);
        tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
    }finally{db.close();}
  }
  async function saveShift(shift){
    if(!shift||!shift.id||!["open","closed"].includes(shift.status))throw new Error("بيانات الوردية غير صحيحة.");
    if(shift.status==="open"&&(!Number.isFinite(Number(shift.openingCash))||Number(shift.openingCash)<0))throw new Error("رصيد بداية الوردية غير صحيح.");
    if(shift.status==="closed"&&(!Number.isFinite(Number(shift.countedCash))||Number(shift.countedCash)<0||!Number.isFinite(Number(shift.expectedCash))))throw new Error("بيانات إغلاق الوردية غير صحيحة.");
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction("shifts","readwrite"),store=tx.objectStore("shifts");let failure="";
        if(shift.status==="open"){
          const req=store.getAll();
          req.onsuccess=()=>{
            if(req.result.some(x=>x.status==="open"&&x.id!==shift.id)){failure="توجد وردية مفتوحة بالفعل. أغلقها أولًا.";try{tx.abort();}catch(e){}return;}
            store.put({...shift,openingCash:Number(shift.openingCash)});
          };
        }else{
          const req=store.get(shift.id);
          req.onsuccess=()=>{
            if(!req.result||req.result.status!=="open"){failure="لا يمكن إغلاق وردية غير مفتوحة.";try{tx.abort();}catch(e){}return;}
            store.put({...req.result,...shift,countedCash:Number(shift.countedCash),expectedCash:Number(shift.expectedCash)});
          };
        }
        tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(new Error(failure||"تعذر حفظ الوردية."));
      });
    }finally{db.close();}
  }

  async function backupData(){
    const values=await Promise.all(STORE_NAMES.map(name=>all(name)));
    const data={};
    STORE_NAMES.forEach((name,index)=>data[name]=values[index]);
    return {app:"supermarket-pos",schemaVersion:4,exportedAt:new Date().toISOString(),data};
  }
  async function restoreData(payload){
    if(!payload||payload.app!=="supermarket-pos"||!payload.data||!Array.isArray(payload.data.products)||!Array.isArray(payload.data.invoices))throw new Error("ملف النسخة الاحتياطية غير صحيح.");
    const restored={...payload.data};
    if(Number(payload.schemaVersion||0)<4||!Array.isArray(restored.cashEntries)||!Array.isArray(restored.customers)){
      restored.invoices=(restored.invoices||[]).map(invoice=>({...invoice}));
      const normalizedPhone=value=>{
        let digits=String(value||"").replace(/\D/g,"");
        if(digits.startsWith("0020"))digits="0"+digits.slice(4);
        else if(digits.startsWith("20")&&digits.length===12)digits="0"+digits.slice(2);
        return digits;
      };
      if(!Array.isArray(restored.customers)){
        const customersById=new Map();
        restored.invoices.forEach(invoice=>{
          if(invoice.paymentMethod!=="credit"||!String(invoice.customerName||"").trim())return;
          const phone=normalizedPhone(invoice.customerPhone);
          const id=invoice.customerId|| (phone?"legacy-customer-"+phone:"legacy-customer-"+String(invoice.id));
          invoice.customerId=id;
          customersById.set(id,{id,name:String(invoice.customerName).trim(),phone:phone||String(invoice.customerPhone||""),openingBalance:0,active:true,note:"تم ترحيله من نسخة احتياطية سابقة",createdAt:invoice.createdAt||new Date().toISOString()});
        });
        restored.customers=[...customersById.values()];
      }
      if(!Array.isArray(restored.cashEntries)){
        const entries=[];
        (restored.invoices||[]).forEach(invoice=>{
          const amount=Number(invoice.total||0);
          if(amount>0&&(invoice.paymentMethod==="cash"||invoice.paymentMethod==="electronic"))entries.push({id:"migration-sale-"+String(invoice.id),type:"income",category:"sale",amount,method:invoice.paymentMethod,referenceId:invoice.id,note:"مبيعات سابقة "+String(invoice.id||""),createdAt:invoice.createdAt||new Date().toISOString()});
        });
        (restored.purchases||[]).forEach(purchase=>{
          const amount=Number(purchase.paidAmount||0);
          if(amount>0)entries.push({id:"migration-purchase-"+String(purchase.id),type:"expense",category:"purchase",amount,method:purchase.paymentMethod||"cash",referenceId:purchase.id,note:"مدفوع مشتريات سابقة "+String(purchase.number||""),createdAt:purchase.createdAt||new Date().toISOString()});
        });
        (restored.supplierPayments||[]).forEach(payment=>{
          const amount=Number(payment.amount||0);
          if(amount>0)entries.push({id:"migration-supplier-payment-"+String(payment.id),type:"expense",category:"supplier_payment",amount,method:payment.method||"cash",referenceId:payment.id,note:"سداد مورد سابق "+String(payment.supplierName||""),createdAt:payment.createdAt||new Date().toISOString()});
        });
        restored.cashEntries=entries;
      }
    }
    for(const name of STORE_NAMES)if(!Array.isArray(restored[name]))restored[name]=[];
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORE_NAMES,"readwrite");
        for(const name of STORE_NAMES)tx.objectStore(name).clear();
        for(const name of STORE_NAMES){
          const rows=restored[name]||[];
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

  async function applyCloudRecords(changes,replaceAll){
    if(!Array.isArray(changes))throw new Error("بيانات المزامنة غير صحيحة.");
    const allowed=new Set(STORE_NAMES);
    for(const change of changes){
      if(!change||!allowed.has(change.store)||change.recordId===undefined||change.recordId===null)throw new Error("سجل سحابي غير صالح.");
      if(!change.deleted&&(!change.data||typeof change.data!=="object"))throw new Error("بيانات سجل سحابي غير مكتملة.");
    }
    const db=await openDB();
    try{
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORE_NAMES,"readwrite");
        const productsStore=tx.objectStore("products"),movementsStore=tx.objectStore("movements");
        let oldProducts=null,oldMovements=null,newProducts=null,newMovements=null;
        let failure="";
        const finishRecalculation=()=>{
          if(!newProducts||!newMovements)return;
          const totals=new Map();
          newMovements.forEach(movement=>{
            const id=String(movement.productId||"");
            if(id)totals.set(id,Number(totals.get(id)||0)+Number(movement.quantity||0));
          });
          newProducts.forEach(product=>{
            if(!product.trackStock)return;
            const base=Number(product.cloudStockBase!==undefined?product.cloudStockBase:product.stock||0);
            product.stock=Math.round((base+Number(totals.get(String(product.id))||0))*1000)/1000;
            productsStore.put(product);
          });
        };
        const recalcProductsReq=()=>{
          const pReq=productsStore.getAll(),mReq=movementsStore.getAll();
          pReq.onsuccess=()=>{newProducts=pReq.result||[];finishRecalculation();};
          mReq.onsuccess=()=>{newMovements=mReq.result||[];finishRecalculation();};
        };
        const applyChanges=()=>{
          if(oldProducts===null||oldMovements===null)return;
          if(!replaceAll){
            const oldTotals=new Map();
            oldMovements.forEach(movement=>{
              const id=String(movement.productId||"");
              if(id)oldTotals.set(id,Number(oldTotals.get(id)||0)+Number(movement.quantity||0));
            });
            oldProducts.forEach(product=>{
              if(product&&product.trackStock&&product.cloudStockBase===undefined){
                product.cloudStockBase=Math.round((Number(product.stock||0)-Number(oldTotals.get(String(product.id))||0))*1000)/1000;
                productsStore.put(product);
              }
            });
          }
          if(replaceAll)STORE_NAMES.forEach(name=>tx.objectStore(name).clear());
          changes.forEach(change=>{
            const store=tx.objectStore(change.store),key=String(change.recordId);
            if(change.deleted){store.delete(key);return;}
            const row={...change.data};
            if(change.store==="products"){
              const base=Number(row.cloudStockBase!==undefined?row.cloudStockBase:row.stock||0);
              row.cloudStockBase=Math.round(base*1000)/1000;
              row.stock=row.trackStock?row.cloudStockBase:null;
            }
            store.put(row);
          });
          const currentRole=window.POSGate&&window.POSGate.getSession?window.POSGate.getSession()?.role:"owner";
          if(currentRole!=="cashier"){
            const incomingSales=changes
              .filter(change=>change.store==="invoices"&&!change.deleted)
              .map(change=>change.data)
              .map(invoice=>{
                if(!invoice||!invoice.id)return null;
                const legacyAmount=Number(invoice.total||0);
                const amount=invoice.paidAmount!==undefined&&invoice.paidAmount!==null
                  ?Number(invoice.paidAmount):(["cash","electronic"].includes(invoice.paymentMethod)?legacyAmount:0);
                const method=invoice.paidMethod||invoice.paymentMethod;
                return {invoice,amount,method};
              })
              .filter(item=>item&&Number.isFinite(item.amount)&&item.amount>0&&["cash","electronic"].includes(item.method));
            if(incomingSales.length){
              const cashStore=tx.objectStore("cashEntries"),cashReq=cashStore.getAll();
              cashReq.onsuccess=()=>{
                const existing=new Set((cashReq.result||[]).filter(entry=>entry.category==="sale").map(entry=>String(entry.referenceId||"")));
                for(const item of incomingSales){
                  const invoice=item.invoice,referenceId=String(invoice.id);
                  if(existing.has(referenceId))continue;
                  cashStore.put({
                    id:"cloud-sale-"+referenceId,type:"income",category:"sale",amount:Math.round(item.amount*100)/100,
                    method:item.method,referenceId,note:"مدفوع فاتورة مبيعات "+referenceId,
                    createdAt:invoice.createdAt||new Date().toISOString()
                  });
                  existing.add(referenceId);
                }
              };
            }
          }
          recalcProductsReq();
        };
        const pReq=productsStore.getAll(),mReq=movementsStore.getAll();
        pReq.onsuccess=()=>{oldProducts=pReq.result||[];applyChanges();};
        mReq.onsuccess=()=>{oldMovements=mReq.result||[];applyChanges();};
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error||new Error("تعذر تطبيق التغييرات السحابية."));
        tx.onabort=()=>reject(new Error(failure||tx.error&&tx.error.message||"أُلغيت عملية تطبيق البيانات السحابية."));
      });
    }finally{db.close();}
  }

  window.POSDatabase={
    getProducts,getInvoices,getProductByBarcode,saveProduct,saveProducts,deleteProduct,setProductActive,saveInvoice,
    getMovements,getSuppliers,getPurchases,getSupplierPayments,getStocktakes,
    getCustomers,getCustomerPayments,getReturns,getCashEntries,getShifts,calculateDiscountedLineTotals,
    saveCustomer,saveCustomerPayment,saveReturn,saveCashEntry,saveShift,
    saveSupplier,saveSupplierPayment,savePurchase,saveStockAdjustment,saveStocktake,
    backupData,restoreData,getSettings,saveSettings,applyCloudRecords
  };
})();