@echo off
REM =========================================================================
REM  AntiKobongan — Script Runner Backend Python
REM  Menjalankan daemon ingestion MQTT -> Supabase + Telegram
REM =========================================================================

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Virtual environment .venv belum ditemukan.
  echo Silakan buat virtual environment terlebih dahulu:
  echo   py -3 -m venv .venv
  echo   .venv\Scripts\pip install -r backend\requirements.txt
  pause
  exit /b 1
)

echo [INFO] Menjalankan Backend AntiKobongan...
echo [TIPS] Pastikan Windows tidak dalam mode sleep selama monitoring:
echo        powercfg /change standby-timeout-ac 0
echo.

.venv\Scripts\python.exe backend\main.py %*
