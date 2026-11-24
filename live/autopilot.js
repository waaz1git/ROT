// Visual Autopilot — reads the track as music (sections, instruments, phrases) and plays the visuals.
//   FOLLOW  reacts on its own: each instrument drives its own family of effects, sections reshape the look
//   DIRECT  only modulates what you switched on, on top of your own slider values
//   CHAOS   picks a small "theme" of effects per phrase and mutates it on the hits: wild but coherent
// Input: the Music module's beat grid and hits (kick/snare/hat/drop) when a track plays; a microphone or
// video sound falls back to energy + onset detection without a grid.
'use strict';
const Autopilot=(()=>{
  const S=Live.part('ap',{on:false,mode:'follow',sens:1,react:.6,smooth:.5,amount:.7,thresh:.35,scenes:'phrase',phrase:8});
  if(!['follow','direct','chaos'].includes(S.mode))S.mode='follow';
  if(!['phrase','drops','off'].includes(S.scenes))S.scenes='phrase';
  S.phrase=[4,8,16].includes(+S.phrase)?+S.phrase:8;
  // which effects each part of the music drives (FOLLOW / CHAOS)
  const BAND={OPTICAL:'bass',SIGNAL:'snare',LIGHT:'high',LAB:'energy'};
  const GEO=['liquid','fluid','ripple','fish','disp','flesh','melt','fracture','kaleido','mirror'];
  const SIG=['rgb','ca','glitch','tear','mosh','comp','sort','vhs','collapse','transmission'];
  const LIT=['bloom','prism','edge','glare','ghost','fb','leak'];
  const LAB=['parasite','void','blackout','post','decay'];

  const st={section:'idle',secSince:0,eS:0,eM:0,eL:0,quietFor:0,dropUntil:0,build:0,prevP:{},lastBar:-1,barCount:0,
    kicks:[],snares:[],hats:[],theme:[],themeBar:-99,hueEnv:0,hueTarget:0,lastUi:0,src:'none',bass:0,mid:0,high:0,mBass:0,hit:{k:0,s:0,h:0}};

  // opt.holdScenes: don't jump to stored scenes until the user fires one (Quick Play keeps the style just picked)
  function setOn(v,opt){S.on=!!v;st.holdScenes=!!(opt&&opt.holdScenes);Live.save();Live.emit('ap',S.on);if(!S.on){st.section='idle'}}
  function setMode(m){if(!['follow','direct','chaos'].includes(m))return;S.mode=m;st.themeBar=-99;Live.save();Live.emit('ap',S.on)}

  // ---- read the audio: grid + hits from a track, energy + onsets otherwise
  function read(ctx){
    const mus=ctx.mus,now=ctx.now;
    let lv=null,ev={k:0,s:0,h:0,drop:0},grid=null;
    if(mus&&mus.loaded&&mus.playing){
      st.src='track';lv=mus.level;const p=mus.pulse||{};
      const edge=k=>{const v=+p[k]||0,pv=st.prevP[k]||0;st.prevP[k]=v;return v>pv+.25?v:0};
      ev.k=edge('kick');ev.s=edge('snare');ev.h=edge('hihat');ev.drop=edge('drop');
      grid={bar:mus.barIndex|0,beat:mus.beatIndex|0,down:!!mus.downbeat,bpm:+mus.bpm||120};
    }else if(DATA.settings.audioReact&&typeof AudioBus!=='undefined'&&AudioBus.audioAvailable()){
      st.src='input';
      try{lv=AudioBus.levels}catch(e){lv=null}
      if(lv){
        // onset = bass jumping above its own running mean
        st.mBass+=((lv.bass||0)-st.mBass)*.05;
        if((lv.bass||0)>st.mBass*1.35+.04&&now-(st.kicks[st.kicks.length-1]||0)>180)ev.k=1;
        if((lv.high||0)>.18&&(lv.mid||0)>.12&&now-(st.snares[st.snares.length-1]||0)>220&&Math.random()<.5)ev.s=.8;
      }
    }else st.src='none';
    return {lv,ev,grid};
  }

  // ---- sections: silence, breakdown, build, drop, groove
  function sections(ctx,lv,ev,grid){
    const dt=ctx.dt,now=ctx.now;
    const e=lv?clamp(+(lv.energy!=null?lv.energy:lv.v)||0,0,1):0;
    st.eS+=(e-st.eS)*(1-Math.exp(-dt/.3));st.eM+=(e-st.eM)*(1-Math.exp(-dt/1.6));st.eL+=(e-st.eL)*(1-Math.exp(-dt/7));
    const cut=w=>w.filter(t=>now-t<4000);
    if(ev.k)st.kicks.push(now);if(ev.s)st.snares.push(now);if(ev.h)st.hats.push(now);
    st.kicks=cut(st.kicks);st.snares=cut(st.snares);st.hats=cut(st.hats);
    st.quietFor=st.eS<.02?st.quietFor+dt:0;
    const kicks2=st.kicks.filter(t=>now-t<2000).length;
    let sec='groove';
    if(st.src==='none')sec='idle';
    else if(now<st.dropUntil)sec='drop';
    else if(st.quietFor>.5)sec='silence';
    else if(st.eL>.04&&st.eS<st.eL*.55&&kicks2<1)sec='breakdown';
    else if(st.eM>st.eL*1.08&&(st.hats.length+st.snares.length)>(st.kicks.length*1.5)&&(st.section==='breakdown'||st.section==='build'))sec='build';
    // a drop: the track's own drop detector, or energy jumping back after a breakdown/build with a kick
    const jump=(st.section==='breakdown'||st.section==='build')&&ev.k&&st.eS>st.eL*1.3;
    if(ev.drop||jump){sec='drop';const beat=grid?60/grid.bpm:.5;st.dropUntil=now+Math.max(3000,beat*16*1000)}
    if(sec!==st.section){
      const was=st.section;st.section=sec;st.secSince=now;
      if(sec==='drop')onDrop(was);
      Live.emit('section',sec,was);
    }
    st.build=sec==='build'?clamp(st.build+dt/(grid?(60/grid.bpm)*32:14),0,1):Math.max(0,st.build-dt*.8);
  }

  const scenesReady=()=>!st.holdScenes&&Scenes.stored()>=2&&!Scenes.busy;
  Live.on('scene',()=>{st.holdScenes=false});
  function onDrop(){
    const A=S.amount;
    if(S.mode!=='direct'){Live.trigger('flash',.75*A);Live.trigger('shake',.9*A)}
    Live.trigger('glitch',A);Live.trigger('zoom',.8*A);
    if(S.scenes!=='off'&&scenesReady())Live.run('scene:next');
    else if(S.mode==='chaos'&&!(typeof Scenes!=='undefined'&&Scenes.busy))Mutation.mutate({amount:.45,quiet:true});
  }

  // ---- phrases: every N bars (on the downbeat) the look moves on
  function phrases(grid){
    if(!grid||grid.bar===st.lastBar)return;
    st.lastBar=grid.bar;st.barCount++;
    if(S.mode==='chaos'&&(grid.bar-st.themeBar>=4||!st.theme.length))newTheme(grid.bar);
    if(grid.bar>0&&grid.bar%Math.max(1,S.phrase|0)===0&&st.section!=='drop'){
      if(S.scenes==='phrase'&&scenesReady())Live.run('scene:next');
      else if(S.mode==='chaos'&&!Scenes.busy)Mutation.mutate({amount:.3,quiet:true});
    }
  }
  // CHAOS theme: one shape, two signal, one light and one lab effect — enough variety, still one look
  function newTheme(bar){
    const pick1=a=>a[Math.floor(Math.random()*a.length)];
    const t=new Set([pick1(GEO),pick1(SIG),pick1(SIG),pick1(LIT),pick1(LAB)]);
    st.theme=[...t];st.themeBar=bar;
  }

  // ---- the mapping
  function tick(ctx){
    if(!S.on){if(ctx.now-st.lastUi>250)ui(ctx);return}
    const {lv,ev,grid}=read(ctx);
    sections(ctx,lv,ev,grid);
    phrases(grid);
    const out=ctx.out,dt=ctx.dt,sens=clamp(S.sens,0,2),A=clamp(S.amount,0,1)*sens;
    // smoothed bands: attack follows "reaction", release follows "smoothing"
    const att=1-Math.exp(-dt*(4+S.react*26)),rel=1-Math.exp(-dt*(1.2+(1-S.smooth)*10));
    const fol=(cur,v)=>cur+(v-cur)*(v>cur?att:rel);
    st.bass=fol(st.bass,lv?+lv.bass||0:0);st.mid=fol(st.mid,lv?+lv.mid||0:0);st.high=fol(st.high,lv?+lv.high||0:0);
    const th=clamp(S.thresh,0,1)*.35;
    const band=b=>Math.max(0,(b==='bass'?st.bass:b==='high'?st.high:b==='snare'?st.mid:st.eS)-th)/(1-th);
    const sec=st.section,calm=sec==='breakdown'?.35:sec==='silence'?.1:1,boost=sec==='drop'?1.4:1;
    const hitK=ev.k&&(!lv||st.bass>th*.6),hitS=ev.s,hitH=ev.h&&st.high>th*.4;
    st.hit.k=hitK?1:st.hit.k*.85;st.hit.s=hitS?1:st.hit.s*.85;st.hit.h=hitH?1:st.hit.h*.85;
    const add=(id,v)=>{if(v>.003&&FXMAP[id])out.fx[id]=(out.fx[id]||0)+v};

    if(S.mode==='direct'){
      // your look, breathing: each active effect follows its band, your sliders stay the base
      FX.forEach(f=>{if(!P.on[f.id]||f.id==='skip')return;add(f.id,band(BAND[f.cat]||'energy')*.5*A*calm*boost*(.4+P.fx[f.id]))});
      if(hitK)Live.trigger('zoom',.35*A*boost);
      if(hitS&&(P.on.glitch||P.on.rgb))Live.trigger('glitch',.4*A*boost);
    }else if(S.mode==='follow'){
      add('liquid',band('bass')*.32*A*calm);add('disp',band('bass')*.12*A*calm);
      add('edge',band('high')*.22*A*calm);add('prism',band('high')*.16*A*calm);
      FX.forEach(f=>{if(P.on[f.id]&&f.id!=='skip')add(f.id,band(BAND[f.cat]||'energy')*.3*A*calm)});
      if(hitK){Live.trigger('zoom',.42*A*boost*calm);Live.trigger('fx',.35*A*boost,{id:'bloom'});if(sec==='drop')Live.trigger('shake',.5*A)}
      if(hitS)Live.trigger('glitch',.5*A*boost*calm);
      if(hitH&&calm>.5)Live.trigger('fx',.18*A,{id:'ca'});
    }else{ // chaos
      const th2=st.theme.length?st.theme:['glitch','rgb','liquid','bloom','parasite'];
      th2.forEach((id,i)=>add(id,(.25+.45*band(['bass','snare','snare','high','energy'][i%5]))*A*calm*boost));
      if(hitK){Live.trigger('zoom',.55*A*boost);Live.trigger('fx',.6*A,{id:th2[0]});if(Math.random()<.3)Live.trigger('shake',.6*A)}
      if(hitS){Live.trigger('fx',.7*A,{id:th2[1]||'glitch'});st.hueTarget+=(Math.random()<.5?-1:1)*Math.PI/3;
        if(Math.random()<.22)Live.trigger('freeze',.25)}
      if(hitH)Live.trigger('fx',.3*A,{id:th2[2]||'rgb'});
      st.hueEnv+=(st.hueTarget-st.hueEnv)*(1-Math.exp(-dt*6));out.hue+=st.hueEnv*(DATA.settings.safe?.3:1);
    }
    // sections reshape the whole picture
    if(sec==='breakdown'){add('ghost',.3*A);add('fb',.22*A);out.zoom+=Math.sin(ctx.now/2400)*.02}
    else if(sec==='silence'){out.freeze=Math.max(out.freeze,.85)}
    else if(sec==='build'){const b=st.build*A;add('rgb',b*.35);add('ca',b*.3);out.zoom+=b*.07;if(hitH)Live.trigger('shake',.2*b)}
    if(ctx.now-st.lastUi>100)ui(ctx);
  }

  // ---- panel
  const el={};
  function mount(host){
    const L=Live,sec=L.section('AUTOPILOT','OFF','apSec');el.note=sec.note;
    const top=L.h('div',{class:'btn-grid'});
    el.toggle=L.btn('● AUTOPILOT OFF',()=>setOn(!S.on),'full');el.toggle.id='apToggle';
    top.appendChild(el.toggle);sec.appendChild(top);
    el.mode=L.seg('Autopilot mode',[['follow','FOLLOW'],['direct','DIRECT'],['chaos','CHAOS']],S.mode,setMode);sec.appendChild(el.mode);
    el.desc=L.h('p',{class:'section-desc live-desc'});sec.appendChild(el.desc);
    // live readout: section + bands + hits
    el.read=L.h('div',{class:'ap-read'},[
      el.secTxt=L.h('b',{class:'ap-sec',text:'IDLE'}),
      L.h('span',{class:'ap-bars'},['B','M','H'].map(k=>L.h('i',{'data-k':k}))),
      L.h('span',{class:'ap-hits'},['KICK','SNARE','HAT'].map(k=>L.h('em',{text:k})))
    ]);
    sec.appendChild(el.read);
    const adv=L.h('details',{class:'adv'},[L.h('summary',{text:'Behaviour'})]);
    const body=L.h('div',{class:'adv-body'});
    body.appendChild(L.range('Sensitivity',0,2,.01,S.sens,v=>{S.sens=v;L.save()}));
    body.appendChild(L.range('Reaction speed',0,1,.01,S.react,v=>{S.react=v;L.save()}));
    body.appendChild(L.range('Smoothing',0,1,.01,S.smooth,v=>{S.smooth=v;L.save()}));
    body.appendChild(L.range('Intensity',0,1,.01,S.amount,v=>{S.amount=v;L.save()}));
    body.appendChild(L.range('Trigger threshold',0,1,.01,S.thresh,v=>{S.thresh=v;L.save()}));
    body.appendChild(L.select('Scene switching',[['phrase','On phrases and drops'],['drops','On drops only'],['off','Never']],S.scenes,v=>{S.scenes=v;L.save()}));
    body.appendChild(L.select('Phrase length',[[4,'4 bars'],[8,'8 bars'],[16,'16 bars']],S.phrase,v=>{S.phrase=+v;L.save()}));
    adv.appendChild(body);sec.appendChild(adv);
    host.appendChild(sec);
    Live.on('ap',sync);sync();
  }
  const DESC={
    follow:'Reacts on its own: kicks punch the camera, snares glitch, hats sparkle, bass bends the picture. Breakdowns calm it, builds raise the tension, drops hit hard.',
    direct:'Only moves the effects you switched on, on top of your own slider values. You stay in control; the music adds the motion.',
    chaos:'Picks a small set of effects every 4 bars and mutates them on every hit. Aggressive, but each phrase stays one look.'
  };
  function sync(){
    if(!el.toggle)return;
    el.toggle.textContent=S.on?'■ AUTOPILOT ON':'● AUTOPILOT OFF';el.toggle.classList.toggle('acid',S.on);el.toggle.setAttribute('aria-pressed',String(S.on));
    el.mode.pick(S.mode);el.desc.textContent=DESC[S.mode];
  }
  function ui(ctx){
    st.lastUi=ctx.now;if(!el.secTxt)return;
    const lbl=!S.on?'OFF':(st.src==='none'?'WAITING FOR MUSIC':st.section.toUpperCase());
    setTxt(el.secTxt,lbl);setTxt(el.note,S.on?S.mode.toUpperCase():'OFF');
    const bars=el.read.querySelectorAll('.ap-bars i'),hits=el.read.querySelectorAll('.ap-hits em');
    [st.bass,st.mid,st.high].forEach((v,i)=>bars[i].style.transform='scaleY('+clamp(v*1.6,.04,1).toFixed(2)+')');
    [st.hit.k,st.hit.s,st.hit.h].forEach((v,i)=>hits[i].classList.toggle('on',v>.5));
    el.read.dataset.sec=S.on?st.section:'off';
  }

  Live.addTicker(tick);
  Live.addAction('autopilot','Autopilot on/off',()=>setOn(!S.on));
  Live.addAction('ap:follow','Autopilot FOLLOW',()=>{setMode('follow');setOn(true)});
  Live.addAction('ap:direct','Autopilot DIRECT',()=>{setMode('direct');setOn(true)});
  Live.addAction('ap:chaos','Autopilot CHAOS',()=>{setMode('chaos');setOn(true)});
  Live.addParam('ap:amount','Autopilot intensity','Live',()=>S.amount,v=>{S.amount=v;Live.save()});
  Live.addParam('ap:sens','Autopilot sensitivity','Live',()=>S.sens/2,v=>{S.sens=v*2;Live.save()});
  Live.addKey('a',()=>{setOn(!S.on);toast(S.on?'<b>AUTOPILOT</b> — '+esc(S.mode.toUpperCase()):'<b>AUTOPILOT OFF</b>')});
  return {mount,setOn,setMode,get settings(){return S},get section(){return st.section},get theme(){return st.theme}};
})();
