require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const dbPath = process.env.DB_PATH || path.join(__dirname, "data", "telaflux.db");
fs.mkdirSync(path.dirname(dbPath), {recursive:true});
const db = new Database(dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS content (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 tmdb_id INTEGER,
 media_type TEXT NOT NULL,
 title TEXT NOT NULL,
 featured INTEGER DEFAULT 0,
 published INTEGER DEFAULT 1,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_TOKEN = process.env.TMDB_TOKEN;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const APP_URL = process.env.APP_URL || process.env.API_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
const FRONTEND_ORIGIN = (()=>{ try { return FRONTEND_URL ? new URL(FRONTEND_URL).origin : ""; } catch { return ""; } })();
const API_PUBLIC_URL = (process.env.API_URL || process.env.RENDER_EXTERNAL_URL || APP_URL).replace(/\/+$/, "");
const sessions = new Map();
const providerCache = new Map();
function getSession(req){
  return sessions.get(req.headers["x-telaflux-session"] || req.headers["x-cineverse-session"]);
}
function sessionToken(){
  return crypto.randomBytes(32).toString("hex");
}
function providerNames(data){
  const br = data?.results?.BR || data?.results?.["BR"];
  const names = [];
  const normalize = name => {
    const n = String(name || "").trim().toLowerCase();
    if(n === "netflix") return "Netflix";
    if(n === "amazon prime video" || n === "prime video") return "Prime Video";
    if(n === "disney plus" || n === "disney+") return "Disney+";
    if(n === "max" || n === "hbo max") return "HBO Max";
    if(n === "apple tv" || n === "apple tv+") return "Apple TV+";
    return String(name || "").trim();
  };
  for (const p of [...(br?.flatrate||[]), ...(br?.free||[]), ...(br?.ads||[])]) {
    const name = normalize(p?.provider_name);
    if(name && !names.includes(name)) names.push(name);
  }
  return names;
}
async function getProviders(type,id){
  const key = `${type}:${id}`;
  const cached = providerCache.get(key);
  if(cached && cached.expires > Date.now()) return cached.names;
  try {
    const d = await tmdb(`${type}/${id}/watch/providers`);
    const names = providerNames(d);
    providerCache.set(key,{names,expires:Date.now()+10*60*1000});
    return names;
  } catch(e) {
    return [];
  }
}

app.use((req,res,next)=>{
  const origin = req.headers.origin;
  const allowed = !FRONTEND_ORIGIN || origin === FRONTEND_ORIGIN || /^https?:\/\/localhost(?::\d+)?$/.test(origin || "");
  if(allowed){
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary","Origin");
    res.setHeader("Access-Control-Allow-Headers","Content-Type, Accept, X-Telaflux-Session, X-Cineverse-Session, X-Admin-Key");
    res.setHeader("Access-Control-Allow-Methods","GET,POST,DELETE,OPTIONS");
  }
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({limit:"100kb"}));
app.use(express.static(__dirname));

function tmdbUrl(endpoint, params={}) {
  const qs = new URLSearchParams(params).toString();
  return `https://api.themoviedb.org/3/${endpoint}${qs ? "?" + qs : ""}`;
}

async function tmdb(endpoint, params={}) {
  if (!TMDB_TOKEN) throw new Error("TMDB_TOKEN não configurado");
  const r = await fetch(tmdbUrl(endpoint, params), {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}`, accept: "application/json" }
  });
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

const genreNames = {
  28:"Ação",12:"Aventura",16:"Animação",35:"Comédia",80:"Crime",
 99:"Documentário",18:"Drama",14:"Fantasia",27:"Terror",10749:"Romance",
878:"Ficção",53:"Suspense",10751:"Família",9648:"Mistério"
};


app.get("/api/auth/start", async (req,res)=>{
  try {
    if(!TMDB_TOKEN) throw new Error("TMDB_TOKEN não configurado");
    const r=await fetch("https://api.themoviedb.org/3/authentication/token/new",{headers:{Authorization:`Bearer ${TMDB_TOKEN}`}});
    const d=await r.json(); if(!d.success) throw new Error(d.status_message||"Falha");
    res.redirect(`https://www.themoviedb.org/authenticate/${d.request_token}?redirect_to=${encodeURIComponent(API_PUBLIC_URL+"/api/auth/callback")}`);
  } catch(e){res.status(500).send(`<h2>Erro de login</h2><p>${e.message}</p>`)}
});
app.get("/api/auth/callback", async (req,res)=>{
  try{
    const r=await fetch("https://api.themoviedb.org/3/authentication/session/new",{method:"POST",headers:{Authorization:`Bearer ${TMDB_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({request_token:req.query.request_token})});
    const d=await r.json(); if(!d.success) throw new Error(d.status_message||"Autenticação recusada");
    const me=await tmdb("account",{session_id:d.session_id});
    const browserToken=sessionToken();
    sessions.set(browserToken,{session_id:d.session_id,account:me});
    const target = FRONTEND_URL || API_PUBLIC_URL;
    res.redirect(`${target}/?telaflux_session=${encodeURIComponent(browserToken)}`);
  }catch(e){res.status(500).send(`<h2>Não foi possível concluir o login</h2><p>${e.message}</p><a href="/">Voltar</a>`)}
});
app.get("/api/me",async(req,res)=>{
 const s=getSession(req); if(!s)return res.status(401).json({authenticated:false});
 res.json({authenticated:true,account:s.account});
});
app.post("/api/logout",(req,res)=>{const token=req.headers["x-telaflux-session"]||req.headers["x-cineverse-session"];sessions.delete(token);res.json({ok:true})});
app.get("/api/watchlist",async(req,res)=>{
 const s=getSession(req); if(!s)return res.status(401).json({error:"login_required"});
 try{
  const [m,t]=await Promise.all([
   tmdb(`account/${s.account.id}/watchlist/movies`,{session_id:s.session_id,language:"pt-BR",sort_by:"created_at.desc"}),
   tmdb(`account/${s.account.id}/watchlist/tv`,{session_id:s.session_id,language:"pt-BR",sort_by:"created_at.desc"})
  ]);
  res.json({movies:m.results||[],tv:t.results||[]});
 }catch(e){res.status(500).json({error:e.message})}
});
app.post("/api/watchlist",async(req,res)=>{
 const s=getSession(req); if(!s)return res.status(401).json({error:"login_required"});
 try{
  const {media_id,media_type,watchlist}=req.body||{};
  if(!Number.isInteger(Number(media_id)) || !["movie","tv"].includes(media_type) || typeof watchlist!=="boolean")
    return res.status(400).json({error:"media_id, media_type e watchlist inválidos"});
  const r=await fetch(`https://api.themoviedb.org/3/account/${s.account.id}/watchlist?session_id=${encodeURIComponent(s.session_id)}`,{
   method:"POST",headers:{Authorization:`Bearer ${TMDB_TOKEN}`,"Content-Type":"application/json"},
   body:JSON.stringify(req.body)
  }); res.status(r.status).json(await r.json());
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/health",(req,res)=>res.json({ok:true}));

app.get("/api/watch",async(req,res)=>{
  try{
    const id=Number(req.query.tmdb_id);
    const type=String(req.query.type||"movie");
    if(!Number.isInteger(id)||id<=0) return res.status(400).json({error:"tmdb_id inválido"});
    if(type!=="movie" && type!=="tv") return res.status(400).json({error:"type deve ser movie ou tv"});

    // O endpoint de watch providers retorna os dados por país.
    // Pedimos explicitamente BR e pt-BR para evitar depender do padrão da conta.
    let data;
    try {
      data=await tmdb(`${type}/${id}/watch/providers`,{language:"pt-BR",watch_region:"BR"});
    } catch(primaryError) {
      // Compatibilidade: algumas configurações antigas usam TMDB_API_KEY.
      if(!TMDB_API_KEY) throw primaryError;
      const u=tmdbUrl(`${type}/${id}/watch/providers`,{language:"pt-BR",watch_region:"BR",api_key:TMDB_API_KEY});
      const r=await fetch(u);
      if(!r.ok) throw primaryError;
      data=await r.json();
    }
    const br=data?.results?.BR || data?.results?.["BR"] || {};
    const groups={
      flatrate:Array.isArray(br.flatrate)?br.flatrate:[],
      free:Array.isArray(br.free)?br.free:[],
      ads:Array.isArray(br.ads)?br.ads:[],
      rent:Array.isArray(br.rent)?br.rent:[],
      buy:Array.isArray(br.buy)?br.buy:[]
    };
    const seen=new Set();
    const providers={};
    for(const [kind,list] of Object.entries(groups)){
      providers[kind]=list.filter(p=>{
        const key=String(p?.provider_id||p?.provider_name||"");
        if(!key||seen.has(key)) return false;
        seen.add(key); return true;
      }).map(p=>({
        ...p,
        // Preparado para futuras fontes de idiomas (ex.: JustWatch).
        // Nunca inferimos dublado/legendado a partir do idioma original.
        language_info:{
          audio_languages:[],
          subtitle_languages:[],
          source:null,
          confidence:"unknown"
        }
      }));
    }
    const all=[...providers.flatrate,...providers.free,...providers.ads,...providers.rent,...providers.buy];
    res.json({tmdb_id:id,type,country:"BR",link:br.link||null,providers,
      names:all.map(p=>p.provider_name).filter(Boolean)});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/title/:type/:id",async(req,res)=>{
 try{
  const ep=req.params.type==="tv"?"tv":req.params.type==="movie"?"movie":null;
  if(!ep || !/^\d+$/.test(req.params.id)) return res.status(400).json({error:"type ou id inválido"});
  const [detail,credits,videos]=await Promise.all([
   tmdb(`${ep}/${req.params.id}`,{language:"pt-BR"}),tmdb(`${ep}/${req.params.id}/credits`,{language:"pt-BR"}),tmdb(`${ep}/${req.params.id}/videos`,{language:"pt-BR"})
  ]);
  res.json({detail,credits,videos});
 }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/admin/content", (req,res)=>{
  const key=req.headers["x-admin-key"];
  if(!process.env.ADMIN_KEY || key!==process.env.ADMIN_KEY) return res.status(401).json({error:"unauthorized"});
  res.json({items:db.prepare("SELECT * FROM content ORDER BY created_at DESC").all()});
});
app.post("/api/admin/content", (req,res)=>{
  const key=req.headers["x-admin-key"];
  if(!process.env.ADMIN_KEY || key!==process.env.ADMIN_KEY) return res.status(401).json({error:"unauthorized"});
  const {tmdb_id,media_type,title,featured=0,published=1}=req.body||{};
  if(!title || typeof title!=="string" || title.trim().length>200 || !["movie","tv"].includes(media_type))
    return res.status(400).json({error:"title e media_type são obrigatórios e válidos"});
  if(tmdb_id!=null && (!Number.isInteger(Number(tmdb_id)) || Number(tmdb_id)<=0))
    return res.status(400).json({error:"tmdb_id inválido"});
  const r=db.prepare("INSERT INTO content(tmdb_id,media_type,title,featured,published) VALUES(?,?,?,?,?)")
    .run(tmdb_id==null?null:Number(tmdb_id),media_type,title.trim(),featured?1:0,published?1:0);
  res.json({id:r.lastInsertRowid});
});
app.delete("/api/admin/content/:id",(req,res)=>{
  const key=req.headers["x-admin-key"];
  if(!process.env.ADMIN_KEY || key!==process.env.ADMIN_KEY) return res.status(401).json({error:"unauthorized"});
  db.prepare("DELETE FROM content WHERE id=?").run(req.params.id); res.json({ok:true});
});

app.get("/api/discover", async (req,res)=>{
  try {
    const today = new Date().toISOString().slice(0,10);
    const minDate = new Date(Date.now()-1000*60*60*24*120).toISOString().slice(0,10);

    // Montamos um catálogo equilibrado: catálogo geral + cada plataforma + Anime + DC.
    // Assim os filtros não dependem de os poucos 30 primeiros resultados do TMDB
    // conterem títulos de uma categoria específica.
    const sources = [
      {type:"movie", params:{language:"pt-BR",region:"BR",sort_by:"popularity.desc","primary_release_date.lte":today,"primary_release_date.gte":minDate,page:1}, providers:[], categories:[]},
      {type:"tv", params:{language:"pt-BR",sort_by:"popularity.desc","first_air_date.lte":today,page:1}, providers:[], categories:[]}
    ];

    const platformProviders = [
      ["Netflix",8], ["Prime Video",119], ["Disney+",337], ["HBO Max",1899], ["Apple TV+",350]
    ];
    for (const [name,id] of platformProviders) {
      sources.push({type:"movie",params:{language:"pt-BR",region:"BR",watch_region:"BR",with_watch_providers:String(id),with_watch_monetization_types:"flatrate",sort_by:"popularity.desc",page:1},providers:[name],categories:[]});
      sources.push({type:"tv",params:{language:"pt-BR",watch_region:"BR",with_watch_providers:String(id),with_watch_monetization_types:"flatrate",sort_by:"popularity.desc",page:1},providers:[name],categories:[]});
    }

    sources.push({type:"movie",params:{language:"pt-BR",region:"BR",with_genres:"16",with_original_language:"ja",sort_by:"popularity.desc",page:1},providers:[],categories:["Anime"]});
    sources.push({type:"tv",params:{language:"pt-BR",with_genres:"16",with_original_language:"ja",sort_by:"popularity.desc",page:1},providers:[],categories:["Anime"]});
    sources.push({type:"movie",params:{language:"pt-BR",region:"BR",with_companies:"429|9993",sort_by:"popularity.desc",page:1},providers:[],categories:["DC"]});
    sources.push({type:"tv",params:{language:"pt-BR",with_companies:"429|9993",sort_by:"popularity.desc",page:1},providers:[],categories:["DC"]});

    const responses = await Promise.all(sources.map(async source=>{
      try {
        const d = await tmdb(source.type === "tv" ? "discover/tv" : "discover/movie", source.params);
        return {source, results:Array.isArray(d.results)?d.results:[]};
      } catch(e) {
        console.warn("discover source:", source.type, e.message);
        return {source, results:[]};
      }
    }));

    const merged = new Map();
    for (const {source,results} of responses) {
      for (const item of results.slice(0,10)) {
        const key = `${source.type}:${item.id}`;
        const prev = merged.get(key);
        if (prev) {
          prev.providers = [...new Set([...(prev.providers||[]), ...source.providers])];
          prev.categories = [...new Set([...(prev.categories||[]), ...source.categories])];
        } else {
          merged.set(key, {
            ...item,
            media_type:source.type,
            providers:[...source.providers],
            categories:[...source.categories]
          });
        }
      }
    }

    let raw = [...merged.values()]
      .sort((a,b)=>(b.popularity||0)-(a.popularity||0))
      .slice(0,60);

    const results = await Promise.all(raw.map(async x=>{
      // Para itens do catálogo geral, buscamos os provedores reais. Itens que já
      // vieram de uma plataforma específica carregam essa informação diretamente,
      // evitando dezenas de chamadas extras ao TMDB.
      const providers = x.providers?.length ? x.providers : await getProviders(x.media_type,x.id);
      const categories = [...new Set([
        ...(x.categories||[]),
                ...((x.production_companies||[]).some(c=>[429,9993].includes(Number(c.id))) ? ["DC"] : [])
      ])];
      return {
        ...x,
        genres:(x.genre_ids||[]).map(id=>genreNames[id]).filter(Boolean),
        categories,
        is_new:true,
        providers,
        platform:providers[0]||"Streaming"
      };
    }));

    const manual = db.prepare("SELECT * FROM content WHERE published=1 ORDER BY featured DESC, created_at DESC").all();
    for (const item of manual) {
      if (!item.tmdb_id) {
        results.push({id:Number(item.id)*-1,title:item.title,media_type:item.media_type,genres:[],categories:[],providers:[],platform:"TelaFlux",is_new:false,manual:true,overview:"Título adicionado manualmente pelo TelaFlux.",vote_average:0,poster_path:null});
        continue;
      }
      try {
        const type=item.media_type==="tv"?"tv":"movie";
        const d=await tmdb(`${type}/${item.tmdb_id}`,{language:"pt-BR"});
        const providers=await getProviders(type,item.tmdb_id);
        const categories=[];
        results.push({...d,id:Number(d.id),media_type:type,genres:(d.genres||[]).map(g=>g.name).filter(Boolean),categories,providers,platform:providers[0]||"Streaming",manual:true});
      } catch(e) { console.warn("manual content:", item.id, e.message); }
    }
    res.json({results});
  } catch(e) {
    console.error("discover:",e);
    res.status(500).json({error:e.message});
  }
});
app.get("/{*splat}",(req,res)=>{
  if(req.path.startsWith("/api/")) return res.status(404).json({error:"not_found"});
  res.sendFile(path.join(__dirname,"index.html"));
});
app.listen(PORT,()=>console.log(`TelaFlux em http://localhost:${PORT}`));
