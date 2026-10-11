# Monitor e backup fora da VM

## 1. Monitor interno (job `nexo-monitor` no Jenkins)

A cada 5 minutos o Jenkins confere:

- se os containers estão ligados e saudáveis (`db`, `app`, `caddy`, `livekit` e, com o domínio, `cloudflared`);
- se o Nexo responde (o `/health` também testa o banco);
- se o disco da VM passou de 90%;
- se o backup diário está em dia (menos de 30 horas).

Se um container caiu, ele **tenta religar sozinho**. Quando aparece um problema (ou quando tudo
volta ao normal), ele **avisa no canal `#avisos`** do Nexo, marcando o dono do servidor
(a notificação chega no celular). O aviso não se repete a cada 5 minutos: só quando algo muda.

### Como ligar

1. **No Nexo**: crie um canal de texto chamado exatamente `avisos` no seu servidor.
   O bot do `.env` (`BOT_TOKEN`) precisa estar nesse servidor (o bot de exemplo já está).
   Se o canal for privado, dê ao bot um cargo que veja o canal.
2. **No Jenkins** (`http://IP-DA-VM:8080`): **Nova tarefa** → nome `nexo-monitor`.
   Lá embaixo, no campo **Copiar de**, digite `nexo-backup` → OK.
   - Na configuração que abrir, desça até **Pipeline** e troque o **Script Path** para
     `infra/monitor/Jenkinsfile` (o resto fica igual) → **Salvar**.
   - Clique em **Construir agora** uma vez (a partir daí ele roda sozinho a cada 5 minutos).

Se o job ficar vermelho, abra o **Console Output**: no fim aparece a lista de problemas.

## 2. Monitor externo (UptimeRobot, grátis)

O monitor interno não consegue avisar se a **VM inteira** cair (PC desligado, internet fora,
falta de luz). Para isso use um serviço de fora:

1. Crie uma conta grátis em <https://uptimerobot.com>.
2. **New monitor** → tipo **HTTP(s)** → URL: `https://meunexo.net.br/health` → intervalo 5 minutos.
3. Em **Alert contacts**, deixe o seu e-mail marcado. Instale o app **UptimeRobot** no celular
   para receber o alerta como notificação.

Pronto: se o Nexo ficar fora do ar, chega um e-mail/notificação; quando voltar, chega outro.

## 3. Backup fora da VM (Windows + OneDrive)

Os backups diários ficam em `/var/backups/nexo`, **dentro** da VM. Se o disco da VM estragar,
eles vão junto. O script `infra/windows/copiar-backups.ps1` copia os backups novos para o
Windows todo dia — por padrão para a pasta do **OneDrive**, que manda para a nuvem sozinho.

### Instalar (uma vez)

1. Copie `infra/windows/copiar-backups.ps1` para o Windows (ex.: Área de Trabalho).
2. Abra o **PowerShell** (não precisa ser administrador), entre na pasta e rode:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\copiar-backups.ps1 -Instalar -Servidor benhur@192.168.100.10
   ```

3. Ele pede a **senha da VM uma única vez** (para criar uma chave de acesso sem senha),
   cria a tarefa agendada **"Nexo - copiar backups"** e já faz a primeira cópia.

Depois disso, todo dia às 8h (ou quando você ligar o PC, se ele estava desligado) os backups
novos são copiados para `OneDrive\Backups do Nexo`. Cópias com mais de 30 dias são apagadas
(as 3 mais novas ficam sempre).

### Comandos úteis

```powershell
# Copiar agora
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\NexoBackup\copiar-backups.ps1"
# Ver o histórico
Get-Content "$env:LOCALAPPDATA\NexoBackup\log.txt" -Tail 20
# Outra pasta de destino ou outro prazo
powershell -ExecutionPolicy Bypass -File .\copiar-backups.ps1 -Instalar -Servidor benhur@192.168.100.10 -Destino "D:\Backups Nexo" -Manter 60
# Desinstalar
powershell -ExecutionPolicy Bypass -File .\copiar-backups.ps1 -Desinstalar
```

### Restaurar a partir da cópia do Windows

Se um dia precisar: copie a pasta do backup (ex.: `2026-10-11_0312`) de volta para
`/var/backups/nexo/` na VM (arrastando no VS Code) e rode `bash infra/backup/restaurar.sh 2026-10-11_0312`.

> Os backups têm o banco inteiro (mensagens e senhas criptografadas). O OneDrive é da sua
> conta Microsoft e só você acessa; não compartilhe essa pasta.
