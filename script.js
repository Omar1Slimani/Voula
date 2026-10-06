


const $ = id => document.getElementById(id);
const RED = '#E2001A';
const POINT_RADIUS = 25;   // م: نصف قطر الدائرة
const TOLERANCE = 6;       // م: هامش الحواف / دقة GPS
const GRID = 0.004;        // حجم خلية الفهرس (~450م)
const DEFAULT_FILE = 'anjar kmz 17_8.kml';
/* Lien direct vers le logo Maroc Telecom (PNG). Collez-le entre les guillemets. */
const LOGO_URL = 'logo.png';
(function(){
  if(!LOGO_URL) return;
  const im=document.getElementById('logoImg');
  im.onload=()=>{im.hidden=false;document.getElementById('logoSvg').style.display='none';document.getElementById('logo').classList.add('has-img')};
  im.src=LOGO_URL;
})();

const ICON_OK='<svg class="i" viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>';
const ICON_NO='<svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_MAP='<svg class="i" viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const ICON_COPY='<svg class="i" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_DEL='<svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';

/* ================= الخريطة ================= */
const map = L.map('map',{zoomControl:false,tap:true,preferCanvas:true,zoomSnap:.5,zoomDelta:1,wheelPxPerZoomLevel:90}).setView([35.003,-5.916],13);
const bases = {
  street: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{maxZoom:22,maxNativeZoom:20,subdomains:'abcd',detectRetina:true,keepBuffer:4,updateWhenIdle:false,attribution:'© OSM © CARTO'}),
  sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:22,maxNativeZoom:18,keepBuffer:4,updateWhenIdle:false,attribution:'© Esri'})
};
let baseKey='street'; bases.street.addTo(map);
function toggleBase(){ map.removeLayer(bases[baseKey]); baseKey = baseKey==='street'?'sat':'street'; bases[baseKey].addTo(map); bases[baseKey].bringToBack(); }
L.control.zoom({position:'topright'}).addTo(map);

const zoneLayer = L.featureGroup().addTo(map);
let currentPhoto=null, pendingNative=false, shapes=[], grid=new Map(), marker=null, userMarker=null, mode='pick';

/* ================= الهندسة (بالأمتار) ================= */
const proj=(lat,lng,lat0,lng0)=>[(lng-lng0)*Math.cos(lat0*Math.PI/180)*111320,(lat-lat0)*110540];
function inRing(r,x,y){
  let ins=false;
  for(let i=0,j=r.length-1;i<r.length;j=i++){
    const xi=r[i][0],yi=r[i][1],xj=r[j][0],yj=r[j][1];
    if(((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi)+xi)) ins=!ins;
  }
  return ins;
}
function distSeg(px,py,a,b){
  const dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy;
  let t=l?((px-a[0])*dx+(py-a[1])*dy)/l:0; t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(a[0]+t*dx),py-(a[1]+t*dy));
}
function distRing(r,x,y){let m=Infinity;for(let i=0,j=r.length-1;i<r.length;j=i++)m=Math.min(m,distSeg(x,y,r[j],r[i]));return m}
/* يعيد المسافة بالمتر إلى الشكل (0 = داخله) */
function distToShape(s,lat,lng){
  if(s.t===1) return Math.max(0, hav(lat,lng,s.lat,s.lng)-POINT_RADIUS);
  const rings=s.rings.map(r=>r.map(c=>proj(c[0],c[1],lat,lng)));
  if(inRing(rings[0],0,0)){
    let hole=false; for(let k=1;k<rings.length;k++) if(inRing(rings[k],0,0)){hole=true;break}
    if(!hole) return 0;
  }
  return Math.min(...rings.map(r=>distRing(r,0,0)));
}
function hav(a,b,c,d){
  const R=6371000,r=x=>x*Math.PI/180,dl=r(c-a),dn=r(d-b);
  const h=Math.sin(dl/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dn/2)**2;
  return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}

/* ================= الفهرس المكاني ================= */
function indexShape(s){
  const M=0.0006,b=s.bbox;
  const x0=Math.floor((b[1]-M)/GRID),x1=Math.floor((b[3]+M)/GRID);
  const y0=Math.floor((b[0]-M)/GRID),y1=Math.floor((b[2]+M)/GRID);
  for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
    const k=x+','+y; let a=grid.get(k); if(!a){a=[];grid.set(k,a)} a.push(s);
  }
}

