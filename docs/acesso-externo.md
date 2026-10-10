# Acesso pela internet (domínio + Cloudflare)

Depois deste guia, seus amigos abrem o Nexo de qualquer lugar em um endereço
como **https://nexo.seudominio.com.br**, com cadeado verde de verdade (sem precisar
instalar certificado em nenhum computador).

Como funciona:

```
Amigo (internet) ──HTTPS──> Cloudflare ══túnel══> cloudflared (na VM) ──> caddy:8080 ──> Nexo
```

O túnel é uma conexão que **sai** da sua VM até a Cloudflare. Então:

- não precisa abrir as portas 80/443 no roteador;
- o IP da sua casa não aparece para quem acessa o site;
- o Jenkins (porta 8080 da VM) continua fechado para a internet.

> **Voz e vídeo** são a exceção: o áudio não passa pelo túnel. Para chamadas de
> voz com quem está fora de casa, faça também a **Parte 4**. Mensagens, imagens,
> threads, etc. funcionam só com as Partes 1–3.

---

## Parte 1: comprar o domínio

Escolha **uma** opção:

| Opção | Exemplo | Preço aproximado | Observação |
|---|---|---|---|
| **Cloudflare Registrar** | `meunexo.com` | ~US$ 10/ano | Mais fácil: já fica pronto na Cloudflare (pule a Parte 2). Precisa de cartão internacional. |
| **Registro.br** | `meunexo.com.br` | ~R$ 40/ano | Paga com Pix/boleto. Precisa do CPF. |

(Os preços mudam; confira no site antes de comprar.)

## Parte 2: colocar o domínio na Cloudflare (só se comprou no Registro.br)

1. Crie uma conta grátis em **dash.cloudflare.com**.
2. Clique em **Adicionar um domínio** (ou *Add a domain*), digite `meunexo.com.br`,
   escolha o plano **Free**.
3. A Cloudflare mostra **dois servidores DNS** (algo como `ana.ns.cloudflare.com` e
   `bob.ns.cloudflare.com`). Deixe essa página aberta.
4. Em outra aba, entre no **registro.br** → clique no domínio → **DNS** →
   **Alterar servidores DNS** → apague os que estão lá e cole os dois da Cloudflare → **Salvar**.
5. Volte na Cloudflare e clique em **Verificar**. Pode levar de alguns minutos a algumas horas.
   Quando ficar **Ativo**, siga em frente.

## Parte 3: criar o túnel

1. Na Cloudflare, abra **Zero Trust** (menu da esquerda). Na primeira vez ele pede para
   escolher um nome de equipe e o plano **Free** (pode pedir cartão, mas não cobra).
2. Vá em **Redes → Túneis** (*Networks → Tunnels*; em algumas contas aparece como
   *Connectors → Cloudflare Tunnels*) e clique em **Criar um túnel**.
3. Tipo: **Cloudflared**. Nome: `nexo`. **Salvar**.
4. Na tela de instalação, escolha **Docker**. Aparece um comando assim:

   ```
   docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoiY2Y...
   ```

   **Não rode esse comando.** Copie só o texto depois de `--token ` (começa com `eyJ`).
   Esse é o seu **token**: trate como senha.
5. Clique em **Avançar** e preencha o **Nome do host público** (*Public hostname*):
   - **Subdomínio:** `nexo` (ou deixe vazio para usar o domínio puro)
   - **Domínio:** `meunexo.com.br`
   - **Tipo de serviço:** `HTTP`
   - **URL:** `caddy:8080`

   > ⚠️ Escreva exatamente `caddy:8080`. **Não** use `localhost:8080`: na VM,
   > a porta 8080 é o Jenkins, e você estaria colocando o Jenkins na internet.
6. **Salvar túnel**.

### Ligar o túnel no Nexo

Na VM (pelo terminal do VS Code), na pasta `~/nexo`:

```bash
nano .env
```

Acrescente no final (com o seu token):

```
COMPOSE_FILE=docker-compose.yml:docker-compose.publico.yml
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiY2Y...
REGISTRATION_CODE=uma-palavra-secreta
```

`REGISTRATION_CODE` é o código que a pessoa precisa digitar para criar conta.
Assim, um desconhecido que achar o site não consegue se cadastrar. Passe o código
só para os seus amigos.

Salve (`Ctrl+O`, `Enter`, `Ctrl+X`) e:

