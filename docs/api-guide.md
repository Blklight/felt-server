# felt — guia da API (`felt-server`)

Este guia descreve o que o servidor precisa entregar para a UI do `felt-web` funcionar de verdade. Ele foi escrito a partir do código da UI (as PRs #1 a #20) e complementa o plano original (`felt-plano.md`, seções 2 e 3). Onde os dois divergem, este guia vale para o contrato com o front; o plano continua valendo para a arquitetura do servidor (Cloudflare Workers, Durable Objects, SQLite, motor puro).

A regra de ouro continua: **o servidor é a autoridade.** O front não embaralha, não avalia mãos, não decide quem ganha e não valida jogadas. Tudo que exige regra chega pronto no `view`.

Tipos de referência: `felt-web/src/dev/view-types.ts` (vai virar `src/net/protocol.ts`, sincronizado a partir do `felt-server/src/protocol.ts`).

---

## 1. Ordem sugerida de implementação

| Passo | Entrega do servidor | O que liga no front |
|---|---|---|
| 1 | `POST /v1/accounts`, `GET/PATCH/DELETE /v1/me` | Perfil real (substitui `useProfileStore`), código de recuperação, apagar conta |
| 2 | `POST /v1/rooms`, `GET /v1/rooms/:code` | Lobby: criar sala e entrar por código de verdade |
| 3 | WebSocket com `hello`, `welcome`, `view`, `ping`, `error` e uma mesa em `phase: "waiting"` | `socket.ts`, faixa de conexão, mesa assistindo |
| 4 | `sit`, `stand`, buy-in e cash-out com ledger | Sentar e sair (E3) |
| 5 | Motor de blackjack (M2/M4) | Mesa de blackjack inteira (E4) |
| 6 | Motor de poker P1 (M6/M7) | Mesa de poker, combinações, showdown (E1/E2) |

Até o passo 6, os servidores de mentira em `felt-web/src/dev/` continuam exercitando a UI. Eles são apagados quando o servidor equivalente estiver pronto.

---

## 2. HTTP

Base: `NEXT_PUBLIC_API_URL` (no plano, `https://felt-api.blklight.dev`). Todas as respostas usam o envelope que o `apiClient` do template já espera:

```ts
type ApiResponse<T> = { data: T | null; error: ApiError | null; message: string };
type ApiError = { code: string; message: string; fields?: Record<string, string> };
```

Erros de validação usam `code: "VALIDATION_ERROR"` e `fields` (`{ name: "too_short" }`, por exemplo).

Autenticação: `Authorization: Bearer <token>`. **Não existe refresh**: o token é permanente até a conta ser apagada. O interceptor de refresh do `apiClient` precisa ser desligado para o `felt` (um `401` significa "conta inválida", não "token expirado").

### 2.1 Contas

| Rota | Corpo | Resposta (`data`) |
|---|---|---|
| `POST /v1/accounts` | `{ name?, avatarId? }` | `{ playerId, token, profile }` |
| `GET /v1/me` | — | `profile` |
| `PATCH /v1/me` | `{ name?, avatarId?, skinId?, backId? }` | `profile` |
| `DELETE /v1/me` | — | `null` (apaga conta, ledger e histórico) |

```ts
type Profile = {
  playerId: string;
  name: string;
  avatarId: AvatarId;
  skinId: CardSkin;
  backId: CardBackVariant;
  balance: number;
  refills: number;
};
type AvatarId = "a1" | "a2" | "a3" | "a4" | "a5" | "a6" | "a7" | "a8";
type CardSkin = "classic" | "fantasy" | "noir" | "vice";
type CardBackVariant = "ink" | "neon" | "vice" | "suits";
```

Validação (a mesma da UI, que só antecipa o erro; quem decide é o servidor):

- `name`: sem espaços nas pontas, 2 a 20 caracteres, texto puro (sempre renderizado como texto).
- `avatarId`, `skinId`, `backId`: só valores das listas acima.

**Token e código de recuperação.** O token tem 32 bytes aleatórios (`crypto.getRandomValues`) em base64url, sem padding: 43 caracteres, `^[A-Za-z0-9_-]{43}$`. O servidor guarda só o SHA-256. O código de recuperação que o jogador vê, copia e importa **é o próprio token**. Importar = o front troca o token guardado e chama `GET /v1/me`; `401` significa código inválido.

Onde o front guarda o token: no `localStorage`, em um store persistido (ver a seção 8).

**Créditos.** `STARTING_CREDITS = 5000`. Recarga diária: uma vez por dia (dia UTC), se o saldo estiver abaixo de 5.000, ele **ganha até 2.500, sem passar de 5.000** (`balance = min(balance + 2500, 5000)`). Quem tem 5.000 ou mais não ganha nada. A conta guarda `refills` (quantas recargas) e `lastRefillDay` (`"2026-11-11"`). A recarga acontece no `GET /v1/me` e entra no ledger com `reason: "refill"` e `ref` = `refill:<dia>`, o que a torna idempotente. Ver a seção 8.

### 2.2 Salas

| Rota | Corpo | Resposta (`data`) |
|---|---|---|
| `POST /v1/rooms` | `{ game, config }` | `{ code }` |
| `GET /v1/rooms/:code` | — | `{ code, game, seats, taken }` |
| `GET /v1/rooms/:code/ws` | — | upgrade para WebSocket (checar `Origin`) |
| `GET /health` | — | `{ ok: true }` |

```ts
type RoomConfig =
  | { game: "poker"; blinds: [10, 20] | [25, 50] | [50, 100]; capToShortestStack: boolean; boardSkin: "creator" | "draw" }
  | { game: "blackjack"; boardSkin: "creator" | "draw" };
```

- **Código da sala:** 5 caracteres do alfabeto sem `0/O/1/I`. A UI valida com `^[A-HJ-NP-Z2-9]{5}$`.
- **Erros:** `ROOM_NOT_FOUND` (código inexistente) e `ROOM_FULL`.
- **Skin da mesa:** `boardSkin` define a skin das cartas compartilhadas. O padrão é `"creator"`, a skin de quem criou a sala. Com `"draw"`, o servidor sorteia entre as skins dos sentados no início de cada mão, com o RNG dele, e guarda o resultado no snapshot.

Buy-in: poker de 20 a 100 big blinds (25/50 dá 1.000 a 5.000); blackjack de 200 a 2.000, com apostas de 10 a 500 por mão. Ver a seção 8.

---

## 3. WebSocket

JSON, versionado (`v: 1`). Cartas: `"As"` = ás de espadas, `"Td"` = dez de ouros, `"??"` = carta escondida.

### 3.1 Cliente → servidor

```ts
type ClientMessage =
  | { t: "hello"; v: 1; token: string }
  | { t: "sit"; seat: number; buyIn: number }
  | { t: "stand" }
  | { t: "action"; action: { type: LegalAction["type"]; amount?: number } }
  | { t: "emote"; id: string }
  | { t: "ping" };
```

- `hello` é a primeira mensagem (o token nunca vai na URL). Sem `hello` em 5 s, o servidor fecha.
- `ping` a cada ~15 s; responder com `setWebSocketAutoResponse` (`pong`) para não acordar o DO.
- Limite de 20 mensagens/s por conexão; acima disso, `RATE_LIMITED`.

### 3.2 Servidor → cliente

```ts
type ServerMessage =
  | { t: "welcome"; seq: number; you: { playerId: string; name: string }; view: TableView }
  | { t: "view"; seq: number; view: TableView }
  | { t: "error"; code: ErrorCode; message?: string }
  | { t: "pong" };
```

- **`view` é sempre um snapshot completo**, enviado depois de cada mudança, e vale mais que qualquer evento. Ao reconectar, o `welcome` traz o snapshot atual.
- **Eventos (`events`) são opcionais na v1.** A UI anima comparando dois `view` seguidos (ver seção 5). Se o servidor mandar eventos no futuro, eles só adiantam a animação; nunca substituem o snapshot.
- `seq` cresce a cada mensagem da mesa. O cliente descarta `view` com `seq` menor que o último aplicado.

### 3.3 Códigos de erro

A UI já traduz estes códigos (em `src/i18n/use-server-error.ts`); qualquer outro vira "Algo deu errado. Tente de novo.":

| Código | Quando |
|---|---|
| `NOT_YOUR_TURN` | Ação fora da vez |
| `ILLEGAL_ACTION` | Ação ou valor fora de `legalActions` |
| `INSUFFICIENT_FUNDS` | Buy-in ou aposta acima do saldo/stack |
| `SEAT_TAKEN` | Lugar ocupado entre o clique e o `sit` |
| `ROOM_NOT_FOUND` | Sala inexistente |
| `ROOM_FULL` | Sem lugares |
| `RATE_LIMITED` | Mais de 20 mensagens/s |
| `UNAUTHORIZED` | Token inválido ou ausente no `hello` |

Uma ação ilegal **nunca** altera o estado (teste de propriedade do plano).

---

## 4. O `view` (o que a UI lê)

```ts
type TableView = {
  handId: number;                // cresce a cada mão (ver seção 5)
  game: "poker" | "blackjack";
  phase: PokerPhase | BlackjackPhase;
  seats: SeatView[];
  board: CardCode[];             // poker: cartas comunitárias reveladas; blackjack: mão da banca
  boardSkinId: CardSkin;
  boardBackId: CardBackVariant;
  pots: number[];                // poker; vazio no blackjack
  secondsLeft: number | null;    // segundos até o fim da vez/fase, no momento do envio
  you: {
    seat: number | null;         // null = assistindo
    legalActions: LegalAction[]; // vazio quando não é a vez do jogador
    hand?: HandInfo;             // poker: melhor mão atual do jogador
  };
  result?: { winners: Winner[] }; // poker: só no showdown
  log?: LogEntry[];              // últimas ações (a UI mostra 8)
  buyIn?: { min: number; max: number }; // presente quando you.seat é null
  dealerTotal?: number;          // blackjack: total das cartas visíveis da banca
};

type PokerPhase = "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown";
type BlackjackPhase = "waiting" | "betting" | "dealing" | "players" | "dealer" | "results";
```

### 4.1 Assentos

```ts
type SeatView = {
  seat: number;
  name: string;
  avatarId: AvatarId;
  skinId: CardSkin;        // skin do dono (as cartas dele aparecem assim para todos)
  backId: CardBackVariant; // verso do dono
  stack: number;
  bet: number;             // aposta na rodada atual (poker) ou na mão (blackjack)
  cards: CardCode[];       // "??" para cartas que este jogador não pode ver
  status: "active" | "folded" | "all-in" | "out" | "empty";
  isDealer: boolean;       // poker: botão do dealer
  blind?: "small" | "big"; // poker
  total?: number;          // blackjack: total da mão
  outcome?: Outcome;       // blackjack: só em phase "results"
  isTurn: boolean;
};
type Outcome = { kind: "win" | "blackjack" | "push" | "lose" | "bust"; amount?: number };
```

Lugares vazios vêm com `status: "empty"`, `name: ""` e `cards: []`. A UI mostra "Sentar aqui" neles quando `you.seat` é `null`.

### 4.2 Ações legais

```ts
type LegalAction = {
  type: "fold" | "check" | "call" | "bet" | "raise" | "all-in" | "hit" | "stand" | "double";
  min?: number;   // bet/raise
  max?: number;   // bet/raise
  amount?: number; // call (quanto paga), double (quanto acrescenta)
};
```

- `raise.min`/`raise.max` são valores **"aumentar para"** (total na rodada), não o acréscimo. A UI manda `{ type: "raise", amount }` com esse total.
- Com `min === max`, a UI mostra só "All-in" e manda `{ type: "raise", amount: max }`.
- Blackjack na fase `betting`: `[{ type: "bet", min, max }]`, com `max` limitado ao stack.
- A UI nunca mostra um botão que não esteja em `legalActions`.

### 4.3 Informação que exige regra (o servidor calcula)

| Campo | Regra |
|---|---|
| `you.hand` | Melhor mão de 5 entre as 2 do jogador e o board atual; `cards` são essas 5 cartas |
| `result.winners[]` | No showdown: `seat`, `amount` ganho e `hand` (as 5 cartas vencedoras, que a UI destaca). Empate = vários vencedores |
| `seats[].total` | Blackjack: total com ás valendo 1 ou 11 |
| `dealerTotal` | Blackjack: total só das cartas visíveis (sem a carta virada) |
| `seats[].outcome` | Blackjack: blackjack paga 3:2 (`amount` = lucro), vitória paga 1:1, empate devolve |

### 4.4 Vazamento de cartas (crítico)

- Cada jogador recebe o **seu** `view`. As cartas de outro jogador vêm como `"??"` até o showdown.
- A carta virada da banca vem como `"??"` até a banca jogar.
- `result` e cartas reveladas só aparecem quando a regra permite.
- Teste de propriedade obrigatório: o `view` de um assento **nunca** contém cartas fechadas de outro antes do showdown.

---

## 5. Como a UI anima (por que alguns campos importam)

A UI anima comparando o `view` anterior com o novo. Para isso funcionar, o servidor precisa manter alguns invariantes:

| Animação | O que a UI observa | Requisito do servidor |
|---|---|---|
| Embaralhar e distribuir do baralho | Mudança de `handId` | **`handId` novo a cada mão** (a UI remonta a mesa e distribui na ordem: uma carta por jogador a partir da esquerda do dealer, depois o board) |
| Flop, turn e river | `board` cresce (3, depois 4, depois 5) | Revelar as cartas comunitárias só ao fim de cada rodada de apostas |
| Carta virando no lugar | Uma posição de `cards`/`board` troca `"??"` por um valor | Manter a ordem e o tamanho das listas (posição estável) |
| Carta nova saindo do baralho (pedir, banca) | Lista cresce no fim | Acrescentar no fim, nunca reordenar |
| Apostas indo ao pote | `seats[i].bet` volta a 0 e `pots` aumenta, no mesmo `view` | Recolher as apostas em um único snapshot |
| Pote indo ao vencedor | `pots` vira vazio e o `stack` do vencedor aumenta, no mesmo `view` | Pagar em um único snapshot, depois de `result` |
| Timer urgente | `secondsLeft <= 5` | Mandar `secondsLeft` no momento do envio; a UI conta para baixo localmente |
| "Sua vez" (leitor de tela) | `you.legalActions` não vazio | — |
| Registro de ações | Novas entradas em `log` | `id` crescente; `log` pode ser só da mão atual |

`LogEntry`:

```ts
type LogEntry = {
  id: number;
  seat: number;
  kind: "blind" | "fold" | "check" | "call" | "bet" | "raise" | "all-in" | "win" | "hit" | "stand" | "double";
  amount?: number;
};
```

---

## 6. Fluxos

**Primeira visita.** `POST /v1/accounts` → guarda `{ playerId, token }` → `GET /v1/me` nas visitas seguintes. O saldo exibido é sempre o do servidor; o cache local só pinta a primeira tela.

**Entrar numa mesa.** `GET /v1/rooms/:code` (se `ROOM_NOT_FOUND`, a UI avisa) → WebSocket → `hello` → `welcome` com o `view`. Sem lugar: `you.seat = null`, `buyIn` presente, lugares vazios clicáveis.

**Sentar.** `sit { seat, buyIn }` → o servidor debita a conta (ledger `buyin`, `ref` única para idempotência), coloca o jogador e manda o `view`. Se o lugar foi tomado: `SEAT_TAKEN`.

**Sair.** `stand` → se o jogador está numa mão, sai ao fim dela (a UI avisa "Você sai quando esta mão terminar"); o stack volta para a conta (ledger `cashout`, `ref` única).

**Reconectar.** O `socket.ts` tenta de novo com espera crescente (1, 2, 4, 8… até 30 s), manda `hello` e recebe o snapshot no `welcome`. Durante a queda, a UI mostra a faixa de reconexão e desativa as ações. Prazos de turno continuam correndo no servidor (alarmes do DO); ao vencer, a ação automática do plano vale (check ou fold no poker, stand no blackjack).

**Apagar conta.** `DELETE /v1/me` → apaga conta, ledger e histórico; o front limpa o token e as mesas recentes.

---

## 7. O que muda no front quando a API existir

- Criar `src/net/api.ts` (contas e salas sobre o `apiClient`, sem refresh), `src/net/socket.ts` (conexão, `hello`, `ping`, backoff, `seq`) e `src/net/protocol.ts` (cópia sincronizada, com script `sync-protocol`).
- `socket.ts` alimenta o `useConnectionStore` (já usado pela faixa de conexão).
- Trocar o perfil local de `useProfileStore` por `GET/PATCH/DELETE /v1/me`; o store passa a guardar só `playerId` e `token` (no `localStorage`).
- `skin` e `back` do `useCardSkinStore` passam a vir do perfil (e a escolha no perfil vira `PATCH /v1/me`). A preferência "usar minha skin em todas as cartas" continua só local.
- Acrescentar `handId` ao tipo `TableView` do front (hoje a mão roteirizada usa um contador próprio).
- `TableScreen` passa a ler o `view` do socket; `Table` usa `key={view.handId}` com `animateDeal`.
- Ligar `Timer` a uma contagem local a partir de `secondsLeft`.
- Apagar `src/dev/use-hand-script.ts` e `src/dev/use-blackjack-script.ts`. Manter `src/dev/fixtures.ts` para testes e showcase.
- Mensagens de erro do socket vão para `useServerError`.

---

## 8. Decisões tomadas

Aprovadas: `handId` no `view`, `boardSkin: "creator" | "draw"` na criação da sala e `secondsLeft` relativo ao envio.

1. **Créditos: 5.000 iniciais e recarga diária de até 2.500, com teto de 5.000.** Quem está abaixo de 5.000 recebe até 2.500 por dia, sem passar de 5.000: com 0 vai a 2.500, com 1.000 vai a 3.500, com 4.900 vai a 5.000. O teto impede que a recarga leve alguém acima do valor inicial, então o saldo só cresce além de 5.000 jogando, o que mantém um ranking futuro justo. 2.500 cobre o buy-in mínimo dos dois jogos (1.000 no poker 25/50, 200 no blackjack). Quem controla o dia e o teto é o servidor; no navegador bastaria mudar o relógio.

2. **Token no `localStorage`, sem a lib `idb`.** IndexedDB não protege mais que o `localStorage`: os dois são lidos por qualquer script que rode na página, então o que protege o token é não ter XSS. Para isso: React escapando todo texto (o nome do jogador nunca vira HTML), uma Content Security Policy no Pages e o token nunca na URL nem em log. IndexedDB só passa a valer a pena se o front guardar dados maiores (histórico de mãos offline, por exemplo); aí entra o `idb`.

3. **Blackjack: buy-in de 200 a 2.000 e aposta de 10 a 500 por mão.** Com 2.000 na mesa, a aposta máxima é um quarto do stack, e o mínimo de 10 rende pelo menos 20 mãos com o buy-in mínimo. Os valores ficam em `config.ts` do servidor; se depois quisermos mesas de limites diferentes, viram uma opção da sala como os blinds do poker.

4. **Carta queimada: o motor queima de verdade, o `view` não mostra.** Queimar antes do flop, do turn e do river custa uma linha no motor e mantém a ordem do baralho igual à de uma mesa real. A carta queimada nunca é revelada, então ela não entra no `view` nem no `log`. Se quisermos ver a queima, a UI anima uma carta virada indo do baralho para um descarte sempre que o board cresce, sem mudar o protocolo.

5. **Sem `events` na v1, só snapshots.** A UI já anima comparando dois `view` (seção 5), então eventos não acrescentam nada agora. Eles dobrariam o contrato e o teste de vazamento (cada evento também poderia vazar uma carta). O campo `events` fica reservado para quando aparecer uma animação que um snapshot não consegue explicar.
