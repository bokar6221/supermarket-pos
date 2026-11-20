(()=>{"use strict";
const $=id=>document.getElementById(id),cart=[];
let products=[],stream=null,timer=null,audioCtx=null,scannerMode="sale",scanStarting=false,nativeScannerActive=false;
let paidAmountTouched=false;
let shopSettings={shopName:"كاشير المحل",shopPhone:"",shopAddress:"",receiptFooter:"شكراً لزيارتكم",paperWidth:"80"};
let activeReceipt=null;
let activeProductCategory="الكل";
let purchaseDraft=[];
let stocktakeDraft=null;
const money=n=>Number(n||0).toLocaleString("ar-EG",{minimumFractionDigits:2,maximumFractionDigits:2})+" ج.م",uid=()=>crypto.randomUUID?crypto.randomUUID():"id-"+Date.now()+"-"+Math.random(),unit=u=>({piece:"قطعة",kg:"كيلو",gram:"جرام"})[u]||"وحدة";
const subtabBars = new Map([...document.querySelectorAll(".inner-tabs[data-subtab-group]")].map(bar => [bar.closest(".view")?.id.replace(/^view-/, ""), bar]));
function mountSubtabs(viewName){
  const host=$("subtabsHost");
  if(!host)return;
  host.replaceChildren();
  const bar=subtabBars.get(viewName);
  if(bar){host.append(bar);host.hidden=false;}
  else{host.hidden=true;}
}
function view(n){setInvoiceOpen(false);document.body.classList.toggle("sales-view",n==="sale");document.querySelectorAll(".view").forEach(x=>x.classList.toggle("active",x.id==="view-"+n));document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.view===n));mountSubtabs(n);if(n==="products"){renderProducts();renderCatalog();}if(n==="inventory")renderInventory();if(n==="purchases")renderPurchases();if(n==="invoices")renderInvoices();if(n==="sale")renderQuick();if(n==="settings")renderSettings();}
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>view(b.dataset.view));
function activateSubtab(group,value){
  const tabs=document.querySelector('[data-subtab-group="'+group+'"]');
  if(!tabs)return;
  tabs.querySelectorAll("[data-subtab]").forEach(button=>button.classList.toggle("active",button.dataset.subtab===value));
  document.querySelectorAll('[data-subpanel-group="'+group+'"]').forEach(panel=>{
    panel.classList.toggle("active",panel.dataset.subpanel===value);
  });
}
mountSubtabs("sale");
document.addEventListener("click",event=>{
  const button=event.target.closest("[data-subtab]");
  if(!button)return;
  const tabs=button.closest("[data-subtab-group]");
  if(tabs)activateSubtab(tabs.dataset.subtabGroup,button.dataset.subtab);
});
const sub=()=>cart.reduce((s,x)=>s+x.total,0),disc=()=>Math.max(0,Number($("discount").value)||0);
function setInvoiceOpen(open){
  document.body.classList.toggle("invoice-open",!!open);
  $("invoiceBackdrop").hidden=!open;
  $("mobileInvoiceToggle").setAttribute("aria-expanded",String(!!open));
}
$("mobileInvoiceToggle").onclick=()=>setInvoiceOpen(true);
$("closeInvoice").onclick=()=>setInvoiceOpen(false);
$("invoiceBackdrop").onclick=()=>setInvoiceOpen(false);
document.addEventListener("keydown",e=>{if(e.key==="Escape")setInvoiceOpen(false);});

function invoiceNetTotal(){
  const subtotal=sub(),discount=Math.min(disc(),subtotal);
  return Math.round(Math.max(0,subtotal-discount)*100)/100;
}
function updatePaymentSummary(resetDefault=false){
  const input=$("paidAmount"),remainingNode=$("remainingAmount"),totalNode=$("grandTotal");
  if(!input||!remainingNode)return;
  const total=invoiceNetTotal();
  if(resetDefault||!paidAmountTouched){
    input.value=$("paymentMethod")&&$("paymentMethod").value==="credit"?"0.00":total.toFixed(2);
  }
  input.max=total.toFixed(2);
  const paid=Number(input.value);
  const valid=Number.isFinite(paid)&&paid>=0;
  const remaining=Math.round((total-(valid?paid:0))*100)/100;
  remainingNode.textContent=money(remaining);
  remainingNode.dataset.state=valid&&remaining>=-0.005?"success":"error";
  if(totalNode){totalNode.textContent=money(total);totalNode.dataset.amount=String(total);}
  window.dispatchEvent(new Event("cashiro-payment-summary"));
}
function renderCart(){
  const netTotal=invoiceNetTotal();
  $("cartCount").textContent=cart.length+" صنف";
  $("grandTotal").textContent=money(netTotal);
  $("mobileCartCount").textContent=String(cart.length);
  $("mobileGrandTotal").textContent=money(netTotal);
  $("checkoutButton").disabled=!cart.length;
  updatePaymentSummary();
  const root=$("cartItems");root.replaceChildren();
  if(!cart.length){
    paidAmountTouched=false;
    updatePaymentSummary(true);
    root.innerHTML='<p class="empty">امسح الباركود أو اضغط على الصنف لإضافته</p>';
    return;
  }
  cart.forEach((x,i)=>{
    const row=document.createElement("div");row.className="cart-item";
    const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
    name.textContent=x.name;
    meta.textContent=unit(x.unit)+" × سعر الوحدة "+money(x.unitPrice);
    info.className="cart-item-info";
    info.append(name,meta);
    const side=document.createElement("div"),amount=document.createElement("strong"),quantityLabel=document.createElement("label"),quantityInput=document.createElement("input"),del=document.createElement("button");
    amount.textContent=money(x.total);
    side.className="cart-item-side";
    quantityLabel.className="cart-quantity-editor";
    quantityLabel.textContent="الكمية";
    quantityInput.type="number";
    quantityInput.min=(x.unit==="piece"||x.unit==="gram")?"1":"0.001";
    quantityInput.step=(x.unit==="piece"||x.unit==="gram")?"1":"0.001";
    quantityInput.inputMode="decimal";
    quantityInput.value=String(x.quantity);
    quantityInput.setAttribute("aria-label","كمية "+x.name);
    quantityInput.addEventListener("change",()=>setCartQuantity(i,quantityInput.value));
    quantityInput.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();quantityInput.blur();}});
    quantityLabel.append(quantityInput);
    del.className="remove";del.textContent="حذف";
    del.onclick=()=>{cart.splice(i,1);renderCart();};
    side.append(amount,quantityLabel,del);
    row.append(info,side);root.append(row);
  });
}
function setCartQuantity(i,value){
  const x=cart[i];if(!x)return;
  const quantity=Number(value);
  const whole=(x.unit==="piece"||x.unit==="gram");
  if(!Number.isFinite(quantity)||quantity<=0||(whole&&!Number.isInteger(quantity))){
    alert(whole?"اكتب عددًا صحيحًا أكبر من صفر.":"اكتب كمية صحيحة أكبر من صفر.");
    renderCart();return;
  }
  const product=x.productId?products.find(item=>item.id===x.productId):null;
  if(product&&product.trackStock&&quantity>Number(product.stock||0)+0.000001){
    alert("الرصيد المتاح: "+product.stock+" "+unit(product.unit));renderCart();return;
  }
  x.quantity=quantity;x.stockQuantity=quantity;x.total=Math.round(quantity*Number(x.unitPrice||0)*100)/100;
  renderCart();
}
function add(x){cart.push({...x,total:Math.round(x.quantity*x.unitPrice*100)/100});renderCart();}
let activeCategory="الكل";
function beep(ok=true){
  if(window.AndroidScanner){
    const method=ok?"playSuccessBeep":"playErrorBeep";
    if(typeof window.AndroidScanner[method]==="function")window.AndroidScanner[method]();
    return;
  }
  try{
    const C=window.AudioContext||window.webkitAudioContext;
    if(!C)return;
    if(!audioCtx)audioCtx=new C();
    const ctx=audioCtx;
    if(ctx.state==="suspended")ctx.resume().catch(()=>{});
    const start=ctx.currentTime+0.004;
    const notes=ok
      ? [{frequency:1450,offset:0,duration:0.085},{frequency:1850,offset:0.105,duration:0.115}]
      : [{frequency:520,offset:0,duration:0.13},{frequency:390,offset:0.16,duration:0.16}];
    notes.forEach(note=>{
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type="triangle";osc.frequency.setValueAtTime(note.frequency,start+note.offset);
      gain.gain.setValueAtTime(0.0001,start+note.offset);
      gain.gain.exponentialRampToValueAtTime(ok?0.30:0.22,start+note.offset+0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001,start+note.offset+note.duration);
      osc.connect(gain);gain.connect(ctx.destination);
      osc.start(start+note.offset);osc.stop(start+note.offset+note.duration+0.01);
    });
  }catch(e){}
}
function weightQty(p,kg){return p.unit==="gram"?kg*1000:kg;}
function addProduct(p,qty=1){if(p.trackStock&&qty>Number(p.stock||0))return alert("الرصيد المتاح: "+p.stock+" "+unit(p.unit));const existing=cart.find(x=>x.productId===p.id);if(existing){const next=existing.quantity+qty;if(p.trackStock&&next>Number(p.stock||0))return alert("الرصيد المتاح: "+p.stock+" "+unit(p.unit));existing.quantity=next;existing.stockQuantity=next;existing.total=Math.round(next*existing.unitPrice*100)/100;}else add({productId:p.id,name:p.name,kind:"product",unit:p.unit,quantity:qty,stockQuantity:qty,unitPrice:Number(p.price),cost:Number(p.cost||0),costKnown:p.costKnown===true||Number(p.cost)>0});beep(true);renderCart();}
function renderQuick(){const root=$("quickProducts"),q=$("quickSearch").value.trim().toLowerCase(),cats=$("quickCategories");root.replaceChildren();const categories=["الكل",...new Set(products.map(p=>p.category).filter(Boolean))];cats.replaceChildren();categories.forEach(c=>{const b=document.createElement("button");b.className="category-chip"+(activeCategory===c?" active":"");b.textContent=c;b.onclick=()=>{activeCategory=c;renderQuick()};cats.append(b);});const list=products.filter(p=>p.active!==false&&(activeCategory==="الكل"||p.category===activeCategory)&&(!q||p.name.toLowerCase().includes(q)||String(p.barcode||"").includes(q)));if(!list.length){root.innerHTML='<p class="empty">لا توجد منتجات مطابقة. أضف منتجات أو اختر تصنيفًا آخر.</p>';return;}list.forEach(p=>{const card=document.createElement("div");card.className="quick-card";const b=document.createElement("button");b.className="quick-product";b.innerHTML="<strong></strong><small></small>";b.querySelector("strong").textContent=p.name;b.querySelector("small").textContent=money(p.price)+" / "+unit(p.unit);b.onclick=()=>{if(p.unit==="piece")addProduct(p,1);else addProduct(p,weightQty(p,.25));};card.append(b);if(p.unit!=="piece"){const weights=document.createElement("div");weights.className="weight-chips";[[.25,"250 جم"],[.5,"500 جم"],[.75,"750 جم"],[1,"1 كجم"]].forEach(([n,label])=>{const x=document.createElement("button");x.textContent=label;x.onclick=()=>addProduct(p,weightQty(p,n));weights.append(x);});card.append(weights);}root.append(card);});}
$("quickSearch").oninput=renderQuick;$("discount").oninput=renderCart;
if($("paidAmount"))$("paidAmount").addEventListener("input",()=>{paidAmountTouched=true;updatePaymentSummary();});
if($("paymentMethod"))$("paymentMethod").addEventListener("change",()=>{paidAmountTouched=false;updatePaymentSummary(true);});
$("saleType").onchange=()=>{$("unitHint").textContent=$("saleType").value==="weight"?"أدخل الوزن بالكيلوجرام؛ 0.250 = 250 جرام.":$("saleType").value==="manual"?"بند يدوي لا يخصم من المخزون.":"الكمية بالقطعة أو العبوة.";$("itemQuantity").step=$("saleType").value==="weight"?"0.001":"1";if($("saleType").value!=="weight")$("itemQuantity").value="1";};
$("itemForm").onsubmit=e=>{e.preventDefault();const name=$("itemName").value.trim(),quantity=Number($("itemQuantity").value),price=Number($("itemPrice").value),kind=$("saleType").value;if(!name||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(price)||price<0)return;add({name,kind,unit:kind==="weight"?"kg":"piece",quantity,unitPrice:price,stockQuantity:quantity});e.target.reset();$("itemQuantity").value="1";$("saleType").value="piece";};

