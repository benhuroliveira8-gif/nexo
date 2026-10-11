# Controle remoto pela tela compartilhada

Quem assiste a uma tela compartilhada pode pedir para usar o mouse e o teclado
do PC de quem compartilha (estilo AnyDesk). Só funciona no **Windows** de quem compartilha.

## Como funciona

1. Quem compartilha a **tela inteira** abre o programinha **Nexo Controle** (ver abaixo).
2. Quem assiste passa o mouse na tela e clica em **🖱️** (Pedir controle).
3. Quem compartilha recebe "Fulano quer controlar o seu PC" e clica em **Permitir**.
4. Quem assiste usa o mouse e o teclado em cima da tela (clique na tela para o teclado).
5. Para encerrar: **✋** (quem controla), **Parar controle** ou **Ctrl+Alt+End** (quem é controlado).

O mouse de quem é controlado tem prioridade: se ele mexer, os comandos de fora param na hora.

## Instalar o Nexo Controle (quem vai ser controlado)

1. No Nexo: ⚙️ → Voz e vídeo → **Baixar Nexo Controle** (ou pelo botão na janela do pedido).
2. Clique com o botão direito no `nexo-controle.ps1` baixado → **Executar com o PowerShell**
   (no Windows 11 pode estar em "Mostrar mais opções").
3. Na primeira vez ele cria o atalho **Nexo Controle** na Área de Trabalho.
4. Deixe a janela aberta enquanto quiser poder ser controlado. Fechou = desligou.
5. Se o navegador perguntar sobre acessar "apps e serviços neste dispositivo", clique em **Permitir**.

Desinstalar: `powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\NexoControle\nexo-controle.ps1" -Desinstalar`

## Segurança

- Nada acontece sem clicar em **Permitir**; só a pessoa autorizada é obedecida.
- O programa só escuta no próprio PC (127.0.0.1:47800) e só aceita o site do seu Nexo.
- Não abre porta nenhuma para a internet. Os comandos vão pela chamada (LiveKit).

## Limitações

- Não dá para mandar Ctrl+Alt+Del nem a tecla Windows.
- Janelas de administrador (perguntas do UAC, programas "como administrador") não recebem os comandos.
- Compartilhando só uma janela ou aba, o controle não é liberado (precisa da tela inteira).
- Teclados diferentes (ABNT2 x americano): vale a tecla física; o caractere é o do PC controlado.
