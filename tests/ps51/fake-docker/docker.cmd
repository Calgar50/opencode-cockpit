@echo off
rem Faux docker du banc PowerShell 5.1 (tests/ps51/README.md) : a placer en tete du PATH du processus de test.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-docker.ps1" %*
exit /b %ERRORLEVEL%
