// Mutation engine — evolves the current look generation by generation instead of rolling new dice.
// A child keeps its parent's character: strengths move by a gaussian step, effects are swapped for others of
// the same family, at most two shape-warps run at once, hue jumps by harmonic steps. Mutations are seeded
// (same parent + same seed = same child), locked parameters never move, and every generation is kept in a
// history you can step through, restore or save as a recipe. A look's "DNA" is its share-link code: copy it,
// paste it, or breed two recipes into a hybrid.
'use strict';
const Mutation=(()=>{
  const S=Live.part('mut',{amount:.35,prob:.4,scope:'all',locks:[],auto:false,every:4,hist:[],pos:-1});
  if(!Array.isArray(S.locks))S.locks=[];
  S.hist=(Array.isArray(S.hist)?S.hist:[]).filter(h=>h&&h.g&&typeof h.g==='object'&&h.g.on&&h.g.fx&&h.g.m).slice(-30);
  S.locks=S.locks.filter(x=>typeof x==='string');
  if(!['all','active'].includes(S.scope))S.scope='all';
  S.pos=clamp(S.pos|0,-1,S.hist.length-1);
  const HEAVY=new Set(['liquid','fluid','kaleido','fish','mirror','melt','fracture','flesh']);
  const GROUPS={
    colors:{label:'Colours',ids:['m:hueShift','grade']},
    motion:{label:'Motion',ids:['m:speed','m:chaos','m:rnd','m:gfreq']},
    shape:{label:'Shape',ids:FX.filter(f=>f.cat==='OPTICAL').map(f=>'fx:'+f.id)},
    signal:{label:'Signal',ids:FX.filter(f=>f.cat==='SIGNAL').map(f=>'fx:'+f.id)},
    light:{label:'Light',ids:FX.filter(f=>f.cat==='LIGHT').map(f=>'fx:'+f.id)},
    lab:{label:'Lab',ids:FX.filter(f=>f.cat==='LAB').map(f=>'fx:'+f.id)},
    set:{label:'Active set',ids:['set']}
  };
  const locked=id=>S.locks.includes(id);

  function rng(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
  function gauss(r){return Math.sqrt(-2*Math.log(Math.max(1e-9,r())))*Math.cos(TAU*r())}

  function child(parent,amount,seed){
    const r=rng(seed),g=deep(parent),prob=clamp(S.prob,0,1);
    const active=()=>FX.filter(f=>g.on[f.id]&&f.id!=='skip');
    // 1. strengths drift around the parent's values
    FX.forEach(f=>{
      if(locked('fx:'+f.id)||!g.on[f.id])return;
      if(r()<prob)g.fx[f.id]=clamp(g.fx[f.id]+gauss(r)*amount*.32,.06,1);
    });
    // 2. the set changes: drop one, bring in a relative (same family as something already there)
    if(!locked('set')&&S.scope==='all'&&r()<prob*(.4+amount)){
      const on=active().filter(f=>!locked('fx:'+f.id));
      if(on.length>3&&r()<.6){const d=on[Math.floor(r()*on.length)];g.on[d.id]=false}
      const cats=active().map(f=>f.cat),fam=cats.length&&r()<.75?cats[Math.floor(r()*cats.length)]:CATS[Math.floor(r()*CATS.length)];
      const heavy=active().filter(f=>HEAVY.has(f.id)).length;
      const pool=FX.filter(f=>f.cat===fam&&!g.on[f.id]&&f.id!=='skip'&&!locked('fx:'+f.id)&&!(HEAVY.has(f.id)&&heavy>=2)&&!(DATA.settings.safe&&f.id==='blackout'));
      if(pool.length&&active().length<8){const n=pool[Math.floor(r()*pool.length)];g.on[n.id]=true;g.fx[n.id]=clamp(.25+r()*.4*(.5+amount),.1,.85)}
    }
    // 3. motion
    [['speed',.35],['chaos',.18],['org',.25],['gfreq',.18],['rnd',.15],['intensity',.1],['zoom',.05]].forEach(([id,k])=>{
      if(locked('m:'+id)||r()>=prob)return;const m=MASTERMAP[id];
      g.m[id]=clamp((g.m[id]!=null?g.m[id]:m.def)+gauss(r)*k*amount*(m.max-m.min)*.5,m.min,m.max);
    });
    // 4. colour: harmonic hue steps, rare grade change
    if(!locked('m:hueShift')&&r()<prob*amount*1.2){const steps=[30,60,120,180,-30,-60,-120];g.m.hueShift=((((g.m.hueShift||0)+steps[Math.floor(r()*steps.length)])+540)%360)-180}
    if(!locked('grade')&&r()<prob*amount*.35)g.grade=r()<.3?0:1+Math.floor(r()*5);
    if(DATA.settings.safe){g.grade=0;FX.forEach(f=>{if(SAFE_LIMITS[f.id]&&g.fx[f.id]>SAFE_LIMITS[f.id])g.fx[f.id]=SAFE_LIMITS[f.id]})}
    return g;
  }

  const strip=g=>{g=deep(g);delete g.res;return g};
  const same=(a,b)=>JSON.stringify(strip(a))===JSON.stringify(strip(b));
  function push(g,info){
    g=strip(g);
    S.hist=S.hist.slice(0,S.pos+1);
    S.hist.push({g,seed:info.seed||0,kind:info.kind||'mut',at:Date.now()});
    if(S.hist.length>30)S.hist.shift();
    S.pos=S.hist.length-1;Live.save();render();
  }
  // the look on screen goes into the history first when you changed it by hand since the last generation
  function ensureBase(){const cur=snapshotLook();if(S.pos<0||!S.hist.length)push(cur,{kind:'base'});else if(!same(S.hist[S.pos].g,cur))push(cur,{kind:'edit'})}
  function apply(g){g=strip(g);applyPreset(g,false);if(typeof markDirty==='function')markDirty()}

  function mutate(opt){
    opt=opt||{};ensureBase();
    const seed=opt.seed!=null?opt.seed>>>0:(Math.random()*4294967296)>>>0;
    const g=child(snapshotLook(),clamp(opt.amount!=null?opt.amount:S.amount,0,1),seed);
    apply(g);push(snapshotLook(),{seed,kind:'mut'});
    if(!opt.quiet){toast('<b>GENERATION '+S.pos+'</b> — seed '+seed.toString(36).toUpperCase());vibrate(6)}
    return seed;
  }
  const edited=()=>!!(S.hist[S.pos]&&!same(S.hist[S.pos].g,snapshotLook()));
  function go(i){
    if(i<0||i>=S.hist.length)return false;
    // hand edits since the last generation are kept as their own entry first (nothing to redo after them)
    if(edited()){if(i>S.pos)return false;push(snapshotLook(),{kind:'edit'})}
    S.pos=i;apply(S.hist[i].g);Live.save();render();return true;
  }
  // undo after a hand edit goes back to the generation you edited
  const undo=()=>{if(edited()){push(snapshotLook(),{kind:'edit'});return go(S.pos-1)}return go(S.pos-1)||toast('<b>NOTHING TO UNDO</b>')};
  const redo=()=>go(S.pos+1)||toast('<b>NOTHING TO REDO</b>');

  // ---- DNA: the look's share-link code
  const dna=()=>b64u.enc(lookForLink());
  function fromDna(s){
    const l=b64u.dec(String(s).trim().replace(/^.*#rot=/,''));
    const o=l&&l.l?l.l:l; // a whole share code works too
    if(!o||typeof o!=='object'||!o.fx)throw new Error('dna');
    const src={fx:{},m:{},pix:+o.pix||0,grade:+o.grade||0,asciiMode:o.a?1:0};
    Object.keys(o.fx).forEach(k=>{const v=+o.fx[k];if(FXMAP[k]&&Number.isFinite(v))src.fx[k]=clamp(v,0,1)});
    MASTER.forEach(m=>{if(o.m&&Number.isFinite(+o.m[m.id]))src.m[m.id]=+o.m[m.id]});
    return src;
  }
  function look(name){
    if(name==='__current')return snapshotLook();
    const b=BUILTIN_PRESETS.find(p=>p.name===name)||(DATA.userPresets&&DATA.userPresets[name]);
    return b?Live.toLook(b):null;
  }
  // two parents → one child: genes from either side, shared effects blended, then one small mutation
  function breed(nameA,nameB,mix){
    const a=look(nameA),b=look(nameB);if(!a||!b)return false;
    ensureBase();
    const seed=(Math.random()*4294967296)>>>0,r=rng(seed),k=clamp(mix,0,1);
    const g=Live.lookLerp(a,b,k);
    FX.forEach(f=>{
      const ia=a.on[f.id],ib=b.on[f.id];
      if(ia!==ib){const from=r()<(ia?1-k:k);g.on[f.id]=from;g.fx[f.id]=from?(ia?a.fx[f.id]:b.fx[f.id]):g.fx[f.id]}
    });
    let on=FX.filter(f=>g.on[f.id]);
    if(on.length>8)on.sort((x,y)=>g.fx[x.id]-g.fx[y.id]).slice(0,on.length-8).forEach(f=>g.on[f.id]=false);
    g.grade=r()<1-k?a.grade:b.grade;
    apply(child(g,.15,seed));push(snapshotLook(),{seed,kind:'hybrid'});
    toast('<b>HYBRID</b> — '+esc(nameA==='__current'?'current':nameA)+' × '+esc(nameB==='__current'?'current':nameB));
    return true;
  }

  // continuous mutation: every N bars with a playing track, every N×2 s otherwise
  let lastBar=-1,lastAt=0;
  function tick(ctx){
    if(!S.auto)return;
    const mus=ctx.mus,every=Math.max(1,S.every|0);
    if(mus&&mus.loaded&&mus.playing){const bar=mus.barIndex|0;if(bar!==lastBar){lastBar=bar;if(bar>0&&bar%every===0)mutate({amount:S.amount*.7,quiet:true})}}
    else if(ctx.now-lastAt>every*2000){lastAt=ctx.now;mutate({amount:S.amount*.7,quiet:true})}
  }

  // ---- panel
  const el={};
  function mount(host){
    const L=Live,sec=L.section('MUTATION','G0','mutSec');el.note=sec.note;
    const g1=L.h('div',{class:'btn-grid'});
    g1.appendChild(L.btn('⟳ MUTATE',()=>mutate(),'hot'));
    g1.appendChild(L.btn('SAVE AS RECIPE',()=>{const n=prompt(LANG==='it'?'Nome della ricetta':'Recipe name','Gen '+S.pos);if(n&&saveCurrentPreset(n))Live.emit('recipes')}));
    g1.appendChild(L.btn('↶ UNDO',undo));g1.appendChild(L.btn('↷ REDO',redo));
    sec.appendChild(g1);
    el.hist=L.h('div',{class:'mut-hist',role:'list','aria-label':'Mutation history'});sec.appendChild(el.hist);
    sec.appendChild(L.range('Mutation intensity',0,1,.01,S.amount,v=>{S.amount=v;L.save()}));
    sec.appendChild(L.range('Mutation probability',0,1,.01,S.prob,v=>{S.prob=v;L.save()}));
    sec.appendChild(L.select('Mutate',[['all','Everything (effects can change)'],['active','Only the active effects']],S.scope,v=>{S.scope=v;L.save()}));
    // locks
    const lk=L.h('div',{class:'live-seg mut-locks','aria-label':'Locked groups'});
    Object.entries(GROUPS).forEach(([k,gr])=>{
      const isOn=()=>gr.ids.every(locked);
      const b=L.h('button',{type:'button',class:'chip'+(isOn()?' on':''),text:'🔒 '+gr.label,'aria-pressed':String(isOn())});
      b.addEventListener('click',()=>{const on=!isOn();gr.ids.forEach(id=>{S.locks=S.locks.filter(x=>x!==id);if(on)S.locks.push(id)});b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));L.save();renderLocks()});
      lk.appendChild(b);
    });
    sec.appendChild(L.h('div',{class:'ctrl-top live-lbl'},[L.h('span',{class:'ctrl-label',text:'Locked'})]));sec.appendChild(lk);
    const det=L.h('details',{class:'adv'},[L.h('summary',{text:'Lock single parameters'})]);
    el.locks=L.h('div',{class:'adv-body mut-single'});det.appendChild(el.locks);sec.appendChild(det);
    // continuous + seed
    sec.appendChild(L.sw('Continuous mutation',S.auto,v=>{S.auto=v;L.save()}));
    sec.appendChild(L.select('Every',[[1,'1 bar (2 s)'],[2,'2 bars (4 s)'],[4,'4 bars (8 s)'],[8,'8 bars (16 s)']],S.every,v=>{S.every=+v;L.save()}));
    const seedIn=L.h('input',{type:'text',class:'live-input',placeholder:'seed','aria-label':'Mutation seed',maxlength:8,spellcheck:'false'});
    sec.appendChild(L.h('div',{class:'live-row'},[seedIn,L.btn('REPLAY SEED',()=>{const v=parseInt(seedIn.value,36);if(Number.isFinite(v))mutate({seed:v});else seedIn.focus()})]));
    el.seed=seedIn;
    // DNA + hybrid
    const dsec=L.h('details',{class:'adv'},[L.h('summary',{text:'Visual DNA & hybrids'})]);
    const db=L.h('div',{class:'adv-body'});
    const dnaIn=L.h('input',{type:'text',class:'live-input',placeholder:'paste DNA','aria-label':'Visual DNA',spellcheck:'false'});
    db.appendChild(L.h('div',{class:'live-row'},[L.btn('COPY DNA',async()=>{const d=dna();try{await navigator.clipboard.writeText(d);toast('<b>DNA COPIED</b>')}catch(e){dnaIn.value=d;dnaIn.select()}}),
      L.btn('APPLY DNA',()=>{try{ensureBase();apply(fromDna(dnaIn.value));push(snapshotLook(),{kind:'dna'});toast('<b>DNA APPLIED</b>')}catch(e){toast('<b>NOT A VALID DNA</b>')}})]));
    db.appendChild(dnaIn);
    el.pa=L.select('Parent A',[],'',()=>{});el.pb=L.select('Parent B',[],'',()=>{});
    db.appendChild(el.pa);db.appendChild(el.pb);
    let mix=.5;db.appendChild(L.range('A ↔ B',0,1,.01,.5,v=>{mix=v}));
    db.appendChild(L.btn('BREED HYBRID',()=>breed(el.pa.sel.value,el.pb.sel.value,mix),'full acid'));
    dsec.appendChild(db);sec.appendChild(dsec);
    dsec.addEventListener('toggle',fillParents);
    host.appendChild(sec);
    renderLocks();render();fillParents();
  }
  function fillParents(){
    if(!el.pa)return;
    const names=[['__current','Current look']].concat(BUILTIN_PRESETS.map(p=>[p.name,p.name]),Object.keys(DATA.userPresets||{}).map(n=>[n,'★ '+n]));
    [el.pa.sel,el.pb.sel].forEach((s,i)=>{const keep=s.value;s.innerHTML='';names.forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;s.appendChild(o)});s.value=keep||names[Math.min(i+1,names.length-1)][0]});
  }
  function renderLocks(){
    if(!el.locks)return;el.locks.innerHTML='';
    [...MASTER.map(m=>['m:'+m.id,m.name]),['grade','Colour grade'],...FX.map(f=>['fx:'+f.id,f.name])].forEach(([id,name])=>{
      const cb=Live.h('input',{type:'checkbox'});cb.checked=locked(id);
      cb.addEventListener('change',()=>{S.locks=S.locks.filter(x=>x!==id);if(cb.checked)S.locks.push(id);Live.save()});
      el.locks.appendChild(Live.h('label',{class:'mut-lock'},[cb,Live.h('span',{text:name})]));
    });
  }
  function render(){
    if(!el.hist)return;
    el.hist.innerHTML='';
    S.hist.forEach((h,i)=>{
      const b=Live.h('button',{type:'button',class:'mut-g'+(i===S.pos?' on':''),role:'listitem',title:(h.kind==='base'?'Base':h.kind==='edit'?'Your edit':h.kind==='hybrid'?'Hybrid':h.kind==='dna'?'DNA':'Seed '+(h.seed>>>0).toString(36).toUpperCase()),text:i===0&&h.kind==='base'?'B':h.kind==='edit'?'✎':String(i)});
      b.style.setProperty('--h',hashHue(JSON.stringify(h.g.on))+'deg');
      b.addEventListener('click',()=>go(i));el.hist.appendChild(b);
    });
    setTxt(el.note,'G'+Math.max(0,S.pos)+' / '+S.hist.length);
    const cur=S.hist[S.pos];if(el.seed&&cur&&cur.seed&&document.activeElement!==el.seed)el.seed.value=(cur.seed>>>0).toString(36).toUpperCase();
    const on=el.hist.querySelector('.on');if(on)el.hist.scrollLeft=Math.max(0,on.offsetLeft-el.hist.clientWidth+on.offsetWidth+8);
  }
  Live.on('recipes',fillParents);

  Live.addTicker(tick);
  Live.addAction('mutate','Mutate',v=>mutate({amount:S.amount*(.5+.5*(v==null?1:v)),quiet:true}));
  Live.addAction('mut:undo','Mutation undo',undo);
  Live.addAction('mut:redo','Mutation redo',redo);
  Live.addParam('mut:amount','Mutation intensity','Live',()=>S.amount,v=>{S.amount=v;Live.save()});
  Live.addKey('x',()=>mutate());
  Live.addKey('z',e=>e.shiftKey?redo():undo());
  return {mount,mutate,undo,redo,go,breed,dna,fromDna,child,get settings(){return S},get history(){return S.hist},get pos(){return S.pos}};
})();
