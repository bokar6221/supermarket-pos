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

  await db.saveProduct({
    id:"purchase-product",name:"صنف مشتريات",barcode:"",category:"اختبار",unit:"piece",
    price:30,cost:10,costKnown:true,trackStock:true,stock:4,minStock:1,active:true,
    updatedAt:new Date().toISOString()
  });
  await assert.rejects(
    db.savePurchase({id:"purchase-mismatch",items:[{productId:"purchase-product",unit:"piece",quantity:2,unitCost:10}],total:25,paidAmount:0,paymentMethod:"cash"}),
    /إجمالي فاتورة الشراء لا يطابق/
  );
  await assert.rejects(
    db.savePurchase({id:"purchase-infinite",items:[{productId:"purchase-product",unit:"piece",quantity:Infinity,unitCost:10}],total:30,paidAmount:0,paymentMethod:"cash"}),
    /راجع كمية وتكلفة/
  );
  await assert.rejects(
    db.savePurchase({id:"purchase-bad-method",items:[{productId:"purchase-product",unit:"piece",quantity:2,unitCost:15}],total:30,paidAmount:10,paymentMethod:"credit"}),
    /طريقة الدفع/
  );
  assert.equal((await db.getProducts()).find(p=>p.id==="purchase-product").stock,4,"Rejected purchases must not change stock");
  assert.equal((await db.getPurchases()).length,0,"Rejected purchases must not create purchase records");
  await db.savePurchase({
    id:"purchase-valid",items:[{productId:"purchase-product",name:"صنف مشتريات",unit:"piece",quantity:2,unitCost:15,total:30}],
    total:30,paidAmount:10,paymentMethod:"cash",createdAt:new Date().toISOString()
  });
  const purchased=(await db.getProducts()).find(p=>p.id==="purchase-product");
  assert.equal(purchased.stock,6,"Valid purchase must increase stock by purchased quantity");
  assert.ok(Math.abs(purchased.cost-(70/6))<0.000001,"Purchase must recalculate weighted average cost");
  assert.equal((await db.getCashEntries()).filter(x=>x.referenceId==="purchase-valid"&&x.category==="purchase").reduce((sum,x)=>sum+x.amount,0),10,"Paid purchase amount must be recorded in the cash ledger");

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

  const roundingInvoice={
    id:"invoice-rounding",createdAt:new Date().toISOString(),
    items:[{productId:"piece-1",name:"منتج اختبار",unit:"piece",quantity:2,stockQuantity:2,unitPrice:50,total:100,cost:20,costKnown:true}],
    subtotal:100,discount:0.01,total:99.99,paymentMethod:"cash",currency:"EGP",status:"saved"
  };
  assert.deepEqual(db.calculateDiscountedLineTotals(roundingInvoice),[99.99],"Line allocations must reconcile exactly to the discounted invoice total");
  await db.saveInvoice(roundingInvoice);
  await db.saveReturn({id:"rounding-return-1",invoiceId:roundingInvoice.id,refundMethod:"cash",items:[{itemIndex:0,quantity:1}]});
  await db.saveReturn({id:"rounding-return-2",invoiceId:roundingInvoice.id,refundMethod:"cash",items:[{itemIndex:0,quantity:1}]});
  const roundingReturns=(await db.getReturns()).filter(x=>x.invoiceId===roundingInvoice.id);
  assert.deepEqual(roundingReturns.map(x=>x.items[0].amount),[50,49.99],"The final partial return must absorb the rounding remainder");
  assert.equal(Math.round((roundingReturns.reduce((sum,x)=>sum+x.amount,0)+1e-9)*100)/100,99.99,"No return sequence may refund more than the paid invoice total");
  console.log("PASS: discounted returns, partial-return limits, stock restoration, integer piece movements, product archive, invoice preservation, cash reconciliation and role-scoped cashier sales.");
}
run().catch(error=>{console.error(error);process.exitCode=1;});
