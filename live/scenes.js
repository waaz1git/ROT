// Scenes — complete visual states you can fire live (keys 1–9, MIDI pads, the sequencer, the autopilot).
// A scene stores the whole look (effects, amounts, masters, colour grade, pixel size) and, optionally, the
// music-reactive routes. Transitions: CUT, SMOOTH (every compatible value interpolated), GLITCH (the old look
// tears apart, then a hard swap), FLASH (white hit on the swap), MORPH (interpolation through a liquid warp).
// Values are written straight into the look every frame: no reset of the decay, the source or the resolution.
'use strict';
const Scenes=(()=>{
  const S=Live.part('scenes',{list:[],cur:-1,trans:'smooth',dur:1.2,music:false});
  if(!Array.isArray(S.list))S.list=[];
  const NAMES='ABCDEFGHIJKL';
  if(!S.list.length)for(let i=0;i<4;i++)S.list.push({name:'Scene '+NAMES[i],look:null});
  // drop damaged entries; a stored look must have its effect maps
  const okLook=l=>!!(l&&typeof l==='object'&&l.on&&typeof l.on==='object'&&l.fx&&typeof l.fx==='object');
  S.list=S.list.filter(x=>x&&typeof x==='object').slice(0,12).map((x,i)=>({name:String(x.name||'Scene '+NAMES[i]).slice(0,20),look:okLook(x.look)?x.look:null,routes:Array.isArray(x.routes)?x.routes:null,react:x.react==null?null:!!x.react}));
  if(!S.list.length)for(let i=0;i<4;i++)S.list.push({name:'Scene '+NAMES[i],look:null});
  if(!['cut','smooth','glitch','flash','morph'].includes(S.trans))S.trans='smooth';
  S.dur=clamp(+S.dur||1.2,.1,4);
  S.cur=clamp(S.cur|0,-1,S.list.length-1);
  let tr=null; // running transition {from,to,start,dur,type,i,swapped}
  let sel=Math.max(0,S.cur);

  const stored=()=>S.list.filter(x=>x.look).length;
  function capture(i){
    const sc=S.list[i];if(!sc)return;
    sc.look=snapshotLook();
    sc.routes=S.music?deep(Music.settings.routes):null;
    sc.react=S.music?!!Music.settings.reactOn:null;
    S.cur=i;Live.save();render();
    toast('<b>'+esc(sc.name.toUpperCase())+' STORED</b>');
  }
  function recall(i,type){
    const sc=S.list[i];if(!sc)return false;
    if(!sc.look){capture(i);return true}
    type=type||S.trans;
    const to=Live.toLook(sc.look),from=snapshotLook(),dur=Math.max(.05,+S.dur||1)*1000;
    if(sc.routes&&Array.isArray(sc.routes)){try{Music.setRoutes(deep(sc.routes),sc.react)}catch(e){}}
    S.cur=i;Live.save();render();Live.emit('scene',i);
    const pix0=P.pix;
    if(type==='cut'||DATA.settings.reduce&&type!=='smooth'){tr=null;finish(to,pix0);return true}
    tr={from,to,start:performance.now(),dur,type,i,swapped:false,pix0};
    return true;
  }
  function finish(to,pix0){
    Live.writeLook(to);
    if(Math.abs((pix0==null?P.pix:pix0)-P.pix)>.001)Engine.resize();
    syncUI();queueSaveLook();
    tr=null;
  }
  const ease=k=>k<.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2;
  function tick(ctx){
    if(!tr)return;
    const k=clamp((ctx.now-tr.start)/tr.dur,0,1),out=ctx.out;
    if(tr.type==='smooth'||tr.type==='morph'){
      Live.writeLook(Live.lookLerp(tr.from,tr.to,ease(k)));
      if(tr.type==='morph'){const sw=Math.sin(Math.PI*k);out.fx.fluid=(out.fx.fluid||0)+sw*.7;out.fx.liquid=(out.fx.liquid||0)+sw*.4;out.zoom+=sw*.06}
    }else{
      // glitch / flash: hold the old look while it breaks, swap in the middle
      const sw=Math.sin(Math.PI*k);
      if(tr.type==='glitch'){out.fx.glitch=(out.fx.glitch||0)+sw*1.2;out.fx.rgb=(out.fx.rgb||0)+sw*.8;out.fx.tear=(out.fx.tear||0)+sw*.6;out.fx.comp=(out.fx.comp||0)+sw*.5}
      if(!tr.swapped&&k>=.5){
        tr.swapped=true;Live.writeLook(tr.to);
        // the effects of the new look arrive at once (no slow fade between two unrelated looks)
        Object.assign(A,deep(P));FX.forEach(f=>A.fx[f.id]=P.on[f.id]?P.fx[f.id]:0);
        if(tr.type==='flash')Live.trigger('flash',.9);else Live.trigger('black',.6);
      }
    }
    if(k>=1)finish(tr.to,tr.pix0);
  }
  function next(d){
    const n=S.list.length;if(stored()<1)return false;
    for(let j=1;j<=n;j++){const i=((S.cur<0?(d>0?-1:0):S.cur)+d*j+n*4)%n;if(S.list[i].look&&i!==S.cur)return recall(i)}
    return false;
  }

  // ---- panel
  const el={};
  function mount(host){
    const L=Live,sec=L.section('SCENES','','scnSec');el.note=sec.note;
    el.grid=L.h('div',{class:'scn-grid',role:'list','aria-label':'Scenes'});sec.appendChild(el.grid);
    const ed=L.h('div',{class:'btn-grid scn-edit'});
    ed.appendChild(L.btn('● STORE',()=>capture(sel)));
    ed.appendChild(L.btn('RENAME',()=>{const sc=S.list[sel];if(!sc)return;const n=prompt(LANG==='it'?'Nome della scena':'Scene name',sc.name);if(n&&n.trim()){sc.name=n.trim().slice(0,20);Live.save();render()}}));
    ed.appendChild(L.btn('DUPLICATE',()=>{const sc=S.list[sel];if(!sc||S.list.length>=12)return toast('<b>12 SCENES MAX</b>');S.list.splice(sel+1,0,{name:(sc.name+' 2').slice(0,20),look:sc.look?deep(sc.look):null,routes:sc.routes?deep(sc.routes):null,react:sc.react});if(S.cur>sel)S.cur++;sel++;Live.save();render()}));
    ed.appendChild(L.btn('DELETE',()=>{if(S.list.length<=1)return;const sc=S.list[sel];if(sc.look&&!confirm((LANG==='it'?'Eliminare ':'Delete ')+sc.name+'?'))return;S.list.splice(sel,1);if(S.cur>=sel)S.cur--;sel=clamp(sel,0,S.list.length-1);Live.save();render()}));
    ed.appendChild(L.btn('◀ MOVE',()=>move(-1)));ed.appendChild(L.btn('MOVE ▶',()=>move(1)));
    ed.appendChild(L.btn('+ NEW SCENE',()=>{if(S.list.length>=12)return toast('<b>12 SCENES MAX</b>');S.list.push({name:'Scene '+NAMES[S.list.length],look:null});sel=S.list.length-1;Live.save();render()},'full'));
    sec.appendChild(ed);
    el.trans=L.seg('Transition',[['cut','CUT'],['smooth','SMOOTH'],['glitch','GLITCH'],['flash','FLASH'],['morph','MORPH']],S.trans,v=>{S.trans=v;Live.save()});
    sec.appendChild(L.h('div',{class:'ctrl-top live-lbl'},[L.h('span',{class:'ctrl-label',text:'Transition'})]));sec.appendChild(el.trans);
    sec.appendChild(L.range('Transition time',.1,4,.05,S.dur,v=>{S.dur=v;Live.save()},v=>(+v).toFixed(2)+' S'));
    sec.appendChild(L.sw('Store the music mapping too',S.music,v=>{S.music=v;Live.save()}));
    sec.appendChild(L.h('p',{class:'section-desc',html:'Tap a scene to fire it, tap an empty one to store the current look. Keys <kbd>1</kbd>–<kbd>9</kbd> fire, <kbd>Shift</kbd>+number stores.'}));
    host.appendChild(sec);render();
  }
  // a preview of the scene's look on the current picture, drawn by the live engine
  function thumb(b,look){
    try{
      const w=96,h=60,im=new ImageData(w,h);
      if(!Engine.renderThumb(Mutation.frameOf(Live.toLook(look)),w,h,w*2,h*2,im))return;
      const cv=document.createElement('canvas');cv.width=w;cv.height=h;cv.className='scn-th';cv.getContext('2d').putImageData(im,0,0);b.prepend(cv);b.classList.add('has-th');
    }catch(e){}
  }
  function move(d){
    const j=sel+d;if(j<0||j>=S.list.length)return;
    [S.list[sel],S.list[j]]=[S.list[j],S.list[sel]];
    if(S.cur===sel)S.cur=j;else if(S.cur===j)S.cur=sel;
    sel=j;Live.save();render();
  }
  function render(){
    if(!el.grid)return;el.grid.innerHTML='';
    S.list.forEach((sc,i)=>{
      const b=Live.h('button',{type:'button',class:'scn'+(sc.look?'':' empty')+(i===S.cur?' cur':'')+(i===sel?' sel':''),role:'listitem',
        'aria-label':sc.name+(sc.look?'':' (empty)')+(i<9?' — key '+(i+1):'')},
        [Live.h('b',{text:i<9?String(i+1):'·'}),Live.h('span',{text:sc.name})]);
      if(sc.look){b.style.setProperty('--h',hashHue(JSON.stringify(sc.look.on))+'deg');thumb(b,sc.look)}
      b.addEventListener('click',()=>{sel=i;recall(i)});
      b.addEventListener('contextmenu',e=>{e.preventDefault();sel=i;render()});
      el.grid.appendChild(b);
    });
    setTxt(el.note,stored()+' / '+S.list.length);
  }

  Live.addTicker(tick);
  for(let i=0;i<12;i++)Live.addAction('scene:'+(i+1),'Scene '+(i+1),()=>{if(S.list[i])recall(i)});
  Live.addAction('scene:next','Next scene',()=>next(1));
  Live.addAction('scene:prev','Previous scene',()=>next(-1));
  Live.addAction('scene:store','Store into the current scene',()=>capture(Math.max(0,S.cur)));
  Live.addParam('scn:dur','Scene transition time','Live',()=>(S.dur-.1)/3.9,v=>{S.dur=.1+v*3.9;Live.save()});
  for(let i=1;i<=9;i++)Live.addKey(String(i),e=>{const j=i-1;if(!S.list[j])return;if(e.shiftKey)capture(j);else{sel=j;recall(j)}});
  function cancel(){if(tr){tr=null;syncUI()}}
  return {mount,recall,capture,next,stored,cancel,get list(){return S.list},get cur(){return S.cur},get busy(){return !!tr}};
})();
