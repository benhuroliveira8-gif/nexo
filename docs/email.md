# E-mail no Nexo (confirmação no cadastro e "Esqueci a senha")

O e-mail é **opcional**. Sem ele, o Nexo funciona como antes.

Com ele ligado:
- quem **cria conta** precisa digitar um e-mail e confirmar com um código de 6 dígitos (evita contas falsas);
- o **"Esqueci a senha"** ganha o botão **📧 Mandar um código para o meu e-mail**;
- quem já tinha conta pode adicionar um e-mail em ⚙️ → *Segurança* → *E-mail* (não é obrigatório para contas antigas).

## 1. Criar uma "senha de app" no Gmail

O Nexo manda os e-mails por uma conta sua. Com Gmail:

1. A conta precisa ter a **verificação em duas etapas** ligada (<https://myaccount.google.com/security>).
2. Abra <https://myaccount.google.com/apppasswords>, dê o nome **Nexo** e clique em **Criar**.
3. O Google mostra uma senha de 16 letras. **Não mande essa senha para ninguém** (nem cole em chat). Ela vai só no `.env` da VM.

> Dica: use uma conta Gmail separada só para o Nexo (ex.: `nexo.avisos@gmail.com`).

## 2. Colocar no `.env` da VM

Na VM:

```bash
cd ~/nexo
nano .env
```

Adicione no fim (trocando pelo seu endereço):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=nexo.avisos@gmail.com
SMTP_FROM=Nexo <nexo.avisos@gmail.com>
```

Para a senha, **não digite na tela à vista**. Rode este comando, cole a senha de app (ela não aparece) e aperte Enter:

```bash
read -rsp "Senha de app do Gmail: " P && echo && echo "SMTP_PASS=$P" >> ~/nexo/.env && unset P
```

Confira só os nomes (sem mostrar valores):

```bash
grep -o '^SMTP_[A-Z]*' ~/nexo/.env
```

Tem que aparecer `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` e `SMTP_PASS`.

## 3. Atualizar a credencial do Jenkins

Como o `.env` mudou, atualize a credencial **nexo-env** (o mesmo passo de sempre):

1. No Windows (PowerShell): `scp benhur@192.168.100.10:~/nexo/.env .`
2. Jenkins → *Manage Jenkins* → *Credentials* → **nexo-env** → *Update* → escolha o arquivo `.env` → **Save**.
3. No job **nexo**, clique em **Build Now** (ou *Rerun*).
4. Apague a cópia do Windows: `Remove-Item .env`

## 4. Testar

1. Abra o Nexo numa janela anônima e clique em **Cadastre-se**: o campo **E-mail** deve aparecer.
2. Crie uma conta de teste com um e-mail seu. O código chega em segundos (olhe também o **spam**).
3. Se der erro "Não consegui mandar o e-mail", veja os logs:

```bash
docker logs nexo-app-1 2>&1 | grep -i "e-mail" | tail
```

Erros comuns:
- `535` / "Username and Password not accepted": a senha de app está errada (crie outra).
- Demora e "timeout": a rede bloqueia a porta 587. Tente `SMTP_PORT=465`.

## Outros provedores

Qualquer SMTP serve (Outlook, Brevo, Zoho…). Porta **465** = conexão segura direta; qualquer outra porta usa STARTTLS (obrigatório).
