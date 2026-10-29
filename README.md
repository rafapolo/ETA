# eta

Mod para o Claude Code que mostra o plano do trabalho como uma árvore de tarefas com tempo estimado, numa faixa acima do prompt. O relógio é real: o mod mede quanto cada tarefa levou, avisa quando uma passa do teto e aprende com o histórico quanto as suas estimativas costumam errar.

```
──────────────────────────────────────────────────────────────────────────────
⏱ Migrar o banco e publicar a v2… ✓ 4/16 · ◷ resta ~17 h (6–28) · ✓ fim ~amanhã 06:40

◷ 1 esperando: Apagar backups antigos (o upload confirmar)
! Reprocessar arquivo de 2025 — parada? +10 h além
└ ○ Recalcular índices — 0:30–1:30 h
  └ ○ Gerar views novas — 20–40 min
▶ Importar dados (2024-01 → hoje) — ━━━─────  44% · faltam ~14 h (4–24)
└ ◆ Explore: achar onde o CSV é lido — 3 min
└ ◐ bun run importa.ts 2024-01 — 12 min
└ ○ Copiar os meses para o servidor novo — 10–20 min
✓ Subir a coleta no servidor — levou 5 min

? Formato do relatório — Opção A ou B? · depois 1–2 h · +1 depois
```

## O que vem no repositório

- **Mod** (`hooks/register.tsx`): a faixa, as ferramentas `mcp__eta__plano` e `mcp__eta__tarefa` que o modelo chama, o espelho do `TodoWrite`/`TaskCreate`/`TaskUpdate` e o comando `/eta`.
- **Skill** `/eta-status` (`skills/eta-status/SKILL.md`): um relatório de status na conversa, com árvore, confiança e pendências, e o hábito de estimar cada tarefa antes de começar.

## Instalar

No prompt de uma sessão do Claude Code no terminal:

```
/plugin install eta --marketplace rafapolo/ETA
```

Responda `y` para adicionar o marketplace e escolha o escopo (usuário é o primeiro).

Pelo shell:

```
claude plugin install eta --marketplace rafapolo/ETA
```

No app de desktop, onde `/plugin` não roda: clique em + ao lado da caixa do prompt, depois Plugins, Add marketplace com `rafapolo/ETA`, depois Add plugin.

## Símbolos e cores

Cada símbolo ocupa uma coluna, para os títulos alinharem; a cor diferencia os estados. As cores são as do tema do Claude Code, então acompanham o tema claro ou escuro.

| Símbolo | Estado | Cor | Quando aparece |
|---|---|---|---|
| `▶` | em andamento | verde (`success`) | o modelo chamou `mcp__eta__tarefa` com `andamento` |
| `◆` | subagente rodando | laranja (`claude`) | o modelo chamou a ferramenta `Agent` |
| `◐` | processo em segundo plano | ciano (`planMode`) | o modelo rodou `Bash` com `run_in_background` |
| `○` | na fila | amarelo (`warning`), texto apagado | ainda não começou |
| `◷` | esperando | magenta (`permission`) | espera algo de fora: outra sessão, download, CI |
| `?` | pergunta | azul em negrito (`suggestion`) | espera uma resposta sua; fica fora da árvore |
| `✕` | bloqueada | vermelho (`error`) | não tem como seguir; num subagente ou processo, `falhou` ou `interrompido` |
| `!` | atrasada | amarelo (`warning`) | passou do teto da faixa |
| `✓` | feita | verde (`success`), texto apagado | terminou; mostra quanto levou |

No cabeçalho e no status:

| Elemento | Cor | O que diz |
|---|---|---|
| `⏱ objetivo` | negrito | o pedido, cortado com `…` para caber numa linha |
| `✓ 4/16` | cinza | tarefas feitas sobre o total |
| `◷ resta ~17 h (6–28)` | cinza | o valor provável e, entre parênteses, a faixa; faixa estreita aparece sozinha |
| `✓ fim ~amanhã 06:40` | cinza | a hora local de término pelo valor provável: `hoje`, `amanhã` ou a data |
| `━━━─────  44%` | azul, a parte vazia apagada | progresso sobre o meio da faixa, até 99% |
| `faltam ~14 h (4–24)` / `até 3 min` | azul | quanto falta; depois do mínimo, só o teto |
| `+2 min além` | amarelo | quanto passou do teto |
| `parada? +10 h além` | amarelo | o estouro passou de 30 min e do próprio teto: provavelmente só não foi encerrada |
| `· +N depois` | apagado | tarefas que dependem desta e ainda não aparecem |

## Como o mod fica sabendo das tarefas

O mod não observa o trabalho em si: ele escuta chamadas de ferramenta.

| Fonte | Entra na árvore | Sai ou muda |
|---|---|---|
| `mcp__eta__plano` | o plano inteiro, com faixas e dependências (`pai`); tarefas de mesmo id ou título herdam os horários | um novo plano substitui o anterior |
| `mcp__eta__tarefa` | — | muda o estado: `andamento` marca o início, `feita` o fim |
| `TodoWrite` | título novo vira tarefa sem estimativa, na raiz | `pending` → `○`, `in_progress` → `▶`, `completed` → `✓`; sumiu da lista, sai da árvore |
| `TaskCreate` / `TaskUpdate` | tarefa criada; o primeiro `addBlockedBy` vira a tarefa-mãe | mudança de status; `deleted` tira da árvore |
| `Agent` (subagente) | `◆ tipo: descrição`, filha da única tarefa em `▶`, se houver uma só | a lista de agentes diz `completed`, `failed` ou `killed` (conferida a cada minuto e ao fim de cada turno do subagente) |
| `Bash` com `run_in_background` | `◐ descrição ou comando`, filha da única tarefa em `▶` | o aviso de término do processo chega na conversa |

Subagentes e processos terminados ficam 5 minutos como `✓ levou X` (ou `✕ falhou`) e depois saem da árvore. Eles não têm estimativa: não entram no `resta` nem no `+N sem estimativa`.

## Como ler a árvore

- `└` recuado sob o ícone de uma tarefa = depende dela: só começa quando ela termina.
- Tarefas no mesmo recuo são independentes entre si.
- **Perguntas** ficam numa seção própria, depois de uma linha em branco abaixo da árvore, junto com o que depende delas. Respondida a pergunta, a tarefa volta para a árvore no lugar dela.
- A linha `◷ N esperando` logo abaixo do cabeçalho junta as esperas externas.

## Como o tempo é contado

- Faixas em minutos de relógio, do início ao fim da tarefa.
- **Resta:** só as tarefas em andamento correm juntas, e delas vale a mais longa (subagentes e processos são paralelo medido, mas sem estimativa, então só aparecem na árvore); o resto da fila soma em série, porque um agente faz uma coisa de cada vez. Perguntas não entram no número enquanto não forem respondidas: aparecem como `+ N dependem de você`.
- **Calibração:** cada tarefa estimada que termina vira uma amostra (estimado × real). A partir de 5 amostras, a resposta de `mcp__eta__plano` traz o fator mediano, e o modelo ajusta as próximas faixas por ele. O histórico guarda as últimas 200 amostras, entre sessões.
- A cada minuto a faixa redesenha sozinha, sem chamar o modelo: o tique não gasta tokens. Só as chamadas de `mcp__eta__plano` e `mcp__eta__tarefa` vão para o modelo.

## Comando

- `/eta` abre ou fecha a faixa nesta sessão.

## Desenvolver

```
claude --plugin-dir .          # sessão com o mod carregado desta pasta
claude plugin validate .
claude plugin test .
```
