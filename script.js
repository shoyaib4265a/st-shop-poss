/* ========= Keys & helpers ========= */
const LS = {
  DEVICE: "st_device",
  SESSION: "st_session",
  DATA: "st_data" // {users, products, inventories, pending, deviceLogs}
};
const $  = (s,root=document)=>root.querySelector(s);
const $$ = (s,root=document)=>Array.from(root.querySelectorAll(s));

const ui = {
  net: $("#netStatus"), drive: $("#driveStatus"), btnSign: $("#btnSign"),
  login: $("#loginView"), appr: $("#approvalView"),
  cashier: $("#cashierView"), admin: $("#adminView"),
  who: $("#who"),
  inPhone: $("#loginPhone"), inPin: $("#loginPin"), btnLogin: $("#btnLogin"),
  reqCode: $("#reqCode"), btnSendReq: $("#btnSendReq"),
  myInv: $("#tblMyInv").querySelector("tbody"),
  salePid: $("#salePid"), saleQty: $("#saleQty"),
  btnSale: $("#btnSale"), btnSync: $("#btnSync"), btnLogout: $("#btnLogout"),
  nPhone: $("#nPhone"), nPin: $("#nPin"), nRole: $("#nRole"), btnCreate: $("#btnCreateUser"),
  prId: $("#prId"), prName: $("#prName"), prPrice: $("#prPrice"),
  btnAddProduct: $("#btnAddProduct"), tblProducts: $("#tblProducts").querySelector("tbody"),
  asPhone: $("#asPhone"), asProduct: $("#asProduct"), asQty: $("#asQty"),
  btnAssign: $("#btnAssign"),
  tblPending: $("#tblPending").querySelector("tbody"),
  tblStock: $("#tblStockOverview").querySelector("tbody"),
  tblDevices: $("#tblDevices").querySelector("tbody"),
};

const state = { tokenClient:null, accessToken:null, driveFileId:null };
const SCOPES = "https://www.googleapis.com/auth/drive.appdata";

/* ========= Theme + network ========= */
function setOnline(v){ ui.net.textContent = v?"Online":"Offline"; ui.net.classList.toggle("offline", !v); }
window.addEventListener("online", ()=>setOnline(true));
window.addEventListener("offline", ()=>setOnline(false));
setOnline(navigator.onLine);
function applyTheme(){
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
}
applyTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

/* ========= Device & data ========= */
function getDeviceId(){ let id = localStorage.getItem(LS.DEVICE); if(!id){ id = "dev_"+crypto.randomUUID(); localStorage.setItem(LS.DEVICE,id);} return id; }
function nowIso(){ return new Date().toISOString(); }

function loadData(){
  const d = JSON.parse(localStorage.getItem(LS.DATA)||"null");
  if(d) return d;
  const seed = {
    users: [{ phone:"Admin", pin:"1234", role:"admin", devices:[] }],
    products: [],
    inventories: [],   // [{cashier, items:[{id,qty}], updatedAt}]
    pending: [],       // [{phone,device,code}]
    deviceLogs: []     // [{phone,device,at}]
  };
  localStorage.setItem(LS.DATA, JSON.stringify(seed));
  return seed;
}
function saveData(d){ localStorage.setItem(LS.DATA, JSON.stringify(d)); }
function sessionSet(s){ localStorage.setItem(LS.SESSION, JSON.stringify(s)); }
function sessionGet(){ return JSON.parse(localStorage.getItem(LS.SESSION)||"null"); }
function sessionClear(){ localStorage.removeItem(LS.SESSION); }
function show(view){ [ui.login,ui.appr,ui.cashier,ui.admin].forEach(v=>v.classList.add("hide")); view.classList.remove("hide"); }

/* ========= Google API ========= */
gapi.load("client", async ()=>{ await gapi.client.init({}); });

