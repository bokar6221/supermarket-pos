/* Customer accounts, sales returns, cash ledger, shifts and operating reports.
   Uses the existing local IndexedDB layer; this is not a multi-device accounting sync. */
(()=>{
"use strict";
const $=id=>document.getElementById(id);
const money=n=>Number(n||0).toLocaleString("ar-EG",{minimumFractionDigits:2,maximumFractionDigits:2})+" ج.م";
const uid=()=>crypto.randomUUID?crypto.randomUUID():"id-"+Date.now()+"-"+Math.random();
const esc=v=>String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const unit=u=>({piece:"قطعة",kg:"كيلو",gram:"جرام"})[u]||"وحدة";
const localKey=d=>{const x=new Date(d);return Number.isNaN(x.getTime())?"":x.getFullYear()+"-"+String(x.getMonth()+1).padStart(2,"0")+"-"+String(x.getDate()).padStart(2,"0");};
const localToday=()=>localKey(new Date());
const localMonth=()=>localToday().slice(0,7);
const digits=p=>{let value=String(p||"").replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\D/g,"");if(value.startsWith("0020"))value="0"+value.slice(4);else if(value.startsWith("20")&&value.length===12)value="0"+value.slice(2);return value;};
let activeReturn=null;

function customerMatches(invoice,customer){
  return invoice.customerId===customer.id || (!!customer.phone&&digits(invoice.customerPhone)===digits(customer.phone));
}
function customerBalance(customer,invoices,payments,returns){
  const sales=invoices.filter(x=>x.paymentMethod==="credit"&&customerMatches(x,customer)).reduce((s,x)=>
    s+(Number.isFinite(Number(x.remainingAmount))?Number(x.remainingAmount):Number(x.total||0)),0);
  const collected=payments.filter(x=>x.customerId===customer.id).reduce((s,x)=>s+Number(x.amount||0),0);
  const credited=returns.filter(x=>invoices.some(inv=>inv.id===x.invoiceId&&customerMatches(inv,customer))).reduce((s,x)=>{
    const credit=Number.isFinite(Number(x.creditReductionAmount))
      ?Number(x.creditReductionAmount):(x.refundMethod==="credit"?Number(x.amount||0):0);
    return s+Math.max(0,credit);
  },0);
  return Math.round((Number(customer.openingBalance||0)+sales-collected-credited)*100)/100;
}
async function loadCustomerData(){
  return Promise.all([POSDatabase.getCustomers(),POSDatabase.getInvoices(),POSDatabase.getCustomerPayments(),POSDatabase.getReturns()]);
}
function fillCustomers(select,customers,placeholder,selected){
  if(!select)return;
  select.replaceChildren();
  const first=document.createElement("option");first.value="";first.textContent=placeholder;select.append(first);
  customers.filter(x=>x.active!==false).sort((a,b)=>a.name.localeCompare(b.name,"ar")).forEach(customer=>{
    const option=document.createElement("option");option.value=customer.id;option.textContent=customer.name+(customer.phone?" · "+customer.phone:"");
    select.append(option);
  });
  if(selected&&customers.some(x=>x.id===selected))select.value=selected;
}
async function renderCustomers(){
  const [customers,invoices,payments,returns]=await loadCustomerData();
  const active=customers.filter(x=>x.active!==false).sort((a,b)=>a.name.localeCompare(b.name,"ar"));
  const q=($("customerSearch")?.value||"").trim().toLocaleLowerCase("ar");
  const list=$("customerList");list.replaceChildren();
  const shown=active.filter(x=>(x.name+" "+(x.phone||"")).toLocaleLowerCase("ar").includes(q));
  $("customerCount").textContent=String(active.length);
  $("customerDebt").textContent=money(active.reduce((s,x)=>s+Math.max(0,customerBalance(x,invoices,payments,returns)),0));
  if(!shown.length)list.innerHTML='<p class="empty">لا توجد نتائج مطابقة.</p>';
  shown.forEach(customer=>{
    const balance=customerBalance(customer,invoices,payments,returns);
    const row=document.createElement("div");row.className="supplier-row";
    const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
    name.textContent=customer.name;meta.textContent=(customer.phone?"هاتف: "+customer.phone+" · ":"")+"رصيد سابق: "+money(customer.openingBalance||0)+(customer.note?" · "+customer.note:"");
    info.append(name,meta);
    const side=document.createElement("div");side.className="customer-row-side";
    const due=document.createElement("strong");due.className=balance>0.005?"supplier-due":"supplier-clear";due.textContent=balance< -0.005?"رصيد لصالح العميل: "+money(Math.abs(balance)):money(balance);
    const edit=document.createElement("button");edit.type="button";edit.className="secondary";edit.textContent="تعديل";
    edit.onclick=()=>{ $("customerId").value=customer.id;$("customerNameForm").value=customer.name;$("customerPhoneForm").value=customer.phone||"";$("customerOpeningBalance").value=String(customer.openingBalance||0);$("customerNote").value=customer.note||"";activate("add"); };
    const collect=document.createElement("button");collect.type="button";collect.className="secondary";collect.textContent="تحصيل";
    collect.disabled=balance<=0.005;collect.onclick=()=>{ $("collectionCustomer").value=customer.id;updateCollectionBalance();activate("collect"); };
    const statement=document.createElement("button");statement.type="button";statement.className="secondary";statement.textContent="كشف";
    statement.onclick=()=>{ $("statementCustomer").value=customer.id;renderCustomerStatement();activate("statement"); };
    side.append(due,edit,collect,statement);row.append(info,side);list.append(row);
  });
  fillCustomers($("collectionCustomer"),active,"اختر العميل", $("collectionCustomer").value);
  fillCustomers($("statementCustomer"),active,"اختر العميل", $("statementCustomer").value);
  updateCollectionBalance();
  renderCustomerStatement();
}
function activate(tab){
  const button=document.querySelector('[data-subtab-group="customers"] [data-subtab="'+tab+'"]');
  if(button)button.click();
}
async function updateCollectionBalance(){
  const id=$("collectionCustomer")?.value;
  if(!id){$("collectionBalance").textContent="اختر العميل لعرض رصيده.";return;}
  const [customers,invoices,payments,returns]=await loadCustomerData();
  const customer=customers.find(x=>x.id===id);
  const balance=customer?customerBalance(customer,invoices,payments,returns):0;$("collectionBalance").textContent=customer?(balance>0.005?"الرصيد المستحق: "+money(balance):balance< -0.005?"رصيد لصالح العميل: "+money(Math.abs(balance)):"لا توجد مديونية على العميل."):"العميل غير موجود.";
}
async function renderCustomerStatement(){
  const root=$("customerStatement"),id=$("statementCustomer")?.value;
  if(!id){root.innerHTML='<p class="empty">اختر عميلًا لعرض كشف الحساب.</p>';return;}
  const [customers,invoices,payments,returns]=await loadCustomerData();
  const customer=customers.find(x=>x.id===id);
  if(!customer){root.innerHTML='<p class="empty">العميل غير موجود.</p>';return;}
  const events=[{date:"",kind:"رصيد سابق",debit:Number(customer.openingBalance||0),credit:0,note:""}];
  invoices.filter(x=>x.paymentMethod==="credit"&&customerMatches(x,customer)).forEach(inv=>events.push({
    date:inv.createdAt,kind:"فاتورة آجل",debit:Number.isFinite(Number(inv.remainingAmount))?Number(inv.remainingAmount):Number(inv.total||0),
    credit:0,note:"فاتورة "+String(inv.id).slice(0,8)
  }));
  payments.filter(x=>x.customerId===id).forEach(p=>events.push({date:p.createdAt,kind:"تحصيل",debit:0,credit:Number(p.amount||0),note:p.note||p.method||""}));
  returns.filter(x=>invoices.some(inv=>inv.id===x.invoiceId&&customerMatches(inv,customer))).forEach(r=>{
    const credit=Number.isFinite(Number(r.creditReductionAmount))
      ?Number(r.creditReductionAmount):(r.refundMethod==="credit"?Number(r.amount||0):0);
    if(credit>0.005)events.push({date:r.createdAt,kind:"مرتجع خفّض المديونية",debit:0,credit,note:"مرتجع فاتورة"});
  });
  events.sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")));
  let balance=0;
  const rows=events.map(e=>{balance+=e.debit-e.credit;return '<tr><td>'+esc(e.date?new Date(e.date).toLocaleDateString("ar-EG"):"—")+'</td><td>'+esc(e.kind)+(e.note?"<small class='table-note'>"+esc(e.note)+"</small>":"")+'</td><td>'+esc(money(e.debit))+'</td><td>'+esc(money(e.credit))+'</td><td>'+esc(money(balance))+'</td></tr>';}).join("");
  const finalBalance=customerBalance(customer,invoices,payments,returns),balanceLabel=finalBalance< -0.005?"رصيد لصالح العميل":"الرصيد المستحق حاليًا";
  root.innerHTML='<div class="table-scroll"><table class="data-table"><thead><tr><th>التاريخ</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="supplier-balance-summary">'+balanceLabel+': <strong>'+esc(money(Math.abs(finalBalance)))+'</strong></p>';
}
const phoneClean=v=>digits(v);
const originalSaveInvoice=POSDatabase.saveInvoice.bind(POSDatabase);
POSDatabase.saveInvoice=async invoice=>{
  if(invoice.paymentMethod==="credit"){
    const name=String(invoice.customerName||"").trim(),phone=phoneClean(invoice.customerPhone);
    if(!name||phone.length<8)throw new Error("البيع الآجل يتطلب اسم العميل ورقم هاتف صحيحًا (8 أرقام على الأقل).");
    const customers=await POSDatabase.getCustomers(),existing=customers.find(x=>phoneClean(x.phone)===phone);
    const saved=await POSDatabase.saveCustomer({id:existing?.id||uid(),name,phone,openingBalance:existing?.openingBalance||0,note:existing?.note||"",active:true});
    invoice.customerId=saved.id;
  }
  return originalSaveInvoice(invoice);
};
function updateCreditHint(){
  const hint=$("creditHint");if(!hint)return;
  const total=Number($("grandTotal")?.dataset.amount||0),paid=Number($("paidAmount")?.value||0);
  const remaining=Math.round((total-paid)*100)/100;
  hint.hidden=!Number.isFinite(remaining)||remaining<=0.005;
  hint.textContent="سيتم تسجيل الباقي ("+money(remaining)+") كمديونية على العميل؛ أدخل الاسم ورقم الهاتف قبل حفظ الفاتورة.";
}
$("paymentMethod").addEventListener("change",updateCreditHint);
if($("paidAmount"))$("paidAmount").addEventListener("input",updateCreditHint);
window.addEventListener("cashiro-payment-summary",updateCreditHint);
updateCreditHint();
$("customerForm").onsubmit=async e=>{
  e.preventDefault();
  const id=$("customerId").value||uid();
  try{
    await POSDatabase.saveCustomer({id,name:$("customerNameForm").value.trim(),phone:$("customerPhoneForm").value.trim(),openingBalance:Number($("customerOpeningBalance").value)||0,note:$("customerNote").value.trim(),active:true});
    e.target.reset();$("customerId").value="";$("customerOpeningBalance").value="0";
    $("customerMessage").textContent="تم حفظ بيانات العميل.";await renderCustomers();activate("list");
  }catch(error){$("customerMessage").textContent="تعذر الحفظ: "+error.message;}
};
$("resetCustomer").onclick=()=>{$("customerForm").reset();$("customerId").value="";$("customerOpeningBalance").value="0";};
$("customerSearch").oninput=renderCustomers;
$("refreshCustomers").onclick=renderCustomers;
$("collectionCustomer").onchange=updateCollectionBalance;
$("statementCustomer").onchange=renderCustomerStatement;
$("customerPaymentForm").onsubmit=async e=>{
  e.preventDefault();
  const [customers,invoices,payments,returns]=await loadCustomerData(),id=$("collectionCustomer").value,customer=customers.find(x=>x.id===id),amount=Number($("collectionAmount").value);
  if(!customer)return alert("اختر العميل.");
  const balance=customerBalance(customer,invoices,payments,returns);
  if(!Number.isFinite(amount)||amount<=0)return alert("أدخل مبلغ تحصيل صحيحًا.");
  if(amount>balance+0.005)return alert("المبلغ أكبر من مديونية العميل: "+money(balance));
  try{
    await POSDatabase.saveCustomerPayment({id:uid(),customerId:id,customerName:customer.name,amount,method:$("collectionMethod").value,note:$("collectionNote").value.trim(),createdAt:new Date().toISOString()});
    $("collectionAmount").value="";$("collectionNote").value="";$("collectionMessage").textContent="تم تسجيل التحصيل وإضافته إلى الخزينة.";
    await renderCustomers();await renderCash();await renderReports();
  }catch(error){$("collectionMessage").textContent="تعذر التسجيل: "+error.message;}
};

async function openReturn(invoiceId){
  const [invoices,returns]=await Promise.all([POSDatabase.getInvoices(),POSDatabase.getReturns()]);
  const invoice=invoices.find(x=>x.id===invoiceId);if(!invoice)return alert("الفاتورة غير موجودة.");
  const returned=returns.filter(x=>x.invoiceId===invoiceId),root=$("salesReturnLines");root.replaceChildren();
  const discountedLineTotals=POSDatabase.calculateDiscountedLineTotals(invoice);
  let available=0;
  (invoice.items||[]).forEach((item,index)=>{
    const priorLines=returned.flatMap(r=>(r.items||[]).filter(x=>Number(x.itemIndex)===index));
    const qtyReturned=priorLines.reduce((s,x)=>s+Number(x.quantity||0),0);
    const refundedAmount=priorLines.reduce((s,x)=>s+(x.amount!==undefined&&x.amount!==null?Number(x.amount)||0:0),0);
    const remaining=Math.max(0,Number(item.quantity||0)-qtyReturned);
    if(remaining<=0.000001)return;
    available++;
    const row=document.createElement("div");row.className="return-line";
    const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
    name.textContent=item.name;meta.textContent="المباع: "+item.quantity+" "+unit(item.unit)+" · المرتجع سابقًا: "+qtyReturned+" · المتبقي: "+remaining;
    info.append(name,meta);
    const input=document.createElement("input");input.type="number";input.min="0";input.max=String(remaining);input.step=item.unit==="piece"?"1":"0.001";input.value="0";input.dataset.itemIndex=String(index);
    input.dataset.netLineTotal=String(discountedLineTotals[index]||0);
    input.dataset.soldQuantity=String(Number(item.quantity)||0);
    input.dataset.alreadyQuantity=String(qtyReturned);
    input.dataset.refundedAmount=String(refundedAmount);
    input.setAttribute("aria-label","كمية مرتجع "+item.name);input.oninput=updateReturnTotal;
    const label=document.createElement("label");label.textContent="كمية المرتجع";label.append(input);
    row.append(info,label);root.append(row);
  });
  if(!available){return alert("تم إرجاع جميع بنود هذه الفاتورة بالفعل.");}
  activeReturn=invoice;
  $("salesReturnInfo").textContent="فاتورة "+String(invoice.id).slice(0,12)+" · "+new Date(invoice.createdAt).toLocaleString("ar-EG")+" · "+(invoice.customerName||"عميل نقدي");
  const method=$("salesReturnMethod");
  if(invoice.paymentMethod==="credit"){method.value="credit";[...method.options].forEach(o=>o.disabled=o.value!=="credit");}
  else{method.value=invoice.paymentMethod==="electronic"?"electronic":"cash";[...method.options].forEach(o=>o.disabled=o.value==="credit");}
  $("salesReturnNote").value="";$("salesReturnMessage").textContent="";$("salesReturnModal").hidden=false;updateReturnTotal();
}
function updateReturnTotal(){
  const inputs=[...$("salesReturnLines").querySelectorAll("input[data-item-index]")];
  const total=inputs.reduce((sum,input)=>{
    const selected=Math.max(0,Number(input.value)||0);
    if(selected<=0)return sum;
    const soldQuantity=Number(input.dataset.soldQuantity||0);
    if(soldQuantity<=0)return sum;
    const cumulativeQuantity=Math.min(soldQuantity,Number(input.dataset.alreadyQuantity||0)+selected);
    const cumulativeRefund=Math.round((Number(input.dataset.netLineTotal||0)*cumulativeQuantity/soldQuantity+1e-9)*100)/100;
    const lineRefund=Math.max(0,Math.round((cumulativeRefund-Number(input.dataset.refundedAmount||0)+1e-9)*100)/100);
    return sum+lineRefund;
  },0);
  $("salesReturnTotal").textContent=money(Math.round((total+1e-9)*100)/100);
}
function closeReturn(){$("salesReturnModal").hidden=true;activeReturn=null;}
$("closeSalesReturn").onclick=closeReturn;
$("salesReturnModal").addEventListener("click",e=>{if(e.target===$("salesReturnModal"))closeReturn();});
$("saveSalesReturn").onclick=async()=>{
  if(!activeReturn)return;
  const items=[...$("salesReturnLines").querySelectorAll("input[data-item-index]")].map(input=>({itemIndex:Number(input.dataset.itemIndex),quantity:Number(input.value)})).filter(x=>x.quantity>0);
  if(!items.length)return alert("أدخل كمية مرتجعة لصنف واحد على الأقل.");
  const method=$("salesReturnMethod").value;
  if(activeReturn.paymentMethod==="credit"&&method!=="credit")return alert("مرتجع فاتورة الآجل يجب أن يخفض مديونية العميل.");
  const button=$("saveSalesReturn");button.disabled=true;
  try{
    await POSDatabase.saveReturn({id:uid(),invoiceId:activeReturn.id,customerId:activeReturn.customerId||null,customerName:activeReturn.customerName||"",refundMethod:method,note:$("salesReturnNote").value.trim(),items,createdAt:new Date().toISOString()});
    $("salesReturnMessage").textContent="تم اعتماد المرتجع وتحديث المخزون والخزينة/مديونية العميل.";
    closeReturn();location.reload();
  }catch(error){$("salesReturnMessage").textContent="تعذر اعتماد المرتجع: "+error.message;button.disabled=false;}
};
$("invoiceList").addEventListener("click",e=>{
  const button=e.target.closest("[data-return-invoice]");if(button)openReturn(button.dataset.returnInvoice);
});

const categoryNames={sale:"مبيعات",customer_collection:"تحصيل عميل",purchase:"مشتريات",supplier_payment:"سداد مورد",sales_return:"مرتجع مبيعات",other_income:"إيراد إضافي",capital:"إيداع نقدية",rent:"إيجار",salary:"أجور",utilities:"مرافق",transport:"نقل ومواصلات",maintenance:"صيانة",withdrawal:"مسحوبات",other:"أخرى"};
const methodName=m=>m==="electronic"?"إلكتروني":"نقدي";
function dateWithin(date,start,end){const t=new Date(date||0).getTime();return t>=start&&t<end;}
async function renderCash(){
  const [entries,shifts]=await Promise.all([POSDatabase.getCashEntries(),POSDatabase.getShifts()]);
  const today=localToday(),todayRows=entries.filter(x=>localKey(x.createdAt)===today);
  const sums={cashIn:0,cashOut:0,elecIn:0,elecOut:0};
  todayRows.forEach(x=>{const key=(x.method==="electronic"?"elec":"cash")+(x.type==="income"?"In":"Out");sums[key]+=Number(x.amount||0);});
  $("cashTodayLabel").textContent="اليوم: "+new Date().toLocaleDateString("ar-EG");
  $("cashIn").textContent=money(sums.cashIn);$("cashOut").textContent=money(sums.cashOut);
  $("cashNet").textContent=money(sums.cashIn-sums.cashOut);$("electronicNet").textContent=money(sums.elecIn-sums.elecOut);
  const open=shifts.filter(x=>x.status==="open").sort((a,b)=>String(b.openedAt).localeCompare(String(a.openedAt)))[0];
  const ledger=$("cashLedger");ledger.replaceChildren();
  entries.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  if(!entries.length)ledger.innerHTML='<p class="empty">لا توجد حركات مالية مسجلة بعد.</p>';
  entries.slice(0,150).forEach(entry=>{
    const row=document.createElement("div");row.className="movement-row";
    const info=document.createElement("div"),title=document.createElement("strong"),meta=document.createElement("small");
    title.textContent=categoryNames[entry.category]||entry.category||"حركة مالية";
    meta.textContent=(entry.type==="income"?"وارد":"منصرف")+" · "+methodName(entry.method)+" · "+new Date(entry.createdAt).toLocaleString("ar-EG")+(entry.note?" · "+entry.note:"");
    info.append(title,meta);
    const amount=document.createElement("strong");amount.className=entry.type==="income"?"movement-positive":"movement-negative";amount.textContent=(entry.type==="income"?"+":"−")+money(entry.amount);
    row.append(info,amount);ledger.append(row);
  });
  renderShift(open,entries,shifts);
}
function expectedShiftCash(shift,entries){
  return Number(shift.openingCash||0)+entries.filter(x=>x.method!=="electronic"&&new Date(x.createdAt)>=new Date(shift.openedAt)&&(!shift.closedAt||new Date(x.createdAt)<=new Date(shift.closedAt))).reduce((s,x)=>s+(x.type==="income"?1:-1)*Number(x.amount||0),0);
}
function renderShift(open,entries,shifts){
  const root=$("shiftPanel"),summary=$("activeShiftSummary");
  if(!open){
    summary.textContent="لا توجد وردية مفتوحة حاليًا.";
    root.innerHTML='<form id="openShiftForm"><h3>فتح وردية جديدة</h3><label>النقدية الموجودة ببداية الوردية (جنيه)<input id="openingCash" type="number" min="0" step="0.01" value="0" required></label><label>ملاحظة<input id="shiftOpenNote" maxlength="120" placeholder="اسم الموظف أو رقم الوردية (اختياري)"></label><button class="primary" type="submit">فتح الوردية</button></form><div id="closedShiftHistory"></div>';
    $("openShiftForm").onsubmit=async e=>{
      e.preventDefault();
      const all=await POSDatabase.getShifts();if(all.some(x=>x.status==="open"))return alert("توجد وردية مفتوحة بالفعل.");
      try{
        await POSDatabase.saveShift({id:uid(),status:"open",openedAt:new Date().toISOString(),openingCash:Number($("openingCash").value)||0,note:$("shiftOpenNote").value.trim()});
        await renderCash();
      }catch(error){alert("تعذر فتح الوردية: "+error.message);}
    };
    const history=$("closedShiftHistory"),closed=(shifts||[]).filter(x=>x.status==="closed").sort((a,b)=>String(b.closedAt||"").localeCompare(String(a.closedAt||""))).slice(0,8);
    if(closed.length){
      const heading=document.createElement("h3");heading.textContent="آخر الورديات المغلقة";history.append(heading);
      closed.forEach(shift=>{
        const row=document.createElement("div");row.className="history-row";
        const info=document.createElement("div"),title=document.createElement("strong"),meta=document.createElement("small");
        title.textContent="وردية "+new Date(shift.openedAt).toLocaleDateString("ar-EG");
        meta.textContent="إغلاق: "+new Date(shift.closedAt).toLocaleTimeString("ar-EG")+" · متوقع "+money(shift.expectedCash)+" · فعلي "+money(shift.countedCash);
        info.append(title,meta);
        const diff=document.createElement("strong");diff.className=Number(shift.difference||0)<0?"movement-negative":"movement-positive";diff.textContent=(Number(shift.difference||0)>0?"+":"")+money(shift.difference||0);
        row.append(info,diff);history.append(row);
      });
    }
  }else{
    const expected=expectedShiftCash(open,entries);
    summary.textContent="وردية مفتوحة منذ "+new Date(open.openedAt).toLocaleString("ar-EG")+" · الرصيد المتوقع الآن "+money(expected);
    root.innerHTML='<div class="customer-balance-preview"><strong>وردية مفتوحة</strong><p>بداية الوردية: '+esc(new Date(open.openedAt).toLocaleString("ar-EG"))+'</p><p>رصيد البداية: '+esc(money(open.openingCash))+'</p><p>النقدية المتوقعة: <strong>'+esc(money(expected))+'</strong></p></div><form id="closeShiftForm"><label>النقدية الفعلية عند الإغلاق<input id="countedCash" type="number" min="0" step="0.01" required value="'+Math.max(0,expected).toFixed(2)+'"></label><button class="primary" type="submit">إغلاق الوردية وتسوية العجز/الزيادة</button></form>';
    $("closeShiftForm").onsubmit=async e=>{
      e.preventDefault();
      const counted=Number($("countedCash").value);if(!Number.isFinite(counted)||counted<0)return alert("أدخل النقدية الفعلية بشكل صحيح.");
      const latest={...open,status:"closed",closedAt:new Date().toISOString(),expectedCash:expected,countedCash:counted,difference:counted-expected};
      try{
        await POSDatabase.saveShift(latest);alert("تم إغلاق الوردية. فرق العهدة: "+money(latest.difference));await renderCash();
      }catch(error){alert("تعذر إغلاق الوردية: "+error.message);}
    };
  }
}
$("refreshCash").onclick=renderCash;
$("cashEntryForm").onsubmit=async e=>{
  e.preventDefault();
  try{
    await POSDatabase.saveCashEntry({id:uid(),type:$("cashEntryType").value,category:$("cashEntryCategory").value,amount:Number($("cashEntryAmount").value),method:$("cashEntryMethod").value,note:$("cashEntryNote").value.trim(),createdAt:new Date().toISOString()});
    e.target.reset();$("cashEntryMessage").textContent="تم حفظ الحركة وإضافتها إلى سجل الخزينة.";await renderCash();await renderReports();
  }catch(error){$("cashEntryMessage").textContent="تعذر الحفظ: "+error.message;}
};

function periodProfitSnapshot(invoices,returns,cashEntries,dateFilter){
  const periodInvoices=invoices.filter(x=>dateFilter(x.createdAt));
  const periodReturns=returns.filter(x=>dateFilter(x.createdAt));
  const invoiceById=new Map(invoices.map(x=>[x.id,x]));
  let sales=0,salesCost=0,knownRevenue=0,totalLineRevenue=0;
  periodInvoices.forEach(invoice=>{
    sales+=Number(invoice.total||0);
    const factor=Number(invoice.subtotal||0)>0?Number(invoice.total||0)/Number(invoice.subtotal):1;
    (invoice.items||[]).forEach(item=>{
      const quantity=Number(item.stockQuantity??item.quantity)||0;
      const savedLineTotal=Number(item.total);
      const lineRevenue=item.total!==undefined&&item.total!==null&&Number.isFinite(savedLineTotal)
        ?savedLineTotal:quantity*Number(item.unitPrice||0)*factor;
      totalLineRevenue+=lineRevenue;
      if(item.costKnown===true||(item.cost!==undefined&&item.cost!==null&&Number.isFinite(Number(item.cost))&&Number(item.cost)>0)){
        salesCost+=Number(item.cost||0)*quantity;
        knownRevenue+=lineRevenue;
      }
    });
  });
  const returnedAmount=periodReturns.reduce((sum,x)=>sum+Number(x.amount||0),0);
  let returnedCost=0;
  periodReturns.forEach(record=>{
    const invoice=invoiceById.get(record.invoiceId);
    (record.items||[]).forEach(line=>{
      const original=(invoice?.items||[])[Number(line.itemIndex)];
      const lineHasCost=line.costKnown===true||(line.cost!==undefined&&line.cost!==null&&Number(line.cost)>0);
      const originalHasCost=original?.costKnown===true||(original?.cost!==undefined&&original?.cost!==null&&Number(original.cost)>0);
      const cost=lineHasCost&&line.cost!==undefined&&line.cost!==null?Number(line.cost)
        :originalHasCost?Number(original.cost):null;
      if(cost!==null&&Number.isFinite(cost))returnedCost+=cost*Number(line.quantity||0);
    });
  });
  const netSales=sales-returnedAmount,cogs=salesCost-returnedCost;
  const operatingCategories=new Set(["rent","salary","utilities","transport","maintenance","other"]);
  const operatingExpenses=cashEntries.filter(x=>x.type==="expense"&&operatingCategories.has(x.category)&&dateFilter(x.createdAt))
    .reduce((sum,x)=>sum+Number(x.amount||0),0);
  const totalCashOut=cashEntries.filter(x=>x.type==="expense"&&dateFilter(x.createdAt))
    .reduce((sum,x)=>sum+Number(x.amount||0),0);
  return {sales,returnedAmount,netSales,cogs,grossProfit:netSales-cogs,operatingExpenses,
    operatingResult:netSales-cogs-operatingExpenses,totalCashOut,
    costCoverage:totalLineRevenue>0?Math.min(1,knownRevenue/totalLineRevenue):0};
}
function renderProfitCards(prefix,result){
  $(prefix+"Cogs").textContent=money(result.cogs);
  $(prefix+"GrossProfit").textContent=money(result.grossProfit);
  $(prefix+"OperatingExpenses").textContent=money(result.operatingExpenses);
  $(prefix+"OperatingResult").textContent=money(result.operatingResult);
  $(prefix+"ProfitNote").textContent="تغطية تكلفة الأصناف المسجلة: "+(result.costCoverage*100).toLocaleString("ar-EG",{maximumFractionDigits:0})+"%. النتيجة تقديرية وليست قائمة مالية معتمدة.";
}
async function renderReports(){
  const [invoices,returns,products,customers,customerPayments,suppliers,purchases,supplierPayments,cashEntries]=await Promise.all([
    POSDatabase.getInvoices(),POSDatabase.getReturns(),POSDatabase.getProducts(),POSDatabase.getCustomers(),POSDatabase.getCustomerPayments(),
    POSDatabase.getSuppliers(),POSDatabase.getPurchases(),POSDatabase.getSupplierPayments(),POSDatabase.getCashEntries()
  ]);
  const today=localToday(),month=localMonth();
  const todayFilter=date=>localKey(date)===today,monthFilter=date=>localKey(date).startsWith(month);
  const todayInvoices=invoices.filter(x=>todayFilter(x.createdAt)),monthInvoices=invoices.filter(x=>monthFilter(x.createdAt));
  const todayReturns=returns.filter(x=>todayFilter(x.createdAt)).reduce((s,x)=>s+Number(x.amount||0),0);
  const monthReturns=returns.filter(x=>monthFilter(x.createdAt)).reduce((s,x)=>s+Number(x.amount||0),0);
  const todaySales=todayInvoices.reduce((s,x)=>s+Number(x.total||0),0),monthSales=monthInvoices.reduce((s,x)=>s+Number(x.total||0),0);
  $("reportTodaySales").textContent=money(todaySales);$("reportTodayInvoices").textContent=String(todayInvoices.length);$("reportTodayReturns").textContent=money(todayReturns);$("reportTodayNet").textContent=money(todaySales-todayReturns);
  $("reportMonthSales").textContent=money(monthSales);$("reportMonthInvoices").textContent=String(monthInvoices.length);$("reportMonthReturns").textContent=money(monthReturns);$("reportMonthNet").textContent=money(monthSales-monthReturns);
  renderProfitCards("reportToday",periodProfitSnapshot(invoices,returns,cashEntries,todayFilter));
  renderProfitCards("reportMonth",periodProfitSnapshot(invoices,returns,cashEntries,monthFilter));
  const inventoryValue=products.filter(p=>p.trackStock).reduce((s,p)=>s+Number(p.stock||0)*Number(p.cost||0),0);
  const customerDebt=customers.filter(x=>x.active!==false).reduce((s,x)=>s+Math.max(0,customerBalance(x,invoices,customerPayments,returns)),0);
  const supplierDebt=suppliers.filter(x=>x.active!==false).reduce((s,x)=>s+Number(x.openingBalance||0),0)+purchases.filter(x=>x.supplierId).reduce((s,x)=>s+Number(x.total||0)-Number(x.paidAmount||0),0)-supplierPayments.reduce((s,x)=>s+Number(x.amount||0),0);
  const monthOut=cashEntries.filter(x=>x.type==="expense"&&monthFilter(x.createdAt)).reduce((s,x)=>s+Number(x.amount||0),0);
  $("reportStockValue").textContent=money(inventoryValue);$("reportCustomerDebt").textContent=money(customerDebt);$("reportSupplierDebt").textContent=money(supplierDebt);$("reportMonthExpenses").textContent=money(monthOut);
}
function updateCashCategoryOptions(){
  const select=$("cashEntryCategory"),type=$("cashEntryType").value,previous=select.value;
  const options=type==="income"
    ?[["other_income","إيراد إضافي"],["capital","إيداع نقدية"],["other","أخرى"]]
    :[["rent","إيجار"],["salary","أجور"],["utilities","مرافق"],["transport","نقل ومواصلات"],["maintenance","صيانة"],["withdrawal","مسحوبات"],["other","أخرى"]];
  select.replaceChildren();
  options.forEach(([value,label])=>{const option=document.createElement("option");option.value=value;option.textContent=label;select.append(option);});
  select.value=options.some(x=>x[0]===previous)?previous:options[0][0];
}
$("cashEntryType").onchange=updateCashCategoryOptions;updateCashCategoryOptions();
document.addEventListener("click",e=>{
  const tab=e.target.closest("[data-view]");if(!tab)return;
  const name=tab.dataset.view;
  if(name==="customers")setTimeout(renderCustomers,0);
  if(name==="cash")setTimeout(renderCash,0);
  if(name==="reports")setTimeout(renderReports,0);
});
document.addEventListener("click",e=>{
  const sub=e.target.closest('[data-subtab-group="reports"] [data-subtab]');if(sub)setTimeout(renderReports,0);
});
window.POSAccounts={renderCustomers,renderCash,renderReports,openReturn};
})();