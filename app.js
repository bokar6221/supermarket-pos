const cart=[];
const money=value=>Number(value||0).toLocaleString("ar-EG",{minimumFractionDigits:2,maximumFractionDigits:2})+" ج.م";
const $=id=>document.getElementById(id);
function renderCart(){
  $("cartCount").textContent=cart.length+" صنف";
  $("grandTotal").textContent=money(cart.reduce((sum,item)=>sum+item.total,0));
  $("checkoutButton").disabled=cart.length===0;
  $("cartItems").innerHTML="";
  if(!cart.length){$("cartItems").innerHTML='<p class="empty">لم تتم إضافة أصناف بعد</p>';return}
  cart.forEach((item,index)=>{
    const row=document.createElement("div");
    row.className="cart-item";
    const details=document.createElement("div");
    const name=document.createElement("strong");name.textContent=item.name;
    const meta=document.createElement("small");meta.textContent=item.quantity+" × "+money(item.unitPrice);
    details.append(name,meta);
    const side=document.createElement("div");
    const amount=document.createElement("strong");amount.textContent=money(item.total);
    const remove=document.createElement("button");remove.className="remove";remove.type="button";remove.textContent="حذف";
    remove.addEventListener("click",()=>{cart.splice(index,1);renderCart()});
    side.append(amount,remove);row.append(details,side);$("cartItems").append(row);
  });
}
$("saleType").addEventListener("change",()=>{
  $("unitHint").textContent=$("saleType").value==="weight"?"أدخل الوزن بالكيلوجرام؛ مثال 0.250 يعني 250 جرام.":"الكمية بالقطعة أو العبوة.";
  $("itemQuantity").step=$("saleType").value==="weight"?"0.001":"1";
  if($("saleType").value!=="weight")$("itemQuantity").value="1";
});
$("itemForm").addEventListener("submit",event=>{
  event.preventDefault();
  const name=$("itemName").value.trim();
  const quantity=Number($("itemQuantity").value);
  const unitPrice=Number($("itemPrice").value);
  if(!name||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitPrice)||unitPrice<0)return;
  cart.push({name,kind:$("saleType").value,quantity,unitPrice,total:Math.round(quantity*unitPrice*100)/100});
  $("itemName").value="";$("itemQuantity").value="1";$("itemPrice").value="";
  renderCart();
});
$("manualButton").addEventListener("click",()=>{$("saleType").value="manual";$("itemName").focus();$("unitHint").textContent="أدخل اسم البند والسعر والكمية يدوياً."});
$("scanButton").addEventListener("click",()=>{$("scannerArea").hidden=false;$("scannerMessage").textContent="قارئ الكاميرا لم يُفعّل بعد. سنضيف مكتبة مسح محلية بعد اختبارها على هاتف Android."});
$("closeScanner").addEventListener("click",()=>{$("scannerArea").hidden=true});
$("checkoutButton").addEventListener("click",async()=>{
  if(!cart.length)return;
  const invoice={id:crypto.randomUUID(),createdAt:new Date().toISOString(),items:cart.map(item=>({...item})),total:Math.round(cart.reduce((s,item)=>s+item.total,0)*100)/100,currency:"EGP",status:"saved"};
  try{
    await POSDatabase.addInvoice(invoice);
    alert("تم حفظ الفاتورة محلياً. هذه نسخة اختبارية وليست فاتورة ضريبية.");
    cart.length=0;renderCart();
  }catch(error){alert("تعذر حفظ الفاتورة: "+error.message)}
});
if("serviceWorker" in navigator && location.protocol!=="file:"){
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}
renderCart();