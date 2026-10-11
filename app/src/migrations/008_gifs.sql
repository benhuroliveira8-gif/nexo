-- GIFs: a mensagem guarda só o endereço do GIF escolhido (o arquivo fica no KLIPY).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS gif jsonb;
