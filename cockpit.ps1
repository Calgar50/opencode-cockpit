<#
.SYNOPSIS
    Pilotage quotidien d'opencode-cockpit.

.DESCRIPTION
    .\cockpit.ps1 open                Ouvre l'interface (connexion automatique)
    .\cockpit.ps1 start | stop | restart
    .\cockpit.ps1 status              Etat des conteneurs et du cockpit
    .\cockpit.ps1 logs [opencode|cockpit]
    .\cockpit.ps1 certs               Reexporte les certificats Windows puis redemarre
    .\cockpit.ps1 update              Met a jour (git pull) puis reinstalle
    .\cockpit.ps1 backup              Sauvegarde reglages, archives SQLite et configuration opencode
    .\cockpit.ps1 uninstall [-Purge]  Arrete et supprime les conteneurs (-Purge : donnees comprises)
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('open', 'start', 'stop', 'restart', 'status', 'logs', 'certs', 'update', 'backup', 'uninstall', 'help')]
    [string]$Command = 'help',
    [Parameter(Position = 1)]
    [ValidateSet('', 'opencode', 'cockpit')]
    [string]$Service = '',
    [switch]$Purge
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = $PSScriptRoot
$EnvFile = Join-Path $Root '.env'
$Project = 'opencode-cockpit'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Attention([string]$Message) { Write-Host "[!] $Message" -ForegroundColor Yellow }

function Invoke-Docker {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & docker @Arguments } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw ("La commande 'docker {0}' a echoue (code {1})." -f ($Arguments -join ' '), $LASTEXITCODE) }
}

function Get-EnvValue([string]$Key) {
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'Fichier .env introuvable : lancez d abord .\install.ps1' }
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
        if ($line -match ('^\s*{0}=(.*)$' -f [regex]::Escape($Key))) { return $Matches[1].Trim() }
    }
    return ''
}

function Get-Port {
    $value = Get-EnvValue 'COCKPIT_PORT'
    if ($value) { return [int]$value }
    return 7777
}

function Test-Health {
    [System.Net.WebRequest]::DefaultWebProxy = $null
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:{0}/api/health' -f (Get-Port)) -TimeoutSec 4
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

Push-Location $Root
try {
    switch ($Command) {
        'open' {
            $url = 'http://127.0.0.1:{0}/auth?t={1}' -f (Get-Port), (Get-EnvValue 'COCKPIT_TOKEN')
            Start-Process $url
        }
        'start' {
            Write-Step 'Demarrage'
            Invoke-Docker compose up -d
        }
        'stop' {
            Write-Step 'Arret'
            Invoke-Docker compose stop
        }
        'restart' {
            Write-Step 'Redemarrage'
            Invoke-Docker compose restart
        }
        'status' {
            Invoke-Docker compose ps
            if (Test-Health) {
                Write-Host ('Cockpit : disponible sur http://127.0.0.1:{0}' -f (Get-Port)) -ForegroundColor Green
            } else {
                Write-Attention 'Cockpit : ne repond pas (voir .\cockpit.ps1 logs)'
            }
        }
        'logs' {
            if ($Service) { Invoke-Docker compose logs --tail 200 -f $Service }
            else { Invoke-Docker compose logs --tail 200 -f }
        }
        'certs' {
            Write-Step 'Reexport des certificats de confiance Windows vers certs\windows-trust.pem'
            $builder = New-Object System.Text.StringBuilder
            $seen = @{}
            foreach ($store in @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root', 'Cert:\LocalMachine\CA')) {
                foreach ($cert in (Get-ChildItem -Path $store -ErrorAction SilentlyContinue)) {
                    if ($cert.NotAfter -lt (Get-Date) -or $seen.ContainsKey($cert.Thumbprint)) { continue }
                    $seen[$cert.Thumbprint] = $true
                    $base64 = [Convert]::ToBase64String($cert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
                    [void]$builder.Append("-----BEGIN CERTIFICATE-----`n")
                    [void]$builder.Append($base64.Replace("`r`n", "`n"))
                    [void]$builder.Append("`n-----END CERTIFICATE-----`n")
                }
            }
            $certsDir = Join-Path $Root 'certs'
            New-Item -ItemType Directory -Path $certsDir -Force | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $certsDir 'windows-trust.pem'), $builder.ToString(), (New-Object System.Text.UTF8Encoding $false))
            Write-Host ("{0} certificats exportes." -f $seen.Count)
            Write-Step 'Redemarrage pour prise en compte'
            Invoke-Docker compose restart
        }
        'update' {
            if (Test-Path -LiteralPath (Join-Path $Root '.git')) {
                Write-Step 'Recuperation de la derniere version (git pull)'
                & git -C $Root pull --ff-only
                if ($LASTEXITCODE -ne 0) { throw 'git pull a echoue : resolvez le conflit puis relancez.' }
            } else {
                Write-Attention 'Pas de depot git : telechargez la nouvelle version dans ce dossier puis relancez .\install.ps1'
            }
            & (Join-Path $Root 'install.ps1') -NoBrowser
        }
        'backup' {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $backupDir = Join-Path $Root 'backups'
            New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
            $image = Get-EnvValue 'COCKPIT_APP_IMAGE'
            Write-Step 'Arret temporaire pour une sauvegarde coherente'
            Invoke-Docker compose stop
            try {
                Write-Step "Sauvegarde vers backups\cockpit-$stamp.tar.gz"
                Invoke-Docker run --rm --entrypoint tar `
                    -v "${Project}_cockpit-data:/src/cockpit-data:ro" `
                    -v "${Project}_oc-config:/src/oc-config:ro" `
                    -v "${Project}_oc-data:/src/oc-data:ro" `
                    -v "${backupDir}:/backup" `
                    $image czf "/backup/cockpit-$stamp.tar.gz" --exclude=oc-data/auth.json --exclude=oc-config/node_modules -C /src .
            } finally {
                Invoke-Docker compose start
            }
            Write-Host 'Sauvegarde terminee. Le jeton GitHub Copilot (auth.json) est volontairement exclu.' -ForegroundColor Green
        }
        'uninstall' {
            if ($Purge) {
                Write-Attention 'Suppression DEFINITIVE des conteneurs, images locales et donnees (reglages, couts, connexion Copilot).'
                Write-Attention 'Le dossier archives\ (exports Markdown) et le fichier .env sont conserves.'
                $answer = Read-Host 'Tapez SUPPRIMER pour confirmer'
                if ($answer -cne 'SUPPRIMER') { Write-Host 'Annule.'; return }
                Invoke-Docker compose down --volumes --rmi local
            } else {
                Invoke-Docker compose down
                Write-Host 'Conteneurs supprimes. Les donnees restent dans les volumes Docker (-Purge pour tout effacer).'
            }
        }
        default {
            Get-Help $MyInvocation.MyCommand.Path -Detailed | Out-Host
        }
    }
} finally {
    Pop-Location
}