function ensureToken(){
  return new Promise((resolve,reject)=>{
    if(state.accessToken) return resolve(state.accessToken);
    if(!state.tokenClient){
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: window.CLIENT_ID,
        scope: SCOPES,
        callback: (resp)=>{
          if(resp && resp.access_token){
            state.accessToken = resp.access_token;
            gapi.client.setToken({access_token:resp.access_token});
            ui.drive.textContent = "Drive: Ready";
            resolve(resp.access_token);
          } else reject(new Error("No token"));
        }
      });
    }
    state.tokenClient.requestAccessToken({prompt:"consent"});
  });
}
async function driveEnsureFile(){
  const r = await gapi.client.request({ path:"https://www.googleapis.com/drive/v3/files", method:"GET",
    params:{spaces:"appDataFolder", q:"name='stshop-pos.json'", fields:"files(id)"}});
  if(r.result.files?.length){ state.driveFileId = r.result.files[0].id; return; }
  const meta = await gapi.client.request({ path:"https://www.googleapis.com/drive/v3/files", method:"POST",
    body:JSON.stringify({name:"stshop-pos.json",parents:["appDataFolder"],mimeType:"application/json"}),
    headers:{"Content-Type":"application/json"}});
  state.driveFileId = meta.result.id; await driveUpload();
}
async function driveDownload(){
  await ensureToken(); await driveEnsureFile();
  const res = await gapi.client.request({ path:`https://www.googleapis.com/drive/v3/files/${state.driveFileId}`, method:"GET", params:{alt:"media"} });
  return res.result || {};
}
async function driveUpload(){
  await ensureToken(); await driveEnsureFile();
  const body = JSON.stringify(loadData());
  await gapi.client.request({ path:`https://www.googleapis.com/upload/drive/v3/files/${state.driveFileId}`, method:"PATCH",
    params:{uploadType:"media"}, headers:{"Content-Type":"application/json"}, body });
  ui.drive.textContent = "Drive: Synced";
}
function uniqueBy(arr, key){ const m=new Map(); for(const x of arr) m.set(key(x), {...m.get(key(x)), ...x}); return [...m.values()]; }
async function syncNow(){
  try{
    const remote = await driveDownload();
    const local  = loadData();
    const merged = {
      users:       uniqueBy([...(remote.users||[]), ...(local.users||[])], x=>x.phone),
      products:    uniqueBy([...(remote.products||[]), ...(local.products||[])], x=>x.id),
      inventories: uniqueBy([...(remote.inventories||[]), ...(local.inventories||[])], x=>x.cashier),
      pending:     uniqueBy([...(remote.pending||[]), ...(local.pending||[])], x=>x.code),
      deviceLogs:  [...(remote.deviceLogs||[]), ...(local.deviceLogs||[])].slice(-500)
    };
    saveData(merged); await driveUpload(); renderAll();
  }catch(e){ console.error(e); ui.drive.textContent="Drive: Error"; }
}

/* ========= Auth / Approval (single device enforced) ========= */
function loginLocal(phone, pin){
  const d = loadData();
  const user = d.users.find(u=>u.phone===phone && u.pin===pin);
  if(!user) return {ok:false, msg:"Invalid credentials"};

  const dev = getDeviceId();
  if(user.role!=="admin"){
    user.devices ||= [];
    // if already bound to another device, require approval for new one
    if(user.devices.length && user.devices[0] !== dev){
      const code = (Math.random().toString(36).slice(2,8)).toUpperCase();
      d.pending.push({ phone:user.phone, device:dev, code });
      saveData(d);
      sessionSet({ phone:user.phone, role:user.role, approved:false });
      return { ok:false, pending:true, code };
    }
    if(!user.devices.length){
      const code = (Math.random().toString(36).slice(2,8)).toUpperCase();
      d.pending.push({ phone:user.phone, device:dev, code });
      saveData(d);
      sessionSet({ phone:user.phone, role:user.role, approved:false });
      return { ok:false, pending:true, code };
    }
  }

  d.deviceLogs.push({ phone:user.phone, device:dev, at:new Date().toISOString() });
  saveData(d);
  sessionSet({ phone:user.phone, role:user.role, approved:true });
  return { ok:true, role:user.role };
}

