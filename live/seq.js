// Visual sequencer — a drum machine for the picture. Each lane fires one kind of visual event on the steps you
// light up; the playhead follows the loaded track's beat grid (or its own BPM clock when no track is loaded).
// Steps cycle off → full → soft. Lanes have their own intensity and probability. Patterns: 8, 16 or 32 steps
// of 1/16 or 1/8 notes, generated from styles, saved and loaded by name.
'use strict';
const Seq=(()=>{
  const LANES=[
    {id:'flash',label:'FLASH'},{id:'zoom',label:'ZOOM'},{id:'glitch',label:'GLITCH'},{id:'freeze',label:'FREEZE'},
    {id:'shake',label:'SHAKE'},{id:'black',label:'BLACK'},{id:'fx',label:'FX'},{id:'scene',label:'SCENE'}
  ];
  const blank=n=>new Array(n).fill(0);
  const S=Live.part('seq',{on:false,len:16,res:16,bpm:120,page:0,fx:'kaleido',lanes:{},patterns:{}});
  LANES.forEach(l=>{const x=S.lanes[l.id];if(!x||!Array.isArray(x.steps))S.lanes[l.id]={steps:blank(32),int:.8,prob:1};else if(x.steps.length<32)x.steps=x.steps.concat(blank(32-x.steps.length))});
  if(!S.patterns||typeof S.patterns!=='object')S.patterns={};
  let clock=0,lastStep=-1,playing=false;

  function fire(lane,v){
    const L=S.lanes[lane];if(!L||Math.random()>L.prob)return;
    const a=v*L.int;
    if(lane==='fx')Live.trigger('fx',a,{id:S.fx});
    else if(lane==='scene'){if(typeof Scenes!=='undefined'&&Scenes.stored()>=2&&!Scenes.busy)Live.run('scene:next')}
    else Live.trigger(lane,a);
  }
  function tick(ctx){
    if(!S.on){if(playing){playing=false;paint(-1)}return}
    const mus=ctx.mus,spb=S.res/4; // steps per beat
    let pos;
    if(mus&&mus.loaded){
      if(!mus.playing){if(playing){playing=false;paint(-1)}return}
      pos=Math.floor((+mus.beatFloat||0)*spb);
    }else{
      const bpm=clamp(+S.bpm||120,40,240);clock+=ctx.dt*bpm/60*spb;pos=Math.floor(clock);
    }
    playing=true;
    const step=((pos%S.len)+S.len)%S.len;
    if(step===lastStep)return;
    lastStep=step;
    LANES.forEach(l=>{const v=S.lanes[l.id].steps[step];if(v)fire(l.id,v===2?.5:1)});
    paint(step);
  }

  // ---- pattern generation
  // k hits spread as evenly as possible over n steps, rotated
  const euclid=(k,n,rot)=>{const o=[];for(let i=0;i<n;i++)o.push(((i*k)%n)<k?1:0);const r=((rot%n)+n)%n;return o.slice(n-r).concat(o.slice(0,n-r))};
  function generate(style){
    const n=S.len,q=n/16,set=(lane,arr)=>{const st=S.lanes[lane].steps;for(let i=0;i<32;i++)st[i]=i<n?(arr[i]||0):0};
    const at=(idx,v)=>{const a=blank(n);idx.forEach(i=>{const j=Math.round(i*q);if(j<n)a[j]=v||1});return a};
    const R=Math.random;
    if(style==='clear'){LANES.forEach(l=>set(l.id,[]))}
    else if(style==='four'){
      set('zoom',at([0,4,8,12]));set('glitch',at([4,12]));set('flash',at([0]));set('shake',at([2,6,10,14],2));
      set('freeze',[]);set('black',[]);set('fx',at([14],2));set('scene',[]);
    }else if(style==='break'){
      set('zoom',at([0,6,10]));set('glitch',at([4,12,15],1));set('freeze',at([7],2));set('shake',at([3,11],2));
      set('flash',at([0]));set('black',at([13],2));set('fx',at([2,10],2));set('scene',[]);
    }else if(style==='trap'){
      set('zoom',at([0,7,10]));set('glitch',at([8]));set('shake',blank(n).map((_,i)=>i%2===0?2:0));
      set('freeze',at([14,15],2));set('flash',at([8]));set('black',[]);set('fx',at([3,11],2));set('scene',[]);
    }else if(style==='euclid'){
      LANES.forEach(l=>{if(l.id==='scene'||l.id==='flash')return set(l.id,[]);const k=1+Math.floor(R()*Math.min(7,n/2));set(l.id,euclid(k,n,Math.floor(R()*n)).map(v=>v?(R()<.7?1:2):0))});
      set('flash',at([0]));
    }else{ // random, weighted toward strong beats
      LANES.forEach(l=>{if(l.id==='scene')return set(l.id,[]);const d=l.id==='flash'||l.id==='black'?.06:l.id==='freeze'?.08:.22;
        set(l.id,blank(n).map((_,i)=>{const strong=i%(4*q)===0?2.2:i%(2*q)===0?1.3:1;return R()<d*strong?(R()<.7?1:2):0}))});
    }
    if(DATA.settings.safe){set('flash',[]);set('black',[])}
    Live.save();render();
  }

  // ---- panel
  const el={};
  function mount(host){
    const L=Live,sec=L.section('SEQUENCER','OFF','seqSec');el.note=sec.note;
    const top=L.h('div',{class:'btn-grid'});
    el.play=L.btn('▶ RUN SEQUENCER',()=>setOn(!S.on),'full');top.appendChild(el.play);sec.appendChild(top);
    const opts=L.h('div',{class:'seq-opts'});
    opts.appendChild(L.seg('Steps',[[8,'8'],[16,'16'],[32,'32']],S.len,v=>{S.len=+v;S.page=0;lastStep=-1;Live.save();render()}));
    opts.appendChild(L.seg('Resolution',[[16,'1/16'],[8,'1/8']],S.res,v=>{S.res=+v;lastStep=-1;Live.save()}));
    sec.appendChild(opts);
    el.pages=L.seg('Page',[[0,'1–16'],[1,'17–32']],S.page,v=>{S.page=+v;render()});el.pages.classList.add('seq-pages');sec.appendChild(el.pages);
    el.grid=L.h('div',{class:'seq-grid',role:'grid','aria-label':'Sequencer steps'});sec.appendChild(el.grid);
    const gen=L.h('div',{class:'live-seg seq-gen'});
    [['four','FOUR ON FLOOR'],['break','BREAKBEAT'],['trap','TRAP'],['euclid','EUCLID'],['random','RANDOM'],['clear','CLEAR']].forEach(([k,t])=>gen.appendChild(L.h('button',{type:'button',class:'chip',text:t,onclick:()=>generate(k)})));
    sec.appendChild(L.h('div',{class:'ctrl-top live-lbl'},[L.h('span',{class:'ctrl-label',text:'Generate'})]));sec.appendChild(gen);
    el.fx=L.select('FX lane effect',FX.filter(f=>f.id!=='skip').map(f=>[f.id,f.name]),S.fx,v=>{S.fx=v;Live.save()});sec.appendChild(el.fx);
    const det=L.h('details',{class:'adv'},[L.h('summary',{text:'Lanes, tempo & patterns'})]);
    const body=L.h('div',{class:'adv-body'});
    el.bpm=L.range('Tempo without a track',60,200,1,S.bpm,v=>{S.bpm=v;Live.save()},v=>Math.round(v)+' BPM');body.appendChild(el.bpm);
    LANES.forEach(l=>{
      const x=S.lanes[l.id];
      body.appendChild(L.range(l.label+' intensity',0,1,.01,x.int,v=>{x.int=v;Live.save()}));
      body.appendChild(L.range(l.label+' probability',0,1,.01,x.prob,v=>{x.prob=v;Live.save()},v=>Math.round(v*100)+'%'));
    });
    const nameIn=L.h('input',{type:'text',class:'live-input',placeholder:'pattern name','aria-label':'Pattern name',maxlength:24});
    el.pat=L.select('Saved patterns',[],'',()=>{});
    body.appendChild(L.h('div',{class:'live-row'},[nameIn,L.btn('SAVE',()=>{const n=nameIn.value.trim().slice(0,24);if(!n)return nameIn.focus();S.patterns[n]={len:S.len,res:S.res,fx:S.fx,lanes:deep(S.lanes)};Live.save();fillPatterns();el.pat.sel.value=n;toast('<b>PATTERN SAVED</b> — '+esc(n))})]));
    body.appendChild(el.pat);
    body.appendChild(L.h('div',{class:'btn-grid'},[L.btn('LOAD',()=>load(el.pat.sel.value)),L.btn('DELETE',()=>{const n=el.pat.sel.value;if(n&&S.patterns[n]){delete S.patterns[n];Live.save();fillPatterns()}})]));
    det.appendChild(body);sec.appendChild(det);
    sec.appendChild(L.h('p',{class:'section-desc',html:'Tap a step: off → full → soft. It follows the track’s beat grid; <kbd>Q</kbd> starts and stops it.'}));
    host.appendChild(sec);fillPatterns();render();sync();
  }
  function load(n){
    const p=S.patterns[n];if(!p)return;
    S.len=[8,16,32].includes(p.len)?p.len:16;S.res=p.res===8?8:16;if(p.fx&&FXMAP[p.fx])S.fx=p.fx;
    LANES.forEach(l=>{const x=p.lanes&&p.lanes[l.id];if(x&&Array.isArray(x.steps))S.lanes[l.id]={steps:x.steps.slice(0,32).map(v=>v===1||v===2?v:0).concat(blank(Math.max(0,32-x.steps.length))),int:clamp(+x.int||.8,0,1),prob:clamp(x.prob==null?1:+x.prob,0,1)}});
    S.page=0;Live.save();render();
    const kids=el.grid&&el.grid.parentNode?el.grid.parentNode.querySelectorAll('.live-seg'):[];
    if(kids[0])kids[0].pick(S.len);if(kids[1])kids[1].pick(S.res);if(el.fx)el.fx.sel.value=S.fx;
    toast('<b>PATTERN LOADED</b> — '+esc(n));
  }
  function fillPatterns(){
    if(!el.pat)return;const s=el.pat.sel;s.innerHTML='';
    const names=Object.keys(S.patterns);
    if(!names.length){const o=document.createElement('option');o.value='';o.textContent='—';s.appendChild(o)}
    names.forEach(n=>{const o=document.createElement('option');o.value=n;o.textContent=n;s.appendChild(o)});
  }
  function render(){
    if(!el.grid)return;el.grid.innerHTML='';
    const cols=Math.min(16,S.len),off=S.len===32?S.page*16:0;
    el.pages.hidden=S.len!==32;el.grid.style.setProperty('--cols',cols);
    LANES.forEach(l=>{
      el.grid.appendChild(Live.h('span',{class:'seq-lab',text:l.label}));
      for(let c=0;c<cols;c++){
        const i=off+c,v=S.lanes[l.id].steps[i];
        const b=Live.h('button',{type:'button',class:'seq-st'+(v===1?' on':v===2?' soft':'')+(i%4===0?' beat':''),'data-i':i,'aria-label':l.label+' step '+(i+1)+(v?(v===1?' full':' soft'):' off')});
        b.addEventListener('click',()=>{const st=S.lanes[l.id].steps;st[i]=st[i]===0?1:st[i]===1?2:0;b.className='seq-st'+(st[i]===1?' on':st[i]===2?' soft':'')+(i%4===0?' beat':'');b.setAttribute('aria-label',l.label+' step '+(i+1)+(st[i]?(st[i]===1?' full':' soft'):' off'));Live.save()});
        el.grid.appendChild(b);
      }
    });
    paint(lastStep);
  }
  function paint(step){
    if(!el.grid)return;
    el.grid.querySelectorAll('.seq-st.now').forEach(b=>b.classList.remove('now'));
    if(step>=0)el.grid.querySelectorAll('.seq-st[data-i="'+step+'"]').forEach(b=>b.classList.add('now'));
  }
  function setOn(v){S.on=!!v;lastStep=-1;clock=0;Live.save();sync();if(!S.on)paint(-1)}
  function sync(){if(!el.play)return;el.play.textContent=S.on?'■ STOP SEQUENCER':'▶ RUN SEQUENCER';el.play.classList.toggle('acid',S.on);el.play.setAttribute('aria-pressed',String(S.on));setTxt(el.note,S.on?S.len+' STEPS':'OFF')}

  Live.addTicker(tick);
  Live.addAction('seq','Sequencer on/off',()=>setOn(!S.on));
  Live.addKey('q',()=>{setOn(!S.on);toast(S.on?'<b>SEQUENCER</b> — running':'<b>SEQUENCER</b> — stopped')});
  return {mount,setOn,generate,load,get settings(){return S},get playing(){return playing}};
})();
