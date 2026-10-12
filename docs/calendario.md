# Calendário do Nexo no Google Agenda (ou no celular)

O Nexo dá a cada pessoa um **link secreto** que termina em `.ics`. Ele mostra os eventos de **todos os servidores** de que você participa e se atualiza sozinho.

## Pegar o link

1. Abra um servidor → **📅 Eventos** (no topo da lista de canais).
2. Clique em **🔗 Google Agenda**.
3. Clique em **Copiar**.

## Google Agenda (computador)

1. Abra <https://calendar.google.com>.
2. Na esquerda, em **Outras agendas**, clique em **+** → **Do URL**.
3. Cole o link e clique em **Adicionar agenda**.

Depois disso, a agenda aparece também no app do Google Agenda no celular.

> O Google atualiza agendas "Do URL" de tempos em tempos (pode levar algumas horas). Não dá para forçar.

## iPhone

Ajustes → Calendário → Contas → Adicionar conta → Outra → **Adicionar calendário assinado** → cole o link.

## Segurança

- Quem tiver o link vê os títulos e horários dos seus eventos. Não poste o link em lugar público.
- Se vazar: **🔗 Google Agenda → Gerar outro link**. O antigo para de funcionar na hora (aí é só trocar no Google Agenda).

## Para quem cuida do servidor

- O endereço é `https://meunexo.net.br/calendario/<link>.ics`. Ele passa pelo mesmo Caddy e túnel do resto do Nexo; não precisa abrir nada novo.
- Vão para o arquivo os eventos dos últimos 60 dias em diante (até 500).
