require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const REGION = "BR";

// --------------------------------------------------
// Configuração básica
// --------------------------------------------------

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());

const cache = new Map();
const CACHE_TIME = 30 * 60 * 1000; // 30 minutos

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() - item.time > CACHE_TIME) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data) {
  cache.set(key, {
    time: Date.now(),
    data
  });
}

async function tmdb(endpoint, params = {}) {
  if (!TMDB_API_KEY) {
    throw new Error("TMDB_API_KEY não configurada.");
  }

  const url = new URL(`${TMDB_BASE_URL}${endpoint}`);

  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "pt-BR");

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TMDB ${response.status}: ${body}`);
  }

  return response.json();
}

function image(path) {
  return path ? `${TMDB_IMAGE_BASE}${path}` : null;
}

function normalizeMovie(item) {
  return {
    id: item.id,
    title: item.title || item.name || "Sem título",
    type: "movie",
    date: item.release_date || null,
    rating: Number(item.vote_average || 0),
    genres: item.genre_ids || [],
    desc: item.overview || "Sem descrição disponível.",
    img: image(item.poster_path),
    backdrop: image(item.backdrop_path),
    platform: item.platform || null
  };
}

function normalizeTV(item) {
  return {
    id: item.id,
    title: item.name || item.title || "Sem título",
    type: "tv",
    date: item.first_air_date || null,
    rating: Number(item.vote_average || 0),
    genres: item.genre_ids || [],
    desc: item.overview || "Sem descrição disponível.",
    img: image(item.poster_path),
    backdrop: image(item.backdrop_path),
    platform: item.platform || null
  };
}

// IDs de provedores do TMDB usados no Brasil.
// Podem ser ajustados futuramente sem alterar o restante da API.
const PROVIDERS = {
  netflix: 8,
  "prime video": 119,
  prime: 119,
  "disney+": 337,
  disney: 337,
  max: 1899,
  "hbo max": 1899,
  "apple tv+": 350,
  "apple tv": 350
};

// --------------------------------------------------
// Saúde da API
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "NEXXORA API funcionando",
    version: "1.0.0"
  });
});

// --------------------------------------------------
// Catálogo principal
// GET /api/discover
// Exemplos:
// /api/discover
// /api/discover?type=movie
// /api/discover?platform=Netflix
// /api/discover?platform=Marvel
// /api/discover?platform=Animes
// --------------------------------------------------

app.get("/api/discover", async (req, res) => {
  try {
    const {
      platform = "",
      type = "all",
      genre = "",
      page = 1
    } = req.query;

    const cacheKey = `discover:${platform}:${type}:${genre}:${page}`;
    const cached = getCache(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const requestedType = String(type).toLowerCase();

    const results = [];

    const addMovies = async () => {
      const params = {
        region: REGION,
        sort_by: "popularity.desc",
        page,
        include_adult: false
      };

      if (genre) params.with_genres = genre;

      if (PROVIDERS[String(platform).toLowerCase()]) {
        params.with_watch_providers =
          PROVIDERS[String(platform).toLowerCase()];
        params.watch_region = REGION;
      }

      const data = await tmdb("/discover/movie", params);
      results.push(...(data.results || []).map(normalizeMovie));
    };

    const addTV = async () => {
      const params = {
        watch_region: REGION,
        sort_by: "popularity.desc",
        page,
        include_adult: false
      };

      if (genre) params.with_genres = genre;

      if (PROVIDERS[String(platform).toLowerCase()]) {
        params.with_watch_providers =
          PROVIDERS[String(platform).toLowerCase()];
      }

      const data = await tmdb("/discover/tv", params);
      results.push(...(data.results || []).map(normalizeTV));
    };

    if (requestedType === "movie") {
      await addMovies();
    } else if (requestedType === "tv" || requestedType === "series") {
      await addTV();
    } else {
      await Promise.all([addMovies(), addTV()]);
    }

    // Filtros especiais que não são provedores de streaming.
    // Marvel e DC usam IDs de empresas do TMDB.
    // Anime usa gênero/animação como aproximação inicial.
    const special = String(platform).toLowerCase();

    if (special === "marvel" || special === "dc") {
      const company =
        special === "marvel" ? 420 : 9993;

      const companyData = await tmdb("/discover/movie", {
        with_companies: company,
        region: REGION,
        sort_by: "popularity.desc",
        page
      });

      const specialResults =
        (companyData.results || []).map(normalizeMovie);

      results.length = 0;
      results.push(...specialResults);
    }

    if (special === "animes") {
      const animeData = await tmdb("/discover/tv", {
        with_genres: 16,
        sort_by: "popularity.desc",
        page
      });

      results.length = 0;
      results.push(...(animeData.results || []).map(normalizeTV));
    }

    const unique = Array.from(
      new Map(results.map(item => [`${item.type}-${item.id}`, item])).values()
    );

    const response = {
      page: Number(page),
      results: unique
    };

    setCache(cacheKey, response);
    res.json(response);

  } catch (error) {
    console.error("Erro em /api/discover:", error.message);

    res.status(500).json({
      error: "Não foi possível carregar o catálogo.",
      details: error.message
    });
  }
});

// --------------------------------------------------
// Filmes que chegam aos cinemas neste mês
// GET /api/cinema-month
// --------------------------------------------------

app.get("/api/cinema-month", async (req, res) => {
  try {
    const now = new Date();

    const year = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        year: "numeric"
      }).format(now)
    );

    const month = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        month: "2-digit"
      }).format(now)
    );

    const key = `cinema-month:${year}-${String(month).padStart(2, "0")}`;
    const cached = getCache(key);

    if (cached) {
      return res.json(cached);
    }

    const firstDay = `${year}-${String(month).padStart(2, "0")}-01`;

    const lastDayNumber = new Date(year, month, 0).getDate();
    const lastDay =
      `${year}-${String(month).padStart(2, "0")}-${String(lastDayNumber).padStart(2, "0")}`;

    const pages = await Promise.all([
      tmdb("/discover/movie", {
        region: REGION,
        with_release_type: "2|3",
        "release_date.gte": firstDay,
        "release_date.lte": lastDay,
        sort_by: "primary_release_date.asc",
        page: 1
      }),
      tmdb("/discover/movie", {
        region: REGION,
        with_release_type: "2|3",
        "release_date.gte": firstDay,
        "release_date.lte": lastDay,
        sort_by: "popularity.desc",
        page: 2
      })
    ]);

    const movies = [];

    for (const pageData of pages) {
      for (const item of pageData.results || []) {
        movies.push({
          ...normalizeMovie(item),
          releaseDate: item.release_date || null,
          cinema: true
        });
      }
    }

    const unique = Array.from(
      new Map(movies.map(item => [item.id, item])).values()
    ).sort((a, b) =>
      String(a.releaseDate || "").localeCompare(String(b.releaseDate || ""))
    );

    const response = {
      month: `${year}-${String(month).padStart(2, "0")}`,
      results: unique
    };

    setCache(key, response);
    res.json(response);

  } catch (error) {
    console.error("Erro em /api/cinema-month:", error.message);

    res.status(500).json({
      error: "Não foi possível carregar as estreias do cinema.",
      details: error.message
    });
  }
});

// --------------------------------------------------
// Conteúdo de streaming em destaque/chegando
// GET /api/streaming
// GET /api/streaming?platform=Netflix
// --------------------------------------------------

app.get("/api/streaming", async (req, res) => {
  try {
    const platform = String(req.query.platform || "").trim();
    const provider = PROVIDERS[platform.toLowerCase()];
    const cacheKey = `streaming:${platform}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const now = new Date();
    const start = now.toISOString().slice(0, 10);
    const future = new Date(now);
    future.setMonth(future.getMonth() + 3);
    const end = future.toISOString().slice(0, 10);

    const movieParams = {
      region: REGION,
      include_adult: false,
      sort_by: "popularity.desc",
      "release_date.gte": start,
      "release_date.lte": end,
      with_release_type: "4|6",
      page: 1
    };
    if (provider) {
      movieParams.with_watch_providers = provider;
      movieParams.watch_region = REGION;
    }

    const tvParams = {
      watch_region: REGION,
      include_adult: false,
      sort_by: "popularity.desc",
      "first_air_date.gte": start,
      "first_air_date.lte": end,
      page: 1
    };
    if (provider) tvParams.with_watch_providers = provider;

    const [movies, tv] = await Promise.all([
      tmdb("/discover/movie", movieParams),
      tmdb("/discover/tv", tvParams)
    ]);

    const results = [
      ...(movies.results || []).map(item => ({...normalizeMovie(item), platform: platform || null})),
      ...(tv.results || []).map(item => ({...normalizeTV(item), platform: platform || null}))
    ].sort((a,b) => String(a.date || "").localeCompare(String(b.date || "")));

    const response = { results };
    setCache(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error("Erro em /api/streaming:", error.message);
    res.status(500).json({ error: "Não foi possível carregar os lançamentos de streaming.", details: error.message });
  }
});

