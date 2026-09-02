@echo off
setlocal
cd /d "%~dp0"
title EntreTelas

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo O Node.js nao esta instalado neste computador.
  echo Instale a versao LTS em https://nodejs.org e tente novamente.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Preparando o EntreTelas pela primeira vez...
  call npm install
  if errorlevel 1 goto :erro
)

echo Atualizando o aplicativo...
call npm run build
if errorlevel 1 goto :erro

echo.
echo EntreTelas iniciado. Mantenha esta janela aberta.
echo Para encerrar, pressione Ctrl+C ou feche esta janela.
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8787"
call npm start
exit /b 0

:erro
echo.
echo Nao foi possivel iniciar o EntreTelas.
pause
exit /b 1
