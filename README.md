# TelasShare — compartilhamento privado de tela

Compartilhamento privado de tela entre amigos, com voz, conversa e envio de arquivos dentro da sala. Transmitir exige clique explícito e escolha manual da tela. O projeto não oferece controle remoto, clipboard nem captura silenciosa.

O aplicativo aceita várias transmissões simultâneas: uma tela pode ser enviada para vários amigos, cada pessoa pode transmitir enquanto assiste outras telas, e o painel oferece tamanhos Pequeno, Médio e Grande, além de tela cheia por transmissão.

O áudio depende da origem e do navegador: uma aba pode fornecer apenas o próprio som; uma tela inteira pode fornecer o áudio do sistema; e, para janelas, o aplicativo solicita áudio somente da janela quando o navegador oferece esse recurso. Avisos de captura exibidos pelo navegador são controles de segurança e não podem ser ocultados pelo site. A sinalização mantém o SDP nativo para compatibilidade entre Chrome e Firefox e tenta reiniciar o ICE quando uma conexão em andamento perde a rota de rede.

O cliente envia um heartbeat de sinalização a cada 20 segundos. Se o WebSocket cair por oscilação de rede ou reinício do servidor, ele reconecta com espera progressiva sem encerrar imediatamente as tracks e conexões WebRTC. O identificador da sessão permanece estável durante a reconexão, permitindo que a negociação e a recuperação do ICE continuem.

Usuários comuns entram no site apenas escolhendo um nome. O lobby atualiza automaticamente e mostra somente os nomes das salas disponíveis; participantes, presença, transmissões e sinalização WebRTC só ficam disponíveis após a senha da sala ser validada. Dentro dela, a pessoa inicia a própria tela uma vez e qualquer participante pode clicar em **Assistir**, sem novo pedido de autorização. Não há limite artificial de participantes; a capacidade prática depende da conexão e da máquina dos transmissores.

Uma sala pode ser **temporária** ou **permanente**. A temporária vive só na memória e desaparece 15 segundos depois que a última pessoa sai, que era o único comportamento das versões anteriores. A permanente guarda a conversa e os arquivos, e continua existindo entre um encontro e outro.

Dentro da sala há também **voz** e **conversa por texto**, cada uma no seu painel. Os painéis podem ser redimensionados e arrastados para onde a pessoa preferir, empilhados em colunas, e a disposição escolhida fica salva naquele navegador.

## Requisitos

- Node.js 20 ou mais recente
- npm 10 ou mais recente
- Chrome, Edge ou Firefox atualizados
- Para dois PCs, ambos precisam alcançar o computador que executa o servidor

## Teste rápido no mesmo computador

No Windows, depois da primeira instalação, você também pode abrir `Abrir TelasShare.bat` com dois cliques. O iniciador encontra a pasta automaticamente, prepara o projeto quando necessário, abre o navegador e mantém o servidor ativo enquanto a janela permanecer aberta.

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

O servidor roda em uma máquina da Oracle Cloud, em `https://telasshare.duckdns.org`, com o Caddy à frente cuidando do certificado. O Node escuta apenas em `127.0.0.1`, de modo que nada chega nele sem passar pelo Caddy.

### Como está montado

- **Máquina**: Oracle Cloud Always Free, Ubuntu 24.04, 150 GB de disco. O serviço é `telasshare.service`, com `systemd` reiniciando em caso de queda.
- **Banco**: MongoDB Atlas, camada gratuita, na mesma região da máquina. Guarda as salas permanentes e suas conversas; uma sala temporária nunca o toca. Sem `MONGODB_URI` o site continua funcionando, apenas sem salas permanentes.
- **Arquivos**: no disco da máquina, em `FILES_DIR`, uma pasta por sala. Vão embora junto com a sala.
- **Relay**: Cloudflare Realtime, com um teto mensal em `TURN_MONTHLY_LIMIT_GB`. Ao chegar nele o servidor deixa de oferecer relay e o P2P continua.
- **Site**: `npm run build` é feito fora da máquina e o `dist/` é enviado pronto, porque 1 GB de memória não comporta o Vite.

Um build pode ser apontado para outro servidor sem publicar nada, o que serve para testar uma máquina nova com o aplicativo de verdade:

