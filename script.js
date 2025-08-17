/* ======= Minimal Secure POS + Google Drive Sync ======= */

/* ---- Storage Keys & Helpers ---- */
const LS = {
  DEVICE:  "st_device",
  SESSION: "st_session",
  DATA:    "st_data" // {users:[], products:[], pending:[{phone,device,code}]}
};
const $  = (s,root=document)=>root.querySelector(s);
const $$ = (s,root=document)=>Array.from(root.querySelectorAll(s));

const ui = {
  // badges
  net: $("#netStatus"),
  drive: $("#driveStatus"),
  btnSign: $("#btnSign"),

  // sections
  login: $("#loginView"),
  appr:  $("#approvalView"),
  cashier: $("#cashierView"),
  admin: $("#adminView"),

  // login
  inPhone: $("#loginPhone"),
  inPin: $("#loginPin"),
  btnLogin: $("#btnLoginLocal"),
  btnBackLogin: $("#btnBackLogin"),

  // approval
  reqCode: $("#reqCode"),
  btnSendReq: $("#btnSendReq"),

  // cashier
  who: $("#who"),
  pId: $("#pId"), pName: $("#pName"), pPrice: $("#pPrice"),
  pStock: $("#pStock"), pCode: $("#pCode"),
  btnAdd: $("#btnAdd"), btnSync: $("#btnSync"), btnLogout: $("#btnLogout"),
  tblProducts: $("#tblProducts"),

  // admin
  nPhone: $("#nPhone"), nPin: $("#nPin"), nRole: $("#nRole"),
  btnCreate: $("#btnCreateUser"), btnSyncAdmin: $("#btnSyncAdmin"), btnLogoutAdmin: $("#btnLogoutAdmin"),
  tblPending: $("#tblPending"),
  mPhone: $("#mPhone"), btnLoadDevices: $("#btnLoadDevices"), btnRevokeAll: $("#btnRevokeAll"),
  deviceList: $("#deviceList"),
};

const state = {
  tokenClient: null,
  accessToken: null,
  driveFileId: null
};

const SCOPES = "https://www.googleapis.com/auth/drive.appdata";

/* ---- Device Fingerprint ---- */
function getDeviceId(){
  let id = localStorage.getItem(LS.DEVICE);
  if(!id){ id = "dev_" + crypto.randomUUID(); localStorage.setItem(LS.DEVICE,id); }
  return id;
}

/* ---- Data shape & init ---- */
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

/* ---- UI helpers ---- */
function show(view){
  [ui.login,ui.appr,ui.cashier,ui.admin].forEach(v=>v && v.classList.add("hide"));
  view && view.classList.remove("hide");
}
function setOnline(v){
  if (!ui.net) return;
  ui.net.textContent = v? "Online" : "Offline";
  ui.net.classList.toggle("offline", !v);
}
window.addEventListener("online",  ()=>setOnline(true));
window.addEventListener("offline", ()=>setOnline(false));
setOnline(navigator.onLine);

/* ===== Theme: follow system ===== */
function applyTheme(){
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
}
applyTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

/* ================= Google API bootstrap ================= */
gapi.load("client", async ()=>{
  await gapi.client.init({});
});

function ensureToken(){
  return new Promise((resolve,reject)=>{
    if (state.accessToken) return resolve(state.accessToken);

    if (!state.tokenClient){
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: window.CLIENT_ID,
        scope: SCOPES,
        callback: (resp)=>{
          if (resp && resp.access_token){
            state.accessToken = resp.access_token;
            gapi.client.setToken({ access_token: resp.access_token });
            if (ui.drive) ui.drive.textContent = "Drive: Ready";
            resolve(resp.access_token);
          } else reject(new Error("No token"));
        }
      });
    }
    state.tokenClient.requestAccessToken({ prompt: "consent" });
  });
}

async function driveEnsureFile(){
  const res = await gapi.client.request({
    path: "https://www.googleapis.com/drive/v3/files",
    method: "GET",
    params: { spaces:"appDataFolder", q:"name='stshop-pos.json'", fields:"files(id,name)" }
  });
  if (res.result.files && res.result.files.length){
    state.driveFileId = res.result.files[0].id;
    return state.driveFileId;
  }
  // create with current local data
  const meta = await gapi.client.request({
    path: "https://www.googleapis.com/drive/v3/files",
    method: "POST",
    body: JSON.stringify({ name:"stshop-pos.json", parents:["appDataFolder"], mimeType:"application/json" }),
    headers: { "Content-Type":"application/json" }
  });
  state.driveFileId = meta.result.id;
  await driveUpload();
  return state.driveFileId;
}

