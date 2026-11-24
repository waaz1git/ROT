// ROT Live — panel wiring: the LIVE tab (Autopilot, Scenes, Sequencer, Mutation, MIDI), the Quick Play and
// Quick Clip entry points, the keyboard sheet and the Italian strings. Loaded last; starts the Live bus.
'use strict';
(function(){
  // Italian for every new label (the page's translation layer picks them up as the panel is built)
  const IT={
    'autopilot':'autopilota','● autopilot off':'● autopilota spento','■ autopilot on':'■ autopilota acceso','off':'spento','behaviour':'comportamento',
    'sensitivity':'sensibilità','reaction speed':'velocità di reazione','smoothing':'morbidezza','intensity':'intensità','trigger threshold':'soglia di attivazione',
    'scene switching':'cambio scena','on phrases and drops':'a ogni frase e drop','on drops only':'solo sui drop','never':'mai','phrase length':'lunghezza frase',
    '4 bars':'4 battute','8 bars':'8 battute','16 bars':'16 battute','32 bars':'32 battute','idle':'in attesa','waiting for music':'aspetto la musica',
    'groove':'groove','breakdown':'breakdown','build':'salita','drop':'drop','silence':'silenzio',
    'reacts on its own: kicks punch the camera, snares glitch, hats sparkle, bass bends the picture. breakdowns calm it, builds raise the tension, drops hit hard.':'Reagisce da solo: la cassa dà colpi di camera, il rullante glitcha, i charleston brillano, il basso piega l’immagine. I breakdown la calmano, le salite alzano la tensione, i drop colpiscono forte.',
    'only moves the effects you switched on, on top of your own slider values. you stay in control; the music adds the motion.':'Muove solo gli effetti che hai acceso, sopra i valori dei tuoi slider. Il controllo resta tuo, la musica aggiunge il movimento.',
    'picks a small set of effects every 4 bars and mutates them on every hit. aggressive, but each phrase stays one look.':'Sceglie un piccolo gruppo di effetti ogni 4 battute e lo muta a ogni colpo. Aggressivo, ma ogni frase resta un look unico.',
    'scenes':'scene','● store':'● salva','rename':'rinomina','duplicate':'duplica','delete':'elimina','◀ move':'◀ sposta','move ▶':'sposta ▶','+ new scene':'+ nuova scena',
    'transition':'transizione','cut':'taglio','smooth':'morbida','transition time':'durata transizione','store the music mapping too':'salva anche la mappatura musicale',
    'sequencer':'sequencer','▶ run sequencer':'▶ avvia sequencer','■ stop sequencer':'■ ferma sequencer','steps':'passi','resolution':'risoluzione','page':'pagina',
    'generate':'genera','four on floor':'cassa dritta','breakbeat':'breakbeat','trap':'trap','euclid':'euclideo','random':'casuale','clear':'svuota',
    'fx lane effect':'effetto della riga fx','lanes, tempo & patterns':'righe, tempo e pattern','tempo without a track':'tempo senza brano',
    'saved patterns':'pattern salvati','save':'salva','load':'carica','pattern name':'nome del pattern',
    'mutation':'mutazione','⟳ mutate':'⟳ muta','save as recipe':'salva come ricetta','↶ undo':'↶ annulla','↷ redo':'↷ ripeti',
    'mutation intensity':'intensità mutazione','mutation probability':'probabilità mutazione','mutate':'muta','everything (effects can change)':'tutto (gli effetti possono cambiare)',
    'only the active effects':'solo gli effetti attivi','locked':'bloccati','lock single parameters':'blocca singoli parametri','continuous mutation':'mutazione continua',
    'every':'ogni','1 bar (2 s)':'1 battuta (2 s)','2 bars (4 s)':'2 battute (4 s)','4 bars (8 s)':'4 battute (8 s)','8 bars (16 s)':'8 battute (16 s)',
    'replay seed':'ripeti seed','visual dna & hybrids':'dna visivo e ibridi','copy dna':'copia dna','apply dna':'applica dna','paste dna':'incolla dna',
    'parent a':'genitore a','parent b':'genitore b','breed hybrid':'crea ibrido','current look':'look attuale','colours':'colori','motion':'movimento','shape':'forma',
    'signal':'segnale','light':'luce','lab':'lab','active set':'gruppo attivo','colour grade':'gradazione colore',
    'enable midi':'attiva midi','midi on':'midi attivo','midi unavailable':'midi non disponibile','retry midi':'riprova midi','waiting for permission…':'attendo il permesso…',
    'map a control to':'collega un controllo a','learn':'impara','cancel':'annulla','profile':'profilo','new':'nuovo','export':'esporta','import':'importa','delete profile':'elimina profilo',
    'no mappings yet: pick a target, press learn, then move a knob or hit a pad.':'Nessuna mappatura: scegli una destinazione, premi IMPARA e muovi una manopola o colpisci un pad.',
    'connect a controller, then enable midi.':'Collega un controller, poi attiva il MIDI.','no midi device connected.':'Nessun dispositivo MIDI collegato.',
    'web midi is not available in this browser. chrome, edge and opera support it.':'Il Web MIDI non è disponibile in questo browser. Funziona con Chrome, Edge e Opera.',
    'quick clip':'clip rapida','◧ quick clip':'◧ clip rapida','■ stop preview':'■ ferma anteprima','close ✕':'chiudi ✕','load track':'carica brano','demo beat':'beat demo',
    'format · 1080p · 60 fps':'formato · 1080p · 60 fps','length':'durata','length without a track':'durata senza brano','start':'inizio',
    'at the current position (next downbeat)':'dalla posizione attuale (prossimo battere)','from the top of the track':'dall’inizio del brano','from the export range':'dall’intervallo di esportazione',
    'recipe':'ricetta','autopilot during the clip':'autopilota durante la clip','leave as it is':'lascia com’è','waveform':'forma d’onda','at the bottom':'in basso','in the middle':'al centro','none':'nessuna',
    'text':'testo','text position':'posizione testo','text size':'dimensione testo','top':'in alto','middle':'centro','bottom':'in basso','▶ preview':'▶ anteprima','● export clip':'● esporta clip',
    'no track':'nessun brano','load a track or the demo beat; without one the clip is silent.':'Carica un brano o il beat demo: senza, la clip è muta.',
    'text on the clip (artist, title, release date…)':'testo sulla clip (artista, titolo, data di uscita…)',
    'a beat clip for your socials: the music, a look, the right shape. exported as a real mp4 with sound, 1080p at 60 fps.':'Una clip a tempo per i social: la musica, un look, il formato giusto. Esportata come vero MP4 con l’audio, 1080p a 60 fps.',
    'quick play':'avvio rapido','⚡ quick play':'⚡ avvio rapido','picture':'immagine','beat':'beat','style':'stile','play':'via',
    'upload image / video':'carica immagine / video','✦ text → image':'✦ testo → immagine','use the sample':'usa l’esempio','next →':'avanti →','skip →':'salta →','← back':'← indietro',
    'upload a beat':'carica un beat','no music →':'senza musica →','go ▶':'via ▶','randomize':'casuale','preview':'anteprima','● record':'● registra','frame png':'frame png','← styles':'← stili',
    'start with an image or a video, or let the ai draw one.':'Parti da un’immagine o da un video, oppure fallo disegnare all’AI.',
    'you already have a picture. keep it or pick another.':'Hai già un’immagine. Tienila o scegline un’altra.',
    'add a beat: the autopilot reads kicks, snares, hats, builds and drops.':'Aggiungi un beat: l’autopilota legge casse, rullanti, charleston, salite e drop.',
    'live':'live','flesh warp':'carne viva','reality melt':'realtà che si scioglie','fracture':'frattura','parasite':'parassita','void':'vuoto','chromatic collapse':'collasso cromatico',
    'memory leak':'memory leak','bad transmission':'trasmissione disturbata','blackout':'blackout'
  };
  Object.assign(UI_IT,IT);
  UI_IT_RX.push(
    [/^Scene ([A-L0-9]+)$/,'Scena $1'],[/^(\d+) MAPS$/,'$1 MAPPATURE'],[/^(\d+) STEPS$/,'$1 PASSI'],
    [/^(\d+) bars = ([\d.]+) s, from (.+) \(on a downbeat\)\.$/,'$1 battute = $2 s, da $3 (su un battere).'],
    [/^Track loaded: (\d+) BPM\. The visuals will follow it\.$/,'Brano caricato: $1 BPM. Le immagini lo seguiranno.'],
    [/^(.+) is playing\. Mutate it until it feels right, then record\. Every control is still in the panels\.$/,'$1 è in riproduzione. Mutalo finché ti convince, poi registra. Tutti i controlli restano nei pannelli.']
  );
  if(I18N.it){
    Object.assign(I18N.it,{'kh.Live':'Live','kh.A':'A','kh.Autopilot on / off':'Autopilota sì / no','kh.X':'X','kh.Mutate (new generation)':'Muta (nuova generazione)',
      'kh.Z / Shift Z':'Z / Shift Z','kh.Mutation undo / redo':'Annulla / ripeti mutazione','kh.1 – 9':'1 – 9','kh.Fire a scene (Shift = store)':'Scena (Shift = salva)',
      'kh.Q':'Q','kh.Sequencer on / off':'Sequencer sì / no','kh.F (hold)':'F (tieni)','kh.Freeze the picture':'Congela l’immagine','kh.K':'K','kh.Quick clip':'Clip rapida','kh.Quick play':'Avvio rapido','kh.J':'J'});
  }
  KEY_HELP.splice(KEY_HELP.findIndex(r=>r[0]==='Anywhere'),0,['Live'],['A','Autopilot on / off'],['X','Mutate (new generation)'],['Z / Shift Z','Mutation undo / redo'],
    ['1 – 9','Fire a scene (Shift = store)'],['Q','Sequencer on / off'],['F (hold)','Freeze the picture'],['K','Quick clip'],['J','Quick play']);

  // the LIVE pane
  const pane=$id('paneLive');
  if(pane){
    [Autopilot,Scenes,Seq,Mutation,Midi].forEach(m=>{try{m.mount(pane)}catch(e){console.warn('[live] mount',e)}});
    const first=pane.querySelector('.live-sec');if(first){first.style.marginTop='0';first.style.paddingTop='2px'}
  }
  // entry points
  const out=$('[data-pane="output"] .btn-grid');
  if(out){const b=Live.h('button',{type:'button',class:'btn full acid',id:'btnQuickClip',text:'◧ QUICK CLIP',onclick:()=>{if(Clip.mode==='preview')Clip.stop();else Clip.open()}});out.insertBefore(b,$id('btnStory'))}
  const nav=$('#topbar .topnav');
  if(nav){const b=Live.h('button',{type:'button',class:'tbtn accent',id:'btnQuick',title:'Quick play — picture, beat, style, go','aria-label':'Quick play'},[]);
    b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg><span>QUICK PLAY</span>';
    b.addEventListener('click',()=>Quick.open());nav.insertBefore(b,nav.firstChild)}
  const eh=$('#emptyHint .eh-actions');
  if(eh){eh.appendChild(Live.h('button',{type:'button',class:'btn',id:'ehQuick',text:'⚡ QUICK PLAY',onclick:()=>Quick.open()}))}

  // keys: hold F to freeze; K quick clip; J quick play
  let fHeld=false;
  Live.addKey('f',e=>{if(e.repeat)return;fHeld=true;(function hold(){if(!fHeld)return;Live.trigger('freeze',.25);setTimeout(hold,120)})()});
  addEventListener('keyup',e=>{if(e.key&&e.key.toLowerCase()==='f')fHeld=false});
  addEventListener('blur',()=>{fHeld=false});
  Live.addKey('k',()=>Clip.open());
  Live.addKey('j',()=>Quick.open());

  Live.init();
  try{UiLoc.apply()}catch(e){}
})();
