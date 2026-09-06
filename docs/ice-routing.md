# Roteamento automático e diagnóstico

No modo automático, a primeira tentativa reúne candidatos P2P/STUN e TURN por UDP
em paralelo, mantendo `iceTransportPolicy: all`. O ICE prefere um caminho direto
viável, mas o relay UDP já está pronto sem depender de uma reconfiguração posterior.
Isso não garante P2P.
Somente uma rota é usada para enviar a mídia dessa conexão. Se for relay,
o tráfego continua contando na franquia do provedor. Os limites de emissão
de credenciais do backend não foram alterados.

TCP/TLS só entra após 4 segundos sem conexão na etapa inicial. Essa etapa mantém candidatos
diretos disponíveis no modo automático. Uma conexão que já funciona não é
migrada por esse temporizador. Após falha de uma conexão estabelecida, a
tentativa de recuperação volta a ter prazo, em vez de ficar indefinida.

P2P manual continua sem TURN. TURN manual continua relay-only, primeiro UDP,
com a mesma janela de 4 segundos antes de permitir TCP/TLS. Os endereços alternativos
da Cloudflare na porta 53 são removidos porque navegadores populares bloqueiam essa porta.

O relatório registra separadamente protocolo ICE, transporte local até TURN,
tipo dos candidatos local/remoto, implementação do encoder/decoder e indicador
de eficiência, quando o navegador os fornece. `null` significa desconhecido,
não ausência de aceleração. Tempo médio de codificação não prova software nem
permite somar os tempos de conexões diferentes como se fossem trabalho serial.
Um erro 701, isoladamente, também não identifica o processo, adaptador ou
firewall responsável por uma falha de conectividade.

Testes locais não reproduzem a rota externa de cada amigo. Confirmar a melhoria
real exige novas amostras nessa rota; não há promessa de 60 FPS ou de UDP em
uma rede que não o permita. Nenhuma configuração de VPN/firewall foi alterada.
