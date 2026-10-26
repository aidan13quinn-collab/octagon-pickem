(() => {
"use strict";

const sb = window.supabase.createClient(window.OP_CONFIG.supabaseUrl, window.OP_CONFIG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const S = {
  session: null, uid: null,
  cards: [], profiles: {}, pickMap: new Map(), lockMap: new Map(), ver: 0,
  tab: "picks", cardId: null, authMode: "signin", loaded: false, viewUser: null, fighters: {}, openForm: new Set(),
  page: null,            // "account" | "settings" | "app" when opened from the menu
  prefs: null,           // this player's notification choices
  push: { subscribed: false, busy: false }
};
try { const t = localStorage.getItem("op-tab"); if (t === "picks" || t === "board") S.tab = t; } catch (e) {}
try { const v = localStorage.getItem("op-board"); if (v === "all" || v === "week") S.boardView = v; } catch (e) {}
// links from notifications: /?tab=picks&card=<card id>
try {
  const q = new URLSearchParams(location.search);
  const t = q.get("tab"); if (t === "picks" || t === "board") S.tab = t;
  if (q.get("card")) S.cardId = q.get("card");
  if (q.has("tab") || q.has("card")) history.replaceState(null, "", location.pathname);
} catch (e) {}

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,2600); }

const lockSVG = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>`;

/* ---------- helpers ---------- */
function fmtOdds(n){ return n==null ? "" : (n>0 ? "+"+n : String(n)); }
function fmtDate(d){ try{ return new Date(d+"T12:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}); }catch(e){ return d; } }
function fmtLockAt(c){ try{ return new Date(c.lock_at).toLocaleString(undefined,{weekday:"short",hour:"numeric",minute:"2-digit"}); }catch(e){ return ""; } }
function cardLocked(c){ return !!c.locked || (!!c.lock_at && Date.now() >= Date.parse(c.lock_at)); }
function isOff(f){ return !!(f.res && f.res.w === "cancelled"); }
function fightLocked(c,f){ return cardLocked(c) || !!(f.res && f.res.w); }
function nameOf(id){ return S.profiles[id]?.display_name || "Player"; }
function colorFor(id){ let h=0; for(const ch of String(id)) h=(h*31+ch.charCodeAt(0))>>>0; return `hsl(${h%360} 55% 42%)`; }
function avatar(id){ const n=nameOf(id); return `<span class="avatar" style="background:${colorFor(id)}" aria-hidden="true">${esc(n.trim().charAt(0).toUpperCase()||"?")}</span>`; }

// pick lookups (indexed, so the page stays fast with hundreds of players)
const pk = (u,c,f) => u+"|"+c+"|"+f;
const lk = (u,c) => u+"|"+c;
function pickOf(uid, cardId, fightId){ return S.pickMap.get(pk(uid,cardId,fightId))?.side || null; }
function lockRow(uid, cardId){ return S.lockMap.get(lk(uid,cardId)) || null; }
// results of heavy calculations are reused until the data changes
const memo = {};
function cached(name, fn){ const m = memo[name]; if(m && m.v===S.ver) return m.r; const r = fn(); memo[name] = { v:S.ver, r }; return r; }
function picksForFight(cardId, fightId){
  const idx = cached("byFight", ()=>{ const m = new Map(); for(const p of S.pickMap.values()){ const k = p.card_id+"|"+p.fight_id; if(!m.has(k)) m.set(k, []); m.get(k).push(p); } return m; });
  return idx.get(cardId+"|"+fightId) || [];
}
// 1 = correct, 0 = wrong, null = not graded / doesn't count
// owes = the player was in the league before this card locked, so a missing pick counts as a miss
function grade(side, f, owes){
  if(!f.res || !f.res.w) return null;
  if(f.res.w==="cancelled" || f.res.w==="draw") return null;
  if(!side) return owes ? 0 : null;
  return side===f.res.w ? 1 : 0;
}
function owes(uid, c){
  const j = S.profiles[uid]?.created_at;
  return !j || !c.lock_at || Date.parse(j) <= Date.parse(c.lock_at);
}
function lockInfo(uid, c){
  const l = lockRow(uid, c.id); if(!l) return null;
  const f = (c.fights||[]).find(x=>x.id===l.fight_id); if(!f || isOff(f)) return null;
  const side = pickOf(uid, c.id, f.id); if(!side) return null;
  let hit = null;
  if(f.res && f.res.w) hit = f.res.w==="draw" ? "push" : f.res.w===side;
  return { f, side, odds: side==="red"?f.oddsRed:f.oddsBlue, hit };
}

function players(){ return cached("players", ()=>{
  const ids = new Set(Object.keys(S.profiles));
  for(const p of S.pickMap.values()) ids.add(p.user_id);
  return [...ids];
}); }
function standings(){ return cached("standings", ()=>{
  const rows = players().map(id=>{
    let w=0,l=0,lw=0,ll=0;
    for(const c of S.cards){
      for(const f of (c.fights||[])){
        const g = grade(pickOf(id,c.id,f.id), f, owes(id,c));
        if(g===1) w++; else if(g===0) l++;
      }
      const L = lockInfo(id,c);
      if(L && L.hit===true) lw++; else if(L && L.hit===false) ll++;
    }
    return {id,w,l,lw,ll};
  });
  rows.sort((a,b)=>b.w-a.w || a.l-b.l || b.lw-a.lw || a.ll-b.ll || nameOf(a.id).localeCompare(nameOf(b.id)));
  return rows;
}); }

/* ---------- data ---------- */
function bump(){ S.ver++; }
function putPick(r){ S.pickMap.set(pk(r.user_id,r.card_id,r.fight_id), { user_id:r.user_id, card_id:r.card_id, fight_id:r.fight_id, side:r.side }); }
function putLock(r){ S.lockMap.set(lk(r.user_id,r.card_id), { user_id:r.user_id, card_id:r.card_id, fight_id:r.fight_id }); }

// the database returns at most 1000 rows per request, so page through bigger tables
async function fetchAll(build){
  const out = [], size = 1000;
  for(let from = 0; ; from += size){
    const { data, error } = await build().range(from, from + size - 1);
    if(error) return { data: out, error };
    out.push(...(data || []));
    if(!data || data.length < size) return { data: out, error: null };
  }
}
let pickSince = 0;   // newest pick time we've seen (ms)
function notePickTime(rows){ for(const r of rows){ const t = Date.parse(r.updated_at); if(t > pickSince) pickSince = t; } }

async function loadAll(){
  const [cards, profiles, picks, locks, fighters] = await Promise.all([
    sb.from("cards").select("*").order("date",{ascending:false}),
    fetchAll(()=>sb.from("profiles").select("id,display_name,created_at").order("id")),
    fetchAll(()=>sb.from("picks").select("user_id,card_id,fight_id,side,updated_at").order("user_id").order("card_id").order("fight_id")),
    fetchAll(()=>sb.from("locks").select("user_id,card_id,fight_id").order("user_id").order("card_id")),
    fetchAll(()=>sb.from("fighters").select("name,record,recent,country,photo_url,photo_credit,photo_page").order("name"))
  ]);
  const err = cards.error || profiles.error || picks.error || locks.error;
  if(err){ toast("Couldn't load the league. Pull to refresh."); console.error(err); }
  S.cards = cards.data || [];
  S.profiles = Object.fromEntries((profiles.data||[]).map(p=>[p.id,p]));
  S.pickMap = new Map(); (picks.data||[]).forEach(putPick); notePickTime(picks.data||[]);
  S.lockMap = new Map(); (locks.data||[]).forEach(putLock);
  S.fighters = Object.fromEntries((fighters.data||[]).map(f=>[f.name,f]));
  S.loaded = true; lastRefresh = Date.now(); bump();
  render();
}

// other players' picks: fetch only what changed since last time (every minute while the page is open)
async function syncPicks(){
  if(!S.uid || !S.loaded) return;
  const since = pickSince ? new Date(pickSince - 15000).toISOString() : null;
  const { data, error } = await fetchAll(()=>{
    let q = sb.from("picks").select("user_id,card_id,fight_id,side,updated_at");
    if(since) q = q.gte("updated_at", since);
    return q.order("updated_at").order("user_id").order("card_id").order("fight_id");
  });
  if(error || !data.length) return;
  data.forEach(putPick); notePickTime(data); bump(); scheduleRender();
}
// when you come back to the page: small refresh instead of reloading the whole league
let lastRefresh = 0;
async function refreshLight(force){
  if(!S.uid || !S.loaded || (!force && Date.now() - lastRefresh < 30000)) return;
  lastRefresh = Date.now();
  const c = currentCard();
  const [cards, locks] = await Promise.all([
    sb.from("cards").select("*").order("date",{ascending:false}),
    c ? fetchAll(()=>sb.from("locks").select("user_id,card_id,fight_id").eq("card_id", c.id).order("user_id")) : Promise.resolve({ data:null })
  ]);
  if(cards.data) S.cards = cards.data;
  if(c && locks.data && !locks.error){ for(const k of [...S.lockMap.keys()]) if(k.endsWith("|"+c.id)) S.lockMap.delete(k); locks.data.forEach(putLock); }
  bump();
  await syncPicks();
  render();
}
let renderTimer = null;
function scheduleRender(){ clearTimeout(renderTimer); renderTimer = setTimeout(render, 150); }

// live updates: only small, rare changes come over the live connection (results, odds, locks, names, fighters).
// each update carries just the changed row, so nobody re-downloads the league.
let channel = null;
function applyChange(table, p){
  const n = p.new || {}, o = p.old || {}, del = p.eventType === "DELETE";
  if(table === "cards"){
    const id = del ? o.id : n.id;
    S.cards = S.cards.filter(c=>c.id !== id);
    if(!del && n.id) S.cards.push(n);
    S.cards.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  } else if(table === "locks"){
    const r = del ? o : n;
    if(del) S.lockMap.delete(lk(r.user_id, r.card_id)); else putLock(n);
  } else if(table === "profiles"){
    if(del) delete S.profiles[o.id]; else S.profiles[n.id] = { id:n.id, display_name:n.display_name, created_at:n.created_at };
  } else if(table === "fighters"){
    if(del) delete S.fighters[o.name]; else S.fighters[n.name] = { name:n.name, record:n.record, recent:n.recent, country:n.country, photo_url:n.photo_url, photo_credit:n.photo_credit, photo_page:n.photo_page };
  }
  bump(); scheduleRender();
}
function subscribe(){
  if(channel) return;
  channel = sb.channel("league");
  ["cards","locks","profiles","fighters"].forEach(t=>channel.on("postgres_changes",{event:"*",schema:"public",table:t},p=>applyChange(t,p)));
  channel.subscribe();
}
function unsubscribe(){ if(channel){ sb.removeChannel(channel); channel=null; } }

const LOCK_LIMIT = -200, LOCK_MSG = "Locks have to be -200 or better.";
function lockOK(f, side){ if(!side) return true; const o = side==="red" ? f.oddsRed : f.oddsBlue; return o==null || Number(o) >= LOCK_LIMIT; }
async function setPick(c, f, side){
  const prev = pickOf(S.uid, c.id, f.id);
  if(prev===side) return;
  if(lockRow(S.uid,c.id)?.fight_id===f.id && !lockOK(f, side)){ toast(LOCK_MSG); return; }
  // optimistic
  putPick({user_id:S.uid, card_id:c.id, fight_id:f.id, side}); bump();
  render();
  const { error } = await sb.from("picks").upsert({user_id:S.uid, card_id:c.id, fight_id:f.id, side, updated_at:new Date().toISOString()});
  if(error){ toast(/-200/.test(error.message||"") ? LOCK_MSG : cardLocked(c) ? "Picks are locked for this card." : "Couldn't save that pick. Try again."); loadAll(); }
}
async function toggleLock(c, f){
  const cur = lockRow(S.uid, c.id);
  if(cur && cur.fight_id===f.id){
    S.lockMap.delete(lk(S.uid,c.id)); bump(); render();
    const { error } = await sb.from("locks").delete().match({user_id:S.uid, card_id:c.id});
    if(error){ toast("Couldn't remove your lock. Try again."); loadAll(); }
    return;
  }
  if(!lockOK(f, pickOf(S.uid, c.id, f.id))){ toast(LOCK_MSG); return; }
  putLock({user_id:S.uid, card_id:c.id, fight_id:f.id}); bump(); render();
  const { error } = await sb.from("locks").upsert({user_id:S.uid, card_id:c.id, fight_id:f.id, updated_at:new Date().toISOString()});
  if(error){ toast(/-200/.test(error.message||"") ? LOCK_MSG : cardLocked(c) ? "Locks are closed for this card." : "Couldn't save your lock. Try again."); loadAll(); }
}

/* ---------- render ---------- */
function preserve(fn){
  const vals={}, active=document.activeElement?.id;
  document.querySelectorAll("#app input[id]").forEach(el=>vals[el.id]=el.value);
  fn();
  for(const [id,v] of Object.entries(vals)){ const el=document.getElementById(id); if(el) el.value=v; }
  if(active){ const el=document.getElementById(active); if(el) el.focus(); }
}
function emptyHTML(h,p){ return `<div class="empty"><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`; }

function render(){
  const signedIn = !!S.uid;
  $("#me").hidden = !signedIn; $("#tabs").hidden = !signedIn;
  if(signedIn){
    $("#me").innerHTML = `<span class="who-am-i">${avatar(S.uid)}<span id="me-name"></span></span>`;
    $("#me-name").textContent = nameOf(S.uid);
    $("#me-name").insertAdjacentHTML("afterbegin", commish(S.uid));
    if(S.loaded) $("#me-name").insertAdjacentHTML("beforeend", crown(S.uid));
    document.querySelectorAll(".tab").forEach(t=>t.setAttribute("aria-selected", String(!S.page && t.dataset.tab===S.tab)));
  }
  $("#menu-btn").hidden = !signedIn;
  if(!signedIn) closeMenu();
  preserve(()=>{
    const app = $("#app");
    if(!signedIn){ app.innerHTML = authHTML(); return; }
    if(!S.loaded){ app.innerHTML = emptyHTML("Loading the card","Connecting to your league."); return; }
    app.innerHTML = S.page ? pageHTML() : (S.tab==="board" ? boardHTML() : picksHTML());
  });
}

function authHTML(){
  const up = S.authMode==="signup";
  return `<section class="auth">
    <div class="switch" role="group" aria-label="Sign in or create an account">
      <button data-act="mode" data-v="signin" aria-pressed="${!up}">Sign in</button>
      <button data-act="mode" data-v="signup" aria-pressed="${up}">Join the league</button>
    </div>
    <form id="auth-form" class="panel" method="post" action="#" autocomplete="on" novalidate>
      <h3>${up?"Create your account":"Welcome back"}</h3>
      ${up?`<div class="field"><label class="label" for="a-name">Display name</label><input id="a-name" name="nickname" maxlength="30" autocomplete="nickname" placeholder="What your friends call you" required></div>`:""}
      <div class="field"><label class="label" for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email" required></div>
      <div class="field"><label class="label" for="a-pass">Password</label><input id="a-pass" name="password" type="password" autocomplete="${up?"new-password":"current-password"}" minlength="6" required></div>
      <p class="err" id="a-err" hidden></p><p class="ok" id="a-ok" hidden></p>
      <button class="btn gold" type="submit" id="a-submit">${up?"Join the league":"Sign in"}</button>
      ${up?`<p class="note" style="margin:0">Passwords need at least 6 characters.</p>`:""}
    </form>
  </section>`;
}

// midnight (local time) at the start of the Monday after the card's event date
function showUntil(c){
  if(!c.date) return 0;
  const [y,m,d] = String(c.date).split("-").map(Number);
  const t = new Date(y, m-1, d);
  if(isNaN(t)) return 0;
  t.setDate(t.getDate() + (((8 - t.getDay()) % 7) || 7));
  return t.getTime();
}
function currentCard(){
  if(!S.cards.length) return null;
  let c = S.cards.find(x=>x.id===S.cardId);
  if(!c){
    // default: a card that's already locked stays up through fight weekend (until the Monday after
    // its event); otherwise the soonest card that hasn't locked yet, otherwise the most recent
    const live = S.cards.filter(x=>cardLocked(x) && Date.now() < showUntil(x)).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    const open = S.cards.filter(x=>!cardLocked(x)).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    c = live[0] || open[0] || S.cards[0];
    S.cardId = c.id;
  }
  return c;
}
function cardSelect(){
  if(S.cards.length<2) return "";
  return `<select id="sel-card" aria-label="Fight card">${S.cards.map(c=>`<option value="${esc(c.id)}" ${c.id===S.cardId?"selected":""}>${esc(c.name)}${c.date?" · "+esc(fmtDate(c.date)):""}</option>`).join("")}</select>`;
}

/* ---------- menu ---------- */
function openMenu(){ $("#menu").hidden=false; $("#menu-scrim").hidden=false; $("#menu-btn").setAttribute("aria-expanded","true"); $("#menu button")?.focus(); }
function closeMenu(){ $("#menu").hidden=true; $("#menu-scrim").hidden=true; $("#menu-btn").setAttribute("aria-expanded","false"); }
function openPage(p){
  S.page=p; S.viewUser=null; render(); window.scrollTo(0,0);
  if(p==="settings"){ loadPrefs(); syncPush(); }
}
async function signOut(){
  // stop this device getting the old account's notifications
  try{
    const reg = await swReady();
    const sub = reg && await reg.pushManager.getSubscription();
    if(sub){ await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
  }catch(e){}
  await sb.auth.signOut();
}

/* ---------- theme ---------- */
function currentTheme(){ return document.documentElement.dataset.theme==="dark" ? "dark" : "light"; }
function setTheme(t){
  document.documentElement.dataset.theme=t;
  try{ localStorage.setItem("fw-theme",t); }catch(e){}
  render();
}

/* ---------- install as an app ---------- */
let deferredInstall = null;
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
const isAndroid = () => /android/i.test(navigator.userAgent);
window.addEventListener("beforeinstallprompt", e=>{ e.preventDefault(); deferredInstall = e; render(); });
window.addEventListener("appinstalled", ()=>{ deferredInstall = null; render(); toast("Fight Week is on your home screen."); });
if("serviceWorker" in navigator){ window.addEventListener("load", ()=>{ navigator.serviceWorker.register("/sw.js").catch(()=>{}); }); }

/* ---------- notifications ---------- */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
async function swReady(){
  if(!("serviceWorker" in navigator)) return null;
  try{
    const reg = await navigator.serviceWorker.getRegistration() || await navigator.serviceWorker.register("/sw.js");
    return await navigator.serviceWorker.ready || reg;
  }catch(e){ return null; }
}
function keyBytes(b64){
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g,"+").replace(/_/g,"/"));
  return Uint8Array.from(raw, c=>c.charCodeAt(0));
}
async function saveSub(sub){
  const j = sub.toJSON();
  const { error } = await sb.from("push_subscriptions").upsert({
    endpoint: j.endpoint, user_id: S.uid, p256dh: j.keys.p256dh, auth: j.keys.auth,
    user_agent: navigator.userAgent.slice(0,200), updated_at: new Date().toISOString()
  });
  return !error;
}
// on sign-in and when Settings opens: is this device subscribed, and does the server know?
async function syncPush(){
  if(!S.uid || !pushSupported() || Notification.permission!=="granted"){ S.push.subscribed=false; if(S.page==="settings") render(); return; }
  const reg = await swReady();
  const sub = reg && await reg.pushManager.getSubscription();
  S.push.subscribed = !!sub;
  if(sub) await saveSub(sub);
  if(S.page==="settings") render();
}
async function pushOn(){
  if(S.push.busy) return;
  S.push.busy=true; render();
  try{
    const perm = await Notification.requestPermission();
    if(perm!=="granted"){ toast(perm==="denied" ? "Notifications are blocked. Allow them in your settings." : "Notifications weren't turned on."); return; }
    const reg = await swReady();
    if(!reg) throw new Error("no service worker");
    let sub = await reg.pushManager.getSubscription();
    if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:keyBytes(window.OP_CONFIG.vapidPublicKey) });
    if(!await saveSub(sub)) throw new Error("save failed");
    if(!S.prefs) await savePrefs(S.prefs || defaultPrefs());
    S.push.subscribed=true;
    toast("Notifications are on for this device.");
  }catch(e){
    console.error(e); toast("Couldn't turn on notifications. Try again.");
  }finally{ S.push.busy=false; render(); }
}
async function pushOff(){
  if(S.push.busy) return;
  S.push.busy=true; render();
  try{
    const reg = await swReady();
    const sub = reg && await reg.pushManager.getSubscription();
    if(sub){ await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
    S.push.subscribed=false; toast("Notifications are off for this device.");
  }catch(e){ toast("Couldn't turn notifications off. Try again."); }
  finally{ S.push.busy=false; render(); }
}
async function pushTest(){
  const { data, error } = await sb.functions.invoke("notify", { body:{ job:"test" } });
  if(error || !data) toast("Couldn't send a test. Try again.");
  else if(!data.sent) toast("No devices got it. Turn notifications off and on again.");
  else toast("Test sent. It should pop up in a few seconds.");
}
const defaultPrefs = () => ({ fight_cancelled:true, fight_added:true, friday_reminder:true, card_results:true });
async function loadPrefs(){
  if(!S.uid) return;
  const { data } = await sb.from("notify_prefs").select("fight_cancelled,fight_added,friday_reminder,card_results").eq("user_id",S.uid).maybeSingle();
  S.prefs = data || defaultPrefs();
  if(S.page==="settings") render();
}
async function savePrefs(p){
  const { error } = await sb.from("notify_prefs").upsert({ user_id:S.uid, ...p, updated_at:new Date().toISOString() });
  return !error;
}
async function savePref(key, on){
  S.prefs = { ...(S.prefs || defaultPrefs()), [key]: on };
  if(!await savePrefs(S.prefs)){ toast("Couldn't save that setting. Try again."); loadPrefs(); }
}

/* ---------- account ---------- */
async function saveName(){
  const input=$("#acc-name"), err=$("#name-err"), btn=$("#name-save");
  const name=input.value.trim();
  err.hidden=true;
  if(!name){ err.textContent="Your username can't be blank."; err.hidden=false; return; }
  if(name.length>30){ err.textContent="Keep it to 30 characters or fewer."; err.hidden=false; return; }
  if(name===nameOf(S.uid)){ toast("That's already your username."); return; }
  btn.disabled=true;
  const { error } = await sb.from("profiles").update({ display_name:name }).eq("id",S.uid);
  btn.disabled=false;
  if(error){ err.textContent="Couldn't save your username. Try again."; err.hidden=false; return; }
  S.profiles[S.uid] = { ...(S.profiles[S.uid]||{id:S.uid}), display_name:name }; bump();
  input.value=""; render(); toast("Username updated.");
}
async function savePassword(){
  const p1=$("#acc-pass").value, p2=$("#acc-pass2").value, err=$("#pass-err"), btn=$("#pass-save");
  err.hidden=true;
  if(p1.length<6){ err.textContent="Use at least 6 characters."; err.hidden=false; return; }
  if(p1!==p2){ err.textContent="Those passwords don't match."; err.hidden=false; return; }
  btn.disabled=true;
  const { error } = await sb.auth.updateUser({ password:p1 });
  btn.disabled=false;
  if(error){ err.textContent = /different from the old/i.test(error.message||"") ? "Pick a password you haven't used here before." : (error.message || "Couldn't change your password. Try again."); err.hidden=false; return; }
  $("#acc-pass").value=""; $("#acc-pass2").value=""; toast("Password changed.");
}

/* ---------- pages ---------- */
const pageTitles = { account:"Account", settings:"Settings", app:"Get the app" };
function pageHTML(){
  let h = `<button class="backbtn" data-act="closepage">‹ Back</button><div class="event-head"><h2>${esc(pageTitles[S.page]||"")}</h2></div>`;
  if(S.page==="account") h += accountHTML();
  else if(S.page==="settings") h += settingsHTML();
  else if(S.page==="app") h += appHTML();
  return h;
}
function accountHTML(){
  const email = S.session?.user?.email || "";
  const joined = S.session?.user?.created_at ? new Date(S.session.user.created_at).toLocaleDateString(undefined,{month:"long",year:"numeric"}) : "";
  return `
  <div class="phead">${avatar(S.uid)}<div class="pmeta"><h2>${commish(S.uid)}${esc(nameOf(S.uid))}${crown(S.uid)}</h2>${joined?`<div class="note">In the league since ${esc(joined)}</div>`:""}</div></div>
  <form class="panel" id="name-form" autocomplete="off" novalidate>
    <h3>Username</h3>
    <p class="note" style="margin:0">This is the name everyone sees on the standings and picks.</p>
    <div class="row"><div class="field"><label class="label" for="acc-name">New username</label><input id="acc-name" maxlength="30" placeholder="${esc(nameOf(S.uid))}" autocapitalize="words"></div><button class="btn" type="submit" id="name-save">Save</button></div>
    <p class="err" id="name-err" hidden></p>
  </form>
  <div class="panel">
    <h3>Login info</h3>
    <div class="kv"><span class="label">Email</span><span class="kv-v">${esc(email)}</span></div>
    <p class="note" style="margin:0">You sign in with this email and your password.</p>
  </div>
  <form class="panel" id="pass-form" method="post" action="#" novalidate>
    <h3>Change password</h3>
    <input type="email" name="email" autocomplete="username" value="${esc(email)}" hidden>
    <div class="field"><label class="label" for="acc-pass">New password</label><input id="acc-pass" type="password" autocomplete="new-password" minlength="6"></div>
    <div class="field"><label class="label" for="acc-pass2">Type it again</label><input id="acc-pass2" type="password" autocomplete="new-password" minlength="6"></div>
    <p class="err" id="pass-err" hidden></p>
    <div><button class="btn" type="submit" id="pass-save">Change password</button></div>
  </form>
  <div><button class="btn danger" data-act="signout">Sign out</button></div>`;
}
function toggleRow(key, title, desc){
  const on = !!(S.prefs || defaultPrefs())[key];
  return `<label class="toggle"><span class="tg-t"><b>${esc(title)}</b><span>${esc(desc)}</span></span><input type="checkbox" role="switch" data-pref="${key}" ${on?"checked":""}><span class="tg-ui" aria-hidden="true"></span></label>`;
}
function settingsHTML(){
  const t = currentTheme();
  let h = `<div class="panel"><h3>Appearance</h3>
    <div class="seg" role="group" aria-label="Theme">
      <button data-act="theme" data-v="light" aria-pressed="${t==="light"}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>Light</button>
      <button data-act="theme" data-v="dark" aria-pressed="${t==="dark"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>Dark</button>
    </div></div>`;

  h += `<div class="panel"><h3>Notifications</h3>`;
  if(!pushSupported()){
    h += isIOS() && !isStandalone()
      ? `<p class="note" style="margin:0">On iPhone, notifications only work in the Fight Week app. Add it to your Home Screen, open it from there, then come back here to turn them on.</p><div><button class="btn gold" data-act="page" data-v="app">How to get the app</button></div>`
      : `<p class="note" style="margin:0">This browser can't show notifications. Try Chrome or Safari, or install the app.</p>`;
  } else if(Notification.permission==="denied"){
    h += `<p class="note" style="margin:0">Notifications are blocked for Fight Week on this device. Allow them in your ${isIOS()?"iPhone Settings › Notifications › Fight Week":"browser's site settings"}, then come back here.</p>`;
  } else if(S.push.subscribed){
    h += `<div class="pushstate on"><span class="dot" aria-hidden="true"></span><span>On for this device</span></div>
      <div class="row-btns"><button class="btn ghost sm" data-act="push-test">Send a test</button><button class="btn ghost sm" data-act="push-off" ${S.push.busy?"disabled":""}>Turn off on this device</button></div>`;
  } else {
    h += `<p class="note" style="margin:0">Get a heads-up on your phone when the card changes, before picks lock, and when the results are in.</p>
      <div><button class="btn gold" data-act="push-on" ${S.push.busy?"disabled":""}>${S.push.busy?"Turning on…":"Turn on notifications"}</button></div>`;
  }
  h += `<div class="toggles">
    ${toggleRow("fight_cancelled","A fight gets cancelled","When a bout on the upcoming card is called off.")}
    ${toggleRow("fight_added","A fight gets added","When a new bout is added to the upcoming card.")}
    ${toggleRow("friday_reminder","Friday reminder","Fridays at 5 PM ET: what time picks lock tomorrow, when the card starts.")}
    ${toggleRow("card_results","Card results","When the last fight ends: your record and where you placed.")}
  </div>
  <p class="note" style="margin:0">These choices apply to every device where you turn notifications on.</p></div>`;
  return h;
}
function appHTML(){
  if(isStandalone()) return `<div class="panel"><h3>You're all set</h3><p class="note" style="margin:0">You're using the Fight Week app right now. Turn on notifications in Settings so you don't miss a card change.</p><div><button class="btn gold" data-act="page" data-v="settings">Go to Settings</button></div></div>`;
  const ios = `<div class="panel steps"><h3>iPhone</h3><ol>
      <li>Open <b>${esc(location.host)}</b> in <b>Safari</b>.</li>
      <li>Tap the <b>Share</b> button <span class="shareico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg></span> at the bottom of the screen.</li>
      <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
      <li>Tap <b>Add</b>. Fight Week shows up on your Home Screen like any other app.</li>
      <li>Open it from your Home Screen, then go to <b>Settings</b> to turn on notifications.</li></ol></div>`;
  const android = `<div class="panel steps"><h3>Android</h3>
      ${deferredInstall?`<div><button class="btn gold" data-act="install">Install Fight Week</button></div><p class="note" style="margin:0">Or do it by hand:</p>`:""}
      <ol><li>Open <b>${esc(location.host)}</b> in <b>Chrome</b>.</li>
      <li>Tap the <b>⋮</b> menu in the top right.</li>
      <li>Tap <b>Install app</b> (or <b>Add to Home screen</b>).</li>
      <li>Tap <b>Install</b>. Fight Week shows up with your other apps.</li>
      <li>Open it, then go to <b>Settings</b> to turn on notifications.</li></ol></div>`;
  let h = `<div class="appintro"><img src="/icons/icon-192.png" alt="" width="56" height="56"><p class="note" style="margin:0">Put Fight Week on your home screen. It opens full-screen like a regular app, and it's how you get notifications on iPhone.</p></div>`;
  h += isAndroid() ? android + ios : ios + android;
  if(!isIOS() && !isAndroid() && deferredInstall) h += `<div class="panel"><h3>On this computer</h3><div><button class="btn gold" data-act="install">Install Fight Week</button></div></div>`;
  return h;
}

