# GIFs (KLIPY)

O Nexo pesquisa GIFs no **KLIPY** (https://klipy.com), o serviço que o Discord passou a usar
depois que o Google desligou o Tenor (30/06/2026). É gratuito; só precisa de uma chave.

## 1. Pegar a chave

1. Entre em https://partner.klipy.com e crie uma conta.
2. Vá em **API Keys** → **Add Platform** (tipo *Web*), nome `Nexo`.
3. Copie a chave (**Test key**). Ela permite 100 pesquisas por hora — suficiente para começar.
4. Quando estiver tudo funcionando, peça o **Production access** no mesmo painel (sem limite).

## 2. Colocar no .env

No terminal da VM, dentro da pasta do Nexo (a chave não aparece enquanto você cola):

```bash
read -rsp "Chave do KLIPY: " K && echo && printf '\nKLIPY_API_KEY=%s\n' "$K" >> .env && unset K
```

Opcional: `GIF_RATING=g` (só GIFs livres), `pg`, `pg-13` (padrão) ou `r`.

Depois **atualize a credencial `nexo-env` no Jenkins** com o novo `.env` e rode o job `nexo`.

## Como funciona

- A pesquisa é feita pelo navegador de cada pessoa direto no KLIPY (regra do KLIPY).
  O servidor do Nexo não baixa nem guarda GIFs; a mensagem guarda só o endereço.
- Por isso, quem vê um GIF carrega a imagem dos servidores do KLIPY.
- "Recentes" fica guardado só no navegador de cada pessoa.
- Sem a chave, o botão GIF mostra um aviso e o resto do Nexo funciona normal.
