"use strict";
const assert=require("node:assert/strict");
global.window=global;
if(!global.indexedDB)throw new Error("fake-indexeddb must be loaded with --require fake-indexeddb/auto");
require("../db.js");
const db=global.POSDatabase;
async function reset(){
  await new Promise((resolve,reject)=>{
    const request=indexedDB.deleteDatabase("supermarket_pos");
    request.onsuccess=()=>resolve();
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error("Database is still open"));
  });
}
async function run(){
  await reset();
  await db.saveProduct({
    id:"piece-1",name:"منتج اختبار",barcode:"",category:"اختبار",unit:"piece",
    price:50,cost:20,costKnown:true,trackStock:true,stock:10,minStock:1,active:true,
    updatedAt:new Date().toISOString()
  });
  const invoice={
    id:"invoice-1",createdAt:new Date().toISOString(),
    items:[{productId:"piece-1",name:"منتج اختبار",unit:"piece",quantity:2,stockQuantity:2,unitPrice:50,total:100,cost:20,costKnown:true}],
    subtotal:100,discount:10,total:90,paymentMethod:"cash",currency:"EGP",status:"saved"
  };
  await db.saveInvoice(invoice);
  assert.equal((await db.getProducts()).find(p=>p.id==="piece-1").stock,8,"Sale must reduce stock by the full sold quantity");

  await db.saveReturn({
    id:"return-1",invoiceId:"invoice-1",refundMethod:"cash",
    items:[{itemIndex:0,quantity:1}],createdAt:new Date().toISOString()
  });
  const firstReturn=(await db.getReturns())[0];
  assert.equal(firstReturn.amount,45,"Return value must include the proportional invoice discount");
  assert.equal((await db.getProducts()).find(p=>p.id==="piece-1").stock,9,"Partial return must restore only returned stock");

  await assert.rejects(
    db.saveReturn({id:"return-too-much",invoiceId:"invoice-1",refundMethod:"cash",items:[{itemIndex:0,quantity:1.01}]}),
    /كمية المرتجع|تعذر حفظ المرتجع/
  );
  await db.saveReturn({
    id:"return-2",invoiceId:"invoice-1",refundMethod:"cash",
    items:[{itemIndex:0,quantity:1}],createdAt:new Date().toISOString()
  });
  assert.equal((await db.getProducts()).find(p=>p.id==="piece-1").stock,10,"Second partial return restores the remaining sold unit");
  assert.equal((await db.getReturns()).reduce((sum,x)=>sum+x.amount,0),90,"All returned units must refund exactly the discounted invoice total");
  await assert.rejects(
    db.saveReturn({id:"return-after-full",invoiceId:"invoice-1",refundMethod:"cash",items:[{itemIndex:0,quantity:1}]}),
    /كمية المرتجع|تعذر حفظ المرتجع/
  );

  const movementsBefore=(await db.getMovements()).length;
  await assert.rejects(
    db.saveStockAdjustment({productId:"piece-1",delta:1.5,reason:"اختبار عدد كسري للقطعة"}),
    /تعذر تنفيذ التسوية/
  );
  assert.equal((await db.getProducts()).find(p=>p.id==="piece-1").stock,10,"Fractional piece adjustment must not change stock");
  assert.equal((await db.getMovements()).length,movementsBefore,"Rejected stock adjustment must not create a movement");

  await assert.rejects(
    db.savePurchase({id:"purchase-fraction",items:[{productId:"piece-1",quantity:1.5,unitCost:10}],total:15,paidAmount:0}),
    /كمية القطعة يجب أن تكون عددًا صحيحًا|تعذر حفظ فاتورة الشراء/
  );
  assert.equal((await db.getProducts()).find(p=>p.id==="piece-1").stock,10,"Rejected purchase must not change stock");
  assert.equal((await db.getPurchases()).length,0,"Rejected purchase must not create a purchase record");

  const deletion=await db.deleteProduct("piece-1");
  assert.deepEqual(deletion,{deleted:false,archived:true},"A referenced product must be archived, never physically deleted");
  const archived=(await db.getProducts()).find(p=>p.id==="piece-1");
  assert.equal(archived.active,false,"Archived product must be inactive");
  assert.equal((await db.getInvoices()).length,1,"Archive must preserve the original invoice");
  assert.equal((await db.getReturns()).length,2,"Archive must preserve return history");
  await assert.rejects(
    db.saveInvoice({...invoice,id:"invoice-archived",items:[{...invoice.items[0],quantity:1,stockQuantity:1,total:50}],subtotal:50,discount:0,total:50}),
    /مؤرشف/
  );
  await db.setProductActive("piece-1",true);
  assert.equal((await db.getProducts()).find(p=>p.id==="piece-1").active,true,"Owner reactivation must restore the item to checkout");

  const cash=(await db.getCashEntries());
  assert.equal(cash.filter(x=>x.category==="sale").reduce((s,x)=>s+x.amount,0),90,"Cash ledger must record discounted sale total");
  assert.equal(cash.filter(x=>x.category==="sales_return").reduce((s,x)=>s+x.amount,0),90,"Cash ledger must record the discounted return amount");

  const remoteSale={id:"cloud-cash-sale",createdAt:new Date().toISOString(),items:[{name:"بيع من جهاز كاشير",unit:"piece",quantity:1,unitPrice:25,total:25}],subtotal:25,discount:0,total:25,paymentMethod:"cash"};
  const remoteChange={store:"invoices",recordId:remoteSale.id,deleted:false,data:remoteSale};
  await db.applyCloudRecords([remoteChange],false);
  let generated=(await db.getCashEntries()).filter(x=>x.referenceId===remoteSale.id&&x.category==="sale");
  assert.equal(generated.length,1,"Owner-side sync must rebuild a cash ledger entry from a cashier invoice");
  assert.equal(generated[0].amount,25,"Rebuilt cash ledger entry must use the actual invoice total");
  await db.applyCloudRecords([remoteChange],false);
  generated=(await db.getCashEntries()).filter(x=>x.referenceId===remoteSale.id&&x.category==="sale");
  assert.equal(generated.length,1,"Repeated invoice sync must not duplicate the cash ledger entry");
  console.log("PASS: discounted returns, partial-return limits, stock restoration, integer piece movements, product archive, invoice preservation, cash reconciliation and role-scoped cashier sales.");
}
run().catch(error=>{console.error(error);process.exitCode=1;});
