# fake-install.ps1 - faux install.ps1 du banc du lot 7 : consigne ses arguments et n'ecrit rien d'autre.
# Copie sous le nom install.ps1 dans chaque installation jetable. Journal : fichier designe par COCKPIT_TEST_INSTALL_LOG
# (variable absente de $CockpitComposeEnvNames, donc jamais masquee), une ligne JSON par appel.
Set-StrictMode -Version 2.0
$log = [Environment]::GetEnvironmentVariable('COCKPIT_TEST_INSTALL_LOG', 'Process')
if ($log) {
    [System.IO.File]::AppendAllText($log, ((ConvertTo-Json -Compress @($args)) + "`n"), (New-Object System.Text.UTF8Encoding $false))
}
Write-Host ('faux install.ps1 : appel avec {0}' -f ((@($args) -join ' ')))