function picksHTML(){
  const c = currentCard();
  if(!c) return emptyHTML("No fight card yet","The next UFC card is added automatically. Check back soon.");
  const fights = c.fights||[];
  const live = fights.filter(f=>!isOff(f));
  const done = live.filter(f=>pickOf(S.uid,c.id,f.id)).length;
  const L = lockInfo(S.uid, c);
  let cw=0, cl=0;
  fights.forEach(f=>{ const g=grade(pickOf(S.uid,c.id,f.id),f,owes(S.uid,c)); if(g===1) cw++; else if(g===0) cl++; });
  const locked = cardLocked(c);

  let h = `<div class="cardpick"><div class="event-head">
      <h2>${esc(c.name)}</h2>
      ${c.date?`<span class="label">${esc(fmtDate(c.date))}</span>`:""}
      <span class="pill ${locked?"locked":"open"}">${locked?"Picks locked":(c.lock_at?`Picks lock ${esc(fmtLockAt(c))}`:"Picks open")}</span>
      ${cw+cl?`<span class="pill gold"><span class="nw">${cw}–${cl}</span> this card</span>`:""}
    </div>${cardSelect()}</div>`;

  if(fights.length){
    const nm = L ? (L.side==="red"?L.f.red:L.f.blue) : "";
    h += `<div class="lockstrip ${L?"set":""}"><span class="lockicon" aria-hidden="true">${lockSVG}</span>
      <span class="ls-t">${L?`Lock: ${esc(nm)}`:(locked?"No lock this week":"Lock of the week")}</span>
      <span class="ls-v">${L?(L.hit===null?"Pending":L.hit==="push"?"Push":L.hit?"Hit":"Missed"):(locked?"":"Pick a fighter, then lock it")}</span></div>`;
  }
  if(!locked && live.length) h += `<p class="note">${done} of ${live.length} picked. Picks save automatically and lock when the first fight starts.</p>`;
  if(!live.length) h += emptyHTML("No bouts on this card","Bouts will appear here once they're announced.");

  // cancelled bouts are left off the page (players still get the "fight cancelled" notification)
  live.forEach((f,i)=>{
    const p = pickOf(S.uid,c.id,f.id);
    const isLock = !!(L && L.f.id===f.id);
    const flocked = fightLocked(c,f);
    const res = f.res && f.res.w ? f.res : null;
    const tag = i===0 ? "Main event" : (i===1 ? "Co-main" : "");
    h += `<section class="bout${isLock?" is-lock":""}" aria-label="${esc(f.red)} vs ${esc(f.blue)}">
      <div class="bout-meta"><span class="label">${esc(tag?tag+" · ":"")}${esc(f.weight||"Bout")} · ${f.rounds||3} rds</span>
        ${isLock?`<span class="pill gold">Lock of the week</span>`:""}</div>
      <div class="corners">${fighterBtn(c,f,"red",p,flocked,res)}<span class="vs">VS</span>${fighterBtn(c,f,"blue",p,flocked,res)}</div>${photoCredits(f)}`;
    if(p && !flocked){
      const nm = p==="red"?f.red:f.blue;
      h += `<div class="chips"><button class="chip lockchip" data-act="lock" data-fight="${esc(f.id)}" aria-pressed="${isLock}">${lockSVG}<span>${isLock?`Locked: ${esc(nm)}`:"Make this my lock"}</span></button>${isLock?'<span class="note">Tap to remove</span>':(L?'<span class="note">Moves your lock here</span>':"")}</div>`;
    } else if(!p && !flocked){
      h += `<p class="note" style="margin:0">Tap a fighter to pick the winner.</p>`;
    }
    if(res){
      const g = grade(p,f,owes(S.uid,c));
      const mark = res.w==="draw" ? "P" : (g===null ? "–" : (g ? "W" : "L"));
      const rText = res.w==="draw" ? "Ruled a draw or no contest" : `${esc(res.w==="red"?f.red:f.blue)} won`;
      h += `<div class="result"><span class="pts ${mark==="W"?"hit":mark==="L"?"miss":""}">${mark}</span><span>${rText}${isLock?(L.hit==="push"?" · lock pushes":L.hit?" · lock hit":" · lock missed"):""}</span></div>`;
    }
    h += historyHTML(f);
    h += crowdHTML(c,f);
    h += `</section>`;
  });
  h += `<div class="panel"><h3>How it works</h3><p class="note" style="margin:0">Pick a winner in every fight to build your record. Then mark one of your picks as your lock of the week; locks keep their own record. Draws, no contests and cancelled bouts don't count either way. Everyone can see each other's picks and locks anytime. Picks lock when the first fight starts.</p></div>`;
  return h;
}
function fighterBtn(c,f,side,p,locked,res){
  const name = side==="red"?f.red:f.blue;
  const odds = side==="red"?f.oddsRed:f.oddsBlue;
  const won = res && res.w===side;
  return `<button class="fighter ${side}${won?" won":""}" data-act="pick" data-fight="${esc(f.id)}" data-v="${side}" aria-pressed="${p===side}" ${locked?"disabled":""}>
    ${boutHasPhoto(f)?face(name):""}<span class="cn">${side==="red"?"Red corner":"Blue corner"}${won?" · Winner":""}</span><span class="nm">${side==="red"?flag(name)+esc(name):esc(name)+flag(name)}</span>
    <span class="od">${odds!=null?esc(fmtOdds(odds)):"Odds TBA"}</span></button>`;
}
// fighter photos: ufc.com fight card photos, or Wikimedia Commons when ufc.com has none
// (filled in by the fighter-photos job). A bout shows faces when at least one fighter has a photo;
// a fighter without one gets their initials.
function boutHasPhoto(f){ return !!(S.fighters[f.red]?.photo_url || S.fighters[f.blue]?.photo_url); }
function face(name){
  const u = S.fighters[name]?.photo_url;
  if(u && /^https:\/\/((www\.)?ufc\.com\/images\/|(upload|thumb)\.wikimedia\.org\/)/.test(u)){
    const ufc = /ufc\.com/.test(u);
    return `<span class="face${ufc?" ufc":""}"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('none');this.remove()"></span>`;
  }
  const ini = String(name).split(/\s+/).filter(Boolean).map(w=>w[0]).slice(0,2).join("").toUpperCase();
  return `<span class="face none" aria-hidden="true">${esc(ini)}</span>`;
}
// photographer credit + license, required by the photos' Creative Commons licenses
function photoCredits(f){
  const items = [f.red,f.blue].map(n=>S.fighters[n]).filter(x=>x && x.photo_url && x.photo_credit);
  if(!items.length) return "";
  return `<p class="credits">Photos: ${items.map(x=>{
    const page = x.photo_page && /^https:\/\/commons\.wikimedia\.org\//.test(x.photo_page) ? x.photo_page : "";
    const t = `${esc(x.name)}: ${esc(x.photo_credit)}`;
    return page ? `<a href="${esc(page)}" target="_blank" rel="noopener">${t}</a>` : t;
  }).join(" · ")} · via Wikimedia Commons</p>`;
}
// last-5 UFC results as little W/L chips, newest first
function formStrip(name){
  const fx = S.fighters[name]; if(!fx) return "";
  if(!fx.recent || !fx.recent.length) return `<span class="form"><span class="form-debut">UFC debut</span></span>`;
  return `<span class="form" aria-label="Last ${fx.recent.length} UFC fights">${fx.recent.map(r=>`<i class="fr ${esc(String(r.res).toLowerCase())}">${esc(r.res)}</i>`).join("")}</span>`;
}
// country flag image (public-domain flags from flagcdn), from the fighters table
function flag(name){
  const c = S.fighters[name]?.country;
  if(!c || !/^[a-z]{2}(-[a-z]{3})?$/.test(c)) return "";
  return `<img class="flag" src="https://flagcdn.com/${c}.svg" alt="" loading="lazy" width="20" height="14">`;
}
function fmtShort(d){ try{ return new Date(d+"T12:00:00").toLocaleDateString(undefined,{month:"short",year:"2-digit"}); }catch(e){ return d; } }
function historyCol(name, side){
  const fx = S.fighters[name];
  let h = `<div class="hcol ${side}"><div class="hname">${flag(name)}${esc(name)}</div>`;
  if(!fx){ return h + `<p class="note" style="margin:0">History not loaded yet.</p></div>`; }
  h += fx.record ? `<div class="hrec"><span class="nw">${esc(fx.record)}</span> pro record</div>` : "";
  if(!fx.recent || !fx.recent.length) return h + `<p class="note" style="margin:0">No UFC fights yet. This is their UFC debut.</p></div>`;
  h += `<ol class="hlist">${fx.recent.map(r=>`<li><i class="fr ${esc(String(r.res).toLowerCase())}">${esc(r.res)}</i><div class="hmain"><span class="hopp">vs ${esc(r.opp)}</span><span class="hmeta">${esc(r.method||"")}${r.round?` · R${esc(r.round)}`:""} · ${esc(fmtShort(r.date))}</span></div></li>`).join("")}</ol>`;
  if(fx.recent.length<5) h += `<p class="note" style="margin:0">${fx.recent.length} UFC ${fx.recent.length===1?"fight":"fights"} so far.</p>`;
  return h + `</div>`;
}
function historyHTML(f){
  const key = side => f.id+":"+side;
  const tog = side => {
    const open = S.openForm.has(key(side));
    const fx = S.fighters[side==="red"?f.red:f.blue];
    const n = fx && fx.recent ? fx.recent.length : 0;
    const label = fx && !n ? "UFC debut" : `Last ${n && n<5 ? n : 5} fights`;
    return `<button class="histbtn ${side}" data-act="hist" data-key="${esc(key(side))}" aria-expanded="${open}">${label} <span aria-hidden="true">${open?"▴":"▾"}</span></button>`;
  };
  let h = `<div class="histrow">${tog("red")}<span></span>${tog("blue")}</div>`;
  ["red","blue"].forEach(side=>{ if(S.openForm.has(key(side))) h += `<div class="hist">${historyCol(side==="red"?f.red:f.blue, side)}</div>`; });
  return h;
}
function locked0(c){ return cardLocked(c) || (c.fights||[]).some(f=>f.res&&f.res.w); }
function crowdHTML(c,f){
  const red=[], blue=[];
  picksForFight(c.id,f.id).forEach(p=>(p.side==="red"?red:blue).push(p.user_id));
  const n = red.length+blue.length;
  if(!n) return locked0(c) ? `<div class="crowd"><span class="note">Nobody picked this one.</span></div>` : "";
  const desc = id => `<span><button class="namelink" data-act="player" data-uid="${esc(id)}">${commish(id)}${esc(nameOf(id))}${crown(id)}</button>${lockRow(id,c.id)?.fight_id===f.id?' <span class="lk">LOCK</span>':""}</span>`;
  return `<div class="crowd"><span class="label">League picks · <span class="nw">${red.length}–${blue.length}</span></span>
    <div class="bar" aria-hidden="true"><i style="width:${red.length/n*100}%;background:var(--red)"></i><i style="width:${blue.length/n*100}%;background:var(--blue)"></i></div>
    <div class="who"><span style="color:var(--red)">${esc(f.red)}:</span>${red.map(desc).join("")||"<span>none</span>"}</div>
    <div class="who"><span style="color:var(--blue)">${esc(f.blue)}:</span>${blue.map(desc).join("")||"<span>none</span>"}</div></div>`;
}

