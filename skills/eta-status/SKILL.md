---
name: eta-status
description: Use quando o usuário digitar /eta-status ou pedir estimativa de tempo, previsão de término ou status geral do trabalho em andamento.
disable-model-invocation: true
argument-hint: "[tarefa opcional a estimar]"
---

# /eta-status — status geral e tempo estimado

O usuário quer saber, em tempo de relógio, quanto falta e onde o trabalho está. A resposta é um relatório curto em pt-BR, e a partir daqui toda tarefa nova começa com uma estimativa.

Se veio argumento (`$ARGUMENTS`), estime só essa tarefa, no mesmo formato.

Se a ferramenta `mcp__eta__plano` existir (mod `eta`), registre a árvore por ela antes de responder e use `mcp__eta__tarefa` ao começar e terminar cada tarefa: o mod mede o tempo real, marca o atraso e devolve o fator de calibração, que você aplica às faixas. Pergunta que espera resposta do usuário vai com `estado: "pergunta"` (a pergunta em `esperando`); espera por algo de fora, com `estado: "esperando"`.

## O relatório agora

Monte a partir do que está na conversa (pedido original, tarefas feitas, mensagens de outras sessões, processos em segundo plano). Não rode comandos só para preencher o relatório, salvo para checar algo em segundo plano cujo estado você não sabe.

```
**📍 Status:** <uma frase: em que ponto está o pedido do usuário>

🎯 <pedido do usuário> — ⏱ <faixa total restante>
├─ ✅ <tarefa feita> — —
├─ ⏳ <espera externa> — ? <condição>
│  └─ ⏭️ <tarefa que só começa depois dela> — <faixa>
│     ├─ ⏭️ <passo que depende da tarefa acima> — <faixa>
│     └─ ⏭️ <outro passo que depende da mesma tarefa> — <faixa>
│        └─ ⏭️ <passo final> — <faixa>
└─ ▶️ <tarefa independente em andamento> — <faixa>

**Confiança:** <🟢/🟡/🔴> <alta/média/baixa> — <o que mais pode mudar o número>
**❓ Pendências**
1. <pergunta ou decisão em aberto> — 👉 recomendo: <opção> — <por quê, uma frase>
2. <ação que só o usuário pode fazer> — 👉 <o que fazer e quando>
```

Montando a árvore:

- Filho = depende do pai: só começa quando o pai termina. Irmãos = não dependem um do outro.
- Tarefa com duas dependências fica sob a que termina por último, com `(também após <outra>)` no fim da linha.
- Desenhe com `├─`, `└─` e `│`. Só a árvore vai em bloco de código, para o alinhamento não quebrar; Status, Confiança e Pendências ficam fora dele, como texto normal.
- Tarefas feitas ficam na árvore enquanto houver filho pendente; ramos inteiramente feitos viram uma linha só (`✅ <ramo> — 3 tarefas`).
- O total na raiz soma as faixas de tudo que falta (o trabalho é feito uma tarefa por vez), e as esperas `?` entram como condição, não como número.

Estados, sempre com o emoji na frente:

| Emoji | Estado |
|---|---|
| ✅ | feita |
| ▶️ | em andamento |
| ⏭️ | próxima |
| ⏳ | esperando <quem/o quê> |
| 🚫 | bloqueada |
| ⚠️ | atrasada (passou do teto da faixa) |

Confiança: 🟢 alta · 🟡 média · 🔴 baixa.

Pendências, sempre por último:

- Liste toda pergunta que ficou sem resposta na conversa, decisão que você adiou e ação que só o usuário pode fazer (login, aprovação, avisar que algo externo terminou).
- Cada item leva uma recomendação concreta (`👉 recomendo: …`) com o motivo em uma frase. Pergunta sem recomendação não entra; se faltar dado para recomendar, a recomendação é como obter esse dado.
- Ordem: o que destrava mais tarefas da árvore primeiro.
- Sem pendências: `**❓ Pendências:** nenhuma`.

## Como estimar

- Formato do tempo: abaixo de 1 hora em minutos (`5–10 min`); de 1 hora para cima em `h:mm` (`1:20–2:00 h`). Numa faixa que cruza a hora, as duas pontas em `h:mm` (`0:40–1:15 h`).
- Tempo de relógio, do início ao fim da tarefa, incluindo espera por rede, build, download e as próprias rodadas de ferramenta.
- Sempre faixa, nunca número único. Faixa larga quando a incerteza é grande — é informação, não falha.
- Tarefa que espera algo externo (outra sessão, download, CI, resposta do usuário): ETA = `?` mais a condição (`? — depois que o retrato 2026-10 chegar`) e, separado, quanto leva depois que a espera acabar.
- Tarefa já feita: ETA `—`.

## A partir daqui, até o fim da sessão

- Antes de começar cada tarefa nova, escreva uma linha: `⏱ <tarefa> — ETA <faixa>`.
- Ao terminar, uma linha: `✅ <tarefa>`.
- Se passar do teto da faixa, pare e reestime numa linha antes de continuar: `⚠️ reestimado: <tarefa> — mais <faixa> (<motivo>)`.
