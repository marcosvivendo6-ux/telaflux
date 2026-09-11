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
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
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
  for (const p of [...(br?.flatrate||[]), ...(br?.free||[]), ...(br?.ads||[])]) {
    if (p?.provider_name && !names.includes(p.provider_name)) names.push(p.provider_name);
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
    res.redirect(`https://www.themoviedb.org/authenticate/${d.request_token}?redirect_to=${encodeURIComponent(APP_URL+"/api/auth/callback")}`);
  } catch(e){res.status(500).send(`<h2>Erro de login</h2><p>${e.message}</p>`)}
});
app.get("/api/auth/callback", async (req,res)=>{
  try{
    const r=await fetch("https://api.themoviedb.org/3/authentication/session/new",{method:"POST",headers:{Authorization:`Bearer ${TMDB_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({request_token:req.query.request_token})});
    const d=await r.json(); if(!d.success) throw new Error(d.status_message||"Autenticação recusada");
    const me=await tmdb("account",{session_id:d.session_id});
    const browserToken=sessionToken();
    sessions.set(browserToken,{session_id:d.session_id,account:me});
    res.send(`<script>localStorage.setItem("telaflux_session","${browserToken}");location.replace("/");</script>`);
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
    const data=await tmdb(`${type}/${id}/watch/providers`);
    const br=data?.results?.BR || {};
    res.json({
      tmdb_id:id,
      type,
      country:"BR",
      link:br.link||null,
      providers:{
        flatrate:br.flatrate||[],
        free:br.free||[],
        ads:br.ads||[],
        rent:br.rent||[],
        buy:br.buy||[]
      }
    });
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
    const [movies,tv] = await Promise.all([
      tmdb("discover/movie", {
        language:"pt-BR", region:"BR", sort_by:"popularity.desc",
        "primary_release_date.lte": today,
        "primary_release_date.gte": new Date(Date.now()-1000*60*60*24*120).toISOString().slice(0,10),
        page:1
      }),
      tmdb("discover/tv", {
        language:"pt-BR", sort_by:"popularity.desc",
        "first_air_date.lte": today,
        page:1
      })
    ]);

    const raw = [
      ...(movies.results||[]).slice(0,18).map(x=>({...x,media_type:"movie"})),
      ...(tv.results||[]).slice(0,18).map(x=>({...x,media_type:"tv"}))
    ].sort((a,b)=>(b.popularity||0)-(a.popularity||0)).slice(0,30);

    const results = await Promise.all(raw.map(async x=>{
      const providers=await getProviders(x.media_type,x.id);
      return {
        ...x,
        genres:(x.genre_ids||[]).map(id=>genreNames[id]).filter(Boolean),
        is_new:true,
        providers,
        platform:providers[0]||"Streaming"
      };
    }));

    const manual = db.prepare("SELECT * FROM content WHERE published=1 ORDER BY featured DESC, created_at DESC").all();
    for (const item of manual) {
      if (!item.tmdb_id) {
        results.push({
          id: Number(item.id) * -1,
          title: item.title,
          media_type: item.media_type,
          genres: [],
          providers: [],
          platform: "TelaFlux",
          is_new: false,
          manual: true,
          overview: "Título adicionado manualmente pelo TelaFlux.",
          vote_average: 0,
          poster_path: null
        });
        continue;
      }
      try {
        const type=item.media_type==="tv"?"tv":"movie";
        const d=await tmdb(`${type}/${item.tmdb_id}`,{language:"pt-BR"});
        const providers=await getProviders(type,item.tmdb_id);
        results.push({
          ...d,
          id:Number(d.id),
          media_type:type,
          genres:(d.genres||[]).map(g=>g.name).filter(Boolean),
          providers,
          platform:providers[0]||"Streaming",
          manual:true
        });
      } catch(e) {
        console.warn("manual content:", item.id, e.message);
      }
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