// this week's lock for a player, shown under their name
function lockTag(uid, short){
  const c = currentCard(); if(!c) return "";
  const L = lockInfo(uid,c); if(!L) return "";
  let nm = L.side==="red"?L.f.red:L.f.blue;
  if(short) nm = String(nm).trim().split(/\s+/).pop(); // standings: last name only so it fits on one line
  const st = L.hit===null ? "" : L.hit==="push" ? " · push" : L.hit ? " · hit" : " · missed";
  return `<span class="locktag ${L.hit===true?"hit":L.hit===false?"miss":""}">${lockSVG}<span>${esc(nm)}${st}</span></span>`;
}
// standings rows for one card: that card's picks and lock only
function weekStandings(c){ return cached("week:"+c.id, ()=>{
  const ids = new Set(players());
  const rows = [...ids].map(id=>{
    const r = cardRecord(id,c); const L = lockInfo(id,c);
    return { id, w:r.w, l:r.l, lw:L&&L.hit===true?1:0, ll:L&&L.hit===false?1:0, picked:(c.fights||[]).some(f=>pickOf(id,c.id,f.id)) };
  }).filter(r=>r.w+r.l>0 || r.picked);
  rows.sort((a,b)=>b.w-a.w || a.l-b.l || b.lw-a.lw || a.ll-b.ll || nameOf(a.id).localeCompare(nameOf(b.id)));
  return rows;
}); }
// the table both views share; tied players (same record and same lock record) share a place: T-2, T-2, then 4
function boardTable(rows, showLock){
  let h = `<div class="boardwrap"><table class="board"><thead><tr><th></th><th>Player</th><th>Record</th><th>Locks</th></tr></thead><tbody>`;
  const same = (a,b) => !!a && !!b && a.w===b.w && a.l===b.l && a.lw===b.lw && a.ll===b.ll;
  let place = 0;
  rows.forEach((r,i)=>{
    if(!same(rows[i-1], r)) place = i+1;
    const tied = same(rows[i-1], r) || same(rows[i+1], r);
    h += `<tr class="${place===1&&r.w>0?"top":""}"><td class="rk">${tied?`<span class="t">T-</span>${place}`:place}</td>
      <td class="nm"><button class="namebtn" data-act="player" data-uid="${esc(r.id)}">${avatar(r.id)}<span class="nmstack"><span class="nmline"><span class="nmtxt">${commish(r.id)}${esc(nameOf(r.id))}${r.id===S.uid?" (you)":""}</span>${crown(r.id)}</span>${showLock?lockTag(r.id,true):""}</span><span class="chev" aria-hidden="true">›</span></button></td>
      <td class="tot">${r.w}–${r.l}</td><td class="lockrec">${r.lw}–${r.ll}</td></tr>`;
  });
  return h + `</tbody></table></div>`;
}
function boardHTML(){
  if(S.viewUser) return playerHTML(S.viewUser);
  const view = S.boardView==="week" ? "week" : "all";
  let h = `<div class="seg boardseg" role="group" aria-label="Standings view">
    <button data-act="bview" data-v="all" aria-pressed="${view==="all"}">All time</button>
    <button data-act="bview" data-v="week" aria-pressed="${view==="week"}">Fight week</button></div>`;
  const cc = currentCard();
  if(view==="week"){
    if(!cc) return h + emptyHTML("No fight card yet","The next UFC card is added automatically. Check back soon.");
    const rows = weekStandings(cc);
    const graded = (cc.fights||[]).some(f=>f.res && f.res.w && f.res.w!=="cancelled");
    h += `<div class="cardpick"><div class="event-head"><h2>${esc(cc.name)}</h2>${cc.date?`<span class="label">${esc(fmtDate(cc.date))}</span>`:""}${rows.length?`<span class="label">${rows.length} ${rows.length===1?"player":"players"}</span>`:""}</div>${cardSelect()}</div>`;
    if(!rows.length) return h + emptyHTML("No picks on this card yet","Rankings for this card show up once people make their picks.");
    if(!graded) h += `<p class="note">No results yet. Rankings fill in as the fights finish.</p>`;
    h += boardTable(rows, true);
    h += `<p class="note">Rankings for this card only. Tap a name to see their picks. Ties go to fewer misses, then the lock.</p>`;
    return h;
  }
  const rows = standings();
  if(!rows.length) return h + emptyHTML("No one's on the board yet","Make a pick to join. Standings fill in as results come in.");
  h += `<div class="event-head"><h2>All-time standings</h2><span class="label">${rows.length} ${rows.length===1?"player":"players"}</span></div>`;
  if(!rows.some(r=>r.w+r.l>0)) h += `<p class="note">No results yet. Everyone starts at 0–0.</p>`;
  h += boardTable(rows);
  h += `<p class="note">Tap a name to see their picks. Ranked by most correct picks. Ties go to fewer misses, then the better lock record. A fight you didn't pick counts as a miss. Draws, no contests and cancelled bouts don't count.</p>`;
  return h;
}