// --------------------------------------------------
// Detalhes de filme ou série
// GET /api/title/movie/123
// GET /api/title/tv/123
// --------------------------------------------------

app.get("/api/title/:type/:id", async (req, res) => {
  try {
    const type = req.params.type === "tv" ? "tv" : "movie";
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: "ID inválido."
      });
    }

    const cacheKey = `title:${type}:${id}`;
    const cached = getCache(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const data = await tmdb(`/${type}/${id}`, {
      append_to_response: "credits,videos,watch/providers"
    });

    const response = {
      ...data,
      poster_url: image(data.poster_path),
      backdrop_url: image(data.backdrop_path)
    };

    setCache(cacheKey, response);
    res.json(response);

  } catch (error) {
    console.error("Erro em /api/title:", error.message);

    res.status(500).json({
      error: "Não foi possível carregar os detalhes.",
      details: error.message
    });
  }
});

// --------------------------------------------------
// Onde assistir
//
// Aceita:
// /api/watch?type=movie&id=123
// /api/watch?type=tv&id=123
//
// Também:
// /api/watch/movie/123
// /api/watch/tv/123
// --------------------------------------------------

async function watchHandler(req, res) {
  try {
    const type =
      req.params.type ||
      req.query.type ||
      "movie";

    const id = Number(
      req.params.id ||
      req.query.id
    );

    if (!["movie", "tv"].includes(type)) {
      return res.status(400).json({
        error: "Tipo inválido. Use movie ou tv."
      });
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: "ID inválido."
      });
    }

    const cacheKey = `watch:${type}:${id}`;
    const cached = getCache(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const data = await tmdb(`/${type}/${id}/watch/providers`);

    const brazil = data.results?.BR || {
      link: null
    };

    const response = {
      id,
      type,
      region: "BR",
      link: brazil.link || null,
      flatrate: brazil.flatrate || [],
      rent: brazil.rent || [],
      buy: brazil.buy || [],
      free: brazil.free || [],
      ads: brazil.ads || []
    };

    setCache(cacheKey, response);
    res.json(response);

  } catch (error) {
    console.error("Erro em /api/watch:", error.message);

    res.status(500).json({
      error: "Não foi possível consultar onde assistir.",
      details: error.message
    });
  }
}

