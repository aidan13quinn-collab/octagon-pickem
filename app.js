(() => {
"use strict";

const sb = window.supabase.createClient(window.OP_CONFIG.supabaseUrl, window.OP_CONFIG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const S = {
  session: null, uid: null,
  cards: [], profiles: {}, picks: [], locks: [],
  tab: "picks", cardId: null, authMode: "signin", loaded: false, viewUser: null, fighters: {}, openForm: new Set()
};
try { const t = localStorage.getItem("op-tab"); if (t === "picks" || t === "board") S.tab = t; } catch (e) {}

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

// pick lookups
function pickOf(uid, cardId, fightId){ return S.picks.find(p=>p.user_id===uid && p.card_id===cardId && p.fight_id===fightId)?.side || null; }
function lockRow(uid, cardId){ return S.locks.find(l=>l.user_id===uid && l.card_id===cardId) || null; }
// 1 = correct, 0 = wrong, null = not graded / doesn't count
function grade(side, f){
  if(!side || !f.res || !f.res.w) return null;
  if(f.res.w==="cancelled" || f.res.w==="draw") return null;
  return side===f.res.w ? 1 : 0;
}
function lockInfo(uid, c){
  const l = lockRow(uid, c.id); if(!l) return null;
  const f = (c.fights||[]).find(x=>x.id===l.fight_id); if(!f || isOff(f)) return null;
  const side = pickOf(uid, c.id, f.id); if(!side) return null;
  let hit = null;
  if(f.res && f.res.w) hit = f.res.w==="draw" ? "push" : f.res.w===side;
  return { f, side, odds: side==="red"?f.oddsRed:f.oddsBlue, hit };
}

function players(){
  const ids = new Set(Object.keys(S.profiles));
  S.picks.forEach(p=>ids.add(p.user_id));
  return [...ids];
}
function standings(){
  const rows = players().map(id=>{
    let w=0,l=0,lw=0,ll=0;
    for(const c of S.cards){
      for(const f of (c.fights||[])){
        const g = grade(pickOf(id,c.id,f.id), f);
        if(g===1) w++; else if(g===0) l++;
      }
      const L = lockInfo(id,c);
      if(L && L.hit===true) lw++; else if(L && L.hit===false) ll++;
    }
    return {id,w,l,lw,ll};
  });
  rows.sort((a,b)=>b.w-a.w || a.l-b.l || b.lw-a.lw || a.ll-b.ll || nameOf(a.id).localeCompare(nameOf(b.id)));
  return rows;
}

/* ---------- data ---------- */
async function loadAll(){
  const [cards, profiles, picks, locks, fighters] = await Promise.all([
    sb.from("cards").select("*").order("date",{ascending:false}),
    sb.from("profiles").select("id,display_name"),
    sb.from("picks").select("user_id,card_id,fight_id,side"),
    sb.from("locks").select("user_id,card_id,fight_id"),
    sb.from("fighters").select("name,record,recent")
  ]);
  const err = cards.error || profiles.error || picks.error || locks.error;
  if(err){ toast("Couldn't load the league. Pull to refresh."); console.error(err); }
  S.cards = cards.data || [];
  S.profiles = Object.fromEntries((profiles.data||[]).map(p=>[p.id,p]));
  S.picks = picks.data || [];
  S.locks = locks.data || [];
  S.fighters = Object.fromEntries((fighters.data||[]).map(f=>[f.name,f]));
  S.loaded = true;
  render();
}
let reloadTimer = null;
function scheduleReload(){ clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 400); }
let channel = null;
function subscribe(){
  if(channel) return;
  channel = sb.channel("league")
    .on("postgres_changes",{event:"*",schema:"public",table:"cards"},scheduleReload)
    .on("postgres_changes",{event:"*",schema:"public",table:"picks"},scheduleReload)
    .on("postgres_changes",{event:"*",schema:"public",table:"locks"},scheduleReload)
    .on("postgres_changes",{event:"*",schema:"public",table:"profiles"},scheduleReload)
    .on("postgres_changes",{event:"*",schema:"public",table:"fighters"},scheduleReload)
    .subscribe();
}
function unsubscribe(){ if(channel){ sb.removeChannel(channel); channel=null; } }

async function setPick(c, f, side){
  const prev = pickOf(S.uid, c.id, f.id);
  if(prev===side) return;
  // optimistic
  S.picks = S.picks.filter(p=>!(p.user_id===S.uid && p.card_id===c.id && p.fight_id===f.id));
  S.picks.push({user_id:S.uid, card_id:c.id, fight_id:f.id, side});
  render();
  const { error } = await sb.from("picks").upsert({user_id:S.uid, card_id:c.id, fight_id:f.id, side, updated_at:new Date().toISOString()});
  if(error){ toast(cardLocked(c) ? "Picks are locked for this card." : "Couldn't save that pick. Try again."); loadAll(); }
}
async function toggleLock(c, f){
  const cur = lockRow(S.uid, c.id);
  if(cur && cur.fight_id===f.id){
    S.locks = S.locks.filter(l=>!(l.user_id===S.uid && l.card_id===c.id)); render();
    const { error } = await sb.from("locks").delete().match({user_id:S.uid, card_id:c.id});
    if(error){ toast("Couldn't remove your lock. Try again."); loadAll(); }
    return;
  }
  S.locks = S.locks.filter(l=>!(l.user_id===S.uid && l.card_id===c.id));
  S.locks.push({user_id:S.uid, card_id:c.id, fight_id:f.id}); render();
  const { error } = await sb.from("locks").upsert({user_id:S.uid, card_id:c.id, fight_id:f.id, updated_at:new Date().toISOString()});
  if(error){ toast(cardLocked(c) ? "Locks are closed for this card." : "Couldn't save your lock. Try again."); loadAll(); }
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
    $("#me").innerHTML = `<span class="who-am-i">${avatar(S.uid)}<span id="me-name"></span></span><button class="linkbtn" data-act="signout">Sign out</button>`;
    $("#me-name").textContent = nameOf(S.uid);
    document.querySelectorAll(".tab").forEach(t=>t.setAttribute("aria-selected", String(t.dataset.tab===S.tab)));
  }
  preserve(()=>{
    const app = $("#app");
    if(!signedIn){ app.innerHTML = authHTML(); return; }
    if(!S.loaded){ app.innerHTML = emptyHTML("Loading the card","Connecting to your league."); return; }
    app.innerHTML = S.tab==="board" ? boardHTML() : picksHTML();
  });
}

function authHTML(){
  const up = S.authMode==="signup";
  return `<section class="auth">
    <div class="switch" role="group" aria-label="Sign in or create an account">
      <button data-act="mode" data-v="signin" aria-pressed="${!up}">Sign in</button>
      <button data-act="mode" data-v="signup" aria-pressed="${up}">Join the league</button>
    </div>
    <form id="auth-form" class="panel" novalidate>
      <h3>${up?"Create your account":"Welcome back"}</h3>
      ${up?`<div class="field"><label class="label" for="a-name">Display name</label><input id="a-name" maxlength="30" autocomplete="nickname" placeholder="What your friends call you" required></div>`:""}
      <div class="field"><label class="label" for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
      <div class="field"><label class="label" for="a-pass">Password</label><input id="a-pass" type="password" autocomplete="${up?"new-password":"current-password"}" minlength="6" required></div>
      <p class="err" id="a-err" hidden></p><p class="ok" id="a-ok" hidden></p>
      <button class="btn gold" type="submit" id="a-submit">${up?"Join the league":"Sign in"}</button>
      ${up?`<p class="note" style="margin:0">Passwords need at least 6 characters.</p>`:""}
    </form>
  </section>`;
}

function currentCard(){
  if(!S.cards.length) return null;
  let c = S.cards.find(x=>x.id===S.cardId);
  if(!c){
    // default: the soonest card that hasn't locked yet, otherwise the most recent
    const open = S.cards.filter(x=>!cardLocked(x)).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    c = open[0] || S.cards[0];
    S.cardId = c.id;
  }
  return c;
}
function cardSelect(){
  if(S.cards.length<2) return "";
  return `<select id="sel-card" aria-label="Fight card">${S.cards.map(c=>`<option value="${esc(c.id)}" ${c.id===S.cardId?"selected":""}>${esc(c.name)}${c.date?" · "+esc(fmtDate(c.date)):""}</option>`).join("")}</select>`;
}

function picksHTML(){
  const c = currentCard();
  if(!c) return emptyHTML("No fight card yet","The next UFC card is added automatically. Check back soon.");
  const fights = c.fights||[];
  const live = fights.filter(f=>!isOff(f));
  const done = live.filter(f=>pickOf(S.uid,c.id,f.id)).length;
  const L = lockInfo(S.uid, c);
  let cw=0, cl=0;
  fights.forEach(f=>{ const g=grade(pickOf(S.uid,c.id,f.id),f); if(g===1) cw++; else if(g===0) cl++; });
  const locked = cardLocked(c);

  let h = `<div class="cardpick"><div class="event-head">
      <h2>${esc(c.name)}</h2>
      ${c.date?`<span class="label">${esc(fmtDate(c.date))}</span>`:""}
      <span class="pill ${locked?"locked":"open"}">${locked?"Picks locked":(c.lock_at?`Picks lock ${esc(fmtLockAt(c))}`:"Picks open")}</span>
      ${cw+cl?`<span class="pill gold">${cw}–${cl} this card</span>`:""}
    </div>${cardSelect()}</div>`;

  if(fights.length){
    const nm = L ? (L.side==="red"?L.f.red:L.f.blue) : "";
    h += `<div class="lockstrip ${L?"set":""}"><span class="lockicon" aria-hidden="true">${lockSVG}</span>
      <span class="ls-t">${L?`Lock: ${esc(nm)}`:(locked?"No lock this week":"Lock of the week")}</span>
      <span class="ls-v">${L?(L.hit===null?"Pending":L.hit==="push"?"Push":L.hit?"Hit":"Missed"):(locked?"":"Pick a fighter, then lock it")}</span></div>`;
  }
  if(!locked && live.length) h += `<p class="note">${done} of ${live.length} picked. Picks save automatically and lock when the first fight starts.</p>`;
  if(!fights.length) h += emptyHTML("No bouts on this card","Bouts will appear here once they're announced.");

  fights.forEach((f,i)=>{
    const p = pickOf(S.uid,c.id,f.id);
    const isLock = !!(L && L.f.id===f.id);
    if(isOff(f)){
      const myLock = lockRow(S.uid,c.id)?.fight_id===f.id;
      h += `<section class="bout off" aria-label="${esc(f.red)} vs ${esc(f.blue)}, cancelled">
        <div class="bout-meta"><span class="label">${esc(f.weight||"Bout")}</span><span class="pill locked">Cancelled</span></div>
        <div class="offnames"><s>${esc(f.red)}</s> <span class="vs">VS</span> <s>${esc(f.blue)}</s></div>
        <p class="note" style="margin:0">This bout is off the card. ${p?"Your pick doesn't count either way.":"It doesn't count for anyone."}${myLock?" Your lock on it is void, so you can lock another pick.":""}</p></section>`;
      return;
    }
    const flocked = fightLocked(c,f);
    const res = f.res && f.res.w ? f.res : null;
    const tag = i===0 ? "Main event" : (i===1 ? "Co-main" : "");
    h += `<section class="bout${isLock?" is-lock":""}" aria-label="${esc(f.red)} vs ${esc(f.blue)}">
      <div class="bout-meta"><span class="label">${esc(tag?tag+" · ":"")}${esc(f.weight||"Bout")} · ${f.rounds||3} rds</span>
        ${isLock?`<span class="pill gold">Lock of the week</span>`:""}</div>
      <div class="corners">${fighterBtn(c,f,"red",p,flocked,res)}<span class="vs">VS</span>${fighterBtn(c,f,"blue",p,flocked,res)}</div>`;
    if(p && !flocked){
      const nm = p==="red"?f.red:f.blue;
      h += `<div class="chips"><button class="chip lockchip" data-act="lock" data-fight="${esc(f.id)}" aria-pressed="${isLock}">${lockSVG}<span>${isLock?`Locked: ${esc(nm)}`:"Make this my lock"}</span></button>${isLock?'<span class="note">Tap to remove</span>':(L?'<span class="note">Moves your lock here</span>':"")}</div>`;
    } else if(!p && !flocked){
      h += `<p class="note" style="margin:0">Tap a fighter to pick the winner.</p>`;
    }
    if(res){
      const g = grade(p,f);
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
    <span class="cn">${side==="red"?"Red corner":"Blue corner"}${won?" · Winner":""}</span><span class="nm">${esc(name)}</span>
    <span class="od">${odds!=null?esc(fmtOdds(odds)):"Odds TBA"}</span>${formStrip(name)}</button>`;
}
// last-5 UFC results as little W/L chips, newest first
function formStrip(name){
  const fx = S.fighters[name]; if(!fx) return "";
  if(!fx.recent || !fx.recent.length) return `<span class="form"><span class="form-debut">UFC debut</span></span>`;
  return `<span class="form" aria-label="Last ${fx.recent.length} UFC fights">${fx.recent.map(r=>`<i class="fr ${esc(String(r.res).toLowerCase())}">${esc(r.res)}</i>`).join("")}</span>`;
}
function fmtShort(d){ try{ return new Date(d+"T12:00:00").toLocaleDateString(undefined,{month:"short",year:"2-digit"}); }catch(e){ return d; } }
function historyCol(name, side){
  const fx = S.fighters[name];
  let h = `<div class="hcol ${side}"><div class="hname">${esc(name)}</div>`;
  if(!fx){ return h + `<p class="note" style="margin:0">History not loaded yet.</p></div>`; }
  h += fx.record ? `<div class="hrec">${esc(fx.record)} pro record</div>` : "";
  if(!fx.recent || !fx.recent.length) return h + `<p class="note" style="margin:0">No UFC fights yet. This is their UFC debut.</p></div>`;
  h += `<ol class="hlist">${fx.recent.map(r=>`<li><i class="fr ${esc(String(r.res).toLowerCase())}">${esc(r.res)}</i><div class="hmain"><span class="hopp">vs ${esc(r.opp)}</span><span class="hmeta">${esc(r.method||"")}${r.round?` · R${esc(r.round)}`:""} · ${esc(fmtShort(r.date))}</span></div></li>`).join("")}</ol>`;
  if(fx.recent.length<5) h += `<p class="note" style="margin:0">${fx.recent.length} UFC ${fx.recent.length===1?"fight":"fights"} so far.</p>`;
  return h + `</div>`;
}
function historyHTML(f){
  const open = S.openForm.has(f.id);
  return `<button class="histbtn" data-act="hist" data-fight="${esc(f.id)}" aria-expanded="${open}">${open?"Hide":"Show"} last 5 UFC fights</button>
    ${open?`<div class="hist">${historyCol(f.red,"red")}${historyCol(f.blue,"blue")}</div>`:""}`;
}
function locked0(c){ return cardLocked(c) || (c.fights||[]).some(f=>f.res&&f.res.w); }
function crowdHTML(c,f){
  const red=[], blue=[];
  S.picks.filter(p=>p.card_id===c.id && p.fight_id===f.id).forEach(p=>(p.side==="red"?red:blue).push(p.user_id));
  const n = red.length+blue.length;
  if(!n) return locked0(c) ? `<div class="crowd"><span class="note">Nobody picked this one.</span></div>` : "";
  const desc = id => `<span><button class="namelink" data-act="player" data-uid="${esc(id)}">${esc(nameOf(id))}</button>${lockRow(id,c.id)?.fight_id===f.id?' <span class="lk">LOCK</span>':""}</span>`;
  return `<div class="crowd"><span class="label">League picks · ${red.length}–${blue.length}</span>
    <div class="bar" aria-hidden="true"><i style="width:${red.length/n*100}%;background:var(--red)"></i><i style="width:${blue.length/n*100}%;background:var(--blue)"></i></div>
    <div class="who"><span style="color:var(--red)">${esc(f.red)}:</span>${red.map(desc).join("")||"<span>none</span>"}</div>
    <div class="who"><span style="color:var(--blue)">${esc(f.blue)}:</span>${blue.map(desc).join("")||"<span>none</span>"}</div></div>`;
}

// this week's lock for a player, shown under their name
function lockTag(uid){
  const c = currentCard(); if(!c) return "";
  const L = lockInfo(uid,c); if(!L) return "";
  const nm = L.side==="red"?L.f.red:L.f.blue;
  const st = L.hit===null ? "" : L.hit==="push" ? " · push" : L.hit ? " · hit" : " · missed";
  return `<span class="locktag ${L.hit===true?"hit":L.hit===false?"miss":""}">${lockSVG}<span>${esc(nm)}${st}</span></span>`;
}
function boardHTML(){
  if(S.viewUser) return playerHTML(S.viewUser);
  const rows = standings();
  if(!rows.length) return emptyHTML("No one's on the board yet","Make a pick to join. Standings fill in as results come in.");
  const cc = currentCard();
  let h = `<div class="event-head"><h2>Season standings</h2><span class="label">${rows.length} ${rows.length===1?"player":"players"}</span></div>`;
  if(!rows.some(r=>r.w+r.l>0)) h += `<p class="note">No results yet. Everyone starts at 0–0.</p>`;
  h += `<div class="boardwrap"><table class="board"><thead><tr><th></th><th>Player</th><th>Record</th><th>Locks</th></tr></thead><tbody>`;
  rows.forEach((r,i)=>{
    h += `<tr class="${i===0&&r.w>0?"top":""}"><td class="rk">${i+1}</td>
      <td class="nm"><button class="namebtn" data-act="player" data-uid="${esc(r.id)}">${avatar(r.id)}<span class="nmstack"><span>${esc(nameOf(r.id))}${r.id===S.uid?" (you)":""}</span>${lockTag(r.id)}</span><span class="chev" aria-hidden="true">›</span></button></td>
      <td class="tot">${r.w}–${r.l}</td><td class="lockrec">${r.lw}–${r.ll}</td></tr>`;
  });
  h += `</tbody></table></div><p class="note">${cc?`Locks shown are for ${esc(cc.name)}. `:""}Tap a name to see their picks. Ranked by most correct picks. Ties go to fewer misses, then the better lock record. Draws, no contests and cancelled bouts don't count.</p>`;
  return h;
}

function cardRecord(uid, c){
  let w=0,l=0;
  (c.fights||[]).forEach(f=>{ const g=grade(pickOf(uid,c.id,f.id),f); if(g===1) w++; else if(g===0) l++; });
  return {w,l};
}
function playerHTML(uid){
  const me = uid===S.uid;
  const r = standings().find(x=>x.id===uid) || {w:0,l:0,lw:0,ll:0};
  let h = `<button class="backbtn" data-act="back">‹ Standings</button>
    <div class="phead">${avatar(uid)}<div class="pmeta"><h2>${esc(nameOf(uid))}${me?" (you)":""}</h2>
      <div class="pstats"><span><b>${r.w}–${r.l}</b> picks</span><span class="lk-stat"><b>${r.lw}–${r.ll}</b> locks</span></div>${lockTag(uid)}</div></div>`;
  const c = currentCard();
  if(!c) return h + emptyHTML("No cards yet","Their picks will show up here once a card is posted.");

  // card-by-card record
  const past = S.cards.filter(x=>cardLocked(x));
  if(past.length){
    h += `<div class="cardhist">${past.map(x=>{
      const cr = cardRecord(uid,x), L = lockInfo(uid,x);
      const lk = L ? (L.hit===null?"lock pending":L.hit==="push"?"lock push":L.hit?"lock hit":"lock missed") : "no lock";
      return `<button class="ch ${x.id===c.id?"on":""}" data-act="pcard" data-card="${esc(x.id)}"><span class="ch-n">${esc(x.name)}</span><span class="ch-r">${cr.w}–${cr.l} · ${lk}</span></button>`;
    }).join("")}</div>`;
  }

  h += `<div class="cardpick"><div class="event-head"><h2>${esc(c.name)}</h2>${c.date?`<span class="label">${esc(fmtDate(c.date))}</span>`:""}</div>${cardSelect()}</div>`;
  const fights = c.fights||[];
  const L = lockInfo(uid,c);
  const cr = cardRecord(uid,c);
  h += `<p class="note">${cr.w+cr.l?`${cr.w}–${cr.l} on this card. `:""}${L?`Lock: ${esc(L.side==="red"?L.f.red:L.f.blue)}${L.hit===null?"":L.hit==="push"?" (push)":L.hit?" (hit)":" (missed)"}.`:"No lock on this card."}</p>`;
  h += `<div class="plist">`;
  fights.forEach(f=>{
    const p = pickOf(uid,c.id,f.id);
    const off = isOff(f);
    const g = grade(p,f);
    const res = f.res && f.res.w;
    const mark = off ? "" : res==="draw" ? "P" : (g===null ? "" : (g?"W":"L"));
    const isLock = L && L.f.id===f.id;
    const side = s => `<span class="pf ${s} ${p===s?"chosen":""} ${res===s?"winner":""}">${esc(s==="red"?f.red:f.blue)}</span>`;
    h += `<div class="prow ${off?"off":""}">
      <div class="pnames">${side("red")}<span class="vs">vs</span>${side("blue")}</div>
      <div class="pright">${isLock?'<span class="lk">LOCK</span>':""}${off?'<span class="pill locked">Cancelled</span>':!p?'<span class="note">No pick</span>':mark?`<span class="pts ${mark==="W"?"hit":mark==="L"?"miss":""}">${mark}</span>`:'<span class="note">Pending</span>'}</div>
    </div>`;
  });
  h += `</div>`;
  return h;
}

/* ---------- events ---------- */
$("#tabs").addEventListener("click", e=>{
  const t=e.target.closest(".tab"); if(!t) return;
  S.tab=t.dataset.tab; S.viewUser=null; try{ localStorage.setItem("op-tab",S.tab); }catch(err){} render();
});
$("#me").addEventListener("click", async e=>{
  if(e.target.closest('[data-act="signout"]')){ await sb.auth.signOut(); }
});
$("#app").addEventListener("change", e=>{
  if(e.target.id==="sel-card"){ S.cardId=e.target.value; render(); }
});
$("#app").addEventListener("click", e=>{
  const b=e.target.closest("[data-act]"); if(!b || b.disabled) return;
  const act=b.dataset.act;
  if(act==="mode"){ S.authMode=b.dataset.v; render(); return; }
  if(act==="player"){ S.viewUser=b.dataset.uid; S.tab="board"; render(); window.scrollTo(0,0); return; }
  if(act==="back"){ S.viewUser=null; render(); return; }
  if(act==="pcard"){ S.cardId=b.dataset.card; render(); return; }
  if(act==="hist"){ const id=b.dataset.fight; S.openForm.has(id)?S.openForm.delete(id):S.openForm.add(id); render(); return; }
  const c=currentCard(); if(!c) return;
  const f=(c.fights||[]).find(x=>x.id===b.dataset.fight); if(!f) return;
  if(act==="pick") setPick(c,f,b.dataset.v);
  if(act==="lock") toggleLock(c,f);
});
$("#app").addEventListener("submit", async e=>{
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
  if(S.uid){ S.loaded=false; render(); await loadAll(); subscribe(); }
  else { unsubscribe(); S.cards=[]; S.picks=[]; S.locks=[]; S.profiles={}; S.loaded=false; render(); }
}
sb.auth.onAuthStateChange((event, session)=>{
  if(event==="SIGNED_IN" || event==="SIGNED_OUT" || event==="INITIAL_SESSION"){
    if((session?.user?.id||null) !== S.uid || event==="INITIAL_SESSION") onSession(session);
  }
});
// re-render when a card's lock time passes, and refresh when the tab comes back into view
let lockSig="";
setInterval(()=>{ const sig=S.cards.map(c=>cardLocked(c)?1:0).join(""); if(sig!==lockSig){ lockSig=sig; if(S.uid) loadAll(); } },30000);
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden && S.uid) loadAll(); });
render();
})();