$("trackStock").onchange=()=>$("stockLabel").hidden=!$("trackStock").checked;
function resetProduct(){$("productForm").reset();$("productId").value="";$("stockLabel").hidden=true;$("productStock").value="0";$("productMinStock").value="0";}
$("resetProduct").onclick=resetProduct;
$("productForm").onsubmit=async e=>{e.preventDefault();const id=$("productId").value||uid(),barcode=$("productBarcode").value.trim(),p={id,name:$("productName").value.trim(),barcode,category:$("productCategory").value.trim(),unit:$("productUnit").value,price:Number($("productPrice").value),cost:Number($("productCost").value)||0,costKnown:$("productCost").value.trim()!=="",trackStock:$("trackStock").checked,stock:$("trackStock").checked?Number($("productStock").value)||0:null,minStock:$("trackStock").checked?Math.max(0,Number($("productMinStock").value)||0):0,active:(products.find(item=>item.id===id)?.active!==false),updatedAt:new Date().toISOString()};if(!p.name||!Number.isFinite(p.price)||p.price<0)return alert("راجع الاسم والسعر.");try{if(barcode){
 const old=await POSDatabase.getProductByBarcode(barcode);
 if(old&&old.id!==id)return alert("الباركود مسجل للمنتج "+old.name);

}await POSDatabase.saveProduct(p);$("productSearch").value="";activeProductCategory="الكل";await load();resetProduct();activateSubtab("products","list");alert("تم حفظ المنتج.");}catch(err){alert("تعذر الحفظ: "+err.message);}};
async function load(){
  const [items,settings]=await Promise.all([POSDatabase.getProducts(),POSDatabase.getSettings()]);
  products=items;shopSettings={...shopSettings,...settings};
  products.sort((a,b)=>a.name.localeCompare(b.name,"ar"));
  $("shopTitle").textContent=shopSettings.shopName||"كاشير المحل";
  renderQuick();renderProducts();renderCatalog();
}
window.POSRefreshAfterCloudSync=async()=>{
  await load();
  await renderInvoices();
  if(window.POSAccounts){
    await window.POSAccounts.renderCustomers();
    await window.POSAccounts.renderCash();
    await window.POSAccounts.renderReports();
  }
};
function renderProducts(){
  const root=$("productList"),categories=$("productCategories");
  const q=$("productSearch").value.trim().toLocaleLowerCase("ar");
  if(!root||!categories)return;
  root.replaceChildren();categories.replaceChildren();
  const categoryNames=["الكل",...new Set(products.map(p=>String(p.category||"").trim()||"بدون تصنيف"))];
  if(!categoryNames.includes(activeProductCategory))activeProductCategory="الكل";
  categoryNames.forEach(category=>{
    const button=document.createElement("button");
    button.type="button";
    button.className="category-chip"+(activeProductCategory===category?" active":"");
    button.textContent=category;
    button.onclick=()=>{activeProductCategory=category;renderProducts();};
    categories.append(button);
  });
  const list=products.filter(p=>{
    const category=String(p.category||"").trim()||"بدون تصنيف";
    const searchHit=p.name.toLocaleLowerCase("ar").includes(q)||String(p.barcode||"").includes(q);
    return (activeProductCategory==="الكل"||category===activeProductCategory)&&searchHit;
  });
  if(!list.length){root.innerHTML='<p class="empty">لا توجد منتجات في هذا التصنيف.</p>';return;}
  list.forEach(p=>{
    const row=document.createElement("div");row.className="product-row";
    const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
    name.textContent=p.name;
    const category=String(p.category||"").trim()||"بدون تصنيف";
    meta.textContent=category+" · "+(p.barcode?"باركود "+p.barcode:"بدون باركود")+" · "+money(p.price)+(p.trackStock?" · رصيد "+qtyText(p.stock)+" "+unit(p.unit)+" · حد الطلب "+qtyText(p.minStock||0):" · دون تتبع مخزون");
    info.append(name,meta);
    const actions=document.createElement("div"),edit=document.createElement("button"),del=document.createElement("button");
    edit.className="secondary";edit.textContent="تعديل";
    edit.onclick=()=>{
      $("productId").value=p.id;$("productName").value=p.name;$("productBarcode").value=p.barcode||"";
      $("productCategory").value=p.category||"";$("productUnit").value=p.unit;$("productPrice").value=p.price;
      $("productCost").value=p.costKnown?String(p.cost):(Number(p.cost)>0?String(p.cost):"");$("trackStock").checked=!!p.trackStock;$("stockLabel").hidden=!p.trackStock;
      $("productStock").value=p.stock??0;$("productMinStock").value=p.minStock??0;
      activateSubtab("products","add");
      $("productForm").scrollIntoView({behavior:"smooth",block:"start"});
    };
    del.className=p.active===false?"secondary":"remove";del.textContent=p.active===false?"إعادة تفعيل":"أرشفة";
    del.onclick=async()=>{
      const activate=p.active===false;
      if(confirm(activate?"إعادة تفعيل الصنف ليظهر في الكاشير؟":"أرشفة الصنف وإخفاؤه عن البيع؟ ستظل الفواتير وحركات المخزون السابقة محفوظة.")){
        try{
          if(activate)await POSDatabase.setProductActive(p.id,true);
          else await POSDatabase.deleteProduct(p.id);
          await load();
        }catch(error){alert(error.message);}
      }
    };
    actions.append(edit,del);row.append(info,actions);root.append(row);
  });
}
function catalogNameKey(value){return String(value||"").trim().toLocaleLowerCase("ar").replace(/\s+/g," ");}
let activeCatalogCategory="الكل";
function renderCatalog(){
  const catalog=window.POS_CATALOG||[],root=$("catalogList"),cats=$("catalogCategories"),q=$("catalogSearch").value.trim().toLocaleLowerCase("ar");
  if(!root||!cats)return;
  root.replaceChildren();cats.replaceChildren();
  const categories=["الكل",...new Set(catalog.map(p=>p.category))];
  categories.forEach(category=>{
    const b=document.createElement("button");b.className="category-chip"+(activeCatalogCategory===category?" active":"");
    b.textContent=category;b.onclick=()=>{activeCatalogCategory=category;renderCatalog();};cats.append(b);
  });
  const existing=new Set(products.map(p=>catalogNameKey(p.name)));
  const list=catalog.filter(p=>(activeCatalogCategory==="الكل"||p.category===activeCatalogCategory)&&(!q||(p.name+" "+p.category).toLocaleLowerCase("ar").includes(q)));
  $("catalogSummary").textContent=list.length+" منتج ظاهر من أصل "+catalog.length+" · المضاف بالفعل يظهر كـ «مضاف».";
  if(!list.length){root.innerHTML='<p class="empty">لا توجد نتائج مطابقة.</p>';return;}
  list.forEach(item=>{
    const row=document.createElement("div");row.className="catalog-row";
    const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
    name.textContent=item.name;meta.textContent=item.category+" · "+money(item.price)+" / "+unit(item.unit);
    info.append(name,meta);
    const button=document.createElement("button");button.className=existing.has(catalogNameKey(item.name))?"catalog-added":"secondary";
    button.type="button";button.textContent=existing.has(catalogNameKey(item.name))?"مضاف":"إضافة";
    button.disabled=existing.has(catalogNameKey(item.name));button.onclick=()=>addCatalogItem(item);
    row.append(info,button);root.append(row);
  });
}
async function addCatalogItem(item){
  if(products.some(p=>catalogNameKey(p.name)===catalogNameKey(item.name)))return alert("المنتج موجود بالفعل في قائمة المحل.");
  try{
    await POSDatabase.saveProduct({id:uid(),name:item.name,barcode:"",category:item.category,unit:item.unit,price:Number(item.price),cost:0,costKnown:false,trackStock:false,stock:null,updatedAt:new Date().toISOString()});
    await load();$("catalogMessage").textContent="تمت إضافة: "+item.name;
  }catch(error){alert("تعذرت إضافة المنتج: "+error.message);}
}
async function importCatalog(){
  const catalog=window.POS_CATALOG||[],existing=new Set(products.map(p=>catalogNameKey(p.name)));
  const pending=catalog.filter(p=>!existing.has(catalogNameKey(p.name)));
  if(!pending.length)return alert("كل منتجات الكتالوج موجودة بالفعل.");
  if(!confirm("سيتم إضافة "+pending.length+" منتجًا إلى قائمة منتجات المحل، مع تخطي الأصناف الموجودة. هل تريد المتابعة؟"))return;
  try{
    const now=new Date().toISOString(),batch=pending.map(item=>({id:uid(),name:item.name,barcode:"",category:item.category,unit:item.unit,price:Number(item.price),cost:0,trackStock:false,stock:null,minStock:0,updatedAt:now}));
    await POSDatabase.saveProducts(batch);await load();
    $("catalogMessage").textContent="تمت إضافة "+batch.length+" منتجًا. راجع الأسعار وعدّلها حسب أسعار محلك.";
    alert("تمت إضافة "+batch.length+" منتجًا إلى قائمة المحل.");
  }catch(error){alert("تعذرت إضافة الكتالوج: "+error.message);}
}
$("catalogSearch").oninput=renderCatalog;
$("catalogImportAll").onclick=importCatalog;
$("productSearch").oninput=renderProducts;