/* ================= قراءة KML (سريعة وبدون مكتبات) ================= */
const tick=()=>new Promise(r=>setTimeout(r,0));
function setProgress(p,t){ $('loadBar').style.width=p+'%'; if(t)$('loadText').textContent=t; }
function parseCoords(txt){
  const out=[]; const parts=txt.trim().split(/\s+/);
  for(const p of parts){
    const c=p.split(','); const lng=+c[0],lat=+c[1];
    if(isFinite(lat)&&isFinite(lng)&&c.length>=2) out.push([lat,lng]);
  }
  return out;
}
const firstText=(el,tag)=>{const n=el.getElementsByTagName(tag)[0];return n?n.textContent.trim():''};

async function processKML(text,label){
  setProgress(5,'Analyse du fichier...'); await tick();
  const doc=new DOMParser().parseFromString(text,'text/xml');
  if(doc.getElementsByTagName('parsererror').length) throw new Error('XML');
  const pms=doc.getElementsByTagName('Placemark');
  const total=pms.length;
  zoneLayer.clearLayers(); shapes=[]; grid=new Map();
  const polyLatLngs=[], pointShapes=[];
  let gb=[90,180,-90,-180];
  const upd=b=>{if(b[0]<gb[0])gb[0]=b[0];if(b[1]<gb[1])gb[1]=b[1];if(b[2]>gb[2])gb[2]=b[2];if(b[3]>gb[3])gb[3]=b[3]};

  for(let i=0;i<total;i++){
    const pm=pms[i], name=firstText(pm,'name')||'Zone';
    const polys=pm.getElementsByTagName('Polygon');
    for(let p=0;p<polys.length;p++){
      const poly=polys[p], rings=[];
      const ob=poly.getElementsByTagName('outerBoundaryIs')[0];
      if(ob){const c=ob.getElementsByTagName('coordinates')[0]; if(c) rings.push(parseCoords(c.textContent))}
      const ibs=poly.getElementsByTagName('innerBoundaryIs');
      for(let k=0;k<ibs.length;k++){const c=ibs[k].getElementsByTagName('coordinates')[0]; if(c) rings.push(parseCoords(c.textContent))}
      if(!rings.length||rings[0].length<3) continue;
      let a=90,b=180,c2=-90,d=-180;
      for(const q of rings[0]){ if(q[0]<a)a=q[0]; if(q[0]>c2)c2=q[0]; if(q[1]<b)b=q[1]; if(q[1]>d)d=q[1]; }
      const s={t:0,name,rings,bbox:[a,b,c2,d]};
      shapes.push(s); indexShape(s); polyLatLngs.push(rings); upd(s.bbox);
    }
    const pts=pm.getElementsByTagName('Point');
    for(let p=0;p<pts.length;p++){
      const c=pts[p].getElementsByTagName('coordinates')[0]; if(!c) continue;
      const pp=parseCoords(c.textContent)[0]; if(!pp) continue;
      const dl=POINT_RADIUS/110540, dn=POINT_RADIUS/(111320*Math.cos(pp[0]*Math.PI/180));
      const s={t:1,name,lat:pp[0],lng:pp[1],bbox:[pp[0]-dl,pp[1]-dn,pp[0]+dl,pp[1]+dn]};
      shapes.push(s); indexShape(s); pointShapes.push(s); upd(s.bbox);
    }
    if(i%300===0){ setProgress(10+Math.round(i/total*70),`Lecture ${i} / ${total}`); await tick(); }
  }

  setProgress(85,'Dessin de la carte...'); await tick();
  const style={color:RED,weight:2,fillColor:RED,fillOpacity:.28,interactive:false};
  if(polyLatLngs.length) L.polygon(polyLatLngs,style).addTo(zoneLayer);
  pointShapes.forEach(s=>L.circle([s.lat,s.lng],{...style,radius:POINT_RADIUS,fillOpacity:.45}).addTo(zoneLayer));

  if(!shapes.length){ updateStatus('','Fichier vide'); showToast('Le fichier ne contient aucune zone'); return false; }
  map.fitBounds([[gb[0],gb[1]],[gb[2],gb[3]]],{padding:[30,30]});
  updateStatus('ready',`${label||'Prêt'} • ${shapes.length}`);
  updateCheckBtn();
  return true;
}

