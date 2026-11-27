# Spec Delta

## Purpose

Levar ao escritório (e ao celular) os pedidos de aprovação de ferramentas de um agente omp: sempre como aviso de que o
agente espera aprovação e, quando o usuário optar, como pedido que pode ser decidido no escritório.

## ADDED Requirements

### Requirement: Espelho da aprovação do omp
Sem `HABBLAUD_OMP_PERMISSOES=1`, quando o omp pedir aprovação de uma ferramenta no terminal, o escritório SHALL mostrar
o agente esperando aprovação, com o nome da ferramenta, sem botões de decidir. O aviso MUST sair quando o omp resolver
o pedido (aprovado ou recusado).

#### Scenario: omp pergunta no terminal
- **WHEN** o omp está em `always-ask` e o agente chama `bash`
- **THEN** o escritório mostra o agente esperando aprovação de `bash` e indica que a decisão é no terminal

#### Scenario: Resolvido no terminal
- **WHEN** o usuário aprova no diálogo do omp
- **THEN** o aviso some e o agente volta a trabalhar

### Requirement: Modo de decisão pelo Habblaud é opt-in
Com `HABBLAUD_OMP_PERMISSOES=1` no ambiente do omp, a extensão SHALL decidir as ferramentas que alteram arquivos ou
executam código (nível `write` ou `exec` no omp); ferramentas só de leitura MUST seguir sem pedido. Esse modo SHALL
ser usado com o omp em `--approval-mode yolo`; em outro modo, a extensão MUST avisar no terminal, uma vez por sessão,
que o omp também vai perguntar.

#### Scenario: Leitura
- **WHEN** o modo está ligado e o agente chama `read`
- **THEN** nenhum pedido aparece e a ferramenta roda sem espera extra

#### Scenario: Modo do omp incompatível
- **WHEN** o modo está ligado e o omp está em `always-ask`
- **THEN** a extensão mostra uma vez o aviso de que haverá duas perguntas

### Requirement: Terminal e escritório decidem juntos
No modo de decisão, cada ferramenta `write`/`exec` SHALL abrir ao mesmo tempo um diálogo no terminal e um pedido no
escritório; a primeira resposta MUST decidir, e a outra superfície MUST ser fechada (o diálogo cancelado ou o pedido
retirado do escritório).

#### Scenario: Responde no celular
- **WHEN** o pedido é permitido no celular com o diálogo ainda aberto no terminal
- **THEN** o diálogo do terminal fecha e a ferramenta roda

#### Scenario: Responde no terminal
- **WHEN** o usuário recusa no diálogo do terminal
- **THEN** o pedido sai do escritório e a ferramenta não roda

### Requirement: Recusa bloqueia com motivo
Uma recusa, de qualquer lado, MUST impedir a ferramenta de executar, e o modelo SHALL receber como erro o motivo
escrito na recusa, ou "recusado no Habblaud"/"recusado no terminal" sem texto. O Habblaud MUST NOT alterar os
argumentos da ferramenta.

#### Scenario: Recusa com motivo
- **WHEN** o pedido do `bash` é recusado no escritório com "não apague essa pasta"
- **THEN** o comando não roda e o modelo recebe "não apague essa pasta" como erro da ferramenta

### Requirement: Prazo da decisão
Com o diálogo aberto no terminal, a espera SHALL durar até a espera configurada no Habblaud (5 min por padrão), porque
o omp não conta o prazo dos handlers enquanto um diálogo da extensão está aberto. Sem diálogo possível (omp sem UI), a
espera MUST terminar pelo menos 2 s antes de `extensionHandlers.toolCallTimeoutMs` (30 s por padrão). Sem resposta, a
ferramenta MUST ser recusada com "sem resposta a tempo" e o pedido MUST sair do escritório como expirado.

#### Scenario: Ninguém responde com o terminal aberto
- **WHEN** ninguém responde por 5 min
- **THEN** o diálogo fecha, a ferramenta não roda, o modelo recebe "sem resposta a tempo" e o pedido some do escritório

#### Scenario: omp sem UI
- **WHEN** o omp roda sem UI (`--print` ou `--mode rpc` sem UI) e ninguém responde no escritório
- **THEN** a ferramenta é recusada antes de o omp bloquear por prazo, com "sem resposta a tempo"

### Requirement: Habblaud fora do ar
Quando o servidor não aceitar o registro do pedido em até 2 s, a decisão MUST ficar só no diálogo do terminal; sem UI,
a ferramenta MUST ser recusada com o motivo "Habblaud fora do ar".

#### Scenario: Habblaud fora do ar
- **WHEN** o servidor não aceita o registro do pedido em até 2 s
- **THEN** só o diálogo do terminal decide