// last week's winner(s): most correct picks on the most recent fully graded card
function lastWinners(){ return cached("winners", lastWinnersCalc); }
function cardPodium(c){
  let best = 0; const recs = {};
  players().forEach(id=>{ const r = cardRecord(id,c); recs[id]=r; if(r.w>best) best=r.w; });
  const ids = new Set(best>0 ? Object.keys(recs).filter(id=>recs[id].w===best) : []);
  // second place: the next-best number of correct picks (ties all get silver)
  let second = 0;
  Object.values(recs).forEach(r=>{ if(r.w<best && r.w>second) second=r.w; });
  const silver = new Set(second>0 ? Object.keys(recs).filter(id=>recs[id].w===second) : []);
  return { card:c, ids, best, silver, second };
}
function gradedCards(){ return S.cards.filter(c=>(c.fights||[]).length && c.fights.every(f=>f.res && f.res.w)).sort((a,b)=>String(b.date).localeCompare(String(a.date))); }
function lastWinnersCalc(){
  const done = gradedCards();
  return done.length ? cardPodium(done[0]) : { card:null, ids:new Set(), silver:new Set() };
}
// every belt each player has won: gold for winning a card, silver for second (ties share)
function beltCounts(){ return cached("belts", ()=>{
  const out = {};
  gradedCards().forEach(c=>{
    const P = cardPodium(c);
    P.ids.forEach(id=>{ (out[id] ||= {g:0,s:0,gold:[],silver:[]}).g++; out[id].gold.push(c.name); });
    P.silver.forEach(id=>{ (out[id] ||= {g:0,s:0,gold:[],silver:[]}).s++; out[id].silver.push(c.name); });
  });
  return out;
}); }
// championship belt: black strap, two side plates and an octagon center plate with a star.
// The gold/silver shine comes from two gradients defined once on the page (beltDefs).
function beltSVG(m){ const g = m==="silver" ? "url(#fwBeltS)" : "url(#fwBeltG)";
  return `<svg viewBox="0 0 64 32" aria-hidden="true"><rect x="1" y="10" width="62" height="12" rx="3" fill="#17181c"/><rect x="8" y="11.5" width="8" height="9" rx="1.5" fill="${g}"/><rect x="48" y="11.5" width="8" height="9" rx="1.5" fill="${g}"/><polygon points="26,2 38,2 46,10 46,22 38,30 26,30 18,22 18,10" fill="${g}" stroke="#17181c" stroke-width="1"/><polygon points="27.5,6 36.5,6 42,11.5 42,20.5 36.5,26 27.5,26 22,20.5 22,11.5" fill="none" stroke="#17181c" stroke-opacity=".5" stroke-width="1.1"/><path d="m32 9.8 1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="#17181c" fill-opacity=".75"/></svg>`; }
