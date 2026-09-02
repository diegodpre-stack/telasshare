# EntreTelas — compartilhamento privado de tela

Primeira versão funcional de compartilhamento de tela entre duas pessoas. O navegador do transmissor exige aceite, clique explícito e escolha manual da tela. O projeto não oferece controle remoto, clipboard, arquivos nem captura silenciosa.

O aplicativo aceita várias transmissões simultâneas: uma tela pode ser enviada para vários amigos, cada pessoa pode transmitir enquanto assiste outras telas, e o painel oferece tamanhos Pequeno, Médio e Grande, além de tela cheia por transmissão.

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

Abra `http://localhost:5173` em duas janelas ou perfis do navegador, entre com nomes diferentes e solicite a tela.

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

### Opção simples: Render

O arquivo `render.yaml` deixa o projeto pronto para o Render. Coloque esta pasta em um repositório GitHub e, no painel do Render, escolha **New > Blueprint**, conecte o repositório e confirme a criação do serviço. O Render executará a instalação, o build e `npm start`, fornecendo um endereço `https://...onrender.com`. O frontend usa automaticamente `wss://` no mesmo endereço.

No plano gratuito, o serviço pode dormir após 15 minutos sem tráfego e levar cerca de um minuto para acordar. Ele é adequado para testes e uso ocasional, não para uma versão de produção.

### Usuário e senha compartilhada

No Render, defina `ROOM_PASSWORD` com a senha que será compartilhada apenas entre seus amigos. O Blueprint gera `SESSION_SECRET` automaticamente. Cada amigo escolhe um nome de usuário diferente e usa a mesma senha. A sessão fica salva no navegador por 30 dias; depois disso, basta digitar a senha novamente. O servidor limita tentativas incorretas e não permite dois usuários online com o mesmo nome.

Nunca coloque `ROOM_PASSWORD`, `SESSION_SECRET` nem o arquivo `.env` no Git.

1. Publique o frontend com HTTPS e defina `VITE_SIGNAL_URL=wss://seu-dominio-de-sinalizacao` antes de `npm run build`.
2. Publique o servidor Node em uma hospedagem que aceite WebSocket e configure `CLIENT_ORIGIN=https://seu-frontend`.
3. Use HTTPS/WSS com certificado válido (`TLS_CERT_PATH` e `TLS_KEY_PATH` quando o TLS terminar no próprio Node; deixe vazios quando um proxy como Caddy/Nginx fizer a terminação TLS).
4. Configure TURN para redes restritas:

```dotenv
VITE_STUN_URLS=stun:stun.l.google.com:19302
VITE_TURN_URLS=turn:turn.seudominio.com:3478?transport=udp,turns:turn.seudominio.com:5349?transport=tcp
VITE_TURN_USERNAME=usuario-temporario
VITE_TURN_CREDENTIAL=segredo-temporario
```

5. Gere e execute:

```powershell
npm install
npm run build
npm start
```

Em produção, prefira credenciais TURN temporárias geradas por um serviço autenticado. As variáveis `VITE_*` ficam embutidas no frontend e não devem conter segredos permanentes.

## Presets de transmissão

- Resolução: Auto, 720p, 1080p e 1440p
- FPS: 30, 60 e 120 (preferência; o valor real depende do navegador, display, GPU e rede)
- Bitrate: Baixa 2,5 Mbps, Média 8 Mbps, Alta 14 Mbps ou valor personalizado

As preferências são aplicadas nas constraints de `getDisplayMedia` e, quando o navegador permite, em `RTCRtpSender.setParameters()` com `maxBitrate` e `maxFramerate`. A interface tenta mostrar o FPS efetivo usando configurações da track e estatísticas WebRTC.

## Limites e segurança desta primeira versão

- Identidade por nome é apenas para desenvolvimento; não é autenticação.
- Pedidos expiram em 60 segundos e a autorização vale somente para aquela sessão.
- O backend valida tipos, destinos, tamanho e formato básico das mensagens WebSocket.
- Nenhuma mensagem remota consegue chamar `getDisplayMedia`; isso só ocorre no clique **Aceitar e escolher tela** do transmissor.
- Ao parar, fechar a aba, perder o peer ou encerrar a captura nativa, tracks e `RTCPeerConnection` são fechados.
- Cada espectador usa uma conexão WebRTC independente. A banda de upload do transmissor cresce aproximadamente uma vez por espectador; para grupos grandes, a evolução recomendada é usar uma SFU.
- Para uso público real, adicione autenticação forte, salas com convite, limite de tentativas, logs mínimos e credenciais TURN temporárias.
