# Design

## Context

Veja proposal.md (Why). Estado atual que molda o desenho:

- Cada ferramenta é uma fonte `AgentSource` (`server/sources/source.ts:22-39`) que traduz o formato dela em chamadas ao
  `Office` (`addMain`, `setStatus`, `addActivity`, `applyTranscript`, `addSub`, `completeSub`, `closeMain`). A sala é
  `normalizeCwd(cwd)` (`server/model/rooms.ts:4-7`). O `CodexSource` (`server/sources/codex/source.ts`) é o modelo mais
  próximo: arquivo JSONL + `FileTail` + polling de 1 s + eventos de hook (`CodexLive`, `POST /api/codex/events`).
- A caixa de entrada (`server/messages/registry.ts:293-336`) já casa a sessão por `sessionId` entre agentes não-Codex.
  As permissões (`server/permissions/registry.ts`) têm um ramo próprio para `provider: 'codex'`.
- Fatos do omp, conferidos no código do pacote `pi-coding-agent` e executados no omp 18.12.2 instalado:
  - Sessões: `~/.omp/agent/sessions/<pasta>/<início>_<uuidv7>.jsonl`, append-only. Linha 1 é um slot `title` de largura
    fixa reescrito no lugar; linha 2 é o cabeçalho `{type:"session", version, id, timestamp, cwd}`. Subagentes em
    `<arquivo sem .jsonl>/<Nome>.jsonl`, com `parentSession` no cabeçalho. Saída limpa grava
    `{type:"custom", customType:"session_exit"}`; crash não grava nada. O lock do omp é do sistema operacional e não é
    visível de fora.
  - Extensões em `<agentDir>/extensions/*.ts`, carregadas em toda sessão interativa e RPC. `pi.on(evento)` aceita
    qualquer nome sem erro (um evento com nome errado nunca dispara).
  - `tool_call` é aguardado, roda **antes** do diálogo de aprovação do omp e bloqueia com `{block: true, reason}` (o
    motivo chega ao modelo como erro da ferramenta). Prazo por handler: `extensionHandlers.toolCallTimeoutMs` (padrão
    30 s); vencido, o omp **bloqueia** a ferramenta.
  - `tool_approval_requested`/`tool_approval_resolved` só observam (o diálogo de `requestApproval` decide).
  - `pi.sendUserMessage(texto, {deliverAs: 'followUp'})` entrega: idle inicia turno; ocupado entra depois do turno.
  - `ctx.ui.confirm(título, mensagem, {signal})` abre um diálogo cancelável no terminal.

## Goals / Non-Goals

**Goals:**
- O escritório mostra agentes omp mesmo sem a extensão (só pelo arquivo), e com ela fica em tempo real.
- A extensão é um arquivo só, sem dependências além do runtime do omp (Bun), igual em Windows/macOS/Linux.

**Non-Goals:**
- Ler `agent.db`/`history.db` do omp (SQLite interno, sem contrato público).
- Mudar a configuração do omp (`config.yml`, modo de aprovação, prazo dos handlers).
- Interromper um turno (`abort`) pelo escritório.

## Decisions

### 1. Fonte `server/sources/omp/`, copiando a forma do Codex
`accounts.ts` (pastas: `HABBLAUD_OMP_DIRS` › `PI_CODING_AGENT_DIR` › `~/.omp/agent`; `setProviderAccounts('omp')`, uma
"conta" por pasta), `files.ts` (índice dos `.jsonl` principais em `sessions/*/`, subagentes por pasta irmã),
`parser.ts` (linha → `ParsedActivity[]` + sinais `turnStart`/`turnEnd`/`exit`/`usage`/`title`/`model`), `source.ts`
(`OmpSource implements AgentSource, OmpLive`). Alternativa descartada: ler pelo RPC/IPC do omp, que só alcança
processos lançados pelo Habblaud.

