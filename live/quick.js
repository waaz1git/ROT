// Quick Play — the fast lane for new users: picture → beat → style → GO, then mutate, preview, record, export.
// Every step uses the real controls underneath (the same file pickers, recipes, autopilot and sequencer), so
// nothing here is a separate toy: after GO the full instrument is still one tap away.
'use strict';
const Quick=(()=>{
  // curated styles: a look + how the autopilot and the sequencer play it
  const STYLES=[
    {id:'underground',name:'UNDERGROUND',d:'Bleached tape, crushed blocks, contours',fx:{vhs:.45,comp:.35,post:.3,edge:.25,decay:.3,tear:.2},m:{speed:.8,chaos:.35,hueShift:-20},grade:1,ap:'follow',seq:'four'},
    {id:'flesh',name:'FLESH',d:'Breathing tissue under hot light',fx:{flesh:.6,liquid:.22,bloom:.3,ghost:.2,dirt:.25},m:{speed:.7,org:.9},grade:0,ap:'follow',seq:'break'},
    {id:'vhs',name:'VHS',d:'A dying tape on a bad signal',fx:{vhs:.7,transmission:.35,tear:.3,ca:.3,dirt:.2,ghost:.15},m:{speed:1},grade:4,ap:'follow',seq:'four'},
    {id:'decay',name:'DIGITAL DECAY',d:'Colour collapse, macroblocks, memory leak',fx:{collapse:.45,comp:.45,mosh:.35,sort:.3,post:.3,leak:.25},m:{speed:.9},grade:2,ap:'follow',seq:'euclid'},
    {id:'chaos',name:'CHAOS',d:'Shards, splits and blackouts on every hit',fx:{glitch:.6,rgb:.55,kaleido:.4,fracture:.4,blackout:.2,parasite:.3},m:{chaos:.85,speed:1.6},grade:0,ap:'chaos',seq:'random'},
    {id:'nightmare',name:'NIGHTMARE',d:'Melting, dissolving, infrared',fx:{void:.45,melt:.35,ghost:.35,decay:.45,fb:.3,edge:.2},m:{hueShift:150,speed:.6},grade:3,ap:'follow',seq:'trap'},
    {id:'liquid',name:'LIQUID',d:'Everything flows with the bass',fx:{liquid:.6,fluid:.5,ripple:.35,prism:.3,bloom:.35},m:{org:1.2,speed:.9},grade:0,ap:'direct',seq:'four'},
    {id:'hyper',name:'HYPERVISION',d:'Prisms, neon contours, acid colour',fx:{kaleido:.45,prism:.5,edge:.45,glare:.4,bloom:.45,rgb:.25},m:{hueShift:60,speed:1.3},grade:5,ap:'follow',seq:'four'},
    {id:'signal',name:'SIGNAL',d:'Interference, tears, broken transmission',fx:{rgb:.45,glitch:.45,tear:.35,comp:.3,transmission:.25,sort:.25},m:{gfreq:.75},grade:0,ap:'follow',seq:'break'},
    {id:'abstract',name:'ABSTRACT',d:'Fractured, mirrored, posterised',fx:{fracture:.5,mirror:.4,post:.4,leak:.35,prism:.3},m:{speed:.8,hueShift:-90},grade:0,ap:'direct',seq:'euclid'}
  ];
  let dlg=null,step=0,style=null;const el={};

  function applyStyle(s){
    applyPreset({fx:s.fx,m:s.m,grade:s.grade},false);
    if(typeof cvFx==='function')cvFx('rx-in');
    DATA.activePreset=null;
  }
  async function go(){
    if(!style)return;
    applyStyle(style);
    const track=Music.hasTrack();
    if(track){
      Autopilot.setMode(style.ap);Autopilot.setOn(true,{holdScenes:true});
      Seq.generate(style.seq);Seq.setOn(true);
      if(!Music.isPlaying())Music.play();
    }
    if(typeof markDirty==='function')markDirty();
    step=3;render();
    toast('<b>'+esc(style.name)+'</b> — '+(track?'autopilot + sequencer on the beat':'add a beat to make it move with the music'),3200);
  }
  function build(){
    const L=Live;
    dlg=L.h('div',{id:'qplay',class:'live-dlg',role:'dialog','aria-modal':'true','aria-labelledby':'qpTitle','aria-hidden':'true'});
    const card=L.h('div',{class:'live-card qp-card'});
    card.appendChild(L.h('div',{class:'ks-head'},[L.h('h2',{id:'qpTitle',text:'Quick play'}),L.h('button',{type:'button',class:'ks-close',text:'CLOSE ✕',onclick:close})]));
    el.steps=L.h('ol',{class:'qp-steps'},['Picture','Beat','Style','Play'].map((t,i)=>L.h('li',{'data-i':i},[L.h('b',{text:String(i+1)}),L.h('span',{text:t})])));
    card.appendChild(el.steps);
    el.body=L.h('div',{class:'qp-body'});card.appendChild(el.body);
    el.nav=L.h('div',{class:'btn-grid qp-nav'});card.appendChild(el.nav);
    dlg.appendChild(card);document.body.appendChild(dlg);
    dlg.addEventListener('click',e=>{if(e.target===dlg)close()});
  }
  function render(){
    const L=Live,b=el.body;b.innerHTML='';el.nav.innerHTML='';
    $$('li',el.steps).forEach((li,i)=>{li.classList.toggle('on',i===step);li.classList.toggle('done',i<step)});
    if(step===0){
      const src=Engine.getSrc(),has=src&&!src.empty;
      b.appendChild(L.h('p',{class:'section-desc',text:has?'You already have a picture. Keep it or pick another.':'Start with an image or a video, or let the AI draw one.'}));
      b.appendChild(L.h('div',{class:'btn-grid'},[
        L.btn('UPLOAD IMAGE / VIDEO',()=>{const f=$id('fileInput');if(f){f.click();waitSource()}},'acid'),
        L.btn('✦ TEXT → IMAGE',()=>{close();openGen()}),
        L.btn('USE THE SAMPLE',async()=>{await loadSampleSource();step=1;render()})]));
      el.nav.appendChild(L.btn(has?'NEXT →':'SKIP →',()=>{step=1;render()},'full'));
    }else if(step===1){
      const has=Music.hasTrack();
      b.appendChild(L.h('p',{class:'section-desc',text:has?'Track loaded: '+Math.round(Music.settings.bpm)+' BPM. The visuals will follow it.':'Add a beat: the autopilot reads kicks, snares, hats, builds and drops.'}));
      b.appendChild(L.h('div',{class:'btn-grid'},[
        L.btn('UPLOAD A BEAT',()=>{const f=$id('musicFile');if(f){f.click();waitTrack()}},'acid'),
        L.btn('DEMO BEAT',async()=>{try{await playDemoBeat()}catch(e){}step=2;render()})]));
      el.nav.appendChild(L.btn('← BACK',()=>{step=0;render()}));el.nav.appendChild(L.btn(has?'NEXT →':'NO MUSIC →',()=>{step=2;render()}));
    }else if(step===2){
      const g=L.h('div',{class:'qp-styles',role:'listbox','aria-label':'Visual styles'});
      STYLES.forEach(s=>{
        const c=L.h('button',{type:'button',class:'qp-style'+(style===s?' on':''),role:'option','aria-selected':String(style===s)},[L.h('b',{text:s.name}),L.h('span',{text:s.d})]);
        c.style.setProperty('--h',hashHue(s.id)+'deg');
        c.addEventListener('click',()=>{style=s;applyStyle(s);$$('.qp-style',g).forEach(x=>{x.classList.toggle('on',x===c);x.setAttribute('aria-selected',String(x===c))});go2.disabled=false});
        g.appendChild(c);
      });
      b.appendChild(g);Motion.stagger(g,10);
      const go2=L.btn('GO ▶',go,'hot');go2.disabled=!style;
      el.nav.appendChild(L.btn('← BACK',()=>{step=1;render()}));el.nav.appendChild(go2);
    }else{
      b.appendChild(L.h('p',{class:'section-desc',text:(style?style.name+' is playing. ':'')+'Mutate it until it feels right, then record. Every control is still in the panels.'}));
      b.appendChild(L.h('div',{class:'btn-grid'},[
        L.btn('⟳ MUTATE',()=>Mutation.mutate(),'acid'),L.btn('RANDOMIZE',()=>{randomizeLook()}),
        L.btn('↶ UNDO',()=>Mutation.undo()),L.btn('PREVIEW',()=>close()),
        L.btn('◧ QUICK CLIP',()=>{close();Clip.open()},'hot'),L.btn('● RECORD',()=>{close();toggleRecording()}),
        L.btn('FRAME PNG',()=>exportPNG(),'full')]));
      el.nav.appendChild(L.btn('← STYLES',()=>{step=2;render()},'full'));
    }
    Motion.stagger(b);
  }
  // move on by itself once the picked file has loaded
  function waitSource(){const t0=Engine.getSrc();let n=0;const iv=setInterval(()=>{const s=Engine.getSrc();if((s!==t0&&s&&!s.empty)||++n>120){clearInterval(iv);if(s!==t0&&dlg.classList.contains('on')&&step===0){step=1;render()}}},500)}
  function waitTrack(){let n=0;const had=Music.hasTrack()&&Music.currentTime();const iv=setInterval(()=>{if((Music.hasTrack()&&!had)||++n>240){clearInterval(iv);if(Music.hasTrack()&&dlg.classList.contains('on')&&step===1){step=2;render()}}},500)}
  function open(at){
    if(!dlg)build();
    if(typeof closeGen==='function')closeGen();if(document.body.dataset.sheet)closeSheet();if(drawerOpen)closeDrawer(drawerOpen);
    if(Tour.on)endTour(true);
    step=at!=null?at:(Engine.getSrc().empty?0:(Music.hasTrack()?2:1));render();
    dlg.classList.add('on');dlg.setAttribute('aria-hidden','false');setTimeout(()=>glitchIn($id('qpTitle')),60);
  }
  function close(){if(!dlg)return;dlg.classList.remove('on');dlg.setAttribute('aria-hidden','true')}
  window.addEventListener('keydown',e=>{if(e.key==='Escape'&&dlg&&dlg.classList.contains('on')){e.preventDefault();e.stopPropagation();close()}},true);
  Live.addAction('quick','Quick play',()=>open());
  STYLES.forEach(s=>Live.addAction('style:'+s.id,'Style '+s.name,()=>{style=s;applyStyle(s)}));
  return {open,close,STYLES,applyStyle};
})();
