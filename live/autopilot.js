// Visual Autopilot — reads the track as music (sections, instruments, phrases) and plays the visuals.
//   FOLLOW  reacts on its own: each instrument drives its own family of effects, sections reshape the look
//   DIRECT  only modulates what you switched on, on top of your own slider values
//   CHAOS   picks a small "theme" of effects per phrase and mutates it on the hits: wild but coherent
// Input: the Music module's beat grid and hits (kick/snare/hat/drop) when a track plays; a microphone or
// video sound falls back to energy + onset detection without a grid.
'use strict';
const Autopilot=(()=>{
  const S=Live.part('ap',{on:false,mode:'follow',sens:1,react:.6,smooth:.5,amount:.7,thresh:.35,scenes:'phrase',phrase:8,density:.5,beat:.7,drop:.8,chaos:.5,locks:[],cats:{kick:true,mid:true,high:true,drop:true,section:true}});
  S.locks=S.locks.filter(id=>typeof id==='string'&&FXMAP[id]);
  ['kick','mid','high','drop','section'].forEach(k=>{if(typeof S.cats[k]!=='boolean')S.cats[k]=true});
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
    if(!S.cats.drop)return;
    const A=S.amount*(.3+clamp(S.drop,0,1)*.9);
    if(S.mode!=='follow'){Live.trigger('flash',.75*A);Live.trigger('shake',.9*A)}
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

    // FOLLOW: subtle, musical · DIRECT: strong hits on beats and drops · CHAOS: a mutating theme per phrase
    const D=clamp(S.density,0,1),BR=clamp(S.beat,0,1)*1.4,CH=clamp(S.chaos,0,1),C=S.cats,lock=new Set(S.locks);
    const addL=(id,v)=>{if(!lock.has(id))add(id,v)};
    const trig=(k,a,o)=>{if(o&&o.id&&lock.has(o.id))return;if(k==='glitch'&&lock.has('glitch'))return;Live.trigger(k,a,o)};
    const mk=S.mode==='follow'?.55:S.mode==='direct'?1.25:1,strong=S.mode==='direct';
    // your active effects breathe with their part of the music in every mode
    FX.forEach(f=>{if(P.on[f.id]&&f.id!=='skip')addL(f.id,band(BAND[f.cat]||'energy')*(.18+.25*D)*A*calm*mk)});
    if(S.mode!=='chaos'){
      // density brings in companions: the bass bends the picture, the highs light its edges
      if(C.kick){addL('liquid',band('bass')*.32*D*A*calm*mk);addL('disp',band('bass')*.14*D*A*calm*mk)}
      if(C.high){addL('edge',band('high')*.22*D*A*calm*mk);addL('prism',band('high')*.16*D*A*calm*mk)}
      if(C.kick&&hitK){trig('zoom',(strong?.55:.22)*BR*A*boost*calm);trig('fx',(strong?.5:.18)*BR*A*boost,{id:'bloom'});if(strong&&sec==='drop')trig('shake',.6*A*S.drop)}
      if(C.mid&&hitS)trig('glitch',(strong?.65:.22)*BR*A*boost*calm);
      if(C.high&&hitH&&calm>.5)trig('fx',(strong?.3:.1)*BR*A,{id:'ca'});
    }else{ // chaos: the level sets how many effects join the theme and how hard they hit
      const th2=(st.theme.length?st.theme:['glitch','rgb','liquid','bloom','parasite']).slice(0,2+Math.round(CH*3)),g=.6+CH*.8;
      th2.forEach((id,i)=>addL(id,(.2+.45*band(['bass','snare','snare','high','energy'][i%5]))*A*calm*boost*g*(.5+D*.5)));
      if(C.kick&&hitK){trig('zoom',.55*A*boost*BR);trig('fx',.6*A*g,{id:th2[0]});if(Math.random()<.15+CH*.3)trig('shake',.6*A)}
      if(C.mid&&hitS){trig('fx',.7*A*g,{id:th2[1]||'glitch'});st.hueTarget+=(Math.random()<.5?-1:1)*Math.PI/3*CH;
        if(Math.random()<.1+CH*.2)trig('freeze',.25)}
      if(C.high&&hitH)trig('fx',.3*A*g,{id:th2[2]||'rgb'});
      st.hueEnv+=(st.hueTarget-st.hueEnv)*(1-Math.exp(-dt*6));out.hue+=st.hueEnv*(DATA.settings.safe?.3:1);
    }
    // sections reshape the whole picture
    if(C.section){
      if(sec==='breakdown'){addL('ghost',.3*A);addL('fb',.22*A);out.zoom+=Math.sin(ctx.now/2400)*.02}
      else if(sec==='silence'){out.freeze=Math.max(out.freeze,.85)}
      else if(sec==='build'){const bb=st.build*A;addL('rgb',bb*.35);addL('ca',bb*.3);out.zoom+=bb*.07;if(hitH)trig('shake',.2*bb)}
    }
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
    body.appendChild(L.range('Effect density',0,1,.01,S.density,v=>{S.density=v;L.save()}));
    body.appendChild(L.range('Beat response',0,1,.01,S.beat,v=>{S.beat=v;L.save()}));
    body.appendChild(L.range('Drop intensity',0,1,.01,S.drop,v=>{S.drop=v;L.save()}));
    body.appendChild(L.range('Chaos level',0,1,.01,S.chaos,v=>{S.chaos=v;L.save()}));
    const cats=L.h('div',{class:'live-seg ap-cats','aria-label':'Reacts to'});
    [['kick','KICK / BASS'],['mid','SNARE / MIDS'],['high','HATS / HIGHS'],['drop','DROPS'],['section','BREAKDOWNS']].forEach(([k,t])=>{
      const b=L.h('button',{type:'button',class:'chip'+(S.cats[k]?' on':''),text:t,'aria-pressed':String(S.cats[k])});
      b.addEventListener('click',()=>{S.cats[k]=!S.cats[k];b.classList.toggle('on',S.cats[k]);b.setAttribute('aria-pressed',String(S.cats[k]));L.save()});cats.appendChild(b)});
    body.appendChild(L.h('div',{class:'ctrl-top live-lbl'},[L.h('span',{class:'ctrl-label',text:'Reacts to'})]));body.appendChild(cats);
    const lk=L.h('details',{class:'adv'},[L.h('summary',{text:'Effects the autopilot never touches'})]),lb=L.h('div',{class:'adv-body mut-single'});
    FX.filter(f=>f.id!=='skip').forEach(f=>{const cb=L.h('input',{type:'checkbox'});cb.checked=S.locks.includes(f.id);
      cb.addEventListener('change',()=>{S.locks=S.locks.filter(x=>x!==f.id);if(cb.checked)S.locks.push(f.id);L.save()});lb.appendChild(L.h('label',{class:'mut-lock'},[cb,L.h('span',{text:f.name})]))});
    lk.appendChild(lb);body.appendChild(lk);
    body.appendChild(L.select('Scene switching',[['phrase','On phrases and drops'],['drops','On drops only'],['off','Never']],S.scenes,v=>{S.scenes=v;L.save()}));
    body.appendChild(L.select('Phrase length',[[4,'4 bars'],[8,'8 bars'],[16,'16 bars']],S.phrase,v=>{S.phrase=+v;L.save()}));
    adv.appendChild(body);sec.appendChild(adv);
    host.appendChild(sec);
    Live.on('ap',sync);sync();
  }
  const DESC={
    follow:'Subtle and musical: your look breathes with the bass and the highs, kicks nudge the camera. Breakdowns calm it, builds raise the tension.',
    direct:'Strong: kicks punch the camera, snares glitch, drops hit with flash and shake (within the safety limits).',
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