async function driveDownload(){
  await ensureToken();
  await driveEnsureFile();
  const res = await gapi.client.request({
    path: `https://www.googleapis.com/drive/v3/files/${state.driveFileId}`,
    method: "GET",
    params: { alt:"media" }
  });
  return res.result || {};
}

async function driveUpload(){
  await ensureToken();
  await driveEnsureFile();
  const body = JSON.stringify(loadData());
  await gapi.client.request({
    path: `https://www.googleapis.com/upload/drive/v3/files/${state.driveFileId}`,
    method: "PATCH",
    params: { uploadType:"media" },
    headers: { "Content-Type":"application/json" },
    body
  });
  ui.drive && (ui.drive.textContent = "Drive: Synced");
}

function uniqueBy(arr, key){
  const m = new Map();
  for (const x of arr) m.set(x[key], { ...m.get(x[key]), ...x });
  return Array.from(m.values());
}

async function syncNow(){
  try{
    const remote = await driveDownload();   // {}
    const local  = loadData();
    const merged = {
      users   : uniqueBy([...(remote.users||[]), ...(local.users||[])], "phone"),
      products: uniqueBy([...(remote.products||[]), ...(local.products||[])], "id"),
      pending : uniqueBy([...(remote.pending||[]), ...(local.pending||[])], "code")
    };
    saveData(merged);
    await driveUpload();
    renderProducts();
    renderPending();
  }catch(e){
    console.error(e);
    ui.drive && (ui.drive.textContent = "Drive: Error");
  }
}

/* ================= Auth + Roles + Device Approval ================= */
function cleanPhone(p){ return (p||"").replace(/\s+/g,""); }

function loginLocal(rawPhone, pin){
  const phone = cleanPhone(rawPhone);
  const d = loadData();
  const user = d.users.find(u=>u.phone===phone && u.pin===pin);
  if (!user) return { ok:false, msg:"Invalid credentials" };

  // Auto-approve any pending codes for this device if admin logs in
  if (user.role==="admin"){
    const dev = getDeviceId();
    const toApprove = d.pending.filter(x=>x.device===dev);
    if (toApprove.length){
      toApprove.forEach(p=>{
        const u = d.users.find(xx=>xx.phone===p.phone);
        if (!u) return;
        u.devices = u.devices || [];
        if (!u.devices.includes(p.device)) u.devices.push(p.device);
      });
      d.pending = d.pending.filter(x=>x.device!==dev);
      saveData(d);
    }
    sessionSet({ phone:user.phone, role:user.role, approved:true });
    return { ok:true, role:user.role, phone:user.phone };
  }

  // cashier device check
  const dev = getDeviceId();
  user.devices = user.devices || [];
  if (!user.devices.includes(dev)){
    const code = (Math.random().toString(36).slice(2,8)).toUpperCase();
    d.pending.push({ phone:user.phone, device:dev, code });
    saveData(d);
    sessionSet({ phone:user.phone, role:user.role, approved:false });
    return { ok:false, pending:true, code };
  }

  sessionSet({ phone:user.phone, role:user.role, approved:true });
  return { ok:true, role:user.role, phone:user.phone };
}

function approveDevice(code){
  const d = loadData();
  const p = d.pending.find(x=>x.code===code);
  if (!p) return false;
  const u = d.users.find(x=>x.phone===p.phone);
  if (!u) return false;
  u.devices = u.devices || [];
  if (!u.devices.includes(p.device)) u.devices.push(p.device);
  d.pending = d.pending.filter(x=>x.code!==code);
  saveData(d);
  return true;
}