- **Leitura do arquivo:** o cabeçalho é lido uma vez (linhas 1–2); o resto por `FileTail` a partir da linha 3. A linha
  1 muda de conteúdo no lugar mantendo o tamanho; o `FileTail` não a relê, e o título vem das entradas `title_change`
  (append) — conferir no parser com um arquivo real.
- **Ferramentas → vocabulário do escritório:** tabela em `parser.ts` (`bash`→Bash, `edit`/`write`/`ast_edit`→Edit,
  `read`→Read, `grep`/`glob`→Grep/Glob, `web_search`/`fetch`→WebSearch/WebFetch, `task`→Task, desconhecida → nome
  cru), reaproveitando `shared/activity.ts` como o `describeCodexTool` faz.
- **Status:** `turnStart` em mensagem `user`; ferramenta aberta (`toolCall` sem `toolResult`) mantém trabalhando;
  `stopReason` `stop`/`error`/`aborted` → à toa.
- **Presença sem extensão:** viva = sem `session_exit` e mtime ≤ 10 min. 10 min cobre um turno longo sem gravação
  (o omp grava a cada mensagem e resultado de ferramenta).
- **Ids:** agente `omp:<sessionId>`; subagente `omp:<sessionId>:<Nome>`.

### 2. Extensão `mod/habblaud-omp/habblaud.ts` + loader instalado
O instalador grava `<agentDir>/extensions/habblaud.ts` com uma linha:
`export { default } from "<file URL de mod/habblaud-omp/habblaud.ts>";`. Assim `git pull` atualiza a extensão sem
reinstalar, e o arquivo do Habblaud é reconhecido pelo conteúdo (marca no comentário de cabeçalho). A porta fica em
`~/.habblaud/omp-extension.json` (`{port}`), lida a cada conexão; `HABBLAUD_PORT` no ambiente do omp tem precedência.
Alternativa descartada: copiar a extensão inteira (fica velha a cada atualização).
Risco a validar na tarefa: o Bun do omp resolver um `export from` de `file:///C:/...` (conferir com uma sessão real).

### 3. Eventos: `POST /api/omp/events`
Corpo `{event, sessionId, sessionFile?, cwd?, at, toolName?, toolCallId?, approval?}` para
`session_start | agent_start | agent_end | tool_start | tool_end | approval_requested | approval_resolved |
heartbeat | session_shutdown`. Batimento a cada 10 s; sem batimento por 30 s, o `OmpSource` fecha o agente.
Mesma trava do `/api/codex/events` (Host local, loopback fora do Docker; `server/http/app.ts:122-129`). A extensão
nunca deixa uma falha de rede chegar ao omp: `fetch` com `AbortSignal.timeout(2000)` e erro engolido.

### 4. Mensagens: rotas existentes
A extensão faz o laço do `habblaud-mensagens` (inbox → entrega → ack), com `session = ctx.sessionManager.getSessionId()`
e entrega por `pi.sendUserMessage(text, {deliverAs: 'followUp'})`. No servidor, só o filtro dos agentes elegíveis
muda de `provider !== 'codex'` para `provider === 'claude' || provider === 'omp'` (`registry.ts:300`), e o texto de
"não alcançável" ganha a variante do omp (`npm run omp:install`).
A consulta roda a cada 2 s com o agente à toa e a cada 5 s ocupado (o `followUp` espera o turno de qualquer jeito).

### 5. Permissões: espelho sempre, decisão opt-in
- **Espelho (padrão):** `tool_approval_requested` → evento `approval_requested` → `office` marca `waitingFor`
  ("aprovar no terminal: bash"), sem pedido no painel; `approval_resolved` limpa. Não passa pelo
  `PermissionRegistry` (não há decisão a tomar).