/* Inventory, suppliers, purchases and physical stocktaking */
function qtyText(value){
  return Number(value||0).toLocaleString("ar-EG",{maximumFractionDigits:3});
}
function trackedProducts(){return products.filter(p=>p.trackStock);}
function stockStatus(product){
  const stock=Number(product.stock||0),minimum=Number(product.minStock||0);
  if(stock<=0)return {key:"out",label:"نفد المخزون"};
  if(minimum>0&&stock<=minimum)return {key:"low",label:"يحتاج طلب"};
  return {key:"ok",label:"متوفر"};
}
function fillSelect(selectId,rows,placeholder,selectedValue){
  const select=$(selectId);if(!select)return;
  const previous=selectedValue!==undefined?String(selectedValue):select.value;
  select.replaceChildren();
  const first=document.createElement("option");first.value="";first.textContent=placeholder;select.append(first);
  rows.forEach(row=>{
    const option=document.createElement("option");option.value=row.id;option.textContent=row.label;select.append(option);
  });
  if(rows.some(row=>String(row.id)===previous))select.value=previous;
}
function renderProductSelects(){
  const options=products.map(p=>({id:p.id,label:p.name+" · "+unit(p.unit)}));
  fillSelect("adjustProduct",options,"اختر الصنف");
  fillSelect("purchaseProduct",options,"اختر الصنف");
}
function movementLabel(type){
  return ({sale:"بيع",purchase:"شراء",return:"مرتجع مبيعات",opening:"رصيد افتتاحي",adjustment:"تسوية يدوية",stocktake:"تسوية جرد"}[type]||type||"حركة");
}
function renderInventory(){
  renderProductSelects();
  const rows=trackedProducts();
  const low=rows.filter(p=>stockStatus(p).key==="low");
  const out=rows.filter(p=>stockStatus(p).key==="out");
  const stockValue=rows.reduce((sum,p)=>sum+(Number(p.stock||0)*Number(p.cost||0)),0);
  $("stockTrackedCount").textContent=String(rows.length);
  $("stockLowCount").textContent=String(low.length);
  $("stockOutCount").textContent=String(out.length);
  $("stockCostValue").textContent=money(stockValue);

  const alerts=$("inventoryAlerts");alerts.replaceChildren();
  const urgent=[...out,...low.filter(p=>stockStatus(p).key==="low")];
  if(!urgent.length){
    const empty=document.createElement("p");empty.className="empty";empty.textContent=rows.length?"لا توجد أصناف وصلت إلى حد الطلب.":"فعّل متابعة المخزون من شاشة المنتجات، ثم سجّل رصيد وحد التنبيه لكل صنف.";alerts.append(empty);
  }else{
    urgent.forEach(p=>{
      const status=stockStatus(p),row=document.createElement("div");row.className="stock-alert-row "+status.key;
      const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
      name.textContent=p.name;meta.textContent="الرصيد: "+qtyText(p.stock)+" "+unit(p.unit)+" · حد التنبيه: "+qtyText(p.minStock||0);
      info.append(name,meta);
      const badge=document.createElement("span");badge.className="stock-status "+status.key;badge.textContent=status.label;
      row.append(info,badge);alerts.append(row);
    });
  }

  const table=$("inventoryTable");
  if(!rows.length)table.innerHTML='<p class="empty">لا توجد أصناف مفعّل لها تتبع المخزون.</p>';
  else{
    const sorted=[...rows].sort((a,b)=>{
      const rank={out:0,low:1,ok:2};return rank[stockStatus(a).key]-rank[stockStatus(b).key]||a.name.localeCompare(b.name,"ar");
    });
    table.innerHTML='<table class="data-table"><thead><tr><th>الصنف</th><th>الرصيد</th><th>حد الطلب</th><th>التكلفة</th><th>الحالة</th></tr></thead><tbody>'+
      sorted.map(p=>{
        const status=stockStatus(p);
        return '<tr><td>'+escapeHtml(p.name)+'</td><td>'+escapeHtml(qtyText(p.stock))+' '+escapeHtml(unit(p.unit))+'</td><td>'+escapeHtml(qtyText(p.minStock||0))+'</td><td>'+escapeHtml(money(p.cost||0))+'</td><td><span class="stock-status '+status.key+'">'+status.label+'</span></td></tr>';
      }).join("")+'</tbody></table>';
  }

  POSDatabase.getMovements().then(movements=>{
    const root=$("movementList");root.replaceChildren();
    movements.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
    const recent=movements.slice(0,40);
    if(!recent.length){root.innerHTML='<p class="empty">لا توجد حركات مخزون مسجلة حتى الآن.</p>';return;}
    recent.forEach(m=>{
      const row=document.createElement("div");row.className="movement-row";
      const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
      name.textContent=m.productName||"صنف";
      const date=m.createdAt?new Date(m.createdAt).toLocaleString("ar-EG"):"";
      meta.textContent=movementLabel(m.type)+(m.note?" · "+m.note:"")+(m.supplierName?" · "+m.supplierName:"")+" · "+date;
      info.append(name,meta);
      const amount=document.createElement("strong"),value=Number(m.quantity||0);
      amount.className=value<0?"movement-negative":"movement-positive";
      amount.textContent=(value>0?"+":"")+qtyText(value)+(m.unit?" "+unit(m.unit):"");
      row.append(info,amount);root.append(row);
    });
  }).catch(error=>console.warn("تعذر تحميل الحركات",error));

  POSDatabase.getStocktakes().then(stocktakes=>{
    const root=$("stocktakeHistory");root.replaceChildren();
    stocktakes.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
    if(!stocktakes.length){root.innerHTML='<p class="empty">لم يتم تنفيذ جرد حتى الآن.</p>';return;}
    stocktakes.slice(0,10).forEach(stocktake=>{
      const wrap=document.createElement("div"),row=document.createElement("div");wrap.className="stocktake-history-item";row.className="history-row";
      const info=document.createElement("div"),title=document.createElement("strong"),meta=document.createElement("small");
      const items=stocktake.items||[];
      const changed=items.filter(item=>Math.abs(Number(item.difference||0))>0.000001).length;
      title.textContent="جرد "+new Date(stocktake.createdAt).toLocaleString("ar-EG");
      meta.textContent=items.length+" صنف · "+changed+" صنف بفروق · "+(stocktake.note||"جرد فعلي");
      info.append(title,meta);
      const details=document.createElement("button");details.type="button";details.className="secondary";details.textContent="الفروق";
      const detailBox=document.createElement("div");detailBox.className="stocktake-differences";detailBox.hidden=true;
      details.onclick=()=>{
        detailBox.hidden=!detailBox.hidden;
        details.textContent=detailBox.hidden?"الفروق":"إخفاء";
        if(detailBox.childElementCount===0){
          const differences=items.filter(item=>Math.abs(Number(item.difference||0))>0.000001);
          if(!differences.length)detailBox.textContent="لا توجد فروق في هذا الجرد.";
          else differences.forEach(item=>{
            const line=document.createElement("div"),name=document.createElement("span"),value=document.createElement("strong");
            name.textContent=item.productName||"صنف";
            const diff=Number(item.difference||0);
            value.textContent=(diff>0?"+":"")+qtyText(diff)+" "+unit(item.unit);
            value.className=diff>0?"movement-positive":"movement-negative";
            line.append(name,value);detailBox.append(line);
          });
        }
      };
      row.append(info,details);wrap.append(row,detailBox);root.append(wrap);
    });
  }).catch(error=>console.warn("تعذر تحميل سجلات الجرد",error));
}
$("refreshInventory").onclick=async()=>{await load();renderInventory();};

