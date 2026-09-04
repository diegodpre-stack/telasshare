# EntreTelas — compartilhamento privado de tela

Primeira versão funcional de compartilhamento privado de tela. O navegador do transmissor exige clique explícito e escolha manual da tela. O projeto não oferece controle remoto, clipboard, arquivos nem captura silenciosa.

O aplicativo aceita várias transmissões simultâneas: uma tela pode ser enviada para vários amigos, cada pessoa pode transmitir enquanto assiste outras telas, e o painel oferece tamanhos Pequeno, Médio e Grande, além de tela cheia por transmissão.

O áudio depende da origem e do navegador: uma aba pode fornecer apenas o próprio som; uma tela inteira pode fornecer o áudio do sistema; e, para janelas, o aplicativo solicita áudio somente da janela quando o navegador oferece esse recurso. Avisos de captura exibidos pelo navegador são controles de segurança e não podem ser ocultados pelo site. A sinalização mantém o SDP nativo para compatibilidade entre Chrome e Firefox e tenta reiniciar o ICE quando uma conexão em andamento perde a rota de rede.

O cliente envia um heartbeat de sinalização a cada 20 segundos. Se o WebSocket cair por oscilação de rede ou substituição da instância no Render, ele reconecta com espera progressiva sem encerrar imediatamente as tracks e conexões WebRTC. O identificador da sessão permanece estável durante a reconexão, permitindo que a negociação e a recuperação do ICE continuem.

Usuários comuns entram no site apenas escolhendo um nome. O lobby atualiza automaticamente e mostra somente os nomes das salas disponíveis; participantes, presença, transmissões e sinalização WebRTC só ficam disponíveis após a senha da sala ser validada. Salas que permanecem vazias por 15 segundos são removidas. Dentro dela, a pessoa inicia a própria tela uma vez e qualquer participante pode clicar em **Assistir**, sem novo pedido de autorização. Não há limite artificial de participantes; a capacidade prática depende da conexão e da máquina dos transmissores.

## Requisitos

- Node.js 20 ou mais recente
- npm 10 ou mais recente
- Chrome, Edge ou Firefox atualizados
- Para dois PCs, ambos precisam alcançar o computador que executa o servidor

## Teste rápido no mesmo computador

No Windows, depois da primeira instalação, você também pode abrir `Abrir EntreTelas.bat` com dois cliques. O iniciador encontra a pasta automaticamente, prepara o projeto quando necessário, abre o navegador e mantém o servidor ativo enquanto a janela permanecer aberta.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Abra `http://localhost:5173` em duas janelas ou perfis do navegador. Entre com nomes diferentes, crie uma sala na primeira janela e clique nela para entrar pela segunda.

## Dois PCs na mesma rede (recomendado: HTTPS)

