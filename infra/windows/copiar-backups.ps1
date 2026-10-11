<#
  Nexo - copia os backups da VM para o Windows (de preferência para a pasta do OneDrive,
  que manda tudo para a nuvem sozinha). Assim, se a VM ou o disco der problema, os backups
  continuam salvos fora dela.

  COMO USAR (no PowerShell do Windows, NÃO precisa ser administrador):

    1) Instalar (uma vez só):
         powershell -ExecutionPolicy Bypass -File .\copiar-backups.ps1 -Instalar -Servidor benhur@192.168.100.10
       Vai pedir a senha da VM UMA vez (para criar uma chave de acesso sem senha).
       Depois disso, todo dia às 8h (ou quando você ligar o PC, se ele estava desligado)
       os backups novos são copiados sozinhos.

    2) Copiar agora (para testar):
         powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\NexoBackup\copiar-backups.ps1"

    3) Desinstalar:
         powershell -ExecutionPolicy Bypass -File .\copiar-backups.ps1 -Desinstalar

  Opções: -Destino "D:\Backups Nexo"   -Manter 30 (dias)   -PastaRemota /var/backups/nexo
#>
param(
  [switch]$Instalar,
  [switch]$Desinstalar,
  [string]$Servidor,
  [string]$Destino,
  [int]$Manter = 0,
  [string]$PastaRemota
)

$ErrorActionPreference = 'Stop'
$Pasta = Join-Path $env:LOCALAPPDATA 'NexoBackup'
$Config = Join-Path $Pasta 'config.json'
$Log = Join-Path $Pasta 'log.txt'
$Tarefa = 'Nexo - copiar backups'
$Chave = Join-Path $env:USERPROFILE '.ssh\id_ed25519'

function Escrever($texto) {
  $linha = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $texto
  Write-Host $linha
  New-Item -ItemType Directory -Force -Path $Pasta | Out-Null
  Add-Content -Path $Log -Value $linha -Encoding UTF8
}

