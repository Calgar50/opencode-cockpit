@echo off
rem Faux curl.exe 7.55 (tests/ps51) : trop ancien pour la verification HTTPS du cockpit ; ne sert que pour --version.
echo curl 7.55.1 (Windows) libcurl/7.55.1 WinSSL
echo Protocols: dict file ftp ftps http https imap imaps pop3 pop3s smtp smtps telnet tftp
exit /b 0
