# Administração do Nexo

## Quem é administrador

- A **primeira conta criada** no Nexo vira administradora sozinha.
- No painel (menu do seu nome → **Administração do Nexo** → *Contas*) dá para tornar outras pessoas admin.
- Também dá para forçar pelo `.env`: `NEXO_ADMINS=ben,fulano` (nomes de usuário, separados por vírgula).

## Esqueci a senha

Dois jeitos, ambos na tela de entrar → **Esqueci a senha**:

1. **Chave de recuperação** (a própria pessoa): em ⚙️ → *Segurança* → *Criar chave de recuperação*.
   Aparece uma vez; guarde num papel ou gerenciador de senhas. Vale uma vez.
2. **Código da administração**: no painel → *Contas* → **Código p/ senha nova**. Vale 24 horas, uma vez.
   Passe o código para a pessoa por um lugar seguro.

Quem tem verificação em duas etapas (2FA) continua precisando do código do app para entrar.

## Bloquear

*Contas* → **Bloquear** (com motivo opcional). A pessoa sai de todos os aparelhos e não consegue
mais entrar; vê o motivo na tela de entrar. As mensagens dela continuam. **Desbloquear** volta tudo.

## Disco

*Visão geral e disco* mostra quanto o disco da VM está cheio e o que ocupa espaço.

- **Limpeza automática**: apaga só o ARQUIVO de anexos com mais de N dias (a mensagem fica com o
  aviso "arquivo antigo removido"). Fotos de perfil, ícones, capas, figurinhas e sons nunca são apagados.
  0 = nunca apaga (padrão).
- **Aviso**: quando o disco passa de X% (padrão 85%), as contas admin recebem uma notificação.
- **Limpar agora**: apaga na hora os anexos com mais de N dias.

## Atualização sem derrubar ninguém

O Jenkins manda o sinal `SIGUSR2` para o app antes do deploy. Todo mundo vê
"O Nexo vai atualizar em 20 s"; o app espera e só então é trocado. Quem estava em chamada volta
sozinho e o navegador recarrega na versão nova quando a pessoa não está no meio de algo
(se estiver numa chamada, aparece o botão "Recarregar agora").

## "Ouvindo" automático (Last.fm) — opcional

1. Crie uma conta em https://www.last.fm/api/account/create (nome do app: `Nexo`). Copie a **API key**.
2. Na VM, dentro da pasta do Nexo (a chave não aparece enquanto você cola):

```bash
read -rsp "Chave do Last.fm: " K && echo && printf '\nLASTFM_API_KEY=%s\n' "$K" >> .env && unset K
```

3. **Atualize a credencial `nexo-env` no Jenkins** com o `.env` novo e rode o job `nexo`.
4. Cada pessoa: ⚙️ → *Minha conta* → **"Ouvindo" automático** → usuário do Last.fm (e conecta o
   Spotify ao Last.fm em last.fm → Configurações → Aplicativos).