(function beltDefs(){
  const stop = (o,c) => `<stop offset="${o}" stop-color="${c}"/>`;
  document.body.insertAdjacentHTML("afterbegin", `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
    <linearGradient id="fwBeltG" x1="0" y1="0" x2="0" y2="1">${stop(0,"#FFF1B8")+stop(.35,"#F2C14E")+stop(.7,"#C8901E")+stop(1,"#8C5E0E")}</linearGradient>
    <linearGradient id="fwBeltS" x1="0" y1="0" x2="0" y2="1">${stop(0,"#FFFFFF")+stop(.35,"#DDE2E8")+stop(.7,"#A9B1BC")+stop(1,"#6E7783")}</linearGradient></defs></svg>`);
})();
// league commissioner (the person who built and runs Fight Week)
const COMMISSIONER_ID = "414eba8d-669f-4cbb-8976-abb42c12c228";
const commishSVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8 3.5 5v6.2c0 5.3 3.6 9.6 8.5 11 4.9-1.4 8.5-5.7 8.5-11V5L12 1.8z" fill="currentColor"/><path d="m12 6.6 1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z" fill="var(--commish-star)"/></svg>`;
function commish(uid){ return uid===COMMISSIONER_ID ? `<span class="commish" title="League commissioner" role="img" aria-label="Commissioner">${commishSVG}</span>` : ""; }
// every belt a player has won: a gold belt (with ×N when more than one), then a silver belt
function crown(uid){
  const B = beltCounts()[uid]; if(!B) return "";
  const label = [B.g?`${B.g} gold`:"",B.s?`${B.s} silver`:""].filter(Boolean).join(", ");
  const tip = [B.gold.length?`Won ${B.gold.join(", ")}`:"",B.silver.length?`Second at ${B.silver.join(", ")}`:""].filter(Boolean).join(" · ");
  const one = (m,n) => n ? `<span class="belt ${m}">${beltSVG(m)}${n>1?`<span class="bx">×${n}</span>`:""}</span>` : "";
  return `<span class="belts" title="${esc(tip)}" role="img" aria-label="${esc(label)} ${B.g+B.s===1?"belt":"belts"}">${one("gold",B.g)}${one("silver",B.s)}</span>`;
}
function cardRecord(uid, c){
  let w=0,l=0;
  (c.fights||[]).forEach(f=>{ const g=grade(pickOf(uid,c.id,f.id),f,owes(uid,c)); if(g===1) w++; else if(g===0) l++; });
  return {w,l};
}
function playerHTML(uid){
  const me = uid===S.uid;
  const r = standings().find(x=>x.id===uid) || {w:0,l:0,lw:0,ll:0};
  let h = `<button class="backbtn" data-act="back">‹ Standings</button>
    <div class="phead">${avatar(uid)}<div class="pmeta"><h2>${commish(uid)}${esc(nameOf(uid))}${crown(uid)}${me?" (you)":""}</h2>
      <div class="pstats"><span><b class="nw">${r.w}–${r.l}</b> picks</span><span class="lk-stat"><b class="nw">${r.lw}–${r.ll}</b> locks</span></div>${lockTag(uid)}</div></div>`;
  const c = currentCard();
  if(!c) return h + emptyHTML("No cards yet","Their picks will show up here once a card is posted.");

  // card-by-card record
  const past = S.cards.filter(x=>cardLocked(x));
  if(past.length){
    h += `<div class="cardhist">${past.map(x=>{
      const cr = cardRecord(uid,x), L = lockInfo(uid,x);
      const lk = L ? (L.hit===null?"lock pending":L.hit==="push"?"lock push":L.hit?"lock hit":"lock missed") : "no lock";
      return `<button class="ch ${x.id===c.id?"on":""}" data-act="pcard" data-card="${esc(x.id)}"><span class="ch-n">${esc(x.name)}</span><span class="ch-r"><span class="nw">${cr.w}–${cr.l}</span> · ${lk}</span></button>`;
    }).join("")}</div>`;
  }

  h += `<div class="cardpick"><div class="event-head"><h2>${esc(c.name)}</h2>${c.date?`<span class="label">${esc(fmtDate(c.date))}</span>`:""}</div>${cardSelect()}</div>`;
  const fights = c.fights||[];
  const L = lockInfo(uid,c);
  const cr = cardRecord(uid,c);
  h += `<p class="note">${cr.w+cr.l?`<span class="nw">${cr.w}–${cr.l}</span> on this card. `:""}${L?`Lock: ${esc(L.side==="red"?L.f.red:L.f.blue)}${L.hit===null?"":L.hit==="push"?" (push)":L.hit?" (hit)":" (missed)"}.`:"No lock on this card."}</p>`;
  h += `<div class="plist">`;
  fights.filter(f=>!isOff(f)).forEach(f=>{
    const p = pickOf(uid,c.id,f.id);
    const off = isOff(f);
    const g = grade(p,f,owes(uid,c));
    const res = f.res && f.res.w;
    const mark = off ? "" : res==="draw" ? "P" : (g===null ? "" : (g?"W":"L"));
    const isLock = L && L.f.id===f.id;
    const side = s => `<span class="pf ${s} ${p===s?"chosen":""} ${res===s?"winner":""}">${esc(s==="red"?f.red:f.blue)}</span>`;
    h += `<div class="prow ${off?"off":""}">
      <div class="pnames">${side("red")}<span class="vs">vs</span>${side("blue")}</div>
      <div class="pright">${isLock?'<span class="lk">LOCK</span>':""}${off?'<span class="pill locked">Cancelled</span>':!p?(mark==="L"?'<span class="note">No pick</span> <span class="pts miss">L</span>':'<span class="note">No pick</span>'):mark?`<span class="pts ${mark==="W"?"hit":mark==="L"?"miss":""}">${mark}</span>`:'<span class="note">Pending</span>'}</div>
    </div>`;
  });
  h += `</div>`;
  return h;
}