/* ================= الفحص ================= */
function checkPoint(fromMap){
  const lat=parseFloat($('lat').value), lng=parseFloat($('lng').value);
  if(isNaN(lat)||isNaN(lng)) return showToast('Choisissez d’abord un point');
  if(!shapes.length) return showToast('Importez d’abord un fichier KML');

  const cand=grid.get(Math.floor(lng/GRID)+','+Math.floor(lat/GRID))||[];
  let hit=null;
  for(const s of cand){
    const b=s.bbox,M=0.0006;
    if(lat<b[0]-M||lat>b[2]+M||lng<b[1]-M||lng>b[3]+M) continue;
    if(distToShape(s,lat,lng)<=TOLERANCE){hit=s;break}
  }

  const el=$('result'); el.style.display='block';
  const acts=`<div class="acts"><a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener">${ICON_MAP}Google Maps</a><button type="button" onclick="copyCoords(${lat},${lng})">${ICON_COPY}Copier</button></div>`;
  if(hit){
    el.className='voula';
    el.innerHTML=`${photoHTML()}<div class="head"><div class="ico">${ICON_OK}</div><div><b>Zone Voula</b><span class="sub">Client dans la couverture${hit.name&&hit.name!=='Zone'?' — '+esc(hit.name):''}</span></div></div>${acts}`;
    showMarker(lat,lng,true);
    navigator.vibrate&&navigator.vibrate(50);
  }else{
    const near=shapes.map(s=>({s,d:hav(lat,lng,(s.bbox[0]+s.bbox[2])/2,(s.bbox[1]+s.bbox[3])/2)})).sort((a,b)=>a.d-b.d).slice(0,5);
    const nd=Math.min(...near.map(n=>distToShape(n.s,lat,lng)));
    el.className='hors';
    el.innerHTML=`${photoHTML()}<div class="head"><div class="ico">${ICON_NO}</div><div><b>Hors Zone Voula</b><span class="sub">Hors couverture — zone la plus proche à ${fmt(nd)}</span></div></div>${acts}`;
    showMarker(lat,lng,false);
    navigator.vibrate&&navigator.vibrate([30,50,30]);
  }
  addHistory(lat,lng,!!hit);
  if(fromMap) sheet.classList.remove('collapsed');
  requestAnimationFrame(()=>el.scrollIntoView({block:'nearest',behavior:'smooth'}));
}
const fmt=m=>m<1000?Math.round(m)+' m':(m/1000).toFixed(1)+' km';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function copyCoords(la,lo){
  const t=`${la.toFixed(6)}, ${lo.toFixed(6)}`;
  (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>showToast('Coordonnées copiées')).catch(()=>{
    const i=document.createElement('input');i.value=t;document.body.appendChild(i);i.select();try{document.execCommand('copy');showToast('Coordonnées copiées')}catch(e){showToast(t)}i.remove();
  });
}

/* ================= السجل (مع الحذف) ================= */
let history=[]; try{history=JSON.parse(localStorage.getItem('zv_hist')||'[]')}catch(e){}
function saveHistory(){try{localStorage.setItem('zv_hist',JSON.stringify(history))}catch(e){}}
function addHistory(lat,lng,ok){
  history=history.filter(h=>!(h.lat===lat&&h.lng===lng)); history.unshift({lat,lng,ok}); history=history.slice(0,10);
  saveHistory(); renderHistory();
}
function renderHistory(){
  $('hist').classList.toggle('hidden',!history.length);
  $('histList').innerHTML=history.map((h,i)=>`<div class="hitem"><button class="go" onclick="useHistory(${i})"><span>${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}</span><span class="tag ${h.ok?'ok':''}">${h.ok?'Zone':'Hors'}</span></button><button class="del" onclick="deleteHistory(${i})" aria-label="Supprimer">${ICON_DEL}</button></div>`).join('');
  resetClearBtn();
}
function useHistory(i){const h=history[i];if(!h)return;setPoint(h.lat,h.lng);map.setView([h.lat,h.lng],17);checkPoint()}
function deleteHistory(i){history.splice(i,1);saveHistory();renderHistory();showToast('Élément supprimé',1400)}
let clearTimer=null;
function resetClearBtn(){clearTimeout(clearTimer);$('clearBtn').classList.remove('confirm');$('clearTxt').textContent='Tout effacer'}
function clearHistory(){
  const b=$('clearBtn');
  if(!b.classList.contains('confirm')){
    b.classList.add('confirm');$('clearTxt').textContent='Confirmer ?';
    clearTimer=setTimeout(resetClearBtn,3000); return;
  }
  history=[];saveHistory();renderHistory();showToast('Historique effacé',1600);
}

