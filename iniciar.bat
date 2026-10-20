@echo off
REM Doble clic para arrancar SKU/FINDER en Windows.
cd /d "%~dp0"
where node >nul 2>nul || (echo Necesitas Node.js 20 o superior: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
start "" http://localhost:3737
node server/index.js
pause