1. **Atualize a credencial `nexo-env` no Jenkins** com este `.env` novo
   (Gerenciar Jenkins → Credentials → nexo-env → Update → escolher o arquivo).
   Se pular este passo, o próximo deploy volta para o `.env` antigo e o túnel cai.
2. Suba:

   ```bash
   docker compose up -d --build
   docker compose ps          # deve aparecer "cloudflared" rodando
   docker compose logs cloudflared --tail 20   # procure "Registered tunnel connection"
   ```

3. Abra **https://nexo.meunexo.com.br** no celular, **com o Wi-Fi desligado** (4G),
   para ter certeza de que está funcionando de fora.

## Parte 4: voz e vídeo de fora de casa (opcional)

O áudio vai direto do navegador até a sua casa, nas portas **7881/TCP** e **7882/UDP**.
Isso exige três coisas:

### 4.1 Conferir se a sua internet aceita (CGNAT)

Algumas operadoras colocam várias casas atrás do mesmo IP (CGNAT), e aí ninguém
de fora consegue entrar, nem com as portas abertas.

1. Abra o painel do roteador (geralmente `http://192.168.0.1`) e procure o **IP WAN** / **IP da internet**.
2. Compare com o IP que aparece em **https://meuip.com.br**.
3. **Iguais** → ótimo, siga em frente.
   **Diferentes** (ou o do roteador começa com `100.64` a `100.127`, `10.` ou `192.168.`)
   → é CGNAT. Peça à operadora um **"IP público"** (algumas liberam de graça pelo
   atendimento), ou use o Nexo só para texto quando estiver fora.

### 4.2 Windows: repassar as portas para a VM

No Windows, abra o **PowerShell como Administrador**, vá até a pasta do projeto e rode:

```powershell
cd C:\caminho\da\pasta\nexo\infra\windows
powershell -ExecutionPolicy Bypass -File .\abrir-portas-voz.ps1
```

No final ele mostra o IP do seu PC na rede de casa (ex.: `192.168.0.70`).

### 4.3 Roteador: encaminhar as portas para o PC

No painel do roteador, procure **Encaminhamento de portas**, **Port Forwarding**,
**Servidor Virtual** ou **NAT** e crie duas regras:

| Nome | Protocolo | Porta externa | IP interno | Porta interna |
|---|---|---|---|---|
| Nexo voz TCP | TCP | 7881 | IP do seu PC (ex.: 192.168.0.70) | 7881 |
| Nexo voz UDP | UDP | 7882 | IP do seu PC | 7882 |

> Dica: reserve o IP do PC no roteador (**DHCP estático** / **Reserva de IP**),
> senão ele pode mudar e as regras param de valer.

Pronto: com o `docker-compose.publico.yml` ativo, o servidor de voz descobre sozinho
o IP público da sua casa e o anuncia para quem está fora.

### Se a voz não funcionar

- **Funciona de fora, mas não de dentro de casa** (usando o domínio): o seu roteador
  não suporta *NAT loopback/hairpin*. Em casa, use o endereço local
  (`https://192.168.100.10`) só para a voz, ou ative "NAT Loopback" no roteador, se existir.
- **Não funciona de fora:** confira o CGNAT (4.1), rode o script de novo (4.2) e
  revise as regras do roteador (4.3). Teste a porta TCP em
  **https://portchecker.co** (porta 7881) com o Nexo ligado.
- **O IP de casa mudou:** o servidor de voz descobre o IP novo ao reiniciar:
  `docker compose restart livekit`.

## Desligar o acesso pela internet

No `.env`, apague (ou comente com `#`) a linha `COMPOSE_FILE=...`, atualize a
credencial `nexo-env` no Jenkins e rode `docker compose up -d --remove-orphans`.
O túnel é removido e o Nexo volta a ser só da rede local. Para fechar as portas de voz
no Windows: `.\abrir-portas-voz.ps1 -Desfazer` (e apague as regras do roteador).

## Segurança

- Use **`REGISTRATION_CODE`**: sem ele, qualquer pessoa na internet pode criar conta.
- O login bloqueia por 15 minutos depois de 10 senhas erradas (por IP + usuário).
- Nunca coloque o Jenkins no túnel. O único destino do túnel é `caddy:8080`.
- O token do túnel e o `.env` são segredos: não mande print deles para ninguém.
  Se vazar, apague o túnel na Cloudflare e crie outro.