$("stockAdjustmentForm").onsubmit=async e=>{
  e.preventDefault();
  const product=products.find(p=>p.id===$("adjustProduct").value);
  if(!product)return alert("اختر الصنف.");
  const value=Number($("adjustmentQuantity").value),type=$("adjustmentType").value;
  if(!Number.isFinite(value)||value<0)return alert("أدخل كمية صحيحة.");
  const current=product.trackStock?Number(product.stock||0):0;
  const delta=type==="add"?value:type==="remove"?-value:value-current;
  if(Math.abs(delta)<0.0000001)return alert("لا توجد كمية تحتاج إلى تسوية.");
  if(current+delta< -0.000001)return alert("لا يمكن أن يصبح رصيد المخزون بالسالب.");
  try{
    await POSDatabase.saveStockAdjustment({productId:product.id,delta,reason:$("adjustmentReason").value.trim()});
    $("adjustmentMessage").textContent="تم تسجيل الحركة وتحديث الرصيد.";
    $("adjustmentQuantity").value="";$("adjustmentReason").value="";
    await load();renderInventory();
  }catch(error){$("adjustmentMessage").textContent="تعذر حفظ الحركة: "+error.message;}
};

function renderStocktakeRows(){
  const root=$("stocktakeRows");root.replaceChildren();
  if(!stocktakeDraft||!stocktakeDraft.length){root.innerHTML='<p class="empty">لا توجد أصناف قابلة للجرد.</p>';return;}
  stocktakeDraft.forEach(item=>{
    const row=document.createElement("div");row.className="stocktake-row";
    const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
    name.textContent=item.productName;meta.textContent="الرصيد الدفتري: "+qtyText(item.expectedQty)+" "+unit(item.unit);
    info.append(name,meta);
    const label=document.createElement("label");label.textContent="الفعلي";
    const input=document.createElement("input");input.type="number";input.min="0";input.step="0.001";input.inputMode="decimal";input.value=String(item.expectedQty);input.dataset.productId=item.productId;
    label.append(input);row.append(info,label);root.append(row);
  });
}
$("startStocktakeButton").onclick=()=>{
  const rows=trackedProducts();
  if(!rows.length)return alert("لا توجد أصناف مفعّل لها تتبع المخزون. فعّل التتبع من شاشة المنتجات أولًا.");
  if(stocktakeDraft&&!confirm("يوجد جرد غير معتمد. هل تريد استبداله بجرد جديد؟"))return;
  stocktakeDraft=rows.map(p=>({productId:p.id,productName:p.name,unit:p.unit,expectedQty:Number(p.stock||0),countedQty:Number(p.stock||0)}));
  $("stocktakeEditor").hidden=false;$("stocktakeMessage").textContent="أدخل الكميات الفعلية لكل صنف. يفضل تنفيذ الجرد بعد إيقاف البيع مؤقتًا.";
  renderStocktakeRows();
};
$("cancelStocktakeButton").onclick=()=>{
  if(stocktakeDraft&&!confirm("إلغاء الجرد الحالي؟ لن يتم تغيير أرصدة المخزون."))return;
  stocktakeDraft=null;$("stocktakeEditor").hidden=true;$("stocktakeRows").replaceChildren();
};
$("completeStocktakeButton").onclick=async()=>{
  if(!stocktakeDraft||!stocktakeDraft.length)return;
  const inputs=[...$("stocktakeRows").querySelectorAll("input[data-product-id]")];
  const counts=new Map(inputs.map(input=>[input.dataset.productId,input.value]));
  const items=stocktakeDraft.map(item=>{
    const raw=counts.get(item.productId);
    const counted=raw===""||raw===undefined?NaN:Number(raw);
    return {...item,countedQty:counted,difference:counted-Number(item.expectedQty||0)};
  });
  if(items.some(item=>!Number.isFinite(item.countedQty)||item.countedQty<0))return alert("راجع الكميات الفعلية؛ لا تقبل القيم السالبة أو الفارغة.");
  const differences=items.filter(item=>Math.abs(item.difference)>0.000001).length;
  if(!confirm("سيتم اعتماد جرد "+items.length+" صنفًا وتسوية "+differences+" صنفًا تختلف كميته عن الرصيد المسجل. هل تتابع؟"))return;
  try{
    await POSDatabase.saveStocktake({id:uid(),createdAt:new Date().toISOString(),note:"جرد فعلي",items});
    stocktakeDraft=null;$("stocktakeEditor").hidden=true;
    $("stocktakeMessage").textContent="تم اعتماد الجرد وتسجيل فروق المخزون في سجل الحركات.";
    await load();renderInventory();
  }catch(error){$("stocktakeMessage").textContent="لم يتم اعتماد الجرد: "+error.message;}
};