/* ================= Admin/Cashier actions ================= */
function renderProducts(){
  const d = loadData();
  ui.tblProducts.innerHTML = d.products.map(x =>
    `<tr><td>${x.id}</td><td>${x.name||""}</td><td>${Number(x.price||0).toFixed(2)}</td><td>${x.stock||0}</td><td>${x.barcode||""}</td></tr>`
  ).join("");
}
function renderPending(){
  const d = loadData();
  ui.tblPending.innerHTML = (d.pending||[]).map(x =>
    `<tr><td>${x.phone}</td><td>${x.device}</td><td>${x.code}</td>
      <td><button class="btn" data-code="${x.code}">Approve</button></td></tr>`
  ).join("");
  $$("#tblPending button").forEach(btn=>{
    btn.addEventListener("click", async e=>{
      const code = e.currentTarget.getAttribute("data-code");
      if (approveDevice(code)){
        renderPending(); await driveUpload(); alert("Approved");
      } else alert("Invalid code");
    });
  });
}
function loadDeviceList(){
  const phone = cleanPhone(ui.mPhone.value);
  const d = loadData();
  const u = d.users.find(x=>x.phone===phone);
  ui.deviceList.innerHTML = u && u.devices && u.devices.length ? "" : `<tr><td colspan="2">No devices</td></tr>`;
  (u?.devices||[]).forEach(dev=>{
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${dev}</td><td><button class="btn danger">Revoke</button></td>`;
    tr.querySelector("button").addEventListener("click", async ()=>{
      u.devices = (u.devices||[]).filter(x=>x!==dev);
      saveData(d); loadDeviceList(); await driveUpload();
    });
    ui.deviceList.appendChild(tr);
  });
}

/* ================== Wiring ================== */
ui.btnLogin?.addEventListener("click", async ()=>{
  const phone = ui.inPhone.value.trim();
  const pin   = ui.inPin.value.trim();
  const r = loginLocal(phone, pin);
  if (r.ok){
    ui.who && (ui.who.textContent = `${r.phone} (${r.role})`);
    show(r.role==="admin" ? ui.admin : ui.cashier);
    renderProducts(); renderPending();
    await syncNow();
  }else if (r.pending){
    ui.reqCode.value = r.code;
    show(ui.appr);
  }else{
    alert(r.msg || "Login failed");
  }
});

ui.btnBackLogin?.addEventListener("click", ()=> show(ui.login));
ui.btnSendReq?.addEventListener("click", async ()=>{ await driveUpload(); alert("Request sent"); });

ui.btnCreate?.addEventListener("click", async ()=>{
  const phone = cleanPhone(ui.nPhone.value);
  const pin   = (ui.nPin.value||"").trim();
  const role  = ui.nRole.value;
  if (!phone || !pin) return alert("Phone & PIN required");
  const d = loadData();
  const i = d.users.findIndex(u=>u.phone===phone);
  const prevDevs = i>=0 ? (d.users[i].devices||[]) : [];
  d.users[i>=0?i:d.users.length] = { phone, pin, role, devices: prevDevs };
  saveData(d); await driveUpload(); alert("User saved");
});
ui.btnSync?.addEventListener("click", ()=>syncNow());
ui.btnSyncAdmin?.addEventListener("click", ()=>syncNow());

ui.btnLogout?.addEventListener("click", ()=>{ sessionClear(); show(ui.login); });
ui.btnLogoutAdmin?.addEventListener("click", ()=>{ sessionClear(); show(ui.login); });

ui.btnSign?.addEventListener("click", async ()=>{
  try{ await ensureToken(); await driveEnsureFile(); ui.drive.textContent="Drive: Ready"; }
  catch(e){ console.error(e); ui.drive.textContent="Drive: Error"; }
});

ui.btnLoadDevices?.addEventListener("click", loadDeviceList);
ui.btnRevokeAll?.addEventListener("click", async ()=>{
  const phone = cleanPhone(ui.mPhone.value); if (!phone) return;
  const d = loadData(); const u = d.users.find(x=>x.phone===phone); if (!u) return;
  u.devices = []; saveData(d); loadDeviceList(); await driveUpload();
});

/* ===== Resume session ===== */
(function boot(){
  if (navigator.mediaDevices?.getUserMedia) {
    // Just probing permission when needed later (barcode etc.)
  }
  const s = sessionGet();
  if (s && s.approved){
    ui.who && (ui.who.textContent = `${s.phone} (${s.role})`);
    show(s.role==="admin" ? ui.admin : ui.cashier);
    renderProducts(); renderPending();
    syncNow();
  }else{
    show(ui.login);
  }
})();
