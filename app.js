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
// bottom tabs, left to right (swipe moves between neighbours)
const TABS = ["profile","community","picks","board","settings"];
try { const t = localStorage.getItem("op-tab"); if (TABS.includes(t)) S.tab = t; } catch (e) {}
try { const v = localStorage.getItem("op-board"); if (v === "all" || v === "week") S.boardView = v; } catch (e) {}
// links from notifications: /?tab=picks&card=<card id>
try {
  const q = new URLSearchParams(location.search);
  const t = q.get("tab"); if (TABS.includes(t)) S.tab = t;
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
// owes = the player made at least one pick on this card, so a fight they left blank counts as a miss.
// A card with no picks at all doesn't count for that player.
function grade(side, f, owes){
  if(!f.res || !f.res.w) return null;
  if(f.res.w==="cancelled" || f.res.w==="draw") return null;
  if(!side) return owes ? 0 : null;
  return side===f.res.w ? 1 : 0;
}
function playedSet(){ return cached("played", ()=>{ const s = new Set(); for(const p of S.pickMap.values()) s.add(p.user_id+"|"+p.card_id); return s; }); }
function played(uid, c){ return playedSet().has(uid+"|"+c.id); }
function owes(uid, c){ return played(uid, c); }
// cards that count toward the all-time board: locked, with at least one fight that has a counted result
function scoredCards(){ return cached("scored", ()=>S.cards.filter(c=>cardLocked(c) && (c.fights||[]).some(f=>f.res && f.res.w && f.res.w!=="cancelled" && f.res.w!=="draw"))); }
// share of scored cards a player must have played to be ranked on the all-time board
const MIN_PLAYED_SHARE = 0.5;
function minCards(){ return Math.ceil(scoredCards().length * MIN_PLAYED_SHARE); }
const pctOf = r => r.w+r.l ? r.w/(r.w+r.l) : 0;
const fmtPct = r => r.w+r.l ? Math.round(pctOf(r)*100)+"%" : "–";
function lockInfo(uid, c){
  const l = lockRow(uid, c.id); if(!l) return null;
  const f = (c.fights||[]).find(x=>x.id===l.fight_id); if(!f || isOff(f)) return null;
  const side = pickOf(uid, c.id, f.id); if(!side) return null;
  let hit = null;
  if(f.res && f.res.w) hit = f.res.w==="draw" ? "push" : f.res.w===side;
  return { f, side, odds: side==="red"?f.oddsRed:f.oddsBlue, hit };
}

// players who have made at least one pick, on any card
function pickedEver(uid){ return cached("pickers", ()=>{ const s = new Set(); for(const p of S.pickMap.values()) s.add(p.user_id); return s; }).has(uid); }
// no lock on a card you played counts as a missed lock, once the card has results.
// Not if your lock was on a bout that got cancelled.
function lockMissed(uid, c){
  if(lockInfo(uid,c) || !played(uid,c) || !scoredCards().includes(c)) return false;
  const l = lockRow(uid, c.id); const f = l && (c.fights||[]).find(x=>x.id===l.fight_id);
  return !(f && isOff(f));
}
function players(){ return cached("players", ()=>{
  const ids = new Set(Object.keys(S.profiles));
  for(const p of S.pickMap.values()) ids.add(p.user_id);
  return [...ids];
}); }
function standings(){ return cached("standings", ()=>{
  const rows = players().map(id=>{
    let w=0,l=0,lw=0,ll=0,cards=0;
    for(const c of scoredCards()) if(played(id,c)) cards++;
    for(const c of S.cards){
      for(const f of (c.fights||[])){
        const g = grade(pickOf(id,c.id,f.id), f, owes(id,c));
        if(g===1) w++; else if(g===0) l++;
      }
      const L = lockInfo(id,c);
      if(L && L.hit===true) lw++; else if((L && L.hit===false) || lockMissed(id,c)) ll++;
    }
    return {id,w,l,lw,ll,cards};
  }).filter(r=>pickedEver(r.id));
  // ranked: played enough cards, by win % then most correct, fewer misses, then the lock record
  const need = Math.max(1, minCards());
  rows.forEach(r=>{ r.ranked = r.cards>=need && r.w+r.l>0; });
  rows.sort((a,b)=>(b.ranked-a.ranked) || pctOf(b)-pctOf(a) || b.w-a.w || a.l-b.l || b.lw-a.lw || a.ll-b.ll || nameOf(a.id).localeCompare(nameOf(b.id)));
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

const LOCK_LIMIT = -250, LOCK_MSG = "Locks have to be -250 or better.";
function lockOK(f, side){ if(!side) return true; const o = side==="red" ? f.oddsRed : f.oddsBlue; return o==null || Number(o) >= LOCK_LIMIT; }
async function setPick(c, f, side){
  const prev = pickOf(S.uid, c.id, f.id);
  if(prev===side) return;
  if(lockRow(S.uid,c.id)?.fight_id===f.id && !lockOK(f, side)){ toast(LOCK_MSG); return; }
  // optimistic
  putPick({user_id:S.uid, card_id:c.id, fight_id:f.id, side}); bump();
  render();
  const { error } = await sb.from("picks").upsert({user_id:S.uid, card_id:c.id, fight_id:f.id, side, updated_at:new Date().toISOString()});
  if(error){ toast(/Locks have to be/.test(error.message||"") ? LOCK_MSG : cardLocked(c) ? "Picks are locked for this card." : "Couldn't save that pick. Try again."); loadAll(); }
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
  if(error){ toast(/Locks have to be/.test(error.message||"") ? LOCK_MSG : cardLocked(c) ? "Locks are closed for this card." : "Couldn't save your lock. Try again."); loadAll(); }
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
  $("#me").hidden = !signedIn; $("#bn").hidden = !signedIn; document.body.classList.toggle("has-bn", signedIn);
  if(signedIn){
    $("#me").innerHTML = `<button class="meav" data-go="profile" aria-label="Your profile">${avatar(S.uid)}</button>`;
    document.querySelectorAll("#bn button").forEach(t=>{ const on = t.dataset.tab===S.tab; t.classList.toggle("on", on); t.setAttribute("aria-selected", String(on)); });
    document.querySelectorAll("#bn-dots i").forEach((d,i)=>d.classList.toggle("on", TABS[i]===S.tab));
  }
  preserve(()=>{
    const app = $("#app");
    if(!signedIn){ app.innerHTML = authHTML(); return; }
    if(!S.loaded){ app.innerHTML = emptyHTML("Loading the card","Connecting to your league."); return; }
    app.innerHTML = tabHTML();
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
function tabHTML(){
  if(S.tab==="profile") return playerHTML(S.uid, true);
  if(S.tab==="community") return communityHTML();
  if(S.tab==="board") return boardHTML();
  if(S.tab==="settings") return S.page ? pageHTML() : settingsMenuHTML();
  return picksHTML();
}
// community: empty for now
function communityHTML(){ return `<div class="event-head"><h2>Community</h2></div>`; }
// settings tab: the old menu as a list; each row opens its page inside this tab
function settingsMenuHTML(){
  const row = (attr, icon, label) => `<button class="srow" ${attr}>${icon}<span>${label}</span><span class="chev" aria-hidden="true">›</span></button>`;
  return `<div class="event-head"><h2>Settings</h2></div><div class="slist">
    ${row('data-act="page" data-v="account"', NAV_ICONS.profile, "Account")}
    ${row('data-act="page" data-v="settings"', NAV_ICONS.bell, "Theme &amp; notifications")}
    ${row('data-act="page" data-v="app"', NAV_ICONS.phone, "Get the app")}
  </div><div class="slist">${row('data-act="signout"', NAV_ICONS.out, "Sign out")}</div>`;
}
// switching tabs: each tab remembers where you were scrolled to
const tabScroll = {};
function setTab(t, keepScroll){
  if(!TABS.includes(t)) return;
  tabScroll[S.tab] = window.scrollY;
  if(t!==S.tab){ S.viewUser=null; S.page=null; }
  S.tab=t; try{ localStorage.setItem("op-tab",t); }catch(err){}
  render();
  window.scrollTo(0, keepScroll===false ? 0 : (tabScroll[t]||0));
}
function openPage(p){
  S.tab="settings"; S.page=p; S.viewUser=null; render(); window.scrollTo(0,0);
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
const pageTitles = { account:"Account", settings:"Theme & notifications", app:"Get the app" };
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

// scorebug names shrink a little when they're long so one word never breaks mid-name
function bugSize(n){ const w = Math.max(...String(n).split(/\s+/).map(x=>x.length)); return w>12 ? 16 : w>9 ? 19 : 22; }
// "2d 06h 14m" until picks lock, as three little boxes
function clockHTML(at){
  let ms = Math.max(0, Date.parse(at) - Date.now()), m = Math.floor(ms/60000);
  const d = Math.floor(m/1440), hh = Math.floor((m%1440)/60), mm = m%60, p = n=>String(n).padStart(2,"0");
  return d ? `<span>${d}<em>D</em></span><span>${p(hh)}<em>H</em></span><span>${p(mm)}<em>M</em></span>`
           : `<span>${p(hh)}<em>H</em></span><span>${p(mm)}<em>M</em></span><span>${p(Math.floor(ms/1000)%60)}<em>S</em></span>`;
}
setInterval(()=>{ document.querySelectorAll(".clock[data-lockat]").forEach(el=>el.innerHTML=clockHTML(el.dataset.lockat)); }, 1000);
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

  // top of the tab: TV-style scorebug for the main event, countdown, progress ring, a big lock tile and share
  const shareSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;
  const nm = String(c.name||""), ix = nm.indexOf(":");
  const kicker = (ix>0 ? nm.slice(0,ix) : nm).trim();
  const vs = (ix>0 ? nm.slice(ix+1) : "").split(/\s+vs\.?\s+/i).map(x=>x.trim()).filter(Boolean);
  const main = live[0];
  const redN = vs.length===2 ? vs[0] : (main ? main.red : ""), blueN = vs.length===2 ? vs[1] : (main ? main.blue : "");
  const allIn = live.length && done===live.length;
  const lockNm = L ? String(L.side==="red"?L.f.red:L.f.blue).trim().split(/\s+/).pop() : "";
  let lockSub, lockCls = L ? "set" : "";
  if(L){ lockSub = L.hit===null ? (locked?"Pending":"Tap to see it") : L.hit==="push" ? "Push" : L.hit ? "Hit" : "Missed"; if(L.hit===true) lockCls+=" hit"; if(L.hit===false) lockCls+=" miss"; }
  else if(lockMissed(S.uid,c)){ lockSub="Missed"; lockCls="miss"; }
  else lockSub = locked ? "No lock this card" : (done ? "Tap a pick below, then lock it" : "Pick fights first, then lock one");
  const R = 15.5, C = 2*Math.PI*R, frac = live.length ? done/live.length : 0;
  let h = `<div class="ptop">
    <div class="pline"><span>${esc(kicker)}${c.date?` · ${esc(fmtDate(c.date).replace(/,\s*\d{4}$/,""))}`:""}</span>${S.cards.length>1?`<label class="cardsw">Card ▾${cardSelect()}</label>`:""}</div>
    ${redN&&blueN?`<div class="bug"><div><span class="bnm r" style="font-size:${bugSize(redN)}px">${esc(redN)}</span><span class="boct">VS</span><span class="bnm b" style="font-size:${bugSize(blueN)}px">${esc(blueN)}</span></div></div>`:`<h2 class="ptitle">${esc(c.name)}</h2>`}
    ${!locked && c.lock_at ? `<div class="pline"><span>Picks lock in</span><span class="clock" data-lockat="${esc(c.lock_at)}">${clockHTML(c.lock_at)}</span></div>`
      : `<div class="pline"><span>${locked?"Picks locked":"Picks open"}</span>${cw+cl?`<span class="crec"><b>${cw}–${cl}</b> this card</span>`:""}</div>`}
    ${live.length?`<div class="pstat">
      <div class="ring" role="img" aria-label="${done} of ${live.length} picked"><svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="${R}" fill="none" stroke="#2a2e38" stroke-width="4"/><circle cx="18" cy="18" r="${R}" fill="none" stroke="${allIn?"var(--good)":"#FFC23D"}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${(C*frac).toFixed(1)} ${C.toFixed(1)}"/></svg><b>${done}/${live.length}</b></div>
      <button class="biglock ${lockCls}" data-act="golock">${lockSVG}<span><b>${L?`Lock: ${esc(lockNm)}`:"Lock not set"}</b><small>${esc(lockSub)}</small></span></button>
      ${done?`<button class="sharebig" data-act="share">${shareSVG}<span>Share<br>picks</span></button>`:""}
    </div>`:""}
    ${!locked && live.length && (!L || !allIn) ? `<p class="ptip">${!L?"Lock your surest pick. Any missed picks or locks count as wrong.":"Any missed picks count as wrong."}</p>` : ""}
  </div>`;
  if(!live.length) h += emptyHTML("No bouts on this card","Bouts will appear here once they're announced.");

  // cancelled bouts are left off the page (players still get the "fight cancelled" notification)
  live.forEach((f,i)=>{
    const p = pickOf(S.uid,c.id,f.id);
    const isLock = !!(L && L.f.id===f.id);
    const flocked = fightLocked(c,f);
    const res = f.res && f.res.w ? f.res : null;
    const tag = i===0 ? "Main event" : (i===1 ? "Co-main" : "");
    h += `<section class="bout${isLock?" is-lock":""}" data-fid="${esc(f.id)}" aria-label="${esc(f.red)} vs ${esc(f.blue)}">
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
  h += `<div class="panel"><h3>How it works</h3><p class="note" style="margin:0">Pick a winner in every fight to build your record. Then mark one of your picks as your lock of the week; locks keep their own record, and no lock counts as a missed lock. Draws, no contests and cancelled bouts don't count either way. Everyone can see each other's picks and locks anytime. Picks lock when the first fight starts.</p></div>`;
  return h;
}
function fighterBtn(c,f,side,p,locked,res){
  const name = side==="red"?f.red:f.blue;
  const odds = side==="red"?f.oddsRed:f.oddsBlue;
  const won = res && res.w===side, mine = p===side, other = !!p && !mine;
  const rec = S.fighters[name]?.record;
  // split face-off: your side floods with its corner color, the other side fades back
  const tag = won ? `<span class="ftag win">${mine?"Your pick · Won":"Winner"}</span>` : mine ? `<span class="ftag">Your pick</span>` : "";
  return `<button class="fighter ${side}${won?" won":""}${mine?" pick":""}${other&&!won?" out":""}" data-act="pick" data-fight="${esc(f.id)}" data-v="${side}" aria-pressed="${mine}" aria-label="${esc(name)}${side==="red"?", red corner":", blue corner"}" ${locked?"disabled":""}>
    ${tag}${boutHasPhoto(f)?face(name):""}<span class="nm">${side==="red"?flag(name)+esc(name):esc(name)+flag(name)}</span>
    <span class="fsub"><span class="od">${odds!=null?esc(fmtOdds(odds)):"Odds TBA"}</span>${rec?`<span class="rec">${esc(String(rec).replace(/-0$/,""))}</span>`:""}</span></button>`;
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
  const desc = id => `<span><button class="namelink" data-act="player" data-uid="${esc(id)}">${commish(id)}${nameHTML(id)}${crown(id)}</button>${lockRow(id,c.id)?.fight_id===f.id?' <span class="lk">LOCK</span>':""}</span>`;
  // percent bar: each side's share at the ends, "YOU" on your side; tap it to see who picked whom
  const rp = Math.round(red.length/n*100), bp = 100-rp, mine = pickOf(S.uid,c.id,f.id);
  const key = "crowd|"+c.id+"|"+f.id, open = S.openForm.has(key);
  const you = `<span class="you">You</span>`;
  return `<div class="crowd"><button class="crowdbar" data-act="hist" data-key="${esc(key)}" aria-expanded="${open}" aria-label="League picks: ${red.length} ${esc(f.red)}, ${blue.length} ${esc(f.blue)}. Show who picked whom.">
      <span class="cends"><span class="cp r">${mine==="red"?you:""}${rp}%</span><span class="clab">League picks</span><span class="cp b">${mine==="blue"?you:""}${bp}%</span></span>
      <span class="cbar" aria-hidden="true">${red.length?`<i style="width:${rp}%;background:var(--hot-red)"></i>`:""}${blue.length?`<i style="flex:1;background:var(--hot-blue)"></i>`:""}</span></button>
    ${open?`<div class="who"><span style="color:var(--hot-red)">${esc(f.red)} · ${red.length}:</span>${red.map(desc).join("")||"<span>none</span>"}</div>
    <div class="who"><span style="color:var(--hot-blue)">${esc(f.blue)} · ${blue.length}:</span>${blue.map(desc).join("")||"<span>none</span>"}</div>`:""}</div>`;
}

// this week's lock for a player, shown under their name
function lockTag(uid, short){
  const c = currentCard(); if(!c) return "";
  const L = lockInfo(uid,c);
  if(!L) return lockMissed(uid,c) ? `<span class="locktag miss">${lockSVG}<span>No lock · missed</span></span>` : "";
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
    return { id, w:r.w, l:r.l, lw:L&&L.hit===true?1:0, ll:(L&&L.hit===false)||lockMissed(id,c)?1:0, picked:(c.fights||[]).some(f=>pickOf(id,c.id,f.id)) };
  }).filter(r=>r.w+r.l>0 || r.picked);
  const top = cardChamps(c);
  rows.forEach(r=>{ r.champ = top.has(r.id); });
  rows.sort((a,b)=>(b.champ-a.champ) || b.w-a.w || a.l-b.l || b.lw-a.lw || a.ll-b.ll || nameOf(a.id).localeCompare(nameOf(b.id)));
  return rows;
}); }
// the table both views share; tied players (same record and same lock record) share a place: T-2, T-2, then 4
// leaderboard rows as little scorebugs: rank octagon, name (+ belts / this week's lock), record, lock box.
// Tied players share a place (T-2, T-2, then 4). Your own row is repeated in a bar pinned above the tabs.
function boardTable(rows, showLock, allTime){
  const same = (a,b) => !!a && !!b && a.w===b.w && a.l===b.l && a.lw===b.lw && a.ll===b.ll && a.ranked===b.ranked && !!a.champ===!!b.champ;
  let place = 0, h = `<div class="lb">`, mine = null;
  rows.forEach((r,i)=>{
    const unranked = allTime && !r.ranked;
    if(unranked && (i===0 || rows[i-1].ranked)){
      const need = Math.max(1, minCards()), total = scoredCards().length;
      h += `<p class="lbdiv">Not ranked yet · play ${need} of ${total} ${total===1?"card":"cards"} to qualify</p>`;
    }
    if(!same(rows[i-1], r)) place = r.champ ? 1 : i+1;
    const tied = r.champ ? rows.filter(x=>x.champ).length>1 : (same(rows[i-1], r) || same(rows[i+1], r));
    const counted = r.w+r.l>0 || r.champ;
    const tier = unranked || !counted ? "" : place===1 ? "g" : place===2 ? "s" : place===3 ? "b3" : "";
    const rk = unranked ? "–" : `${tied?'<small>T</small>':""}${place}`;
    const gold = allTime ? undefined : !!r.champ;
    const under = allTime ? `<span class="lbsub">${crown(r.id) || `${r.cards} ${r.cards===1?"card":"cards"}`}</span>` : (showLock ? `<span class="lbsub">${lockTag(r.id,true)}</span>` : "");
    const row = `<span class="lboct">${rk}</span>
      <span class="lbwho"><b>${commish(r.id)}${nameHTML(r.id, gold)}</b>${under}</span>
      <span class="lbrec">${r.w}–${r.l}${allTime?`<small>${fmtPct(r)}</small>`:""}</span>
      <span class="lblock">${lockSVG}${r.lw}–${r.ll}</span>`;
    h += `<button class="lbrow ${tier}${unranked?" unranked":""}${r.id===S.uid?" me":""}" data-act="player" data-uid="${esc(r.id)}">${row}</button>`;
    if(r.id===S.uid) mine = { rk, rec:`${r.w}–${r.l}`, pct: allTime ? fmtPct(r) : "", lock:`${r.lw}–${r.ll}` };
  });
  h += `</div>`;
  if(mine) h += `<button class="lbme" data-act="player" data-uid="${esc(S.uid)}"><span class="lboct">${mine.rk}</span><b>You</b><span class="lbrec">${mine.rec}${mine.pct?` <small>${mine.pct}</small>`:""}</span><span class="lblock">${lockSVG}${mine.lock}</span></button>`;
  return h;
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
  h += boardTable(rows, false, true);
  h += `<p class="note">Tap a name to see their picks. Ranked by win %, then most correct picks, fewer misses and the better lock record. To be ranked, play at least half of the cards so far. Cards you skip entirely don't count against you, but on a card you play, a fight you leave blank counts as a miss. Draws, no contests and cancelled bouts don't count.</p>`;
  return h;
}

// last week's winner(s): most correct picks on the most recent fully graded card
function lastWinners(){ return cached("winners", lastWinnersCalc); }
// manual belt calls for specific cards (gold/silver player ids)
const BELT_OVERRIDES = {
  "ufc-fight-night-october-31-2026": { gold:["ca0766ad-8794-4c93-bd7e-85f8729ce20c"], silver:["00867612-1642-4bd0-9e9a-8d3cb66a4e89"] } // ericfriedman gold, Briewe silver
};
function cardPodium(c){
  const O = BELT_OVERRIDES[c.id];
  if(O){ const ids=new Set(O.gold||[]), silver=new Set(O.silver||[]); const rec=id=>cardRecord(id,c).w; return { card:c, ids, silver, best: ids.size?Math.max(...[...ids].map(rec)):0, second: silver.size?Math.max(...[...silver].map(rec)):0 }; }
  let best = 0; const recs = {};
  players().forEach(id=>{ const r = cardRecord(id,c); recs[id]=r; if(r.w>best) best=r.w; });
  const ids = new Set(best>0 ? Object.keys(recs).filter(id=>recs[id].w===best) : []);
  // second place: the next-best number of correct picks (ties all get silver)
  let second = 0;
  Object.values(recs).forEach(r=>{ if(r.w<best && r.w>second) second=r.w; });
  const silver = new Set(second>0 && ids.size===1 ? Object.keys(recs).filter(id=>recs[id].w===second) : []);
  return { card:c, ids, best, silver, second };
}
function gradedCards(){ return S.cards.filter(c=>(c.fights||[]).length && c.fights.every(f=>f.res && f.res.w)).sort((a,b)=>String(b.date).localeCompare(String(a.date))); }
function lastWinnersCalc(){
  const done = gradedCards();
  return done.length ? cardPodium(done[0]) : { card:null, ids:new Set(), silver:new Set() };
}
// numbered cards ("UFC 333: ...") return their number; Fight Nights and anything else return null
function cardNumber(c){ const m = /^UFC\s+(\d+)\b/i.exec(String(c?.name||"").trim()); return m ? m[1] : null; }
// reigning champ(s): first place on the most recent fully graded card, until the next card starts
function champs(){ return cached("champs", ()=>{
  const P = lastWinners(); if(!P.card) return new Set();
  const next = S.cards.some(c=>c.id!==P.card.id && String(c.date) > String(P.card.date) && cardLocked(c));
  return next ? new Set() : P.ids;
}); }
// a card's first place, once every fight on it has a result
function cardChamps(c){ return (c.fights||[]).length && c.fights.every(f=>f.res && f.res.w) ? cardPodium(c).ids : new Set(); }
// a player's name, in glowing gold when they're a champ
function nameHTML(id, gold){ const n = esc(nameOf(id)); return (gold ?? champs().has(id)) ? `<span class="champ">${n}</span>` : n; }
// every belt each player has won: gold for winning a card, silver for second (ties share).
// num: numbered-card belts, each one its own ({m, num, name}); fn: Fight Night belts, counted
function beltCounts(){ return cached("belts", ()=>{
  const out = {};
  const add = (id, m, c) => {
    const B = (out[id] ||= {g:0,s:0,gold:[],silver:[],num:[],fn:{gold:0,silver:0}});
    B[m==="gold"?"g":"s"]++; B[m].push(c.name);
    const n = cardNumber(c);
    if(n) B.num.push({m, num:n, name:c.name}); else B.fn[m]++;
  };
  gradedCards().forEach(c=>{
    const P = cardPodium(c);
    P.ids.forEach(id=>add(id,"gold",c));
    P.silver.forEach(id=>add(id,"silver",c));
  });
  // numbered belts: gold first, then silver; newest card first within each
  Object.values(out).forEach(B=>B.num.sort((a,b)=>(a.m===b.m?0:a.m==="gold"?-1:1) || Number(b.num)-Number(a.num)));
  return out;
}); }
// championship belt: strap, two side plates and an octagon center plate engraved with the card number
// (red strap) or FN for a Fight Night (black strap).
// The gold/silver shine comes from two gradients defined once on the page (beltDefs).
function beltSVG(m, txt){ const g = m==="silver" ? "url(#fwBeltS)" : "url(#fwBeltG)";
  const num = txt && txt!=="FN", strap = num ? "#7E1420" : "#17181c", label = txt || "FN";
  const fs = label.length>=3 ? 10.5 : 11.5;
  return `<svg viewBox="0 0 64 32" aria-hidden="true"><rect x="1" y="10" width="62" height="12" rx="3" fill="${strap}"/><rect x="7" y="11.5" width="8" height="9" rx="1.5" fill="${g}"/><rect x="49" y="11.5" width="8" height="9" rx="1.5" fill="${g}"/><polygon points="25,1 39,1 48,10 48,22 39,31 25,31 16,22 16,10" fill="${g}" stroke="#17181c" stroke-width="1"/><polygon points="26.5,5 37.5,5 44,11.5 44,20.5 37.5,27 26.5,27 20,20.5 20,11.5" fill="none" stroke="#17181c" stroke-opacity=".45" stroke-width="1"/><text x="32" y="16.2" text-anchor="middle" dominant-baseline="central" font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900" font-size="${fs}" fill="#17181c" fill-opacity=".85" letter-spacing="-.5">${esc(label)}</text></svg>`; }
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
// every belt a player has won: numbered-card belts first, each its own (gold, then silver),
// then Fight Night belts: one gold and one silver, with ×N when more than one
function crown(uid){
  const B = beltCounts()[uid]; if(!B) return "";
  const label = [B.g?`${B.g} gold`:"",B.s?`${B.s} silver`:""].filter(Boolean).join(", ");
  const tip = [B.gold.length?`Won ${B.gold.join(", ")}`:"",B.silver.length?`Second at ${B.silver.join(", ")}`:""].filter(Boolean).join(" · ");
  const nums = B.num.map(x=>`<span class="belt ${x.m} num">${beltSVG(x.m, x.num)}</span>`).join("");
  const fn = (m,n) => n ? `<span class="belt ${m}">${beltSVG(m,"FN")}${n>1?`<span class="bx">×${n}</span>`:""}</span>` : "";
  return `<span class="belts" title="${esc(tip)}" role="img" aria-label="${esc(label)} ${B.g+B.s===1?"belt":"belts"}">${nums}${fn("gold",B.fn.gold)}${fn("silver",B.fn.silver)}</span>`;
}
function cardRecord(uid, c){
  let w=0,l=0;
  (c.fights||[]).forEach(f=>{ const g=grade(pickOf(uid,c.id,f.id),f,owes(uid,c)); if(g===1) w++; else if(g===0) l++; });
  return {w,l};
}
// a player's place on a sorted list of rows (tied players share it); null when not ranked
function placeIn(rows, uid, allTime){
  const i = rows.findIndex(r=>r.id===uid); if(i<0) return null;
  const r = rows[i]; if(allTime && !r.ranked) return null;
  const same = (a,b)=>a.w===b.w && a.l===b.l && a.lw===b.lw && a.ll===b.ll && !!a.champ===!!b.champ && a.ranked===b.ranked;
  if(r.champ) return { place:1, tied: rows.filter(x=>x.champ).length>1, of: rows.length };
  const first = rows.findIndex(x=>same(x,r));
  return { place:first+1, tied: rows.filter(x=>same(x,r)).length>1, of: rows.length };
}
const ordinal = n => { const v=n%100; return n+(v>=11&&v<=13?"th":["th","st","nd","rd"][n%10]||"th"); };
// every belt a player has won, newest first: [{m:"gold"|"silver", c:card}]
function beltList(uid){ return gradedCards().flatMap(c=>{ const P=cardPodium(c); return P.ids.has(uid) ? [{m:"gold",c}] : P.silver.has(uid) ? [{m:"silver",c}] : []; }); }
// correct picks on underdogs (plus odds), biggest first
function upsetsOf(uid){
  const hits=[]; let dogs=0;
  for(const c of S.cards) for(const f of (c.fights||[])){
    const side = pickOf(uid,c.id,f.id), r = f.res && f.res.w; if(!side || (r!=="red" && r!=="blue")) continue;
    const o = side==="red" ? f.oddsRed : f.oddsBlue; if(o==null || Number(o)<=0) continue;
    dogs++; if(r===side) hits.push({ o:Number(o), win: side==="red"?f.red:f.blue, over: side==="red"?f.blue:f.red, c });
  }
  return { hits: hits.sort((a,b)=>b.o-a.o), dogs };
}
const cardShort = c => cardNumber(c) ? `UFC ${cardNumber(c)}` : (c.date ? fmtDate(c.date).replace(/,\s*\d{4}$/,"") : "Fight Night");
const mainEvent = c => { const n=String(c.name||""), i=n.indexOf(":"); return i>0 ? n.slice(i+1).trim() : ""; };
function playerHTML(uid, asTab){
  const me = uid===S.uid;
  const rows = standings();
  const r = rows.find(x=>x.id===uid) || {w:0,l:0,lw:0,ll:0,cards:0};
  const pl = placeIn(rows, uid, true), champ = champs().has(uid);
  const joined = S.profiles[uid]?.created_at ? new Date(S.profiles[uid].created_at).toLocaleDateString(undefined,{month:"short",year:"numeric"}) : "";
  const metaBits = [champ?"Champ":"", pl?`${pl.tied?"T-":""}${ordinal(pl.place)} of ${pl.of}`:"Not ranked yet", joined?`Since ${joined}`:""].filter(Boolean);
  // fighter card header
  let h = `${asTab?"":`<button class="backbtn" data-act="back">‹ Leaders</button>`}
  <section class="phero${champ?" champ":""}">
    <div class="phtop">${avatar(uid)}<div class="phid"><h2>${commish(uid)}${nameHTML(uid)}${me?` <span class="pyou">You</span>`:""}</h2><div class="phmeta">${metaBits.map(esc).join(" · ")}</div>${lockTag(uid)}</div></div>
    <div class="tape"><div><b>${r.w}–${r.l}</b><span>Record</span></div><div><b>${r.w+r.l?fmtPct(r):"–"}</b><span>Win %</span></div><div class="tl"><b>${r.lw}–${r.ll}</b><span>Locks</span></div><div><b>${r.cards||0}</b><span>Cards</span></div></div>
  </section>`;
  // belt case
  const belts = beltList(uid);
  if(belts.length){
    h += `<div class="psec"><span>Belts</span><span>${belts.length}</span></div><div class="beltcase">${belts.map(b=>`<div class="bcase ${b.m}"><span class="belt ${b.m}${cardNumber(b.c)?" num":""}">${beltSVG(b.m, cardNumber(b.c)||"FN")}</span><b>${esc(cardNumber(b.c)?`UFC ${cardNumber(b.c)}`:"Fight Night")}</b><small>${esc([mainEvent(b.c), b.m==="silver"?"Silver":"", b.c.date?fmtDate(b.c.date).replace(/,\s*\d{4}$/,""):""].filter(Boolean).join(" · "))}</small></div>`).join("")}</div>`;
  }
  // biggest upsets
  const U = upsetsOf(uid);
  if(U.dogs){
    h += `<div class="psec"><span>Biggest upsets</span><span>${U.hits.length} of ${U.dogs} underdog${U.dogs===1?"":"s"} hit</span></div>`;
    h += U.hits.length ? `<div class="ups">${U.hits.slice(0,3).map(x=>`<div class="up"><span class="uodds">${esc(fmtOdds(x.o))}</span><span class="uwho"><b>${esc(x.win)}</b><small>over ${esc(x.over)}</small></span><span class="ucard">${esc(cardShort(x.c))}</span></div>`).join("")}</div>` : `<p class="note">No underdog picks have hit yet.</p>`;
  }
  // recent cards: record and where they finished
  const recent = scoredCards().slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,4);
  if(recent.length){
    h += `<div class="psec"><span>Recent cards</span></div><div class="pform">${recent.map(x=>{
      if(!played(uid,x)) return `<span class="skip"><b>–</b><small>${esc(cardShort(x))}</small><small class="pl">Skipped</small></span>`;
      const cr = cardRecord(uid,x), wp = placeIn(weekStandings(x), uid, false), done = (x.fights||[]).every(f=>f.res && f.res.w);
      const won = done && cardPodium(x).ids.has(uid);
      return `<span class="${won?"win":""}"><b>${cr.w}–${cr.l}</b><small>${esc(cardShort(x))}</small>${wp&&done?`<small class="pl">${wp.tied?"T-":""}${ordinal(wp.place)}</small>`:""}</span>`;
    }).join("")}</div>`;
  }
  h += `<div class="psec"><span>Picks by card</span></div>`;
  const c = currentCard();
  if(!c) return h + emptyHTML("No cards yet","Their picks will show up here once a card is posted.");

  // card-by-card record
  const past = S.cards.filter(x=>cardLocked(x));
  if(past.length){
    h += `<div class="cardhist">${past.map(x=>{
      const cr = cardRecord(uid,x), L = lockInfo(uid,x);
      const lk = L ? (L.hit===null?"lock pending":L.hit==="push"?"lock push":L.hit?"lock hit":"lock missed") : lockMissed(uid,x) ? "no lock · missed" : "no lock";
      const rec = played(uid,x) ? `<span class="nw">${cr.w}–${cr.l}</span> · ${lk}` : "didn't play";
      return `<button class="ch ${x.id===c.id?"on":""}" data-act="pcard" data-card="${esc(x.id)}"><span class="ch-n">${esc(x.name)}</span><span class="ch-r">${rec}</span></button>`;
    }).join("")}</div>`;
  }

  h += `<div class="pline"><span>${esc(c.name)}</span>${S.cards.length>1?`<label class="cardsw">Card ▾${cardSelect()}</label>`:""}</div>`;
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

/* ---------- share my picks: a phone-story image (1080×1920) of every matchup, your side lit up, lock on top ---------- */
// fighter photos come through our own address (see vercel.json) so the browser lets us draw them into the image
function photoProxy(u){
  if(!u) return null;
  let m = /^https:\/\/(?:www\.)?ufc\.com\/images\/(.+)$/.exec(u); if(m) return "/fphoto/ufc/" + m[1];
  m = /^https:\/\/upload\.wikimedia\.org\/(.+)$/.exec(u); if(m) return "/fphoto/wm/" + m[1];
  return null;
}
function loadImg(src){ return new Promise(res=>{ if(!src) return res(null); const i=new Image(); i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; setTimeout(()=>res(null), 8000); }); }
async function buildShareImage(uid, c, withPhotos){
  const W=1080, H=1920, X=44;
  const cv=document.createElement("canvas"); cv.width=W; cv.height=H; const g=cv.getContext("2d");
  const DISP='"Big Shoulders Display","Arial Narrow",Impact,sans-serif', LAB='"Barlow Condensed","Arial Narrow",sans-serif', BODY='Barlow,system-ui,sans-serif';
  try{ await Promise.all(['900 80px "Big Shoulders Display"','700 30px "Barlow Condensed"','600 30px Barlow','500 30px Barlow'].map(f=>document.fonts.load(f))); }catch(e){}
  const C={bg:"#111318",panel:"#1A1D24",line:"#2C303A",ink:"#ECEEF3",muted:"#9AA0AE",dim:"#5B606C",gold:"#E0B154",red:"#F0566A",blue:"#6E95F0"};
  const rr=(x,y,w,h,r)=>{ g.beginPath(); g.moveTo(x+r,y); g.arcTo(x+w,y,x+w,y+h,r); g.arcTo(x+w,y+h,x,y+h,r); g.arcTo(x,y+h,x,y,r); g.arcTo(x,y,x+w,y,r); g.closePath(); };
  const fit=(txt,font,size,max)=>{ let s=size; do{ g.font=font.replace("$",s); if(g.measureText(txt).width<=max) break; s-=2; }while(s>12); return s; };
  const clip=(txt,max)=>{ if(g.measureText(txt).width<=max) return txt; while(txt.length>1 && g.measureText(txt+"…").width>max) txt=txt.slice(0,-1); return txt+"…"; };

  // background + header band (red / dark / blue, like the site header)
  g.fillStyle=C.bg; g.fillRect(0,0,W,H);
  const band=300;
  g.save(); g.beginPath(); g.rect(0,0,W,band); g.clip();
  g.fillStyle="#3a1a20"; g.fillRect(0,0,W,band);
  g.fillStyle="#0c0d10"; g.beginPath(); g.moveTo(W*.42,0); g.lineTo(W*.66,0); g.lineTo(W*.56,band); g.lineTo(W*.32,band); g.closePath(); g.fill();
  g.fillStyle="#1d2a4a"; g.beginPath(); g.moveTo(W*.66,0); g.lineTo(W,0); g.lineTo(W,band); g.lineTo(W*.56,band); g.closePath(); g.fill();
  g.restore();
  g.fillStyle=C.gold; g.font=`700 30px ${LAB}`; g.textBaseline="alphabetic"; if("letterSpacing" in g) g.letterSpacing="6px";
  g.fillText("FIGHT WEEK", X, 84); if("letterSpacing" in g) g.letterSpacing="0px";
  const nm = String(c.name||"");
  const ix = nm.indexOf(":");
  const l1 = (ix>0 ? nm.slice(0,ix).replace(/^UFC Fight Night$/i,"Fight Night") : "").toUpperCase();
  const l2 = (ix>0 ? nm.slice(ix+1) : nm).trim().toUpperCase();
  g.fillStyle="#fff";
  let s1 = l1 ? fit(l1,`900 $px ${DISP}`,76,W-2*X) : 0; if(l1){ g.font=`900 ${s1}px ${DISP}`; g.fillText(l1, X, 160); }
  const s2 = fit(l2,`900 $px ${DISP}`,76,W-2*X); g.font=`900 ${s2}px ${DISP}`; g.fillText(l2, X, l1?232:180);
  g.font=`600 30px ${BODY}`; const who=nameOf(uid); g.fillStyle="#fff"; g.fillText(who, X, 276);
  const ww=g.measureText(who).width; g.fillStyle="rgba(255,255,255,.7)"; g.font=`500 30px ${BODY}`;
  g.fillText(`'s picks${c.date?" · "+fmtDate(c.date):""}`, X+ww, 276);

  // rows: lock first, then the card in order
  const live=(c.fights||[]).filter(f=>!isOff(f));
  const L=lockInfo(uid,c);
  const order = L ? [L.f, ...live.filter(f=>f.id!==L.f.id)] : live;
  const photos = {};
  if(withPhotos){
    const names=[...new Set(order.flatMap(f=>[f.red,f.blue]))];
    const imgs=await Promise.all(names.map(n=>loadImg(photoProxy(S.fighters[n]?.photo_url))));
    names.forEach((n,i)=>{ if(imgs[i]) photos[n]={img:imgs[i], ufc:/ufc\.com/.test(S.fighters[n]?.photo_url||"")}; });
  }
  const top=band+40, bottom=H-120, gap=12, n=order.length||1;
  const lockExtra = L ? 1.3 : 1;
  const rh = Math.min(118, (bottom-top-gap*(n-1)) / (n-1+lockExtra));
  let y=top;
  const face=(name, cx, cy, r, side, picked, lock)=>{
    g.save(); g.beginPath(); g.arc(cx,cy,r,0,Math.PI*2); g.closePath();
    g.fillStyle = side==="red" ? "#3A1C22" : "#1A2540"; g.fill(); g.clip();
    const P=photos[name];
    if(P){ const im=P.img, box=r*2, x0=cx-r, y0=cy-r; const sc=Math.max(box/im.width, box/im.height); let dw=im.width*sc, dh=im.height*sc;
      let dx=(box-dw)*.5, dy=(box-dh)*(P.ufc?0:.2);
      if(P.ufc){ const z=1.35, ox=box*.5, oy=box*.08; dx=ox+(dx-ox)*z; dy=oy+(dy-oy)*z; dw*=z; dh*=z; }
      g.drawImage(im, x0+dx, y0+dy, dw, dh);
    } else {
      g.fillStyle = side==="red" ? C.red : C.blue; g.globalAlpha=.9; g.font=`900 ${Math.round(r*.8)}px ${DISP}`; g.textAlign="center"; g.textBaseline="middle";
      g.fillText(String(name).split(/\s+/).filter(Boolean).map(w=>w[0]).slice(0,2).join("").toUpperCase(), cx, cy+2); g.globalAlpha=1; g.textAlign="left"; g.textBaseline="alphabetic";
    }
    if(!picked){ g.fillStyle="rgba(17,19,24,.62)"; g.fillRect(cx-r,cy-r,r*2,r*2); }
    g.restore();
    if(picked){ g.save(); g.lineWidth = lock?7:5; g.strokeStyle = lock?C.gold:(side==="red"?C.red:C.blue);
      if(lock){ g.shadowColor="rgba(224,177,84,.8)"; g.shadowBlur=24; }
      g.beginPath(); g.arc(cx,cy,r+1,0,Math.PI*2); g.stroke(); g.restore(); }
  };
  const lockIcon=(x,y,s,col)=>{ g.save(); g.strokeStyle=col; g.lineWidth=s*.13; g.lineCap="round"; g.lineJoin="round";
    rr(x, y+s*.42, s*.8, s*.56, s*.1); g.stroke(); g.beginPath(); g.moveTo(x+s*.18,y+s*.42); g.lineTo(x+s*.18,y+s*.28); g.arc(x+s*.4,y+s*.28,s*.22,Math.PI,0); g.lineTo(x+s*.62,y+s*.42); g.stroke(); g.restore(); };

  order.forEach((f,i)=>{
    const lock = !!(L && L.f.id===f.id), h = lock ? rh*1.3 : rh, p = pickOf(uid,c.id,f.id);
    g.save(); rr(X, y, W-2*X, h, 20);
    if(lock){ const gr=g.createLinearGradient(X,0,W-X,0); gr.addColorStop(0,"rgba(224,177,84,.24)"); gr.addColorStop(1,"rgba(224,177,84,.06)");
      g.shadowColor="rgba(224,177,84,.35)"; g.shadowBlur=40; g.fillStyle=C.panel; g.fill(); g.shadowBlur=0; g.fillStyle=gr; g.fill(); g.lineWidth=3; g.strokeStyle=C.gold; g.stroke(); }
    else { g.fillStyle=C.panel; g.fill(); g.lineWidth=2; g.strokeStyle=C.line; g.stroke(); }
    g.restore();
    const r = h*.36, pad = 18, cy = y+h/2;
    face(f.red, X+pad+r, cy, r, "red", p==="red", lock && p==="red");
    face(f.blue, W-X-pad-r, cy, r, "blue", p==="blue", lock && p==="blue");
    const midX=W/2, nameMax = (W-2*X)/2 - (pad+2*r+22) - 34;
    g.fillStyle=C.muted; g.font=`700 ${Math.round(Math.max(20,h*.2))}px ${LAB}`; g.textAlign="center"; g.textBaseline="middle"; g.fillText("VS", midX, cy+1);
    [["red", X+pad+2*r+20, "left"], ["blue", W-X-pad-2*r-20, "right"]].forEach(([side, x, al])=>{
      const picked = p===side, name = side==="red"?f.red:f.blue;
      const size = Math.round(lock ? h*.27 : h*.27);
      g.textAlign=al; g.textBaseline="middle";
      g.font = `${picked?"600":"500"} ${size}px ${BODY}`;
      g.fillStyle = picked ? (lock ? C.gold : C.ink) : C.dim;
      const t = clip(name, nameMax);
      if(lock && picked){
        const ls=Math.round(h*.17); g.font=`700 ${ls}px ${LAB}`; g.fillStyle=C.gold; if("letterSpacing" in g) g.letterSpacing="3px";
        const lw=g.measureText("LOCK").width, ix2 = al==="left" ? x : x-lw-ls*1.1;
        lockIcon(ix2, cy-h*.3, ls*.95, C.gold); g.textAlign="left"; g.fillText("LOCK", ix2+ls*1.1, cy-h*.22+ls*.45); if("letterSpacing" in g) g.letterSpacing="0px";
        g.textAlign=al; g.font=`700 ${size}px ${BODY}`; g.fillStyle=C.gold; g.fillText(clip(name,nameMax), x, cy+h*.14);
      } else g.fillText(t, x, cy+1);
    });
    g.textAlign="left"; g.textBaseline="alphabetic";
    y += h + gap;
  });

  // footer
  g.fillStyle=C.line; g.fillRect(X, H-96, W-2*X, 2);
  const picked = live.filter(f=>pickOf(uid,c.id,f.id)).length;
  g.fillStyle=C.muted; g.font=`500 28px ${BODY}`; g.fillText(`${picked} of ${live.length} picked · ${L?"1 lock":"no lock"}`, X, H-44);
  g.fillStyle=C.gold; g.font=`700 28px ${LAB}`; g.textAlign="right"; if("letterSpacing" in g) g.letterSpacing="5px"; g.fillText("FIGHT WEEK", W-X, H-44); if("letterSpacing" in g) g.letterSpacing="0px"; g.textAlign="left";

  return new Promise((res,rej)=>{ try{ cv.toBlob(b=>b?res(b):rej(new Error("no image")), "image/png"); }catch(e){ rej(e); } });
}
let shareBusy=false;
async function sharePicks(c){
  if(shareBusy || !c) return; shareBusy=true; toast("Making your picks image…");
  let blob;
  try { blob = await buildShareImage(S.uid, c, true); }
  catch(e){ try { blob = await buildShareImage(S.uid, c, false); } catch(e2){ shareBusy=false; toast("Couldn't make the image. Try again."); return; } }
  shareBusy=false;
  const short = String(c.name||"picks").split(":")[0].trim().replace(/\s+/g,"-").toLowerCase();
  const file = new File([blob], `fight-week-${short}.png`, { type:"image/png" });
  const url = URL.createObjectURL(blob);
  const canShare = !!(navigator.canShare && navigator.canShare({ files:[file] }));
  const el = document.createElement("div"); el.className="sharesheet"; el.setAttribute("role","dialog"); el.setAttribute("aria-label","Your picks image");
  el.innerHTML = `<div class="ss-inner"><img src="${url}" alt="Your picks for ${esc(c.name)}"><div class="ss-btns">
    ${canShare?`<button class="btn gold" data-ss="share">Save or share</button>`:`<a class="btn gold" href="${url}" download="${esc(file.name)}">Download image</a>`}
    <button class="btn ghost" data-ss="close">Close</button></div>
    <p class="note">${isIOS()?"Or press and hold the image and tap Save to Photos.":"Or right-click the image to save it."}</p></div>`;
  const close = ()=>{ el.remove(); URL.revokeObjectURL(url); document.removeEventListener("keydown", onKey); };
  const onKey = e=>{ if(e.key==="Escape") close(); };
  el.addEventListener("click", async e=>{
    const b=e.target.closest("[data-ss]");
    if(!b){ if(e.target===el) close(); return; }
    if(b.dataset.ss==="close") close();
    if(b.dataset.ss==="share"){ try{ await navigator.share({ files:[file], title:"My Fight Week picks" }); }catch(err){} }
  });
  document.addEventListener("keydown", onKey);
  clearTimeout(toast._t); $("#toast").hidden=true;
  document.body.appendChild(el);
}

/* ---------- events ---------- */
/* ---------- bottom tabs ---------- */
const NAV_ICONS = {
  profile:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>',
  community:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>',
  picks:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><polygon points="8,2.5 16,2.5 21.5,8 21.5,16 16,21.5 8,21.5 2.5,16 2.5,8"/><path d="m8 12 3 3 5-6" stroke-linecap="round"/></svg>',
  board:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  bell:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
  out:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/></svg>'
};
const TAB_LABELS = { profile:"Profile", community:"Community", picks:"Picks", board:"Leaders", settings:"Settings" };
(function buildNav(){
  $("#bn").innerHTML = TABS.map(t=>`<button role="tab" data-tab="${t}" aria-label="${TAB_LABELS[t]}" aria-selected="false">${NAV_ICONS[t]}<span>${TAB_LABELS[t]}</span></button>`).join("");
  $("#bn-dots").innerHTML = TABS.map(()=>"<i></i>").join("");
})();
$("#me").addEventListener("click", e=>{ if(e.target.closest("[data-go]")) setTab("profile", false); });
$("#bn").addEventListener("click", e=>{
  const t=e.target.closest("button[data-tab]"); if(!t) return;
  if(t.dataset.tab===S.tab){ S.viewUser=null; S.page=null; render(); window.scrollTo({top:0,behavior:"smooth"}); return; } // tap the tab you're on: back to its top
  setTab(t.dataset.tab);
});
// swipe left/right anywhere on the page to move between tabs.
// The direction locks after a few pixels, so scrolling up and down never flips tabs.
// Swipes that start at the very edge are left to the phone (iPhone's swipe-back), and so are
// swipes on inputs, dropdowns and anything that scrolls sideways.
(function swipeTabs(){
  let x0=0, y0=0, t0=0, mode=null, dx=0;
  const app = $("#app");
  const scrollsSideways = el => { for(let n=el; n && n!==document.body; n=n.parentElement){ const o=getComputedStyle(n).overflowX; if((o==="auto"||o==="scroll") && n.scrollWidth > n.clientWidth+2) return true; } return false; };
  const blocked = el => !!el.closest("input,textarea,select,.sharesheet,#bn,[data-noswipe]") || scrollsSideways(el);
  const idx = () => TABS.indexOf(S.tab);
  document.addEventListener("touchstart", e=>{
    // pinched in: let the finger pan around the zoomed page instead of switching tabs
    const zoomed = window.visualViewport && window.visualViewport.scale > 1.01;
    if(!S.uid || zoomed || e.touches.length!==1 || blocked(e.target)){ mode="off"; return; }
    const t=e.touches[0]; x0=t.clientX; y0=t.clientY; t0=Date.now(); dx=0;
    mode = (x0 < 22 || x0 > window.innerWidth-22) ? "off" : null;
  }, {passive:true});
  document.addEventListener("touchmove", e=>{
    if(mode==="off" || mode==="y") return;
    const t=e.touches[0], mx=t.clientX-x0, my=t.clientY-y0;
    if(mode===null){
      if(Math.abs(mx)<10 && Math.abs(my)<10) return;
      mode = Math.abs(mx) > Math.abs(my)*1.2 ? "x" : "y";
      if(mode==="y") return;
      app.style.transition="none";
    }
    e.preventDefault();
    const edge = (mx>0 && idx()===0) || (mx<0 && idx()===TABS.length-1);
    dx = edge ? mx*0.25 : mx;   // rubber-band at the first and last tab
    app.style.transform=`translateX(${dx}px)`;
  }, {passive:false});
  document.addEventListener("touchend", ()=>{
    if(mode!=="x"){ mode=null; return; }
    mode=null;
    const W=window.innerWidth, v=Math.abs(dx)/Math.max(1,Date.now()-t0);
    const dir = dx<0 ? 1 : -1, next = TABS[idx()+dir];
    if(next && (Math.abs(dx) > W*0.22 || (v>0.45 && Math.abs(dx)>40))){
      app.style.transition="transform .16s ease-in"; app.style.transform=`translateX(${-dir*W}px)`;
      setTimeout(()=>{
        setTab(next);
        app.style.transition="none"; app.style.transform=`translateX(${dir*W*0.35}px)`;
        requestAnimationFrame(()=>requestAnimationFrame(()=>{ app.style.transition="transform .2s ease-out"; app.style.transform=""; }));
      }, 150);
    } else { app.style.transition="transform .2s ease-out"; app.style.transform=""; }
  });
})();
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
  if(act==="player"){ if(b.dataset.uid===S.uid){ setTab("profile", false); return; } tabScroll[S.tab]=window.scrollY; S.tab="board"; S.page=null; S.viewUser=b.dataset.uid; try{ localStorage.setItem("op-tab","board"); }catch(err){} render(); window.scrollTo(0,0); return; }
  if(act==="back"){ S.viewUser=null; render(); return; }
  if(act==="pcard"){ S.cardId=b.dataset.card; render(); return; }
  if(act==="hist"){ const k=b.dataset.key; S.openForm.has(k)?S.openForm.delete(k):S.openForm.add(k); render(); return; }
  const c=currentCard(); if(!c) return;
  if(act==="share"){ sharePicks(c); return; }
  if(act==="golock"){ const L=lockInfo(S.uid,c); const f=L ? L.f : (c.fights||[]).find(x=>!isOff(x) && pickOf(S.uid,c.id,x.id)) || (c.fights||[]).find(x=>!isOff(x)); const el=f && document.querySelector(`.bout[data-fid="${CSS.escape(f.id)}"]`); if(el) el.scrollIntoView({behavior:"smooth",block:"center"}); return; }
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
