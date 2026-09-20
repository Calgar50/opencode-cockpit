@echo off
rem Curl qui consigne ses arguments (fichier COCKPIT_TEST_CURL_LOG) puis delegue au vrai curl.exe de Windows (tests/ps51).
node "%~dp0curl-log.mjs" %*
exit /b %ERRORLEVEL%