- **Decisão (`HABBLAUD_OMP_PERMISSOES=1`):** no `tool_call`, se o nível da ferramenta for `write`/`exec`:
  1. `POST /api/permissions` com `provider: 'omp'`, `session_id`, `tool_name`, `tool_input` e `timeout_ms`. Com
     `ctx.hasUI`, vale a espera do Habblaud (5 min por padrão). O omp pausa o prazo do handler enquanto um diálogo da
     extensão está aberto (`runner.ts:201-207`, `timeoutBudget.pause()`). Isso foi provado no 18.12.2: com o prazo em
     3 s por `--config`, um `confirm` aberto por 8 s não bloqueou a ferramenta. Sem UI, vale `toolCallTimeoutMs − 3000`;
     esse valor vem de `HABBLAUD_OMP_TIMEOUT_MS` quando o usuário mudou o prazo do omp, porque o `ctx` não expõe as
     configurações, e é 27 000 por padrão.
  2. em paralelo, `ctx.ui.confirm(...)` com um `AbortController`;
  3. `Promise.race` entre o diálogo e o long-poll `GET /api/permissions/:id/wait`; quem vencer cancela o outro. O
     diálogo, pelo `signal`. O pedido, por `POST /api/permissions/:id/decision` `{behavior: 'terminal'}`, que já existe
     e o solta como `released/terminal` (`registry.ts:513-515`). Se a trava de página dessa rota recusar quem não é a
     página, entra uma rota do lado do hook, `POST /api/permissions/:id/withdraw`, com a mesma trava do
     `POST /api/permissions`. Só abandonar o long-poll deixaria o pedido 8 s na tela até o `ORPHAN_MS`;
  4. recusa → `{block: true, reason}`; permitido → `undefined`; prazo → `{block: true, reason: 'sem resposta a tempo'}`;
     Habblaud sem responder ao `POST` em 2 s → só o diálogo.
- **Nível da ferramenta:** o omp não expõe o tier ao `tool_call` (o `ToolInfo` de `getAllTools()` não tem `approval`).
  A extensão usa uma lista fixa de ferramentas só de leitura do omp (`read`, `grep`, `glob`, `ls`, `web_search`,
  `fetch`, `lsp`, `todo`, `ask`...); qualquer outra conta como `write`/`exec`, o mesmo padrão do omp ("omitido = exec").
- No servidor, `parseHookInput` aceita `provider: 'omp'`; o ramo segue as regras do Codex (sem sugestões, sem
  perguntas, recusar só com motivo) e o agente casa por `sessionId` entre os agentes `omp`.

### 6. Provider `'omp'`
`shared/types.ts:18` vira `'claude' | 'codex' | 'omp'`. O compilador aponta cada `switch`/ramo; nos que testam
`=== 'codex'` (cliente: `client/src/ui/provider.ts`, composer, gaveta, permissões), o omp ganha nome, ícone e
mensagens próprias. O World manda só o que já manda (sem provider no pacote; conferir `shared/world/protocol.ts:505`).

## Risks / Trade-offs

- [Formato do JSONL do omp muda entre versões] → o parser ignora tipos desconhecidos, e os testes usam linhas reais
  copiadas do omp 18.12.2.
- [Sem UI, o omp bloqueia aos 30 s] → a extensão recusa antes, com motivo; quem roda omp sem UI e mudou o prazo informa
  `HABBLAUD_OMP_TIMEOUT_MS`.
- [Lista fixa de ferramentas de leitura fica velha] → ferramenta nova cai em `write`/`exec` (pede permissão a mais, não
  a menos).
- [Agente fantasma de 10 min sem extensão] → documentado; a extensão resolve com o batimento.
- [`pi.on` aceita nome errado sem erro] → teste do mod confere que cada handler registrado dispara num omp de verdade
  (tarefa de verificação com `omp --mode rpc`).

## Migration Plan

Sem migração: fonte nova, ligada só quando a pasta do omp existe; a extensão só existe depois do `omp:install`.
Desfazer: `npm run omp:uninstall` e `HABBLAUD_OMP=0`.

## Open Questions

(nenhuma que mude o que é construído; os dois pontos "conferir" acima são verificações dentro das tarefas)
