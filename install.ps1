<#
.SYNOPSIS
    Installe, configure et demarre opencode-cockpit (Docker Desktop requis).

.DESCRIPTION
    - verifie Docker Desktop ;
    - cree ou complete le fichier .env (secrets aleatoires, dossier des projets, proxy) ;
    - exporte les autorites de certification de confiance de Windows vers certs\windows-trust.pem
      (indispensable derriere un proxy d'entreprise qui inspecte le HTTPS) ;
    - construit, telecharge ou charge les images, demarre les conteneurs et ouvre l'interface.

    Relancer le script est sans danger : les secrets et reglages existants sont conserves.

.PARAMETER WorkspaceDir
    Dossier contenant vos projets. Il est monte dans les conteneurs sous /workspace :
    l'agent ne voit que ce dossier. Il ne doit ni contenir le dossier du cockpit, ni etre contenu
    dedans : clonez ou extrayez le cockpit a part (l'agent pourrait sinon modifier ses scripts et .env).

.PARAMETER Mode
    Build (defaut) : construit les images localement (acces a Docker Hub et au registre npm requis).
    Pull           : telecharge les images publiees sur GHCR.
    Load           : charge une archive d'images (docker save) telechargee depuis la page Releases.

.PARAMETER Proxy
    URL du proxy HTTP(S) d'entreprise. Sans ce parametre : valeur deja dans .env, sinon variable
    HTTPS_PROXY, sinon proxy systeme Windows detecte. -Proxy '' force une connexion directe ; ce choix
    est memorise (plus aucune detection) jusqu'a un nouveau -Proxy <url> ou un proxy saisi dans .env.

.PARAMETER InsecureTls
    Desactive la verification des certificats TLS dans les conteneurs. Solution de secours
    uniquement, si l'export des certificats ne suffit pas. Reglage memorise dans .env.

.PARAMETER SecureTls
    Reactive la verification TLS apres un -InsecureTls.

    Le mode d'installation (-Mode) est memorise dans .env, ainsi que le registre s'il a ete passe
    avec -ImageRegistry : une relance sans -Mode (ou cockpit.ps1 update) reutilise le meme mode.

.EXAMPLE
    .\install.ps1 -WorkspaceDir C:\dev

.EXAMPLE
    .\install.ps1 -Mode Load -ImagesArchive .\opencode-cockpit-images-0.1.1.tar.gz
#>
[CmdletBinding()]
param(
    [string]$WorkspaceDir,
    [int]$Port = 0,
    [ValidateSet('Build', 'Pull', 'Load')]
    [string]$Mode = 'Build',
    [string]$ImagesArchive,
    [string]$ImageRegistry = 'ghcr.io/calgar50',
    [string]$Proxy,
    [string]$NoProxy,
    [switch]$SkipCertificates,
    [switch]$InsecureTls,
    [switch]$SecureTls,
    [switch]$NoStart,
    [switch]$NoBrowser
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = $PSScriptRoot
$EnvFile = Join-Path $Root '.env'
$Version = 'dev'
$VersionFile = Join-Path $Root 'VERSION'
if (Test-Path -LiteralPath $VersionFile) { $Version = (Get-Content -LiteralPath $VersionFile -TotalCount 1).Trim() }

function Write-Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Info([string]$Message) { Write-Host "    $Message" }
function Write-Good([string]$Message) { Write-Host "    [OK] $Message" -ForegroundColor Green }
function Write-Attention([string]$Message) { Write-Host "    [!] $Message" -ForegroundColor Yellow }

# Chemin absolu normalise, sans barre finale ('C:' designe la racine du lecteur, pas son dossier courant).
function Get-NormalizedPath([string]$Path) {
    $candidate = $Path.Trim().Trim('"').Replace('/', '\')
    if ($candidate -match '^[A-Za-z]:$') { $candidate += '\' }
    return [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
}

# Vrai si les deux dossiers sont identiques ou si l'un contient l'autre (insensible a la casse).
function Test-PathOverlap([string]$First, [string]$Second) {
    $a = Get-NormalizedPath $First
    $b = Get-NormalizedPath $Second
    $ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
    return ($a -ieq $b) -or $a.StartsWith($b + '\', $ignoreCase) -or $b.StartsWith($a + '\', $ignoreCase)
}

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

# Fonctions simples, sans bloc param : un attribut [Parameter()] ajouterait les parametres communs de
# PowerShell, et des options docker comme -v ou -d seraient prises pour -Verbose ou -Debug.
function Invoke-Docker {
    $dockerArgs = @($args)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $savedProxy = Clear-ShellProxy
    try { & docker @dockerArgs } finally { $ErrorActionPreference = $previous; Restore-ShellProxy $savedProxy }
    if ($LASTEXITCODE -ne 0) { throw ("La commande 'docker {0}' a echoue (code {1})." -f ($dockerArgs -join ' '), $LASTEXITCODE) }
}

function Get-DockerOutput {
    $dockerArgs = @($args)
    $output = $null
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & docker @dockerArgs 2>&1 } finally { $ErrorActionPreference = $previous }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output | Out-String).Trim() }
}

function New-Secret([int]$Bytes = 32) {
    $buffer = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Read-EnvFile([string]$Path) {
    $values = [ordered]@{}
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
            if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
            $index = $line.IndexOf('=')
            $values[$line.Substring(0, $index).Trim()] = $line.Substring($index + 1).Trim()
        }
    }
    return $values
}

function Write-EnvFile([string]$Path, $Values) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# Genere par install.ps1. Contient des secrets : ne jamais versionner ni partager ce fichier.')
    foreach ($key in $Values.Keys) { $lines.Add(('{0}={1}' -f $key, $Values[$key])) }
    $content = ($lines -join "`n") + "`n"
    [System.IO.File]::WriteAllText($Path, $content, (New-Object System.Text.UTF8Encoding $false))
    # Lecture et ecriture reservees a l'utilisateur courant.
    try {
        $account = '{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME
        & icacls $Path /inheritance:r /grant:r ('{0}:(R,W)' -f $account) | Out-Null
    } catch {
        Write-Attention "Impossible de restreindre les droits du fichier .env : $($_.Exception.Message)"
    }
}

function Get-SystemProxy {
    try {
        $target = New-Object System.Uri 'https://api.githubcopilot.com/'
        $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
        $resolved = $systemProxy.GetProxy($target)
        if ($null -ne $resolved -and $resolved.AbsoluteUri -ne $target.AbsoluteUri) {
            return $resolved.GetLeftPart([System.UriPartial]::Authority)
        }
    } catch { }
    return $null
}

function Export-WindowsCertificates([string]$Destination) {
    $builder = New-Object System.Text.StringBuilder
    $seen = @{}
    $count = 0
    foreach ($store in @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root', 'Cert:\LocalMachine\CA')) {
        foreach ($cert in (Get-ChildItem -Path $store -ErrorAction SilentlyContinue)) {
            if ($cert.NotAfter -lt (Get-Date) -or $seen.ContainsKey($cert.Thumbprint)) { continue }
            $seen[$cert.Thumbprint] = $true
            $base64 = [Convert]::ToBase64String($cert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
            [void]$builder.Append("-----BEGIN CERTIFICATE-----`n")
            [void]$builder.Append($base64.Replace("`r`n", "`n"))
            [void]$builder.Append("`n-----END CERTIFICATE-----`n")
            $count++
        }
    }
    [System.IO.File]::WriteAllText($Destination, $builder.ToString(), (New-Object System.Text.UTF8Encoding $false))
    return $count
}

function Wait-Health([int]$HealthPort, [int]$TimeoutSeconds) {
    # Le proxy systeme ne doit pas intercepter les appels vers 127.0.0.1.
    [System.Net.WebRequest]::DefaultWebProxy = $null
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/api/health" -f $HealthPort) -TimeoutSec 4
            if ($response.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Seconds 3
    }
    return $false
}

Write-Host ''
Write-Host "opencode-cockpit $Version - installation" -ForegroundColor White

# --- 1. Docker ------------------------------------------------------------------------
Write-Step 'Verification de Docker Desktop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker est introuvable. Installez et demarrez Docker Desktop, puis relancez ce script.'
}
$server = Get-DockerOutput version --format '{{.Server.Version}}'
if ($server.ExitCode -ne 0) {
    throw "Docker Desktop ne repond pas. Demarrez-le puis relancez ce script. Detail : $($server.Output)"
}
$compose = Get-DockerOutput compose version --short
if ($compose.ExitCode -ne 0) { throw 'Docker Compose v2 est requis (inclus dans Docker Desktop).' }
Write-Good ("Docker {0}, Compose {1}" -f $server.Output, $compose.Output)

# --- 2. Configuration (.env) -----------------------------------------------------------
Write-Step 'Configuration'
$config = Read-EnvFile $EnvFile
$isNew = $config.Count -eq 0

# Mode d'installation memorise : une relance (ou cockpit.ps1 update) garde le mode choisi la premiere fois.
$modeInferred = $false
if (-not $PSBoundParameters.ContainsKey('Mode') -and $config.Contains('COCKPIT_INSTALL_MODE') -and (@('Build', 'Pull', 'Load') -contains $config['COCKPIT_INSTALL_MODE'])) {
    $Mode = $config['COCKPIT_INSTALL_MODE']
    Write-Info "Mode d'installation repris de .env : $Mode"
} elseif (-not $PSBoundParameters.ContainsKey('Mode') -and $config.Contains('COCKPIT_OPENCODE_IMAGE') -and $config['COCKPIT_OPENCODE_IMAGE'] -and $config['COCKPIT_OPENCODE_IMAGE'] -notmatch ':local$') {
    # .env d'une version anterieure (mode non memorise) avec des images publiees : reutilisation sans construction.
    # Mode deduit, jamais memorise : une installation Pull ne doit pas devenir Load pour de bon.
    $Mode = 'Load'
    $modeInferred = $true
    Write-Attention 'Mode d installation non memorise (.env d une version anterieure) : images deja presentes reutilisees. Pour les mettre a jour : .\install.ps1 -Mode Pull, ou .\install.ps1 -Mode Load -ImagesArchive <archive>.'
}
if (-not $PSBoundParameters.ContainsKey('ImageRegistry') -and $config.Contains('COCKPIT_IMAGE_REGISTRY') -and $config['COCKPIT_IMAGE_REGISTRY']) {
    $ImageRegistry = $config['COCKPIT_IMAGE_REGISTRY']
}

if (-not $WorkspaceDir -and $config.Contains('WORKSPACE_DIR')) { $WorkspaceDir = $config['WORKSPACE_DIR'] }
if (-not $WorkspaceDir) {
    $suggestion = Join-Path $env:USERPROFILE 'source\repos'
    $answer = Read-Host "Dossier de vos projets [$suggestion]"
    if ([string]::IsNullOrWhiteSpace($answer)) { $WorkspaceDir = $suggestion } else { $WorkspaceDir = $answer.Trim('" ') }
}
if (-not (Test-Path -LiteralPath $WorkspaceDir -PathType Container)) {
    $create = Read-Host "Le dossier '$WorkspaceDir' n'existe pas. Le creer ? (o/N)"
    if ($create -notmatch '^[oOyY]') { throw 'Installation annulee : dossier des projets introuvable.' }
    New-Item -ItemType Directory -Path $WorkspaceDir -Force | Out-Null
}
$resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspaceDir).Path.TrimEnd('\')
# Le dossier du cockpit (scripts, docker-compose.yml, .env, certs\) ne doit jamais etre monte dans le conteneur de l'agent :
# une modification approuvee ou une injection de consigne y deviendrait du code execute sur le poste Windows.
if (Test-PathOverlap $Root $resolvedWorkspace) {
    throw ("Le dossier du cockpit ({0}) et le dossier des projets ({1}) se chevauchent : l'agent pourrait modifier cockpit.ps1, install.ps1, docker-compose.yml, .env ou certs. Deplacez le dossier du cockpit hors du dossier des projets (avec .env, certs, archives et backups), ou choisissez un autre -WorkspaceDir." -f $Root, $resolvedWorkspace)
}
$tooBroad = @($env:USERPROFILE, $env:SystemDrive, "$($env:SystemDrive)\", $env:SystemRoot) | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $resolvedWorkspace) }
if ($resolvedWorkspace -match '^[A-Za-z]:$' -or $tooBroad) {
    Write-Attention "Le dossier '$resolvedWorkspace' est tres large : l'agent pourra lire tout son contenu."
    $confirmBroad = Read-Host 'Continuer quand meme ? (o/N)'
    if ($confirmBroad -notmatch '^[oOyY]') { throw 'Installation annulee : choisissez un dossier dedie a vos projets (-WorkspaceDir).' }
}
$config['WORKSPACE_DIR'] = $resolvedWorkspace -replace '\\', '/'
Write-Good "Projets : $resolvedWorkspace"

if (-not $config.Contains('ARCHIVE_DIR')) { $config['ARCHIVE_DIR'] = './archives' }
if ($Port -gt 0) { $config['COCKPIT_PORT'] = [string]$Port }
elseif (-not $config.Contains('COCKPIT_PORT')) { $config['COCKPIT_PORT'] = '7777' }
$Port = [int]$config['COCKPIT_PORT']

if (-not $config.Contains('COCKPIT_TOKEN') -or $config['COCKPIT_TOKEN'].Length -lt 32) { $config['COCKPIT_TOKEN'] = New-Secret 32 }
if (-not $config.Contains('OPENCODE_SERVER_PASSWORD') -or $config['OPENCODE_SERVER_PASSWORD'].Length -lt 16) {
    $config['OPENCODE_SERVER_PASSWORD'] = New-Secret 32
}
Write-Good 'Secrets presents (generes aleatoirement si absents)'

# Proxy d'entreprise. -Proxy '' est memorise (COCKPIT_PROXY_MODE=direct) : plus de detection aux relances.
if ($PSBoundParameters.ContainsKey('Proxy')) {
    if ($Proxy) { $config['COCKPIT_PROXY_MODE'] = 'manual' } else { $config['COCKPIT_PROXY_MODE'] = 'direct' }
    $detectedProxy = $Proxy
}
elseif ($config.Contains('HTTPS_PROXY') -and $config['HTTPS_PROXY']) {
    $detectedProxy = $config['HTTPS_PROXY']
    # Proxy saisi dans .env apres un -Proxy '' : il l'emporte sur la connexion directe memorisee.
    if ($config.Contains('COCKPIT_PROXY_MODE') -and $config['COCKPIT_PROXY_MODE'] -eq 'direct') { $config['COCKPIT_PROXY_MODE'] = 'manual' }
}
elseif ($config.Contains('COCKPIT_PROXY_MODE') -and $config['COCKPIT_PROXY_MODE'] -eq 'direct') { $detectedProxy = '' }
elseif ($env:HTTPS_PROXY) { $detectedProxy = $env:HTTPS_PROXY }
else { $detectedProxy = Get-SystemProxy }
if ($detectedProxy) {
    $config['HTTP_PROXY'] = $detectedProxy
    $config['HTTPS_PROXY'] = $detectedProxy
    # Identifiants jamais affiches : la console peut etre journalisee (transcription PowerShell) ou copiee dans un ticket.
    $shownProxy = $detectedProxy -replace '^((?:[A-Za-z][A-Za-z0-9+.-]*://)?)[^/]*@', '$1****@'
    Write-Good "Proxy : $shownProxy"
    if ($detectedProxy -match '@') { Write-Attention "L'URL du proxy contient des identifiants : ils sont stockes dans .env (acces restreint)." }
} elseif ($config.Contains('COCKPIT_PROXY_MODE') -and $config['COCKPIT_PROXY_MODE'] -eq 'direct') {
    $config['HTTP_PROXY'] = ''
    $config['HTTPS_PROXY'] = ''
    Write-Info "Connexion directe, sans proxy (choix memorise ; -Proxy <url> pour utiliser un proxy)."
} else {
    if (-not $config.Contains('HTTP_PROXY')) { $config['HTTP_PROXY'] = '' }
    if (-not $config.Contains('HTTPS_PROXY')) { $config['HTTPS_PROXY'] = '' }
    Write-Info 'Aucun proxy detecte (connexion directe).'
}
if ($PSBoundParameters.ContainsKey('NoProxy')) { $config['NO_PROXY'] = $NoProxy }
elseif (-not $config.Contains('NO_PROXY')) { $config['NO_PROXY'] = '' }

if ($InsecureTls -and $SecureTls) { throw '-InsecureTls et -SecureTls sont incompatibles.' }
if ($InsecureTls) { $config['COCKPIT_TLS_INSECURE'] = '1' }
elseif ($SecureTls) { $config['COCKPIT_TLS_INSECURE'] = '0' }
elseif (-not $config.Contains('COCKPIT_TLS_INSECURE')) { $config['COCKPIT_TLS_INSECURE'] = '0' }
if ($config['COCKPIT_TLS_INSECURE'] -eq '1') {
    Write-Attention 'Verification TLS DESACTIVEE (COCKPIT_TLS_INSECURE=1). A n utiliser qu en dernier recours.'
}
if (-not $config.Contains('TZ')) { $config['TZ'] = 'Europe/Paris' }
# Dossier .opencode/ des depots ignore par defaut (un depot pourrait y executer du code sans confirmation).
if (-not $config.Contains('COCKPIT_PROJECT_CONFIG')) { $config['COCKPIT_PROJECT_CONFIG'] = '0' }
if (-not $config.Contains('COCKPIT_GITHUB_ENTERPRISE_DOMAIN')) { $config['COCKPIT_GITHUB_ENTERPRISE_DOMAIN'] = '' }

# Certificats
$certsDir = Join-Path $Root 'certs'
New-Item -ItemType Directory -Path $certsDir -Force | Out-Null
if ($SkipCertificates) {
    Write-Info 'Export des certificats Windows ignore (-SkipCertificates).'
} else {
    $certCount = Export-WindowsCertificates (Join-Path $certsDir 'windows-trust.pem')
    Write-Good "$certCount autorites de certification Windows exportees vers certs\windows-trust.pem"
}

# Images (valeurs precedentes gardees pour les remettre dans .env si la construction ou le telechargement echoue)
$imageKeys = @('COCKPIT_OPENCODE_IMAGE', 'COCKPIT_APP_IMAGE', 'COCKPIT_INSTALL_MODE')
$previousImages = @{}
foreach ($key in $imageKeys) { if ($config.Contains($key)) { $previousImages[$key] = $config[$key] } }
switch ($Mode) {
    'Build' {
        $config['COCKPIT_OPENCODE_IMAGE'] = 'opencode-cockpit/opencode:local'
        $config['COCKPIT_APP_IMAGE'] = 'opencode-cockpit/app:local'
    }
    'Pull' {
        $config['COCKPIT_OPENCODE_IMAGE'] = "$ImageRegistry/opencode-cockpit-opencode:$Version"
        $config['COCKPIT_APP_IMAGE'] = "$ImageRegistry/opencode-cockpit-app:$Version"
    }
    'Load' {
        if ($ImagesArchive) {
            # Chemin relatif lu depuis le dossier courant : docker load s'execute ensuite depuis le dossier du projet.
            $ImagesArchive = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ImagesArchive)
            if (-not (Test-Path -LiteralPath $ImagesArchive -PathType Leaf)) { throw "Archive d'images introuvable : $ImagesArchive" }
        } else {
            # Relance sans archive : on garde les images deja chargees si elles sont toujours presentes.
            $loadedImages = @(@($config['COCKPIT_OPENCODE_IMAGE'], $config['COCKPIT_APP_IMAGE']) | Where-Object { $_ })
            $missingImages = @($loadedImages | Where-Object { (Get-DockerOutput image inspect --format '{{.Id}}' $_).ExitCode -ne 0 })
            if ($loadedImages.Count -lt 2 -or $missingImages.Count -gt 0) {
                throw "Mode Load : images absentes. Telechargez opencode-cockpit-images-$Version.tar.gz depuis la page Releases, puis : .\install.ps1 -Mode Load -ImagesArchive <fichier>"
            }
            foreach ($image in $loadedImages) {
                if ($image -notmatch (':' + [regex]::Escape($Version) + '$')) {
                    Write-Attention "Image $image : version differente de $Version. Mise a jour : .\install.ps1 -Mode Pull, ou .\install.ps1 -Mode Load -ImagesArchive <archive $Version>."
                }
            }
            Write-Good 'Images deja chargees reutilisees'
        }
    }
}

New-Item -ItemType Directory -Path (Join-Path $Root 'archives') -Force | Out-Null

# --- 3. Images ---------------------------------------------------------------------------
Push-Location $Root
try {
    if ($Mode -eq 'Load' -and $ImagesArchive) {
        Write-Step "Chargement des images depuis $ImagesArchive"
        $loaded = Get-DockerOutput load --input $ImagesArchive
        if ($loaded.ExitCode -ne 0) { throw "docker load a echoue : $($loaded.Output)" }
        foreach ($match in [regex]::Matches($loaded.Output, 'Loaded image:\s*(\S+)')) {
            $name = $match.Groups[1].Value
            if ($name -match 'opencode-cockpit-opencode') { $config['COCKPIT_OPENCODE_IMAGE'] = $name }
            if ($name -match 'opencode-cockpit-app') { $config['COCKPIT_APP_IMAGE'] = $name }
        }
        Write-Good ("Images : {0}, {1}" -f $config['COCKPIT_OPENCODE_IMAGE'], $config['COCKPIT_APP_IMAGE'])
    }

    if (-not $modeInferred) { $config['COCKPIT_INSTALL_MODE'] = $Mode }
    # Version de production affichee dans l'interface pour les images construites sur le poste.
    $config['COCKPIT_VERSION'] = $Version
    # Registre memorise seulement s'il a ete choisi : sinon, le defaut de la version installee s'applique.
    if ($PSBoundParameters.ContainsKey('ImageRegistry')) { $config['COCKPIT_IMAGE_REGISTRY'] = $ImageRegistry }
    Write-EnvFile $EnvFile $config
    if ($isNew) { Write-Good 'Fichier .env cree' } else { Write-Good 'Fichier .env mis a jour (secrets conserves)' }

    try {
        if ($Mode -eq 'Build') {
            Write-Step 'Construction des images (quelques minutes la premiere fois)'
            Invoke-Docker compose build
        } elseif ($Mode -eq 'Pull') {
            Write-Step 'Telechargement des images'
            Invoke-Docker compose pull
        }
    } catch {
        # .env retrouve les images precedentes : start et restart continuent de fonctionner.
        if (-not $isNew) {
            foreach ($key in $imageKeys) {
                if ($previousImages.ContainsKey($key)) { $config[$key] = $previousImages[$key] }
                elseif ($config.Contains($key)) { $config.Remove($key) }
            }
            Write-EnvFile $EnvFile $config
            Write-Attention 'Echec : les images precedentes restent configurees dans .env.'
        }
        throw
    }

    if ($NoStart) {
        Write-Step 'Installation terminee (demarrage non demande)'
        Write-Info 'Demarrer : .\cockpit.ps1 start'
        return
    }

    # --- 4. Demarrage ----------------------------------------------------------------------
    # Les volumes partages doivent appartenir a l'utilisateur non-root des conteneurs (uid 1000),
    # quel que soit le conteneur qui les a initialises en premier (sinon opencode redemarre en boucle).
    Write-Step 'Preparation des volumes'
    Invoke-Docker compose up --no-start --remove-orphans
    $volumeArgs = @()
    foreach ($volume in @('oc-config', 'oc-data', 'oc-cache', 'cockpit-data', 'control')) {
        $volumeArgs += @('-v', ('opencode-cockpit_{0}:/volumes/{0}' -f $volume))
    }
    Invoke-Docker run --rm --user 0 --entrypoint chown @volumeArgs $config['COCKPIT_OPENCODE_IMAGE'] -R 1000:1000 /volumes
    Write-Good 'Droits des volumes verifies'

    Write-Step 'Demarrage des conteneurs'
    Invoke-Docker compose up -d --remove-orphans
    Write-Info 'Attente de la disponibilite du cockpit...'
    if (-not (Wait-Health $Port 240)) {
        Write-Attention 'Le cockpit ne repond pas encore. Consultez les journaux : .\cockpit.ps1 logs'
        return
    }
    Write-Good ("Cockpit disponible sur http://127.0.0.1:{0}" -f $Port)
} finally {
    Pop-Location
}

$loginUrl = 'http://127.0.0.1:{0}/auth?t={1}' -f $Port, $config['COCKPIT_TOKEN']
if (-not $NoBrowser) { Start-Process $loginUrl }

Write-Step 'Et ensuite ?'
Write-Info '1. Dans l interface : Parametres > Connexion > Connecter GitHub Copilot.'
Write-Info '2. Commandes utiles : .\cockpit.ps1 open | status | logs | stop | update | backup'
Write-Info '3. Les conversations classees sont copiees en Markdown dans le dossier archives\.'
Write-Host ''