/* ---------- events ---------- */
$("#tabs").addEventListener("click", e=>{
  const t=e.target.closest(".tab"); if(!t) return;
  S.tab=t.dataset.tab; S.viewUser=null; S.page=null; try{ localStorage.setItem("op-tab",S.tab); }catch(err){} render();
});
$("#menu-btn").addEventListener("click", ()=>{ $("#menu").hidden ? openMenu() : closeMenu(); });
$("#menu-scrim").addEventListener("click", closeMenu);
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && !$("#menu").hidden){ closeMenu(); $("#menu-btn").focus(); } });
$("#menu").addEventListener("click", async e=>{
  const b=e.target.closest("button"); if(!b) return;
  closeMenu();
  if(b.dataset.act==="signout"){ await signOut(); return; }
  if(b.dataset.page) openPage(b.dataset.page);
});
$("#app").addEventListener("change", e=>{
  if(e.target.id==="sel-card"){ S.cardId=e.target.value; render(); }
  if(e.target.dataset.pref){ savePref(e.target.dataset.pref, e.target.checked); }
});
$("#app").addEventListener("click", e=>{
  const b=e.target.closest("[data-act]"); if(!b || b.disabled) return;
  const act=b.dataset.act;
  if(act==="mode"){ S.authMode=b.dataset.v; render(); return; }
  if(act==="install" && deferredInstall){ deferredInstall.prompt(); deferredInstall.userChoice.finally(()=>{ deferredInstall=null; render(); }); return; }
  if(act==="page"){ openPage(b.dataset.v); return; }
  if(act==="closepage"){ S.page=null; render(); window.scrollTo(0,0); return; }
  if(act==="theme"){ setTheme(b.dataset.v); return; }
  if(act==="bview"){ S.boardView=b.dataset.v; try{ localStorage.setItem("op-board",S.boardView); }catch(err){} render(); return; }
  if(act==="push-on"){ pushOn(); return; }
  if(act==="push-off"){ pushOff(); return; }
  if(act==="push-test"){ pushTest(); return; }
  if(act==="signout"){ signOut(); return; }
  if(act==="player"){ S.viewUser=b.dataset.uid; S.tab="board"; render(); window.scrollTo(0,0); return; }
  if(act==="back"){ S.viewUser=null; render(); return; }
  if(act==="pcard"){ S.cardId=b.dataset.card; render(); return; }
  if(act==="hist"){ const k=b.dataset.key; S.openForm.has(k)?S.openForm.delete(k):S.openForm.add(k); render(); return; }
  const c=currentCard(); if(!c) return;
  const f=(c.fights||[]).find(x=>x.id===b.dataset.fight); if(!f) return;
  if(act==="pick") setPick(c,f,b.dataset.v);
  if(act==="lock") toggleLock(c,f);
});
$("#app").addEventListener("submit", async e=>{
  if(e.target.id==="name-form"){ e.preventDefault(); saveName(); return; }
  if(e.target.id==="pass-form"){ e.preventDefault(); savePassword(); return; }
  if(e.target.id!=="auth-form") return;
  e.preventDefault();
  const err=$("#a-err"), ok=$("#a-ok"), btn=$("#a-submit");
  err.hidden=true; ok.hidden=true;
  const email=$("#a-email").value.trim(), pass=$("#a-pass").value;
  const up = S.authMode==="signup";
  const name = up ? $("#a-name").value.trim() : "";
  if(up && !name){ err.textContent="Add a display name so your friends know who you are."; err.hidden=false; return; }
  if(!email || !pass){ err.textContent="Enter your email and password."; err.hidden=false; return; }
  if(up && pass.length<6){ err.textContent="Use a password with at least 6 characters."; err.hidden=false; return; }
  btn.disabled=true;
  const res = up
    ? await sb.auth.signUp({ email, password: pass, options: { data: { display_name: name } } })
    : await sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled=false;
  if(res.error){
    const m = res.error.message || "";
    err.textContent = /invalid login/i.test(m) ? "That email and password don't match. Try again or join the league." :
                      /already registered/i.test(m) ? "That email already has an account. Sign in instead." :
                      /rate limit/i.test(m) ? "Too many attempts. Wait a minute and try again." : m;
    err.hidden=false; return;
  }
  if(up && !res.data.session){ ok.textContent="Check your email to confirm your account, then sign in."; ok.hidden=false; }
});

/* ---------- boot ---------- */
async function onSession(session){
  S.session = session; S.uid = session?.user?.id || null;
  if(S.uid){ S.loaded=false; render(); await loadAll(); subscribe(); syncPush(); }
  else { unsubscribe(); S.cards=[]; S.pickMap=new Map(); S.lockMap=new Map(); S.profiles={}; bump(); S.loaded=false; S.page=null; S.prefs=null; S.push={subscribed:false,busy:false}; render(); }
}
sb.auth.onAuthStateChange((event, session)=>{
  if(event==="SIGNED_IN" || event==="SIGNED_OUT" || event==="INITIAL_SESSION"){
    if((session?.user?.id||null) !== S.uid || event==="INITIAL_SESSION") onSession(session);
  }
});
// re-render when a card's lock time passes, and refresh when the tab comes back into view
let lockSig="";
setInterval(()=>{ const sig=S.cards.map(c=>cardLocked(c)?1:0).join(""); if(sig!==lockSig){ const first=!lockSig; lockSig=sig; if(S.uid && !first) refreshLight(true); else render(); } },30000);
setInterval(()=>{ if(!document.hidden) syncPicks(); },60000);
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden && S.uid) refreshLight(false); });
render();
})();
