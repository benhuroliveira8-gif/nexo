# Ideia futura: levar o Nexo para a nuvem (Oracle Cloud grátis)

Anotado em 11/10/2026. Ainda não foi feito.

## Por quê

- Não precisar deixar o PC de casa ligado 24 h (hoje: PC ligado, tela apagada,
  VM com "Sempre iniciar automaticamente" no Hyper-V).
- A máquina na nuvem tem IP público: a voz pela internet passa a funcionar
  (hoje a voz fica em modo local por causa do CGNAT).

## Opção escolhida: Oracle Cloud "Always Free"

- ARM (Ampere A1): 2 núcleos e 12 GB de RAM grátis (era 4/24 até jun/2026).
- 200 GB de disco, 10 TB/mês de saída.
- Todos os serviços do Nexo têm versão ARM (Postgres, Node, Caddy, LiveKit, Jenkins).

Cuidados:
- Precisa de cartão de crédito (só verificação).
- Região de casa não muda depois: escolher **São Paulo** ou **Vinhedo**.
- Erro "Out of host capacity" ao criar a máquina: tentar mais tarde ou outro domínio de disponibilidade.
- A Oracle pode recolher máquinas grátis "paradas" (7 dias com CPU, rede e memória abaixo de 20%).
  Precisa configurar algo para evitar isso.
- A Oracle já mudou as regras sem aviso (jun/2026): conferir a documentação antes.
  https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm

Descartados: Google Cloud e2-micro (só 1 GB de RAM); AWS (créditos por ~6 meses, depois cobra).

## Passo a passo (resumo)

1. Criar conta na Oracle Cloud e a máquina Ampere A1 (Ubuntu, 2 OCPU / 12 GB, disco ~100 GB).
2. Abrir as portas no firewall da Oracle (Security List) e no Ubuntu: 80/443 TCP e as da voz
   (7881 TCP, 7882 UDP e a faixa de portas UDP do LiveKit).
3. Instalar Docker e trazer o projeto.
4. Restaurar o último backup (banco + arquivos enviados) — ver docs/monitor-e-backup.md.
5. Usar `docker-compose.publico.yml` com a voz pela internet (tirar o # das linhas do LiveKit).
6. Apontar `meunexo.net.br` para a nova máquina (ou o túnel da Cloudflare para lá).
7. Conferir UptimeRobot, nexo-monitor e backup; deixar a VM de casa como reserva.
