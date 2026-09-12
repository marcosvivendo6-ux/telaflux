require("dotenv").config();
const express=require("express"),crypto=require("crypto"),Database=require("better-sqlite3"),path=require("path"),fs=require("fs");
const dbPath=process.env.DB_PATH||path.join(__dirname,"data","telaflux.db");fs.mkdirSync(path.dirname(dbPath),{recursive:true});const db=new Database(dbPath);db.exec(`CREATE TABLE IF NOT EXISTS content (id INTEGER PRIMARY KEY AUTOINCREMENT,tmdb_id INTEGER,media_type TEXT NOT NULL,title TEXT NOT NULL,featured INTEGER DEFAULT 0,published INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY AUTOINCREMENT,tmdb_id INTEGER NOT NULL,media_type TEXT NOT NULL,user_id INTEGER NOT NULL,rating REAL NOT NULL CHECK(rating>=0 AND rating<=5),created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(tmdb_id,media_type,user_id)); CREATE INDEX IF NOT EXISTS idx_ratings_title ON ratings(tmdb_id,media_type); CREATE TRIGGER IF NOT EXISTS trg_ratings_half_step BEFORE INSERT ON ratings BEGIN SELECT CASE WHEN NEW.rating<0 OR NEW.rating>5 OR NEW.rating*2!=CAST(NEW.rating*2 AS INTEGER) THEN RAISE(ABORT,"rating must be between 0 and 5 in 0.5 steps") END; END; CREATE TRIGGER IF NOT EXISTS trg_ratings_half_step_update BEFORE UPDATE OF rating ON ratings BEGIN SELECT CASE WHEN NEW.rating<0 OR NEW.rating>5 OR NEW.rating*2!=CAST(NEW.rating*2 AS INTEGER) THEN RAISE(ABORT,"rating must be between 0 and 5 in 0.5 steps") END; END`);
const app=express(),PORT=process.env.PORT||3000,TMDB_TOKEN=process.env.TMDB_TOKEN,TMDB_API_KEY=process.env.TMDB_API_KEY,APP_URL=process.env.APP_URL||process.env.API_URL||process.env.RENDER_EXTERNAL_URL||`http://localhost:${process.env.PORT||3000}`,FRONTEND_URL=(process.env.FRONTEND_URL||"").replace(/\/+$/,"");const FRONTEND_ORIGIN=(()=>{try{return FRONTEND_URL?new URL(FRONTEND_URL).origin:""}catch{return""}})(),API_PUBLIC_URL=(process.env.API_URL||process.env.RENDER_EXTERNAL_URL||APP_URL).replace(/\/+$/,"");const sessions=new Map(),providerCache=new Map(),upcomingCache={expires:0,data:null},discoverCache={expires:0,data:null};
const SESSION_TTL=24*60*60*1000;
const TMDB_TIMEOUT=12000;
const sessionCleanup=setInterval(()=>{const now=Date.now();for(const [token,session] of sessions){if(now-session.lastSeen>SESSION_TTL)sessions.delete(token)}},15*60*1000);
sessionCleanup.unref?.();
function getSession(req){const token=String(req.headers["x-telaflux-session"]||req.headers["x-cineverse-session"]||"");if(!token)return null;const session=sessions.get(token);if(!session)return null;if(Date.now()-session.lastSeen>SESSION_TTL){sessions.delete(token);return null}session.lastSeen=Date.now();return session}function sessionToken(){return crypto.randomBytes(32).toString("hex")}
const ratingAttempts=new Map(); function ratingRateLimit(req){const key=String(req.headers["x-telaflux-session"]||req.headers["x-cineverse-session"]||req.ip||"unknown");const now=Date.now(),entry=ratingAttempts.get(key)||{start:now,count:0};if(now-entry.start>60000){entry.start=now;entry.count=0}entry.count++;ratingAttempts.set(key,entry);return entry.count<=30}
function providerNames(data){const br=data?.results?.BR||data?.results?.["BR"],names=[],normalize=n=>{const x=String(n||"").trim().toLowerCase();if(x==="netflix")return"Netflix";if(x==="amazon prime video"||x==="prime video")return"Prime Video";if(x==="disney plus"||x==="disney+")return"Disney+";if(x==="max"||x==="hbo max")return"HBO Max";if(x==="apple tv"||x==="apple tv+")return"Apple TV+";return String(n||"").trim()};for(const p of [...(br?.flatrate||[]),...(br?.free||[]),...(br?.ads||[])]){const n=normalize(p?.provider_name);if(n&&!names.includes(n))names.push(n)}return names}
async function getProviders(type,id){const key=`${type}:${id}`,c=providerCache.get(key);if(c&&c.expires>Date.now())return c.names;try{const d=await tmdb(`${type}/${id}/watch/providers`,{watch_region:"BR",language:"pt-BR"}),names=providerNames(d);providerCache.set(key,{names,expires:Date.now()+600000});return names}catch{return[]}}
app.disable("x-powered-by");app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");res.setHeader("X-Frame-Options","DENY");res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");if(req.headers["x-forwarded-proto"]==="https"||req.secure)res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");next()});
app.use((req,res,next)=>{const origin=req.headers.origin,allowed=!origin||origin===FRONTEND_ORIGIN||/^https?:\/\/localhost(?::\d+)?$/.test(origin||"");if(allowed){res.setHeader("Access-Control-Allow-Origin",origin||"*");res.setHeader("Vary","Origin");res.setHeader("Access-Control-Allow-Headers","Content-Type, Accept, X-Telaflux-Session, X-Cineverse-Session, X-Admin-Key");res.setHeader("Access-Control-Allow-Methods","GET,POST,DELETE,OPTIONS")}if(req.method==="OPTIONS")return res.sendStatus(204);next()});app.use(express.json({limit:"100kb"}));app.use(express.static(__dirname));
function tmdbUrl(endpoint,params={}){const qs=new URLSearchParams(params).toString();return`https://api.themoviedb.org/3/${endpoint}${qs?"?"+qs:""}`}async function fetchWithTimeout(url,options={},timeout=TMDB_TIMEOUT){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);try{return await fetch(url,{...options,signal:options.signal||controller.signal})}finally{clearTimeout(timer)}}async function tmdb(endpoint,params={}){if(!TMDB_TOKEN)throw new Error("TMDB_TOKEN não configurado");const r=await fetchWithTimeout(tmdbUrl(endpoint,params),{headers:{Authorization:`Bearer ${TMDB_TOKEN}`,accept:"application/json"}});if(!r.ok)throw new Error(`TMDB ${r.status}`);return r.json()}
const genreNames={28:"Ação",12:"Aventura",16:"Animação",35:"Comédia",80:"Crime",99:"Documentário",18:"Drama",14:"Fantasia",27:"Terror",10749:"Romance",878:"Ficção",53:"Suspense",10751:"Família",9648:"Mistério"};