app.get("/api/watch", watchHandler);
app.get("/api/watch/:type/:id", watchHandler);

// --------------------------------------------------
// Busca
// GET /api/search?q=batman
// --------------------------------------------------

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.status(400).json({
        error: "Informe um termo de busca."
      });
    }

    const page = Number(req.query.page || 1);
    const cacheKey = `search:${q}:${page}`;

    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const data = await tmdb("/search/multi", {
      query: q,
      page,
      include_adult: false,
      region: REGION
    });

    const results = (data.results || [])
      .filter(item => item.media_type === "movie" || item.media_type === "tv")
      .map(item =>
        item.media_type === "movie"
          ? normalizeMovie(item)
          : normalizeTV(item)
      );

    const response = {
      page: data.page || page,
      total_results: data.total_results || results.length,
      results
    };

    setCache(cacheKey, response);
    res.json(response);

  } catch (error) {
    console.error("Erro em /api/search:", error.message);

    res.status(500).json({
      error: "Não foi possível realizar a busca.",
      details: error.message
    });
  }
});

// --------------------------------------------------
// Limpeza automática simples do cache
// --------------------------------------------------

setInterval(() => {
  const now = Date.now();

  for (const [key, item] of cache.entries()) {
    if (now - item.time > CACHE_TIME) {
      cache.delete(key);
    }
  }
}, 10 * 60 * 1000);

// --------------------------------------------------
// Início
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`NEXXORA API rodando na porta ${PORT}`);
});
