# Proposal

## Why

Agentes abertos pelo CLI **omp** (oh-my-pi, `can1357/oh-my-pi`) não aparecem no escritório: o Habblaud só lê o que o
Claude Code grava em `~/.claude*` e o que o Codex grava em `~/.codex*`, e o omp tem runtime próprio que grava tudo em
`~/.omp/agent/sessions/`, mesmo quando usa um modelo Anthropic (nada vai para `~/.claude/projects`). Quem trabalha com o
omp fica sem sala, sem personagem, sem mensagens e sem aprovação pelo escritório.

## What Changes

- Nova fonte de agentes **omp**: cada sessão viva em `~/.omp/agent/sessions/<pasta>/<início>_<id>.jsonl` vira um
  agente na sala do seu `cwd` (a mesma sala de um Claude ou Codex no mesmo projeto), com ferramenta atual, status,
  título, tokens, modelo, subagentes (as tasks do omp) e encerramento quando a sessão termina.
- Nova extensão do omp (`mod/habblaud-omp/`), instalada por `npm run omp:install` (com `omp:uninstall` e `omp:status`)
  em `~/.omp/agent/extensions/`, que:
  - avisa o Habblaud em tempo real (início e fim de sessão e de turno, ferramenta iniciada e terminada) e mantém um
    batimento, para o agente fechar na hora mesmo num crash;
  - busca as mensagens deixadas no escritório para aquela sessão e as entrega ao agente (`followUp` com ele ocupado,
    turno novo com ele livre), confirmando cada uma;
  - espelha no escritório a espera de aprovação do omp (o agente de mão levantada, decisão no terminal) e, com
    `HABBLAUD_OMP_PERMISSOES=1` (para usar com o omp em `--approval-mode yolo`), decide as ferramentas `write`/`exec`
    pelo Habblaud: diálogo no terminal e pedido no escritório ao mesmo tempo, vale a primeira resposta; recusa
    bloqueia a ferramenta com o motivo; sem resposta antes do prazo do omp, recusa.
- Provider novo `omp` no snapshot e no cliente (nome, ícone, crachá), ao lado de `claude` e `codex`.
- Variáveis `HABBLAUD_OMP` (liga/desliga, padrão ligado quando a pasta existe) e `HABBLAUD_OMP_DIRS` (pastas do omp,
  respeitando também `PI_CODING_AGENT_DIR`); no Docker, `npm run docker:up` monta só `sessions/` do omp, somente leitura.
- Fora desta mudança: lançar o omp pelo "Novo agente"/terminal interativo, uso de 5h/semanal por conta e histórico de
  sessões omp antigas.

## Capabilities

### New Capabilities

- `omp-agents`: descoberta e acompanhamento das sessões do omp como agentes do escritório (presença, sala, atividade,
  status, tokens, subagentes, encerramento), por arquivo e pelos eventos da extensão.
- `omp-messages`: entrega de mensagens do escritório a uma sessão do omp pela extensão, com confirmação.
- `omp-permissions`: pedido de permissão de ferramentas do omp ao escritório, com bloqueio na recusa.
- `omp-extension-install`: instalação, remoção e verificação da extensão do Habblaud no omp.

### Modified Capabilities

(nenhuma: o repositório não tem specs anteriores em `openspec/specs/`)

## Impact

- **Servidor:** nova fonte em `server/sources/omp/`, registrada em `server/index.ts`; rota `POST /api/omp/events`;
  `/api/mod/inbox`, `/api/mod/inbox/ack` e `/api/permissions` passam a aceitar sessões do omp; `server/config.ts`.
- **Compartilhado:** `Provider` em `shared/types.ts` ganha `'omp'`; o protocolo do World não envia o provider de forma
  que quebre (conferir `shared/world/protocol.ts`).
- **Cliente:** `client/src/ui/provider.ts` e os ramos por provider (composer, gaveta, permissões).
- **Scripts:** `scripts/omp-install.ts`, `scripts/docker-up.ts`; `package.json` (scripts novos).
- **Docs:** README.pt-BR e CHANGELOG ("Não lançado"); textos novos traduzidos em en/es/fr para o `i18n:check`.
- **Dependência externa:** API de extensões do omp (validada no omp 18.12.2: `pi.on`, `sendUserMessage`, `tool_call`
  com `{block, reason}` aguardado; prazo `extensionHandlers.toolCallTimeoutMs`, padrão 30 s, que bloqueia ao vencer).