```bash
npm run desktop:test -- https://outro-servidor.exemplo
```

O `render.yaml` continua no repositório: o projeto sobe no Render sem alteração nenhuma, o que é uma saída caso a máquina precise ser trocada às pressas. O plano gratuito de lá dorme após alguns minutos sem tráfego e leva cerca de um minuto para acordar.

### Aplicativo para Windows

O site oferece em todas as telas uma versão portátil (`TelasShare-Portable.exe`), que abre sem instalação, e um instalador Windows 64-bit opcional. O aplicativo Electron abre o mesmo serviço hospedado na Oracle, portanto usuários do navegador e do aplicativo entram nas mesmas salas e assistem às mesmas transmissões. Ele inclui seu próprio mecanismo Chromium e não depende de Edge, Chrome ou WebView2 instalados.

Ao iniciar uma captura no aplicativo, o seletor mostra as telas e janelas disponíveis. Nada pode iniciar a captura silenciosamente. Tela inteira pode incluir todo o áudio do sistema. No Windows 10 build 20348 ou posterior, uma janela usa um capturador WASAPI nativo por processo: ele inclui a árvore de processos do aplicativo escolhido e exclui Discord e outros programas. Se esse recurso não estiver disponível, a janela é transmitida sem áudio em vez de usar silenciosamente o áudio completo do computador. Na versão web, selecione uma guia no Chrome/Edge para compartilhar apenas o áudio dela.

O aplicativo se chamava EntreTelas até a versão 0.1.84. O `appId` (`com.entretelas.desktop`), as chaves de `localStorage` (`entretelas-*`) e as variáveis `ENTRETELAS_*` mantêm o nome antigo de propósito: o `appId` é a identidade da instalação para o Windows, e trocá-lo faria a próxima atualização instalar uma segunda cópia ao lado da primeira; renomear as chaves apagaria o nome e as preferências de quem já usa.

Cada push na branch `main` executa `.github/workflows/desktop-release.yml`, gera uma versão nova e publica `TelasShare-Portable.exe` e `TelasShare-Setup.exe` nas Releases do GitHub. A versão instalada verifica essa fonte ao abrir, baixa atualizações em segundo plano e oferece reinicialização imediata quando a nova versão fica pronta. A versão portátil precisa ser substituída por um novo download quando houver atualização. Sem um certificado comercial de assinatura, o Windows pode exibir o aviso de editor desconhecido na primeira execução.

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

O endereço alternativo aceita apenas loopback e é ignorado no aplicativo empacotado. Abra `http://localhost:8787` no navegador para entrar como espectador. Para voltar ao serviço publicado, remova a variável:

```powershell
Remove-Item Env:ENTRETELAS_APP_URL -ErrorAction SilentlyContinue
npm run desktop
```

Gerar o instalador localmente exige o GStreamer instalado, porque `scripts/bundle-gstreamer.mjs` copia o runtime para dentro do pacote:

```powershell
node scripts/bundle-gstreamer.mjs
npm run desktop:dist
```

#### Captura nativa

O aplicativo pode capturar e codificar fora do Chromium, num processo GStreamer separado. O motivo é medido: o Chromium lê cada quadro de volta da GPU para a memória do sistema e o converte para I420 numa única thread antes de qualquer encoder. Em 2560×1440 isso são 14,7 MB por quadro e cerca de 23 ms de trabalho, contra um orçamento de 16,6 ms a 60 FPS — o que trava a captura perto de 41 FPS. O pipeline nativo mantém o quadro na GPU até dentro do encoder; na mesma máquina, a mesma tela sustentou 60 FPS sem quadros perdidos.

A opção fica em **Captura da sua tela**, desligada por padrão, e só aparece onde há um encoder utilizável. O runtime do GStreamer vai dentro do instalador, então não há nada para instalar à parte.

O que muda em relação ao caminho do navegador:

