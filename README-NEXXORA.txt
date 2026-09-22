# NEXXORA — pacote final revisado

Arquivos:
- index.html — página inicial
- detalhes.html — detalhes de filmes e séries
- cinema.html — estreias cinematográficas
- streaming.html — lançamentos/destaques de streaming com filtro de plataforma
- buscar.html — pesquisa
- minha-lista.html — lista local do usuário
- server.js — API
- package.json — dependências do backend

Backend: defina `TMDB_API_KEY` no ambiente do serviço. O frontend aponta para `https://telaflux-api.onrender.com/api` até a troca final do backend.

Revisões aplicadas:
- home e streaming usam `/api/streaming` em vez de tratar catálogo popular como lançamento futuro;
- corrigida a compatibilidade da Minha Lista com o campo de pôster;
- links da Minha Lista abrem detalhes;
- adicionada atribuição TMDB nas páginas;
- mantido o projeto sem hospedagem de filmes/séries.

Antes da publicação pública/comercial, mantenha as atribuições exigidas pela TMDB e, quando houver dados de provedores, a atribuição exigida pelo JustWatch.

Nenhuma alteração foi feita no GitHub ou Render durante esta revisão.
