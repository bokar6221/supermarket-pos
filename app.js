(()=>{"use strict";
const $=id=>document.getElementById(id),cart=[];
let products=[],stream=null,timer=null,audioCtx=null,scannerMode="sale",scanStarting=false,nativeScannerActive=false;
let shopSettings={shopName:"كاشير المحل",shopPhone:"",shopAddress:"",receiptFooter:"شكراً لزيارتكم",paperWidth:"80"};
let activeReceipt=null;
const money=n=>Number(n||0).toLocaleString("ar-EG",{minimumFractionDigits:2,maximumFractionDigits:2})+" ج.م",uid=()=>crypto.randomUUID?crypto.randomUUID():"id-"+Date.now()+"-"+Math.random(),unit=u=>({piece:"قطعة",kg:"كيلو",gram:"جرام"})[u]||"وحدة";
function view(n){setInvoiceOpen(false);document.body.classList.toggle("sales-view",n==="sale");document.querySelectorAll(".view").forEach(x=>x.classList.toggle("active",x.id==="view-"+n));document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.view===n));if(n==="products"){renderProducts();renderCatalog();}if(n==="invoices")renderInvoices();if(n==="sale")renderQuick();if(n==="settings")renderSettings();}
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>view(b.dataset.view));
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

function renderCart(){
  const netTotal=Math.max(0,sub()-Math.min(disc(),sub()));
  $("cartCount").textContent=cart.length+" صنف";
  $("grandTotal").textContent=money(netTotal);
  $("mobileCartCount").textContent=String(cart.length);
  $("mobileGrandTotal").textContent=money(netTotal);
  $("checkoutButton").disabled=!cart.length;
  const root=$("cartItems");root.replaceChildren();
  if(!cart.length){root.innerHTML='<p class="empty">امسح الباركود أو اضغط على الصنف لإضافته</p>';return;}
  cart.forEach((x,i)=>{
    const row=document.createElement("div");row.className="cart-item";
    const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");
    name.textContent=x.name;
    meta.textContent=x.quantity+" "+unit(x.unit)+" × سعر الوحدة "+money(x.unitPrice);
    info.className="cart-item-info";
    if(x.productId&&(x.unit==="kg"||x.unit==="gram")){
      const amountLabel=document.createElement("label"),amountInput=document.createElement("input");
      amountLabel.className="amount-field";amountLabel.textContent="عايز بكام؟";
      amountInput.type="number";amountInput.min="0.01";amountInput.step="0.01";amountInput.inputMode="decimal";
      amountInput.value=Number(x.total).toFixed(2);amountInput.setAttribute("aria-label","المبلغ المطلوب لهذا المنتج");
      amountInput.addEventListener("change",()=>setCartAmount(i,amountInput.value));
      amountLabel.append(amountInput);info.append(name,amountLabel,meta);
    }else info.append(name,meta);
    const side=document.createElement("div"),amount=document.createElement("strong"),controls=document.createElement("div"),minus=document.createElement("button"),plus=document.createElement("button"),del=document.createElement("button");
    amount.textContent=money(x.total);controls.className="qty-controls";
    minus.textContent="−";plus.textContent="+";
    minus.onclick=()=>changeCartQty(i,-(x.unit==="piece"?1:x.unit==="gram"?250:.25));
    plus.onclick=()=>changeCartQty(i,x.unit==="piece"?1:x.unit==="gram"?250:.25);
    del.className="remove";del.textContent="حذف";
    del.onclick=()=>{cart.splice(i,1);renderCart()};
    controls.append(minus,plus);side.className="cart-item-side";side.append(amount,controls,del);
    row.append(info,side);root.append(row);
  });
}
function setCartAmount(i,value){
  const x=cart[i];if(!x)return;
  const amount=Math.round(Number(value)*100)/100;
  if(!Number.isFinite(amount)||amount<=0){alert("اكتب مبلغًا صحيحًا أكبر من صفر.");renderCart();return;}
  if(!Number.isFinite(x.unitPrice)||x.unitPrice<=0){alert("سعر الكيلو أو الجرام غير مضبوط لهذا المنتج.");renderCart();return;}
  const quantity=Math.round((amount/x.unitPrice)*1000)/1000;
  if(quantity<=0){alert("المبلغ أقل من أن ينتج وزنًا قابلًا للبيع.");renderCart();return;}
  const product=products.find(p=>p.id===x.productId);
  if(product&&product.trackStock&&quantity>Number(product.stock||0)+0.000001){
    alert("الرصيد المتاح لا يكفي لهذا المبلغ. الرصيد: "+product.stock+" "+unit(product.unit));renderCart();return;
  }
  x.quantity=quantity;x.stockQuantity=quantity;x.total=amount;renderCart();
}
function changeCartQty(i,delta){const x=cart[i];if(!x)return;const next=Math.round((x.quantity+delta)*1000)/1000;if(next<=0){cart.splice(i,1);}else{const p=products.find(item=>item.id===x.productId);if(p&&p.trackStock&&next>Number(p.stock||0))return alert("الرصيد المتاح: "+p.stock+" "+unit(p.unit));x.quantity=next;x.stockQuantity=next;x.total=Math.round(next*x.unitPrice*100)/100;}renderCart();}
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
function addProduct(p,qty=1){if(p.trackStock&&qty>Number(p.stock||0))return alert("الرصيد المتاح: "+p.stock+" "+unit(p.unit));const existing=cart.find(x=>x.productId===p.id);if(existing){const next=existing.quantity+qty;if(p.trackStock&&next>Number(p.stock||0))return alert("الرصيد المتاح: "+p.stock+" "+unit(p.unit));existing.quantity=next;existing.stockQuantity=next;existing.total=Math.round(next*existing.unitPrice*100)/100;}else add({productId:p.id,name:p.name,kind:"product",unit:p.unit,quantity:qty,stockQuantity:qty,unitPrice:Number(p.price),cost:Number(p.cost||0)});beep(true);renderCart();}
function renderQuick(){const root=$("quickProducts"),q=$("quickSearch").value.trim().toLowerCase(),cats=$("quickCategories");root.replaceChildren();const categories=["الكل",...new Set(products.map(p=>p.category).filter(Boolean))];cats.replaceChildren();categories.forEach(c=>{const b=document.createElement("button");b.className="category-chip"+(activeCategory===c?" active":"");b.textContent=c;b.onclick=()=>{activeCategory=c;renderQuick()};cats.append(b);});const list=products.filter(p=>(activeCategory==="الكل"||p.category===activeCategory)&&(!q||p.name.toLowerCase().includes(q)||String(p.barcode||"").includes(q)));if(!list.length){root.innerHTML='<p class="empty">لا توجد منتجات مطابقة. أضف منتجات أو اختر تصنيفًا آخر.</p>';return;}list.forEach(p=>{const card=document.createElement("div");card.className="quick-card";const b=document.createElement("button");b.className="quick-product";b.innerHTML="<strong></strong><small></small>";b.querySelector("strong").textContent=p.name;b.querySelector("small").textContent=money(p.price)+" / "+unit(p.unit);b.onclick=()=>{if(p.unit==="piece")addProduct(p,1);else addProduct(p,weightQty(p,.25));};card.append(b);if(p.unit!=="piece"){const weights=document.createElement("div");weights.className="weight-chips";[[.25,"250 جم"],[.5,"500 جم"],[.75,"750 جم"],[1,"1 كجم"]].forEach(([n,label])=>{const x=document.createElement("button");x.textContent=label;x.onclick=()=>addProduct(p,weightQty(p,n));weights.append(x);});card.append(weights);}root.append(card);});}
$("quickSearch").oninput=renderQuick;$("discount").oninput=renderCart;
$("saleType").onchange=()=>{$("unitHint").textContent=$("saleType").value==="weight"?"أدخل الوزن بالكيلوجرام؛ 0.250 = 250 جرام.":$("saleType").value==="manual"?"بند يدوي لا يخصم من المخزون.":"الكمية بالقطعة أو العبوة.";$("itemQuantity").step=$("saleType").value==="weight"?"0.001":"1";if($("saleType").value!=="weight")$("itemQuantity").value="1";};
$("itemForm").onsubmit=e=>{e.preventDefault();const name=$("itemName").value.trim(),quantity=Number($("itemQuantity").value),price=Number($("itemPrice").value),kind=$("saleType").value;if(!name||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(price)||price<0)return;add({name,kind,unit:kind==="weight"?"kg":"piece",quantity,unitPrice:price,stockQuantity:quantity});e.target.reset();$("itemQuantity").value="1";$("saleType").value="piece";};
$("manualButton").onclick=()=>{$("saleType").value="manual";$("itemName").focus();$("manualPanel").scrollIntoView({behavior:"smooth"});};
$("trackStock").onchange=()=>$("stockLabel").hidden=!$("trackStock").checked;
function resetProduct(){$("productForm").reset();$("productId").value="";$("stockLabel").hidden=true;$("productStock").value="0";}
$("resetProduct").onclick=resetProduct;
$("productForm").onsubmit=async e=>{e.preventDefault();const id=$("productId").value||uid(),barcode=$("productBarcode").value.trim(),p={id,name:$("productName").value.trim(),barcode,category:$("productCategory").value.trim(),unit:$("productUnit").value,price:Number($("productPrice").value),cost:Number($("productCost").value)||0,trackStock:$("trackStock").checked,stock:$("trackStock").checked?Number($("productStock").value)||0:null,updatedAt:new Date().toISOString()};if(!p.name||!Number.isFinite(p.price)||p.price<0)return alert("راجع الاسم والسعر.");try{if(barcode){
 const old=await POSDatabase.getProductByBarcode(barcode);
 if(old&&old.id!==id)return alert("الباركود مسجل للمنتج "+old.name);

}await POSDatabase.saveProduct(p);await load();resetProduct();alert("تم حفظ المنتج.");}catch(err){alert("تعذر الحفظ: "+err.message);}};
async function load(){
  const [items,settings]=await Promise.all([POSDatabase.getProducts(),POSDatabase.getSettings()]);
  products=items;shopSettings={...shopSettings,...settings};
  products.sort((a,b)=>a.name.localeCompare(b.name,"ar"));
  $("shopTitle").textContent=shopSettings.shopName||"كاشير المحل";
  renderQuick();renderProducts();renderCatalog();
}
function renderProducts(){const root=$("productList"),q=$("productSearch").value.trim().toLowerCase();root.replaceChildren();const list=products.filter(p=>p.name.toLowerCase().includes(q)||String(p.barcode||"").includes(q));if(!list.length){root.innerHTML='<p class="empty">لا توجد منتجات مسجلة.</p>';return;}list.forEach(p=>{const row=document.createElement("div");row.className="product-row";const info=document.createElement("div"),name=document.createElement("strong"),meta=document.createElement("small");name.textContent=p.name;meta.textContent=(p.barcode?"باركود "+p.barcode:"بدون باركود")+" · "+money(p.price)+(p.trackStock?" · رصيد "+p.stock+" "+unit(p.unit):" · دون مخزون");info.append(name,meta);const actions=document.createElement("div"),edit=document.createElement("button"),del=document.createElement("button");edit.className="secondary";edit.textContent="تعديل";edit.onclick=()=>{$("productId").value=p.id;$("productName").value=p.name;$("productBarcode").value=p.barcode||"";$("productCategory").value=p.category||"";$("productUnit").value=p.unit;$("productPrice").value=p.price;$("productCost").value=p.cost||"";$("trackStock").checked=!!p.trackStock;$("stockLabel").hidden=!p.trackStock;$("productStock").value=p.stock??0;$("productForm").scrollIntoView({behavior:"smooth"});};del.className="remove";del.textContent="حذف";del.onclick=async()=>{if(confirm("حذف المنتج؟ الفواتير السابقة لن تتغير.")){await POSDatabase.deleteProduct(p.id);await load();}};actions.append(edit,del);row.append(info,actions);root.append(row);});}
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
    await POSDatabase.saveProduct({id:uid(),name:item.name,barcode:"",category:item.category,unit:item.unit,price:Number(item.price),cost:0,trackStock:false,stock:null,updatedAt:new Date().toISOString()});
    await load();$("catalogMessage").textContent="تمت إضافة: "+item.name;
  }catch(error){alert("تعذرت إضافة المنتج: "+error.message);}
}
async function importCatalog(){
  const catalog=window.POS_CATALOG||[],existing=new Set(products.map(p=>catalogNameKey(p.name)));
  const pending=catalog.filter(p=>!existing.has(catalogNameKey(p.name)));
  if(!pending.length)return alert("كل منتجات الكتالوج موجودة بالفعل.");
  if(!confirm("سيتم إضافة "+pending.length+" منتجًا إلى قائمة منتجات المحل، مع تخطي الأصناف الموجودة. هل تريد المتابعة؟"))return;
  try{
    const now=new Date().toISOString(),batch=pending.map(item=>({id:uid(),name:item.name,barcode:"",category:item.category,unit:item.unit,price:Number(item.price),cost:0,trackStock:false,stock:null,updatedAt:now}));
    await POSDatabase.saveProducts(batch);await load();
    $("catalogMessage").textContent="تمت إضافة "+batch.length+" منتجًا. راجع الأسعار وعدّلها حسب أسعار محلك.";
    alert("تمت إضافة "+batch.length+" منتجًا إلى قائمة المحل.");
  }catch(error){alert("تعذرت إضافة الكتالوج: "+error.message);}
}
$("catalogSearch").oninput=renderCatalog;
$("catalogImportAll").onclick=importCatalog;
$("productSearch").oninput=renderProducts;

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
  html+='<div class="receipt-totals"><div><span>الإجمالي قبل الخصم</span><strong>'+escapeHtml(money(subtotal))+'</strong></div><div><span>الخصم</span><strong>'+escapeHtml(money(inv.discount||0))+'</strong></div><div class="receipt-grand"><span>المطلوب</span><strong>'+escapeHtml(money(inv.total||0))+'</strong></div></div>';
  html+='<p class="receipt-payment">طريقة الدفع: '+escapeHtml(paymentName(inv.paymentMethod))+'</p><footer>'+escapeHtml(shopSettings.receiptFooter||"شكراً لزيارتكم")+'</footer></article>';
  return html;
}
function receiptDocument(inv){
  const width=shopSettings.paperWidth==="A4"?"A4":Math.max(45,Number(shopSettings.paperWidth||80))+"mm auto";
  const style='@page{size:'+width+';margin:3mm}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:Tahoma,Arial,sans-serif}body{display:flex;justify-content:center;padding:3mm;font-size:10pt}.receipt-paper{max-width:100%;margin:0 auto;padding:2mm;font-size:9pt}.receipt-brand{text-align:center;border-bottom:1px dashed #777;padding-bottom:8px;margin-bottom:8px}.receipt-brand h2{font-size:16pt;margin:0 0 5px}.receipt-brand p{margin:3px 0;font-size:9pt}.receipt-meta{display:flex;justify-content:space-between;gap:8px;margin:8px 0}.receipt-meta div{display:flex;flex-direction:column;gap:3px}.receipt-meta span,.receipt-customer{font-size:8pt;color:#333}.receipt-customer{border-block:1px dashed #aaa;padding:6px 0;margin:6px 0}.receipt-customer span{display:block;margin-top:3px}.receipt-table{width:100%;border-collapse:collapse;font-size:8pt}.receipt-table th,.receipt-table td{padding:5px 2px;border-bottom:1px solid #ddd;text-align:right;vertical-align:top}.receipt-table th{background:#f1f1f1}.receipt-totals{margin-top:8px;border-top:1px dashed #777;padding-top:6px}.receipt-totals div{display:flex;justify-content:space-between;gap:8px;padding:3px 0}.receipt-grand{font-size:12pt;border-top:1px solid #333;margin-top:4px;padding-top:7px!important}.receipt-payment{font-size:9pt;margin:8px 0}.receipt-paper footer{text-align:center;border-top:1px dashed #777;padding-top:8px;margin-top:10px;font-weight:bold}';
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(invoiceNumber(inv))+'</title><style>'+style+'</style></head><body>'+receiptContent(inv)+'</body></html>';
}
function receiptMessage(inv){
  const lines=(inv.items||[]).map(item=>'• '+item.name+' — '+receiptQuantity(item)+' × '+money(item.unitPrice)+' = '+money(item.total));
  return [shopSettings.shopName||"فاتورة مبيعات",shopSettings.shopAddress||"",shopSettings.shopPhone?"هاتف: "+shopSettings.shopPhone:"",
    "فاتورة رقم: "+invoiceNumber(inv),"التاريخ: "+receiptDate(inv),inv.customerName?"العميل: "+inv.customerName:"",
    "--------------------",...lines,"--------------------",
    "الإجمالي قبل الخصم: "+money(inv.subtotal??(Number(inv.total||0)+Number(inv.discount||0))),
    "الخصم: "+money(inv.discount||0),"الإجمالي المطلوب: "+money(inv.total||0),
    "طريقة الدفع: "+paymentName(inv.paymentMethod),shopSettings.receiptFooter||"شكراً لزيارتكم"
  ].filter(Boolean).join("\n");
}
function showReceipt(inv){activeReceipt=inv;$("receiptPreview").innerHTML=receiptContent(inv);$("receiptModal").hidden=false;}
function closeReceipt(){$("receiptModal").hidden=true;activeReceipt=null;}
async function shareInvoice(inv){
  const message=receiptMessage(inv);
  if(window.AndroidScanner&&typeof window.AndroidScanner.shareText==="function"){window.AndroidScanner.shareText(message);return;}
  if(navigator.share){
    try{await navigator.share({title:"فاتورة "+invoiceNumber(inv),text:message});return;}
    catch(error){if(error&&error.name==="AbortError")return;}
  }
  const opened=window.open("https://wa.me/?text="+encodeURIComponent(message),"_blank","noopener");
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
    meta.textContent=receiptDate(inv)+" · "+(inv.items||[]).length+" صنف · "+paymentName(inv.paymentMethod)+(inv.customerName?" · "+inv.customerName:"");
    info.append(title,meta);
    const total=document.createElement("strong");total.textContent=money(inv.total);
    const actions=document.createElement("div");actions.className="invoice-actions";
    const detail=document.createElement("button");detail.className="secondary";detail.textContent="عرض";detail.onclick=()=>showReceipt(inv);
    const print=document.createElement("button");print.className="secondary";print.textContent="طباعة";print.onclick=()=>printInvoice(inv);
    const share=document.createElement("button");share.className="secondary";share.textContent="واتساب";share.onclick=()=>shareInvoice(inv);
    actions.append(detail,print,share);row.append(info,total,actions);root.append(row);
  });
}
$("checkoutButton").onclick=async()=>{
  if(!cart.length)return;
  const s=sub(),d=disc();if(d>s)return alert("الخصم أكبر من إجمالي الفاتورة.");
  const inv={id:uid(),createdAt:new Date().toISOString(),items:cart.map(x=>({...x})),
    subtotal:s,discount:d,total:Math.round((s-d)*100)/100,paymentMethod:$("paymentMethod").value,
    customerName:$("customerName").value.trim(),customerPhone:$("customerPhone").value.trim(),
    currency:"EGP",status:"saved"};
  try{
    await POSDatabase.saveInvoice(inv);
    cart.length=0;$("discount").value="0";$("customerName").value="";$("customerPhone").value="";
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