- O bitrate é escolhido no início a partir da resolução e do FPS, e não se adapta à rede depois. O encoder ainda gasta menos em cenas paradas e mais em movimento, mas não recua porque a conexão de alguém piorou.
- A prévia funciona pelo próprio aplicativo assistindo a si mesmo, o que custa um pipeline extra enquanto estiver aberta.
- O diagnóstico não mostra FPS nem rota do lado do envio: essas estatísticas vivem dentro do `webrtcbin`, fora do alcance da página.
- O áudio é o do sistema, menos o do próprio aplicativo — sem isso a transmissão devolveria aos amigos a voz deles mesmos.

Uma janela precisa estar visível para ser capturada. Minimizada, coberta ou em tela cheia exclusiva ela não gera quadros, e o aplicativo avisa em vez de ficar esperando.

Se o pipeline não iniciar, a transmissão usa o caminho do navegador e diz o motivo. Testes de regressão: `node scripts/test-native-capture.mjs`, `node scripts/test-whip-bridge.mjs` e `node scripts/test-native-broadcast.mjs`.

#### Verificar o encoder

O diagnóstico mostra o perfil H.264 negociado e os contadores de quadros codificados, recebidos e decodificados, e mantém eventos de encerramento da captura e falhas de negociação mesmo depois que a transmissão desaparece. Não inclui conteúdo da tela, SDP, IPs nem mensagens brutas de exceções.

Para conferir, use uma transmissão com movimento na tela e olhe **Implementação** e **Encoder eficiente informado**: `OpenH264` é software. A consulta de capacidade por perfil é uma indicação, não uma garantia, e hardware por si só não garante mais FPS na captura. Um teste NVIDIA→NVIDIA não comprova compatibilidade AMD→NVIDIA ou NVIDIA→AMD.

### Salas privadas

Não existe senha geral para usuários comuns: basta escolher um nome. Depois desse login, o lobby mostra os nomes das salas, mas não mostra participantes nem transmissões. Qualquer usuário pode criar uma sala e escolher sua senha; os amigos clicam nela e informam essa senha para entrar. O login fica salvo no navegador por até 30 dias. O servidor recusa novas tentativas após dez erros vindos do mesmo endereço em dez minutos, e não permite dois usuários com o mesmo nome dentro da mesma sala.

As senhas são guardadas com `scrypt` e salt individual, e nunca são enviadas a outros participantes.

Sair de uma sala não obriga a digitar a senha de novo ao voltar. O que fica guardado é a sessão que o servidor emitiu quando a senha foi aceita, presa àquela sala e àquele navegador -- ela não vale em outro computador nem no aplicativo, onde a senha é pedida uma vez. Sair do site descarta todas elas.

#### Quem manda na sala

Quem cria é o dono, e só ele apaga na hora. O dono pode nomear co-donos, que conseguem apenas iniciar uma contagem de três dias, que o dono cancela até o fim do prazo. Apagar exige a senha da sala além da posse: sem contas, um nome é só um nome, e destruir não é o menor dos atos.

A posse é reconhecida por sessão **ou** por nome, de modo que a mesma pessoa em outro computador continua sendo dona. É uma troca deliberada, e a razão de a senha ser pedida de qualquer forma.

Uma sala permanente que passe sessenta dias sem ninguém entrar é apagada. Qualquer visita zera essa contagem, não só a do dono.

#### Arquivos e fotos

Dentro de uma sala permanente é possível enviar arquivos, que aparecem na conversa. Ficam no disco do servidor, em uma pasta por sala, e vão embora junto com a sala.

O tipo é lido dos bytes e não do nome: apenas uma lista curta de formatos é exibida na própria página, e todo o resto -- um SVG inclusive, porque SVG carrega script -- é entregue como download. Os endereços são assinados e de prazo curto, porque uma tag `<img>` não consegue enviar cabeçalho de autorização e um link que nunca expira é um link que vaza uma vez e serve para sempre.

#### Voz

A voz usa uma conexão de áudio separada por par, com Opus e DTX. Há silenciar, ensurdecer e volume individual de cada pessoa, de 0 a 200%.

O microfone passa por um portão que decide o que é fala pela variação do sinal, e não pelo volume: um ventilador constante logo acima do limite não o abre, enquanto uma voz abre. Há também supressão de ruído por RNNoise, que roda no próprio navegador.

Nunca coloque `SESSION_SECRET` nem o arquivo `.env` no Git.