/* Supplier balances = opening balance + purchases - payments made */
function supplierBalance(supplierId,suppliers,purchases,payments){
  const supplier=suppliers.find(s=>s.id===supplierId);
  const opening=Number(supplier&&supplier.openingBalance||0);
  const bought=purchases.filter(p=>p.supplierId===supplierId).reduce((sum,p)=>sum+Number(p.total||0)-Number(p.paidAmount||0),0);
  const paid=payments.filter(p=>p.supplierId===supplierId).reduce((sum,p)=>sum+Number(p.amount||0),0);
  return opening+bought-paid;
}
function renderPurchases(){
  Promise.all([POSDatabase.getSuppliers(),POSDatabase.getPurchases(),POSDatabase.getSupplierPayments()]).then(([suppliers,purchases,payments])=>{
    suppliers.sort((a,b)=>a.name.localeCompare(b.name,"ar"));
    const active=suppliers.filter(s=>s.active!==false);
    const supplierOptions=active.map(s=>({id:s.id,label:s.name}));
    fillSelect("purchaseSupplier",supplierOptions,"بدون مورد محدد");
    fillSelect("paymentSupplier",supplierOptions,"اختر المورد");
    fillSelect("statementSupplier",supplierOptions,"اختر المورد");
    fillSelect("purchaseProduct",products.map(p=>({id:p.id,label:p.name+" · "+unit(p.unit)})),"اختر الصنف");

    const list=$("supplierList");list.replaceChildren();
    if(!active.length)list.innerHTML='<p class="empty">لم تتم إضافة موردين بعد.</p>';
    active.forEach(s=>{
      const balance=supplierBalance(s.id,suppliers,purchases,payments);
      const row=document.createElement("div");row.className="supplier-row";
      const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
      name.textContent=s.name;meta.textContent=(s.phone?"هاتف: "+s.phone+" · ":"")+"رصيد سابق: "+money(s.openingBalance||0);
      info.append(name,meta);
      const due=document.createElement("strong");due.className=balance>0.005?"supplier-due":"supplier-clear";due.textContent=money(balance);
      row.append(info,due);list.append(row);
    });

    const history=$("purchaseHistory");history.replaceChildren();
    purchases.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
    if(!purchases.length)history.innerHTML='<p class="empty">لا توجد فواتير مشتريات حتى الآن.</p>';
    purchases.slice(0,80).forEach(p=>{
      const row=document.createElement("div");row.className="history-row";
      const info=document.createElement("div"),title=document.createElement("strong"),meta=document.createElement("small");
      title.textContent=p.number||"فاتورة مشتريات";
      meta.textContent=(p.supplierName||"بدون مورد")+" · "+(p.createdAt?new Date(p.createdAt).toLocaleString("ar-EG"):"")+" · مدفوع "+money(p.paidAmount||0)+" · متبقي "+money(p.balance||0);
      if(p.note)meta.textContent+=" · "+p.note;
      info.append(title,meta);
      const actions=document.createElement("div");actions.className="purchase-history-actions";
      const amount=document.createElement("strong");amount.textContent=money(p.total);
      const details=document.createElement("button");details.type="button";details.className="secondary";details.textContent="تفاصيل";
      details.onclick=()=>alert((p.items||[]).map(item=>item.name+" — "+qtyText(item.quantity)+" "+unit(item.unit)+" × "+money(item.unitCost)+" = "+money(item.total)).join("\n")+"\nالإجمالي: "+money(p.total)+"\nالمدفوع: "+money(p.paidAmount||0)+"\nالمتبقي: "+money(p.balance||0));
      actions.append(amount,details);row.append(info,actions);history.append(row);
    });

    const statement=$("supplierStatement"),supplierId=$("statementSupplier").value;
    statement.replaceChildren();
    if(!supplierId){statement.innerHTML='<p class="empty">اختر موردًا لعرض كشف حسابه.</p>';return;}
    const supplier=active.find(s=>s.id===supplierId);
    if(!supplier){statement.innerHTML='<p class="empty">المورد غير متاح.</p>';return;}
    const events=[{date:"",kind:"رصيد سابق",debit:Number(supplier.openingBalance||0),credit:0,note:""}];
    purchases.filter(p=>p.supplierId===supplierId).forEach(p=>{
      const due=Number(p.total||0)-Number(p.paidAmount||0);
      events.push({date:p.createdAt,kind:"فاتورة شراء",debit:due,credit:0,note:p.note||""});
    });
    payments.filter(p=>p.supplierId===supplierId).forEach(p=>{
      events.push({date:p.createdAt,kind:"سداد للمورد",debit:0,credit:Number(p.amount||0),note:p.note||""});
    });
    events.sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")));
    let running=0;
    const rows=events.map(event=>{
      running+=event.debit-event.credit;
      return '<tr><td>'+escapeHtml(event.date?new Date(event.date).toLocaleDateString("ar-EG"):"—")+'</td><td>'+escapeHtml(event.kind)+'</td><td>'+escapeHtml(money(event.debit))+'</td><td>'+escapeHtml(money(event.credit))+'</td><td>'+escapeHtml(money(running))+'</td></tr>';
    }).join("");
    statement.innerHTML='<div class="table-scroll"><table class="data-table"><thead><tr><th>التاريخ</th><th>البيان</th><th>مستحق</th><th>سداد</th><th>الرصيد</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="supplier-balance-summary">الرصيد المستحق حاليًا: <strong>'+escapeHtml(money(supplierBalance(supplierId,suppliers,purchases,payments)))+'</strong></p>';
  }).catch(error=>console.warn("تعذر تحميل الموردين والمشتريات",error));
  renderPurchaseDraft();
}
$("statementSupplier").onchange=renderPurchases;
$("supplierForm").onsubmit=async e=>{
  e.preventDefault();
  const supplier={id:uid(),name:$("supplierName").value.trim(),phone:$("supplierPhone").value.trim(),openingBalance:Number($("supplierOpeningBalance").value)||0,createdAt:new Date().toISOString()};
  try{
    await POSDatabase.saveSupplier(supplier);e.target.reset();$("supplierOpeningBalance").value="0";
    $("supplierMessage").textContent="تم حفظ المورد.";renderPurchases();
  }catch(error){$("supplierMessage").textContent="تعذر حفظ المورد: "+error.message;}
};
$("supplierPaymentForm").onsubmit=async e=>{
  e.preventDefault();
  const [suppliers,purchases,payments]=await Promise.all([POSDatabase.getSuppliers(),POSDatabase.getPurchases(),POSDatabase.getSupplierPayments()]);
  const supplierId=$("paymentSupplier").value,amount=Number($("supplierPaymentAmount").value);
  const balance=supplierBalance(supplierId,suppliers,purchases,payments);
  if(!supplierId)return alert("اختر المورد.");
  if(!Number.isFinite(amount)||amount<=0)return alert("أدخل مبلغ سداد صحيحًا.");
  if(amount>balance+0.005)return alert("مبلغ السداد أكبر من رصيد المورد المستحق: "+money(balance));
  try{
    const supplier=suppliers.find(s=>s.id===supplierId);
    await POSDatabase.saveSupplierPayment({id:uid(),supplierId,supplierName:supplier.name,amount,method:$("supplierPaymentMethod").value,note:$("supplierPaymentNote").value.trim(),createdAt:new Date().toISOString()});
    $("supplierPaymentAmount").value="";$("supplierPaymentNote").value="";
    $("supplierPaymentMessage").textContent="تم تسجيل السداد وتحديث كشف الحساب.";renderPurchases();
  }catch(error){$("supplierPaymentMessage").textContent="تعذر تسجيل السداد: "+error.message;}
};
$("purchaseProduct").onchange=()=>{
  const product=products.find(p=>p.id===$("purchaseProduct").value);
  $("purchaseUnitCost").value=product?String(product.cost||""):"";
  $("purchaseQuantity").step=product&&product.unit==="piece"?"1":"0.001";
  $("purchaseQuantity").min=product&&product.unit==="piece"?"1":"0.001";
  if(product&&product.unit==="piece"&&Number($("purchaseQuantity").value)<1)$("purchaseQuantity").value="1";
};
$("purchaseItemForm").onsubmit=e=>{
  e.preventDefault();
  const product=products.find(p=>p.id===$("purchaseProduct").value);
  const quantity=Number($("purchaseQuantity").value),unitCost=Number($("purchaseUnitCost").value);
  if(!product)return alert("اختر صنفًا مسجلًا أولًا.");
  if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitCost)||unitCost<0)return alert("راجع الكمية وتكلفة الوحدة.");
  const existing=purchaseDraft.find(item=>item.productId===product.id);
  if(existing){
    const combined=existing.quantity+quantity,totalCost=(existing.quantity*existing.unitCost)+(quantity*unitCost);
    existing.quantity=combined;existing.unitCost=totalCost/combined;existing.total=totalCost;
  }else purchaseDraft.push({productId:product.id,name:product.name,unit:product.unit,quantity,unitCost,total:quantity*unitCost});
  $("purchaseQuantity").value="1";$("purchaseUnitCost").value=String(product.cost||"");
  renderPurchaseDraft();
};
function renderPurchaseDraft(){
  const root=$("purchaseDraftList");if(!root)return;
  root.replaceChildren();
  const total=purchaseDraft.reduce((sum,item)=>sum+item.total,0);
  $("purchaseDraftTotal").textContent=money(total);
  const paid=Number($("purchasePaidAmount").value)||0;
  $("purchaseDuePreview").textContent="المتبقي بعد السداد: "+money(Math.max(0,total-paid))+(paid>total?" · راجع المبلغ المدفوع":"");
  $("savePurchaseButton").disabled=!purchaseDraft.length;
  if(!purchaseDraft.length){root.innerHTML='<p class="empty">لم تتم إضافة أصناف إلى فاتورة الشراء.</p>';return;}
  purchaseDraft.forEach((item,index)=>{
    const row=document.createElement("div");row.className="purchase-draft-row";
    const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
    name.textContent=item.name;meta.textContent=qtyText(item.quantity)+" "+unit(item.unit)+" × تكلفة "+money(item.unitCost);
    info.append(name,meta);
    const amount=document.createElement("strong");amount.textContent=money(item.total);
    const del=document.createElement("button");del.type="button";del.className="remove";del.textContent="حذف";del.onclick=()=>{purchaseDraft.splice(index,1);renderPurchaseDraft();};
    row.append(info,amount,del);root.append(row);
  });
}
$("purchasePaidAmount").oninput=renderPurchaseDraft;
$("savePurchaseButton").onclick=async()=>{
  const total=purchaseDraft.reduce((sum,item)=>sum+item.total,0),paid=Number($("purchasePaidAmount").value)||0;
  if(!purchaseDraft.length)return alert("أضف أصنافًا للمشتريات.");
  if(paid<0||paid>total+0.005)return alert("المبلغ المدفوع يجب ألا يتجاوز إجمالي فاتورة الشراء.");
  const supplierId=$("purchaseSupplier").value;
  const suppliers=await POSDatabase.getSuppliers();
  const supplier=suppliers.find(s=>s.id===supplierId);
  if(supplierId&&!supplier)return alert("المورد المختار غير موجود.");
  const purchase={
    id:uid(),number:"PUR-"+new Date().toISOString().replace(/[-:TZ.]/g,"").slice(0,14)+"-"+uid().slice(0,4).toUpperCase(),
    createdAt:new Date().toISOString(),supplierId:supplierId||null,supplierName:supplier?supplier.name:"",
    items:purchaseDraft.map(item=>({...item})),total,paidAmount:paid,balance:Math.max(0,total-paid),
    paymentMethod:$("purchasePaymentMethod").value,note:$("purchaseNote").value.trim()
  };
  try{
    await POSDatabase.savePurchase(purchase);
    purchaseDraft=[];$("purchasePaidAmount").value="0";$("purchaseNote").value="";
    $("purchaseMessage").textContent="تم حفظ فاتورة الشراء، وزيادة أرصدة المخزون، وتحديث متوسط تكلفة الأصناف.";
    await load();renderInventory();renderPurchases();
  }catch(error){$("purchaseMessage").textContent="لم يتم حفظ المشتريات: "+error.message;}
};


