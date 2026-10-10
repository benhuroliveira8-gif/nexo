# Abre as portas de VOZ do Nexo no Windows (para quem acessa pela internet).
#
# Rode no PowerShell COMO ADMINISTRADOR, na pasta onde está este arquivo:
#   powershell -ExecutionPolicy Bypass -File .\abrir-portas-voz.ps1
#
# O que faz:
#   1) Repassa as portas 7881/TCP e 7882/UDP do Windows para a VM (192.168.100.10)
#   2) Libera essas portas no Firewall do Windows
# Depois disso, falta só o roteador repassar as mesmas portas para este PC.

param([switch]$Desfazer)

$VmIp  = '192.168.100.10'
$Ports = @(
  @{ Protocol = 'TCP'; Port = 7881 },
  @{ Protocol = 'UDP'; Port = 7882 }
)

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Abra o PowerShell como Administrador (botão direito > Executar como administrador).' -ForegroundColor Red
  exit 1
}

# Acha a rede NAT da VM (a que cobre 192.168.100.x).
$nat = Get-NetNat | Where-Object { $_.InternalIPInterfaceAddressPrefix -like '192.168.100.*' } | Select-Object -First 1
if (-not $nat) {
  Write-Host 'Não achei a rede NAT 192.168.100.0/24 (a "RedeFixa"). Redes NAT existentes:' -ForegroundColor Red
  Get-NetNat | Format-Table Name, InternalIPInterfaceAddressPrefix
  exit 1
}
Write-Host "Rede NAT encontrada: $($nat.Name) ($($nat.InternalIPInterfaceAddressPrefix))"

if ($Desfazer) {
  foreach ($p in $Ports) {
    Get-NetNatStaticMapping -NatName $nat.Name -ErrorAction SilentlyContinue |
      Where-Object { $_.ExternalPort -eq $p.Port -and $_.Protocol -eq $p.Protocol } |
      Remove-NetNatStaticMapping -Confirm:$false
    Get-NetFirewallRule -DisplayName "Nexo voz $($p.Protocol) $($p.Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  }
  Write-Host 'Portas de voz fechadas de novo.' -ForegroundColor Green
  exit 0
}

foreach ($p in $Ports) {
  # Remove regra antiga igual (para poder rodar o script de novo sem erro).
  Get-NetNatStaticMapping -NatName $nat.Name -ErrorAction SilentlyContinue |
    Where-Object { $_.ExternalPort -eq $p.Port -and $_.Protocol -eq $p.Protocol } |
    Remove-NetNatStaticMapping -Confirm:$false

  Add-NetNatStaticMapping -NatName $nat.Name -Protocol $p.Protocol `
    -ExternalIPAddress '0.0.0.0' -ExternalPort $p.Port `
    -InternalIPAddress $VmIp -InternalPort $p.Port | Out-Null

  $ruleName = "Nexo voz $($p.Protocol) $($p.Port)"
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol $p.Protocol -LocalPort $p.Port -Profile Any | Out-Null

  Write-Host "OK: porta $($p.Port)/$($p.Protocol) -> $($VmIp):$($p.Port) e liberada no firewall" -ForegroundColor Green
}

$lan = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -like '192.168.*' -and $_.IPAddress -notlike '192.168.100.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1).IPAddress
Write-Host ''
Write-Host "Agora, no roteador, encaminhe 7881/TCP e 7882/UDP para este PC: $lan" -ForegroundColor Yellow
Write-Host 'Para desfazer tudo: rode  .\abrir-portas-voz.ps1 -Desfazer'
