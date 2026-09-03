# Teste SFU local — EntreTelas

Laboratório isolado do aplicativo atual. Usa LiveKit Server 1.13.6 para Windows x64;
download oficial com validação SHA-256. Não acessa LiveKit Cloud ou Cloudflare TURN.
As dependências ficam nesta pasta, sem modificar as dependências de produção.

## Preparar e iniciar

Dentro desta pasta, com Node.js instalado:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

Depois abra `Iniciar teste local.cmd` com dois cliques. O terminal permanece aberto;
Ctrl+C encerra o processo e o servidor de mídia filho. Não há serviço de inicialização automática.

Abra http://localhost:8790 em duas abas. Entre com nomes diferentes, clique em
Compartilhar em uma delas e escolha explicitamente uma origem. A outra recebe vídeo
pelo SFU. Duplo clique no vídeo abre tela cheia; arraste o canto do cartão para redimensionar.
O botão Parar e o botão de encerramento do navegador param a captura.

O teste usa preferência 1080p60, teto de 8 Mbps, VP8 e sem simulcast ou áudio para
reduzir variáveis. Não promete 60 FPS. A seção Diagnóstico mostra FPS, resolução e
bitrate de envio/recepção, motivo de limitação e tempo de codificação quando disponíveis.
O servidor distribui a publicação; não transforma um vídeo capturado a 40 FPS em 60 FPS.

## Validação reproduzível

Com o servidor aberto e Google Chrome instalado:

```powershell
node smoke.mjs
```

Esse teste abre dois clientes headless, gera vídeo sintético (não captura a tela),
confirma decodificação no espectador, remoção da track ao parar e rejeição de pedidos
de token sem origem autorizada. Não representa desempenho de captura de um jogo.

## Limites desta etapa

- **Somente este PC.** HTTP e sinalização ligados em loopback. Não encaminhe 8790 ou 7880 no roteador.
- Tokens curtos, chaves aleatórias em memória e autorização somente para tracks de tela.
- A interface não possui câmera, microfone, arquivos ou controle remoto.
- Não altera salas, autenticação, configuração TURN, app ou deploy do Render.
- O LiveKit avisa que monitoramento automático de CPU/capacidade não é suportado
  neste Windows. Isso não impediu o teste de mídia; não usar como servidor de grande escala.
- O teste possui no máximo oito participantes. Rodar dois clientes no mesmo PC
  acrescenta carga e não substitui o teste em computadores separados.

## Próxima etapa: amigos pela internet

Ainda precisa ser implementada e validada: endereço HTTPS/WSS com certificado confiável,
autenticação do teste externo, reserva DHCP para o PC, anúncio do endereço público e
regras específicas de firewall/roteador. Não expor o emissor de tokens local como está.

As portas de mídia configuradas são **7882 UDP** e **7881 TCP**. O acesso web seguro
precisará de uma porta HTTPS definida junto com o certificado/proxy. Não abrir faixas
amplas nem ativar DMZ. Falhas de acesso direto ao SFU ainda podem exigir uma solução
de relay; esta etapa não contém fallback pago automático.

Documentação: https://docs.livekit.io/transport/self-hosting/ports-firewall/