`getDisplayMedia` exige contexto seguro fora de `localhost`. No PC que será o servidor, instale o [mkcert](https://github.com/FiloSottile/mkcert), descubra o IP local (exemplo: `192.168.1.50`) e execute na pasta do projeto:

```powershell
mkcert -install
mkcert 192.168.1.50 localhost 127.0.0.1
Copy-Item .env.example .env
```

Edite `.env` e use os nomes exatos dos arquivos criados pelo mkcert:

```dotenv
CLIENT_ORIGIN=https://192.168.1.50:5173,https://localhost:5173
VITE_SIGNAL_URL=wss://192.168.1.50:8787
VITE_HTTPS_CERT_PATH=./192.168.1.50+2.pem
VITE_HTTPS_KEY_PATH=./192.168.1.50+2-key.pem
TLS_CERT_PATH=./192.168.1.50+2.pem
TLS_KEY_PATH=./192.168.1.50+2-key.pem
```

Depois:

```powershell
npm install
npm run dev
```

Libere as portas TCP `5173` e `8787` no firewall do PC servidor. Nos dois PCs, abra `https://192.168.1.50:5173`. O certificado raiz do mkcert precisa ser confiável nos dois dispositivos; copie e instale a CA raiz no segundo PC, ou use um certificado válido para um domínio local.

## Pela internet

O deploy automático do Render está ativado em `render.yaml` e no painel (Auto-Deploy: On Commit). Cada push para `main` publica a nova versão automaticamente. O deploy reinicia o servidor e pode interromper salas e transmissões em uso.

### Opção simples: Render

O arquivo `render.yaml` deixa o projeto pronto para o Render. Coloque esta pasta em um repositório GitHub e, no painel do Render, escolha **New > Blueprint**, conecte o repositório e confirme a criação do serviço. O Render executará a instalação, o build e `npm start`, fornecendo um endereço `https://...onrender.com`. O frontend usa automaticamente `wss://` no mesmo endereço.

No plano gratuito, o serviço pode dormir após 15 minutos sem tráfego e levar cerca de um minuto para acordar. Ele é adequado para testes e uso ocasional, não para uma versão de produção.

### Aplicativo para Windows

O site oferece em todas as telas uma versão portátil (`EntreTelas-Portable.exe`), que abre sem instalação, e um instalador Windows 64-bit opcional. O aplicativo Electron abre o mesmo serviço hospedado no Render, portanto usuários do navegador e do aplicativo entram nas mesmas salas e assistem às mesmas transmissões. Ele inclui seu próprio mecanismo Chromium e não depende de Edge, Chrome ou WebView2 instalados.

Ao iniciar uma captura no aplicativo, o seletor mostra as telas e janelas disponíveis. Nada pode iniciar a captura silenciosamente. Tela inteira pode incluir todo o áudio do sistema. No Windows 10 build 20348 ou posterior, uma janela usa um capturador WASAPI nativo por processo: ele inclui a árvore de processos do aplicativo escolhido e exclui Discord e outros programas. Se esse recurso não estiver disponível, a janela é transmitida sem áudio em vez de usar silenciosamente o áudio completo do computador. Na versão web, selecione uma guia no Chrome/Edge para compartilhar apenas o áudio dela.

Cada push na branch `main` executa `.github/workflows/desktop-release.yml`, gera uma versão nova e publica `EntreTelas-Portable.exe` e `EntreTelas-Setup.exe` nas Releases do GitHub. A versão instalada verifica essa fonte ao abrir, baixa atualizações em segundo plano e oferece reinicialização imediata quando a nova versão fica pronta. A versão portátil precisa ser substituída por um novo download quando houver atualização. Sem um certificado comercial de assinatura, o Windows pode exibir o aviso de editor desconhecido na primeira execução.

Por padrão, `npm run desktop` abre o site publicado, não os arquivos locais. Para testar alterações do frontend no Electron sem publicar, execute em um terminal:

```powershell
npm run build
npm start
```

Em outro terminal, na mesma pasta:

```powershell
$env:ENTRETELAS_APP_URL = 'http://localhost:8787'
npm run desktop
```

O endereço alternativo aceita apenas loopback e é ignorado no aplicativo empacotado. Abra `http://localhost:8787` no navegador para entrar como espectador. Para verificar o encoder, use uma transmissão nova com movimento na tela, escolha **Automático** ou **H.264** e confira **Implementação** e **Encoder eficiente informado** no diagnóstico. A consulta de capacidade por perfil é uma indicação, não uma garantia; `OpenH264` é software, enquanto `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)` identifica o encoder NVIDIA. Hardware não garante, por si só, mais FPS na captura ou na prévia.

#### Compatibilidade de captura e H.264

A captura zero-copy e a codificação por hardware são independentes. O desktop agora deixa `ZeroCopyDesktopCapture` desativado por padrão, mas continua permitindo encoders de hardware e priorizando os perfis eficientes informados pelo navegador. Isso evita forçar o caminho experimental de captura em todas as GPUs; não é uma confirmação de que um problema específico de driver foi corrigido. As proteções de drivers do Chromium continuam ativas.

Essa alteração exige reiniciar o desktop com o código novo (ou instalar uma nova versão empacotada); atualizar somente o site não altera as flags do processo. O diagnóstico mostra a política de captura, o perfil H.264 negociado e os contadores de quadros codificados/recebidos/decodificados. O relatório mantém eventos de encerramento da captura e falhas de negociação mesmo depois que a transmissão desaparece, além de falhas do processo GPU no desktop novo. Não inclui conteúdo da tela, SDP, IPs ou mensagens brutas de exceções.

Para comparar a captura experimental em um teste controlado, use `$env:ENTRETELAS_GPU_CAPTURE = '1'` antes de iniciar o desktop. Remova a variável para voltar ao novo padrão. O valor legado `0` também restaura a política padrão do Chromium que pode preferir software em resoluções baixas; não use esse valor para verificar que o encoder permanece em hardware. Nenhuma dessas configurações garante suporte ou estabilidade em um driver específico.

Testes de regressão: `node scripts/test-encoder-support.mjs`, `node scripts/test-media-runtime.mjs` e `node scripts/test-media-diagnostics.mjs`. A validação real deve conferir quadros decodificados e imagem no receptor, além de `powerEfficientEncoder` no transmissor. Um teste NVIDIA→NVIDIA não comprova compatibilidade AMD→NVIDIA ou NVIDIA→AMD.

Para voltar ao serviço publicado ou gerar o instalador:

```powershell
Remove-Item Env:ENTRETELAS_APP_URL -ErrorAction SilentlyContinue
npm run desktop
npm run desktop:dist
```

### Salas privadas

O Blueprint gera `SESSION_SECRET` automaticamente. Não existe senha geral para usuários comuns: basta escolher um nome. Depois desse login, o lobby mostra os nomes das salas, mas não mostra participantes nem transmissões. Qualquer usuário pode criar uma sala e escolher sua senha; os amigos clicam nela e informam essa senha para entrar. O login fica salvo no navegador por até 30 dias. O servidor limita tentativas de login incorretas e não permite dois usuários com o mesmo nome dentro da mesma sala.

As salas ficam somente na memória nesta versão. Se o Render reiniciar ou adormecer o serviço gratuito, elas desaparecem e precisam ser criadas novamente; a interface descartará a sessão antiga na próxima tentativa. As senhas são armazenadas em memória com `scrypt`, salt individual e nunca são enviadas para outros participantes.

Nunca coloque `SESSION_SECRET` nem o arquivo `.env` no Git.

1. Publique o frontend com HTTPS e defina `VITE_SIGNAL_URL=wss://seu-dominio-de-sinalizacao` antes de `npm run build`.
2. Publique o servidor Node em uma hospedagem que aceite WebSocket e configure `CLIENT_ORIGIN=https://seu-frontend`.
3. Use HTTPS/WSS com certificado válido (`TLS_CERT_PATH` e `TLS_KEY_PATH` quando o TLS terminar no próprio Node; deixe vazios quando um proxy como Caddy/Nginx fizer a terminação TLS).
4. Para usar o Cloudflare Realtime TURN como fallback protegido por limite mensal, crie uma chave TURN e um token de API com permissão de leitura `Account Analytics`. Adicione estas variáveis secretas no backend/Render:

```dotenv
CLOUDFLARE_TURN_KEY_ID=id-da-chave-turn
CLOUDFLARE_TURN_API_TOKEN=token-secreto-da-chave-turn
CLOUDFLARE_ACCOUNT_ID=id-da-conta-cloudflare
CLOUDFLARE_ANALYTICS_API_TOKEN=token-com-permissao-account-analytics
TURN_MONTHLY_LIMIT_GB=800
TURN_ENABLED=true
```

O fallback pode ser desligado sem remover nenhuma credencial definindo `TURN_ENABLED=false` (ou removendo a variável). Para reativá-lo, basta voltar o valor para `true` e fazer um novo deploy. Com ele desligado, as transmissões usam somente STUN/P2P. A prévia do transmissor mostra protocolo, latência, banda estimada e eventual motivo de limitação para ajudar a comparar as rotas.

Antes de fornecer qualquer credencial, o backend consulta na própria Cloudflare a saída mensal da chave TURN. Ao atingir 800 GB, ele bloqueia novas credenciais; os clientes também verificam o estado a cada cinco minutos e encerram conexões auxiliares ativas. A margem de 200 GB cobre atraso de métricas e tráfego ainda em andamento. Se a consulta falhar ou alguma variável de proteção estiver ausente, o sistema falha de forma segura e fornece somente STUN/P2P. O limite é uma proteção conservadora do aplicativo, mas a medição da Cloudflare não deve ser tratada como um teto financeiro contratual absoluto.

As credenciais temporárias duram uma hora e a chave permanente nunca é enviada ao navegador. O WebRTC mantém `iceTransportPolicy: all`: tenta conexão direta P2P e usa o TURN somente quando necessário. P2P permanece disponível mesmo quando o TURN é bloqueado.

As variáveis `VITE_TURN_*` permanecem disponíveis exclusivamente para testes locais com outro provedor. Elas ficam embutidas no frontend e nunca devem receber uma chave permanente de produção.

5. Gere e execute:

```powershell
npm install
npm run build
npm start
```

## Presets de transmissão

- Resolução: Auto, 720p, 1080p e 1440p
- FPS: 30, 60 e 120 (preferência; o valor real depende do navegador, display, GPU e rede)
- Bitrate: Baixa 2,5 Mbps, Média 8 Mbps, Alta 14 Mbps ou valor personalizado

As preferências são aplicadas nas constraints de `getDisplayMedia` e, quando o navegador permite, em `RTCRtpSender.setParameters()` com `maxBitrate` e `maxFramerate`. A interface tenta mostrar o FPS efetivo usando configurações da track e estatísticas WebRTC.

## Limites e segurança desta primeira versão

- Identidade por nome é simples; o acesso à sala depende do conhecimento do nome e da senha.
- Sessões são assinadas, vinculadas a uma única sala e expiram em até 30 dias.
- O backend valida tipos, destinos, tamanho e formato básico das mensagens WebSocket.
- O servidor rejeita qualquer presença, moderação ou sinalização WebRTC destinada a outra sala.
- Nenhuma mensagem remota consegue chamar `getDisplayMedia`; isso só ocorre no clique **Iniciar transmissão** do transmissor.
- Ao parar, fechar a aba, perder o peer ou encerrar a captura nativa, tracks e `RTCPeerConnection` são fechados.
- Cada espectador usa uma conexão WebRTC independente. A banda de upload do transmissor cresce aproximadamente uma vez por espectador; para grupos grandes, a evolução recomendada é usar uma SFU.
- Para uso público real, adicione contas persistentes, banco de dados e recuperação de salas.
