@echo off
setlocal
cd /d "%~dp0backend"
if not exist ".env" copy /Y ".env.example" ".env" >nul
echo.
echo   vamo - chatbot com Go, React e OpenAI
echo   Abra http://127.0.0.1:8080 no navegador.
echo   Configure OPENAI_API_KEY em backend/.env para conversar.
echo   Mantenha este terminal aberto. Use Ctrl+C para encerrar.
echo.
if not exist "vamo-chat.exe" (
  echo Execute go build -o vamo-chat.exe . na pasta backend primeiro.
  pause
  exit /b 1
)
vamo-chat.exe
if errorlevel 1 pause
