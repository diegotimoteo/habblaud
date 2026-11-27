# Spec Delta

## Purpose

Permitir mandar mensagens do escritório a um agente omp aberto no terminal, entregues pela extensão do Habblaud no omp
com o mesmo contrato de caixa de entrada e confirmação usado para o Claude Code.

## ADDED Requirements

### Requirement: Caixa de entrada por sessão do omp
Com as mensagens ligadas no Habblaud, a extensão SHALL perguntar ao servidor, em `POST /api/mod/inbox` com o id da
sessão do omp, se há mensagens para ela. A pergunta MUST marcar a presença da caixa de mensagem desse agente no
escritório. Fora do ar ou com resposta diferente de 2xx, a extensão MUST esperar 30 s antes de perguntar de novo.

#### Scenario: Caixa acende
- **WHEN** um agente omp com a extensão está aberto e as mensagens estão ligadas
- **THEN** a gaveta desse agente oferece o campo de mensagem

#### Scenario: Mensagens desligadas
- **WHEN** o servidor responde 403 à pergunta
- **THEN** a extensão não entrega nada e só pergunta de novo depois de 30 s

### Requirement: Entrega ao agente
Cada mensagem recebida SHALL ser entregue à sessão como mensagem do usuário, na ordem de chegada e com o texto
exatamente como veio. Com o agente no meio de um turno, ela MUST entrar como continuação depois do turno atual, sem
interromper ferramentas em andamento; com ele livre, MUST iniciar um turno novo.

#### Scenario: Agente livre
- **WHEN** o agente está à toa e chega a mensagem "rode os testes"
- **THEN** um turno novo começa com esse texto como pedido do usuário

#### Scenario: Agente ocupado
- **WHEN** o agente está trabalhando e chega uma mensagem
- **THEN** o turno atual termina normalmente e a mensagem é tratada logo em seguida

### Requirement: Confirmação de entrega
Depois de tentar entregar as mensagens de uma rodada, a extensão SHALL mandar um único `POST /api/mod/inbox/ack` com o
resultado de cada uma (`ok`, ou falha com o motivo numa linha de até 500 caracteres). O escritório MUST mostrar a
mensagem como entregue ou com o motivo da falha.

#### Scenario: Entregue
- **WHEN** a entrega da mensagem não lança erro
- **THEN** o escritório marca a mensagem como entregue

#### Scenario: Falha
- **WHEN** a entrega lança um erro
- **THEN** o escritório mostra a mensagem como falha, com o texto do erro

### Requirement: Mensagens só para a sessão certa
O servidor SHALL entregar a uma pergunta apenas mensagens endereçadas ao agente omp daquela sessão; uma sessão MUST NOT
receber mensagens de outro agente, nem de um Claude ou Codex.

#### Scenario: Dois agentes omp no mesmo projeto
- **WHEN** há mensagem para o agente A e o agente B pergunta
- **THEN** B recebe a lista vazia e a mensagem continua esperando A
