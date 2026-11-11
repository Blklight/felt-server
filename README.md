# felt-server

Servidor do [felt](https://felt.blklight.dev): cartas com amigos (blackjack e poker), com créditos fictícios. Sem dinheiro real, sem prêmios, sem anúncios.

Cloudflare Workers + Durable Objects (SQLite), Hono e zod. O front fica em [Blklight/felt-web](https://github.com/Blklight/felt-web).

## Rodando

```bash
bun install
bun run dev
```

O Worker sobe em `http://localhost:8787`:

- `GET /health`
- `GET /v1/rooms/:code/ws` — WebSocket da sala (código de 5 letras, sem `0/O/1/I`)

## Contrato com o front

`docs/api-guide.md`. Próximos passos em `docs/roadmap.md`.

## Licença

MIT.
