// ROT Live — the shared performance layer under Autopilot, Sequencer, Scenes, Mutation, MIDI and Quick Clip.
// Loaded after the main script, it uses the engine's globals (P, A, FX, MASTER, DATA, Music, Engine, UI…).
// The main loop calls Live.frame() once per frame and applies what it returns:
//   applyFx(fxVals)  additive effect amounts, before the safe-mode caps
//   post(frame)      zoom punch, hue, flash, shake, freeze and the clip overlay
'use strict';
const Live=(()=>{
  const KEY='rot2.live';
  const loaded=storeGet(KEY,null);
  const state=(loaded&&typeof loaded==='object'&&!Array.isArray(loaded))?loaded:{};
  let saveT=0;
  function save(){clearTimeout(saveT);saveT=setTimeout(()=>storeSet(KEY,state),300)}
  // a module's saved state, merged with its defaults field by field (old or damaged data falls back per field)
  function part(name,def){
    let v=state[name];if(!v||typeof v!=='object'||Array.isArray(v))v={};
    for(const k in def){const d=def[k],x=v[k];
      if(x==null||(Array.isArray(d)?!Array.isArray(x):(typeof x!==typeof d||(typeof d==='number'&&!Number.isFinite(x)))))v[k]=JSON.parse(JSON.stringify(d))}
    state[name]=v;return v;
  }

  // ---- events
  const listeners={};
  function on(ev,fn){(listeners[ev]=listeners[ev]||[]).push(fn)}
  function emit(ev,a,b){(listeners[ev]||[]).forEach(fn=>{try{fn(a,b)}catch(e){console.warn('[live]',ev,e)}})}

  // ---- per-frame output and the trigger envelopes behind it
  const out={fx:Object.create(null),zoom:0,hue:0,flash:0,invert:0,freeze:0,shake:[0,0],overlay:null,applyFx,post};
  const env={flash:0,zoom:0,glitch:0,shake:0,black:0,invert:0,fx:Object.create(null)};
  const DECAY={flash:10,zoom:7,glitch:5.5,shake:9,black:12,invert:9};
  let freezeUntil=0,flashTimes=[];
  const safe=()=>!!DATA.settings.safe,reduce=()=>!!DATA.settings.reduce;

  // kind: flash | zoom | glitch | shake | black | freeze | fx (opt.id) — amt 0..1
  function trigger(kind,amt,opt){
    amt=clamp(+amt||0,0,1);if(amt<=0)return;
    const now=performance.now();
    if(kind==='flash'||kind==='black'||kind==='invert'){
      // photosensitivity: no flashes or blackouts in safe mode; together with the music's own flashes
      // at most 3 a second (2 with reduced motion)
      if(safe())return;
      flashTimes=flashTimes.filter(t=>now-t<1000);
      const music=(typeof musicFlashTimes!=='undefined'?musicFlashTimes:[]).filter(t=>now-t<1000).length;
      if(flashTimes.length+music>=(reduce()?2:3))return;
      flashTimes.push(now);env[kind]=Math.max(env[kind],reduce()&&kind==='black'?amt*.4:amt);
    }else if(kind==='freeze'){freezeUntil=Math.max(freezeUntil,now+60+amt*420)}
    else if(kind==='fx'){const id=opt&&opt.id;if(id&&FXMAP[id])env.fx[id]=Math.max(env.fx[id]||0,amt)}
    else if(kind in env)env[kind]=Math.max(env[kind],amt);
    emit('trigger',kind,amt);
  }

  const tickers=[];
  function addTicker(fn){tickers.push(fn)}
  const ctx={dt:0,now:0,T:0,mus:null,out};
  let ready=false;

  function frame(dt,mus,T,now){
    out.fx=Object.create(null);out.zoom=0;out.hue=0;out.flash=0;out.invert=0;out.freeze=0;out.shake[0]=out.shake[1]=0;
    ctx.dt=dt;ctx.now=now;ctx.T=T;ctx.mus=mus;
    for(const fn of tickers){try{fn(ctx)}catch(e){console.warn('[live] ticker',e)}}
    // envelopes → output
    for(const k in DECAY)env[k]*=Math.exp(-dt*DECAY[k]);
    const add=(id,v)=>{if(v>.002)out.fx[id]=(out.fx[id]||0)+v};
    add('glitch',env.glitch*.9);add('rgb',env.glitch*.55);add('tear',env.glitch*.35);
    add('blackout',env.black);
    for(const id in env.fx){env.fx[id]*=Math.exp(-dt*5);add(id,env.fx[id]);if(env.fx[id]<.002)delete env.fx[id]}
    out.zoom+=env.zoom*.14;
    out.flash+=env.flash*.8;out.invert=env.invert>.02?env.invert:0;
    if(env.shake>.003){const a=Math.random()*TAU,m=env.shake*.022;out.shake[0]=Math.cos(a)*m;out.shake[1]=Math.sin(a)*m}
    if(performance.now()<freezeUntil)out.freeze=1;
    return out;
  }
  function applyFx(fxVals){
    for(const id in out.fx){if(FXMAP[id]&&id!=='skip')fxVals[id]=clamp((fxVals[id]||0)+out.fx[id],0,1.8)}
  }
  function post(frame){
    frame.zoom=clamp(frame.zoom*(1+out.zoom),.05,3);
    frame.hue+=out.hue;
    if(!safe())frame.flash=Math.max(frame.flash,clamp(out.flash*(reduce()?.45:1),0,1));
    frame.freeze=out.freeze;
    frame.invert=safe()?0:clamp(out.invert*(reduce()?.4:1),0,1);
    const sk=safe()?0:(reduce()?.3:1);
    frame.shake=sk?[out.shake[0]*sk,out.shake[1]*sk]:null;
    frame.overlay=out.overlay;
  }

  // ---- parameters: one registry for MIDI knobs, mutation locks and scene morphs
  // id → {label,group,get():0..1,set(v01)}
  const params=new Map();
  function addParam(id,label,group,get,set){params.set(id,{id,label,group,get,set})}
  MASTER.forEach(m=>addParam('m:'+m.id,m.name,'Master',
    ()=>(P[m.id]-m.min)/(m.max-m.min),
    v=>{P[m.id]=m.min+clamp(v,0,1)*(m.max-m.min);syncControl('m:'+m.id)}));
  FX.forEach(f=>addParam('fx:'+f.id,f.name,'Effect',
    ()=>P.on[f.id]?P.fx[f.id]:0,
    v=>{v=clamp(v,0,1);P.fx[f.id]=v;P.on[f.id]=v>.01;syncControl('fx:'+f.id)}));
  // update controls without rebuilding the panel; batched once per frame (a MIDI knob sends ~100 messages a second)
  const pendingSync=new Set();let syncRaf=0;
  function syncControl(id){pendingSync.add(id);if(!syncRaf)syncRaf=requestAnimationFrame(flushSync)}
  function flushSync(){syncRaf=0;const ids=[...pendingSync];pendingSync.clear();ids.forEach(syncOne);if(ids.length&&typeof queueSaveLook==='function')queueSaveLook()}
  function syncOne(id){
    if(id.startsWith('m:')){const k=id.slice(2),u=UI.master&&UI.master[k];if(u){u.input.value=P[k];u.out.textContent=(+P[k]).toFixed(2);fillRange(u.input)}}
    else if(id.startsWith('fx:')){const k=id.slice(3),u=UI.fx&&UI.fx[k];if(u){u.rng.value=P.fx[k];u.val.textContent=(+P.fx[k]).toFixed(2);u.cb.checked=!!P.on[k];u.row.classList.toggle('off',!P.on[k]);fillRange(u.rng)}}
  }

  // ---- actions: things a pad, a key or a sequencer step can do. id → {label,run(vel)}
  const actions=new Map();
  function addAction(id,label,run){actions.set(id,{id,label,run})}
  function run(id,vel){const a=actions.get(id);if(!a)return false;try{a.run(vel==null?1:vel)}catch(e){console.warn('[live] action',id,e)}emit('action',id);return true}
  addAction('flash','Flash',v=>trigger('flash',v));
  addAction('zoom','Zoom punch',v=>trigger('zoom',v));
  addAction('glitch','Glitch hit',v=>trigger('glitch',v));
  addAction('shake','Shake',v=>trigger('shake',v));
  addAction('freeze','Freeze',v=>trigger('freeze',v));
  addAction('black','Blackout hit',v=>trigger('black',v));
  addAction('invert','Invert hit',v=>trigger('invert',v));
  addAction('randomize','Randomize look',()=>{randomizeLook(true);if(typeof markDirty==='function')markDirty()});
  addAction('extreme','Extreme on/off',()=>toggleExtreme());
  addAction('hypno','Hypnosis on/off',()=>toggleHypnosis());
  addAction('record','Record video on/off',()=>toggleRecording());
  addAction('png','Save a frame (PNG)',()=>exportPNG());
  addAction('play','Music play/pause',()=>{if(Music.hasTrack())Music.toggle()});
  addAction('tap','Tap tempo',()=>{if(Music.hasTrack())Music.tap()});

  // ---- looks: interpolation between two snapshots (same shape as snapshotLook())
  function lookLerp(a,b,k){
    const o={_full:true,on:{},fx:{},m:{},res:P.res,pix:0,grade:0,asciiMode:0};
    FX.forEach(f=>{
      const va=a.on&&a.on[f.id]?+a.fx[f.id]||0:0,vb=b.on&&b.on[f.id]?+b.fx[f.id]||0:0;
      const v=va+(vb-va)*k;o.fx[f.id]=v>.001?v:(+b.fx[f.id]||f.def);o.on[f.id]=v>.001;
    });
    MASTER.forEach(m=>{const va=a.m&&a.m[m.id]!=null?+a.m[m.id]:m.def,vb=b.m&&b.m[m.id]!=null?+b.m[m.id]:m.def;o.m[m.id]=va+(vb-va)*k});
    o.pix=(+a.pix||0)+((+b.pix||0)-(+a.pix||0))*k;
    o.grade=k<.5?(+a.grade||0):(+b.grade||0);o.asciiMode=k<.5?(+a.asciiMode||0):(+b.asciiMode||0);
    return o;
  }
  // any recipe (built-in partial or saved full look) as a full snapshot, without touching the live look
  function toLook(src){
    const o={_full:true,on:{},fx:{},m:{},res:P.res,pix:clamp(+src.pix||0,0,1),grade:clamp(+src.grade||0,0,5),asciiMode:src.asciiMode?1:0};
    const full=isFullLook(src);
    FX.forEach(f=>{
      if(full){o.on[f.id]=src.on&&src.on[f.id]!=null?!!src.on[f.id]:!!(src.fx&&src.fx[f.id]>0);o.fx[f.id]=src.fx&&src.fx[f.id]!=null?clamp(+src.fx[f.id]||0,0,1):f.def}
      else{const v=src.fx&&src.fx[f.id]!=null?clamp(+src.fx[f.id]||0,0,1):0;o.on[f.id]=v>0;o.fx[f.id]=v>0?v:f.def}
    });
    const m=normalizeMasters(src);MASTER.forEach(x=>o.m[x.id]=m[x.id]!=null?m[x.id]:x.def);
    return o;
  }
  // write a look straight into P (no UI rebuild, no save): used every frame by transitions
  function writeLook(l){
    FX.forEach(f=>{P.on[f.id]=!!l.on[f.id];P.fx[f.id]=clamp(+l.fx[f.id]||0,0,1)});
    MASTER.forEach(m=>{if(l.m[m.id]!=null)P[m.id]=clamp(+l.m[m.id],m.min,m.max)});
    P.pix=clamp(+l.pix||0,0,1);P.grade=clamp(+l.grade||0,0,5);P.asciiMode=+l.asciiMode?1:0;
    if(DATA.settings.safe)capForSafeMode(P);
  }

  // ---- small UI kit (reuses the panel's own classes)
  function h(tag,attrs,kids){
    const e=document.createElement(tag);
    if(attrs)for(const k in attrs){const v=attrs[k];if(v==null||v===false)continue;
      if(k==='class')e.className=v;else if(k==='text')e.textContent=v;else if(k==='html')e.innerHTML=v;
      else if(k.startsWith('on'))e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?'':v)}
    (kids||[]).forEach(c=>{if(c!=null)e.appendChild(typeof c==='string'?document.createTextNode(c):c)});
    return e;
  }
  function section(title,note,id){
    const s=h('div',{class:'section live-sec',id});
    const noteEl=h('div',{class:'section-note',text:note||''});
    s.appendChild(h('div',{class:'section-head'},[h('div',{class:'section-title',html:'<b>'+esc(title)+'</b> <span class="line"></span>'}),noteEl]));
    s.note=noteEl;return s;
  }
  function range(label,min,max,step,val,onInput,fmt){
    fmt=fmt||(v=>(+v).toFixed(2));
    const out=h('span',{class:'ctrl-val',text:fmt(val)});
    const inp=h('input',{type:'range',min,max,step,value:val,'aria-label':label});
    inp.addEventListener('input',()=>{out.textContent=fmt(+inp.value);fillRange(inp);onInput(+inp.value)});
    const row=h('div',{class:'ctrl'},[h('div',{class:'ctrl-top'},[h('span',{class:'ctrl-label',text:label}),out]),inp]);
    requestAnimationFrame(()=>fillRange(inp));
    row.input=inp;row.set=v=>{inp.value=v;out.textContent=fmt(+v);fillRange(inp)};
    return row;
  }
  function select(label,options,val,onChange){
    const s=h('select',{'aria-label':label});
    options.forEach(([v,t])=>{const o=h('option',{value:v,text:t});if(String(v)===String(val))o.selected=true;s.appendChild(o)});
    s.addEventListener('change',()=>onChange(s.value));
    const row=h('div',{class:'ctrl'},[h('div',{class:'ctrl-top'},[h('span',{class:'ctrl-label',text:label})]),s]);
    row.sel=s;return row;
  }
  function seg(label,options,val,onPick){
    const wrap=h('div',{class:'live-seg',role:'radiogroup','aria-label':label});
    options.forEach(([v,t])=>{
      const b=h('button',{type:'button',class:'chip'+(String(v)===String(val)?' on':''),role:'radio','aria-checked':String(String(v)===String(val)),text:t});
      b.addEventListener('click',()=>{$$('.chip',wrap).forEach(x=>{const on=x===b;x.classList.toggle('on',on);x.setAttribute('aria-checked',String(on))});onPick(v)});
      wrap.appendChild(b);
    });
    wrap.pick=v=>{const i=options.findIndex(o=>String(o[0])===String(v));$$('.chip',wrap).forEach((x,j)=>{x.classList.toggle('on',j===i);x.setAttribute('aria-checked',String(j===i))})};
    return wrap;
  }
  function sw(label,val,onChange){
    const inp=h('input',{type:'checkbox'});inp.checked=!!val;
    inp.addEventListener('change',()=>onChange(inp.checked));
    const l=h('label',{class:'switch'},[h('span',{text:label}),inp]);l.input=inp;return l;
  }
  function btn(text,onClick,cls){return h('button',{type:'button',class:'btn'+(cls?' '+cls:''),text,onclick:onClick})}

  // ---- keys: digits, A, X, Z, F, Q, K belong to Live (see KEY_HELP)
  const keys=new Map();
  function addKey(k,fn){keys.set(k,fn)}
  const HOLD=new Set(['f']);
  function key(k,e){if(/^Digit[0-9]$/.test(e.code||'')&&!/^[\/?]$/.test(e.key))k=e.code.slice(5);const fn=keys.get(k);if(fn&&e.repeat&&!HOLD.has(k)){e.preventDefault();return true}if(!fn)return false;e.preventDefault();fn(e);return true}

  function init(){if(ready)return;ready=true;emit('ready')}

  return {state,part,save,on,emit,trigger,addTicker,frame,applyFx,post,out,
    params,addParam,syncControl,actions,addAction,run,lookLerp,writeLook,toLook,
    h,section,range,select,seg,sw,btn,addKey,key,init,get ready(){return ready}};
})();
