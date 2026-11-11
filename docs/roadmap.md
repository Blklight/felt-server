# felt-server — próximos passos

Ordem de implementação. Cada passo liga uma parte do front (`felt-web`). Contrato em `docs/api-guide.md`; a numeração segue a seção 1 do guia.

## Feito

- [x] **M0** — esqueleto: Worker (Hono), Durable Objects `Table` e `Account` (SQLite), `GET /health`, WebSocket da sala com eco, ping/pong por auto-resposta, checagem de `Origin`, CI (typecheck, lint, testes).

## 1. Contas

- [ ] `POST /v1/accounts` (`{ name?, avatarId? }` → `{ playerId, token, profile }`); token de 32 bytes base64url, guardar só o SHA-256.
- [ ] `GET /v1/me` com recarga diária idempotente: `min(balance + 2500, 5000)` uma vez por dia UTC, ledger `reason: "refill"`, `ref: refill:<dia>`.
- [ ] `PATCH /v1/me` (`name`, `avatarId`, `skinId`, `backId`) com validação zod igual à da UI.
- [ ] `DELETE /v1/me` apaga conta, ledger e histórico.
- [ ] Middleware de Bearer: `401` = conta inválida (sem refresh).
- [ ] Testes: criação, recarga (abaixo/acima de 5.000, mesmo dia duas vezes), validação, apagar.

## 2. Salas

- [ ] `POST /v1/rooms` (`{ game, config }` → `{ code }`), código de 5 caracteres sem `0/O/1/I`, sem colisão.
- [ ] `GET /v1/rooms/:code` (`{ code, game, seats, taken }`); `ROOM_NOT_FOUND`, `ROOM_FULL`.
- [ ] `config` por jogo: blinds do poker, `capToShortestStack`, `boardSkin: "creator" | "draw"`.
- [ ] Rota do WebSocket devolve `ROOM_NOT_FOUND` só para sala que não existe (hoje vale só o formato do código).

## 3. WebSocket base

- [ ] `hello` (token, versão do protocolo) → `welcome` + primeiro `view` em `phase: "waiting"`.
- [ ] Um `view` por jogador, com `seq`; espectador sem cartas fechadas.
- [ ] `error` com os códigos do guia; limite de `MAX_MESSAGE_BYTES`.
- [ ] Reconexão: mesmo token recupera o assento.

## 4. Sentar e sair

- [ ] `sit` com buy-in (poker 20–100 BB; blackjack 200–2.000), débito no ledger do `Account`.
- [ ] `stand` / cash-out devolve o stack ao saldo; idempotente por `ref`.
- [ ] Desconexão longa libera o assento (alarm).

## 5. Motor de blackjack

- [ ] Fase de aposta (10–500), deal, `hit`/`stand`/`double`, dealer até 17, pagamentos.
- [ ] `legalActions`, `total`, `outcome`, `dealerTotal`, `handId`, `secondsLeft` (alarm por turno).
- [ ] Skin da mesa (`boardSkinId`/`boardBackId`) por `boardSkin`.

## 6. Motor de poker (Hold'em)

- [ ] Blinds, botão, ordem de ação, `fold`/`check`/`call`/`bet`/`raise`/`all-in` com min/max.
- [ ] Queima antes de flop, turn e river (não aparece no `view`).
- [ ] Side pots, avaliação de mãos (`HandRank`), `you.hand`, showdown com `winners`.
- [ ] Timer de turno por alarm; auto-fold ao estourar.

## Transversal

- [ ] **Teste de vazamento:** nenhum `view` contém carta fechada de outro jogador nem do baralho.
- [ ] RNG do servidor (`crypto.getRandomValues`) para baralho e sorteio de skin.
- [ ] Rate limit por conexão.
- [ ] Deploy: job `wrangler deploy` no CI com os secrets `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`, e domínio `felt-api.blklight.dev`.
- [ ] Script `sync-protocol` para copiar `src/protocol.ts` ao front.

## No front quando cada passo ficar pronto

Ver seção 7 do `docs/api-guide.md`: `src/net/{api,socket,protocol}.ts`, perfil vindo de `/v1/me`, `handId` no `TableView`, e apagar os scripts de `src/dev/`.
