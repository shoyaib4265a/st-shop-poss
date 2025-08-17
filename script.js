/* ===== Storage & helpers ===== */
const LS = { DEVICE:"st_device", SESSION:"st_session", DATA:"st_data" };
const $  = (s,root=document)=>root.querySelector(s);
const $$ = (s,root=document)=>Array.from(root.querySelectorAll(s));

const ui = {
  login: $("#loginView"), appr: $("#approvalView"),
  cashier: $("#cashierView"), admin: $("#adminView"),
  who: $("#who"), net: $("#netStatus"), drive: $("#driveStatus"),
  btnSign: $("#btnSign"),
  inPhone: $("#loginPhone"), inPin: $("#loginPin"),
  btnLocal: $("#btnLoginLocal"),
  reqCode: $("#reqCode"), btnSendReq: $("#btnSendReq"),
  nPhone: $("#nPhone"), nPin: $("#nPin"), nRole: $("#nRole"),
  btnCreate: $("#btnCreateUser"),
  pId: $("#pId"), pName: $("#pName"), pPrice: $("#pPrice"), pStock: $("#pStock"), pCode: $("#pCode"),
  btnAdd: $("#btnAdd"), btnSync: $("#btnSync"), btnLogout: $("#btnLogout"),
  tblProducts: $("#tblProducts tbody"), tblPending: $("#tblPending tbody")
};

const state = { tokenClient:null, gReady:false, accessToken:null, driveFileId:null };
const SCOPES = "https://www.googleapis.com/auth/drive.appdata";

/* Device ID */
function getDeviceId(){
  let id = localStorage.getItem(LS.DEVICE);
  if(!id){ id = "dev_" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)); localStorage.setItem(LS.DEVICE,id); }
  return id;
}

/* Data init */
function loadData(){
  const d = JSON.parse(localStorage.getItem(LS.DATA) || "null");
  if (d) return d;
  const seed = { users:[], products:[], pending:[] };
  seed.users.push({ phone:"Admin", pin:"1234", role:"admin", devices:[] });
  localStorage.setItem(LS.DATA, JSON.stringify(seed));
  return seed;
}
function saveData(d){ localStorage.setItem(LS.DATA, JSON.stringify(d)); }
function sessionSet(s){ localStorage.setItem(LS.SESSION, JSON.stringify(s)); }
function sessionGet(){ return JSON.parse(localStorage.getItem(LS.SESSION) || "null"); }
function sessionClear(){ localStorage.removeItem(LS.SESSION); }

/* UI */
function show(v){
  [ui.login,ui.appr,ui.cashier,ui.admin].forEach(x=>x && x.classList.add("hide"));
  v && v.classList.remove("hide");
}
function setOnline(ok){
  if(!ui.net) return;
  ui.net.textContent = ok ? "Online" : "Offline";
  ui.net.classList.toggle("offline", !ok);
}
window.addEventListener("online", ()=>setOnline(true));
window.addEventListener("offline",()=>setOnline(false));
setOnline(navigator.onLine);

/* Theme (auto) */
function applyTheme(){
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
}
applyTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

/* ===== Google API bootstrap ===== */
gapi.load("client", async ()=>{ await gapi.client.init({}); state.gReady = true; });

function ensureToken(){
  return new Promise((resolve,reject)=>{
    if (state.accessToken) return resolve(state.accessToken);
    if (!state.tokenClient){
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: window.CLIENT_ID, scope: SCOPES,
        callback: (resp)=>{
          if (resp && resp.access_token){
            state.accessToken = resp.access_token;
            gapi.client.setToken({ access_token: resp.access_token });
            if (ui.drive) ui.drive.textContent = "Drive: Auth";
            resolve(resp.access_token);
          } else reject(new Error("No token"));
        }
      });
    }
    state.tokenClient.requestAccessToken({ prompt:"consent" });
  });
}

async function driveEnsureFile(){
  const res = await gapi.client.request({
    path:"https://www.googleapis.com/drive/v3/files", method:"GET",
    params:{ spaces:"appDataFolder", q:"name='stshop-pos.json'", fields:"files(id,name)" }
  });
  if (res.result.files && res.result.files.length){
    state.driveFileId = res.result.files[0].id; return state.driveFileId;
  }
  const meta = await gapi.client.request({
    path:"https://www.googleapis.com/drive/v3/files", method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ name:"stshop-pos.json", parents:["appDataFolder"], mimeType:"application/json" })
  });
  state.driveFileId = meta.result.id;
  await driveUpload();
  return state.driveFileId;
}

async function driveDownload(){
  await ensureToken(); await driveEnsureFile();
  const res = await gapi.client.request({
    path:`https://www.googleapis.com/drive/v3/files/${state.driveFileId}`, method:"GET", params:{ alt:"media" }
  });
  return res.result || {};
}

async function driveUpload(){
  await ensureToken(); await driveEnsureFile();
  const body = JSON.stringify(loadData());
  await gapi.client.request({
    path:`https://www.googleapis.com/upload/drive/v3/files/${state.driveFileId}`,
    method:"PATCH", params:{ uploadType:"media" }, headers:{ "Content-Type":"application/json" }, body
  });
  if (ui.drive) ui.drive.textContent = "Drive: Synced";
}

