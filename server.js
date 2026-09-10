import express from "express";
import cors from "cors";

const app = express();

const PORT = process.env.PORT || 3000;
const TMDB_TOKEN = process.env.TMDB_TOKEN;
const REGION = "BR";

const PROVIDER_NETFLIX = 8;
const PROVIDER_PRIME = 119;
const PROVIDER_DISNEY = 337;
const PROVIDER_MAX = 1899;
const PROVIDER_APPLE = 350;

const COMPANY_DC = 9993;
const COMPANY_MARVEL = 420;

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/discover", async (req, res) => {
  try {
    const {
      platform = "all",
      company = "all",
      type = "all",
      page = 1
    } = req.query;

    if (!TMDB_TOKEN) {
      return res.status(500).json({
        error: "TMDB_TOKEN não configurado"
      });
    }

    const headers = {
      Authorization: `Bearer ${TMDB_TOKEN}`,
      accept: "application/json"
    };

    const urls = [];

    const addUrl = (mediaType, params = "") => {
      urls.push(
        `https://api.themoviedb.org/3/discover/${mediaType}?language=pt-BR&region=${REGION}&sort_by=popularity.desc&page=${page}${params}`
      );
    };

    const providerMap = {
      Netflix: PROVIDER_NETFLIX,
      "Prime Video": PROVIDER_PRIME,
      "Disney+": PROVIDER_DISNEY,
      "HBO Max": PROVIDER_MAX,
      "Apple TV+": PROVIDER_APPLE
    };

    const companyMap = {
      DC: COMPANY_DC,
      Marvel: COMPANY_MARVEL
    };

    const provider = providerMap[platform];
    const companyId = companyMap[company];

    if (type === "movie") {
      addUrl(
        "movie",
        provider ? `&with_watch_providers=${provider}&watch_region=${REGION}` : ""
      );
    } else if (type === "tv") {
      addUrl(
        "tv",
        provider ? `&with_watch_providers=${provider}&watch_region=${REGION}` : ""
      );
    } else {
      addUrl(
        "movie",
        provider ? `&with_watch_providers=${provider}&watch_region=${REGION}` : ""
      );
      addUrl(
        "tv",
        provider ? `&with_watch_providers=${provider}&watch_region=${REGION}` : ""
      );
    }

    const responses = await Promise.all(
      urls.map(url =>
        fetch(url, { headers }).then(r => {
          if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
          return r.json();
        })
      )
    );

    let results = responses.flatMap(data => data.results || []);

    if (companyId) {
      results = results.filter(item =>
        (item.production_companies || []).some(
          companyItem => companyItem.id === companyId
        )
      );
    }

    results = results.map(item => ({
      id: item.id,
      title: item.title || item.name,
      overview: item.overview || "",
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path,
      vote_average: item.vote_average,
      release_date: item.release_date || item.first_air_date || "",
      media_type: item.media_type || (
        item.title ? "movie" : "tv"
      )
    }));

    res.json({ results });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao consultar o catálogo",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`TelaFlux API rodando na porta ${PORT}`);
});
