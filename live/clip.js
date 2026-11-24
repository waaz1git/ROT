// Quick Clip — beat clips for social posts. Load a track, pick a recipe, a format (9:16 · 4:5 · 1:1 · 16:9,
// all 1080p at 60 fps) and a length in bars; preview it inside a frame of the final shape, then export a real
// MP4 with the music (the existing recorder: MediaRecorder + the music's own audio stream). Clips start on a
// downbeat and last a whole number of bars. Text and a waveform can be burned in through the engine's overlay
// layer, so they are in the exported file, not only on screen.
'use strict';
const Clip=(()=>{
  const S=Live.part('clip',{fmt:'1080x1920',bars:8,secs:10,start:'here',recipe:'__current',ap:'keep',wave:'bottom',text:'',textPos:'bottom',textSize:'m'});
  const FMTS=[['1080x1920','9:16'],['1080x1350','4:5'],['1080x1080','1:1'],['1920x1080','16:9']];
  if(!FMTS.some(f=>f[0]===S.fmt))S.fmt='1080x1920';
  S.bars=[4,8,16,32].includes(+S.bars)?+S.bars:8;S.secs=[6,10,15,30].includes(+S.secs)?+S.secs:10;
  if(!['here','top','range'].includes(S.start))S.start='here';if(!['keep','follow','direct','chaos','off'].includes(S.ap))S.ap='keep';
  if(!['bottom','center','off'].includes(S.wave))S.wave='bottom';if(!['top','center','bottom'].includes(S.textPos))S.textPos='bottom';
  if(!['s','m','l'].includes(S.textSize))S.textSize='m';S.text=String(S.text).slice(0,60);
  const OVL={tex:null}; // the object handed to the engine every frame (no per-frame allocation)
  let cvRect=null;const readRect=()=>{const c=$id('cv');cvRect=c?c.getBoundingClientRect():{left:0,top:0,width:innerWidth,height:innerHeight}};
  let mode=null; // null | 'preview' | 'export'
  let ov=null;   // {cv,ctx,tex,w,h,key,peaks,a,b,lastX}
  let restore=null,stopT=0;

  // ---- timing: whole bars from a downbeat
  function grid(){
    const s=Music.settings,bpm=+s.bpm||120,period=60/bpm,beats=Music.beats||[],bs=+s.barShift||0;
    return {bpm,period,bar:period*4,beats,bs};
  }
  function snapToBar(t){
    const g=grid();if(!g.beats.length)return Math.max(0,t);
    const t0=g.beats[0],i0=Math.round((t0-(+Music.settings.gridOffset||0))/g.period); // Music's index of beats[0]
    let i=Math.max(0,Math.round((t-t0)/g.period));
    while(((i+i0-g.bs)%4+4)%4!==0)i++;
    return t0+i*g.period;
  }
  function window_(){
    if(!Music.hasTrack())return null;
    const g=grid(),len=S.bars*g.bar,dur=Music.duration()||0;
    let a=S.start==='top'?snapToBar(0):S.start==='range'&&Music.settings.range?Music.settings.range.a:snapToBar(Math.max(0,Music.currentTime()-g.bar*.5));
    if(a+len>dur)a=Math.max(0,snapToBar(Math.max(0,dur-len-g.bar)));
    return {a,b:Math.min(dur,a+len),len:Math.min(len,dur-a)};
  }

  // ---- overlay layer (canvas → texture in the final pass)
  function fmtSize(){const [w,h]=S.fmt.split('x').map(Number);return {w,h}}
  function needOverlay(){return mode&&((S.wave!=='off'&&Music.hasTrack())||S.text.trim())}
  function overlayTick(ctx){
    if(!needOverlay()){if(ctx.out.overlay)ctx.out.overlay=null;if(ov&&!mode)dropOverlay();return}
    const exp=Engine.isExporting(),f=fmtSize();
    let cw,ch;
    if(exp){cw=f.w;ch=f.h}
    else{if(!cvRect)readRect();const r=cvRect,k=Math.min(Math.min(2,devicePixelRatio||1),1920/Math.max(1,r.width,r.height));cw=Math.max(64,Math.round(r.width*k));ch=Math.max(64,Math.round(r.height*k))}
    if(!ov||ov.w!==cw||ov.h!==ch){
      if(ov&&ov.tex)ov.tex.dispose();
      const cv=document.createElement('canvas');cv.width=cw;cv.height=ch;
      const tex=new THREE.CanvasTexture(cv);tex.minFilter=THREE.LinearFilter;tex.magFilter=THREE.LinearFilter;tex.generateMipmaps=false;
      ov={cv,ctx:cv.getContext('2d'),tex,w:cw,h:ch,key:'',peaks:ov&&ov.peaks,win:ov&&ov.win};
    }
    // in the preview, draw inside the frame of the final shape; in the export, the frame is the whole picture
    let bx=0,by=0,bw=cw,bh=ch;
    if(!exp){const ar=f.w/f.h;if(cw/ch>ar){bw=Math.round(ch*ar);bx=Math.round((cw-bw)/2)}else{bh=Math.round(cw/ar);by=Math.round((ch-bh)/2)}}
    const win=ov.win||window_();ov.win=win;
    const prog=win&&win.len>0?clamp((Music.currentTime()-win.a)/win.len,0,1):0;
    const px=Math.round(prog*240);
    const key=[cw,ch,bx,by,S.text,S.textPos,S.textSize,S.wave,px].join('|');
    if(key!==ov.key){ov.key=key;draw(bx,by,bw,bh,prog,win);ov.tex.needsUpdate=true}
    OVL.tex=ov.tex;ctx.out.overlay=OVL;
  }
  function peaks(win){
    const buf=Music.buffer;if(!buf||!win)return null;
    const id=win.a.toFixed(2)+':'+win.b.toFixed(2);if(ov.peaks&&ov.peaks.id===id&&ov.peaks.buf===buf)return ov.peaks.v;
    const d=buf.getChannelData(0),sr=buf.sampleRate,N=240,v=new Float32Array(N);
    const i0=Math.floor(win.a*sr),i1=Math.min(d.length,Math.floor(win.b*sr)),step=Math.max(1,Math.floor((i1-i0)/N));
    let mx=1e-6;
    for(let k=0;k<N;k++){let m=0;const s=i0+k*step;for(let j=0;j<step;j+=8){const x=Math.abs(d[s+j]||0);if(x>m)m=x}v[k]=m;if(m>mx)mx=m}
    for(let k=0;k<N;k++)v[k]/=mx;
    ov.peaks={id,v,buf};return v;
  }
  function draw(bx,by,bw,bh,prog,win){
    const c=ov.ctx;c.clearRect(0,0,ov.w,ov.h);
    const css=getComputedStyle(document.documentElement);
    const fd=(css.getPropertyValue('--fd')||'sans-serif').trim(),fm=(css.getPropertyValue('--fm')||'monospace').trim();
    if(S.wave!=='off'&&Music.hasTrack()){
      const v=peaks(win);
      if(v){
        const N=v.length,ww=bw*.84,x0=bx+(bw-ww)/2,hh=bh*(S.wave==='center'?.16:.07),cy=S.wave==='center'?by+bh/2:by+bh*.9;
        const bwid=ww/N;
        for(let k=0;k<N;k++){
          const a=Math.max(.04,v[k])*hh,played=k/N<=prog;
          c.fillStyle=played?'rgba(216,255,79,.95)':'rgba(255,255,255,.55)';
          c.fillRect(x0+k*bwid,cy-a/2,Math.max(1,bwid*.62),a);
        }
      }
    }
    const t=S.text.trim();
    if(t){
      const size=bh*({s:.038,m:.06,l:.09}[S.textSize]||.06);
      c.font='800 '+Math.round(size)+'px '+fd;c.textAlign='center';c.textBaseline='middle';
      const lines=wrap(c,t.toUpperCase(),bw*.86).slice(0,4),lh=size*1.08;
      const yc=S.textPos==='top'?by+bh*.14:S.textPos==='center'?by+bh*.5:by+bh*(S.wave==='bottom'?.76:.86);
      lines.forEach((ln,i)=>{const y=yc+(i-(lines.length-1)/2)*lh;
        c.lineWidth=Math.max(2,size*.12);c.strokeStyle='rgba(0,0,0,.55)';c.strokeText(ln,bx+bw/2,y);
        c.fillStyle='#fff';c.fillText(ln,bx+bw/2,y)});
      c.font='500 '+Math.round(size*.28)+'px '+fm;c.fillStyle='rgba(255,255,255,.6)';
    }
  }
  function wrap(c,t,max){const w=t.split(/\s+/),o=[];let line='';w.forEach(x=>{const n=line?line+' '+x:x;if(c.measureText(n).width>max&&line){o.push(line);line=x}else line=n});if(line)o.push(line);return o}

  // ---- preview / export
  function guide(on){
    let g=$id('qcGuide');
    if(!on){if(g)g.classList.remove('on');return}
    if(!g){g=document.createElement('div');g.id='qcGuide';g.setAttribute('aria-hidden','true');document.body.appendChild(g)}
    const r=$id('cv').getBoundingClientRect(),f=fmtSize(),ar=f.w/f.h;
    let w=r.width,h=r.height;if(w/h>ar)w=h*ar;else h=w/ar;
    Object.assign(g.style,{left:(r.left+(r.width-w)/2)+'px',top:(r.top+(r.height-h)/2)+'px',width:w+'px',height:h+'px'});
    g.dataset.fmt=FMTS.find(x=>x[0]===S.fmt)[1];g.classList.add('on');
  }
  function setup(){
    restore={look:snapshotLook(),ap:typeof Autopilot!=='undefined'?{on:Autopilot.settings.on,mode:Autopilot.settings.mode}:null};
    if(S.recipe&&S.recipe!=='__current'){const b=BUILTIN_PRESETS.find(p=>p.name===S.recipe)||(DATA.userPresets||{})[S.recipe];if(b){applyPreset(b,false);if(typeof cvFx==='function')cvFx('rx-in')}}
    if(S.ap!=='keep'&&typeof Autopilot!=='undefined'){if(S.ap==='off')Autopilot.setOn(false);else{Autopilot.setMode(S.ap);Autopilot.setOn(true)}}
    if(ov)ov.win=null;
  }
  function dropOverlay(){if(ov&&ov.tex)ov.tex.dispose();ov=null;OVL.tex=null}
  function teardown(keepLook){
    clearTimeout(stopT);guide(false);
    if(restore&&restore.ap&&S.ap!=='keep'&&typeof Autopilot!=='undefined'){Autopilot.setMode(restore.ap.mode);Autopilot.setOn(restore.ap.on)}
    if(restore&&!keepLook&&S.recipe!=='__current')applyPreset(restore.look,false);
    restore=null;mode=null;if(ov)ov.win=null;Live.out.overlay=null;dropOverlay();sync();
  }
  async function preview(){
    if(mode)return stop();
    close();mode='preview';setup();guide(true);sync();
    const win=window_();
    if(win){await Music.seekTo(win.a);if(mode!=='preview')return;Music.play();stopT=setTimeout(()=>{if(mode==='preview'){Music.pause();stop()}},win.len/(Music.settings.rate||1)*1000+200)}
    else stopT=setTimeout(stop,S.secs*1000);
    toast('<b>PREVIEW</b> — '+FMTS.find(x=>x[0]===S.fmt)[1]+' · press Esc or the Clip button to stop',3000);
  }
  function stop(){if(mode==='preview'){Music.pause();teardown(false)}}
  async function exportClip(){
    if(REC.active||REC.starting||REC.stopping||REC.finalizing)return toast(tr('story.busy'));
    if(mode==='preview')stop();
    close();
    const ms=Music.settings,prev={res:DATA.settings.exportRes,dur:DATA.settings.duration,range:ms.range?deep(ms.range):null,useRange:ms.useRange,audio:DATA.settings.includeAudio};
    const win=window_();
    mode='export';setup();sync();
    DATA.settings.exportRes=S.fmt;DATA.settings.includeAudio=true;
    if(win){ms.range={a:win.a,b:win.b};ms.useRange=true;DATA.settings.duration=clamp(Math.ceil(win.len/(ms.rate||1))+1,3,120)}
    else DATA.settings.duration=clamp(S.secs,3,120);
    syncExportUI();pendingRestore=()=>{DATA.settings.exportRes=prev.res;DATA.settings.duration=prev.dur;DATA.settings.includeAudio=prev.audio;saveSettings()};
    toast('<b>QUICK CLIP</b> — recording '+(win?S.bars+' bars':S.secs+' s')+' · '+FMTS.find(x=>x[0]===S.fmt)[1],2600);
    await startRecording();
    const iv=setInterval(()=>{
      if(REC.active||REC.starting||REC.stopping||REC.finalizing)return;
      clearInterval(iv);
      DATA.settings.exportRes=prev.res;DATA.settings.duration=prev.dur;DATA.settings.includeAudio=prev.audio;ms.range=prev.range;ms.useRange=prev.useRange;
      pendingRestore=null;saveSettings();syncExportUI();try{Music.syncUI()}catch(e){}
      teardown(true);
    },400);
  }

  // ---- dialog
  let dlg=null;
  function build(){
    const L=Live;
    dlg=L.h('div',{id:'qclip',class:'live-dlg',role:'dialog','aria-modal':'true','aria-labelledby':'qcTitle','aria-hidden':'true'});
    const card=L.h('div',{class:'live-card'});
    card.appendChild(L.h('div',{class:'ks-head'},[L.h('h2',{id:'qcTitle',text:'Quick clip'}),L.h('button',{type:'button',class:'ks-close',text:'CLOSE ✕',onclick:close})]));
    card.appendChild(L.h('p',{class:'section-desc',text:'A beat clip for your socials: the music, a look, the right shape. Exported as a real MP4 with sound, 1080p at 60 fps.'}));
    const body=L.h('div',{class:'qc-body'});
    el.track=L.h('div',{class:'qc-track'});body.appendChild(el.track);
    body.appendChild(L.h('div',{class:'btn-grid'},[L.btn('LOAD TRACK',()=>{const f=$id('musicFile');if(f)f.click()}),L.btn('DEMO BEAT',async()=>{try{await playDemoBeat()}catch(e){}sync()})]));
    el.fmt=L.seg('Format',FMTS.map(([v,t])=>[v,t]),S.fmt,v=>{S.fmt=v;Live.save();if(mode==='preview')guide(true)});
    body.appendChild(L.h('div',{class:'ctrl-top live-lbl'},[L.h('span',{class:'ctrl-label',text:'Format · 1080p · 60 fps'})]));body.appendChild(el.fmt);
    el.bars=L.select('Length',[[4,'4 bars'],[8,'8 bars'],[16,'16 bars'],[32,'32 bars']],S.bars,v=>{S.bars=+v;Live.save();sync()});body.appendChild(el.bars);
    el.secs=L.select('Length without a track',[[6,'6 s'],[10,'10 s'],[15,'15 s'],[30,'30 s']],S.secs,v=>{S.secs=+v;Live.save()});body.appendChild(el.secs);
    body.appendChild(L.select('Start',[['here','At the current position (next downbeat)'],['top','From the top of the track'],['range','From the export range']],S.start,v=>{S.start=v;Live.save();sync()}));
    el.recipe=L.select('Recipe',[],S.recipe,v=>{S.recipe=v;Live.save()});body.appendChild(el.recipe);
    body.appendChild(L.select('Autopilot during the clip',[['keep','Leave as it is'],['follow','FOLLOW'],['direct','DIRECT'],['chaos','CHAOS'],['off','Off']],S.ap,v=>{S.ap=v;Live.save()}));
    body.appendChild(L.select('Waveform',[['bottom','At the bottom'],['center','In the middle'],['off','None']],S.wave,v=>{S.wave=v;Live.save()}));
    const tIn=L.h('input',{type:'text',class:'live-input',maxlength:60,placeholder:'Text on the clip (artist, title, release date…)','aria-label':'Text overlay',value:S.text});
    tIn.addEventListener('input',()=>{S.text=tIn.value;Live.save()});
    body.appendChild(L.h('div',{class:'ctrl'},[L.h('div',{class:'ctrl-top'},[L.h('span',{class:'ctrl-label',text:'Text'})]),tIn]));
    body.appendChild(L.h('div',{class:'qc-two'},[
      L.seg('Text position',[['top','TOP'],['center','MIDDLE'],['bottom','BOTTOM']],S.textPos,v=>{S.textPos=v;Live.save()}),
      L.seg('Text size',[['s','S'],['m','M'],['l','L']],S.textSize,v=>{S.textSize=v;Live.save()})]));
    card.appendChild(body);
    el.info=L.h('p',{class:'section-desc qc-info'});card.appendChild(el.info);
    card.appendChild(L.h('div',{class:'btn-grid'},[L.btn('▶ PREVIEW',preview),L.btn('● EXPORT CLIP',exportClip,'hot')]));
    dlg.appendChild(card);document.body.appendChild(dlg);
    dlg.addEventListener('click',e=>{if(e.target===dlg)close()});
  }
  const el={};
  function fillRecipes(){
    const s=el.recipe.sel,keep=S.recipe;s.innerHTML='';
    [['__current','Current look']].concat(BUILTIN_PRESETS.map(p=>[p.name,p.name]),Object.keys(DATA.userPresets||{}).map(n=>[n,'★ '+n]))
      .forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;s.appendChild(o)});
    s.value=keep;if(s.value!==keep){S.recipe='__current';s.value='__current'}
  }
  function open(){
    if(!dlg)build();
    if(typeof closeGen==='function')closeGen();if(document.body.dataset.sheet)closeSheet();if(drawerOpen)closeDrawer(drawerOpen);
    fillRecipes();sync();dlg.classList.add('on');dlg.setAttribute('aria-hidden','false');
    Motion.stagger(dlg.querySelector('.qc-body'));setTimeout(()=>glitchIn($id('qcTitle')),60);
  }
  function close(){if(!dlg)return;dlg.classList.remove('on');dlg.setAttribute('aria-hidden','true')}
  function sync(){
    const btn=$id('btnQuickClip');if(btn)btn.textContent=mode==='preview'?'■ STOP PREVIEW':'◧ QUICK CLIP';
    if(!dlg)return;
    const has=Music.hasTrack(),g=has?grid():null;
    el.track.innerHTML='';
    el.track.appendChild(Live.h('b',{text:has?(($id('musicName')||{}).textContent||'TRACK'):'NO TRACK'}));
    el.track.appendChild(Live.h('span',{text:has?Math.round(g.bpm*10)/10+' BPM':'Load a track or the demo beat; without one the clip is silent.'}));
    el.bars.hidden=!has;el.secs.hidden=has;
    const win=window_();
    el.info.textContent=win?S.bars+' bars = '+win.len.toFixed(1)+' s, from '+fmtTime(win.a)+' (on a downbeat).':'';
  }

  let pendingRestore=null;
  addEventListener('pagehide',()=>{if(pendingRestore)pendingRestore()});
  Live.addTicker(overlayTick);
  Live.addAction('clip','Quick clip',()=>open());
  window.addEventListener('keydown',e=>{
    if(dlg&&dlg.classList.contains('on')&&e.key!=='Escape'){if(e.key.length===1&&!e.metaKey&&!e.ctrlKey)e.stopPropagation();return}
    if(e.key!=='Escape')return;
    if(dlg&&dlg.classList.contains('on')){e.preventDefault();e.stopPropagation();close()}
    else if(mode==='preview'){e.preventDefault();stop()}
  },true);
  addEventListener('resize',()=>{cvRect=null;if(mode==='preview')guide(true)});
  return {open,close,preview,stop,exportClip,get mode(){return mode},get settings(){return S},get overlayCanvas(){return ov&&ov.cv},window:window_,snapToBar};
})();
