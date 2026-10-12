# Transcrição das mensagens de voz

## Jeito automático (já vem ligado)

Quando alguém grava um áudio no **Chrome ou Edge** (computador ou Android), o próprio navegador
escreve o que a pessoa fala e o texto vai junto com o áudio. Aparece embaixo do áudio (📝) e a
busca também acha pelo que foi falado.

- Cada pessoa pode desligar em ⚙️ → *Voz e vídeo* → *Mensagens de voz*.
- No Chrome, o reconhecimento de voz usa os servidores do Google.
- No Firefox e em alguns iPhones o navegador não sabe transcrever: o áudio vai sem texto.

## Transcrição no servidor (opcional)

Para transcrever também os áudios de quem usa navegador sem reconhecimento de voz, dá para ligar
o **Whisper** num container (roda na própria VM, nada sai dela). Usa uns 1 a 2 GB de memória e
deixa a CPU ocupada por alguns segundos a cada áudio.

No `.env` da VM (pasta do Nexo), acrescente:

```bash
printf '\nCOMPOSE_PROFILES=transcricao\nWHISPER_URL=http://whisper:9000\n' >> .env
```

(Se o `.env` já tiver `COMPOSE_PROFILES`, junte com vírgula, ex.: `COMPOSE_PROFILES=bots,transcricao`.)

Depois atualize a credencial `nexo-env` no Jenkins e rode o job `nexo`. Na primeira vez ele baixa
o modelo (alguns minutos). Para mais precisão (e mais memória): `WHISPER_MODEL=small`.