function Destino-Padrao {
  if ($env:OneDrive -and (Test-Path $env:OneDrive)) { return (Join-Path $env:OneDrive 'Backups do Nexo') }
  return (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Backups do Nexo')
}

function Ler-Config {
  if (Test-Path $Config) { return (Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json) }
  return $null
}

# ------------------------------------------------------------------ Desinstalar
if ($Desinstalar) {
  Unregister-ScheduledTask -TaskName $Tarefa -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarefa '$Tarefa' removida. Os backups já copiados continuam na pasta de destino."
  exit 0
}

# ------------------------------------------------------------------ Instalar
if ($Instalar) {
  if (-not $Servidor) { $Servidor = Read-Host 'Usuário e IP da VM (ex.: benhur@192.168.100.10)' }
  if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host 'O "ssh" do Windows não foi encontrado. Instale em: Configurações > Sistema > Recursos opcionais > Cliente OpenSSH.' -ForegroundColor Red
    exit 1
  }
  if (-not $Destino) { $Destino = Destino-Padrao }
  if ($Manter -le 0) { $Manter = 30 }
  if (-not $PastaRemota) { $PastaRemota = '/var/backups/nexo' }

  # Chave de acesso (sem senha) para a cópia rodar sozinha.
  if (-not (Test-Path $Chave)) {
    Write-Host 'Criando uma chave de acesso SSH...'
    New-Item -ItemType Directory -Force -Path (Split-Path $Chave) | Out-Null
    Start-Process -FilePath 'ssh-keygen' -ArgumentList "-q -t ed25519 -f `"$Chave`" -N `"`" -C nexo-backup" -Wait -NoNewWindow
  }
  & ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new $Servidor 'echo ok' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Agora digite a SENHA da VM (só desta vez) para liberar a chave:' -ForegroundColor Yellow
    Get-Content "$Chave.pub" | & ssh -o StrictHostKeyChecking=accept-new $Servidor 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
    & ssh -o BatchMode=yes -o ConnectTimeout=10 $Servidor 'echo ok' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host 'Não deu para entrar na VM sem senha. Confira o usuário/IP e tente de novo.' -ForegroundColor Red; exit 1 }
  }
  Write-Host 'Acesso à VM sem senha: OK' -ForegroundColor Green

  New-Item -ItemType Directory -Force -Path $Pasta | Out-Null
  [pscustomobject]@{ servidor = $Servidor; destino = $Destino; manter = $Manter; pastaRemota = $PastaRemota } |
    ConvertTo-Json | Set-Content -Path $Config -Encoding UTF8
  $copia = Join-Path $Pasta 'copiar-backups.ps1'
  if ($PSCommandPath -ne $copia) { Copy-Item -Path $PSCommandPath -Destination $copia -Force }

  $acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$copia`""
  $gatilhos = @((New-ScheduledTaskTrigger -Daily -At '08:00'), (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"))
  $ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $Tarefa -Action $acao -Trigger $gatilhos -Settings $ajustes -Description 'Copia os backups do Nexo da VM para o Windows/OneDrive.' -Force | Out-Null
  Write-Host "Tarefa '$Tarefa' criada: todo dia às 8h e ao entrar no Windows." -ForegroundColor Green
  Write-Host "Destino: $Destino"
  Write-Host 'Fazendo a primeira cópia agora...'
  & $copia
  exit $LASTEXITCODE
}

# ------------------------------------------------------------------ Copiar
$cfg = Ler-Config
if (-not $Servidor) { $Servidor = $cfg.servidor }
if (-not $Destino) { $Destino = if ($cfg -and $cfg.destino) { $cfg.destino } else { Destino-Padrao } }
if ($Manter -le 0) { $Manter = if ($cfg -and $cfg.manter) { [int]$cfg.manter } else { 30 } }
if (-not $PastaRemota) { $PastaRemota = if ($cfg -and $cfg.pastaRemota) { $cfg.pastaRemota } else { '/var/backups/nexo' } }
if (-not $Servidor) { Write-Host 'Rode primeiro com -Instalar -Servidor usuario@IP-DA-VM' -ForegroundColor Red; exit 1 }

try {
  New-Item -ItemType Directory -Force -Path $Destino | Out-Null
  # Lista os backups completos da VM (os que têm o arquivo OK).
  $lista = & ssh -o BatchMode=yes -o ConnectTimeout=15 $Servidor "ls -1 $PastaRemota/*/OK 2>/dev/null"
  if ($LASTEXITCODE -ne 0 -and -not $lista) { throw 'não consegui falar com a VM (ela está ligada? o IP mudou?)' }
  $remotos = @($lista | ForEach-Object { ($_ -split '/')[-2] } | Where-Object { $_ -match '^\d{4}-\d{2}-\d{2}_\d{4}$' } | Sort-Object)
  if (-not $remotos.Count) { Escrever 'Nenhum backup completo na VM ainda.'; exit 0 }

  $novos = 0
  foreach ($nome in $remotos) {
    $final = Join-Path $Destino $nome
    if (Test-Path (Join-Path $final 'OK')) { continue }
    $tmp = Join-Path $Destino ".$nome.tmp"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Escrever "Copiando $nome..."
    & scp -q -o BatchMode=yes -o ConnectTimeout=15 "${Servidor}:$PastaRemota/$nome/*" "$tmp"
    if ($LASTEXITCODE -ne 0) { throw "falhou ao copiar $nome" }
    foreach ($arq in 'banco.dump', 'anexos.tar.gz', 'OK') {
      if (-not (Test-Path (Join-Path $tmp $arq))) { throw "cópia de $nome incompleta (faltou $arq)" }
    }
    if (Test-Path $final) { Remove-Item -Recurse -Force $final }
    Rename-Item -Path $tmp -NewName $nome
    $novos++
  }

  # Apaga cópias com mais de N dias (as 3 mais novas nunca são apagadas).
  $locais = @(Get-ChildItem -Path $Destino -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{4}$' } | Sort-Object Name)
  $limite = (Get-Date).AddDays(-$Manter)
  $apagaveis = $locais | Select-Object -First ([Math]::Max(0, $locais.Count - 3))
  foreach ($d in $apagaveis) {
    $data = [datetime]::ParseExact($d.Name.Substring(0, 10), 'yyyy-MM-dd', $null)
    if ($data -lt $limite) { Remove-Item -Recurse -Force $d.FullName; Escrever "Apagada cópia antiga $($d.Name)." }
  }
  $total = @(Get-ChildItem -Path $Destino -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{4}$' }).Count
  Escrever "Pronto: $novos backup(s) novo(s) copiado(s). Total guardado em '$Destino': $total."
  # Mantém o log pequeno.
  if ((Get-Item $Log).Length -gt 200KB) { Get-Content $Log -Tail 500 | Set-Content $Log -Encoding UTF8 }
  exit 0
} catch {
  Escrever "ERRO: $($_.Exception.Message)"
  exit 1
}