1. Publique o frontend com HTTPS e defina `VITE_SIGNAL_URL=wss://seu-dominio-de-sinalizacao` antes de `npm run build`.
2. Publique o servidor Node em uma hospedagem que aceite WebSocket e configure `CLIENT_ORIGIN=https://seu-frontend`.
3. Use HTTPS/WSS com certificado válido (`TLS_CERT_PATH` e `TLS_KEY_PATH` quando o TLS terminar no próprio Node; deixe vazios quando um proxy como Caddy/Nginx fizer a terminação TLS).
4. Para usar o Cloudflare Realtime TURN como fallback protegido por limite mensal, crie uma chave TURN e um token de API com permissão de leitura `Account Analytics`. Adicione estas variáveis ao `.env` do servidor:

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

As credenciais temporárias duram uma hora e a chave permanente nunca é enviada ao navegador. Por padrão o WebRTC tenta a conexão direta e recorre ao TURN só quando ela falha, e o P2P continua disponível mesmo com o TURN bloqueado. Antes de clicar em **Assistir** é possível escolher entre **Automático**, **Somente P2P** e **Somente TURN**.

Vale saber o que a escolha significa para a privacidade: em P2P os dois lados enxergam o endereço IP um do outro, o que é inerente a uma conexão direta. Com **Somente TURN**, cada lado vê apenas o endereço do relay da Cloudflare, em troca de latência um pouco maior e de consumo da franquia mensal. A etiqueta de cada transmissão diz qual rota está em uso, e quando não é possível determiná-la ela não diz nada em vez de supor.

As variáveis `VITE_TURN_*` permanecem disponíveis exclusivamente para testes locais com outro provedor. Elas ficam embutidas no frontend e nunca devem receber uma chave permanente de produção.

5. Gere e execute:

```powershell
npm install
npm run build
npm start
```

## Presets de transmissão

- Resolução: Auto, 720p, 1080p e 1440p
- FPS preferido: 30 ou 60 (o valor real depende da tela, da GPU e da rede)
- Codec: Automático, H.264, AV1, VP9 ou VP8
- Áudio: transmitir som ou somente vídeo

A captura sempre usa o tamanho nativo da tela e a redução acontece no envio: pedir um quadro menor na captura obriga o navegador a encolher cada um deles na thread que os produz, e isso custa FPS antes mesmo de codificar.

No caminho do navegador não há escolha de bitrate. O teto é de 20 Mbps por espectador e o Chromium decide o valor real, subindo e descendo conforme a rede — o número que aparece no diagnóstico é o que ele escolheu, não um limite fixo. No caminho nativo o bitrate é derivado da resolução e do FPS, porque nada ali o ajusta depois.

## Limites e segurança desta primeira versão

- Identidade por nome é simples; o acesso à sala depende do conhecimento do nome e da senha.
- Sessões são assinadas, vinculadas a uma única sala e expiram em até 30 dias.
- O backend valida tipos, destinos, tamanho e formato básico das mensagens WebSocket.
- O servidor rejeita qualquer presença, moderação ou sinalização WebRTC destinada a outra sala.
- Nenhuma mensagem remota consegue chamar `getDisplayMedia`; isso só ocorre no clique **Iniciar transmissão** do transmissor.
- Ao parar, fechar a aba, perder o peer ou encerrar a captura nativa, tracks e `RTCPeerConnection` são fechados.
- Cada espectador usa uma conexão WebRTC independente. A banda de upload do transmissor cresce aproximadamente uma vez por espectador; para grupos grandes, a evolução recomendada é usar uma SFU.
- Não há contas: a identidade é o nome digitado, e é a senha da sala que protege o acesso.
- Envios são limitados por arquivo e por sala, e o tamanho é conferido enquanto os bytes chegam, não depois.
- Cada conexão tem um orçamento de mensagens e de bytes; quem passa dele é desconectado sem afetar a sala.
- O endereço IP de quem se conecta serve apenas para limitar tentativas de login, fica em memória e nunca é enviado a outro participante.
- O painel de diagnóstico nunca mostra endereços de candidatos, URLs de servidores ou credenciais.
- Para uso público real, o próximo passo seria contas de verdade com senha.