/* ================= واجهة ================= */
function showToast(m,d=2400){const t=$('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),d)}
function updateStatus(s,t){$('statusBadge').className='badge '+s;$('statusText').textContent=t}
function showLoading(v){$('loading').classList.toggle('show',v); if(v)setProgress(0,'Chargement des données...')}

const sheet=$('sheet'), dz=$('dragzone');
let cY=0;
const isDesktop=()=>window.matchMedia('(min-width:768px)').matches;
function measure(){
  if(isDesktop()){sheet.style.removeProperty('--cy');return}
  const cs=getComputedStyle(sheet);
  const peek=dz.offsetHeight+parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom);
  cY=Math.max(0,sheet.offsetHeight-peek);
  sheet.style.setProperty('--cy',cY+'px');
}
if(window.ResizeObserver) new ResizeObserver(measure).observe(sheet);
window.addEventListener('resize',measure);
window.addEventListener('orientationchange',()=>setTimeout(measure,250));
let drag=null, raf=0;
dz.addEventListener('pointerdown',e=>{
  if(isDesktop()||e.target.closest('button')) return;
  drag={id:e.pointerId,y0:e.clientY,base:sheet.classList.contains('collapsed')?cY:0,y:0,lastY:e.clientY,lastT:performance.now(),v:0,moved:false};
  dz.setPointerCapture(e.pointerId);
});
dz.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.id) return;
  const dy=e.clientY-drag.y0;
  if(!drag.moved){ if(Math.abs(dy)<6) return; drag.moved=true; sheet.style.transition='none'; }
  const now=performance.now();
  drag.v=(e.clientY-drag.lastY)/Math.max(1,now-drag.lastT); drag.lastY=e.clientY; drag.lastT=now;
  drag.y=Math.max(0,Math.min(cY,drag.base+dy));
  if(!raf) raf=requestAnimationFrame(()=>{raf=0; sheet.style.transform=`translate3d(0,${drag.y}px,0)`});
});
function endDrag(e){
  if(!drag||e.pointerId!==drag.id) return;
  const d=drag; drag=null;
  if(!d.moved){ sheet.classList.toggle('collapsed'); return; }
  cancelAnimationFrame(raf); raf=0;
  sheet.style.transition=''; sheet.style.transform='';
  sheet.classList.toggle('collapsed', Math.abs(d.v)>.4 ? d.v>0 : d.y>cY/2);
}
dz.addEventListener('pointerup',endDrag);
dz.addEventListener('pointercancel',endDrag);

function setMode(m){
  mode=m; const man=m==='manual';
  $('lat').disabled=$('lng').disabled=!man;
  $('btnManual').classList.toggle('active',man); $('btnPick').classList.toggle('active',!man);
  $('hint').classList.toggle('hidden',man); $('pasteBox').classList.toggle('hidden',!man);
  document.body.classList.toggle('picking',!man);
  if(man) setTimeout(()=>$('paste').focus(),100);
}
function updateCheckBtn(){
  const lat=parseFloat($('lat').value),lng=parseFloat($('lng').value),ok=!isNaN(lat)&&!isNaN(lng);
  $('checkBtn').disabled=$('quickCheck').disabled=!ok;
  const p=$('preview'); $('previewText').textContent=ok?`${lat.toFixed(5)}, ${lng.toFixed(5)}`:'Aucun point choisi'; p.classList.toggle('empty',!ok);
}
function showMarker(lat,lng,res){
  if(marker) map.removeLayer(marker);
  const c=res===true?RED:res===false?'#141414':'#7a7a7a';
  marker=L.marker([lat,lng],{icon:L.divIcon({className:'',html:`<div class="pin" style="background:${c}"></div>`,iconSize:[22,22],iconAnchor:[11,11]}),keyboard:false}).addTo(map);
}
function showAccuracy(lat,lng,acc){
  if(userMarker){map.removeLayer(userMarker);userMarker=null}
  if(acc&&isFinite(acc)) userMarker=L.circle([lat,lng],{radius:acc,color:'#141414',weight:1,fillOpacity:.08,interactive:false}).addTo(map);
}
function setPoint(lat,lng,photo,acc){
  currentPhoto=photo||null;
  $('lat').value=(+lat).toFixed(6);$('lng').value=(+lng).toFixed(6);
  showMarker(lat,lng,null); showAccuracy(lat,lng,acc); updateCheckBtn();
}

