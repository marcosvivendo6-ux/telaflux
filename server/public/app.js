const $ = (s) => document.querySelector(s);
const state = { results: [], saved: loadSaved(), view: 'search', loading: false };
function loadSaved(){ try{return JSON.parse(localStorage.getItem('lhb-saved')||'[]')}catch{return []} }
function persist(){ localStorage.setItem('lhb-saved', JSON.stringify(state.saved)); updateCounts(); }
function updateCounts(){ $('#savedCount').textContent=state.saved.length; }
function escapeHtml(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function safeUrl(s=''){try{const u=new URL(s);return ['https:','http:'].includes(u.protocol)?u.href:''}catch{return ''}}
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2300)}
function setView(view){
 state.view=view;
 $('#searchView').classList.toggle('hidden',view!=='search');
 $('#savedView').classList.toggle('hidden',view!=='saved');
 $('#pageTitle').textContent=view==='search'?'Encontre sua próxima oportunidade.':'Sua lista de oportunidades.';
 document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 if(view==='saved') renderSaved();
}
document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
$('#backSearch').addEventListener('click',()=>setView('search'));
$('#searchForm').addEventListener('submit', async e=>{
 e.preventDefault(); if(state.loading)return;
 const params=new URLSearchParams({city:$('#city').value.trim(),state:$('#state').value,segment:$('#segment').value,limit:$('#limit').value});
 if(!params.get('city'))return;
 state.loading=true; const btn=$('#searchButton');btn.disabled=true;btn.innerHTML='<span class="spinner"></span> Pesquisando…';
 $('#notice').classList.add('hidden');$('#resultsSection').classList.remove('hidden');$('#resultsList').innerHTML='<div class="loading"><span class="spinner"></span> Consultando dados públicos. Isso pode levar alguns segundos…</div>';
 try{
  const r=await fetch('/api/search?'+params.toString());const data=await r.json();
  if(!r.ok)throw new Error(data.error||'A busca não pôde ser concluída.');
  state.results=data.results||[];
  $('#resultsTitle').textContent=`${data.count} empresas encontradas em ${data.query.city}`;
  $('#metricTotal').textContent=state.results.length;
  $('#metricSites').textContent=state.results.filter(x=>x.website).length;
  $('#metricNoSites').textContent=state.results.filter(x=>!x.website).length;
  $('#metricInstagram').textContent=state.results.filter(x=>x.instagram).length;
  showNotice(data.warning||'Resultados carregados.');renderResults();
 }catch(err){$('#resultsList').innerHTML='';showNotice(err.message,true);$('#resultsSection').classList.remove('hidden')}
 finally{state.loading=false;btn.disabled=false;btn.innerHTML='<span>⌕</span> Buscar empresas'}
});
function showNotice(msg,error=false){const n=$('#notice');n.textContent=msg;n.classList.toggle('error',error);n.classList.remove('hidden')}
$('#filterText').addEventListener('input',renderResults);
$('#siteFilter').addEventListener('change',renderResults);
$('#sortBy').addEventListener('change',renderResults);
function filtered(items){
 const q=($('#filterText')?.value||'').toLowerCase().trim(), sf=$('#siteFilter')?.value||'all', sort=$('#sortBy')?.value||'name';
 let arr=items.filter(x=>`${x.name} ${x.address} ${x.phone} ${x.type}`.toLowerCase().includes(q));
 if(sf==='no')arr=arr.filter(x=>!x.website);if(sf==='yes')arr=arr.filter(x=>x.website);
 if(sort==='opportunity')arr.sort((a,b)=>Number(!b.website)-Number(!a.website)||a.name.localeCompare(b.name,'pt-BR'));
 else arr.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
 return arr;
}
function leadCard(x,savedMode=false){
 const isSaved=state.saved.some(s=>s.id===x.id);
 const site=safeUrl(x.website), insta=safeUrl(x.instagram), phone=(x.phone||'').replace(/[^\d+]/g,'');
 const maps=x.lat!=null&&x.lon!=null?`https://www.google.com/maps?q=${x.lat},${x.lon}`:'';
 const status=site?'<span class="status good">✓ Site registrado</span>':'<span class="status warn">! Site não identificado</span>';
 const instaStatus=insta?'<span class="status neutral">Instagram encontrado · bio não verificada</span>':'<span class="status neutral">Instagram não identificado</span>';
 return `<article class="lead-card"><div class="lead-main"><div class="lead-title-row"><div class="lead-title">${escapeHtml(x.name)}</div><span class="type-tag">${escapeHtml(x.type||'negócio')}</span></div><div class="lead-address">⌖ ${escapeHtml(x.address||'Endereço não informado')}</div><div class="lead-links">${site?`<a href="${escapeHtml(site)}" target="_blank" rel="noreferrer">↗ Site</a>`:`<button data-action="audit" data-id="${escapeHtml(x.id)}">⌕ Verificar site manualmente</button>`}${insta?`<a href="${escapeHtml(insta)}" target="_blank" rel="noreferrer">◎ Instagram</a>`:''}${phone?`<a href="https://wa.me/${escapeHtml(phone.replace(/^\+/,'').replace(/^0+/,''))}" target="_blank" rel="noreferrer">☏ Contato/WhatsApp</a>`:''}${maps?`<a href="${maps}" target="_blank" rel="noreferrer">⌖ Mapa</a>`:''}<a href="${escapeHtml(x.osmUrl||'https://www.openstreetmap.org')}" target="_blank" rel="noreferrer">Fonte</a></div><div class="status-row">${status}${instaStatus}</div></div><div class="lead-actions">${site?`<button class="icon-btn" title="Auditar site" data-action="audit" data-id="${escapeHtml(x.id)}">↗</button>`:''}<button class="icon-btn ${isSaved?'saved':''}" title="${isSaved?'Remover dos salvos':'Salvar lead'}" data-action="save" data-id="${escapeHtml(x.id)}">${isSaved?'★':'☆'}</button>${savedMode?'<button class="icon-btn" title="Remover lead" data-action="remove" data-id="'+escapeHtml(x.id)+'">×</button>':''}</div></article>`;
}
function renderResults(){const arr=filtered(state.results);$('#resultsList').innerHTML=arr.length?arr.map(x=>leadCard(x)).join(''):'<div class="empty-state"><h3>Nenhuma empresa com esses filtros</h3><p>Tente mudar o filtro ou pesquisar outra cidade.</p></div>';}
function renderSaved(){updateCounts();$('#emptySaved').classList.toggle('hidden',state.saved.length>0);$('#savedList').innerHTML=state.saved.map(x=>leadCard(x,true)).join('');}
document.addEventListener('click',async e=>{
 const b=e.target.closest('[data-action]');if(!b)return;
 const id=b.dataset.id;let item=state.results.find(x=>x.id===id)||state.saved.find(x=>x.id===id);
 if(b.dataset.action==='save'&&item){if(state.saved.some(x=>x.id===id)){state.saved=state.saved.filter(x=>x.id!==id);toast('Lead removido dos salvos')}else{state.saved.unshift({...item,savedAt:new Date().toISOString(),pipelineStatus:'Pendente'});toast('Lead salvo com sucesso')}persist();renderResults();if(state.view==='saved')renderSaved()}
 if(b.dataset.action==='remove'){state.saved=state.saved.filter(x=>x.id!==id);persist();renderSaved();toast('Lead removido')}
 if(b.dataset.action==='audit'&&item)auditSite(item);
});
async function auditSite(item){
 const dialog=$('#auditDialog');$('#auditTitle').textContent=item.name;
 $('#auditUrl').textContent=item.website||'Nenhum site registrado na fonte consultada.';
 $('#auditResult').innerHTML='<div class="loading"><span class="spinner"></span> Verificando endereço…</div>';
 $('#auditLinks').innerHTML=item.instagram?`<a href="${escapeHtml(item.instagram)}" target="_blank" rel="noreferrer">Abrir Instagram para revisar a bio ↗</a>`:'';
 dialog.showModal();
 if(!item.website){$('#auditResult').textContent='Não há endereço de site para testar. Isso não confirma ausência de site. Pesquise o nome da empresa em outras fontes e confira o Instagram manualmente.';return}
 try{const r=await fetch('/api/audit-site',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:item.website})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Falha na auditoria');
 $('#auditResult').innerHTML=`<strong>${data.reachable?'✓ Endereço respondeu':'! Não foi possível confirmar'}</strong><br>${escapeHtml(data.message)}<br><small class="muted">Status HTTP: ${data.httpStatus??'não confirmado'} · ${new Date(data.checkedAt).toLocaleString('pt-BR')}</small>`;
 }catch(err){$('#auditResult').textContent=err.message}
}
function exportCSV(){
 if(!state.saved.length){toast('Salve pelo menos um lead antes de exportar');return}
 const headers=['Nome','Segmento','Endereço','Cidade','Estado','Telefone','Site','Instagram','Status do site','Revisão Instagram','Fonte','URL da fonte'];
 const rows=state.saved.map(x=>[x.name,x.type,x.address,x.city,x.state,x.phone,x.website,x.instagram,x.websiteStatus,x.instagramBioStatus,x.source,x.osmUrl]);
 const csv=[headers,...rows].map(row=>row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(';')).join('\r\n');
 const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='leadhunter-brasil-leads.csv';a.click();URL.revokeObjectURL(url);toast('CSV exportado');
}
$('#exportButton').addEventListener('click',exportCSV);$('#savedExportButton').addEventListener('click',exportCSV);
updateCounts();
