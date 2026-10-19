# omp-agents Specification

## Purpose
Fazer cada sessão viva do CLI omp aparecer no escritório como um agente, na sala do seu projeto, com atividade, status,
tokens, subagentes e encerramento, do mesmo jeito que as sessões do Claude Code e do Codex.

## Requirements

### Requirement: Descoberta das pastas do omp
O sistema SHALL procurar sessões do omp em `HABBLAUD_OMP_DIRS` (lista separada por vírgula), quando definida; sem ela,
em `PI_CODING_AGENT_DIR`, quando definida; e, sem nenhuma, em `~/.omp/agent`. Com `HABBLAUD_OMP=0` a fonte omp MUST
ficar desligada. Uma pasta sem `sessions/` MUST ser ignorada sem erro.

#### Scenario: Pasta padrão
- **WHEN** nenhuma das variáveis está definida e `~/.omp/agent/sessions/` existe
- **THEN** o sistema acompanha as sessões dessa pasta e `meta.sources` lista a fonte `omp`

#### Scenario: Desligado
- **WHEN** `HABBLAUD_OMP=0`
- **THEN** nenhuma sessão do omp aparece e `meta.sources` não lista a fonte `omp`

#### Scenario: Sem omp instalado
- **WHEN** nenhuma pasta candidata tem `sessions/`
- **THEN** o servidor sobe normalmente, sem aviso de erro, e sem a fonte `omp`

### Requirement: Sessão viva vira agente na sala do cwd
Cada arquivo de sessão principal (`sessions/<pasta>/<início>_<id>.jsonl`) considerado vivo SHALL virar um agente com
provider `omp`, id da sessão tirado do cabeçalho do arquivo e sala igual à do `cwd` do cabeçalho, a mesma usada por
agentes Claude e Codex no mesmo diretório. O nome da pasta MUST NOT ser usado para deduzir o `cwd`.

#### Scenario: Sessão nova no mesmo projeto de um Claude
- **WHEN** um Claude Code já trabalha em `C:\proj` e uma sessão omp começa com `cwd` `C:\proj`
- **THEN** em até 2 s o escritório mostra um segundo agente, de provider `omp`, na mesma sala

#### Scenario: Cabeçalho ilegível
- **WHEN** o arquivo não tem um cabeçalho `session` válido com `id` e `cwd`
- **THEN** o arquivo é ignorado e nenhum agente é criado

### Requirement: Presença por arquivo
Sem eventos da extensão, uma sessão SHALL ser considerada viva enquanto o arquivo não terminar com uma entrada
`session_exit` e tiver sido modificado há no máximo 10 minutos; ao deixar de ser viva, o agente MUST sair do escritório.

#### Scenario: Saída limpa
- **WHEN** o omp grava `session_exit` ao encerrar
- **THEN** o agente sai do escritório em até 2 s

#### Scenario: Processo morto sem extensão
- **WHEN** a sessão para de ser gravada sem `session_exit` e sem extensão instalada
- **THEN** o agente fica à toa e sai do escritório depois de 10 minutos sem mudança no arquivo

### Requirement: Atividade, status e resumo a partir do transcript
O sistema SHALL ler o arquivo de sessão de forma incremental e mostrar a ferramenta em uso, com o nome mapeado para o
vocabulário do escritório (comando, edição, leitura, busca, web, subagente), o status (trabalhando durante um turno,
à toa ao fim dele), o título, o modelo e os tokens somados das respostas do assistente.

#### Scenario: Ferramenta em andamento
- **WHEN** o assistente chama `bash` e o resultado ainda não chegou
- **THEN** o agente aparece trabalhando, com a atividade de comando e o comando como detalhe

#### Scenario: Fim do turno
- **WHEN** chega uma resposta do assistente com `stopReason` `stop`
- **THEN** o agente fica à toa

#### Scenario: Tokens
- **WHEN** a sessão tem respostas com `usage`
- **THEN** a gaveta do agente mostra a soma de entrada, saída e cache dessas respostas

### Requirement: Subagentes do omp
Cada transcript de subagente gravado em `<pasta da sessão>/<Nome>.jsonl` com `parentSession` apontando para a sessão
SHALL aparecer como subagente do agente principal enquanto estiver ativo, e MUST ser concluído quando terminar ou
quando o principal sair.

#### Scenario: Task com dois subagentes
- **WHEN** o agente principal dispara uma task que cria `ArchScout.jsonl` e `ApiScout.jsonl`
- **THEN** o escritório mostra dois subagentes ligados ao principal, com os nomes `ArchScout` e `ApiScout`

### Requirement: Eventos da extensão têm precedência
Quando a extensão do Habblaud estiver instalada no omp, os eventos dela SHALL definir presença e status da sessão:
`session_start` cria o agente na hora, `agent_start`/`agent_end` mudam o status, `session_shutdown` fecha, e a falta
de batimento por 30 s MUST fechar o agente mesmo sem `session_exit` no arquivo.

#### Scenario: Crash com extensão
- **WHEN** o processo do omp é morto (sem `session_exit`) com a extensão instalada
- **THEN** o agente sai do escritório em até 35 s

#### Scenario: Evento de sessão desconhecida no arquivo
- **WHEN** chega `session_start` de uma sessão cujo arquivo ainda não existe
- **THEN** o agente aparece pelo evento e passa a receber atividade quando o arquivo surgir

### Requirement: Rota de eventos só local
`POST /api/omp/events` SHALL aceitar eventos apenas com Host local e, fora do Docker, apenas de conexão pelo loopback;
corpo fora do formato MUST receber 400 sem alterar o escritório.

#### Scenario: Pedido de outra máquina
- **WHEN** um evento chega de um IP da rede
- **THEN** o servidor responde 403 e nada muda no escritório

### Requirement: Somente leitura no Docker
No Docker, o sistema SHALL montar só `sessions/` de cada pasta do omp, somente leitura; nunca a pasta inteira do omp,
que tem credenciais e configurações.

#### Scenario: docker:up com omp
- **WHEN** `npm run docker:up` roda numa máquina com `~/.omp/agent/sessions/`
- **THEN** o override gerado monta apenas essa pasta, `:ro`, e o container vê as sessões do omp
