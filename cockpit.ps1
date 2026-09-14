<#
.SYNOPSIS
    Pilotage quotidien d'opencode-cockpit.

.DESCRIPTION
    .\cockpit.ps1 open                  Ouvre l'interface (connexion automatique)
    .\cockpit.ps1 start | stop          Demarre (en appliquant .env) ou arrete les conteneurs
    .\cockpit.ps1 restart               Recree les conteneurs (relit .env et certs\)
    .\cockpit.ps1 status                Etat des conteneurs et du cockpit
    .\cockpit.ps1 logs [opencode|cockpit]
    .\cockpit.ps1 diag                  Diagnostic en lecture seule : conteneurs, acces reseau a Copilot, journal
    .\cockpit.ps1 certs                 Reexporte les certificats Windows puis recree les conteneurs
    .\cockpit.ps1 update                git pull puis relance install.ps1 (meme mode d'installation)
    .\cockpit.ps1 backup                Sauvegarde reglages, couts, archives et configuration opencode
    .\cockpit.ps1 restore <fichier>     Restaure une sauvegarde (remplace les donnees actuelles)
    .\cockpit.ps1 uninstall [-Purge]    Supprime les conteneurs (-Purge : donnees et images comprises)
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('open', 'start', 'stop', 'restart', 'status', 'logs', 'diag', 'certs', 'update', 'backup', 'restore', 'uninstall', 'help')]
    [string]$Command = 'help',
    # Service pour 'logs' (opencode ou cockpit), ou fichier de sauvegarde pour 'restore'.
    [Parameter(Position = 1)]
    [string]$Target = '',
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

$ProxyVariables = @('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')

# docker compose donne priorite aux variables du shell sur .env : elles sont masquees le temps de l'appel.
function Clear-ShellProxy {
    $saved = @{}
    # Nom reel conserve : une variable http_proxy en minuscules est restauree telle quelle.
    $names = @([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $ProxyVariables -contains $_ })
    foreach ($name in $names) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    return $saved
}

function Restore-ShellProxy {
    param($Saved)
    foreach ($name in @($Saved.Keys)) { [Environment]::SetEnvironmentVariable($name, $Saved[$name], 'Process') }
}

# Fonction simple, sans bloc param : un attribut [Parameter()] ajouterait les parametres communs de
# PowerShell, et des options docker comme -v ou -d seraient prises pour -Verbose ou -Debug.
function Invoke-Docker {
    $dockerArgs = @($args)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $savedProxy = Clear-ShellProxy
    try { & docker @dockerArgs } finally { $ErrorActionPreference = $previous; Restore-ShellProxy $savedProxy }
    if ($LASTEXITCODE -ne 0) { throw ("La commande 'docker {0}' a echoue (code {1})." -f ($dockerArgs -join ' '), $LASTEXITCODE) }
}

# Commande docker avec delai maximal : un conteneur bloque au demarrage ne doit pas figer le diagnostic.
# Premier argument : delai en secondes ; les suivants sont passes a docker.
function Invoke-DockerTimeout {
    $seconds = [int]$args[0]
    $dockerArgs = @($args | Select-Object -Skip 1)
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    # Chemin absolu resolu par PowerShell : Windows chercherait sinon d'abord un docker.exe dans le dossier courant.
    $startInfo.FileName = (Get-Command docker.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $startInfo.Arguments = (@($dockerArgs | ForEach-Object { if ([string]$_ -match '[\s"]') { '"' + ([string]$_).Replace('"', '\"') + '"' } else { [string]$_ } })) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $savedProxy = Clear-ShellProxy
    try { $process = [System.Diagnostics.Process]::Start($startInfo) } finally { Restore-ShellProxy $savedProxy }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($seconds * 1000)) {
        try { $process.Kill() } catch { }
        return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Output = '' }
    }
    return [pscustomobject]@{ TimedOut = $false; ExitCode = $process.ExitCode; Output = ($stdout.Result + $stderr.Result).Trim() }
}

# Masque les formes de secrets les plus courantes avant affichage (identifiants dans une URL, jetons GitHub, mots de passe).
function Hide-Secrets([string]$Text) {
    $masked = $Text -replace '(?i)([a-z][a-z0-9+.-]*://[^:\s/@]+:)[^@\s]+@', '$1****@'
    $masked = $masked -replace '(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}', '$1****'
    $masked = $masked -replace '(?i)(authorization\s*[:=]\s*(bearer|basic|token)\s+)\S+', '$1****'
    $masked = $masked -replace '(?i)((pass(word|wd)?|pwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+', '$1****'
    return $masked
}

