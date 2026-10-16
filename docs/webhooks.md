# Webhooks: outros sistemas postando num canal

Um webhook é um **link secreto**. Quem mandar uma mensagem para esse link posta num canal do Nexo, com o nome do webhook (ex.: "Jenkins").

## Criar

Menu do servidor (▾) → **🔗 Webhooks** (precisa poder gerenciar canais):

1. Dê um nome (ex.: **Jenkins**) e escolha o canal (ex.: `#deploys`).
2. Clique em **Criar** e **copie o link**. Ele só aparece nesta hora (depois dá para gerar outro, e o antigo para de funcionar).

## Testar no terminal

```bash
curl -H "Content-Type: application/json" -d '{"content":"Olá do webhook! ✅"}' "COLE_O_LINK_AQUI"
```

Também aceita texto puro: `curl -d "Disco da VM em 90%" "COLE_O_LINK_AQUI"`.

Regras: até 30 mensagens por minuto, até 4000 caracteres; @pessoa funciona, @everyone não; sem anexos.

## Jenkins avisando "deploy feito ✅"

O `Jenkinsfile` do Nexo já sabe avisar. Falta só dar o link para ele:

1. Crie o webhook (nome **Jenkins**, canal à sua escolha) e copie o link.
2. Jenkins → *Manage Jenkins* → *Credentials* → *(global)* → **Add Credentials**:
   - **Kind:** Secret text
   - **Secret:** cole o link
   - **ID:** `nexo-webhook`
3. **Create**.

A partir do próximo deploy, aparece no canal:
- ✅ Deploy do Nexo feito: versão nova no ar. (build #N)
- ❌ O deploy do Nexo falhou. Veja o Jenkins (job nexo). (build #N)

Sem a credencial, o Jenkins só escreve "Aviso no Nexo desligado" no log e segue normal.

## Alertas da VM (exemplo)

Um aviso quando o disco passar de 85% (rode `crontab -e` na VM e adicione a linha):

```
*/30 * * * * USO=$(df --output=pcent / | tail -1 | tr -dc 0-9); [ "$USO" -ge 85 ] && curl -s -d "⚠️ Disco da VM em ${USO}\%" "COLE_O_LINK_AQUI" >/dev/null
```

(No crontab o `%` precisa de uma barra antes: `\%`.)

## Segurança

- Quem tiver o link consegue postar no canal. Não coloque o link em lugar público nem no GitHub.
- Vazou? Webhooks → ⋯ → **Gerar link novo** (o antigo para na hora). Lembre de atualizar a credencial `nexo-webhook` no Jenkins.
