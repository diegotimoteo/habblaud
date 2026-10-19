# Tasks

## 1. Provider `omp` e configuração

- [x] 1.1 `Provider` em `shared/types.ts` vira `'claude' | 'codex' | 'omp'`; corrigir cada ramo que o `npm run typecheck` apontar (servidor e cliente), com nome, ícone e textos do omp em `client/src/ui/provider.ts` — verificar: `npm run typecheck` limpo e o modo demo (`npm run demo`) sem erro no console
- [x] 1.2 `server/config.ts`: `omp` (`HABBLAUD_OMP`, padrão ligado) e `ompDirs`; `docker-compose.yml` repassa `HABBLAUD_OMP` e `HABBLAUD_OMP_DIRS` — verificar: testes de `parseConfig` para ligado/desligado e o teste do compose que confere as variáveis repassadas
- [x] 1.3 `server/sources/omp/accounts.ts`: `discoverOmpDirs` (`HABBLAUD_OMP_DIRS` › `PI_CODING_AGENT_DIR` › `~/.omp/agent`, só pastas com `sessions/`) e as contas por pasta (`setProviderAccounts('omp')`); `isOmpDir` impede que a pasta seja tomada por conta do Claude em `server/accounts/detect.ts` — verificar: testes de descoberta com pastas temporárias, incluindo Windows (`C:\...`)

## 2. Parser do transcript do omp

- [x] 2.1 Capturar fixtures reais (texto trocado por `…`) de `~/.omp/agent/sessions/` do omp 18.12.2: sessão com `bash`/`edit`/`read`, sessão com task e subagentes, saída limpa com `session_exit`, resposta com erro — verificar: arquivos em `server/sources/omp/fixtures/` sem texto de conversa
- [x] 2.2 `server/sources/omp/parser.ts`: cabeçalho (`id`, `cwd`, `parentSession`), linhas → `ParsedActivity[]` e sinais (`turnStart`, `turnEnd`, `exit`, `usage`, `model`, `title`); tabela de ferramentas do omp para o vocabulário de `shared/activity.ts`; tipos desconhecidos ignorados — verificar: testes com as fixtures da 2.1 (atividade de cada ferramenta, status por `stopReason`, soma de tokens, título, `session_exit`)

## 3. Fonte omp por arquivo

- [x] 3.1 `server/sources/omp/files.ts`: índice dos `.jsonl` principais e dos subagentes (pasta irmã), presença por `session_exit` + mtime ≤ 10 min — verificar: testes com pastas temporárias (nova, encerrada, parada há 11 min, subagente)
- [x] 3.2 `server/sources/omp/source.ts`: `OmpSource implements AgentSource` com polling de 1 s, `fs.watch` como acelerador, `FileTail` a partir da linha 3, boot entre `beginBoot`/`endBoot`; `enter`/`leave` → `addMain({provider:'omp'})`/`closeMain`, subagentes → `addSub`/`completeSub`; `applyTranscript` com título/modelo/tokens — verificar: teste de ponta a ponta com um `Office` real e um arquivo crescendo (agente aparece na sala do `cwd`, muda de status, ganha subagente, sai no `session_exit`)
- [x] 3.3 Registrar a fonte em `server/index.ts` ao lado do Codex e listar em `meta.sources` — verificar: `npm run dev` com uma sessão omp aberta nesta máquina mostra o agente na sala `habblaud` em até 2 s
- [x] 3.4 `scripts/docker-up.ts`: montar `sessions/` de cada pasta do omp em `/omp/<pasta>/sessions:ro` e passar `HABBLAUD_OMP_DIRS` — verificar: teste do override gerado (só `sessions/`, `:ro`)

## 4. Eventos da extensão no servidor

- [x] 4.1 `POST /api/omp/events` (parse e validação em `server/omp/http.ts`, trava igual à de `/api/codex/events`) e `OmpLive.applyEvent` no `OmpSource`: `session_start` cria, `agent_start`/`agent_end` mudam status, `tool_start`/`tool_end` atividade imediata, `session_shutdown` fecha, batimento ausente por 30 s fecha — verificar: testes da rota (400 no corpo inválido, 403 fora do loopback) e do ciclo com relógio manual
- [x] 4.2 Espelho da aprovação: `approval_requested`/`approval_resolved` marcam e limpam `waitingFor` ("aprovar no terminal: <ferramenta>") sem criar pedido no painel — verificar: teste no `Office` e no snapshot