function uniqueBy(arr, key){
  const m = new Map(); for (const x of arr) m.set(x[key], { ...m.get(x[key]), ...x }); return Array.from(m.values());
}
async function syncNow(){
  try{
    const remote = await driveDownload();
    const local  = loadData();
    const merged = {
      users   : uniqueBy([...(remote.users||[]), ...(local.users||[])], "phone"),
      products: uniqueBy([...(remote.products||[]), ...(local.products||[])], "id"),
      pending : uniqueBy([...(remote.pending||[]),  ...(local.pending||[]) ], "code")
    };
    saveData(merged); await driveUpload();
  }catch(e){ console.error(e); if (ui.drive) ui.drive.textContent = "Drive: Error"; }
}

/* ===== Auth + Roles + Device Approval ===== */
function loginLocal(phone,pin){
  const d = loadData();
  const user = d.users.find(u=>u.phone===phone && u.pin===pin);
  if (!user) return { ok:false, msg:"Invalid credentials" };
  const dev = getDeviceId();
  if (user.role!=="admin"){
    user.devices = user.devices || [];
    if (!user.devices.includes(dev)){
      const code = (Math.random().toString(36).slice(2,8)).toUpperCase();
      d.pending.push({ phone:user.phone, device:dev, code });
      saveData(d);
      sessionSet({ phone:user.phone, role:user.role, approved:false });
      return { ok:false, pending:true, code };
    }
  }
  sessionSet({ phone:user.phone, role:user.role, approved:true });
  return { ok:true, role:user.role };
}

function approveDevice(code){
  const d = loadData();
  const p = d.pending.find(x=>x.code===code); if (!p) return false;
  const u = d.users.find(x=>x.phone===p.phone); if (!u) return false;
  u.devices = u.devices || [];
  if (!u.devices.includes(p.device)) u.devices.push(p.device);
  d.pending = d.pending.filter(x=>x.code!==code);
  saveData(d); return true;
}

/* ===== Admin/Cashier actions ===== */
function renderProducts(){
  const d = loadData();
  ui.tblProducts.innerHTML = d.products.map(x =>
    `<tr><td>${x.id}</td><td>${x.name||""}</td><td>${x.price||0}</td><td>${x.stock||0}</td><td>${x.barcode||""}</td></tr>`
  ).join("");
}
function renderPending(){
  const d = loadData();
  ui.tblPending.innerHTML = d.pending.map(x =>
    `<tr><td>${x.phone}</td><td>${x.device}</td><td>${x.code}</td><td><button data-code="${x.code}" class="approve">Approve</button></td></tr>`
  ).join("");
  $$("#tblPending .approve").forEach(btn=>{
    btn.addEventListener("click", async e=>{
      const code = e.currentTarget.getAttribute("data-code");
      if (approveDevice(code)){ renderPending(); await driveUpload(); alert("Approved"); }
      else alert("Invalid code");
    });
  });
}

/* ===== Wiring ===== */
ui.btnLocal?.addEventListener("click", async ()=>{
  const phone = (ui.inPhone.value||"").trim();
  const pin   = (ui.inPin.value||"").trim();
  const r = loginLocal(phone, pin);
  if (r.ok){
    if (ui.who) ui.who.textContent = `${phone} (${r.role})`;
    show(r.role==="admin" ? ui.admin : ui.cashier);
    renderProducts(); renderPending(); await syncNow();
  }else if (r.pending){
    ui.reqCode.value = r.code; show(ui.appr);
  }else{
    alert(r.msg || "Login failed");
  }
});

ui.btnSendReq?.addEventListener("click", async ()=>{ await driveUpload(); alert("Request sent"); });

ui.btnCreate?.addEventListener("click", async ()=>{
  const phone = (ui.nPhone.value||"").trim();
  const pin   = (ui.nPin.value||"").trim();
  const role  = ui.nRole.value;
  if (!phone || !pin) return alert("Phone & PIN required");
  const d = loadData();
  const i = d.users.findIndex(u=>u.phone===phone);
  const devs = i>=0 ? (d.users[i].devices||[]) : [];
  d.users[i>=0?i:d.users.length] = { phone, pin, role, devices:devs };
  saveData(d); await driveUpload(); renderPending(); alert("User saved");
  ui.nPhone.value = ui.nPin.value = "";
});

ui.btnAdd?.addEventListener("click", async ()=>{
  const id = (ui.pId.value||"").trim(); if (!id) return alert("Product ID required");
  const d = loadData();
  const i = d.products.findIndex(p=>p.id===id);
  const item = {
    id,
    name: ui.pName.value||"",
    price: Math.max(0, parseFloat(ui.pPrice.value||"0") || 0),
    stock: Math.max(0, parseInt(ui.pStock.value||"0") || 0),
    barcode: ui.pCode.value||""
  };
  d.products[i>=0?i:d.products.length] = item;
  saveData(d); renderProducts(); await driveUpload();
  ui.pId.value = ui.pName.value = ui.pPrice.value = ui.pStock.value = ui.pCode.value = "";
});

ui.btnLogout?.addEventListener("click", ()=>{ sessionClear(); show(ui.login); });

ui.btnSign?.addEventListener("click", async ()=>{
  try{ await ensureToken(); await driveEnsureFile(); ui.drive && (ui.drive.textContent = "Drive: Ready"); }
  catch(e){ console.error(e); ui.drive && (ui.drive.textContent = "Drive: Error"); }
});

ui.btnSync?.addEventListener("click", ()=>syncNow());

/* Resume session */
(function boot(){
  const s = sessionGet();
  if (s && s.approved){
    if (ui.who) ui.who.textContent = `${s.phone} (${s.role})`;
    show(s.role==="admin" ? ui.admin : ui.cashier);
    renderProducts(); renderPending(); syncNow();
  }else{
    show(ui.login);
  }
})();
