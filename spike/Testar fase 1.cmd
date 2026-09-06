@echo off
chcp 65001 >nul
title EntreTelas - teste da fase 1
set "ROOT=%~dp0"

echo.
echo  Fase 1 - captura nativa na GPU chegando ao navegador por WebRTC
echo  ------------------------------------------------------------
echo.

echo  [1/3] subindo o relay WHIP numa janela propria...
start "EntreTelas - relay WHIP" cmd /k "pushd "%ROOT%.." && node spike\whip-relay.mjs"

REM O relay precisa estar ouvindo antes de o navegador comecar a perguntar pela oferta.
timeout /t 2 /nobreak >nul

echo  [2/3] abrindo a pagina do espectador no navegador padrao...
start "" "http://127.0.0.1:8137/"

echo.
echo  Espere a pagina carregar e mostrar "aguardando o pipeline..."
echo.
echo  A pagina precisa estar aberta ANTES do pipeline comecar: quem oferta e o
echo  GStreamer, e sem ninguem para responder ele desiste da sessao.
echo.
pause

echo.
echo  [3/3] iniciando a captura. Ctrl+C nesta janela encerra a transmissao.
echo.
powershell -ExecutionPolicy Bypass -File "%ROOT%start-pipeline.ps1"

echo.
echo  Pipeline encerrado. A janela do relay continua aberta; feche-a quando terminar.
pause