## 5. Extensão do Habblaud para o omp

- [x] 5.1 `mod/habblaud-omp/habblaud.ts`: eventos (`session_start`, `agent_start`, `agent_end`, `tool_execution_start`/`_end`, `tool_approval_requested`/`_resolved`, `session_shutdown`) e batimento de 10 s para `/api/omp/events`, com `fetch` de no máximo 2 s e nenhum erro chegando ao omp; porta de `HABBLAUD_PORT` ou `~/.habblaud/omp-extension.json` — verificar: rodar `omp --mode rpc --no-extensions -e mod/habblaud-omp/habblaud.ts` contra um servidor de teste e conferir que cada evento chega (os nomes de evento errados não dão erro no omp, então isto é obrigatório)
- [x] 5.2 Mensagens: laço inbox → `pi.sendUserMessage(text, {deliverAs:'followUp'})` → ack (2 s à toa, 5 s ocupado, 30 s fora do ar); servidor aceita `provider === 'omp'` em `server/messages/registry.ts` e mostra "rode npm run omp:install" quando a sessão não está alcançável — verificar: testes do registry (sessão certa, outro agente não recebe) e prova real: mensagem mandada pela gaveta chega a um omp aberto e aparece como entregue
- [x] 5.3 Permissões, modo de decisão (`HABBLAUD_OMP_PERMISSOES=1`): no `tool_call` de ferramenta fora da lista de leitura, `POST /api/permissions` (`provider:'omp'`) + `ctx.ui.confirm` com `signal`, corrida entre os dois, retirada do pedido com `{behavior:'terminal'}` (ou rota de retirada do lado do hook, se a trava da página recusar), recusa → `{block, reason}`; aviso único quando o modo de aprovação do omp não é `yolo` — verificar: prova real com `omp --mode rpc-ui` (recusa no escritório bloqueia e o modelo recebe o motivo; resposta no terminal retira o pedido)
- [x] 5.4 Prazo do modo de decisão: com `ctx.hasUI`, `timeout_ms` = espera do Habblaud (5 min); sem UI, `HABBLAUD_OMP_TIMEOUT_MS` (padrão 30 000) − 3000; sem resposta → `{block, reason: 'sem resposta a tempo'}`; Habblaud sem aceitar o `POST` em 2 s → só o diálogo (sem UI, recusa "Habblaud fora do ar") — verificar: prova real com `--config` de `toolCallTimeoutMs` curto, com e sem UI
- [x] 5.5 Servidor: `parseHookInput` aceita `provider:'omp'` com as regras do Codex (sem sugestões nem perguntas, recusar com motivo) e casa o agente por `sessionId` entre os agentes omp — verificar: testes do registry para o omp (pedido aparece no agente certo, decisão chega ao long-poll)

## 6. Instalador

- [x] 6.1 `scripts/omp-install.ts` com `install`/`uninstall`/`status`, `--dry-run`, `--port`: grava o loader de uma linha em `<pasta>/extensions/habblaud.ts` (marca no cabeçalho), nunca toca outros arquivos; `status` diz instalada/atualizada, Habblaud respondendo e `HABBLAUD_OMP_PERMISSOES`; scripts `omp:install|uninstall|status` no `package.json` — verificar: testes com pasta temporária (instala, não duplica, remove, `orca-agent-status.ts` intacto byte a byte) e prova real de que uma sessão nova do omp carrega a extensão pelo loader no Windows

## 7. Documentação e textos

- [x] 7.1 README.pt-BR (seção do omp: o que aparece, `omp:install`, mensagens, as duas formas das permissões, variáveis) e CHANGELOG em "Não lançado" — verificar: os comandos documentados rodam como escrito
- [x] 7.2 Traduzir os textos novos (`tr(...)`) em en/es/fr — verificar: `npm run i18n:check` sem textos novos sem tradução

## 8. Verificação integrada

- [x] 8.1 `npm run typecheck`, `npm test` (duas vezes seguidas) e `npm run i18n:check` limpos — verificar: saída dos três
- [x] 8.2 Prova de ponta a ponta nesta máquina: `npm run omp:install`, `npm run dev`, abrir `omp` neste repositório e outro num segundo projeto; ver os dois agentes nas salas certas, uma task com subagentes, uma mensagem entregue, um pedido recusado no escritório (modo de decisão) e o agente saindo ao fechar e ao matar o processo — verificar: registro do que foi observado em cada passo