function Get-EnvValue([string]$Key) {
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'Fichier .env introuvable : lancez d abord .\install.ps1' }
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
        if ($line -match ('^\s*{0}=(.*)$' -f [regex]::Escape($Key))) { return $Matches[1].Trim() }
    }
    return ''
}

# Chemin absolu normalise, sans barre finale ('C:' designe la racine du lecteur, pas son dossier courant).
function Get-NormalizedPath([string]$Path) {
    $candidate = $Path.Trim().Trim('"').Replace('/', '\')
    if ($candidate -match '^[A-Za-z]:$') { $candidate += '\' }
    # Chemin relatif de .env : docker compose le lit depuis le dossier du cockpit.
    if (-not [System.IO.Path]::IsPathRooted($candidate)) { $candidate = Join-Path $Root $candidate }
    return [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
}

# Le dossier du cockpit (scripts, docker-compose.yml, .env, certs\) ne doit jamais etre monte dans le conteneur de l'agent.
function Assert-CockpitOutsideWorkspace {
    $workspace = Get-EnvValue 'WORKSPACE_DIR'
    if (-not $workspace) { return }
    $a = Get-NormalizedPath $Root
    $b = Get-NormalizedPath $workspace
    $ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
    if (($a -ieq $b) -or $a.StartsWith($b + '\', $ignoreCase) -or $b.StartsWith($a + '\', $ignoreCase)) {
        throw ("Le dossier du cockpit ({0}) et le dossier des projets ({1}, WORKSPACE_DIR) se chevauchent : l'agent pourrait modifier cockpit.ps1, install.ps1, docker-compose.yml, .env ou certs. Deplacez le dossier du cockpit hors du dossier des projets (avec .env, certs, archives et backups), puis relancez .\install.ps1." -f $a, $b)
    }
}

function Get-Port {
    $value = Get-EnvValue 'COCKPIT_PORT'
    if ($value) { return [int]$value }
    return 7777
}

function Get-ArchiveDir {
    # Dossier reellement monte sur /archives, tel que compose le resout (guillemets, ~, chemin relatif).
    # La configuration contient des secrets : elle reste en memoire et n'est jamais affichee.
    $json = $null
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $savedProxy = Clear-ShellProxy
    # docker ecrit du JSON en UTF-8 ; PowerShell 5.1 le lirait avec la page de code de la console (850 en francais).
    $savedEncoding = $null
    try { $savedEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { $savedEncoding = $null }
    try { $json = (& docker compose config --format json 2>$null) -join "`n" } finally {
        $ErrorActionPreference = $previous
        Restore-ShellProxy $savedProxy
        if ($null -ne $savedEncoding) { try { [Console]::OutputEncoding = $savedEncoding } catch { } }
    }
    if ($LASTEXITCODE -ne 0 -or -not $json) { throw 'Lecture de la configuration impossible (docker compose config).' }
    $mount = @((ConvertFrom-Json $json).services.cockpit.volumes | Where-Object { $_.target -eq '/archives' }) | Select-Object -First 1
    if ($null -eq $mount) { throw 'Montage /archives introuvable dans docker-compose.yml.' }
    New-Item -ItemType Directory -Path $mount.source -Force | Out-Null
    return (Resolve-Path -LiteralPath $mount.source).Path
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

# Un chemin de sauvegarde relatif se lit depuis le dossier courant de l'utilisateur, pas depuis $Root.
if ($Command -eq 'restore' -and $Target) {
    $Target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Target)
}

Push-Location $Root
try {
    switch ($Command) {
        'open' {
            $url = 'http://127.0.0.1:{0}/auth?t={1}' -f (Get-Port), (Get-EnvValue 'COCKPIT_TOKEN')
            Start-Process $url
        }
        'start' {
            Assert-CockpitOutsideWorkspace
            Write-Step 'Demarrage'
            Invoke-Docker compose up -d
        }
        'stop' {
            Write-Step 'Arret'
            Invoke-Docker compose stop
        }
        'restart' {
            Assert-CockpitOutsideWorkspace
            # 'compose restart' garderait l'ancienne configuration : on recree les conteneurs pour relire .env.
            Write-Step 'Redemarrage (configuration .env relue)'
            Invoke-Docker compose up -d --force-recreate
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
            if ($Target -and @('opencode', 'cockpit') -notcontains $Target) { throw 'Service inconnu : utilisez "logs opencode" ou "logs cockpit".' }
            if ($Target) { Invoke-Docker compose logs --tail 200 -f $Target }
            else { Invoke-Docker compose logs --tail 200 -f }
        }
        'diag' {
            Write-Step 'Diagnostic (lecture seule)'
            $oc = "$Project-opencode-1"
            Write-Host ''
            Write-Host '--- Conteneurs ---'
            $containers = Invoke-DockerTimeout 20 ps -a --filter "name=$Project-" --format '{{.Names}} | {{.Status}} | {{.Image}}'
            if ($containers.TimedOut) {
                Write-Attention 'docker ps ne repond pas en 20 s : Docker Desktop est bloque. Redemarrez-le (wsl --shutdown, puis relancez Docker Desktop).'
                return
            }
            Write-Host $containers.Output
            if ($containers.Output -match ([regex]::Escape($oc) + ' \| Created')) {
                Write-Attention 'opencode est reste a l etat Created : Docker n arrive pas a le lancer. Placez WORKSPACE_DIR sur un disque local (ni lecteur reseau, ni OneDrive), puis redemarrez Docker Desktop.'
            }
            Write-Host ''
            Write-Host '--- Cockpit ---'
            if (-not (Test-Path -LiteralPath $EnvFile)) {
                Write-Attention 'Fichier .env introuvable : lancez diag depuis le dossier du cockpit installe.'
            } elseif (Test-Health) {
                Write-Host ('Cockpit : repond sur http://127.0.0.1:{0} (page Diagnostic > Tester la connexion Copilot)' -f (Get-Port))
            } else {
                Write-Attention 'Cockpit : ne repond pas'
            }
            Write-Host ''
            Write-Host '--- Acces reseau depuis le conteneur opencode (proxy et certificats du cockpit, sans jeton) ---'
            $hostsToProbe = @('api.githubcopilot.com', 'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com', 'api.github.com', 'github.com', 'models.opencode.ai', 'registry.npmjs.org')
            foreach ($probeHost in $hostsToProbe) {
                $probe = Invoke-DockerTimeout 25 exec $oc curl -s -m 15 --cacert /home/node/.cockpit/ca-bundle.pem -o /dev/null -D - -w 'code=%{http_code}' "https://$probeHost/"
                $code = '---'
                if ($probe.Output -match 'code=(\d{3})') { $code = $Matches[1] }
                if ($probe.TimedOut) { $verdict = 'pas de reponse (conteneur bloque ?)' }
                elseif ($code -eq '---') { $verdict = 'test impossible (conteneur arrete ?)' }
                elseif ($code -eq '000') { $verdict = 'INJOIGNABLE (proxy, pare-feu ou certificat)' }
                elseif ($probe.Output -match '(?im)^x-github-request-id:') { $verdict = 'joignable' }
                elseif ($probeHost -like '*github*') { $verdict = 'reponse sans marque GitHub : page de blocage du proxy ?' }
                else { $verdict = 'joignable' }
                Write-Host ('{0,-34} {1}  {2}' -f $probeHost, $code, $verdict)
            }
            Write-Host ''
            Write-Host '--- Journal d opencode : lignes d erreur recentes (secrets courants masques ; journal complet : page Diagnostic) ---'
            $journal = Invoke-DockerTimeout 20 logs --tail 300 $oc
            if ($journal.TimedOut) { Write-Attention 'Journal illisible en 20 s.' }
            elseif (-not $journal.Output) { Write-Attention 'Journal vide : opencode n a jamais demarre (voir l etat du conteneur ci-dessus).' }
            else {
                $problems = @($journal.Output -split "`r?`n" | Where-Object { $_ -match 'level=(ERROR|WARN)|ERREUR|Error|EACCES|denied' } | Select-Object -Last 20)
                if ($problems.Count -eq 0) { Write-Host 'Aucune ligne d erreur dans les 300 dernieres lignes.' }
                foreach ($line in $problems) { Write-Host (Hide-Secrets $line) }
            }
            Write-Host ''
            Write-Host 'Pare-feu qui n ouvre que l adresse de votre abonnement (api.business ou api.enterprise joignable, api.githubcopilot.com bloquee) :'
            Write-Host '  .\install.ps1 -CopilotApiUrl https://api.business.githubcopilot.com -NoBrowser'
        }
        'certs' {
            Assert-CockpitOutsideWorkspace
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
            Write-Step 'Recreation des conteneurs pour prise en compte'
            Invoke-Docker compose up -d --force-recreate
        }
        'update' {
            Assert-CockpitOutsideWorkspace
            if (Test-Path -LiteralPath (Join-Path $Root '.git')) {
                Write-Step 'Recuperation de la derniere version (git pull)'
                & git -C $Root pull --ff-only
                if ($LASTEXITCODE -ne 0) { throw 'git pull a echoue : resolvez le conflit puis relancez.' }
            } else {
                Write-Attention 'Pas de depot git : remplacez les fichiers par ceux de la nouvelle version (sans toucher a .env, certs\, archives\ ni backups\), puis lancez .\install.ps1'
                return
            }
            & (Join-Path $Root 'install.ps1') -NoBrowser
        }
        'backup' {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $backupDir = Join-Path $Root 'backups'
            New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
            $image = Get-EnvValue 'COCKPIT_APP_IMAGE'
            $archiveDir = Get-ArchiveDir
            Write-Step 'Arret temporaire pour une sauvegarde coherente'
            Invoke-Docker compose stop
            try {
                Write-Step "Sauvegarde vers backups\cockpit-$stamp.tar.gz"
                Invoke-Docker run --rm --entrypoint tar `
                    -v "${Project}_cockpit-data:/src/cockpit-data:ro" `
                    -v "${Project}_oc-config:/src/oc-config:ro" `
                    -v "${Project}_oc-data:/src/oc-data:ro" `
                    -v "${archiveDir}:/src/archives:ro" `
                    -v "${backupDir}:/backup" `
                    $image czf "/backup/cockpit-$stamp.tar.gz" --exclude=oc-data/auth.json --exclude=oc-config/node_modules -C /src .
            } finally {
                Invoke-Docker compose start
            }
            Write-Host 'Sauvegarde terminee. Exclus volontairement : jeton GitHub Copilot (auth.json), fichier .env et dossier certs\.' -ForegroundColor Green
        }
        'restore' {
            if (-not $Target -or -not (Test-Path -LiteralPath $Target -PathType Leaf)) {
                throw 'Indiquez une sauvegarde existante : .\cockpit.ps1 restore .\backups\cockpit-AAAAMMJJ-HHMMSS.tar.gz'
            }
            $backup = Get-Item -LiteralPath $Target
            if ($backup.Name -notmatch '^[A-Za-z0-9._-]+\.tar\.gz$') { throw 'Nom de sauvegarde inattendu : lettres, chiffres, point, tiret, souligne et extension .tar.gz uniquement.' }
            $image = Get-EnvValue 'COCKPIT_APP_IMAGE'
            $archiveDir = Get-ArchiveDir
            # Verification AVANT tout arret : une archive illisible ne coupe pas le cockpit.
            Write-Step "Verification de $($backup.Name)"
            Invoke-Docker run --rm --entrypoint tar -v "$($backup.DirectoryName):/backup:ro" $image tzf "/backup/$($backup.Name)" | Out-Null
            Write-Attention 'La restauration REMPLACE les reglages, couts, archives indexees et la configuration opencode actuels.'
            Write-Attention 'Le dossier archives\ est complete : les fichiers absents de la sauvegarde restent, ceux de meme nom sont remplaces. La connexion GitHub Copilot est conservee.'
            $answer = Read-Host 'Tapez RESTAURER pour confirmer'
            if ($answer -cne 'RESTAURER') { Write-Host 'Annule.'; return }
            Invoke-Docker compose up --no-start
            Invoke-Docker compose stop
            try {
                Write-Step "Restauration de $($backup.Name)"
                $script = "set -e; " +
                    "for d in cockpit-data oc-config oc-data; do find /dst/`$d -mindepth 1 -maxdepth 1 ! -name auth.json -exec rm -rf {} +; done; " +
                    "tar xzf /backup/$($backup.Name) --no-same-owner -C /dst; chown -R 1000:1000 /dst/cockpit-data /dst/oc-config /dst/oc-data"
                Invoke-Docker run --rm --user 0 --entrypoint sh `
                    -v "${Project}_cockpit-data:/dst/cockpit-data" `
                    -v "${Project}_oc-config:/dst/oc-config" `
                    -v "${Project}_oc-data:/dst/oc-data" `
                    -v "${archiveDir}:/dst/archives" `
                    -v "$($backup.DirectoryName):/backup:ro" `
                    $image -c $script
            } finally {
                # Redemarrage dans tous les cas, meme si la restauration a echoue.
                Write-Step 'Redemarrage des conteneurs'
                Invoke-Docker compose up -d --force-recreate
            }
            Write-Host 'Restauration terminee.' -ForegroundColor Green
        }
        'uninstall' {
            if ($Purge) {
                Write-Attention 'Suppression DEFINITIVE des conteneurs, des volumes (reglages, couts, connexion Copilot) et des images designees dans .env.'
                Write-Attention 'Conserves : archives\, backups\, certs\ et .env. Images d anciennes versions : docker image ls, puis docker image rm.'
                $answer = Read-Host 'Tapez SUPPRIMER pour confirmer'
                if ($answer -cne 'SUPPRIMER') { Write-Host 'Annule.'; return }
                # --rmi all : aussi les images telechargees (-Mode Pull) ou chargees depuis l'archive (-Mode Load).
                Invoke-Docker compose down --volumes --rmi all
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