function approveDevice(code){
  const d = loadData();
  const p = d.pending.find(x=>x.code===code);
  if(!p) return false;
  const u = d.users.find(x=>x.phone===p.phone);
  if(!u) return false;
  // single-device policy: bind ONLY this device, drop others
  u.devices = [p.device];
  d.pending = d.pending.filter(x=>x.code!==code);
  saveData(d);
  return true;
}

/* ========= Admin actions ========= */
function upsertProduct(id, name, price){
  const d = loadData();
  const i = d.products.findIndex(p=>p.id===id);
  const row = { id, name, price:Number(price||0) };
  if(i>=0) d.products[i]=row; else d.products.push(row);
  saveData(d);
}
function createOrUpdateUser(phone, pin, role){
  const d = loadData();
  const exists = d.users.find(u=>u.phone===phone);
  // enforce: one cashier per phone (no duplicates)
  if(!exists){
    d.users.push({ phone, pin, role, devices:[] });
    if(role==="cashier"){
      const inv = d.inventories.find(x=>x.cashier===phone);
      if(!inv) d.inventories.push({ cashier:phone, items:[], updatedAt:new Date().toISOString() });
    }
  }else{
    // if existing is cashier and trying to create another cashier with same phone, just update PIN/role
    exists.pin = pin; exists.role = role; exists.devices ||= [];
    if(role==="cashier"){
      const inv = d.inventories.find(x=>x.cashier===phone);
      if(!inv) d.inventories.push({ cashier:phone, items:[], updatedAt:new Date().toISOString() });
    }
  }
  saveData(d);
}
function assignStock(phone, pid, qty){
  qty = parseInt(qty||"0",10); if(!phone||!pid||!qty) return;
  const d = loadData();
  let inv = d.inventories.find(x=>x.cashier===phone);
  if(!inv){ inv = { cashier:phone, items:[], updatedAt:new Date().toISOString() }; d.inventories.push(inv); }
  const row = inv.items.find(x=>x.id===pid);
  if(row) row.qty = (row.qty||0) + qty; else inv.items.push({id:pid, qty});
  inv.updatedAt = new Date().toISOString();
  saveData(d);
}

/* ========= Cashier actions ========= */
function recordSale(mePhone, pid, qty){
  qty = parseInt(qty||"0",10);
  if(!pid || !qty) return false;
  const d = loadData();
  const inv = d.inventories.find(x=>x.cashier===mePhone);
  if(!inv) return false;
  const row = inv.items.find(x=>x.id===pid);
  if(!row || row.qty<qty) return false;
  row.qty -= qty; inv.updatedAt = new Date().toISOString();
  saveData(d); return true;
}

/* ========= Renderers ========= */
function nameOf(pid){ const p=loadData().products.find(x=>x.id===pid); return p?p.name:pid; }