function escapeHtml(value){
  return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function invoiceNumber(inv){return "SJ-"+String(inv.id||"").replace(/[^a-z0-9]/gi,"").slice(0,8).toUpperCase();}
function paymentName(value){return ({cash:"نقدي",electronic:"دفع إلكتروني",credit:"آجل"}[value]||"غير محدد");}
function receiptDate(inv){
  const date=new Date(inv.createdAt||Date.now());
  return Number.isNaN(date.getTime())?"":date.toLocaleString("ar-EG");
}
function receiptQuantity(item){
  return Number(item.quantity||0).toLocaleString("ar-EG",{maximumFractionDigits:3})+" "+unit(item.unit);
}
function receiptContent(inv){
  const paper=shopSettings.paperWidth==="A4"?"190mm":Math.max(45,Number(shopSettings.paperWidth||80)-8)+"mm";
  const rows=(inv.items||[]).map(item=>"<tr><td>"+escapeHtml(item.name)+"</td><td>"+escapeHtml(receiptQuantity(item))+"</td><td>"+escapeHtml(money(item.unitPrice))+"</td><td>"+escapeHtml(money(item.total))+"</td></tr>").join("");
  const subtotal=Number(inv.subtotal??(Number(inv.total||0)+Number(inv.discount||0)));
  let html='<article class="receipt-paper" style="width:'+paper+'">';
  html+='<header class="receipt-brand"><h2>'+escapeHtml(shopSettings.shopName||"كاشير المحل")+'</h2>';
  if(shopSettings.shopAddress)html+='<p>'+escapeHtml(shopSettings.shopAddress)+'</p>';
  if(shopSettings.shopPhone)html+='<p>هاتف: '+escapeHtml(shopSettings.shopPhone)+'</p>';
  html+='</header><div class="receipt-meta"><div><span>رقم الفاتورة</span><strong>'+escapeHtml(invoiceNumber(inv))+'</strong></div><div><span>التاريخ</span><strong>'+escapeHtml(receiptDate(inv))+'</strong></div></div>';
  if(inv.customerName||inv.customerPhone)html+='<div class="receipt-customer">'+(inv.customerName?'العميل: '+escapeHtml(inv.customerName):'')+(inv.customerPhone?'<span>هاتف: '+escapeHtml(inv.customerPhone)+'</span>':'')+'</div>';
  html+='<table class="receipt-table"><thead><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>'+rows+'</tbody></table>';
  const invoiceTotal=Number(inv.total||0);
  const paidAmount=Number.isFinite(Number(inv.paidAmount))?Number(inv.paidAmount):(inv.paymentMethod==="credit"?0:invoiceTotal);
  const remainingAmount=Number.isFinite(Number(inv.remainingAmount))?Number(inv.remainingAmount):Math.max(0,invoiceTotal-paidAmount);
  const paidMethod=paidAmount>0?paymentName(inv.paidMethod||inv.paymentMethod):paymentName(inv.paymentMethod);
  html+='<div class="receipt-totals"><div><span>الإجمالي قبل الخصم</span><strong>'+escapeHtml(money(subtotal))+'</strong></div><div><span>الخصم</span><strong>'+escapeHtml(money(inv.discount||0))+'</strong></div><div class="receipt-grand"><span>المبلغ المطلوب</span><strong>'+escapeHtml(money(invoiceTotal))+'</strong></div><div><span>المدفوع</span><strong>'+escapeHtml(money(paidAmount))+'</strong></div><div class="receipt-remaining"><span>الباقي</span><strong>'+escapeHtml(money(remainingAmount))+'</strong></div></div>';
  html+='<p class="receipt-payment">طريقة استلام المدفوع: '+escapeHtml(paidMethod)+'</p><footer>'+escapeHtml(shopSettings.receiptFooter||"شكراً لزيارتكم")+'</footer></article>';
  return html;
}
function receiptDocument(inv){
  const style='@page{margin:3mm}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:Tahoma,Arial,sans-serif}body{display:flex;justify-content:center;padding:3mm;font-size:10pt}.receipt-paper{max-width:100%;margin:0 auto;padding:2mm;font-size:9pt}.receipt-brand{text-align:center;border-bottom:1px dashed #777;padding-bottom:8px;margin-bottom:8px}.receipt-brand h2{font-size:16pt;margin:0 0 5px}.receipt-brand p{margin:3px 0;font-size:9pt}.receipt-meta{display:flex;justify-content:space-between;gap:8px;margin:8px 0}.receipt-meta div{display:flex;flex-direction:column;gap:3px}.receipt-meta span,.receipt-customer{font-size:8pt;color:#333}.receipt-customer{border-block:1px dashed #aaa;padding:6px 0;margin:6px 0}.receipt-customer span{display:block;margin-top:3px}.receipt-table{width:100%;border-collapse:collapse;font-size:8pt}.receipt-table th,.receipt-table td{padding:5px 2px;border-bottom:1px solid #ddd;text-align:right;vertical-align:top}.receipt-table th{background:#f1f1f1}.receipt-totals{margin-top:8px;border-top:1px dashed #777;padding-top:6px}.receipt-totals div{display:flex;justify-content:space-between;gap:8px;padding:3px 0}.receipt-grand{font-size:12pt;border-top:1px solid #333;margin-top:4px;padding-top:7px!important}.receipt-payment{font-size:9pt;margin:8px 0}.receipt-paper footer{text-align:center;border-top:1px dashed #777;padding-top:8px;margin-top:10px;font-weight:bold}';
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(invoiceNumber(inv))+'</title><style>'+style+'</style></head><body>'+receiptContent(inv)+'</body></html>';
}
function receiptMessage(inv){
  const lines=(inv.items||[]).map(item=>'• '+item.name+' — '+receiptQuantity(item)+' × '+money(item.unitPrice)+' = '+money(item.total));
  const paid=Number.isFinite(Number(inv.paidAmount))?Number(inv.paidAmount):(inv.paymentMethod==="credit"?0:Number(inv.total||0));
  const remaining=Number.isFinite(Number(inv.remainingAmount))?Number(inv.remainingAmount):Math.max(0,Number(inv.total||0)-paid);
  const method=paid>0?paymentName(inv.paidMethod||inv.paymentMethod):paymentName(inv.paymentMethod);
  return [shopSettings.shopName||"فاتورة مبيعات",shopSettings.shopAddress||"",shopSettings.shopPhone?"هاتف: "+shopSettings.shopPhone:"",
    "فاتورة رقم: "+invoiceNumber(inv),"التاريخ: "+receiptDate(inv),inv.customerName?"العميل: "+inv.customerName:"",inv.customerPhone?"هاتف العميل: "+inv.customerPhone:"",
    "--------------------",...lines,"--------------------",
    "الإجمالي قبل الخصم: "+money(inv.subtotal??(Number(inv.total||0)+Number(inv.discount||0))),
    "الخصم: "+money(inv.discount||0),"الإجمالي المطلوب: "+money(inv.total||0),
    "المدفوع: "+money(paid),"الباقي: "+money(remaining),
    "طريقة استلام المدفوع: "+method,shopSettings.receiptFooter||"شكراً لزيارتكم"
  ].filter(Boolean).join("\n");
}
function showReceipt(inv){activeReceipt=inv;$("receiptPreview").innerHTML=receiptContent(inv);$("receiptModal").hidden=false;}
function closeReceipt(){$("receiptModal").hidden=true;activeReceipt=null;}
function normalizeWhatsAppPhone(phone){
  let digits=String(phone||"").replace(/\D/g,"");
  if(digits.startsWith("00"))digits=digits.slice(2);
  else if(digits.startsWith("0"))digits="20"+digits.slice(1);
  return digits.length>=10&&digits.length<=15?digits:"";
}
async function shareInvoice(inv){
  const message=receiptMessage(inv),phone=normalizeWhatsAppPhone(inv.customerPhone);
  if(phone&&window.AndroidScanner&&typeof window.AndroidScanner.sendWhatsApp==="function"){
    window.AndroidScanner.sendWhatsApp(phone,message);return;
  }
  if(!phone&&window.AndroidScanner&&typeof window.AndroidScanner.shareText==="function"){
    window.AndroidScanner.shareText(message);return;
  }
  if(navigator.share){
    try{await navigator.share({title:"فاتورة "+invoiceNumber(inv),text:message});return;}
    catch(error){if(error&&error.name==="AbortError")return;}
  }
  const url="https://wa.me/"+(phone||"")+"?text="+encodeURIComponent(message);
  const opened=window.open(url,"_blank","noopener");
  if(!opened)alert("تعذر فتح واتساب تلقائيًا. اسمح بفتح الرابط من إعدادات المتصفح.");
}
function printInvoice(inv){
  const html=receiptDocument(inv),job="فاتورة-"+invoiceNumber(inv);
  if(window.AndroidScanner&&typeof window.AndroidScanner.printHtml==="function"){window.AndroidScanner.printHtml(html,job);return;}
  const printWindow=window.open("","_blank");
  if(!printWindow){alert("اسمح بفتح نافذة الطباعة من إعدادات المتصفح.");return;}
  printWindow.document.open();printWindow.document.write(html);printWindow.document.close();
  setTimeout(()=>{try{printWindow.focus();printWindow.print();}catch(error){}},500);
}
function renderSettings(){
  if(!$("shopSettingsForm"))return;
  $("shopName").value=shopSettings.shopName||"";$("shopPhone").value=shopSettings.shopPhone||"";
  $("shopAddress").value=shopSettings.shopAddress||"";$("receiptFooter").value=shopSettings.receiptFooter||"شكراً لزيارتكم";
  $("paperWidth").value=String(shopSettings.paperWidth||"80");
}
$("shopSettingsForm").onsubmit=async e=>{
  e.preventDefault();
  const values={shopName:$("shopName").value.trim()||"كاشير المحل",shopPhone:$("shopPhone").value.trim(),
    shopAddress:$("shopAddress").value.trim(),receiptFooter:$("receiptFooter").value.trim()||"شكراً لزيارتكم",paperWidth:$("paperWidth").value};
  try{await POSDatabase.saveSettings(values);shopSettings={...shopSettings,...values};$("shopTitle").textContent=shopSettings.shopName;$("settingsMessage").textContent="تم حفظ بيانات المحل على هذا الجهاز.";}
  catch(error){$("settingsMessage").textContent="تعذر الحفظ: "+error.message;}
};
$("closeReceiptModal").onclick=closeReceipt;
$("receiptModal").addEventListener("click",event=>{if(event.target===$("receiptModal"))closeReceipt();});
$("receiptPrint").onclick=()=>{if(activeReceipt)printInvoice(activeReceipt);};
$("receiptShare").onclick=()=>{if(activeReceipt)shareInvoice(activeReceipt);};

async function renderInvoices(){
  const root=$("invoiceList");root.replaceChildren();
  const list=(await POSDatabase.getInvoices()).sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  if(!list.length){root.innerHTML='<p class="empty">لا توجد فواتير محفوظة.</p>';return;}
  list.forEach(inv=>{
    const row=document.createElement("div");row.className="invoice-row";
    const info=document.createElement("div"),title=document.createElement("strong"),meta=document.createElement("small");
    title.textContent="فاتورة "+invoiceNumber(inv);
    const due=Number.isFinite(Number(inv.remainingAmount))?Number(inv.remainingAmount):(inv.paymentMethod==="credit"?Number(inv.total||0):0);
    meta.textContent=receiptDate(inv)+" · "+(inv.items||[]).length+" صنف · "+paymentName(inv.paymentMethod)+(due>0.005?" · باقي "+money(due):"")+(inv.customerName?" · "+inv.customerName:"");
    info.append(title,meta);
    const total=document.createElement("strong");total.textContent=money(inv.total);
    const actions=document.createElement("div");actions.className="invoice-actions";
    const detail=document.createElement("button");detail.className="secondary";detail.textContent="عرض";detail.onclick=()=>showReceipt(inv);
    const print=document.createElement("button");print.className="secondary";print.textContent="طباعة";print.onclick=()=>printInvoice(inv);
    const share=document.createElement("button");share.className="secondary";share.textContent="واتساب";share.onclick=()=>shareInvoice(inv);
    const returnButton=document.createElement("button");returnButton.type="button";returnButton.className="secondary";returnButton.textContent="مرتجع";returnButton.dataset.returnInvoice=inv.id;
    actions.append(detail,print,share,returnButton);row.append(info,total,actions);root.append(row);
  });
}
$("checkoutButton").onclick=async()=>{
  if(!cart.length)return;
  const subtotal=Math.round(sub()*100)/100,discount=Math.round(disc()*100)/100;
  if(discount>subtotal)return alert("الخصم أكبر من إجمالي الفاتورة.");
  const total=Math.round((subtotal-discount)*100)/100;
  const paidAmount=Math.round(Number($("paidAmount").value||0)*100)/100;
  if(!Number.isFinite(paidAmount)||paidAmount<0)return alert("اكتب مبلغًا صحيحًا في خانة المدفوع.");
  if(paidAmount>total+0.005)return alert("المبلغ المدفوع لا يمكن أن يكون أكبر من المبلغ المطلوب.");
  const remainingAmount=Math.max(0,Math.round((total-paidAmount)*100)/100);
  const selectedMethod=$("paymentMethod").value;
  if(selectedMethod==="credit"&&paidAmount>0.005)return alert("عند تسجيل دفعة جزئية، اختر طريقة استلامها: نقدي أو دفع إلكتروني. اختر «آجل» فقط عندما لا يدفع العميل شيئًا الآن.");
  const customerName=$("customerName").value.trim(),customerPhone=$("customerPhone").value.trim();
  const phoneDigits=customerPhone.replace(/\D/g,"");
  if(remainingAmount>0.005&&(!customerName||phoneDigits.length<8)){
    return alert("لوجود مبلغ متبقٍ على العميل، اكتب اسم العميل ورقم هاتف صحيحًا (8 أرقام على الأقل).");
  }
  const effectivePaymentMethod=remainingAmount>0.005?"credit":selectedMethod;
  const paidMethod=selectedMethod==="electronic"?"electronic":"cash";
  const inv={id:uid(),createdAt:new Date().toISOString(),items:cart.map(x=>({...x})),
    subtotal,discount,total,paymentMethod:effectivePaymentMethod,paidAmount,
    remainingAmount,paidMethod,customerName,customerPhone,currency:"EGP",status:"saved"};
  try{
    await POSDatabase.saveInvoice(inv);
    cart.length=0;$("discount").value="0";$("customerName").value="";$("customerPhone").value="";
    paidAmountTouched=false;$("paymentMethod").value="cash";
    renderCart();setInvoiceOpen(false);await load();showReceipt(inv);
  }catch(err){alert("لم تحفظ الفاتورة: "+err.message);}
};
async function stopCamera(){
  if(nativeScannerActive&&window.AndroidScanner&&typeof window.AndroidScanner.stopScan==="function"){
    try{window.AndroidScanner.stopScan();}catch(e){}
  }
  nativeScannerActive=false;
  if(timer)clearTimeout(timer);
  timer=null;
  scanStarting=false;
  if(stream){stream.getTracks().forEach(track=>track.stop());stream=null;}
  $("cameraPreview").srcObject=null;
  $("scannerArea").hidden=true;
}
function validEAN(value,format){
  const d=String(value||"").replace(/[^0-9]/g,"");
  if(!["ean_13","ean_8","upc_a"].includes(format))return true;
  const n=format==="ean_13"?13:format==="ean_8"?8:12;
  if(d.length!==n)return false;
  let sum=0,weight=3;
  for(let i=d.length-2;i>=0;i--){sum+=Number(d[i])*weight;weight=weight===3?1:3;}
  return (10-sum%10)%10===Number(d[d.length-1]);
}
async function handleScanned(code,format){
  if(scannerMode==="product"){
    $("productBarcode").value=code;
    $("scannerMessage").textContent="✓ تم قراءة الباركود. اضغط حفظ المنتج.";
    beep(true);await stopCamera();$("productBarcode").focus();return;
  }
  // Exact full barcode match only. Never guess a product from a shortened prefix.
  const p=await POSDatabase.getProductByBarcode(code);
  if(p&&p.active===false){
    beep(false);
    $("scannerMessage").textContent="هذا الصنف مؤرشف ولا يمكن بيعه. أعد تفعيله من إدارة المنتجات أولًا.";
    return;
  }
  if(p){
    if(p.unit==="piece")addProduct(p,1);else addProduct(p,weightQty(p,.25));
    $("scannerMessage").textContent="✓ تمت إضافة "+p.name+" — أبعد العبوة عن الكاميرا حتى تختفي القراءة، ثم امسح الصنف التالي.";
  }else{
    beep(false);
    $("scannerMessage").textContent="لم أجد منتجًا مطابقًا: "+code+" — راجع تسجيل الباركود في المنتج.";
  }
}
window.onNativeScannerReady=()=>{
  scanStarting=false;
};
window.onNativeScannerClosed=()=>{
  scanStarting=false;
  nativeScannerActive=false;
};
window.onNativeBarcodeScanned=(code,format)=>{
  if(!code)return;
  handleScanned(String(code),String(format||""));
};
async function scan(mode="sale"){
  if(scanStarting||stream||nativeScannerActive)return;
  scannerMode=mode;
  if(window.AndroidScanner&&typeof window.AndroidScanner.startScan==="function"){
    scanStarting=true;nativeScannerActive=true;
    try{window.AndroidScanner.startScan(mode);}
    catch(error){scanStarting=false;nativeScannerActive=false;alert("تعذر تشغيل ماسح Android: "+(error?.message||error));}
    return;
  }
  scanStarting=true;
  try{
    const C=window.AudioContext||window.webkitAudioContext;
    if(C){if(!audioCtx)audioCtx=new C();await audioCtx.resume();}
  }catch(e){}
  if(!("BarcodeDetector"in window)){
    scanStarting=false;
    return alert("هذا المتصفح لا يدعم قارئ الباركود. استخدم Chrome محدّثًا على Android.");
  }
  try{
    const wanted=["ean_13","ean_8","upc_a","upc_e","code_128","code_39","code_93","itf","codabar","qr_code"];
    const supported=await BarcodeDetector.getSupportedFormats();
    const formats=wanted.filter(x=>supported.includes(x));
    if(!formats.length)throw new Error("لا توجد صيغ باركود للمنتجات مدعومة.");
    const detector=new BarcodeDetector({formats});
    if(!navigator.mediaDevices?.getUserMedia)throw new Error("الكاميرا غير متاحة.");
    stream=await navigator.mediaDevices.getUserMedia({
      video:{
        facingMode:{ideal:"environment"},
        width:{ideal:1280},
        height:{ideal:720},
        frameRate:{ideal:24,max:30}
      },
      audio:false
    });
    const track=stream.getVideoTracks()[0];
    // Ask supported mobile cameras to keep autofocus continuous. Unsupported controls are ignored safely.
    try{
      const capabilities=track?.getCapabilities?.();
      const cameraHints={};
      if(capabilities?.focusMode?.includes("continuous"))cameraHints.focusMode="continuous";
      if(capabilities?.exposureMode?.includes("continuous"))cameraHints.exposureMode="continuous";
      if(capabilities?.whiteBalanceMode?.includes("continuous"))cameraHints.whiteBalanceMode="continuous";
      if(Object.keys(cameraHints).length)await track.applyConstraints({advanced:[cameraHints]});
    }catch(e){}
    $("scannerMessage").textContent="وجّه الباركود أمام الكاميرا. سيُضاف الصنف مرة واحدة فقط لكل ظهور.";
    $("scannerArea").hidden=false;
    const video=$("cameraPreview");
    video.srcObject=stream;
    await video.play();
    scanStarting=false;

    let candidateCode="",stableReads=0,lockedCode="",noCodeSince=0;
    const unlockAfterMs=1200;
    const loop=async()=>{
      if(!stream)return;
      try{
        const codes=await detector.detect(video);
        const now=performance.now();
        const detected=codes.find(item=>{
          const value=String(item.rawValue||"").trim();
          return value&&validEAN(value,item.format||"");
        });
        if(detected){
          const code=String(detected.rawValue).trim();
          noCodeSince=0;
          if(code===lockedCode){
            candidateCode="";
            stableReads=0;
          }else{
            if(code===candidateCode)stableReads++;
            else{candidateCode=code;stableReads=1;}
            if(stableReads>=2){
              // Lock this physical appearance before adding the item, so repeated camera frames cannot add it twice.
              lockedCode=code;
              candidateCode="";
              stableReads=0;
              await handleScanned(code,detected.format||"");
            }
          }
        }else{
          candidateCode="";
          stableReads=0;
          if(!noCodeSince)noCodeSince=now;
          // A brief autofocus blur must not release the lock and create a duplicate sale.
          if(now-noCodeSince>=unlockAfterMs){
            lockedCode="";
            noCodeSince=0;
          }
        }
      }catch(e){
        // A transient detector error is treated like a blurred frame, not a confirmed removal.
      }
      if(stream)timer=setTimeout(loop,90);
    };
    loop();
  }catch(e){
    await stopCamera();
    alert("تعذر تشغيل المسح. تأكد من إذن الكاميرا واستخدام رابط HTTPS. "+(e?.message||""));
  }
}
$("scanButton").onclick=()=>scan("sale");$("scanProductBarcode").onclick=()=>scan("product");$("closeScanner").onclick=stopCamera;
$("exportBackup").onclick=async()=>{try{const data=await POSDatabase.backupData(),json=JSON.stringify(data,null,2);if(window.AndroidScanner&&typeof window.AndroidScanner.saveBackup==="function"){window.AndroidScanner.saveBackup(json);$("backupMessage").textContent="اختر مكان حفظ النسخة من نافذة Android.";return;}const blob=new Blob([json],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="supermarket-pos-backup-"+new Date().toISOString().slice(0,10)+".json";a.click();URL.revokeObjectURL(url);$("backupMessage").textContent="تم إنشاء النسخة؛ احتفظ بها خارج الهاتف.";}catch(e){alert(e.message);}};
$("importBackup").onchange=async e=>{const f=e.target.files[0];if(!f)return;if(!confirm("الاستعادة ستحذف البيانات الحالية وتستبدلها. هل تتابع؟")){e.target.value="";return;}try{await POSDatabase.restoreData(JSON.parse(await f.text()));await load();await renderInvoices();$("backupMessage").textContent="تمت الاستعادة بنجاح.";}catch(err){alert("فشلت الاستعادة: "+err.message);}finally{e.target.value="";}};
window.addEventListener("online",()=>$("connectionState").textContent="متصل");window.addEventListener("offline",()=>$("connectionState").textContent="دون إنترنت");
if(!window.AndroidScanner&&"serviceWorker"in navigator&&location.protocol!=="file:")addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
(async()=>{try{await load();renderCart();}catch(e){alert("تعذر فتح قاعدة البيانات: "+e.message);}})();
})();
/* POS integrity release 1.6.0 */
