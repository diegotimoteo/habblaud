# omp-extension-install Specification

## Purpose
Instalar, atualizar, remover e conferir a extensão do Habblaud no omp com um comando, sem mexer nas extensões de
outros apps nem nas configurações do omp.

## Requirements

### Requirement: Instalar
`npm run omp:install` SHALL colocar a extensão do Habblaud em `extensions/` de cada pasta do omp acompanhada pelo
servidor (as mesmas de `omp-agents`), como um arquivo que carrega a extensão do repositório do Habblaud. A porta do
Habblaud MUST ficar num arquivo de configuração do Habblaud, fora da extensão, para que mudar a porta não exija
reinstalar. Rodar de novo MUST NOT duplicar a extensão.

#### Scenario: Primeira instalação
- **WHEN** `npm run omp:install` roda numa máquina com `~/.omp/agent/`
- **THEN** `~/.omp/agent/extensions/` ganha só a extensão do Habblaud, e a próxima sessão do omp a carrega

#### Scenario: Reinstalar
- **WHEN** o comando roda de novo
- **THEN** existe uma única extensão do Habblaud, apontando para o repositório atual

### Requirement: Não tocar no que não é do Habblaud
Os comandos SHALL ler e gravar só a extensão do Habblaud; as outras extensões (por exemplo, as do Orca) e os arquivos de
configuração do omp MUST continuar exatamente como estavam.

#### Scenario: Extensões do Orca presentes
- **WHEN** `extensions/` tem `orca-agent-status.ts` e o install e o uninstall rodam
- **THEN** `orca-agent-status.ts` continua idêntico, byte a byte

### Requirement: Remover
`npm run omp:uninstall` SHALL apagar a extensão do Habblaud de cada pasta do omp; sem ela instalada, MUST terminar sem
erro dizendo que não havia nada a remover.

#### Scenario: Remoção
- **WHEN** a extensão está instalada e o uninstall roda
- **THEN** o arquivo do Habblaud some de `extensions/` e as próximas sessões do omp não o carregam

### Requirement: Status
`npm run omp:status` SHALL mostrar, por pasta do omp, se a extensão está instalada e atualizada e se o Habblaud responde
na porta configurada, e se o modo de decisão das permissões (`HABBLAUD_OMP_PERMISSOES`) está ligado no ambiente atual.

#### Scenario: Instalada e servidor no ar
- **WHEN** a extensão está instalada e o Habblaud roda
- **THEN** o status mostra a pasta com "instalada" e "Habblaud respondendo"

### Requirement: Opções comuns aos instaladores
Os comandos SHALL aceitar `--dry-run` (mostra o que mudaria, sem gravar) e `--port <n>`, como os outros instaladores do
Habblaud, e MUST rodar no Windows, no macOS e no Linux.

#### Scenario: Dry run
- **WHEN** `npm run omp:install -- --dry-run` roda
- **THEN** a saída lista os arquivos que seriam criados e nada é gravado
