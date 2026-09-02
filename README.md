# EntreTelas — compartilhamento privado de tela

Primeira versão funcional de compartilhamento privado de tela. O navegador do transmissor exige clique explícito e escolha manual da tela. O projeto não oferece controle remoto, clipboard, arquivos nem captura silenciosa.

O aplicativo aceita várias transmissões simultâneas: uma tela pode ser enviada para vários amigos, cada pessoa pode transmitir enquanto assiste outras telas, e o painel oferece tamanhos Pequeno, Médio e Grande, além de tela cheia por transmissão.

Usuários comuns entram no site apenas escolhendo um nome. O botão **ADM** revela o campo de senha administrativa. O lobby atualiza automaticamente e mostra somente os nomes das salas disponíveis; participantes, presença, transmissões e sinalização WebRTC só ficam disponíveis após a senha da sala ser validada. Salas que permanecem vazias por 15 segundos são removidas. `ADMIN_PASSWORD_1` é o único SUPER ADM e pode entrar em qualquer sala; os outros administradores precisam da senha da sala como qualquer usuário. Dentro dela, a pessoa inicia a própria tela uma vez e qualquer participante pode clicar em **Assistir**, sem novo pedido de autorização. Não há limite artificial de participantes; a capacidade prática depende da conexão e da máquina dos transmissores.

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

### Opção simples: Render

O arquivo `render.yaml` deixa o projeto pronto para o Render. Coloque esta pasta em um repositório GitHub e, no painel do Render, escolha **New > Blueprint**, conecte o repositório e confirme a criação do serviço. O Render executará a instalação, o build e `npm start`, fornecendo um endereço `https://...onrender.com`. O frontend usa automaticamente `wss://` no mesmo endereço.

No plano gratuito, o serviço pode dormir após 15 minutos sem tráfego e levar cerca de um minuto para acordar. Ele é adequado para testes e uso ocasional, não para uma versão de produção.

### Salas privadas

O Blueprint gera `SESSION_SECRET` automaticamente. Não existe senha geral para usuários comuns: basta escolher um nome. Depois desse login, o lobby mostra os nomes das salas, mas não mostra participantes nem transmissões. Qualquer usuário pode criar uma sala e escolher sua senha; os amigos clicam nela e informam essa senha para entrar. O login fica salvo no navegador por até 30 dias. O servidor limita tentativas administrativas incorretas e não permite dois usuários com o mesmo nome dentro da mesma sala.

As salas ficam somente na memória nesta versão. Se o Render reiniciar ou adormecer o serviço gratuito, elas desaparecem e precisam ser criadas novamente; a interface descartará a sessão antiga na próxima tentativa. As senhas são armazenadas em memória com `scrypt`, salt individual e nunca são enviadas para outros participantes.

Nunca coloque `SESSION_SECRET`, senhas administrativas nem o arquivo `.env` no Git.

Defina `ADMIN_PASSWORD_1` até `ADMIN_PASSWORD_4` no Render. A primeira senha é exclusiva do SUPER ADM e deve ficar somente com o proprietário; ela permite entrar em qualquer sala sem a senha. As outras três concedem moderação, mas não permitem entrar em uma sala sem sua senha.

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

- Identidade por nome é simples; o acesso à sala depende do conhecimento do nome e da senha.
- Sessões são assinadas, vinculadas a uma única sala e expiram em até 30 dias.
- O backend valida tipos, destinos, tamanho e formato básico das mensagens WebSocket.
- O servidor rejeita qualquer presença, moderação ou sinalização WebRTC destinada a outra sala.
- Nenhuma mensagem remota consegue chamar `getDisplayMedia`; isso só ocorre no clique **Iniciar transmissão** do transmissor.
- Ao parar, fechar a aba, perder o peer ou encerrar a captura nativa, tracks e `RTCPeerConnection` são fechados.
- Cada espectador usa uma conexão WebRTC independente. A banda de upload do transmissor cresce aproximadamente uma vez por espectador; para grupos grandes, a evolução recomendada é usar uma SFU.
- Para uso público real, adicione contas persistentes, banco de dados, recuperação de salas e credenciais TURN temporárias.
