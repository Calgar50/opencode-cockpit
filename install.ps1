<#
.SYNOPSIS
    Installe, configure et demarre opencode-cockpit (Docker Desktop requis).

.DESCRIPTION
    - verifie Docker Desktop ;
    - cree ou complete le fichier .env (secrets aleatoires, dossier des projets, proxy) ;
    - exporte les autorites de certification de confiance de Windows vers certs\windows-trust.pem
      (indispensable derriere un proxy d'entreprise qui inspecte le HTTPS) ;
    - construit, telecharge ou charge les images, demarre les conteneurs et ouvre l'interface.

    Acces local en HTTPS par defaut (https://127.0.0.1:<port>), avec un certificat auto-signe cree dans
    le volume cockpit-tls. Le navigateur affiche un avertissement au premier acces : ce script affiche
    l'empreinte SHA-256 a comparer. Avant d'ouvrir le lien, il verifie le serveur (empreinte du certificat
    et preuve du jeton) ; le lien ouvert est a usage unique et ne contient pas le jeton.

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

.PARAMETER CopilotApiUrl
    Adresse d'API Copilot imposee quand le pare-feu de l'entreprise n'ouvre que celle de l'abonnement, par exemple
    https://api.business.githubcopilot.com. Vide : adresse d'office, ou celle de l'abonnement annoncee par GitHub
    quand le reseau bloque la premiere. Reglage memorise dans .env (COCKPIT_COPILOT_API_URL).

.PARAMETER InsecureTls
    Desactive la verification des certificats TLS dans les conteneurs. Solution de secours
    uniquement, si l'export des certificats ne suffit pas. Reglage memorise dans .env.

.PARAMETER SecureTls
    Reactive la verification TLS apres un -InsecureTls.

    Le mode d'installation (-Mode) est memorise dans .env, ainsi que le registre s'il a ete passe
    avec -ImageRegistry : une relance sans -Mode (ou cockpit.ps1 update) reutilise le meme mode.

.PARAMETER Http
    Sert le cockpit en HTTP local (http://127.0.0.1:<port>) au lieu de HTTPS : a n'utiliser que si la
    strategie d'entreprise interdit de passer l'avertissement de certificat dans le navigateur. Le cookie
    de session et tout le contenu des pages circulent alors EN CLAIR sur ce PC. Le choix doit etre confirme
    en tapant HTTP EN CLAIR, il est memorise dans .env avec sa date, rappele par un bandeau permanent de
    l'interface, et garde par chaque mise a jour jusqu'a un .\install.ps1 -Https.

.PARAMETER Https
    Revient a l'acces HTTPS local apres un -Http (nouveau jeton, reconnexion necessaire).

.PARAMETER TlsPreflight
    Verifie le poste sans rien modifier et sans Docker : strategies du navigateur, mode inscrit dans .env,
    voie de verification disponible. Code de sortie 3 si Edge interdit de passer l'avertissement, 0 sinon.

.PARAMETER AcceptBrowserBlock
    Poursuit l'installation en HTTPS meme quand la lecture du registre annonce qu'Edge interdit de passer
    l'avertissement (par exemple quand l'exception est livree par le cloud et absente du registre).
    Jamais memorise dans .env.

.PARAMETER OmoArchive
    Archive de l'image de la Salle Oh My OpenAgent, construite sur le PC personnel et recopiee ici avec son
    fichier .sha256 voisin. L'empreinte de l'archive est verifiee AVANT tout chargement, puis l'identifiant
    de l'image chargee est compare a celui du .sha256. L'etiquette est inscrite dans .env ; la salle reste
    coupee (COCKPIT_OMO=off) tant que vous ne l'activez pas vous-meme.

.PARAMETER OmoProjetsSeulement
    Genere seulement les deux fichiers des projets prepares (liste et surcharge compose) a partir du dossier
    donne par -WorkspacePath, sans toucher a .env ni a Docker. Sert aux bancs et aux tests. Code de sortie 4
    si un depot git du dossier ne peut pas etre protege.
    Dans la salle, le dossier de travail est en LECTURE SEULE ; la surcharge n'y ouvre en ecriture que les
    entrees de premier niveau des projets prepares, une par une (jamais .git, jamais la racine d'un projet).
    L'IA de la salle ne peut donc creer ni fichier ni dossier a la racine d'un projet (refus net), et un
    fichier ou dossier ajoute a la racine d'un projet demande de relancer install.ps1.

.PARAMETER WorkspacePath
    Dossier de travail parcouru par -OmoProjetsSeulement (obligatoire avec lui, ignore sinon).

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
    [string]$CopilotApiUrl,
    [switch]$SkipCertificates,
    [switch]$InsecureTls,
    [switch]$SecureTls,
    [switch]$NoStart,
    [switch]$NoBrowser,
    [switch]$Http,
    [switch]$Https,
    [switch]$TlsPreflight,
    [switch]$AcceptBrowserBlock,
    [string]$OmoArchive,
    [switch]$OmoProjetsSeulement,
    [string]$WorkspacePath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = $PSScriptRoot
$EnvFile = Join-Path $Root '.env'
$Version = 'dev'
$VersionFile = Join-Path $Root 'VERSION'
if (Test-Path -LiteralPath $VersionFile) { $Version = (Get-Content -LiteralPath $VersionFile -TotalCount 1).Trim() }
# Version minimale d'image capable de servir le mode choisi et la preuve du jeton : une installation plus ancienne est une
# migration (passage au HTTPS local). Ne change pas avec les versions suivantes : une installation 1.0.5 garde son mode d'acces.
$MinimumImageVersion = [version]'1.0.5'
# Version minimale des images pour ce docker-compose.yml (1.0.6) : opencode n'y a plus d'autre sortie que le relais du cockpit.
$RequiredImageVersion = [version]'1.0.6'

# Mode de langage restreint (AppLocker, WDAC) : le chargement de CockpitTls.ps1 et les appels .NET echoueraient
# plus loin, avec un message incomprehensible. Meme texte que Assert-CockpitFullLanguage, avant tout chargement.
$LanguageMode = [string]$ExecutionContext.SessionState.LanguageMode
if ($LanguageMode -ne 'FullLanguage') {
    throw ("PowerShell est en mode de langage {0} sur ce poste (strategie AppLocker ou WDAC) : les scripts du cockpit exigent FullLanguage. Aucune modification. Lancez-les depuis un dossier autorise par l'informatique." -f $LanguageMode)
}

# Bibliotheque commune (adresses, sante, strategies du navigateur, isolation de docker compose).
$TlsLibrary = Join-Path $Root 'CockpitTls.ps1'
if (-not (Test-Path -LiteralPath $TlsLibrary -PathType Leaf)) {
    throw 'Fichiers de la version incomplets : CockpitTls.ps1 est absent du dossier du cockpit. Retelechargez la version complete (page Releases ou git pull), puis relancez.'
}
$zone = $null
try { $zone = Get-Item -LiteralPath $TlsLibrary -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue } catch { $zone = $null }
if ($null -ne $zone) {
    throw 'CockpitTls.ps1 est marque comme telecharge depuis Internet : Windows refuse de le charger. Lancez Unblock-File .\install.ps1, .\cockpit.ps1, .\CockpitTls.ps1 puis relancez.'
}
try { . $TlsLibrary } catch {
    throw ("Chargement de CockpitTls.ps1 impossible : {0} Si les fichiers viennent d'une archive ZIP : Unblock-File .\install.ps1, .\cockpit.ps1, .\CockpitTls.ps1" -f $_.Exception.Message)
}
Assert-CockpitFullLanguage

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

# Fonctions simples, sans bloc param : un attribut [Parameter()] ajouterait les parametres communs de
# PowerShell, et des options docker comme -v ou -d seraient prises pour -Verbose ou -Debug.
# Toutes les variables lues par docker-compose.yml sont masquees le temps de l'appel, et le fichier compose
# est passe explicitement : ni une variable du shell ni un docker-compose.override.yml ne changent le resultat.
function Invoke-Docker {
    $dockerArgs = ConvertTo-CockpitDockerArgs $Root @($args)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $savedEnv = Clear-CockpitComposeEnv
    try { & docker @dockerArgs } finally { $ErrorActionPreference = $previous; Restore-CockpitComposeEnv $savedEnv }
    if ($LASTEXITCODE -ne 0) { throw ("La commande 'docker {0}' a echoue (code {1})." -f ($dockerArgs -join ' '), $LASTEXITCODE) }
}

function Get-DockerOutput {
    $dockerArgs = ConvertTo-CockpitDockerArgs $Root @($args)
    $output = $null
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $savedEnv = Clear-CockpitComposeEnv
    try { $output = & docker @dockerArgs 2>&1 } finally { $ErrorActionPreference = $previous; Restore-CockpitComposeEnv $savedEnv }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output | Out-String).Trim() }
}

# Migration du web 1.0.x -> 1.1.0 (A37, fiche MW 1.1) : vrai si opencode tourne, ou si on ne peut pas le savoir (ferme en cas de doute).
function Test-OpencodeRunning {
    try {
        $ps = Invoke-CockpitDocker $Root @('compose', 'ps', '-q', '--status', 'running', 'opencode') 30
        return ($ps.TimedOut -or $ps.ExitCode -ne 0 -or ([string]$ps.StdOut).Trim() -cne '')
    } catch { return $true }
}

# Arret d'opencode avant la migration, par Invoke-CockpitDocker (jamais Invoke-Docker, qui leve sur un code non nul), puis controle :
# aucun conteneur opencode en marche. Faux si l'un ou l'autre echoue : la migration n'a alors pas lieu, l'installation continue.
function Stop-OpencodeForWebMigration {
    try {
        $stop = Invoke-CockpitDocker $Root @('compose', 'stop', 'opencode') 120
        if ($stop.TimedOut -or $stop.ExitCode -ne 0) { return $false }
    } catch { return $false }
    return (-not (Test-OpencodeRunning))
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

# Nom lisible de la voie qui a verifie le cockpit (jamais un detail technique de plus).
function Get-MethodLabel([string]$Method) {
    if ($Method -ceq 'curl') { return 'curl' }
    if ($Method -ceq 'csharp') { return 'classe .NET' }
    if ($Method -ceq 'native') { return 'HttpWebRequest' }
    return 'voie inconnue'
}

# Port retenu pour la garde du navigateur et l'adresse affichee, avant que .env ne soit complete.
function Get-GuardPort($Config) {
    if ($Port -gt 0) { return $Port }
    if ($Config.Contains('COCKPIT_PORT')) {
        $parsed = 0
        if ([int]::TryParse([string]$Config['COCKPIT_PORT'], [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535) { return $parsed }
    }
    return 7777
}

# Cause d'un schema servi different de .env : noms des variables (jamais leurs valeurs) ou fichier voisin.
function Get-DivergenceCause($Divergence) {
    $scopes = @{ 'Process' = 'Processus'; 'User' = 'Utilisateur'; 'Machine' = 'Machine' }
    if ($Divergence.Variables.Count -gt 0) {
        $names = @($Divergence.Variables | ForEach-Object { '{0} ({1})' -f $_.Name, $scopes[[string]$_.Scope] })
        return ('variable(s) {0} definie(s)' -f ($names -join ', '))
    }
    if ($Divergence.Files.Count -gt 0) { return ('fichier {0} dans le dossier du cockpit' -f ($Divergence.Files -join ', ')) }
    return 'aucune : .env modifie sans redemarrage'
}

# Version d'une chaine du fichier .env ($null si absente ou illisible : une 1.0.4 ecrit 1.0.4, une image de
# developpement ecrit dev).
function ConvertTo-CockpitVersionOrNull([string]$Text) {
    if ($Text -cmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)') { return [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3]) }
    return $null
}

# --- Salle Oh My OpenAgent : archive, projets prepares et protection git (D-2b-28, MO-3, L16c) ----------
# Valeurs reprises du contrat machine docker\opencode-omo\contrat-salle.json (services.salle, fichiersControle.projets)
# et des bornes du superviseur (supervisor-lib.mjs) : l'egalite est verifiee par tests\ps51\Test-OmoInstall.ps1.
# L16c (decision A16, option E1) : docker-compose.yml monte le dossier de travail ENTIER en lecture seule dans la salle ;
# la surcharge generee ici n'y rouvre l'ecriture que par exception, une entree de premier niveau de projet a la fois.
# Sur Docker Desktop Windows, un .git:ro pose SOUS un dossier en ecriture se contourne (casse, noms courts 8.3, dossier
# parent : 10 alias inscriptibles mesures) ; sous un ancetre en lecture seule, tout alias repond EROFS.
$OmoServiceSalle = 'opencode-omo'
$OmoServiceCockpit = 'cockpit'
$OmoFichierProjets = 'omo-projets.json'
$OmoCibleWorkspace = '/workspace'
# SOURCE de la liste des projets prepares, vue par le cockpit : elle vit sur l'hote et n'est JAMAIS le fichier que le
# cockpit depose dans le volume de controle (COCKPIT_OMO_CONTROL_DIR). Egale a COCKPIT_OMO_PROJECTS_FILE du compose.
$OmoCibleProjetsSource = '/omo-source/omo-projets.json'
$OmoPlafondEntrees = 200000
$OmoProfondeurMax = 256
$OmoListeMax = 20

function Get-FileSha256([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()) } finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

# Fichier <archive>.sha256 ecrit a la construction de l'image : trois lignes separees par LF,
#   <empreinte de l'archive, 64 hex>  <nom de l'archive>
#   image-id sha256:<64 hex>
#   image opencode-cockpit/opencode-omo:<etiquette>
# Rien n'est rendu si une seule ligne est hors format : une archive dont on ne sait rien n'est jamais chargee.
function Read-OmoChecksumFile([string]$Path, [string]$ArchiveName) {
    $lines = @(([System.IO.File]::ReadAllText($Path) -split "`n") | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_ -ne '' })
    if ($lines.Count -ne 3) { throw ("Fichier {0} hors format : trois lignes attendues (empreinte, image-id, image)." -f (Split-Path -Leaf $Path)) }
    if ($lines[0] -cnotmatch '^([0-9a-f]{64})  (\S.*)\z') { throw ("Fichier {0} hors format : la 1re ligne doit porter l empreinte de l archive et son nom." -f (Split-Path -Leaf $Path)) }
    $sha = $Matches[1]
    $nom = $Matches[2]
    if ($lines[1] -cnotmatch '^image-id (sha256:[0-9a-f]{64})\z') { throw ("Fichier {0} hors format : la 2e ligne doit porter l identifiant, sous la forme image-id sha256:<64 caracteres hexadecimaux>." -f (Split-Path -Leaf $Path)) }
    $imageId = $Matches[1]
    if ($lines[2] -cnotmatch '^image (opencode-cockpit/opencode-omo:[0-9A-Za-z_][0-9A-Za-z_.-]{0,127})\z') { throw ("Fichier {0} hors format : la 3e ligne doit porter l etiquette, sous la forme image opencode-cockpit/opencode-omo:<etiquette>." -f (Split-Path -Leaf $Path)) }
    $image = $Matches[1]
    if ($nom -ine $ArchiveName) { throw ("Fichier {0} : il decrit l archive {1}, pas {2}. Recopiez l archive et son .sha256 ensemble." -f (Split-Path -Leaf $Path), $nom, $ArchiveName) }
    return [pscustomobject]@{ Sha256 = $sha; ImageId = $imageId; Image = $image }
}

# Texte YAML entre guillemets doubles : contre-obliques, guillemets et caracteres de controle echappes.
function ConvertTo-OmoYamlText([string]$Value) {
    $builder = New-Object System.Text.StringBuilder '"'
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq '\') { [void]$builder.Append('\\') }
        elseif ($ch -eq '"') { [void]$builder.Append('\"') }
        elseif ($code -lt 32 -or $code -eq 127) { [void]$builder.Append(('\x{0:x2}' -f $code)) }
        else { [void]$builder.Append($ch) }
    }
    return $builder.Append('"').ToString()
}

# Texte JSON d'une chaine : meme echappement que JSON.stringify, tout ce qui sort de l'ASCII imprimable passe en \uXXXX.
function ConvertTo-OmoJsonText([string]$Value) {
    $builder = New-Object System.Text.StringBuilder '"'
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq '\') { [void]$builder.Append('\\') }
        elseif ($ch -eq '"') { [void]$builder.Append('\"') }
        elseif ($code -lt 32 -or $code -gt 126) { [void]$builder.Append(('\u{0:x4}' -f $code)) }
        else { [void]$builder.Append($ch) }
    }
    return $builder.Append('"').ToString()
}

# Vrai pour un lien symbolique ou une jonction Windows : jamais suivi, jamais protegeable par un bind.
function Test-OmoReparsePoint($Info) {
    return (([int]$Info.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

# Nom ramene a ce que Windows en fait : casse ignoree, points et espaces de fin retires (Win32 les ignore).
function ConvertTo-OmoNomNormalise([string]$Nom) { return $Nom.ToLowerInvariant().TrimEnd('.', ' ') }

# Nom qui designe .git pour git sous Windows (.git, .GIT, .Git...) : un depot, quelle que soit la casse (L16c).
function Test-OmoNomGit([string]$Nom) { return ($Nom -ieq '.git') }

# Nom JAMAIS ouvert en ecriture (decision A16) : tout nom qui se ramene a .git (casse, points ou espaces de fin) et les
# noms courts 8.3 de .git (GIT~1...), meme quand ils designent autre chose : ce n'est pas a la salle de le deviner.
function Test-OmoNomGitOuCourt([string]$Nom) {
    $normal = ConvertTo-OmoNomNormalise $Nom
    return (($normal -ceq '.git') -or ($normal -cmatch '^git~[0-9]+\z'))
}

# Dossier des carnets de l'extension (.omo) : jamais cree dans un projet, jamais ouvert en ecriture s'il existe (A16 point 2).
# Grande fusion, decision D4 : sequence %XX qu'opencode 1.18.30 decoderait (meme motif que PERCENT_ESCAPE de projects.ts) ;
# un % isole ("Remise 20%") n'en est pas une.
function Test-OmoSequenceEchappee([string]$Chemin) { return ($Chemin -cmatch '%[0-9A-Fa-f]{2}') }

function Test-OmoNomCarnets([string]$Nom) { return ((ConvertTo-OmoNomNormalise $Nom) -ceq '.omo') }

# Depot nu (git clone --bare, .bare d'un montage bare + worktrees, x.git servant de depot local) : un fichier HEAD,
# un dossier objects et un dossier refs, comme git lui-meme le reconnait (meme regle que le superviseur).
function Test-OmoBareRepo($Entries) {
    $head = @($Entries | Where-Object { $_.Name -ceq 'HEAD' -and $_ -is [System.IO.FileInfo] })
    $objects = @($Entries | Where-Object { $_.Name -ceq 'objects' -and $_ -is [System.IO.DirectoryInfo] })
    $refs = @($Entries | Where-Object { $_.Name -ceq 'refs' -and $_ -is [System.IO.DirectoryInfo] })
    return ($head.Count -gt 0 -and $objects.Count -gt 0 -and $refs.Count -gt 0)
}

# Cible "gitdir: <chemin>" d'un .git FICHIER (sous-module, worktree, --separate-git-dir), resolue cote hote.
# Un fichier pointeur lie en :ro ne protege rien par lui-meme : git ecrit et execute ce qui est au bout.
# Rend $null si la ligne est absente, si la cible n'existe pas, sort du dossier de travail, ou passe par un lien.
function Resolve-OmoGitdirTarget([string]$GitFile, [string]$Workspace) {
    $text = ''
    try { $text = [System.IO.File]::ReadAllText($GitFile) } catch { return $null }
    if ($text.Length -gt 4096) { return $null }
    $first = (($text -split "`n")[0]).TrimEnd("`r")
    if ($first -cnotmatch '^gitdir:[ \t]*(\S(?:.*\S)?)[ \t]*\z') { return $null }
    $target = $Matches[1]
    try {
        if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $GitFile) $target }
        $target = [System.IO.Path]::GetFullPath($target).TrimEnd('\')
    } catch { return $null }
    if (-not (Test-Path -LiteralPath $target -PathType Container)) { return $null }
    $base = (Get-NormalizedPath $Workspace)
    if (-not $target.StartsWith($base + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    # Aucun maillon de lien entre le dossier de travail et la cible : on ne juge pas un detour.
    $current = $target
    while ($current.Length -gt $base.Length) {
        $info = $null
        try { $info = Get-Item -LiteralPath $current -Force } catch { return $null }
        if (Test-OmoReparsePoint $info) { return $null }
        $current = (Split-Path -Parent $current).TrimEnd('\')
        if (-not $current) { return $null }
    }
    return $target
}

# Grande fusion, decision D7 c : drapeaux de la 1.0.6 dans l'ENV d'une image (docker image inspect, une ligne CLE=VALEUR
# par variable ; noms sensibles a la casse). Une image de la salle construite sur une base plus ancienne ne les porte pas.
function Test-OmoImageFlags([string]$EnvText) {
    return ($EnvText -cmatch '(?m)^OPENCODE_DISABLE_MODELS_FETCH=1\r?$' -and $EnvText -cmatch '(?m)^npm_config_offline=true\r?$')
}

# ENV d'une IMAGE (jamais d'un conteneur, dont l'environnement contient les secrets) : seule lecture de .Config.Env de ce
# script, admise nommement par tests/ps51/Validate-Scripts.ps1. Faux si l'image est illisible.
function Test-OmoImageEnvFlags([string]$Image) {
    if (-not $Image -or $Image.StartsWith('-')) { return $false }
    $read = Get-DockerOutput image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Image
    return ($read.ExitCode -eq 0 -and (Test-OmoImageFlags ([string]$read.Output)))
}

# Parcours du dossier de travail (D-2b-28) : liens et jonctions jamais suivis, node_modules et interieurs de .git
# exclus, nombre d'entrees et profondeur bornes. Rend les projets prepares, les depots a proteger, les entrees de
# premier niveau de chaque projet (L16c : ce que la surcharge peut ouvrir en ecriture) et, le cas echeant, la liste
# de ce qui ne peut pas l'etre (un seul element suffit a refuser la surcharge).
function Get-OmoWorkspaceScan([string]$Workspace) {
    $root = Get-NormalizedPath $Workspace
    $projets = New-Object System.Collections.Generic.List[object]
    $proteges = New-Object System.Collections.Generic.List[object]
    $problemes = New-Object System.Collections.Generic.List[string]
    # Cles comparees a l'octet : deux projets ne different jamais que par la casse sur NTFS, mais rien n'est suppose.
    $entreesProjets = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::Ordinal)
    $entrees = 0
    $ajouter = {
        param([string]$Texte)
        if ($problemes.Count -lt $OmoListeMax) { $problemes.Add($Texte) }
    }
    $pile = New-Object System.Collections.Generic.Stack[object]
    $pile.Push([pscustomobject]@{ Relatif = ''; Profondeur = 0 })
    while ($pile.Count -gt 0) {
        $noeud = $pile.Pop()
        $relatif = [string]$noeud.Relatif
        $absolu = $root
        if ($relatif -cne '') { $absolu = Join-Path $root ($relatif -replace '/', '\') }
        if ([int]$noeud.Profondeur -gt $OmoProfondeurMax) {
            & $ajouter ('{0} : dossier trop profond (plus de {1} niveaux)' -f $relatif, $OmoProfondeurMax)
            break
        }
        $entries = $null
        try { $entries = @((New-Object System.IO.DirectoryInfo $absolu).GetFileSystemInfos()) } catch {
            # Dossier illisible (droits refuses) : il peut cacher un depot. Balayage incomplet, verdict ferme.
            & $ajouter ('{0} : dossier illisible, un depot git peut s y cacher' -f $(if ($relatif -ceq '') { '.' } else { $relatif }))
            break
        }
        if ($relatif -cne '' -and (Test-OmoBareRepo $entries)) {
            $proteges.Add([pscustomobject]@{ Chemin = $relatif; Forme = 'dossier'; Source = $absolu })
            continue
        }
        if ($relatif -ceq '' -and (Test-OmoBareRepo $entries)) {
            & $ajouter '. : le dossier de travail est lui-meme un depot nu ; choisissez un dossier qui contient vos projets'
            break
        }
        $aGit = $false
        $estProjet = $false
        $sousDossiers = New-Object System.Collections.Generic.List[object]
        foreach ($entry in $entries) {
            $entrees++
            if ($entrees -gt $OmoPlafondEntrees) {
                & $ajouter ('plafond de {0} entrees atteint : le dossier de travail est trop grand pour etre verifie' -f $OmoPlafondEntrees)
                break
            }
            $nom = $entry.Name
            $cheminRelatif = $nom
            if ($relatif -cne '') { $cheminRelatif = $relatif + '/' + $nom }
            # .git a la casse pres (.GIT est le depot pour git sous Windows) : L16c.
            if (Test-OmoNomGit $nom) {
                $aGit = $true
                if (Test-OmoReparsePoint $entry) {
                    & $ajouter ('{0} : lien ou jonction, impossible a proteger par un montage' -f $cheminRelatif)
                    continue
                }
                if ($entry -is [System.IO.DirectoryInfo]) {
                    $proteges.Add([pscustomobject]@{ Chemin = $cheminRelatif; Forme = 'dossier'; Source = $entry.FullName })
                    if ($relatif -cne '' -and -not $estProjet) {
                        $projets.Add([pscustomobject]@{ Chemin = $relatif; Git = 'dossier' })
                        $estProjet = $true
                    }
                    continue
                }
                # .git fichier : protege par un bind de fichier :ro (MO-3 point 5), a condition que sa cible le soit aussi.
                $cible = Resolve-OmoGitdirTarget $entry.FullName $root
                if ($null -eq $cible) {
                    & $ajouter ('{0} : fichier "gitdir:" dont la cible est introuvable, hors du dossier de travail ou atteinte par un lien' -f $cheminRelatif)
                    continue
                }
                $proteges.Add([pscustomobject]@{ Chemin = $cheminRelatif; Forme = 'fichier'; Source = $entry.FullName })
                $cibleRelative = $cible.Substring($root.Length).TrimStart('\') -replace '\\', '/'
                if (@($proteges | Where-Object { $_.Chemin -ceq $cibleRelative }).Count -eq 0) {
                    $proteges.Add([pscustomobject]@{ Chemin = $cibleRelative; Forme = 'dossier'; Source = $cible })
                }
                continue
            }
            if ($nom -ceq 'node_modules') { continue }
            if (-not ($entry -is [System.IO.DirectoryInfo])) { continue }
            if (Test-OmoReparsePoint $entry) {
                & $ajouter ('{0} : lien ou jonction de dossier ; son contenu ne peut pas etre protege' -f $cheminRelatif)
                continue
            }
            $sousDossiers.Add([pscustomobject]@{ Relatif = $cheminRelatif; Profondeur = [int]$noeud.Profondeur + 1 })
        }
        if ($entrees -gt $OmoPlafondEntrees) { break }
        # Dossier de premier niveau sans aucun .git : projet prepare quand meme (spec. 3.15.2 "projet sans .git : accepte").
        if ($relatif -cne '' -and -not $aGit -and ($relatif -cnotmatch '/')) {
            $projets.Add([pscustomobject]@{ Chemin = $relatif; Git = 'absent' })
            $estProjet = $true
        }
        # Entrees de premier niveau du projet, deja lues et comptees : la surcharge n'ouvre en ecriture que parmi elles (L16c).
        if ($estProjet) { $entreesProjets[$relatif] = @($entries) }
        foreach ($sous in $sousDossiers) { $pile.Push($sous) }
    }
    # Grande fusion, decision D4 : un projet dont le chemin porte une sequence %XX (par exemple a%2F..%2Fx) est ecarte de la
    # preparation. opencode 1.18.30 decode le dossier DEUX fois et ouvrirait la salle ailleurs, hors du dossier de travail ; le
    # cockpit le refuse de toute facon. Ecarte, il reste en lecture seule pour la salle, et ses .git restent proteges.
    $ecartes = New-Object System.Collections.Generic.List[string]
    $prepares = New-Object System.Collections.Generic.List[object]
    foreach ($projet in $projets.ToArray()) {
        $chemin = [string]$projet.Chemin
        if (Test-OmoSequenceEchappee $chemin) { $ecartes.Add($chemin); [void]$entreesProjets.Remove($chemin) } else { $prepares.Add($projet) }
    }
    # Un meme dossier peut etre vu deux fois (cible d'un .git fichier qui est aussi un depot nu) : un seul montage.
    # .ToArray() avant tout tri ou filtre : PowerShell 5.1 se trompe de liaison sur @(<List[object]> | ...).
    $uniques = New-Object System.Collections.Generic.List[object]
    $vus = @{}
    foreach ($item in ($proteges.ToArray() | Sort-Object -Property Chemin)) {
        if (-not $vus.ContainsKey($item.Chemin)) { $vus[$item.Chemin] = $true; $uniques.Add($item) }
    }
    return [pscustomobject]@{ Racine = $root
        Projets = @($prepares.ToArray() | Sort-Object -Property Chemin)
        Ecartes = @($ecartes.ToArray() | Sort-Object)
        Proteges = @($uniques.ToArray())
        Problemes = @($problemes.ToArray())
        Entrees = $entrees
        EntreesProjets = $entreesProjets }
}

# Ecriture par exception (L16c, decision A16, option E1). docker-compose.yml monte le dossier de travail ENTIER en
# lecture seule sur /workspace ; seule cette liste y rouvre l'ecriture : un montage distinct par entree de premier
# niveau (dossier OU fichier) de chaque projet prepare. Restent en lecture seule, proteges par l'ancetre :
#   - .git et tout nom qui s'y ramene (casse, points ou espaces de fin, nom court GIT~n) ;
#   - .omo, dossier des carnets de l'extension : la salle n'ecrit jamais ses carnets sur le poste (A16 point 2) ;
#   - toute entree qui contient un depot git (sous-module, depot imbrique, depot nu, cible gitdir:) ou un autre projet
#     prepare : ouverte en ecriture, elle rendrait ce depot inscriptible, crochets compris, sous tous ses alias.
# Jamais d'ecriture sur la racine d'un projet ni sur le dossier de travail : la salle ne peut rien creer a la racine
# d'un projet (refus net, EROFS), et une entree ajoutee apres l'installation attend la relance d'install.ps1 ; une entree
# supprimee, renommee ou remplacee par un lien aussi, la salle ne demarrant plus d'ici la (relecture 2ter-vague-3). Un lien
# de fichier a ce niveau est refuse (les liens de dossier le sont deja par le parcours) : docker le suivrait sur l'hote
# et ouvrirait sa cible en ecriture.
function Get-OmoEcritures($Scan) {
    $ecritures = New-Object System.Collections.Generic.List[object]
    $gardees = New-Object System.Collections.Generic.List[object]
    $problemes = New-Object System.Collections.Generic.List[string]
    $depots = New-Object System.Collections.Generic.List[string]
    foreach ($item in @($Scan.Proteges)) { $depots.Add([string]$item.Chemin) }
    foreach ($item in @($Scan.Projets)) { $depots.Add([string]$item.Chemin) }
    foreach ($projet in @($Scan.Projets)) {
        $chemin = [string]$projet.Chemin
        if (-not $Scan.EntreesProjets.ContainsKey($chemin)) { continue }
        foreach ($entry in @($Scan.EntreesProjets[$chemin] | Sort-Object -Property Name -CaseSensitive)) {
            $nom = [string]$entry.Name
            $relatif = $chemin + '/' + $nom
            if (Test-OmoNomGitOuCourt $nom) { continue }
            if (Test-OmoNomCarnets $nom) {
                $gardees.Add([pscustomobject]@{ Chemin = $relatif; Raison = 'carnets de l extension, jamais ouverts en ecriture' })
                continue
            }
            if (Test-OmoReparsePoint $entry) {
                if (-not ($entry -is [System.IO.DirectoryInfo]) -and $problemes.Count -lt $OmoListeMax) {
                    $problemes.Add(('{0} : lien a la racine d un projet ; l ouvrir en ecriture ouvrirait sa cible' -f $relatif))
                }
                continue
            }
            $contient = $false
            foreach ($depot in $depots) {
                if ($depot -ceq $relatif -or $depot.StartsWith($relatif + '/', [System.StringComparison]::Ordinal)) { $contient = $true; break }
            }
            if ($contient) {
                $gardees.Add([pscustomobject]@{ Chemin = $relatif; Raison = 'contient un depot git' })
                continue
            }
            # Forme relevee a la generation (relecture 2ter-vague-3) : cockpit.ps1 la compare avant chaque demarrage de la salle.
            $forme = 'fichier'
            if ($entry -is [System.IO.DirectoryInfo]) { $forme = 'dossier' }
            $ecritures.Add([pscustomobject]@{ Projet = $chemin; Nom = $nom; Source = $entry.FullName; Cible = ($OmoCibleWorkspace + '/' + $relatif); Forme = $forme })
        }
    }
    return [pscustomobject]@{ Ecritures = @($ecritures.ToArray()); Gardees = @($gardees.ToArray()); Problemes = @($problemes.ToArray()) }
}

# omo-projets.json : format OmoPreparedProjects (T3a), chemins relatifs a /workspace, fins de ligne LF.
function ConvertTo-OmoProjectsJson($Scan) {
    $lignes = New-Object System.Collections.Generic.List[string]
    $lignes.Add('{')
    $lignes.Add('  "version": 1,')
    $lignes.Add(('  "genereLe": {0},' -f (ConvertTo-OmoJsonText ([DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)))))
    $lignes.Add('  "projets": [')
    $corps = @($Scan.Projets | ForEach-Object { '    { "chemin": ' + (ConvertTo-OmoJsonText $_.Chemin) + ', "git": ' + (ConvertTo-OmoJsonText $_.Git) + ' }' })
    for ($i = 0; $i -lt $corps.Count; $i++) { $lignes.Add($corps[$i] + $(if ($i -lt $corps.Count - 1) { ',' } else { '' })) }
    $lignes.Add('  ],')
    $lignes.Add('  "gitProteges": [')
    $corps = @($Scan.Proteges | ForEach-Object { '    { "chemin": ' + (ConvertTo-OmoJsonText $_.Chemin) + ', "forme": ' + (ConvertTo-OmoJsonText $_.Forme) + ' }' })
    for ($i = 0; $i -lt $corps.Count; $i++) { $lignes.Add($corps[$i] + $(if ($i -lt $corps.Count - 1) { ',' } else { '' })) }
    $lignes.Add('  ]')
    $lignes.Add('}')
    return (($lignes -join "`n") + "`n")
}

# docker-compose.omo-projets.yml : sur le service de la salle, un montage EN ECRITURE par entree de premier niveau de
# projet prepare (L16c : le dossier de travail y est deja monte en lecture seule par docker-compose.yml, ce sont les
# seules exceptions) ; sur le service du cockpit, le montage en lecture seule de la liste des projets prepares. La liste
# est portee par cette surcharge, jamais par docker-compose.yml : le fichier est git-ignore et absent tant qu'install.ps1
# n'a pas tourne, et docker creerait alors un DOSSIER vide a sa place, que le cockpit relirait "illisible".
# Relecture 2ter-vague-3 : chaque exception est ecrite en syntaxe longue avec bind.create_host_path: false, et porte en
# commentaire la forme relevee (fichier ou dossier). Une entree supprimee ou renommee sur le poste apres cette generation
# serait sinon recreee par Docker en DOSSIER vide, a chaque relance (un fichier devient un dossier) : mesure, Docker Desktop
# 4.91. Avec create_host_path: false, une relance par la politique restart ou par compose restart echoue sans rien creer ;
# seule la creation d'un conteneur (compose up) cree encore la source, et ConvertTo-CockpitDockerArgs (CockpitTls.ps1)
# ne passe alors plus le profil de la salle tant qu'une source manque, a change de forme ou est devenue lien ou jonction.
function ConvertTo-OmoProjectsYaml($Ecritures, [string]$ProjectsFile) {
    $lignes = New-Object System.Collections.Generic.List[string]
    $lignes.Add('# Genere par install.ps1 (D-2b-28, L16c) : dossier de travail en lecture seule, ecriture par exception.')
    $lignes.Add('# Un montage en ecriture par entree de premier niveau de chaque projet prepare ; jamais .git, jamais la racine d un projet.')
    $lignes.Add('# Ne pas modifier a la main ; relancez install.ps1 apres avoir ajoute, supprime, renomme ou remplace par un lien un projet, un fichier ou un dossier a sa racine.')
    $lignes.Add('services:')
    # Source de la liste des projets prepares : le cockpit la LIT ici, puis la recopie normalisee dans /control-omo.
    $lignes.Add('  ' + $OmoServiceCockpit + ':')
    $lignes.Add('    volumes:')
    $sourceListe = ($ProjectsFile -replace '\\', '/')
    $monteListe = ($sourceListe + ':' + $OmoCibleProjetsSource + ':ro') -replace '\$', '$$$$'
    $lignes.Add('      - ' + (ConvertTo-OmoYamlText $monteListe))
    $lignes.Add('  ' + $OmoServiceSalle + ':')
    # Aucune entree a ouvrir (aucun projet, ou des projets sans rien a leur racine) : une liste vide, jamais une cle nulle.
    if (@($Ecritures).Count -eq 0) { $lignes.Add('    volumes: []') }
    else {
        $lignes.Add('    volumes:')
        foreach ($item in @($Ecritures)) {
            # Un dollar dans un nom serait interprete par compose : il se double ($$) pour rester litteral.
            $source = ($item.Source -replace '\\', '/') -replace '\$', '$$$$'
            $cible = $item.Cible -replace '\$', '$$$$'
            $lignes.Add('      - { type: bind, source: ' + (ConvertTo-OmoYamlText $source) + ', target: ' + (ConvertTo-OmoYamlText $cible) + ', bind: { create_host_path: false } } # ' + $item.Forme)
        }
    }
    return (($lignes -join "`n") + "`n")
}

# Un core.hooksPath global qui pointe DANS le dossier de travail fait executer, a chaque commande git du poste, des
# scripts que la salle peut ecrire : elle ne voit pas ce reglage, qui vit dans la configuration git de l'utilisateur.
function Get-OmoHooksPathNotice([string]$Workspace) {
    $found = @(Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($found.Count -eq 0) { return '' }
    $run = Invoke-CockpitProcess -FilePath $found[0].Source -Arguments @('config', '--global', '--get', 'core.hooksPath') -TimeoutSec 20
    if ($run.ExitCode -ne 0) { return '' }
    $value = ([string]$run.StdOut).Trim()
    if (-not $value) { return '' }
    if ($value.StartsWith('~')) { $value = Join-Path $env:USERPROFILE $value.Substring(1).TrimStart('/', '\') }
    try { $resolved = Get-NormalizedPath $value } catch { return '' }
    if (-not (Test-PathOverlap $resolved $Workspace)) { return '' }
    return ("core.hooksPath global de git pointe dans le dossier de travail ({0}) : un depot ouvert dans la salle pourrait y deposer un script execute par vos commandes git. Retirez ce reglage (git config --global --unset core.hooksPath) ou deplacez ce dossier hors du dossier des projets." -f $resolved)
}

# Frictions de l'ecriture par exception (L16c, decision A16 point 6), dites a chaque generation ; le README et la
# documentation de la salle les reprennent. Rien n'est modifie sur le poste pour cela : ni droit administrateur, ni
# attribut de fichier, ni dossier ajoute dans les projets.
function Write-OmoFrictionNotice {
    Write-Info 'Salle : le dossier de travail y est en LECTURE SEULE ; seules les entrees de premier niveau des projets prepares y sont ouvertes en ecriture, une par une.'
    Write-Attention 'L IA de la salle ne peut creer ni fichier ni dossier a la racine d un projet : elle recoit un refus net (systeme de fichiers en lecture seule), jamais une perte silencieuse.'
    Write-Attention 'Apres avoir ajoute un fichier ou un dossier a la racine d un projet, relancez install.ps1 : sans cela, la salle ne peut pas y ecrire.'
    Write-Attention 'Apres avoir supprime, renomme ou remplace par un lien ou une jonction un fichier ou un dossier a la racine d un projet (git clean, npm run clean, changement de branche...), relancez aussi install.ps1 : sans cela, la salle ne demarre plus (cockpit.ps1 le dit), pour que Docker ne recree pas un dossier vide a sa place sur le poste.'
    Write-Info 'Aucun dossier .omo n est cree dans vos projets : l extension n y tient pas ses carnets (plans, notes), et un .omo deja present reste en lecture seule pour la salle.'
}

# Ecrit les deux fichiers, ou n'ecrit rien et rend faux : la surcharge ne doit jamais decrire une protection partielle.
function Write-OmoProjectFiles([string]$Workspace, [string]$Destination) {
    $scan = Get-OmoWorkspaceScan $Workspace
    $ouverture = Get-OmoEcritures $scan
    $ecartes = @($scan.Ecartes)
    if ($ecartes.Count -gt 0) {
        Write-Attention 'Projets ecartes de la salle : leur nom porte une sequence %XX (par exemple %2F), qu opencode decoderait en un autre chemin, hors du dossier de travail. Renommez-les, puis relancez install.ps1 :'
        foreach ($ecarte in ($ecartes | Select-Object -First $OmoListeMax)) { Write-Host ('    - ' + $ecarte) -ForegroundColor Yellow }
        if ($ecartes.Count -gt $OmoListeMax) { Write-Host ('    - ... et {0} de plus' -f ($ecartes.Count - $OmoListeMax)) -ForegroundColor Yellow }
    }
    $overlay = Join-Path $Destination $CockpitOmoOverlay
    $projectsFile = Join-Path $Destination $OmoFichierProjets
    $problemes = New-Object System.Collections.Generic.List[string]
    foreach ($probleme in (@($scan.Problemes) + @($ouverture.Problemes))) { if ($problemes.Count -lt $OmoListeMax) { $problemes.Add([string]$probleme) } }
    if ($problemes.Count -gt 0) {
        Write-Host ''
        Write-Attention 'Depots git du dossier de travail qui ne peuvent pas etre proteges en lecture seule :'
        foreach ($probleme in $problemes) { Write-Host ('    - ' + $probleme) -ForegroundColor Yellow }
        Write-Attention 'La surcharge du profil de la salle n est PAS ecrite : sans elle, la salle refuse de s activer.'
        # Une surcharge d'une execution precedente decrirait une protection qui n'a plus cours : elle est retiree.
        foreach ($stale in @($overlay, $projectsFile)) { if (Test-Path -LiteralPath $stale -PathType Leaf) { Remove-Item -LiteralPath $stale -Force } }
        return $false
    }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($projectsFile, (ConvertTo-OmoProjectsJson $scan), $utf8)
    [System.IO.File]::WriteAllText($overlay, (ConvertTo-OmoProjectsYaml $ouverture.Ecritures $projectsFile), $utf8)
    Write-Good ('Projets prepares pour la salle : {0} ; entrees ouvertes en ecriture : {1} ; depots git proteges par la lecture seule : {2} ({3} entrees parcourues)' -f $scan.Projets.Count, @($ouverture.Ecritures).Count, $scan.Proteges.Count, $scan.Entrees)
    $gardees = @($ouverture.Gardees)
    if ($gardees.Count -gt 0) {
        Write-Info 'Restent en lecture seule pour la salle, en plus des .git :'
        foreach ($garde in ($gardees | Select-Object -First $OmoListeMax)) { Write-Info ('  - {0} : {1}' -f $garde.Chemin, $garde.Raison) }
        if ($gardees.Count -gt $OmoListeMax) { Write-Info ('  - ... et {0} de plus' -f ($gardees.Count - $OmoListeMax)) }
    }
    Write-OmoFrictionNotice
    $notice = Get-OmoHooksPathNotice $Workspace
    if ($notice) { Write-Attention $notice }
    return $true
}

# --- 0. Incompatibilites de parametres (avant toute commande docker et toute ecriture) -----
if ($Http -and $Https) { throw '-Http et -Https sont incompatibles : choisissez un seul mode d acces.' }
if ($TlsPreflight -and ($Http -or $Https)) { throw '-TlsPreflight ne modifie rien : il ne se combine ni avec -Http ni avec -Https.' }
if ($AcceptBrowserBlock -and $Http) { throw '-AcceptBrowserBlock ne concerne que l acces HTTPS : il est sans objet avec -Http.' }
if ($OmoProjetsSeulement -and $OmoArchive) { throw '-OmoProjetsSeulement n installe rien : il ne se combine pas avec -OmoArchive.' }
if ($OmoProjetsSeulement -and -not $WorkspacePath) { throw '-OmoProjetsSeulement demande -WorkspacePath <dossier> : le dossier de travail a parcourir.' }
if ($WorkspacePath -and -not $OmoProjetsSeulement) { throw '-WorkspacePath ne sert qu avec -OmoProjetsSeulement ; le dossier des projets se choisit avec -WorkspaceDir.' }

Write-Host ''
Write-Host "opencode-cockpit $Version - installation" -ForegroundColor White

# --- 0 ter. Projets prepares seuls : aucune ecriture dans .env, aucun appel a Docker (bancs et tests) ---
if ($OmoProjetsSeulement) {
    if (-not (Test-Path -LiteralPath $WorkspacePath -PathType Container)) { throw ("Dossier de travail introuvable : {0}" -f $WorkspacePath) }
    $omoWorkspace = (Resolve-Path -LiteralPath $WorkspacePath).Path.TrimEnd('\')
    if (Test-PathOverlap $Root $omoWorkspace) {
        throw ("Le dossier du cockpit ({0}) et le dossier de travail ({1}) se chevauchent : la salle pourrait modifier les scripts du cockpit." -f $Root, $omoWorkspace)
    }
    Write-Step ('Projets prepares et protection git : ' + $omoWorkspace)
    if (-not (Write-OmoProjectFiles $omoWorkspace $Root)) { exit 4 }
    Write-Info ('Fichiers ecrits : {0} et {1}' -f $OmoFichierProjets, $CockpitOmoOverlay)
    exit 0
}

# --- 0 quater. Archive de la salle : empreinte lue et verifiee AVANT tout appel a Docker -----------------
$omoChecksum = $null
if ($OmoArchive) {
    $OmoArchive = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OmoArchive)
    if (-not (Test-Path -LiteralPath $OmoArchive -PathType Leaf)) { throw ("Archive de la salle introuvable : {0}" -f $OmoArchive) }
    $omoName = Split-Path -Leaf $OmoArchive
    $omoChecksumFile = $OmoArchive + '.sha256'
    if (-not (Test-Path -LiteralPath $omoChecksumFile -PathType Leaf)) {
        throw ("Fichier d empreinte absent : {0}.sha256 doit se trouver a cote de l archive. Recopiez les deux fichiers ensemble depuis le PC ou l image a ete construite." -f $omoName)
    }
    $omoChecksum = Read-OmoChecksumFile $omoChecksumFile $omoName
    Write-Step 'Verification de l archive de la salle (avant tout chargement)'
    $omoActual = Get-FileSha256 $OmoArchive
    if ($omoActual -cne $omoChecksum.Sha256) {
        throw ("Archive refusee : son empreinte SHA-256 ne correspond pas a {0}.sha256. Aucune image n a ete chargee, aucun fichier modifie. Recopiez l archive depuis le PC ou elle a ete construite." -f $omoName)
    }
    Write-Good ('Empreinte de {0} verifiee' -f $omoName)
}

# --- 0 bis. Verification du poste (-TlsPreflight) : aucune ecriture, aucun appel a Docker ---
if ($TlsPreflight) {
    $preflightConfig = Read-EnvFile $EnvFile
    $preflightPort = Get-GuardPort $preflightConfig
    $preflightMode = Get-CockpitLocalMode $preflightConfig
    $policy = Get-CockpitBrowserTlsPolicy -Port $preflightPort
    $curl = Get-CockpitCurl ''
    Write-Step 'Verification du poste (aucune modification, Docker non requis)'
    Write-Info ('Port vise : {0} ; exception a demander : {1}' -f $preflightPort, $policy.Origin)
    $edgeSource = 'non lue'
    if ($policy.Source) { $edgeSource = [string]$policy.Source }
    Write-Info ('Edge SSLErrorOverrideAllowed : {0} ({1})' -f (Format-CockpitEdgePolicyValue $policy), $edgeSource)
    $origins = @($policy.Origins | Where-Object { $_ -cmatch '^[ -~]{1,80}\z' })
    $originsText = 'aucune'
    if ($origins.Count -gt 0) { $originsText = ($origins | Select-Object -First 10) -join ', ' }
    Write-Info ('Exceptions Edge listees (SSLErrorOverrideAllowedForOrigins) : {0}' -f $originsText)
    Write-Info ('Verdict Edge : {0}' -f $policy.Verdict)
    $chromeValue = 'absente'
    if ($null -ne $policy.Chrome.Value) { $chromeValue = '{0} ({1})' -f $policy.Chrome.Value, $policy.Chrome.Source }
    Write-Info ('Chrome SSLErrorOverrideAllowed (information) : {0}' -f $chromeValue)
    $httpsOnly = 'aucune'
    if (@($policy.HttpsOnly).Count -gt 0) { $httpsOnly = (@($policy.HttpsOnly | ForEach-Object { '{0} = {1} ({2})' -f $_.Name, $_.Value, $_.Source }) -join ' ; ') }
    Write-Info ('Strategies Edge "HTTPS uniquement" (information) : {0}' -f $httpsOnly)
    $modeText = 'aucun fichier .env (installation neuve)'
    if ($preflightConfig.Count -gt 0) {
        if (-not $preflightMode.Valid) { $modeText = 'invalide : {0}' -f $preflightMode.Problem }
        elseif ([string]$preflightMode.Scheme -ceq 'http') { $modeText = 'http, confirme le {0} UTC' -f $preflightMode.ConfirmedAt }
        else { $modeText = 'https' }
    }
    Write-Info ('Mode d acces inscrit dans .env : {0}' -f $modeText)
    if ($curl.Available) { Write-Info ('curl.exe : {0}, version {1}, Schannel' -f $curl.Path, $curl.Version) }
    else { Write-Info ('curl.exe : indisponible ({0})' -f $curl.Reason) }
    $route = 'classe .NET (compilation, alerte antivirus possible)'
    if ($curl.Available) { $route = 'curl ({0}, Schannel)' -f $curl.Version }
    if ($preflightMode.Valid -and [string]$preflightMode.Scheme -ceq 'http') { $route = 'HttpWebRequest (mode HTTP)' }
    Write-Info ('Voie qui serait utilisee : {0}' -f $route)
    Write-Info ('Mode de langage PowerShell : {0}' -f $LanguageMode)
    Write-Info ('Windows : {0}' -f [Environment]::OSVersion.Version)
    Write-Info 'Verification qui fait foi : edge://policy (filtre SSLError).'
    if ($policy.Verdict -ceq 'Bloque') {
        Write-Attention 'Edge interdit de passer l avertissement de certificat : demandez l exception ci-dessus, ou installez en mode HTTP local (.\install.ps1 -Http).'
        exit 3
    }
    exit 0
}

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

# --- 2 bis. Pre-controles groupes (lecture seule, avant toute question et toute ecriture) ---
# Un seul message et un seul arret : le mode d'acces inscrit dans .env, les images du mode Load et la
# strategie du navigateur sont evalues ensemble (plan 3.5.1).
$previousVersion = ''
if ($config.Contains('COCKPIT_VERSION')) { $previousVersion = ([string]$config['COCKPIT_VERSION']).Trim() }
$previousApp = ''
if ($config.Contains('COCKPIT_APP_IMAGE')) { $previousApp = [string]$config['COCKPIT_APP_IMAGE'] }
$previousOpencode = ''
if ($config.Contains('COCKPIT_OPENCODE_IMAGE')) { $previousOpencode = [string]$config['COCKPIT_OPENCODE_IMAGE'] }
$previousInstallMode = ''
if ($config.Contains('COCKPIT_INSTALL_MODE')) { $previousInstallMode = [string]$config['COCKPIT_INSTALL_MODE'] }
$previousToken = ''
if ($config.Contains('COCKPIT_TOKEN')) { $previousToken = [string]$config['COCKPIT_TOKEN'] }
$previousVersionValue = ConvertTo-CockpitVersionOrNull $previousVersion
$isMigration = (-not $isNew) -and (($null -eq $previousVersionValue) -or ($previousVersionValue -lt $MinimumImageVersion))

$modeRead = Get-CockpitLocalMode $config
$transition = Get-CockpitTransition -Mode $modeRead -IsNew $isNew -IsMigration $isMigration -Http:$Http -Https:$Https
$guardPort = Get-GuardPort $config
$policy = Get-CockpitBrowserTlsPolicy -Port $guardPort

# Mode Load sans archive : images presentes et assez recentes pour servir le mode choisi (controle avance ici,
# pour qu'un seul message regroupe explique l'arret).
$loadProblem = ''
if ($Mode -ceq 'Load' -and -not $ImagesArchive) {
    $loadedImages = @(@($previousOpencode, $previousApp) | Where-Object { $_ })
    $missingImages = @($loadedImages | Where-Object { (Get-DockerOutput image inspect --format '{{.Id}}' $_).ExitCode -ne 0 })
    if ($loadedImages.Count -lt 2 -or $missingImages.Count -gt 0) { $loadProblem = 'images absentes' }
    else {
        $appVersion = Get-CockpitImageVersion $previousApp
        if ($null -eq $appVersion) { $loadProblem = 'image {0} de version inconnue, version {1} requise' -f $previousApp, $Version }
        elseif ($appVersion -lt $RequiredImageVersion) { $loadProblem = 'image {0} en version {1}, version {2} requise' -f $previousApp, $appVersion, $Version }
    }
}

$precheck = Get-CockpitPrecheckProblems -Transition $transition -Mode $modeRead -Policy $policy -AcceptBrowserBlock ([bool]$AcceptBrowserBlock) `
    -IsMigration $isMigration -LoadProblem $loadProblem -Port $guardPort -Version $Version -PreviousVersion $previousVersion
if ($precheck.Problems.Count -gt 0) {
    Write-Host ''
    foreach ($problem in $precheck.Problems) { Write-CockpitLines $problem.Lines }
    throw $CockpitA19
}
foreach ($warning in $precheck.Warnings) { Write-CockpitLines $warning.Lines }

# Relance dans le mode deja en place : le choix n'est pas redemande (plan 3.4.1).
if ($Http -and $transition -ceq 'ResteHttp') { Write-Info ('Deja en mode HTTP local (confirme le {0}) : rien a confirmer.' -f $modeRead.ConfirmedAt) }
elseif ($Https -and $transition -ceq 'ResteHttps') { Write-Info 'Deja en HTTPS local : rien a changer.' }

# Seule question du mode HTTP (ecran A5 puis saisie de HTTP EN CLAIR) : aucun parametre ne l'evite.
if ($transition -ceq 'EntreeHttp') { Confirm-CockpitHttpMode $guardPort $policy }

# Valeurs a remettre dans .env si la construction ou le telechargement echoue : sinon .env designerait un mode
# et un jeton differents des conteneurs encore en marche, et plus personne ne pourrait ouvrir le cockpit.
$restoreKeys = @('COCKPIT_OPENCODE_IMAGE', 'COCKPIT_APP_IMAGE', 'COCKPIT_INSTALL_MODE', 'COCKPIT_LOCAL_SCHEME',
    'COCKPIT_LOCAL_HTTP_CONFIRMED', 'COCKPIT_VERSION', 'COCKPIT_TOKEN', 'OPENCODE_SERVER_PASSWORD')
$previousValues = @{}
foreach ($key in $restoreKeys) { if ($config.Contains($key)) { $previousValues[$key] = $config[$key] } }

# Mode final et date de confirmation, toujours ecrits explicitement (une cle absente ou vide = https).
$finalScheme = 'https'
$finalConfirmedAt = ''
if ($transition -ceq 'EntreeHttp') {
    $finalScheme = 'http'
    $finalConfirmedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
} elseif ($transition -ceq 'ResteHttp') {
    $finalScheme = 'http'
    $finalConfirmedAt = [string]$modeRead.ConfirmedAt
}
$config['COCKPIT_LOCAL_SCHEME'] = $finalScheme
$config['COCKPIT_LOCAL_HTTP_CONFIRMED'] = $finalConfirmedAt
$finalMode = [pscustomobject]@{ Scheme = $finalScheme; ConfirmedAt = $finalConfirmedAt; Raw = $finalScheme; Valid = $true; Problem = $null }

# Nouveau jeton des qu'il a pu circuler en clair, ou qu'il n'a pas le format servi par la preuve (plan 3.4.3).
$rawScheme = ''
if ($null -ne $modeRead.Raw) { $rawScheme = ([string]$modeRead.Raw).Trim() }
$backToHttps = ($transition -ceq 'EntreeHttps') -and ($rawScheme -ceq 'http')
$rotateToken = $backToHttps -or ($transition -ceq 'EntreeHttps' -and -not $modeRead.Valid) -or $isMigration -or (-not (Test-CockpitGeneratedToken $previousToken))
$tokenReplaced = $rotateToken -and -not $isNew -and [bool]$previousToken
if ($rotateToken) { $config['COCKPIT_TOKEN'] = New-Secret 32 }

# Le mode HTTP est rappele des le debut de l'installation, y compris avec -NoBrowser et pendant une mise a jour.
if ($finalScheme -ceq 'http') {
    Write-Host ''
    Write-CockpitModeNotice $finalMode $policy
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

# --- 2 ter. Salle : projets prepares et protection git (D-2b-28), avant toute ecriture ------------------
# Seulement quand la salle est en jeu : une installation sans elle n'a rien a monter en lecture seule.
$omoInstalled = $config.Contains('COCKPIT_OMO_IMAGE') -and [string]$config['COCKPIT_OMO_IMAGE']
if ($OmoArchive -or $omoInstalled) {
    Write-Step 'Salle : projets prepares et protection des depots git'
    if (-not (Write-OmoProjectFiles $resolvedWorkspace $Root)) {
        Write-Attention 'Installation arretee : corrigez les points ci-dessus puis relancez (.\install.ps1 -OmoProjetsSeulement -WorkspacePath <dossier> pour verifier sans rien installer).'
        exit 4
    }
}

if (-not $config.Contains('ARCHIVE_DIR')) { $config['ARCHIVE_DIR'] = './archives' }
if ($Port -gt 0) { $config['COCKPIT_PORT'] = [string]$Port }
elseif (-not $config.Contains('COCKPIT_PORT')) { $config['COCKPIT_PORT'] = '7777' }
$Port = [int]$config['COCKPIT_PORT']

if (-not $config.Contains('COCKPIT_TOKEN') -or $config['COCKPIT_TOKEN'].Length -lt 32) { $config['COCKPIT_TOKEN'] = New-Secret 32 }
if (-not $config.Contains('OPENCODE_SERVER_PASSWORD') -or $config['OPENCODE_SERVER_PASSWORD'].Length -lt 16) {
    $config['OPENCODE_SERVER_PASSWORD'] = New-Secret 32
}
# 1.0.6 : avant cette version, opencode envoyait au proxy d'entreprise, en clair, des appels a son propre serveur portant ce mot
# de passe (http://0.0.0.0:4096). Il est donc remplace une fois, a la mise a jour. Secret interne : aucune reconnexion.
$rotateServerPassword = (-not $isNew) -and (($null -eq $previousVersionValue) -or ($previousVersionValue -lt $RequiredImageVersion))
if ($rotateServerPassword) {
    $config['OPENCODE_SERVER_PASSWORD'] = New-Secret 32
    Write-Info ("Mot de passe interne d'opencode renouvele (passage a la {0} : il a pu circuler en clair vers le proxy)." -f $Version)
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
    # 1.0.6 : le relais du cockpit, seule sortie d'opencode, ne passe que par un proxy http:// (schema absent = http://). Avec
    # un autre schema, il refuse tout sur place (rien ne part en direct) : les demandes d'IA d'opencode echoueraient.
    if ($detectedProxy -match '^([A-Za-z][A-Za-z0-9+.-]*)://' -and $Matches[1] -ne 'http') {
        Write-Attention ("Proxy en {0}:// : le relais d'opencode ne sait passer que par un proxy http:// ; les demandes d'IA d'opencode echoueront. Indiquez l'adresse http:// du proxy : .\install.ps1 -Proxy http://<proxy>:<port>" -f $Matches[1].ToLowerInvariant())
    }
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
# Domaine GitHub Enterprise : meme regle que le cockpit 1.0.6, qui refuserait sinon de demarrer (schema et barre finale retires,
# nom DNS d'au moins deux etiquettes, jamais une adresse IP). C'est le seul domaine que le relais ouvre a opencode, pendant une
# connexion a Copilot.
$gheValue = ([string]$config['COCKPIT_GITHUB_ENTERPRISE_DOMAIN']).Trim()
if ($gheValue) {
    $gheValue = ($gheValue -ireplace '^https?://', '' -replace '/\z', '' -replace '\.\z', '').ToLowerInvariant()
    $gheLabel = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
    if ($gheValue.Length -gt 253 -or $gheValue -cnotmatch ('^{0}(\.{0})+\z' -f $gheLabel) -or $gheValue -cmatch '\.([0-9]+|0x[0-9a-f]*)\z') {
        throw 'COCKPIT_GITHUB_ENTERPRISE_DOMAIN refuse : nom de domaine attendu (par exemple entreprise.ghe.com), sans adresse IP, port ni chemin. Corrigez .env puis relancez (.env n a pas ete modifie).'
    }
    $config['COCKPIT_GITHUB_ENTERPRISE_DOMAIN'] = $gheValue
}

# Adresse d'API Copilot imposee (memorisee ; vide = automatique). Meme controle que le cockpit au demarrage :
# une erreur ici evite un conteneur qui refuse de demarrer.
if ($PSBoundParameters.ContainsKey('CopilotApiUrl')) { $config['COCKPIT_COPILOT_API_URL'] = $CopilotApiUrl.Trim() }
elseif (-not $config.Contains('COCKPIT_COPILOT_API_URL')) { $config['COCKPIT_COPILOT_API_URL'] = '' }
$copilotUrl = [string]$config['COCKPIT_COPILOT_API_URL']
if ($copilotUrl) {
    $allowedHosts = @('api.githubcopilot.com', 'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com', 'api.individual.githubcopilot.com')
    $gheDomain = ([string]$config['COCKPIT_GITHUB_ENTERPRISE_DOMAIN']).Trim().ToLowerInvariant()
    if ($gheDomain) { $allowedHosts += "copilot-api.$gheDomain" }
    $urlPattern = '^https://(' + (($allowedHosts | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')/?$'
    if ($copilotUrl -notmatch $urlPattern) {
        throw "COCKPIT_COPILOT_API_URL refusee : utilisez https://api.business.githubcopilot.com, https://api.enterprise.githubcopilot.com, https://api.githubcopilot.com (ou copilot-api.<COCKPIT_GITHUB_ENTERPRISE_DOMAIN> declare dans .env)."
    }
}
if ($config['COCKPIT_COPILOT_API_URL']) { Write-Good ("Adresse d'API Copilot imposee : {0}" -f $config['COCKPIT_COPILOT_API_URL']) }

# Certificats
$certsDir = Join-Path $Root 'certs'
New-Item -ItemType Directory -Path $certsDir -Force | Out-Null
if ($SkipCertificates) {
    Write-Info 'Export des certificats Windows ignore (-SkipCertificates).'
} else {
    $certCount = Export-WindowsCertificates (Join-Path $certsDir 'windows-trust.pem')
    Write-Good "$certCount autorites de certification Windows exportees vers certs\windows-trust.pem"
}

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
            # Relance sans archive : les images deja chargees ont ete verifiees par les pre-controles (A-Load).
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
        # Controle avant toute ecriture de .env : une archive trop ancienne ne sait ni servir le mode choisi,
        # ni prouver qu'elle connait le jeton.
        $loadedVersion = Get-CockpitImageVersion $config['COCKPIT_APP_IMAGE']
        if ($null -eq $loadedVersion -or $loadedVersion -lt $RequiredImageVersion) {
            $seen = 'de version inconnue'
            if ($null -ne $loadedVersion) { $seen = 'en version {0}' -f $loadedVersion }
            throw ("Archive refusee : l'image {0} est {1}, version {2} requise. Telechargez opencode-cockpit-images-{2}.tar.gz (page Releases), puis relancez avec -Mode Load -ImagesArchive <fichier>. Aucun fichier modifie." -f $config['COCKPIT_APP_IMAGE'], $seen, $Version)
        }
    }

    # --- 3 bis. Salle : chargement de l'archive verifiee et comparaison de l'identifiant d'image -------
    if ($null -ne $omoChecksum) {
        Write-Step ('Chargement de l image de la salle depuis ' + (Split-Path -Leaf $OmoArchive))
        $omoLoaded = Get-DockerOutput load --input $OmoArchive
        if ($omoLoaded.ExitCode -ne 0) { throw ("docker load a echoue : {0}" -f $omoLoaded.Output) }
        $omoTags = @([regex]::Matches($omoLoaded.Output, 'Loaded image:\s*(\S+)') | ForEach-Object { $_.Groups[1].Value })
        if ($omoTags -cnotcontains $omoChecksum.Image) {
            throw ("Archive refusee : elle ne contient pas l image {0} annoncee par son .sha256 (chargees : {1}). COCKPIT_OMO_IMAGE n est pas ecrite." -f $omoChecksum.Image, (($omoTags | Select-Object -First 4) -join ', '))
        }
        $omoIdRead = Get-DockerOutput image inspect --format '{{.Id}}' $omoChecksum.Image
        $omoId = ([string]$omoIdRead.Output).Trim()
        if ($omoIdRead.ExitCode -ne 0 -or $omoId -cne $omoChecksum.ImageId) {
            throw ("Archive refusee : l identifiant de l image chargee differe de celui du fichier .sha256. L image n est pas utilisee (COCKPIT_OMO_IMAGE n est pas ecrite) ; supprimez-la avec docker image rm {0}, puis recopiez l archive depuis le PC ou elle a ete construite." -f $omoChecksum.Image)
        }
        # Grande fusion, decision D7 c : une salle construite sur une base anterieure a la 1.0.6 n'herite pas de ses drapeaux
        # (catalogue des modeles coupe, npm hors ligne). Elle ne fuit pas (egress refuse tout sur place), mais remplit le journal
        # des sorties refusees : l'installation l'avertit, sans refuser.
        if (-not (Test-OmoImageEnvFlags $omoChecksum.Image)) {
            Write-Attention 'Image de la salle construite sur une base anterieure a la 1.0.6 (OPENCODE_DISABLE_MODELS_FETCH=1 et npm_config_offline=true absents) : ses sorties refusees par egress rempliront son journal. Reconstruisez-la sur le PC personnel avec scripts\build-omo-image.ps1, sur l image opencode du cockpit 1.0.6 ou plus recente.'
        }
        $config['COCKPIT_OMO_IMAGE'] = $omoChecksum.Image
        # L'interrupteur n'est jamais mis sur "on" par l'installation : la salle s'active depuis l'interface.
        if (-not $config.Contains('COCKPIT_OMO') -or -not [string]$config['COCKPIT_OMO']) { $config['COCKPIT_OMO'] = 'off' }
        # Mot de passe du serveur de la salle : tire par le generateur cryptographique de Windows, jamais affiche.
        if (-not $config.Contains('OPENCODE_OMO_PASSWORD') -or ([string]$config['OPENCODE_OMO_PASSWORD']).Length -lt 32) {
            $config['OPENCODE_OMO_PASSWORD'] = New-Secret 32
            Write-Good 'Mot de passe de la salle genere (jamais affiche, conserve dans .env)'
        }
        Write-Good ('Image de la salle : {0} (identifiant conforme au fichier .sha256)' -f $omoChecksum.Image)
        Write-Info 'La salle reste coupee (COCKPIT_OMO=off) : activez-la depuis l interface, en mode Avance.'
    }
    if (-not $modeInferred) { $config['COCKPIT_INSTALL_MODE'] = $Mode }
    # Version de production affichee dans l'interface pour les images construites sur le poste.
    $config['COCKPIT_VERSION'] = $Version
    # Registre memorise seulement s'il a ete choisi : sinon, le defaut de la version installee s'applique.
    if ($PSBoundParameters.ContainsKey('ImageRegistry')) { $config['COCKPIT_IMAGE_REGISTRY'] = $ImageRegistry }
    # Version remplacee, ecrite une seule fois : cockpit.ps1 rollback y revient sans deviner.
    if ($isMigration -and -not $config.Contains('COCKPIT_PREVIOUS_VERSION')) {
        $config['COCKPIT_PREVIOUS_VERSION'] = $previousVersion
        $config['COCKPIT_PREVIOUS_APP_IMAGE'] = $previousApp
        $config['COCKPIT_PREVIOUS_OPENCODE_IMAGE'] = $previousOpencode
        $config['COCKPIT_PREVIOUS_INSTALL_MODE'] = $previousInstallMode
    }
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
        if ($Mode -eq 'Build' -or $Mode -eq 'Pull') {
            $builtVersion = Get-CockpitImageVersion $config['COCKPIT_APP_IMAGE']
            if ($null -eq $builtVersion -or $builtVersion -lt $RequiredImageVersion) {
                $seen = 'de version inconnue'
                if ($null -ne $builtVersion) { $seen = 'en version {0}' -f $builtVersion }
                throw ("L'image {0} est {1}, version {2} requise. Relancez .\install.ps1 apres avoir mis a jour les fichiers du cockpit (git pull ou nouvelle archive)." -f $config['COCKPIT_APP_IMAGE'], $seen, $Version)
            }
        }
    } catch {
        # .env retrouve les images, le mode d'acces, la version et le jeton precedents : les conteneurs encore
        # en marche restent joignables, et la rotation du jeton aura lieu a la prochaine execution reussie.
        if (-not $isNew) {
            foreach ($key in $restoreKeys) {
                if ($previousValues.ContainsKey($key)) { $config[$key] = $previousValues[$key] }
                elseif ($config.Contains($key)) { $config.Remove($key) }
            }
            Write-EnvFile $EnvFile $config
            Write-Attention 'Echec : les images, le mode d acces et le jeton precedents restent configures dans .env.'
        }
        throw
    }

    if ($NoStart) {
        # Migration du web (A37, fiche MW 1.1 point 2) : seulement si le volume de configuration d'opencode existe ET si opencode ne
        # tourne pas ; jamais d'arret ni de demarrage ici. Jamais bloquante : le fichier sera lu au prochain cockpit.ps1 start.
        $webLines = @()
        try {
            $noStartProject = Get-CockpitComposeProjectName $Root
            $volume = Invoke-CockpitDocker '' @('volume', 'inspect', '--format', '{{.Name}}', ('{0}_oc-config' -f $noStartProject)) 30
            if (-not $volume.TimedOut -and $volume.ExitCode -eq 0) {
                $webMigration = New-CockpitWebMigrationResult 'non-migre' 'opencode-actif'
                if (-not (Test-OpencodeRunning)) { $webMigration = Invoke-CockpitWebMigration -Root $Root -Project $noStartProject -Image $config['COCKPIT_APP_IMAGE'] -Contexte 'nostart' }
                $webLines = @(Get-CockpitWebMigrationLines $webMigration 'nostart')
            }
        } catch { $webLines = @(Get-CockpitWebMigrationLines (New-CockpitWebMigrationResult 'erreur' 'docker') 'nostart') }
        if ($webLines.Count -gt 0) { Write-Host ''; Write-CockpitLines $webLines }
        Write-Step 'Installation terminee (demarrage non demande)'
        if ($finalScheme -ceq 'http') { Write-Info 'Demarrer : .\cockpit.ps1 start, puis .\cockpit.ps1 open (verification : preuve du jeton)' }
        else { Write-Info 'Demarrer : .\cockpit.ps1 start, puis .\cockpit.ps1 open (verification HTTPS : empreinte et preuve du jeton)' }
        return
    }

    # --- 4. Demarrage ----------------------------------------------------------------------
    # Les volumes partages doivent appartenir a l'utilisateur non-root des conteneurs (uid 1000),
    # quel que soit le conteneur qui les a initialises en premier (sinon opencode redemarre en boucle).
    Write-Step 'Preparation des volumes'
    $Project = Get-CockpitComposeProjectName $Root
    Invoke-Docker compose up --no-start --remove-orphans
    $volumeArgs = @()
    foreach ($volume in @('oc-config', 'oc-data', 'oc-cache', 'cockpit-data', 'control')) {
        $volumeArgs += @('-v', ('{0}_{1}:/volumes/{1}' -f $Project, $volume))
    }
    # --pull never : une image absente est une erreur, jamais un telechargement (en Build, le nom local se resoudrait sur docker.io).
    Invoke-Docker run --rm --pull never --network none --user 0 --entrypoint chown @volumeArgs $config['COCKPIT_OPENCODE_IMAGE'] -R 1000:1000 /volumes
    # Volume du certificat local : prepare dans les deux modes (le mode HTTP n'y ecrit rien, mais le retour en
    # HTTPS doit trouver un dossier utilisable). Image du cockpit, jamais -R : la cle garde ses droits 0600.
    $tlsMount = @('-v', ('{0}_cockpit-tls:/tls' -f $Project))
    Invoke-Docker run --rm --pull never --network none --user 0 --entrypoint chown @tlsMount $config['COCKPIT_APP_IMAGE'] 1000:1000 /tls
    Invoke-Docker run --rm --pull never --network none --user 0 --entrypoint chmod @tlsMount $config['COCKPIT_APP_IMAGE'] 0700 /tls
    Write-Good 'Droits des volumes verifies'
    # Migration du web 1.0.x -> 1.1.0 (A37, fiche MW 1.1 point 1) : opencode arrete et verifie arrete, puis le conteneur jetable de
    # l'image app. Jamais bloquante : si opencode tourne encore, pas de migration, une ligne [!] ; up -d suit dans tous les cas.
    $webMigration = New-CockpitWebMigrationResult 'non-migre' 'opencode-actif'
    if (Stop-OpencodeForWebMigration) { $webMigration = Invoke-CockpitWebMigration -Root $Root -Project $Project -Image $config['COCKPIT_APP_IMAGE'] -Contexte 'install' }
    $webLines = @(Get-CockpitWebMigrationLines $webMigration 'install')
    if ($webLines.Count -gt 0) { Write-Host ''; Write-CockpitLines $webLines }

    Write-Step 'Demarrage des conteneurs'
    Invoke-Docker compose up -d --remove-orphans
    Write-Info 'Attente de la disponibilite du cockpit...'
    $health = Wait-CockpitHealth -Root $Root -Port $Port -Mode $finalScheme -Token $config['COCKPIT_TOKEN'] -TimeoutSec 240
} finally {
    Pop-Location
}

# --- 5. Resultat : aucune adresse annoncee, aucun lien ouvert sans sante Ok -----------------
if ($health.Reason -cne 'Ok') {
    $baseUrl = Get-CockpitBaseUrl $finalScheme $Port
    Write-Host ''
    switch ($health.Reason) {
        'EmpreinteDifferente' {
            Write-CockpitLines @(('    [!] Le serveur sur 127.0.0.1:{0} ne presente PAS le certificat du cockpit.' -f $Port),
                ("    Attendue : {0}  Programme a l'ecoute sur ce port : {1}" -f $health.TlsState.Sha256, (Get-CockpitPortOwner $Port)),
                "    Aucune page n'a ete ouverte (aucun lien de connexion envoye).")
        }
        'PreuveInvalide' {
            Write-CockpitLines @(("    [!] Le serveur sur 127.0.0.1:{0} ne prouve pas qu'il connait le jeton de ce cockpit." -f $Port),
                ("    Programme a l'ecoute sur ce port : {0}" -f (Get-CockpitPortOwner $Port)),
                "    Aucune page n'a ete ouverte (aucun lien de connexion envoye).",
                '    Causes possibles : le cockpit est arrete et un autre programme occupe le port (.\cockpit.ps1 status),',
                '    ou .env a ete modifie sans redemarrage (.\cockpit.ps1 restart).')
        }
        'JetonHorsFormat' {
            Write-CockpitLines @("    [!] Le jeton de .env n'a pas le format genere par install.ps1 (64 caracteres hexadecimaux) :",
                "    le cockpit ne peut pas prouver qu'il le connait. Aucune page n'a ete ouverte.",
                '    Solution : .\install.ps1 (nouveau jeton, reconnexion necessaire).')
        }
        'SchemaDifferent' {
            $divergence = Get-CockpitComposeDivergence $Root
            $lines = @(('    [!] Le cockpit en marche ne sert pas le mode inscrit dans .env (.env : {0} ; cockpit : {1}).' -f $finalScheme, ($health.Detail -replace '^schema servi : ', '')),
                "    Aucune page n'a ete ouverte.", ('    Cause trouvee : {0}.' -f (Get-DivergenceCause $divergence)),
                '    Appliquer .env : .\cockpit.ps1 restart (les scripts ignorent ces variables et fichiers).')
            if ($divergence.Variables.Count -gt 0 -or $divergence.Files.Count -gt 0) {
                $lines += '    Pour vos commandes docker compose lancees a la main : supprimez cette cause, ou utilisez -f docker-compose.yml.'
            }
            Write-CockpitLines $lines
        }
        'ImageAncienne' {
            $imageVersion = $health.Version
            if (-not $imageVersion) { $imageVersion = 'anterieure a {0}' -f $MinimumImageVersion }
            $lines = @(('    [!] Mise a jour inachevee : les scripts sont en {0}, le cockpit en marche est en {1}.' -f $Version, $imageVersion),
                ('    Votre cockpit {0} fonctionne toujours sur {1} : utilisez votre favori' -f $imageVersion, (Get-CockpitBaseUrl 'http' $Port)),
                '    ou un onglet deja connecte. A defaut : .\cockpit.ps1 rollback, puis .\cockpit.ps1 open.',
                ("    .\cockpit.ps1 open n'ouvre rien ici : il ne sait pas verifier un cockpit {0}." -f $imageVersion),
                '    Terminer la mise a jour : .\install.ps1 (HTTPS) ou .\install.ps1 -Http (mode HTTP local)')
            if ($Mode -ceq 'Load') { $lines += ('    Mode Load : ajoutez -Mode Load -ImagesArchive <opencode-cockpit-images-{0}.tar.gz>' -f $Version) }
            Write-CockpitLines $lines
        }
        'AucuneVoie' {
            if ($finalScheme -ceq 'https') {
                Write-CockpitLines @(('    [!] Aucune voie de verification utilisable ({0}).' -f (Hide-Secrets $health.Detail)),
                    "    Aucune page n'a ete ouverte. Verification manuelle :",
                    ("      1. ouvrez {0} dans Edge ; sur l'avertissement, affichez le certificat ;" -f $baseUrl),
                    ('      2. comparez son empreinte SHA-256 a : {0} ;' -f $health.TlsState.Sha256),
                    "      3. si elles sont identiques, continuez, puis saisissez dans l'ecran de connexion la valeur de COCKPIT_TOKEN",
                    '         lue dans le fichier .env (ne la copiez nulle part ailleurs).')
            } else {
                Write-CockpitLines @(('    [!] Aucune voie de verification utilisable ({0}).' -f (Hide-Secrets $health.Detail)),
                    "    Aucune page n'a ete ouverte. En mode HTTP local, le jeton ne se saisit jamais dans une page.",
                    '    Diagnostic : .\cockpit.ps1 diag. Si Edge autorise le HTTPS sur ce poste : .\install.ps1 -Https')
            }
        }
        default {
            $state = $health.ContainerHealth
            if (-not $state) { $state = 'inconnu' }
            $first = '    [!] Verification du cockpit impossible ({0}) : {1}. Aucune page n a ete ouverte.' -f $health.Reason, (Hide-Secrets $health.Detail)
            if ($health.Reason -ceq 'NonDisponible') { $first = '    [!] Le cockpit ne repond pas apres 240 secondes. Aucune page n a ete ouverte.' }
            Write-CockpitLines @($first, ('    Etat Docker du conteneur cockpit : {0}' -f $state))
            if ($state -cne 'healthy') {
                $logs = Get-DockerOutput compose logs --no-color --tail 200 cockpit
                $interesting = @(($logs.Output -split "`r?`n") | Where-Object { $_ -match '(?i)TLS|HTTPS|certificat|configuration' } | Select-Object -Last 20)
                if ($interesting.Count -gt 0) {
                    Write-Info 'Dernieres lignes utiles du journal du cockpit :'
                    foreach ($line in $interesting) { Write-Info (Hide-Secrets $line) }
                }
            }
            Write-Info 'Journaux complets : .\cockpit.ps1 logs ; diagnostic : .\cockpit.ps1 diag'
        }
    }
    return
}

Write-Host ''
if ($finalScheme -ceq 'https') {
    $until = $health.TlsState.NotAfter.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
    Write-CockpitLines @(('    [OK] Cockpit disponible sur {0} (certificat epingle et preuve du jeton verifies : {1})' -f (Get-CockpitBaseUrl 'https' $Port), (Get-MethodLabel $health.Method)),
        ('    Empreinte SHA-256 du certificat : {0} (valable jusqu au {1})' -f $health.TlsState.Sha256, $until),
        "    Le navigateur va afficher `"Votre connexion n'est pas privee`" : c'est attendu (certificat local,",
        "    non approuve par Windows). Comparez l'empreinte, puis Avance > Continuer vers 127.0.0.1 (non securise).",
        '    Le lien ouvert est a usage unique (10 minutes) et ne contient pas votre jeton.',
        "    Utilisez 127.0.0.1 (localhost redemande l'avertissement). L'ancienne adresse en http:// ne repond plus.")
} else {
    Write-CockpitLines @(('    [OK] Cockpit disponible sur {0} (mode HTTP local, preuve du jeton verifiee : {1})' -f (Get-CockpitBaseUrl 'http' $Port), (Get-MethodLabel $health.Method)))
    Write-CockpitModeNotice $finalMode $policy
}
if ($health.Version -and $health.Version -cne $Version) {
    Write-Attention ('Le cockpit en marche annonce la version {0}, les scripts sont en {1}. Relancez .\install.ps1 si la mise a jour est incomplete.' -f $health.Version, $Version)
}

$previousLabel = $previousVersion
if (-not $previousLabel) { $previousLabel = 'version precedente' }
if ($isMigration -and $finalScheme -ceq 'https') {
    Write-Step ('Passage a la {0} : HTTPS local' -f $Version)
    Write-CockpitLines @(('    Nouvelle adresse : {0} (remplacez vos favoris http://).' -f (Get-CockpitBaseUrl 'https' $Port)),
        "    Nouveau jeton de connexion : l'ancien, envoye en clair par la version precedente, est revoque.",
        '    Une reconnexion est necessaire : lancez maintenant .\cockpit.ps1 open',
        "    Le navigateur affichera un avertissement de certificat : comparez l'empreinte ci-dessus.",
        ('    Retour a la version precedente ({0}) si besoin : .\cockpit.ps1 rollback' -f $previousLabel))
} elseif ($isMigration) {
    Write-Step ('Passage a la {0} en mode HTTP local' -f $Version)
    Write-CockpitLines @(('    Adresse inchangee : {0} (vos favoris restent valables).' -f (Get-CockpitBaseUrl 'http' $Port)),
        '    Nouveau jeton de connexion ; une reconnexion est necessaire : lancez maintenant .\cockpit.ps1 open',
        "    En mode HTTP, la connexion se fait uniquement par .\cockpit.ps1 open (l'ecran de connexion ne demande pas le jeton).",
        "    Un bandeau permanent rappelle le mode HTTP dans l'interface.",
        ('    Retour a la version precedente ({0}) si besoin : .\cockpit.ps1 rollback' -f $previousLabel))
} elseif ($backToHttps) {
    Write-Host ''
    Write-CockpitLines @("    [OK] Retour en HTTPS : nouveau jeton genere ; l'ancien, dont la session a circule en clair, est revoque (reconnexion necessaire).",
        ('    Empreinte SHA-256 du certificat : {0} (valable jusqu au {1})' -f $health.TlsState.Sha256, $health.TlsState.NotAfter.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)),
        "    Si c'est l'empreinte deja acceptee dans votre navigateur il y a moins de 7 jours, aucun avertissement ;",
        "    sinon le navigateur affichera `"Votre connexion n'est pas privee`" : comparez l'empreinte avant de continuer.")
} elseif ($tokenReplaced) {
    Write-Attention 'Nouveau jeton de connexion genere (l ancien n avait pas le format attendu) : une reconnexion est necessaire.'
}

# --- 6. Ouverture --------------------------------------------------------------------------
# Le lien porte un ticket a usage unique obtenu du serveur deja verifie : il n'est ni affiche, ni journalise.
$login = Get-CockpitLoginUrl -Health $health -Port $Port -Mode $finalScheme -Token $config['COCKPIT_TOKEN']
if ($null -eq $login.Url) {
    Write-Attention ('Lien de connexion non obtenu ({0}) : aucune page n a ete ouverte. Relancez .\cockpit.ps1 open' -f $login.Reason)
} else {
    $decision = Get-CockpitOpenDecision $health $finalScheme $policy
    Write-CockpitLines $decision.Lines
    if ($decision.Decision -ceq 'Open' -and -not $NoBrowser) { Start-Process $login.Url }
    elseif ($NoBrowser) { Write-Info 'Ouvrir : .\cockpit.ps1 open' }
}

Write-Step 'Et ensuite ?'
Write-Info '1. Dans l interface : Parametres > Connexion > Connecter GitHub Copilot.'
Write-Info '2. Commandes utiles : .\cockpit.ps1 open | status | logs | stop | update | backup'
if ($finalScheme -ceq 'https') { Write-Info '3. Certificat local : .\cockpit.ps1 tls (empreinte a comparer dans le navigateur).' }
else { Write-Info '3. Revenir a l acces HTTPS, si Edge le permet : .\install.ps1 -Https' }
Write-Info '4. Les conversations classees sont copiees en Markdown dans le dossier archives\.'
Write-Host ''