map.on('click',e=>{ if(mode!=='pick')return; setPoint(e.latlng.lat,e.latlng.lng); checkPoint(true); });

/* لصق إحداثيات أو رابط Google Maps */
$('paste').addEventListener('input',e=>{
  const t=e.target.value;
  const m=t.match(/@?(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/);
  if(m){const la=+m[1],lo=+m[2]; if(Math.abs(la)<=90&&Math.abs(lo)<=180){setPoint(la,lo);map.setView([la,lo],17);checkPoint()}}
});
$('lat').addEventListener('input',updateCheckBtn);
$('lng').addEventListener('input',updateCheckBtn);

function locateMe(){
  const b=$('locateBtn');
  if(!navigator.geolocation) return showToast('Géolocalisation non prise en charge');
  b.classList.add('locating');
  navigator.geolocation.getCurrentPosition(pos=>{
    b.classList.remove('locating');
    const {latitude:la,longitude:lo,accuracy}=pos.coords;
    map.setView([la,lo],17);
    setPoint(la,lo,null,accuracy); checkPoint(true);
    if(accuracy>30) showToast(`Précision GPS faible (±${Math.round(accuracy)} m)`);
  },err=>{
    b.classList.remove('locating');
    showToast(err.code===1?'Autorisez l’accès à la position':err.code===3?'Délai de localisation dépassé':'Position indisponible');
  },{enableHighAccuracy:true,timeout:12000,maximumAge:0});
}

function resetAll(){
  currentPhoto=null; $('lat').value=$('lng').value=$('paste').value='';
  $('result').style.display='none';
  if(marker){map.removeLayer(marker);marker=null}
  if(userMarker){map.removeLayer(userMarker);userMarker=null}
  updateCheckBtn();
}

/* ================= GPS (suivi haute précision) ================= */
let gpsWatch=null, gpsBest=null, gpsCb=null;
function startGps(cb){
  stopGps(); gpsBest=null; gpsCb=cb||null;
  if(!navigator.geolocation){ gpsCb&&gpsCb(null,'unsupported'); return }
  gpsWatch=navigator.geolocation.watchPosition(p=>{
    const c=p.coords, now=Date.now();
    /* on garde la meilleure précision récente */
    if(!gpsBest||c.accuracy<=gpsBest.accuracy+3||now-gpsBest.t>8000)
      gpsBest={lat:c.latitude,lng:c.longitude,accuracy:c.accuracy,t:now};
    gpsCb&&gpsCb(gpsBest);
  },err=>{ gpsCb&&gpsCb(null,err.code) },{enableHighAccuracy:true,maximumAge:0,timeout:25000});
}
function stopGps(){ if(gpsWatch!==null&&navigator.geolocation){navigator.geolocation.clearWatch(gpsWatch)} gpsWatch=null; gpsCb=null; }

/* ================= Caméra GPS intégrée ================= */
let camStream=null;
function setChip(cls,txt){ $('gpsChip').className='gps-chip '+cls; $('gpsText').textContent=txt; }
function onGpsUpdate(pos,err){
  const sh=$('shutter');
  if(!pos){
    const m=err===1?'GPS refusé : autorisez la localisation':err==='unsupported'?'GPS non pris en charge':err===3?'GPS : délai dépassé':'GPS indisponible';
    setChip('err',m); sh.disabled=true; $('camCoords').textContent=''; return;
  }
  const a=Math.round(pos.accuracy);
  setChip(pos.accuracy<=30?'ok':'', pos.accuracy<=30?`GPS prêt • ±${a} m`:`GPS : précision ±${a} m…`);
  $('camCoords').textContent=`${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;
  sh.disabled=false;
}
async function openCamera(){
  /* le GPS est activé dès l'ouverture (geste utilisateur) */
  setChip('','GPS : recherche…'); $('camCoords').textContent=''; $('shutter').disabled=true;
  $('camMsg').style.display='none';
  startGps(onGpsUpdate);
  const useNative=()=>{ pendingNative=true; $('camInput').click(); };
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ return useNative(); }
  try{
    camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
    const v=$('camVideo'); v.srcObject=camStream; await v.play().catch(()=>{});
    $('cam').classList.add('show');
  }catch(e){
    console.warn('camera',e);
    camStream=null;
    useNative();
  }
}
function closeCamera(){
  $('cam').classList.remove('show');
  if(camStream){camStream.getTracks().forEach(t=>t.stop());camStream=null}
  $('camVideo').srcObject=null;
  if(!pendingNative) stopGps();
}
async function snap(){
  const v=$('camVideo');
  if(!v.videoWidth||!gpsBest) return showToast('GPS pas encore prêt');
  const pos={...gpsBest};                        /* position figée au moment de la prise de vue */
  const f=$('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  navigator.vibrate&&navigator.vibrate(30);
  const k=Math.min(1,520/v.videoWidth), c=document.createElement('canvas');
  c.width=Math.round(v.videoWidth*k); c.height=Math.round(v.videoHeight*k);
  c.getContext('2d').drawImage(v,0,0,c.width,c.height);
  const src=c.toDataURL('image/jpeg',.72);
  closeCamera();
  setPoint(pos.lat,pos.lng,{src,note:`Position GPS à la prise de vue (±${Math.round(pos.accuracy)} m)`},pos.accuracy);
  map.setView([pos.lat,pos.lng],18);
  checkPoint(true);
}
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&$('cam').classList.contains('show')) closeCamera(); });

/* ================= Photos : EXIF / galerie / caméra native (secours) ================= */
function parseTiff(v,t){
  const le=v.getUint16(t)===0x4949, u16=p=>v.getUint16(p,le), u32=p=>v.getUint32(p,le);
  const ifd=t+u32(t+4); let gps=null;
  for(let i=0,n=u16(ifd);i<n;i++){const e=ifd+2+i*12; if(u16(e)===0x8825){gps=t+u32(e+8);break}}
  if(!gps) return null;
  const g={};
  for(let i=0,n=u16(gps);i<n;i++){
    const e=gps+2+i*12, tag=u16(e);
    if(tag===1||tag===3) g[tag]=String.fromCharCode(v.getUint8(e+8));
    else if(tag===2||tag===4){const q=t+u32(e+8); g[tag]=[0,1,2].map(k=>u32(q+k*8)/(u32(q+k*8+4)||1))}
  }
  if(!g[2]||!g[4]) return null;
  let la=g[2][0]+g[2][1]/60+g[2][2]/3600, lo=g[4][0]+g[4][1]/60+g[4][2]/3600;
  if(g[1]==='S') la=-la; if(g[3]==='W') lo=-lo;
  return isFinite(la)&&isFinite(lo)&&(la||lo)?{lat:la,lng:lo}:null;
}
async function readExifGPS(file){
  try{
    const v=new DataView(await file.slice(0,262144).arrayBuffer());
    if(v.getUint16(0)!==0xFFD8) return null;
    let o=2;
    while(o<v.byteLength-10){
      const m=v.getUint16(o);
      if((m&0xFF00)!==0xFF00) break;
      if(m===0xFFE1&&v.getUint32(o+4)===0x45786966){const r=parseTiff(v,o+10); if(r) return r}
      o+=2+v.getUint16(o+2);
    }
  }catch(e){}
  return null;
}
function pickPhoto(){ pendingNative=false; $('galInput').click(); }
function photoHTML(){ return currentPhoto?`${currentPhoto.src?`<img class="shot" src="${currentPhoto.src}" alt="">`:''}<div class="pnote">${esc(currentPhoto.note)}</div>`:''; }
function makeThumb(file){
  return new Promise(res=>{
    const u=URL.createObjectURL(file), im=new Image();
    im.onload=()=>{const k=Math.min(1,520/im.width),c=document.createElement('canvas');c.width=im.width*k;c.height=im.height*k;c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);res(c.toDataURL('image/jpeg',.72))};
    im.onerror=()=>{URL.revokeObjectURL(u);res('')};
    im.src=u;
  });
}
async function onPhoto(e,fromCam){
  const f=e.target.files[0]; e.target.value='';
  if(!f){ if(fromCam){pendingNative=false;stopGps()} return }
  showToast('Lecture de la position de la photo...',8000);
  let pos=await readExifGPS(f), note='Coordonnées issues de la photo', acc=null;
  if(!pos&&fromCam&&gpsBest){
    pos={lat:gpsBest.lat,lng:gpsBest.lng}; acc=gpsBest.accuracy;
    note=`Position GPS de l'appareil à la prise de vue (±${Math.round(acc)} m)`;
  }
  if(fromCam){pendingNative=false;stopGps()}
  if(!pos) return showToast('Aucune coordonnée dans la photo. Utilisez la Caméra GPS ou autorisez la localisation.',5000);
  const src=await makeThumb(f);
  setPoint(pos.lat,pos.lng,{src,note},acc);
  map.setView([pos.lat,pos.lng],18);
  checkPoint(true);
}
$('camInput').addEventListener('change',e=>onPhoto(e,true));
$('galInput').addEventListener('change',e=>onPhoto(e,false));
/* annulation de la caméra native */
$('camInput').addEventListener('cancel',()=>{pendingNative=false;stopGps()});

