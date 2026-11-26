// Modes — QUICK (a minimal dock: upload → distort → explore → export), LIVE (the full instrument) and
// LAB (the full instrument opened on the experimental effects). Switching only changes what is shown:
// the look, the source, the music and every setting stay as they are.
'use strict';
const Modes=(()=>{
  const S=Live.part('ui',{mode:'live',style:''});
  if(!['quick','live','lab'].includes(S.mode))S.mode='live';
  const el={};

  function set(m,quiet){
    if(!['quick','live','lab'].includes(m))return;
    S.mode=m;Live.save();document.body.dataset.mode=m;
    $$('.mode-sw button').forEach(b=>{const on=b.dataset.m===m;b.classList.toggle('on',on);b.setAttribute('aria-checked',String(on))});
    if(m!=='live'&&m!=='lab'){if(document.body.dataset.sheet)closeSheet()}
    if(m==='lab'){
      // effects list filtered on the LAB family, LIVE tab open on the right
      const chip=$('#fxFilters .chip[data-cat="LAB"]');if(chip)chip.click();
      const t=$('.tab[data-tab="live"]');if(t&&!t.classList.contains('on'))t.click();
    }else if(m==='live'){const chip=$('#fxFilters .chip[data-cat="ALL"]');if(chip&&!chip.classList.contains('on'))chip.click()}
    if(m==='quick'){sync();Motion.stagger(el.dock.querySelector('.qd-row'))}
    if(!quiet){const it=LANG==='it',d=m==='quick'?(it?'carica, distorci, esplora, esporta':'upload, distort, explore, export'):m==='lab'?(it?'effetti sperimentali':'experimental effects'):(it?'lo strumento completo':'the full instrument');
      toast('<b>'+(it?'MODALITÀ ':'')+m.toUpperCase()+(it?'':' MODE')+'</b> — '+d)}
  }

  function build(){
    // the switch (top bar on wide screens, a floating pill under it on phones)
    const sw=Live.h('div',{class:'mode-sw',role:'radiogroup','aria-label':'Mode'});
    [['quick','QUICK'],['live','LIVE'],['lab','LAB']].forEach(([m,t])=>sw.appendChild(Live.h('button',{type:'button','data-m':m,role:'radio',text:t,onclick:()=>set(m)})));
    const brand=$('#topbar .brand');if(brand)brand.after(sw);else document.body.appendChild(sw);
    el.sw=sw;
    // the QUICK dock
    const d=Live.h('div',{id:'quickDock',role:'region','aria-label':'Quick mode'});
    el.flow=Live.h('ol',{class:'qd-flow'},['UPLOAD','DISTORT','EXPLORE','EXPORT'].map(t=>Live.h('li',{text:t})));
    d.appendChild(el.flow);
    const row=Live.h('div',{class:'qd-row'});
    const btn=(t,fn,cls,title)=>Live.h('button',{type:'button',class:'qd-b'+(cls?' '+cls:''),text:t,title:title||t,onclick:fn});
    row.appendChild(btn('MEDIA',()=>{const f=$id('fileInput');if(f)f.click()},'','Upload an image or a video'));
    row.appendChild(btn('BEAT',()=>{const f=$id('musicFile');if(f)f.click()},'','Upload a track'));
    row.appendChild(btn('✦ AI',()=>openGen(),'','Generate an image from text'));
    el.style=Live.h('select',{class:'qd-sel','aria-label':'Mood / style'});
    el.style.appendChild(Live.h('option',{value:'',text:'MOOD…'}));
    Quick.STYLES.forEach(s=>el.style.appendChild(Live.h('option',{value:s.id,text:s.name})));
    el.style.value=S.style||'';
    el.style.addEventListener('change',()=>{const s=Quick.STYLES.find(x=>x.id===el.style.value);if(!s)return;S.style=s.id;Live.save();Quick.applyStyle(s);
      if(Autopilot.settings.on)Autopilot.setMode(s.ap==='direct'?'direct':s.ap);sync()});
    row.appendChild(el.style);
    const iw=Live.h('label',{class:'qd-int'},[Live.h('span',{text:'INTENSITY'})]);
    el.int=Live.h('input',{type:'range',min:0,max:2,step:.01,value:P.intensity,'aria-label':'Intensity'});
    el.int.addEventListener('input',()=>{P.intensity=+el.int.value;Live.syncControl('m:intensity');fillRange(el.int)});
    iw.appendChild(el.int);row.appendChild(iw);
    el.sync=btn('BEAT SYNC',()=>{const on=!Autopilot.settings.on;Autopilot.setOn(on);if(on&&Music.hasTrack()&&!Music.isPlaying())Music.play();sync()},'tog','Let the autopilot play the visuals with the music');
    row.appendChild(el.sync);
    row.appendChild(btn('⚄ RANDOM',()=>{randomizeLook();sync()},'','Generate a random visual'));
    row.appendChild(btn('VARIATIONS',()=>{el.vars.classList.toggle('on');if(el.vars.classList.contains('on'))Mutation.variations(3,el.vars)},'','Three mutations of this look'));
    row.appendChild(btn('● EXPORT',()=>Clip.open(),'hot','Record and export a clip'));
    d.appendChild(row);
    el.vars=Live.h('div',{class:'qd-vars mut-vars','aria-label':'Variations: tap one to keep it'});
    d.appendChild(el.vars);
    document.body.appendChild(d);el.dock=d;el.row=row;
  }
  // the flow lights up as the steps are done
  function sync(){
    if(!el.dock)return;
    const src=Engine.getSrc(),has=src&&!src.empty,fx=FX.some(f=>P.on[f.id]);
    [has,has&&fx,Mutation.history.length>1||Autopilot.settings.on,!!DATA.lastExport].forEach((v,i)=>el.flow.children[i].classList.toggle('done',!!v));
    el.sync.classList.toggle('on',Autopilot.settings.on);el.sync.setAttribute('aria-pressed',String(Autopilot.settings.on));
    if(document.activeElement!==el.int){el.int.value=P.intensity;fillRange(el.int)}
  }
  function init(){
    build();set(S.mode,true);
    Live.on('ap',sync);
    setInterval(()=>{if(S.mode==='quick')sync()},1000);
  }
  Live.addAction('mode:quick','Quick mode',()=>set('quick'));
  Live.addAction('mode:live','Live mode',()=>set('live'));
  Live.addAction('mode:lab','Lab mode',()=>set('lab'));
  Live.addKey('0',()=>set(S.mode==='quick'?'live':S.mode==='live'?'lab':'quick'));
  return {init,set,get mode(){return S.mode}};
})();
Modes.init();
