@echo off
REM Jalankan backend AntiKobongan dari root proyek. Tidak berisi rahasia.
cd /d "%~dp0.."
if not exist ".venv\Scripts\activate.bat" (
  echo Virtual environment .venv belum ada.
  echo Jalankan: python -m venv .venv
  exit /b 1
)
call ".venv\Scripts\activate.bat"
python backend\main.py %*
