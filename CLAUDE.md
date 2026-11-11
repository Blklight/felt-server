# felt-server

Servidor do `felt` (cartas com amigos, créditos fictícios). Cloudflare Workers + Durable Objects com SQLite. O front é o `felt-web` (repo separado).

Leia antes de mudar o protocolo ou o `view`: `docs/api-guide.md` (o contrato com a UI) e o plano do projeto (`felt-plano.md`, seções 0 a 3).

## Stack

TypeScript estrito, Bun, Biome, Hono (rotas no Worker), zod (validação de toda mensagem), Vitest com `@cloudflare/vitest-pool-workers` (os testes rodam no runtime de verdade, com Durable Objects e SQLite).

## Comandos

- `bun run dev` — `wrangler dev` (Worker, Durable Objects e SQLite locais)
- `bun run typecheck` — `tsc --noEmit`
- `bun run lint` — `biome check`
- `bun run test` — Vitest no runtime do Workers
- `bun run deploy` — `wrangler deploy`

Sempre rode typecheck, lint e testes antes de dizer que terminou.

## Estrutura

- `src/index.ts` — Worker: rotas, CORS, checagem de `Origin` e encaminhamento do WebSocket para a `Table`.
- `src/protocol.ts` — tipos e schemas zod das mensagens (fonte da verdade; o front copia).
- `src/durable/Table.ts` — uma por sala (`idFromName(código)`): sockets, estado, alarmes.
- `src/durable/Account.ts` — uma por jogador (`idFromName(sha256(token))`): saldo, ledger, histórico.
- `src/engine/` — motor dos jogos (a criar no M2).

## Regras

- TypeScript estrito. Sem `any`.
- **O servidor é a autoridade.** Embaralha, distribui, valida e manda a cada jogador só o que ele pode ver.
- **`src/engine/` é puro:** sem rede, sem `Date`, sem `Math.random`. O RNG entra por parâmetro; o de produção usa `crypto.getRandomValues`.
- **Nunca enviar cartas fechadas de um jogador a outro.** Qualquer mudança no `view` precisa do teste de vazamento.
- **Memória é cache.** O snapshot da mesa é salvo a cada ação (um upsert). Prazos usam alarmes (`ctx.storage.setAlarm`), nunca `setTimeout`.
- WebSocket com hibernação (`ctx.acceptWebSocket`) e `setWebSocketAutoResponse` para `ping`/`pong`.
- Buy-in, cash-out e recarga têm chave de idempotência (`ref` única no ledger).
- Validação com zod em toda mensagem; limite de tamanho (`MAX_MESSAGE_BYTES`) e de frequência por conexão (20 msg/s).
- Nunca logar token. Nenhum dado pessoal além de nome e avatar.
- Não adicionar dependências sem avisar.
- Um marco por vez. Ao terminar, listar o que foi feito e o que ficou de fora.

## Marcos

M0 (feito): esqueleto, WebSocket de eco passando pela `Table`, CI. Próximos: M2 (motor de blackjack), M3 (contas), M4 (blackjack jogável), M5 (multiplayer), M6+ (poker). Ver `docs/api-guide.md`, seção 1, para a ordem que liga cada parte no front.
