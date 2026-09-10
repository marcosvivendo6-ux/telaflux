# Publicação

O projeto já está preparado para deploy em um serviço Node.js (Render, Railway, Fly.io ou VPS).

Variáveis:
- TMDB_TOKEN
- APP_URL
- ADMIN_KEY
- DB_PATH

Comandos:
npm install
npm start

Admin:
https://SEU-DOMINIO/admin.html

Para produção, use HTTPS e armazenamento persistente para o SQLite. Em hospedagens efêmeras, troque SQLite por Postgres/Supabase.

O TMDB usa Bearer Token para autenticação da aplicação e sessões para recursos do usuário. Consulte a documentação oficial antes de publicar.