function renderProducts(){
  const d = loadData();
  ui.tblProducts.innerHTML = d.products.map(p=>`<tr><td>${p.id}</td><td>${p.name||""}</td><td>${(p.price??0).toFixed?.(2)??p.price||0}</td></tr>`).join("");
}
function renderPending(){
  const d = loadData();
  ui.tblPending.innerHTML = d.pending.map(p=>`<tr><td>${p.phone}</td><td>${p.device}</td><td>${p.code}</td><td><button class="btn" data-code="${p.code}">Approve</button></td></tr>`).join("");
  $$("#tblPending [data-code]").forEach(b=>{
    b.onclick = async ()=>{
      const ok = approveDevice(b.getAttribute("data-code"));
      if(ok){ renderPending(); await driveUpload(); alert("Approved"); } else alert("Invalid code");
    };
  });
}
function renderStockOverview(){
  const d = loadData();
  ui.tblStock.innerHTML = d.inventories.flatMap(inv =>
    inv.items.map(it=>`<tr><td>${inv.cashier}</td><td>${nameOf(it.id)}</td><td>${it.qty||0}</td></tr>`)
  ).join("");
}
function renderDevices(){
  const d = loadData();
  ui.tblDevices.innerHTML = d.deviceLogs.slice(-100).reverse().map(v =>
    `<tr><td>${v.phone}</td><td>${v.device}</td><td>${new Date(v.at).toLocaleString()}</td>
     <td><button class="btn danger" data-revoke="${v.phone}|${v.device}">Revoke</button></td></tr>`
  ).join("");
  $$("#tblDevices [data-revoke]").forEach(btn=>{
    btn.onclick = async ()=>{
      const [phone,dev] = btn.getAttribute("data-revoke").split("|");
      const dta = loadData(); const u=dta.users.find(x=>x.phone===phone); if(!u) return;
      u.devices = (u.devices||[]).filter(x=>x!==dev); saveData(dta); await driveUpload(); alert("Revoked");
    };
  });
}
function renderMyInventory(mePhone){
  const d = loadData();
  const inv = d.inventories.find(x=>x.cashier===mePhone);
  ui.myInv.innerHTML = (inv?.items||[]).map(it=>`<tr><td>${it.id}</td><td>${nameOf(it.id)}</td><td>${it.qty||0}</td></tr>`).join("");
}
function renderAll(){
  renderProducts(); renderPending(); renderStockOverview(); renderDevices();
  const s = sessionGet(); if(s?.approved && s.role==="cashier") renderMyInventory(s.phone);
}

/* ========= Wiring ========= */
$("#btnSign").onclick = async ()=>{ try{ await ensureToken(); await driveEnsureFile(); }catch(e){ console.error(e); } };

ui.btnLogin.onclick = async ()=>{
  const r = loginLocal(ui.inPhone.value.trim(), ui.inPin.value.trim());
  if(r.ok){
    ui.who && (ui.who.textContent = `${ui.inPhone.value.trim()} (${r.role})`);
    show(r.role==="admin" ? ui.admin : ui.cashier);
    renderAll(); await syncNow();
  }else if(r.pending){
    ui.reqCode.value = r.code; show(ui.appr);
  }else alert(r.msg||"Login failed");
};

ui.btnSendReq.onclick = async ()=>{ await driveUpload(); alert("Request sent"); };

ui.btnCreate.onclick = async ()=>{
  const phone=ui.nPhone.value.trim(), pin=ui.nPin.value.trim(), role=ui.nRole.value;
  if(!phone||!pin) return alert("Phone & PIN required");
  createOrUpdateUser(phone, pin, role);
  await driveUpload(); renderAll(); alert("User saved");
};
ui.btnAddProduct.onclick = async ()=>{
  const id=ui.prId.value.trim(); if(!id) return alert("Product ID required");
  upsertProduct(id, ui.prName.value.trim(), ui.prPrice.value.trim());
  await driveUpload(); renderProducts(); ui.prId.value=ui.prName.value=ui.prPrice.value="";
};
ui.btnAssign.onclick = async ()=>{
  assignStock(ui.asPhone.value.trim(), ui.asProduct.value.trim(), ui.asQty.value.trim());
  await driveUpload(); renderAll();
};
ui.btnSale.onclick = async ()=>{
  const s = sessionGet(); if(!s?.approved) return;
  const ok = recordSale(s.phone, ui.salePid.value.trim(), ui.saleQty.value.trim());
  if(!ok) return alert("Not enough stock / wrong ID");
  await driveUpload(); renderMyInventory(s.phone); ui.salePid.value=""; ui.saleQty.value="1";
};
ui.btnSync.onclick = ()=>syncNow();
ui.btnLogout.onclick = ()=>{ sessionClear(); show(ui.login); };

/* ========= Boot ========= */
(function boot(){
  const s = sessionGet();
  if(s?.approved){ ui.who && (ui.who.textContent=`${s.phone} (${s.role})`); show(s.role==="admin"?ui.admin:ui.cashier); renderAll(); syncNow(); }
  else show(ui.login);
})();