const adminAttempts=new Map();const rateLimitCleanup=setInterval(()=>{const now=Date.now();for(const [key,entry] of ratingAttempts){if(now-entry.start>120000)ratingAttempts.delete(key)}for(const [key,entry] of adminAttempts){if(now-entry.start>120000)adminAttempts.delete(key)}},120000);rateLimitCleanup.unref?.();function adminRateLimit(req){const key=String(req.ip||"unknown"),now=Date.now(),entry=adminAttempts.get(key)||{start:now,count:0};if(now-entry.start>60000){entry.start=now;entry.count=0}entry.count++;adminAttempts.set(key,entry);return entry.count<=30}
function isSafeHttpUrl(value){try{const u=new URL(String(value||""));return u.protocol==="https:"&&u.hostname==="www.themoviedb.org"}catch{return false}}
function escapeHtmlServer(value=""){return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
app.get("/api/auth/start",async(req,res)=>{try{if(!TMDB_TOKEN)throw new Error("TMDB_TOKEN não configurado");const r=await fetchWithTimeout("https://api.themoviedb.org/3/authentication/token/new",{headers:{Authorization:`Bearer ${TMDB_TOKEN}`}}),d=await r.json();if(!d.success)throw new Error(d.status_message||"Falha");res.redirect(`https://www.themoviedb.org/authenticate/${d.request_token}?redirect_to=${encodeURIComponent(API_PUBLIC_URL+"/api/auth/callback")}`)}catch(e){res.status(500).send(`<h2>Não foi possível iniciar o login</h2><p>Tente novamente em instantes.</p>`)}});
app.get("/api/auth/callback",async(req,res)=>{try{if(!/^[A-Za-z0-9_-]{20,200}$/.test(String(req.query.request_token||"")))return res.status(400).send("Solicitação de login inválida.");const r=await fetchWithTimeout("https://api.themoviedb.org/3/authentication/session/new",{method:"POST",headers:{Authorization:`Bearer ${TMDB_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({request_token:req.query.request_token})}),d=await r.json();if(!d.success)throw new Error(d.status_message||"Autenticação recusada");const me=await tmdb("account",{session_id:d.session_id}),browserToken=sessionToken();sessions.set(browserToken,{session_id:d.session_id,account:me,lastSeen:Date.now()});res.redirect(`${FRONTEND_URL||API_PUBLIC_URL}/#telaflux_session=${encodeURIComponent(browserToken)}`)}catch(e){res.status(500).send(`<h2>Não foi possível concluir o login</h2><p>Tente novamente em instantes.</p><a href="/">Voltar</a>`)}});
app.get("/api/me",async(req,res)=>{const s=getSession(req);if(!s)return res.status(401).json({authenticated:false});res.setHeader("Cache-Control","no-store");res.json({authenticated:true,account:{id:s.account?.id,name:s.account?.name||"",username:s.account?.username||""}})});app.post("/api/logout",(req,res)=>{sessions.delete(req.headers["x-telaflux-session"]||req.headers["x-cineverse-session"]);res.setHeader("Cache-Control","no-store");res.json({ok:true})});
app.get("/api/watchlist",async(req,res)=>{res.setHeader("Cache-Control","no-store");const s=getSession(req);if(!s)return res.status(401).json({error:"login_required"});try{const[m,t]=await Promise.all([tmdb(`account/${s.account.id}/watchlist/movies`,{session_id:s.session_id,language:"pt-BR",sort_by:"created_at.desc"}),tmdb(`account/${s.account.id}/watchlist/tv`,{session_id:s.session_id,language:"pt-BR",sort_by:"created_at.desc"})]);res.json({movies:m.results||[],tv:t.results||[]})}catch(e){res.status(500).json({error:"internal_error"})}});
app.post("/api/watchlist",async(req,res)=>{const s=getSession(req);if(!s)return res.status(401).json({error:"login_required"});try{const{media_id,media_type,watchlist}=req.body||{};if(!Number.isInteger(Number(media_id))||!["movie","tv"].includes(media_type)||typeof watchlist!=="boolean")return res.status(400).json({error:"media_id, media_type e watchlist inválidos"});const r=await fetchWithTimeout(`https://api.themoviedb.org/3/account/${s.account.id}/watchlist?session_id=${encodeURIComponent(s.session_id)}`,{method:"POST",headers:{Authorization:`Bearer ${TMDB_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify(req.body)});let payload={};try{payload=await r.json()}catch{}res.status(r.status).json(payload)}catch(e){res.status(500).json({error:"internal_error"})}});
app.get("/api/health",(req,res)=>{res.setHeader("Cache-Control","no-store");res.json({ok:true})});
app.get("/api/ratings",(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const tmdbId=Number(req.query.tmdb_id),mediaType=String(req.query.type||"movie");
    if(!Number.isInteger(tmdbId)||tmdbId<=0||!["movie","tv"].includes(mediaType))return res.status(400).json({error:"tmdb_id ou type inválidos"});
    const row=db.prepare("SELECT ROUND(AVG(rating),1) AS average, COUNT(*) AS votes FROM ratings WHERE tmdb_id=? AND media_type=?").get(tmdbId,mediaType);
    const s=getSession(req);let mine=null;
    if(s){const userId=Number(s.account?.id);if(Number.isInteger(userId)&&userId>0){const r=db.prepare("SELECT rating FROM ratings WHERE tmdb_id=? AND media_type=? AND user_id=?").get(tmdbId,mediaType,userId);if(r)mine=Number(r.rating)}}
    res.json({tmdb_id:tmdbId,type:mediaType,average:row?.votes?Number(row.average):null,votes:Number(row?.votes||0),mine});
  }catch(e){res.status(500).json({error:"internal_error"})}
});
app.post("/api/ratings",(req,res)=>{
  const s=getSession(req);if(!s)return res.status(401).json({error:"login_required"});
  if(!ratingRateLimit(req))return res.status(429).json({error:"Muitas avaliações em pouco tempo. Tente novamente em instantes."});
  try{
    const tmdbId=Number(req.body?.tmdb_id),mediaType=String(req.body?.type||"");
    const rating=Number(req.body?.rating),userId=Number(s.account?.id);
    if(!Number.isInteger(tmdbId)||tmdbId<=0||!["movie","tv"].includes(mediaType)||!Number.isInteger(userId)||userId<=0||!Number.isFinite(rating)||rating<0||rating>5||Math.round(rating*2)/2!==rating)return res.status(400).json({error:"tmdb_id, type e rating inválidos. A nota deve ser de 0 a 5, em passos de 0,5."});
    db.prepare(`INSERT INTO ratings(tmdb_id,media_type,user_id,rating) VALUES(?,?,?,?) ON CONFLICT(tmdb_id,media_type,user_id) DO UPDATE SET rating=excluded.rating,updated_at=CURRENT_TIMESTAMP`).run(tmdbId,mediaType,userId,rating);
    const row=db.prepare("SELECT ROUND(AVG(rating),1) AS average, COUNT(*) AS votes FROM ratings WHERE tmdb_id=? AND media_type=?").get(tmdbId,mediaType);
    res.json({ok:true,tmdb_id:tmdbId,type:mediaType,average:Number(row.average),votes:Number(row.votes),mine:rating});
  }catch(e){console.error("ratings POST:",e);res.status(500).json({error:"Não foi possível registrar a avaliação."})}
});
app.get("/api/watch",async(req,res)=>{try{res.setHeader("Cache-Control","public, max-age=300, stale-while-revalidate=600");const id=Number(req.query.tmdb_id),type=String(req.query.type||"movie");if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:"tmdb_id inválido"});if(type!=="movie"&&type!=="tv")return res.status(400).json({error:"type deve ser movie ou tv"});let data;try{const cacheKey=`watch:${type}:${id}`;const cached=providerCache.get(cacheKey);if(cached&&cached.expires>Date.now())return res.json(cached.data);data=await tmdb(`${type}/${id}/watch/providers`,{language:"pt-BR",watch_region:"BR"});}catch(primaryError){if(!TMDB_API_KEY)throw primaryError;const r=await fetchWithTimeout(tmdbUrl(`${type}/${id}/watch/providers`,{language:"pt-BR",watch_region:"BR",api_key:TMDB_API_KEY}));if(!r.ok)throw primaryError;data=await r.json()}const br=data?.results?.BR||data?.results?.["BR"]||{},groups={flatrate:br.flatrate||[],free:br.free||[],ads:br.ads||[],rent:br.rent||[],buy:br.buy||[]},seen=new Set(),providers={};for(const[k,list]of Object.entries(groups))providers[k]=list.filter(p=>{const key=String(p?.provider_id||p?.provider_name||"");if(!key||seen.has(key))return false;seen.add(key);return true}).map(p=>({...p,language_info:{audio_languages:[],subtitle_languages:[],source:null,confidence:"unknown"}}));const all=[...providers.flatrate,...providers.free,...providers.ads,...providers.rent,...providers.buy];const response={tmdb_id:id,type,country:"BR",link:isSafeHttpUrl(br.link)?br.link:null,providers,names:all.map(p=>p.provider_name).filter(Boolean)};providerCache.set(`watch:${type}:${id}`,{data:response,expires:Date.now()+600000});res.json(response)}catch(e){res.status(500).json({error:"internal_error"})}});
app.get("/api/title/:type/:id",async(req,res)=>{try{res.setHeader("Cache-Control","public, max-age=300, stale-while-revalidate=600");const ep=req.params.type==="tv"?"tv":req.params.type==="movie"?"movie":null;if(!ep||!/^\d+$/.test(req.params.id))return res.status(400).json({error:"type ou id inválido"});const[detail,credits,videos]=await Promise.all([tmdb(`${ep}/${req.params.id}`,{language:"pt-BR"}),tmdb(`${ep}/${req.params.id}/credits`,{language:"pt-BR"}),tmdb(`${ep}/${req.params.id}/videos`,{language:"pt-BR"})]);res.json({detail,credits,videos})}catch(e){res.status(500).json({error:"internal_error"})}});
app.get("/api/upcoming",async(req,res)=>{
  try{
    if(upcomingCache.data&&upcomingCache.expires>Date.now())return res.json(upcomingCache.data);
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const endDate=new Date(`${today}T12:00:00-03:00`);
    endDate.setDate(endDate.getDate()+120);
    const end=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(endDate);
    const [cinema,digital,tv]=await Promise.all([
      tmdb("discover/movie",{language:"pt-BR",region:"BR","primary_release_date.gte":today,"primary_release_date.lte":end,sort_by:"primary_release_date.asc","with_release_type":"2|3",page:1}),
      tmdb("discover/movie",{language:"pt-BR",region:"BR","primary_release_date.gte":today,"primary_release_date.lte":end,sort_by:"primary_release_date.asc","with_release_type":"4",page:1}),
      tmdb("discover/tv",{language:"pt-BR","first_air_date.gte":today,"first_air_date.lte":end,sort_by:"first_air_date.asc",page:1})
    ]);
    const merged=new Map();
    const add=(items,media_type,release_kind)=>{
      for(const x of (items||[]).slice(0,12)){
        const key=`${media_type}:${x.id}`;
        const item={...x,media_type,release_date:media_type==="tv"?x.first_air_date:x.release_date,release_kind};
        const prev=merged.get(key);
        if(!prev||release_kind==="Cinema"&&prev.release_kind!=="Cinema")merged.set(key,item);
      }
    };
    add(cinema.results,"movie","Cinema");add(digital.results,"movie","Digital");add(tv.results,"tv","Streaming");

    const base=[...merged.values()]
      .filter(x=>x.release_date)
      .sort((a,b)=>String(a.release_date).localeCompare(String(b.release_date)))
      .slice(0,24);

    const majorStudios=[
      "warner bros","warner bros. pictures","warner bros pictures","universal pictures","universal studios",
      "paramount pictures","paramount studios","sony pictures","columbia pictures","20th century studios",
      "walt disney pictures","disney studios","pixar","marvel studios","lucasfilm","dc studios",
      "legendary pictures","amazon mgm studios","metro-goldwyn-mayer","mgm","new line cinema",
      "netflix studios","apple original films","hbo films","a24","lionsgate"
    ];
    const normalizeName=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
    const scoreProject=(detail,credits)=>{
      let score=0,signals=[];
      const companies=(detail?.production_companies||[]).map(c=>normalizeName(c?.name));
      if(companies.some(name=>majorStudios.some(studio=>name===normalizeName(studio)||name.includes(normalizeName(studio))||normalizeName(studio).includes(name)))){
        score+=25;signals.push("grande estúdio");
      }
      if(detail?.belongs_to_collection?.id){score+=25;signals.push("franquia");}
      const director=(credits?.crew||[]).find(c=>String(c?.job||"").toLowerCase()==="director");
      const directorPop=Number(director?.popularity||0);
      if(directorPop>=20){score+=25;signals.push("diretor muito conhecido");}
      else if(directorPop>=8){score+=15;signals.push("diretor conhecido");}
      else if(directorPop>=3){score+=7;}
      const cast=(credits?.cast||[]).filter(c=>Number(c?.popularity)>0).sort((a,b)=>Number(b.popularity)-Number(a.popularity));
      const topCast=cast.slice(0,5).reduce((sum,c)=>sum+Number(c.popularity||0),0);
      const maxCast=Number(cast[0]?.popularity||0);
      if(maxCast>=40||topCast>=100){score+=20;signals.push("elenco de grande destaque");}
      else if(maxCast>=20||topCast>=55){score+=12;signals.push("elenco conhecido");}
      else if(maxCast>=10||topCast>=30){score+=6;}
      const pop=Number(detail?.popularity||0);
      if(pop>=50){score+=20;signals.push("alta popularidade");}
      else if(pop>=20){score+=12;signals.push("boa popularidade");}
      else if(pop>=8){score+=6;}
      if(Number(detail?.vote_count||0)>=1000)score+=5;
      return {score,signals,director:director?.name||null};
    };

    const enriched=await mapWithConcurrency(base,8,async x=>{
      let detail=x,credits={};
      try{[detail,credits]=await Promise.all([
        tmdb(`${x.media_type}/${x.id}`,{language:"pt-BR"}),
        tmdb(`${x.media_type}/${x.id}/credits`,{language:"pt-BR"})
      ]);}catch{}
      const project=scoreProject(detail,credits);
      return {...x,...detail,media_type:x.media_type,release_date:x.release_date,release_kind:x.release_kind,platform:x.release_kind,project_score:project.score,project_signals:project.signals,director:project.director};
    });

    const major=enriched
      .filter(x=>{
        const signals=x.project_signals||[];
        const strongSignal=signals.some(s=>["grande estúdio","franquia","diretor muito conhecido","diretor conhecido","elenco de grande destaque","elenco conhecido","alta popularidade","boa popularidade"].includes(s));
        return strongSignal || Number(x.project_score||0)>=20;
      })
      .sort((a,b)=>b.project_score-a.project_score||String(a.release_date).localeCompare(String(b.release_date)))
      .slice(0,9);
    const majorIds=new Set(major.map(x=>`${x.media_type}:${x.id}`));
    const discoveryPool=enriched
      .filter(x=>!majorIds.has(`${x.media_type}:${x.id}`))
      .sort((a,b)=>a.project_score-b.project_score||String(a.release_date).localeCompare(String(b.release_date))||Number(b.popularity||0)-Number(a.popularity||0));
    const discoveries=discoveryPool.slice(0,9);
    const data={results:[...major,...discoveries],major,discoveries,updated_at:new Date().toISOString(),period:{from:today,to:end},classification:{major_threshold:20,notes:"Classificação automática por sinais fortes de estúdio, franquia, diretor, elenco e popularidade; pontuação >=20 também pode elevar o projeto."}};
    upcomingCache.data=data;upcomingCache.expires=Date.now()+600000;res.setHeader("Cache-Control","public, max-age=120, stale-while-revalidate=600");
    res.json(data);
  }catch(e){console.error("upcoming:",e);res.status(500).json({error:"internal_error"})}
});

app.get("/api/recommend",async(req,res)=>{
  try{
    const mood=String(req.query.mood||"comedia");
    const time=String(req.query.time||"120");
    const genreMap={terror:"27",comedia:"35",epico:"28|12",emocionante:"18|10749",inteligente:"18|878"};
    const withGenres=genreMap[mood]||"35";
    const sources=[
      {type:"movie",path:"discover/movie",params:{language:"pt-BR",region:"BR",with_genres:withGenres,sort_by:"vote_average.desc",vote_count_gte:50,page:1}},
      {type:"tv",path:"discover/tv",params:{language:"pt-BR",with_genres:withGenres,sort_by:"vote_average.desc",vote_count_gte:20,page:1}}
    ];
    const candidates=[];
    for(const source of sources){
      try{
        const d=await tmdb(source.path,source.params);
        for(const x of (d.results||[]).slice(0,12))candidates.push({...x,media_type:source.type});
      }catch{}
    }
    const detailed=await Promise.all(candidates.slice(0,24).map(async x=>{
      try{
        const d=await tmdb(`${x.media_type}/${x.id}`,{language:"pt-BR"});
        const runtime=Number(x.media_type==="tv"?d.episode_run_time?.[0]||0:d.runtime||0);
        return {...x,...d,runtime};
      }catch{return null}
    }));
    const valid=detailed.filter(Boolean);
    const fits=valid.filter(x=>{
      const d=Number(x.runtime||0);
      if(time==="maratona")return x.media_type==="tv"||d>=180;
      const limit=Number(time);
      if(time==="120")return d>=120;
      return d>0&&d<=limit;
    });
    if(!fits.length)return res.json({title:null,criteria:{mood,time}});
    const pool=[...fits].sort((a,b)=>(Number(b.vote_average)||0)-(Number(a.vote_average)||0));
    const best=pool[0];
    res.json({id:best.id,media_type:best.media_type,title:best.title||best.name||"Sem título",desc:best.overview||"Sem sinopse disponível.",runtime:Number(best.runtime||0),rating:Number(best.vote_average||0),criteria:{mood,time}});
  }catch(e){console.error("recommend:",e);res.status(500).json({error:"internal_error"})}
});
app.get("/api/admin/content",(req,res)=>{const key=req.headers["x-admin-key"];if(!adminRateLimit(req))return res.status(429).json({error:"rate_limited"});if(!process.env.ADMIN_KEY||key!==process.env.ADMIN_KEY)return res.status(401).json({error:"unauthorized"});res.json({items:db.prepare("SELECT * FROM content ORDER BY created_at DESC").all()})});app.post("/api/admin/content",(req,res)=>{const key=req.headers["x-admin-key"];if(!adminRateLimit(req))return res.status(429).json({error:"rate_limited"});if(!process.env.ADMIN_KEY||key!==process.env.ADMIN_KEY)return res.status(401).json({error:"unauthorized"});const{tmdb_id,media_type,title,featured=0,published=1}=req.body||{};if(!title||typeof title!=="string"||title.trim().length>200||!["movie","tv"].includes(media_type))return res.status(400).json({error:"title e media_type são obrigatórios e válidos"});if(tmdb_id!=null&&(!Number.isInteger(Number(tmdb_id))||Number(tmdb_id)<=0))return res.status(400).json({error:"tmdb_id inválido"});const r=db.prepare("INSERT INTO content(tmdb_id,media_type,title,featured,published) VALUES(?,?,?,?,?)").run(tmdb_id==null?null:Number(tmdb_id),media_type,title.trim(),featured?1:0,published?1:0);discoverCache.data=null;discoverCache.expires=0;res.json({id:r.lastInsertRowid})});app.delete("/api/admin/content/:id",(req,res)=>{const key=req.headers["x-admin-key"];if(!adminRateLimit(req))return res.status(429).json({error:"rate_limited"});if(!process.env.ADMIN_KEY||key!==process.env.ADMIN_KEY)return res.status(401).json({error:"unauthorized"});db.prepare("DELETE FROM content WHERE id=?").run(req.params.id);discoverCache.data=null;discoverCache.expires=0;res.json({ok:true})});
async function mapWithConcurrency(items,limit,worker){const out=new Array(items.length),queue=items.map((_,i)=>i);async function run(){while(queue.length){const i=queue.shift();out[i]=await worker(items[i],i)}}await Promise.all(Array.from({length:Math.min(limit,items.length)},run));return out}
app.get("/api/discover",async(req,res)=>{try{if(discoverCache.data&&discoverCache.expires>Date.now())return res.json(discoverCache.data);const today=new Date().toISOString().slice(0,10),minDate=new Date(Date.now()-10368000000).toISOString().slice(0,10),sources=[{type:"movie",params:{language:"pt-BR",region:"BR",sort_by:"popularity.desc","primary_release_date.lte":today,"primary_release_date.gte":minDate,page:1},providers:[],categories:[]},{type:"tv",params:{language:"pt-BR",sort_by:"popularity.desc","first_air_date.lte":today,page:1},providers:[],categories:[]}],platformProviders=[["Netflix",8],["Prime Video",119],["Disney+",337],["HBO Max",1899],["Apple TV+",350]];for(const[name,id]of platformProviders){sources.push({type:"movie",params:{language:"pt-BR",region:"BR",watch_region:"BR",with_watch_providers:String(id),with_watch_monetization_types:"flatrate",sort_by:"popularity.desc",page:1},providers:[name],categories:[]});sources.push({type:"tv",params:{language:"pt-BR",watch_region:"BR",with_watch_providers:String(id),with_watch_monetization_types:"flatrate",sort_by:"popularity.desc",page:1},providers:[name],categories:[]})}sources.push({type:"movie",params:{language:"pt-BR",region:"BR",with_genres:"16",with_original_language:"ja",sort_by:"popularity.desc",page:1},providers:[],categories:["Anime"]},{type:"tv",params:{language:"pt-BR",with_genres:"16",with_original_language:"ja",sort_by:"popularity.desc",page:1},providers:[],categories:["Anime"]},{type:"movie",params:{language:"pt-BR",region:"BR",with_companies:"429|9993",sort_by:"popularity.desc",page:1},providers:[],categories:["DC"]},{type:"tv",params:{language:"pt-BR",with_companies:"429|9993",sort_by:"popularity.desc",page:1},providers:[],categories:["DC"]});const responses=await Promise.all(sources.map(async source=>{try{const d=await tmdb(source.type==="tv"?"discover/tv":"discover/movie",source.params);return{source,results:Array.isArray(d.results)?d.results:[]}}catch(e){console.warn("discover source:",source.type,e.message);return{source,results:[]}}})),merged=new Map;for(const{source,results}of responses)for(const item of results.slice(0,10)){const key=`${source.type}:${item.id}`,prev=merged.get(key);prev?(prev.providers=[...new Set([...(prev.providers||[]),...source.providers])],prev.categories=[...new Set([...(prev.categories||[]),...source.categories])]):merged.set(key,{...item,media_type:source.type,providers:[...source.providers],categories:[...source.categories]})}const raw=[...merged.values()].sort((a,b)=>(b.popularity||0)-(a.popularity||0)).slice(0,60),results=await mapWithConcurrency(raw,8,async x=>{const providers=x.providers?.length?x.providers:await getProviders(x.media_type,x.id),categories=[...new Set([...(x.categories||[]),...((x.production_companies||[]).some(c=>[429,9993].includes(Number(c.id)))?["DC"]:[])])];return{...x,genres:(x.genre_ids||[]).map(id=>genreNames[id]).filter(Boolean),categories,is_new:true,providers,platform:providers[0]||"Streaming"}});for(const item of db.prepare("SELECT * FROM content WHERE published=1 ORDER BY featured DESC, created_at DESC").all()){if(!item.tmdb_id){results.push({id:Number(item.id)*-1,title:item.title,media_type:item.media_type,genres:[],categories:[],providers:[],platform:"TelaFlux",is_new:false,manual:true,overview:"Título adicionado manualmente pelo TelaFlux.",vote_average:0,poster_path:null});continue}try{const type=item.media_type==="tv"?"tv":"movie",d=await tmdb(`${type}/${item.tmdb_id}`,{language:"pt-BR"}),providers=await getProviders(type,item.tmdb_id);results.push({...d,id:Number(d.id),media_type:type,genres:(d.genres||[]).map(g=>g.name).filter(Boolean),categories:[],providers,platform:providers[0]||"Streaming",manual:true})}catch(e){console.warn("manual content:",item.id,e.message)}}
    const ratingRows=db.prepare("SELECT tmdb_id,media_type,ROUND(AVG(rating),1) AS average,COUNT(*) AS votes FROM ratings GROUP BY tmdb_id,media_type").all();
    const ratingMap=new Map(ratingRows.map(r=>[`${r.media_type}:${r.tmdb_id}`,{average:Number(r.average),votes:Number(r.votes)}]));
    for(const item of results){const rr=ratingMap.get(`${item.media_type}:${item.id}`);item.user_rating=rr?.average??null;item.user_rating_votes=rr?.votes??0}
    const response={results};discoverCache.data=response;discoverCache.expires=Date.now()+300000;res.setHeader("Cache-Control","public, max-age=120, stale-while-revalidate=300");res.json(response)}catch(e){console.error("discover:",e);res.status(500).json({error:"internal_error"})}});
app.get("/{*splat}",(req,res)=>{if(req.path.startsWith("/api/"))return res.status(404).json({error:"not_found"});res.sendFile(path.join(__dirname,"index.html"))});app.listen(PORT,()=>console.log(`NEXORA em http://localhost:${PORT}`));
