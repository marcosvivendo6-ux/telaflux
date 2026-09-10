import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_TOKEN = process.env.TMDB_TOKEN;

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/discover", async (req, res) => {
  try {
    if (!TMDB_TOKEN) {
      return res.status(500).json({
        error: "TMDB_TOKEN não configurado"
      });
    }

    const headers = {
      Authorization: `Bearer ${TMDB_TOKEN}`,
      accept: "application/json"
    };

    const [moviesResponse, tvResponse] = await Promise.all([
      fetch(
        "https://api.themoviedb.org/3/discover/movie?language=pt-BR&sort_by=primary_release_date.desc&page=1",
        { headers }
      ),
      fetch(
        "https://api.themoviedb.org/3/discover/tv?language=pt-BR&sort_by=first_air_date.desc&page=1",
        { headers }
      )
    ]);

    if (!moviesResponse.ok || !tvResponse.ok) {
      throw new Error("Erro ao consultar o TMDB");
    }

    const movies = await moviesResponse.json();
    const tv = await tvResponse.json();

    const results = [
      ...(movies.results || []).slice(0, 20).map(movie => ({
        id: movie.id,
        title: movie.title,
        media_type: "movie",
        release_date: movie.release_date,
        platform: "Filmes",
        genres: [],
        vote_average: movie.vote_average,
        overview: movie.overview,
        poster_path: movie.poster_path,
        is_new: true
      })),

      ...(tv.results || []).slice(0, 20).map(show => ({
        id: show.id,
        title: show.name,
        media_type: "tv",
        first_air_date: show.first_air_date,
        platform: "Séries",
        genres: [],
        vote_average: show.vote_average,
        overview: show.overview,
        poster_path: show.poster_path,
        is_new: true
      }))
    ];

    res.json({ results });

  } catch (error) {
    console.error(error);

    res.status(502).json({
      error: "Falha ao consultar o catálogo"
    });
  }
});

app.listen(PORT, () => {
  console.log(`TelaFlux API funcionando na porta ${PORT}`);
});
