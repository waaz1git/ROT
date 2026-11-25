// Export 2.2 — the Output panel says what this browser can really do, and adds quality, file name, cancel
// and a look file (the recipe of what is on screen, with name, creator, category and tags) to share or keep.
// The public gallery stays closed on the server (uploads could not be moderated), so sharing is by link or file.
'use strict';
const Export2=(()=>{
  const el={};
  function support(){
    const rec=!!window.MediaRecorder,mp4=rec&&!!chooseMp4Mime();
    return {rec,mp4,text:!rec?'This browser cannot record video here: FRAME PNG still works.':!mp4?'This browser records no MP4 (H.264): use Chrome or Edge for video; FRAME PNG works.':'MP4 (H.264) with sound, 60 fps: supported in this browser.'};
  }
  function build(){
    const res=$id('exportRes');if(!res)return;
    const host=res.closest('.ctrl');
    const sp=support();
    el.sup=Live.h('p',{class:'section-desc exp-sup'+(sp.mp4?' ok':' warn'),text:sp.text});host.after(el.sup);
    const q=Live.select('Quality',[['std','Standard (smaller file)'],['high','High'],['max','Maximum (big file)']],DATA.settings.quality||'high',v=>{DATA.settings.quality=v;saveSettings()});
    el.sup.after(q);
    const fn=Live.h('input',{type:'text',class:'live-input',maxlength:60,placeholder:'rot-export (automatic)','aria-label':'File name',value:DATA.settings.fileName||''});
    fn.addEventListener('input',()=>{DATA.settings.fileName=fn.value;saveSettings()});
    const fr=Live.h('div',{class:'ctrl'},[Live.h('div',{class:'ctrl-top'},[Live.h('span',{class:'ctrl-label',text:'File name'})]),fn]);q.after(fr);
    // cancel a take without saving it
    const grid=$('[data-pane="output"] .btn-grid');
    if(grid){el.cancel=Live.btn('✕ CANCEL TAKE',()=>{if(!REC.active)return;REC.cancel=true;stopRecording('cancel')},'full');el.cancel.hidden=true;grid.appendChild(el.cancel)}
    setInterval(()=>{if(el.cancel)el.cancel.hidden=!REC.active},400);
    // look file
    if(grid)grid.appendChild(Live.btn('⬇ LOOK FILE',lookFile,'full'));
  }
  function lookFile(){
    const name=(prompt(LANG==='it'?'Nome del look':'Look name',DATA.activePreset||'My look')||'').trim().slice(0,40);if(!name)return;
    const by=(prompt(LANG==='it'?'Autore (facoltativo)':'Creator (optional)','')||'').trim().slice(0,40);
    const look=snapshotLook(),o={rot:'look',v:1,name,creator:by,category:Recipes.category(look),tags:FX.filter(f=>look.on[f.id]).map(f=>f.id),link:shareURL?(()=>{try{return shareURL()}catch(e){return ''}})():'',look};
    downloadBlob(new Blob([JSON.stringify(o,null,1)],{type:'application/json'}),name.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.rot.json');
    toast('<b>LOOK FILE SAVED</b> — import it from Recipes → IMPORT');
  }
  build();
  return {support,lookFile};
})();
