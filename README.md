# IPTV Pulse

MVP local para avaliar a qualidade da conexão voltada a IPTV e streaming ao vivo.

## Como executar

1. Abra um terminal nesta pasta.
2. Instale as dependências: `npm install`
3. Inicie o app: `npm run dev`
4. Abra no navegador o endereço exibido (normalmente `http://localhost:5173`).

Para gerar uma versão de produção, execute `npm run build`.

## O que o app mede

- Download e upload por transferência HTTP para um servidor público.
- Ping e jitter aproximados por sete requisições HTTP curtas.
- Latência sob carga por requisições disparadas durante o download.
- Perda estimada pela proporção de falhas nas sondas HTTP.
- Score IPTV de 0 a 100, perfil de qualidade (SD até 4K), explicação de gargalos, histórico local e comparação entre testes.

## Limitações importantes

Navegadores não permitem enviar ping ICMP, UDP ou pacotes de rede diretamente. Por isso, ping, jitter, perda e latência sob carga são indicadores HTTP e aparecem marcados como **estimados** na interface. Eles continuam sendo úteis para uma triagem prática, mas não substituem ferramentas de diagnóstico de roteador ou de operadora.

Os testes dependem de acesso a `speed.cloudflare.com`; firewall corporativo, bloqueador de conteúdo, VPN ou rede restrita podem impedir a conclusão. O histórico fica apenas no `localStorage` deste navegador.