/* ================= تخزين الملف محلياً (IndexedDB) ================= */
function idb(){return new Promise((res,rej)=>{const r=indexedDB.open('zv',1);r.onupgradeneeded=()=>r.result.createObjectStore('f');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function cacheSet(v){try{const d=await idb();d.transaction('f','readwrite').objectStore('f').put(v,'kml')}catch(e){}}
async function cacheGet(){try{const d=await idb();return await new Promise(r=>{const q=d.transaction('f').objectStore('f').get('kml');q.onsuccess=()=>r(q.result);q.onerror=()=>r(null)})}catch(e){return null}}

/* ================= تحميل الملفات ================= */
async function loadText(text,label,save){
  showLoading(true); updateStatus('loading','Traitement');
  try{
    const ok=await processKML(text,label);
    if(ok&&save) cacheSet({text,label});
  }catch(e){console.error(e);showToast('Lecture du fichier impossible');updateStatus('','Échec du chargement')}
  finally{showLoading(false)}
}
$('fileInput').addEventListener('change',async e=>{
  const f=e.target.files[0]; if(!f) return;
  const n=f.name.toLowerCase();
  try{
    if(n.endsWith('.kmz')){
      showLoading(true); setProgress(3,'Décompression...');
      const zip=await JSZip.loadAsync(f);
      const k=Object.keys(zip.files).find(x=>x.toLowerCase().endsWith('.kml'));
      if(!k) throw new Error('no kml');
      const txt=await zip.files[k].async('string');
      await loadText(txt,f.name,true);
    }else if(n.endsWith('.kml')){
      await loadText(await f.text(),f.name,true);
    }else showToast('Choisissez un fichier KML ou KMZ');
  }catch(err){console.error(err);showLoading(false);showToast('Lecture du fichier impossible');updateStatus('','Échec du chargement')}
  e.target.value='';
});

window.addEventListener('load',async()=>{
  renderHistory();
  updateStatus('loading','Chargement');
  if(location.protocol!=='file:'){
    try{
      const r=await fetch(DEFAULT_FILE); if(!r.ok) throw 0;
      return loadText(await r.text(),'KML',true);
    }catch(e){}
  }
  const c=await cacheGet();
  if(c&&c.text) return loadText(c.text,c.label,false);
  updateStatus('','Importez le fichier'); showToast('Importez un fichier KML pour commencer'); sheet.classList.remove('collapsed');
});
/* En zoom proche : zone plus transparente pour voir les bâtiments dessous */
map.on('zoomend',()=>{ zoneLayer.setStyle(map.getZoom()>=17?{weight:3,fillOpacity:.1}:{weight:2,fillOpacity:.28}); });
setMode('pick'); measure();
