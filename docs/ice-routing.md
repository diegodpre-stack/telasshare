# Roteamento automático e diagnóstico

No modo automático, P2P e TURN por UDP são preparados na mesma negociação,
com `iceTransportPolicy: all`. Não há uma espera fixa de 30 segundos para
começar a preparar UDP. O ICE escolhe um par viável; isso não garante P2P.
Somente uma rota é usada para enviar a mídia dessa conexão. Se for relay,
o tráfego continua contando na franquia do provedor. Os limites de emissão
de credenciais do backend não foram alterados.

TCP/TLS só entra após 30 segundos sem conexão. Essa etapa mantém candidatos
diretos disponíveis no modo automático. Uma conexão que já funciona não é
migrada por esse temporizador. Após falha de uma conexão estabelecida, a
tentativa de recuperação volta a ter prazo, em vez de ficar indefinida.

P2P manual continua sem TURN. TURN manual continua relay-only, primeiro UDP,
com a mesma janela de 30 segundos antes de permitir TCP/TLS.

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
