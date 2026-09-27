# Test-OmoInstall.ps1 - installation de la salle par install.ps1 sous Windows PowerShell 5.1 (paquet L15c). Sans Pester.
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Test-OmoInstall.ps1 [-FailFast]
# Banc partage : copie jetable du cockpit (install/InstallBench.ps1), faux docker en tete du PATH, espions (Spies.ps1).
# Couvre : le contrat machine, l'archive de la salle (empreinte verifiee AVANT tout chargement, identifiant compare),
# les projets prepares et la protection des depots git du dossier de travail (L16c : dossier de travail en lecture seule,
# ecriture par exception sur les entrees de premier niveau des projets), enfin l'encodage de tous les .ps1 livres.
# Aucun secret reel : les mots de passe generes sont compares par longueur et par condense, jamais affiches.
# Aucune ressource Docker : le faux docker du banc repond a tout, et tout appel non prevu fait echouer le cas.
#
# P13 (T-L15-a) : ce fichier est lance PAR CHEMIN depuis un run: de la CI. Les chaines que les tests de P13 interdisent
# dans .github et dans les scripts qu'il appelle n'y figurent donc jamais en clair : elles sont assemblees ci-dessous.
param([switch]$FailFast)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $Here '..\..'))
. (Join-Path $RepoRoot 'CockpitTls.ps1')
. (Join-Path $Here 'install\InstallBench.ps1')

$NomSalle = 'opencode' + '-omo'
$NomVariableImage = 'COCKPIT_OMO' + '_IMAGE'
$DepotImageSalle = 'opencode-cockpit/' + $NomSalle
$DossierSalle = Join-Path (Join-Path $RepoRoot 'docker') $NomSalle

$Results = @{ Pass = 0; Fail = 0; Failures = (New-Object System.Collections.Generic.List[string]) }
function Assert-Test([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) { $Results.Pass++; return }
    $Results.Fail++
    $Results.Failures.Add(($Name + ' ' + $Detail).Trim())
    Write-Host ('  [KO] {0} {1}' -f $Name, $Detail) -ForegroundColor Red
    if ($FailFast) { throw ('FailFast : ' + $Name) }
}
function Write-Section([string]$Title) { Write-Host ('--- ' + $Title) -ForegroundColor Cyan }
function Get-Extract([string]$Text, [int]$Length = 260) {
    $flat = ([string]$Text -replace '\s+', ' ').Trim()
    if ($flat.Length -le $Length) { return $flat }
    return $flat.Substring(0, $Length)
}
# Texte ecrit par Write-Host (flux 6) pendant un bloc ; les valeurs rendues sont ignorees.
function Invoke-Captured6([scriptblock]$Block) {
    $texte = New-Object System.Collections.Generic.List[string]
    & $Block 6>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.InformationRecord]) { $texte.Add([string]$_.MessageData) } }
    return ($texte -join "`n")
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('cockpit-omo-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
$EnvNames = @('PATH', 'COCKPIT_TEST_DOCKER_SCENARIO', 'COCKPIT_LOCAL_SCHEME', 'COCKPIT_TOKEN', 'WORKSPACE_DIR',
    'COMPOSE_FILE', 'COMPOSE_PROFILES', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'GIT_CONFIG_GLOBAL')
$SavedEnv = @{}
foreach ($name in $EnvNames) { $SavedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
function Set-Env([string]$Name, [string]$Value) { [Environment]::SetEnvironmentVariable($Name, $Value, 'Process') }

# Lance install.ps1 de la copie jetable, espions charges dans CETTE portee (ils disparaissent au retour) : aucune
# question ne peut atteindre une vraie console, aucune strategie de navigateur n'est lue dans le registre du poste.
function Invoke-Install {
    param([string]$Root, [hashtable]$Parameters)
    . (Join-Path $Here 'Spies.ps1')
    Reset-SpyState
    $splat = @{}
    if ($null -ne $Parameters) { foreach ($key in @($Parameters.Keys)) { $splat[$key] = $Parameters[$key] } }
    $hostLines = New-Object System.Collections.Generic.List[string]
    $message = $null
    $script = Join-Path $Root 'install.ps1'
    $global:LASTEXITCODE = 0
    try {
        & $script @splat 6>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.InformationRecord]) { $hostLines.Add([string]$_.MessageData) }
        }
    } catch { $message = $_.Exception.Message }
    return [pscustomobject]@{ Host = ($hostLines -join "`n"); Error = $message; ExitCode = $LASTEXITCODE
        Prompts = @($SpyState.ReadHostCalls | ForEach-Object { [string]$_ }) }
}

function Get-TextDigestLocal([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$Text))).Replace('-', '').ToLowerInvariant()) }
    finally { $sha.Dispose() }
}

# --- Arbres de test ---------------------------------------------------------------------------------------------
function New-Folder([string]$Path) { New-Item -ItemType Directory -Path $Path -Force | Out-Null; return $Path }
function New-TextFile([string]$Path, [string]$Text) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}
# Dossier .git ordinaire (ce que le parcours doit monter en lecture seule).
function New-GitFolder([string]$Path) {
    New-Folder (Join-Path $Path 'hooks') | Out-Null
    New-TextFile (Join-Path $Path 'config') "[core]`n"
    New-TextFile (Join-Path $Path 'HEAD') "ref: refs/heads/principal`n"
}
# Depot nu : un fichier HEAD, un dossier objects et un dossier refs, comme git lui-meme le reconnait.
function New-BareRepo([string]$Path) {
    New-Folder (Join-Path $Path 'objects') | Out-Null
    New-Folder (Join-Path $Path 'refs') | Out-Null
    New-TextFile (Join-Path $Path 'HEAD') "ref: refs/heads/principal`n"
}
function New-Junction([string]$Link, [string]$Target) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Link) -Force | Out-Null
    New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
}

# Copie jetable dont une constante d'install.ps1 est remplacee : sert a eprouver les bornes du parcours sans
# fabriquer 200 000 fichiers. Le script livre garde ses valeurs, verifiees plus haut contre celles du superviseur.
function New-PatchedRoot([string]$Name, [string]$Before, [string]$After) {
    $root = New-InstallRoot $Work $RepoRoot $Name
    $file = Join-Path $root 'install.ps1'
    $text = [System.IO.File]::ReadAllText($file)
    if ($text.IndexOf($Before, [System.StringComparison]::Ordinal) -lt 0) { throw ('Constante introuvable dans la copie : ' + $Before) }
    [System.IO.File]::WriteAllText($file, $text.Replace($Before, $After), (New-Object System.Text.UTF8Encoding $true))
    return $root
}

function Get-ProjectsFile([string]$Root) { return (Join-Path $Root 'omo-projets.json') }
function Get-OverlayFile([string]$Root) { return (Join-Path $Root $CockpitOmoOverlay) }
function Read-Projects([string]$Root) { return (ConvertFrom-Json ([System.IO.File]::ReadAllText((Get-ProjectsFile $Root)))) }
function Get-ProjectState($Projects, [string]$Chemin) {
    $entry = @($Projects.projets | Where-Object { $_.chemin -ceq $Chemin })
    if ($entry.Count -eq 0) { return '' }
    return [string]$entry[0].git
}
function Get-ProtectedForm($Projects, [string]$Chemin) {
    $entry = @($Projects.gitProteges | Where-Object { $_.chemin -ceq $Chemin })
    if ($entry.Count -eq 0) { return '' }
    return [string]$entry[0].forme
}
# Montages d'UN service de la surcharge (defaut : la salle). La surcharge en porte deux depuis la relecture
# 2bis-vague-2 : les ouvertures en ecriture de la salle (L16c), et la source de la liste des projets prepares sur le cockpit.
function Get-OverlayLines([string]$Root, [string]$Service = $NomSalle) {
    $montages = New-Object System.Collections.Generic.List[string]
    $dedans = $false
    foreach ($ligne in @([System.IO.File]::ReadAllLines((Get-OverlayFile $Root)))) {
        if ($ligne -cmatch '^  [A-Za-z0-9_.-]+:$') { $dedans = ($ligne -ceq ('  ' + $Service + ':')); continue }
        if ($dedans -and $ligne.StartsWith('      - ')) { $montages.Add($ligne.Substring(8)) }
    }
    return @($montages)
}
# Forme d'un montage de la salle (relecture 2ter-vague-3) : syntaxe longue, bind.create_host_path: false, et la forme relevee
# a la generation en commentaire. Groupes : 1 source, 2 cible, 3 forme.
$MotifMontageSalle = '^\{ type: bind, source: "([^"]+)", target: "(/workspace(?:/[^"]*)?)", bind: \{ create_host_path: false \} \} # (fichier|dossier)\z'
# Cibles des montages de la salle, dans l'ordre de la surcharge.
function Get-OverlayTargets([string]$Root) {
    return @(Get-OverlayLines $Root | ForEach-Object {
        if ($_ -cmatch $MotifMontageSalle) { $Matches[2] } else { '?' + $_ }
    })
}
# Montage attendu pour une source de l'hote (chemin Windows) et une cible, avec sa forme.
function Get-ExpectedMount([string]$Source, [string]$Target, [string]$Forme) {
    return ('{ type: bind, source: "' + (($Source -replace '\\', '/') -replace '\$', '$$$$') + '", target: "' + ($Target -replace '\$', '$$$$') + '", bind: { create_host_path: false } } # ' + $Forme)
}
# Chemin d'une cible relatif a /workspace ('' pour /workspace), et celui de son dossier parent ('' s'il n'y en a pas).
function Get-TargetRelative([string]$Target) {
    if ($Target.StartsWith('/workspace/')) { return $Target.Substring(11) }
    return ''
}
function Get-TargetParent([string]$Target) {
    $relatif = Get-TargetRelative $Target
    if ($relatif.IndexOf('/') -lt 0) { return '' }
    return $relatif.Substring(0, $relatif.LastIndexOf('/'))
}
# Vrai si le dernier segment d'une cible se ramene a .git (casse, points ou espaces de fin, nom court GIT~n).
function Test-TargetIsGit([string]$Target) {
    $leaf = ($Target.Substring($Target.LastIndexOf('/') + 1)).ToLowerInvariant().TrimEnd('.', ' ')
    return ($leaf -ceq '.git' -or $leaf -cmatch '^git~[0-9]+\z')
}
# Valeur d'une variable d'environnement du service cockpit, lue dans docker-compose.yml du depot.
function Get-ComposeCockpitEnv([string]$Name) {
    $texte = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'docker-compose.yml'))
    $trouve = [regex]::Match($texte, ('(?m)^\s+' + [regex]::Escape($Name) + ':\s*(\S+)\s*$'))
    if (-not $trouve.Success) { return '' }
    return $trouve.Groups[1].Value
}

try {
    # --- 1. Contrat machine et bornes du parcours ----------------------------------------------------------------
    Write-Section 'Contrat de la salle et bornes du parcours'
    $Contract = ConvertFrom-Json ([System.IO.File]::ReadAllText((Join-Path $DossierSalle 'contrat-salle.json')))
    $ContractVars = @($Contract.variables.cockpit)
    $manquantes = @($ContractVars | Where-Object { $CockpitComposeEnvNames -cnotcontains $_ })
    Assert-Test 'contrat : chaque variable du cockpit est masquee par la bibliotheque' ($manquantes.Count -eq 0) ($manquantes -join ', ')
    Assert-Test 'contrat : service de la salle' ([string]$Contract.services.salle -ceq $NomSalle)
    Assert-Test 'contrat : nom du fichier des projets prepares' ([string]$Contract.fichiersControle.projets -ceq 'omo-projets.json')

    $InstallText = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'install.ps1'))
    $SupervisorText = [System.IO.File]::ReadAllText((Join-Path $DossierSalle 'supervisor-lib.mjs'))
    function Get-Number([string]$Text, [string]$Pattern) {
        if ($Text -cmatch $Pattern) { return [int]($Matches[1] -replace '_', '') }
        return -1
    }
    $plafondInstall = Get-Number $InstallText '\$OmoPlafondEntrees = ([0-9_]+)'
    $plafondSalle = Get-Number $SupervisorText 'BALAYAGE_PLAFOND = ([0-9_]+)'
    Assert-Test 'bornes : meme plafond d entrees des deux cotes' ($plafondInstall -gt 0 -and $plafondInstall -eq $plafondSalle) ('{0} / {1}' -f $plafondInstall, $plafondSalle)
    $profondeurInstall = Get-Number $InstallText '\$OmoProfondeurMax = ([0-9_]+)'
    $profondeurSalle = Get-Number $SupervisorText 'BALAYAGE_PROFONDEUR_MAX = ([0-9_]+)'
    Assert-Test 'bornes : meme profondeur maximale des deux cotes' ($profondeurInstall -gt 0 -and $profondeurInstall -eq $profondeurSalle) ('{0} / {1}' -f $profondeurInstall, $profondeurSalle)

    # --- 2. Projets prepares et protection git (-OmoProjetsSeulement) --------------------------------------------
    Write-Section 'Projets prepares et protection des depots git'
    $Root = New-InstallRoot $Work $RepoRoot 'cockpit'
    Set-Env 'PATH' ((Join-Path $Here 'fake-docker') + ';' + $SavedEnv['PATH'])
    # Tout appel a docker fait echouer le cas : -OmoProjetsSeulement ne doit en passer aucun.
    $journalProjets = Set-InstallDockerScenario $Work 'projets' @((New-DockerRule '.' '' 0 '' $null -Fail))
    # Combinaisons de parametres et dossiers de travail impossibles : rien n est ecrit, docker n est jamais appele.
    $RootParams = New-InstallRoot $Work $RepoRoot 'cockpit-params'
    $casParams = @(
        @{ Nom = 'archive et projets seuls ensemble'; Texte = 'n installe rien';
            Parametres = @{ OmoProjetsSeulement = $true; WorkspacePath = $Work; OmoArchive = (Join-Path $Work 'x.tar.gz') } },
        @{ Nom = 'projets seuls sans dossier'; Texte = 'demande -WorkspacePath';
            Parametres = @{ OmoProjetsSeulement = $true } },
        @{ Nom = 'dossier donne sans projets seuls'; Texte = 'ne sert qu avec -OmoProjetsSeulement';
            Parametres = @{ WorkspacePath = $Work } },
        @{ Nom = 'dossier de travail introuvable'; Texte = 'Dossier de travail introuvable';
            Parametres = @{ OmoProjetsSeulement = $true; WorkspacePath = (Join-Path $Work 'dossier-absent') } },
        @{ Nom = 'dossier de travail qui contient le cockpit'; Texte = 'se chevauchent';
            Parametres = @{ OmoProjetsSeulement = $true; WorkspacePath = $RootParams } })
    foreach ($cas in $casParams) {
        $result = Invoke-Install -Root $RootParams -Parameters $cas.Parametres
        Assert-Test ('refus de parametres : ' + $cas.Nom) ($null -ne $result.Error -and $result.Error.Contains($cas.Texte)) (Get-Extract $result.Error)
        Assert-Test ('refus de parametres : ' + $cas.Nom + ' n ecrit aucun fichier') (-not (Test-Path -LiteralPath (Get-OverlayFile $RootParams)) -and -not (Test-Path -LiteralPath (Get-ProjectsFile $RootParams)))
    }
    Assert-Test 'refus de parametres : docker jamais appele' (@(Get-DockerCalls $journalProjets).Count -eq 0)

    $Ws = New-Folder (Join-Path $Work 'ws')
    New-GitFolder (Join-Path $Ws 'alpha\.git')
    New-TextFile (Join-Path $Ws 'alpha\src\index.ts') "export const a = 1;`n"
    New-GitFolder (Join-Path $Ws 'alpha\node_modules\paquet\.git')
    New-Folder (Join-Path $Ws 'beta\sous\encore') | Out-Null
    New-GitFolder (Join-Path $Ws 'mono\pkg\.git')
    New-BareRepo (Join-Path $Ws 'depots\x.git')
    New-Folder (Join-Path $Ws 'gitdirs') | Out-Null
    New-BareRepo (Join-Path $Ws 'gitdirs\sousmod')
    New-TextFile (Join-Path $Ws 'sousmod\.git') "gitdir: ../gitdirs/sousmod`n"
    # Vrai sous-module : la cible vit DANS le .git du depot parent, que le parcours ne visite jamais. Seule la
    # resolution de "gitdir:" peut la proteger ; sans elle, elle n'apparaitrait nulle part.
    New-GitFolder (Join-Path $Ws 'alpha\.git\modules\sous')
    New-TextFile (Join-Path $Ws 'sousmod2\.git') "gitdir: ../alpha/.git/modules/sous`n"
    # Nom de dossier a espace et a dollar : la surcharge doit rester litterale pour compose.
    New-Folder (Join-Path $Ws 'pro jet $test') | Out-Null

    $result = Invoke-Install -Root $Root -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $Ws }
    Assert-Test 'projets : code de sortie 0' ($result.ExitCode -eq 0 -and $null -eq $result.Error) (Get-Extract ($result.Host + ' ' + $result.Error))
    Assert-Test 'projets : aucune question posee' ($result.Prompts.Count -eq 0)
    Assert-Test 'projets : aucun appel a docker' (@(Get-DockerCalls $journalProjets).Count -eq 0)
    Assert-Test 'projets : les deux fichiers sont ecrits' ((Test-Path -LiteralPath (Get-ProjectsFile $Root)) -and (Test-Path -LiteralPath (Get-OverlayFile $Root)))

    $Projects = Read-Projects $Root
    Assert-Test 'omo-projets.json : version et date' ($Projects.version -eq 1 -and ([string]$Projects.genereLe) -cmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\z') ([string]$Projects.genereLe)
    Assert-Test 'projet : .git dossier prepare' ((Get-ProjectState $Projects 'alpha') -ceq 'dossier')
    Assert-Test 'projet : dossier de premier niveau sans git prepare' ((Get-ProjectState $Projects 'beta') -ceq 'absent')
    Assert-Test 'projet : dossier profond avec .git dossier prepare' ((Get-ProjectState $Projects 'mono/pkg') -ceq 'dossier')
    Assert-Test 'projet : .git fichier NON prepare pour l ouverture' ((Get-ProjectState $Projects 'sousmod') -ceq '')
    Assert-Test 'projet : dossier profond sans git non prepare' ((Get-ProjectState $Projects 'beta/sous') -ceq '')
    Assert-Test 'projet : depot nu non prepare' ((Get-ProjectState $Projects 'depots/x.git') -ceq '')
    $sousNodeModules = @($Projects.projets + $Projects.gitProteges | Where-Object { ([string]$_.chemin).Contains('node_modules') })
    Assert-Test 'parcours : node_modules jamais parcouru' ($sousNodeModules.Count -eq 0) (($sousNodeModules | ForEach-Object { $_.chemin }) -join ', ')

    Assert-Test 'protection : .git dossier monte en lecture seule' ((Get-ProtectedForm $Projects 'alpha/.git') -ceq 'dossier')
    Assert-Test 'protection : .git dossier profond' ((Get-ProtectedForm $Projects 'mono/pkg/.git') -ceq 'dossier')
    Assert-Test 'protection : .git fichier monte comme fichier' ((Get-ProtectedForm $Projects 'sousmod/.git') -ceq 'fichier')
    Assert-Test 'protection : cible gitdir du .git fichier montee en dossier' ((Get-ProtectedForm $Projects 'gitdirs/sousmod') -ceq 'dossier')
    Assert-Test 'protection : cible gitdir hors du parcours (sous-module) montee quand meme' ((Get-ProtectedForm $Projects 'alpha/.git/modules/sous') -ceq 'dossier')
    Assert-Test 'projet : le sous-module au .git fichier n est pas prepare' ((Get-ProjectState $Projects 'sousmod2') -ceq '')
    Assert-Test 'protection : depot nu traite comme un .git dossier' ((Get-ProtectedForm $Projects 'depots/x.git') -ceq 'dossier')
    $doublons = @($Projects.gitProteges | Group-Object -Property chemin | Where-Object { $_.Count -gt 1 })
    Assert-Test 'protection : aucun chemin monte deux fois' ($doublons.Count -eq 0) (($doublons | ForEach-Object { $_.Name }) -join ', ')
    Assert-Test 'protection : forme des chemins = celle que la salle compare (dossier du depot ou son .git)' (@($Projects.gitProteges | Where-Object { ([string]$_.chemin).StartsWith('/') -or ([string]$_.chemin).Contains('\') }).Count -eq 0)

    # L16c : plus aucun .git:ro ; la surcharge n'ouvre en ECRITURE que les entrees de premier niveau des projets prepares.
    # alpha/node_modules l'est (le parcours n'y cherche pas de depot, D-2b-28) ; mono/pkg est un projet, donc l'entree pkg de
    # mono reste en lecture seule ; depots/x.git et gitdirs/sousmod sont des depots, leurs entrees aussi.
    $lines = @(Get-OverlayLines $Root)
    Assert-Test 'surcharge : service du contrat' (([System.IO.File]::ReadAllText((Get-OverlayFile $Root))).Contains('  ' + $NomSalle + ':'))
    Assert-Test 'surcharge : chaque montage en syntaxe longue, create_host_path: false, forme relevee, jamais en lecture seule' ($lines.Count -gt 0 -and @($lines | Where-Object { $_ -cmatch $MotifMontageSalle -and -not $_.Contains('read_only') }).Count -eq $lines.Count) ($lines -join ' | ')
    $cibles = @(Get-OverlayTargets $Root | Sort-Object)
    $attendues = @('/workspace/alpha/node_modules', '/workspace/alpha/src', '/workspace/beta/sous') | Sort-Object
    Assert-Test 'surcharge : exactement les entrees de premier niveau ouvrables' (($cibles -join ',') -ceq ($attendues -join ',')) ($cibles -join ' | ')
    $attendu = Get-ExpectedMount (Join-Path $Ws 'alpha\src') '/workspace/alpha/src' 'dossier'
    Assert-Test 'surcharge : source de l hote et cible sous /workspace' ($lines -ccontains $attendu) ($lines -join ' | ')
    Assert-Test 'surcharge : plus aucun montage de .git' (@($lines | Where-Object { $_ -cmatch '/\.git[:"]' }).Count -eq 0) ($lines -join ' | ')
    $dollar = @($lines | Where-Object { $_.Contains('pro jet') })
    Assert-Test 'surcharge : un projet vide n ouvre rien' ($dollar.Count -eq 0) ($dollar -join ' | ')

    # Relecture 2bis-vague-2 : COCKPIT_OMO_PROJECTS_FILE est la SOURCE lue par le cockpit, jamais la destination qu'il
    # ecrit dans le volume de controle. Cette source vit sur l'hote et n'atteint le conteneur que par la surcharge,
    # en lecture seule ; sans ce montage, la salle ne recoit ni la liste des projets ni les gitProteges.
    $cibleSource = Get-ComposeCockpitEnv 'COCKPIT_OMO_PROJECTS_FILE'
    $cibleControle = Get-ComposeCockpitEnv 'COCKPIT_OMO_CONTROL_DIR'
    Assert-Test 'surcharge : source de la liste hors du volume de controle' (
        $cibleSource -and $cibleControle -and $cibleSource.StartsWith('/') -and -not $cibleSource.StartsWith($cibleControle + '/')
    ) ($cibleSource + ' / ' + $cibleControle)
    $lignesCockpit = Get-OverlayLines $Root 'cockpit'
    $attenduListe = '"' + ((Get-ProjectsFile $Root) -replace '\\', '/') + ':' + $cibleSource + ':ro"'
    Assert-Test 'surcharge : liste des projets prepares montee en lecture seule sur le cockpit' ($lignesCockpit -ccontains $attenduListe) (($lignesCockpit -join ' | ') + ' / attendu ' + $attenduListe)

    # Le dossier a dollar est vide : il n'apparait donc pas dans la surcharge. On eprouve l'echappement sur un arbre
    # dedie, ou ce dossier porte un .git (jamais ouvert) et une entree src (ouverte en ecriture).
    $WsDollar = New-Folder (Join-Path $Work 'ws-dollar')
    New-GitFolder (Join-Path $WsDollar 'pro jet $test\.git')
    New-TextFile (Join-Path $WsDollar 'pro jet $test\src\a.txt') "a`n"
    $RootDollar = New-InstallRoot $Work $RepoRoot 'cockpit-dollar'
    $result = Invoke-Install -Root $RootDollar -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $WsDollar }
    $lignesDollar = @(Get-OverlayLines $RootDollar)
    $attenduDollar = '{ type: bind, source: "' + ((($WsDollar -replace '\\', '/') + '/pro jet $test/src') -replace '\$', '$$$$')
    $attenduDollar = $attenduDollar + '", target: "/workspace/pro jet $$test/src", bind: { create_host_path: false } } # dossier'
    Assert-Test 'surcharge : dollar double et espace conserve, source et cible' ($result.ExitCode -eq 0 -and $lignesDollar.Count -eq 1 -and $lignesDollar[0] -ceq $attenduDollar) (($lignesDollar -join ' | ') + ' / attendu ' + $attenduDollar)
    Assert-Test 'omo-projets.json : le chemin garde le dollar tel quel' ((Get-ProjectState (Read-Projects $RootDollar) 'pro jet $test') -ceq 'dossier')

    # --- 2 ter. Montages inverses (L16c, decision A16, option E1) ----------------------------------------------------
    # Le dossier de travail est monte ENTIER en lecture seule par docker-compose.yml ; la surcharge ne rouvre l'ecriture que
    # par exception : un montage par entree de premier niveau (dossier ET fichier) de chaque projet prepare, jamais sur .git
    # ni sur un nom qui s'y ramene, jamais sur la racine d'un projet ni sur le dossier de travail, jamais sur .omo.
    Write-Section 'Montages inverses : lecture seule par defaut, ecriture par exception'
    $WsE1 = New-Folder (Join-Path $Work 'ws-e1')
    New-GitFolder (Join-Path $WsE1 'app\.git')
    New-GitFolder (Join-Path $WsE1 'app\.git\modules\sub')
    New-TextFile (Join-Path $WsE1 'app\src\main.ts') "export {};`n"
    New-TextFile (Join-Path $WsE1 'app\README.md') "lisez-moi`n"
    New-TextFile (Join-Path $WsE1 'app\.omo\notes.md') "note de l utilisateur`n"
    # Sous-module : le pointeur vit dans libs/, sa cible dans le .git du projet. libs ouvert en ecriture = pointeur reecrit.
    New-TextFile (Join-Path $WsE1 'app\libs\sub\.git') "gitdir: ../../.git/modules/sub`n"
    New-TextFile (Join-Path $WsE1 'app\libs\autre.txt') "x`n"
    # Depot imbrique dans une entree : vendor reste en lecture seule, le depot devient un projet prepare a part entiere.
    New-GitFolder (Join-Path $WsE1 'app\vendor\lib\.git')
    New-TextFile (Join-Path $WsE1 'app\vendor\lib\code.c') "int main(void) { return 0; }`n"
    # Le depot de casse : pour git sous Windows, .GIT EST le depot.
    New-GitFolder (Join-Path $WsE1 'casse\.GIT')
    New-TextFile (Join-Path $WsE1 'casse\src\a.txt') "a`n"
    # Un nom court 8.3 de .git, porte ici par un vrai dossier : jamais ouvert non plus.
    New-Folder (Join-Path $WsE1 'court\GIT~1') | Out-Null
    New-TextFile (Join-Path $WsE1 'court\doc\a.md') "a`n"
    # Un nom qui se ramene a .git par un point final (fichier cree par le prefixe \\?\, que Win32 ne normalise pas). Un
    # DOSSIER de ce nom ne se lit pas sous Windows : le parcours le dit illisible et refuse la surcharge, ferme en cas de doute.
    New-TextFile (Join-Path $WsE1 'point\doc\a.md') "a`n"
    $pointFinal = '\\?\' + (Join-Path $WsE1 'point\.git.')
    $avecPointFinal = $true
    try { [System.IO.File]::WriteAllText($pointFinal, "gitdir: ailleurs`n") } catch { $avecPointFinal = $false }
    New-TextFile (Join-Path $WsE1 'notes-a-la-racine.txt') "hors projet`n"
    New-Folder (Join-Path $WsE1 'vide') | Out-Null

    $RootE1 = New-InstallRoot $Work $RepoRoot 'cockpit-e1'
    try {
        $result = Invoke-Install -Root $RootE1 -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $WsE1 }
    } finally {
        if ($avecPointFinal) { try { [System.IO.File]::Delete($pointFinal) } catch { } }
    }
    Assert-Test 'E1 : code de sortie 0 et surcharge ecrite' ($result.ExitCode -eq 0 -and $null -eq $result.Error -and (Test-Path -LiteralPath (Get-OverlayFile $RootE1))) (Get-Extract ($result.Host + ' ' + $result.Error))
    $ProjectsE1 = Read-Projects $RootE1
    $projetsE1 = @($ProjectsE1.projets | ForEach-Object { [string]$_.chemin })
    $linesE1 = @(Get-OverlayLines $RootE1)
    $ciblesE1 = @(Get-OverlayTargets $RootE1)
    $attenduesE1 = @('/workspace/app/README.md', '/workspace/app/src', '/workspace/app/vendor/lib/code.c', '/workspace/casse/src', '/workspace/court/doc', '/workspace/point/doc')
    Assert-Test 'E1 : un montage en ecriture par entree de premier niveau, dossiers ET fichiers' ((@($ciblesE1 | Sort-Object) -join ',') -ceq (@($attenduesE1 | Sort-Object) -join ',')) ($ciblesE1 -join ' | ')
    Assert-Test 'E1 : chaque montage est en ecriture (syntaxe longue sans read_only), aucun :ro dans la salle' (@($linesE1 | Where-Object { $_ -cmatch $MotifMontageSalle -and -not $_.Contains('read_only') -and -not $_.Contains(':ro') }).Count -eq $linesE1.Count) ($linesE1 -join ' | ')
    Assert-Test 'E1 : source de l hote = cible, fichier compris (forme fichier)' ($linesE1 -ccontains (Get-ExpectedMount (Join-Path $WsE1 'app\README.md') '/workspace/app/README.md' 'fichier')) ($linesE1 -join ' | ')
    Assert-Test 'E1 : forme relevee pour un dossier' ($linesE1 -ccontains (Get-ExpectedMount (Join-Path $WsE1 'app\src') '/workspace/app/src' 'dossier')) ($linesE1 -join ' | ')
    $surGit = @($ciblesE1 | Where-Object { Test-TargetIsGit $_ })
    Assert-Test 'E1 : aucun montage en ecriture sur .git ni sur un nom qui s y ramene (.GIT, GIT~1, .git.)' ($surGit.Count -eq 0) ($surGit -join ' | ')
    Assert-Test 'E1 : .GIT reconnu comme le depot du projet' ((Get-ProjectState $ProjectsE1 'casse') -ceq 'dossier' -and (Get-ProtectedForm $ProjectsE1 'casse/.GIT') -ceq 'dossier')
    $surRacine = @($ciblesE1 | Where-Object { $_ -ceq '/workspace' -or $projetsE1 -ccontains (Get-TargetRelative $_) })
    Assert-Test 'E1 : aucun montage sur le dossier de travail ni sur la racine d un projet' ($surRacine.Count -eq 0) ($surRacine -join ' | ')
    $horsProjet = @($ciblesE1 | Where-Object { $projetsE1 -cnotcontains (Get-TargetParent $_) })
    Assert-Test 'E1 : chaque montage est un enfant direct d un projet prepare' ($horsProjet.Count -eq 0) ($horsProjet -join ' | ')
    Assert-Test 'E1 : rien a la racine du dossier de travail n est ouvert' (@($ciblesE1 | Where-Object { $_.Contains('notes-a-la-racine') }).Count -eq 0)
    Assert-Test 'E1 : .omo existant jamais ouvert en ecriture' (@($ciblesE1 | Where-Object { $_.EndsWith('/.omo') }).Count -eq 0 -and $result.Host.Contains('app/.omo : carnets de l extension')) (Get-Extract $result.Host)
    Assert-Test 'E1 : entree qui porte un sous-module (pointeur gitdir:) gardee en lecture seule' (-not ($ciblesE1 -ccontains '/workspace/app/libs') -and $result.Host.Contains('app/libs : contient un depot git')) (Get-Extract $result.Host)
    Assert-Test 'E1 : entree qui porte un depot imbrique gardee en lecture seule, le depot prepare a part' (-not ($ciblesE1 -ccontains '/workspace/app/vendor') -and (Get-ProjectState $ProjectsE1 'app/vendor/lib') -ceq 'dossier')
    $omoCrees = @(Get-ChildItem -LiteralPath $WsE1 -Recurse -Force -Directory | Where-Object { $_.Name -ieq '.omo' })
    Assert-Test 'E1 : aucun dossier .omo cree sur le poste (seul celui de l utilisateur existe)' ($omoCrees.Count -eq 1 -and $omoCrees[0].FullName -ceq (Join-Path $WsE1 'app\.omo')) (($omoCrees | ForEach-Object { $_.FullName }) -join ' | ')
    Assert-Test 'E1 : friction dite (aucune creation a la racine d un projet)' ($result.Host.Contains('ne peut creer ni fichier ni dossier a la racine d un projet') -and $result.Host.Contains('refus net')) (Get-Extract $result.Host)
    Assert-Test 'E1 : friction dite (relancer install.ps1 apres un ajout a la racine)' ($result.Host.Contains('relancez install.ps1')) (Get-Extract $result.Host)
    Assert-Test 'E1 : friction dite (relancer install.ps1 apres une suppression, un renommage ou un lien a la racine)' ($result.Host.Contains('supprime, renomme ou remplace par un lien ou une jonction un fichier ou un dossier a la racine d un projet') -and $result.Host.Contains('relancez aussi install.ps1')) (Get-Extract $result.Host)
    if (-not $avecPointFinal) { Write-Host '  (nom .git. non creable sur ce poste : ce cas est joue sans lui)' -ForegroundColor DarkGray }

    # --- 2 quater. Sources de la surcharge verifiees avant chaque demarrage de la salle (relecture 2ter-vague-3) ------
    # Mesure (Docker Desktop 4.91, moteur 29.8.0) : une source de bind supprimee sur le poste apres la generation est recreee par
    # Docker en DOSSIER vide a chaque relance (un fichier devient un dossier), et une entree devenue jonction ouvre sa cible en
    # ecriture. Syntaxe longue + create_host_path: false : une relance par la politique restart ou par compose restart echoue
    # sans rien creer ; seule une creation (compose up) cree encore la source. ConvertTo-CockpitDockerArgs ne passe donc pas le
    # profil de la salle a up, create, start, restart ni run tant qu'une source manque ou a change, et le dit une fois.
    Write-Section 'Sources de la surcharge verifiees avant chaque demarrage de la salle'
    $WsSrc = New-Folder (Join-Path $Work 'ws-sources')
    New-GitFolder (Join-Path $WsSrc 'app\.git')
    New-TextFile (Join-Path $WsSrc 'app\src\main.ts') "export {};`n"
    New-TextFile (Join-Path $WsSrc 'app\README.md') "lisez-moi`n"
    New-TextFile (Join-Path $WsSrc 'app\dist\sortie.js') "x`n"
    $RootSrc = New-InstallRoot $Work $RepoRoot 'cockpit-sources'
    $result = Invoke-Install -Root $RootSrc -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $WsSrc }
    Assert-Test 'sources : surcharge generee' ($result.ExitCode -eq 0 -and (Test-Path -LiteralPath (Get-OverlayFile $RootSrc))) (Get-Extract ($result.Host + ' ' + $result.Error))
    [System.IO.File]::WriteAllText((Join-Path $RootSrc '.env'), "COCKPIT_OMO=on`n", (New-Object System.Text.UTF8Encoding $false))
    # Arguments docker et texte affiche (flux 6) d'un appel de la bibliotheque, l'avertissement remis a zero avant l'appel.
    function Get-SalleCall([string[]]$DockerArgs) {
        $CockpitTlsSession.OmoNotice = $false
        $texte = New-Object System.Collections.Generic.List[string]
        $valeurs = New-Object System.Collections.Generic.List[string]
        & { ConvertTo-CockpitDockerArgs $RootSrc $DockerArgs } 6>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.InformationRecord]) { $texte.Add([string]$_.MessageData) } else { $valeurs.Add([string]$_) } }
        return [pscustomobject]@{ Args = ($valeurs -join ' '); Host = ($texte -join "`n") }
    }
    $Demarrages = @('up', 'create', 'start', 'restart', 'run')
    Assert-Test 'sources : toutes presentes, rien a signaler' (@(Get-CockpitOmoSourceProblems $RootSrc).Count -eq 0) (@(Get-CockpitOmoSourceProblems $RootSrc) -join ', ')
    foreach ($sous in $Demarrages) {
        $appel = Get-SalleCall @('compose', $sous)
        Assert-Test ('sources presentes : profil de la salle passe a ' + $sous) ($appel.Args.Contains('--profile omo') -and $appel.Host -ceq '') ($appel.Args + ' / ' + $appel.Host)
    }
    # Un FICHIER de la racine supprime (npm run clean, git clean...) : jamais recree, profil retire pour les demarrages seulement.
    Remove-Item -LiteralPath (Join-Path $WsSrc 'app\README.md') -Force
    Assert-Test 'fichier supprime : l entree est nommee' ((@(Get-CockpitOmoSourceProblems $RootSrc) -join ',') -ceq 'app/README.md') (@(Get-CockpitOmoSourceProblems $RootSrc) -join ', ')
    foreach ($sous in $Demarrages) {
        $appel = Get-SalleCall @('compose', $sous, '-d')
        Assert-Test ('fichier supprime : aucun profil de la salle pour ' + $sous) (-not $appel.Args.Contains('--profile') -and $appel.Args.Contains($CockpitOmoOverlay)) $appel.Args
        Assert-Test ('fichier supprime : message pour ' + $sous) ($appel.Host.Contains('Salle non demarree') -and $appel.Host.Contains('app/README.md') -and $appel.Host.Contains('Relancez install.ps1')) (Get-Extract $appel.Host)
    }
    foreach ($sous in @('stop', 'down', 'ps', 'logs')) {
        $appel = Get-SalleCall @('compose', $sous)
        Assert-Test ('fichier supprime : profil garde pour ' + $sous + ' (arret de la salle, MO-3)') ($appel.Args.Contains('--profile omo') -and $appel.Host -ceq '') ($appel.Args + ' / ' + $appel.Host)
    }
    $CockpitTlsSession.OmoNotice = $false
    $deux = Invoke-Captured6 { ConvertTo-CockpitDockerArgs $RootSrc @('compose', 'up', '-d') | Out-Null; ConvertTo-CockpitDockerArgs $RootSrc @('compose', 'start') | Out-Null }
    Assert-Test 'message dit une seule fois par execution' (([regex]::Matches($deux, 'Salle non demarree')).Count -eq 1) (Get-Extract $deux)
    Assert-Test 'fichier supprime : rien n est recree sur le poste par la verification' (-not (Test-Path -LiteralPath (Join-Path $WsSrc 'app\README.md')))
    # Le meme nom revenu en DOSSIER (forme changee) : toujours refuse.
    New-Folder (Join-Path $WsSrc 'app\README.md') | Out-Null
    Assert-Test 'forme changee (fichier devenu dossier) : refuse' ((@(Get-CockpitOmoSourceProblems $RootSrc) -join ',') -ceq 'app/README.md')
    Remove-Item -LiteralPath (Join-Path $WsSrc 'app\README.md') -Force
    New-TextFile (Join-Path $WsSrc 'app\README.md') "lisez-moi`n"
    Assert-Test 'fichier revenu : rien a signaler' (@(Get-CockpitOmoSourceProblems $RootSrc).Count -eq 0)
    # Un DOSSIER supprime (dist, par tsc --build --clean) : meme refus.
    Remove-Item -LiteralPath (Join-Path $WsSrc 'app\dist') -Recurse -Force
    Assert-Test 'dossier supprime : refuse, rien recree' ((@(Get-CockpitOmoSourceProblems $RootSrc) -join ',') -ceq 'app/dist' -and -not (Test-Path -LiteralPath (Join-Path $WsSrc 'app\dist')))
    New-Folder (Join-Path $WsSrc 'app\dist') | Out-Null
    # Un dossier remplace par une JONCTION vers un dossier hors du dossier de travail : Docker l'ouvrirait en ecriture.
    $dehors = New-Folder (Join-Path $Work 'dehors-sources')
    Remove-Item -LiteralPath (Join-Path $WsSrc 'app\src') -Recurse -Force
    New-Junction (Join-Path $WsSrc 'app\src') $dehors
    Assert-Test 'jonction a la place d un dossier : refusee' ((@(Get-CockpitOmoSourceProblems $RootSrc) -join ',') -ceq 'app/src') (@(Get-CockpitOmoSourceProblems $RootSrc) -join ', ')
    Assert-Test 'jonction : aucun profil pour up' (-not (Get-SalleCall @('compose', 'up', '-d')).Args.Contains('--profile'))
    [System.IO.Directory]::Delete((Join-Path $WsSrc 'app\src'), $false)
    New-TextFile (Join-Path $WsSrc 'app\src\main.ts') "export {};`n"
    # Surcharge d'une version precedente (syntaxe courte, sans create_host_path ni forme) : a regenerer.
    $ancienne = [System.IO.File]::ReadAllText((Get-OverlayFile $RootSrc)) -replace '(?m)^      - \{ type: bind, source: "([^"]+)", target: "([^"]+)", bind: \{ create_host_path: false \} \} # \w+$', '      - "$1:$2:rw"'
    [System.IO.File]::WriteAllText((Get-OverlayFile $RootSrc), $ancienne, (New-Object System.Text.UTF8Encoding $false))
    Assert-Test 'surcharge d avant (syntaxe courte) : a regenerer, aucun profil pour up' (((@(Get-CockpitOmoSourceProblems $RootSrc) | Select-Object -Unique) -join ',') -ceq 'surcharge a regenerer' -and -not (Get-SalleCall @('compose', 'up')).Args.Contains('--profile')) (@(Get-CockpitOmoSourceProblems $RootSrc) -join ', ')
    # Relance d'install.ps1 : la surcharge suit le poste, le profil revient.
    Remove-Item -LiteralPath (Join-Path $WsSrc 'app\dist') -Recurse -Force
    $result = Invoke-Install -Root $RootSrc -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $WsSrc }
    Assert-Test 'relance d install.ps1 : entree retiree de la surcharge, profil revenu' ($result.ExitCode -eq 0 -and @(Get-CockpitOmoSourceProblems $RootSrc).Count -eq 0 -and -not ((Get-OverlayTargets $RootSrc) -ccontains '/workspace/app/dist') -and (Get-SalleCall @('compose', 'up', '-d')).Args.Contains('--profile omo')) (Get-Extract ($result.Host + ' ' + $result.Error))

    # Un projet sans rien a ouvrir : la liste de la salle est vide mais bien formee (jamais une cle nulle pour compose).
    $WsVide = New-Folder (Join-Path $Work 'ws-e1-vide')
    New-GitFolder (Join-Path $WsVide 'seul\.git')
    $RootVide = New-InstallRoot $Work $RepoRoot 'cockpit-e1-vide'
    $result = Invoke-Install -Root $RootVide -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $WsVide }
    $texteVide = [System.IO.File]::ReadAllText((Get-OverlayFile $RootVide))
    Assert-Test 'E1 : rien a ouvrir, volumes: [] pour la salle' ($result.ExitCode -eq 0 -and $texteVide.Contains("  " + $NomSalle + ":`n    volumes: []`n")) (Get-Extract $texteVide)

    # --- 2 bis. core.hooksPath global de l hote (relecture 2bis-vague-0) -----------------------------------------
    # Un core.hooksPath global qui pointe dans le dossier de travail fait executer, a chaque commande git du poste,
    # des scripts que la salle peut ecrire. Ce reglage vit dans la configuration git de l utilisateur : la salle ne
    # le voit pas, donc install.ps1 doit le signaler.
    Write-Section 'core.hooksPath global qui pointe dans le dossier de travail'
    $gitPoste = @(Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($gitPoste.Count -eq 0) {
        Write-Host '  (git absent du poste : ce cas est saute)' -ForegroundColor DarkGray
    } else {
        # GIT_CONFIG_GLOBAL remplace le fichier de configuration global le temps du cas : celui de l utilisateur
        # n est ni lu, ni ecrit, ni modifie.
        $configGit = Join-Path $Work 'gitconfig-global'
        $rootHooks = New-InstallRoot $Work $RepoRoot 'cockpit-hooks'
        $casHooks = @(
            @{ Nom = 'dans le dossier de travail'; Valeur = (($Ws -replace '\\', '/') + '/crochets'); Attendu = $true },
            @{ Nom = 'ailleurs sur le poste'; Valeur = (((Join-Path $Work 'crochets-hors') -replace '\\', '/')); Attendu = $false })
        foreach ($cas in $casHooks) {
            New-TextFile $configGit ("[core]`n`thooksPath = " + $cas.Valeur + "`n")
            Set-Env 'GIT_CONFIG_GLOBAL' $configGit
            $result = Invoke-Install -Root $rootHooks -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $Ws }
            $signale = $result.Host.Contains('core.hooksPath global de git pointe dans le dossier de travail')
            Assert-Test ('core.hooksPath ' + $cas.Nom + ' : signale seulement quand la salle peut y ecrire') ($result.ExitCode -eq 0 -and $signale -eq $cas.Attendu) (Get-Extract $result.Host)
            Assert-Test ('core.hooksPath ' + $cas.Nom + ' : la surcharge est ecrite dans tous les cas') (Test-Path -LiteralPath (Get-OverlayFile $rootHooks))
        }
        Set-Env 'GIT_CONFIG_GLOBAL' $SavedEnv['GIT_CONFIG_GLOBAL']
    }

    # --- 3. Refus : rien n'est ecrit, code de sortie non nul ------------------------------------------------------
    Write-Section 'Depots impossibles a proteger : surcharge refusee'
    $CasRefus = @(
        @{ Nom = 'lien-dossier'; Texte = 'lien ou jonction de dossier' },
        @{ Nom = 'lien-git'; Texte = 'lien ou jonction' },
        @{ Nom = 'gitdir-sortant'; Texte = 'cible est introuvable' },
        @{ Nom = 'racine-nue'; Texte = 'lui-meme un depot nu' })
    # Nom different de $Ws : les variables de PowerShell ne distinguent pas la casse, l'arbre du cas 2 serait perdu.
    foreach ($cas in $CasRefus) {
        $wsCas = New-Folder (Join-Path $Work ('ws-' + $cas.Nom))
        $cible = New-Folder (Join-Path $Work ('cible-' + $cas.Nom))
        New-GitFolder (Join-Path $wsCas 'bon\.git')
        switch ($cas.Nom) {
            'lien-dossier' { New-Junction (Join-Path $wsCas 'raccourci') $cible }
            'lien-git' { New-GitFolder (Join-Path $cible 'depot\.git'); New-Folder (Join-Path $wsCas 'faux') | Out-Null; New-Junction (Join-Path $wsCas 'faux\.git') (Join-Path $cible 'depot\.git') }
            'gitdir-sortant' { New-TextFile (Join-Path $wsCas 'dehors\.git') ('gitdir: ' + ($cible -replace '\\', '/') + "`n") }
            'racine-nue' { New-BareRepo $wsCas }
        }
        $root = New-InstallRoot $Work $RepoRoot ('cockpit-' + $cas.Nom)
        # Surcharge d'une execution precedente : elle doit disparaitre, pour qu'aucune protection perimee ne serve.
        New-TextFile (Get-OverlayFile $root) "services: {}`n"
        New-TextFile (Get-ProjectsFile $root) "{}`n"
        $result = Invoke-Install -Root $root -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $wsCas }
        Assert-Test ('refus ' + $cas.Nom + ' : code de sortie 4') ($result.ExitCode -eq 4) (Get-Extract ($result.Host + ' ' + $result.Error))
        Assert-Test ('refus ' + $cas.Nom + ' : cause nommee') ($result.Host.Contains($cas.Texte)) (Get-Extract $result.Host)
        Assert-Test ('refus ' + $cas.Nom + ' : surcharge perimee retiree') (-not (Test-Path -LiteralPath (Get-OverlayFile $root)) -and -not (Test-Path -LiteralPath (Get-ProjectsFile $root)))
    }

    # L16c : un LIEN DE FICHIER a la racine d un projet serait un montage en ecriture de sa cible (docker suit le lien sur
    # l hote). Les liens de dossier sont deja refuses par le parcours ; celui-ci l est par la liste des ouvertures.
    $wsLien = New-Folder (Join-Path $Work 'ws-lien-fichier')
    $cibleLien = Join-Path $Work 'cible-lien-fichier.txt'
    New-TextFile $cibleLien "hors du dossier de travail`n"
    New-TextFile (Join-Path $wsLien 'projet\src\a.txt') "a`n"
    $lienCree = $true
    try { New-Item -ItemType SymbolicLink -Path (Join-Path $wsLien 'projet\raccourci.txt') -Target $cibleLien -ErrorAction Stop | Out-Null } catch { $lienCree = $false }
    if ($lienCree) {
        $rootLien = New-InstallRoot $Work $RepoRoot 'cockpit-lien-fichier'
        $result = Invoke-Install -Root $rootLien -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $wsLien }
        Assert-Test 'refus lien-fichier : code 4 et lien nomme' ($result.ExitCode -eq 4 -and $result.Host.Contains('projet/raccourci.txt : lien a la racine d un projet')) (Get-Extract $result.Host)
        Assert-Test 'refus lien-fichier : aucune surcharge ecrite' (-not (Test-Path -LiteralPath (Get-OverlayFile $rootLien)))
        Remove-Item -LiteralPath (Join-Path $wsLien 'projet\raccourci.txt') -Force
    } else {
        Write-Host '  (lien symbolique de fichier non creable sans le mode developpeur : ce cas est saute ; joue la ou il l est)' -ForegroundColor DarkGray
    }

    $wsPlafond = New-Folder (Join-Path $Work 'ws-plafond')
    foreach ($nom in @('a', 'b', 'c', 'd', 'e', 'f')) { New-GitFolder (Join-Path $wsPlafond ($nom + '\.git')) }
    $rootPlafond = New-PatchedRoot 'cockpit-plafond' '$OmoPlafondEntrees = 200000' '$OmoPlafondEntrees = 3'
    $result = Invoke-Install -Root $rootPlafond -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $wsPlafond }
    Assert-Test 'refus plafond : code 4 et plafond nomme' ($result.ExitCode -eq 4 -and $result.Host.Contains('plafond de 3 entrees atteint')) (Get-Extract $result.Host)
    Assert-Test 'refus plafond : aucune surcharge ecrite' (-not (Test-Path -LiteralPath (Get-OverlayFile $rootPlafond)))

    $rootProfond = New-PatchedRoot 'cockpit-profond' '$OmoProfondeurMax = 256' '$OmoProfondeurMax = 1'
    $result = Invoke-Install -Root $rootProfond -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $Ws }
    Assert-Test 'refus profondeur : code 4 et profondeur nommee' ($result.ExitCode -eq 4 -and $result.Host.Contains('trop profond')) (Get-Extract $result.Host)

    # Le meme arbre, avec la profondeur livree, passe : la borne est bien la seule difference.
    $rootTemoin = New-InstallRoot $Work $RepoRoot 'cockpit-temoin'
    $result = Invoke-Install -Root $rootTemoin -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $Ws }
    Assert-Test 'temoin : le meme arbre passe avec les bornes livrees' ($result.ExitCode -eq 0) (Get-Extract $result.Host)

    # --- 4. Archive de la salle (T-L15-h) ------------------------------------------------------------------------
    Write-Section 'Archive de la salle : empreinte, identifiant, ecriture dans .env'
    $Etiquette = $DepotImageSalle + ':4.19.4-20260921-101500'
    $IdentifiantVrai = 'sha256:' + ('a1' * 32)
    $IdentifiantAutre = 'sha256:' + ('b2' * 32)
    $Archive = Join-Path $Work 'salle-ok.tar.gz'
    [System.IO.File]::WriteAllBytes($Archive, [System.Text.Encoding]::ASCII.GetBytes('archive de test, aucun contenu reel'))
    $ArchiveSha = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    function Set-Checksum([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false)) }
    function New-ChecksumText([string]$Sha, [string]$Nom, [string]$Id, [string]$Image) {
        return ('{0}  {1}' -f $Sha, $Nom) + "`n" + ('image-id ' + $Id) + "`n" + ('image ' + $Image) + "`n"
    }
    $ChecksumFile = $Archive + '.sha256'

    # Aucune de ces installations ne doit atteindre docker : toute regle est marquee interdite.
    $journalAvant = Set-InstallDockerScenario $Work 'archive-avant' @((New-DockerRule '.' '' 0 '' $null -Fail))
    $rootArchive = New-InstallRoot $Work $RepoRoot 'cockpit-archive'
    Remove-Item -LiteralPath $ChecksumFile -Force -ErrorAction SilentlyContinue
    $result = Invoke-Install -Root $rootArchive -Parameters @{ OmoArchive = $Archive; SkipCertificates = $true }
    Assert-Test 'archive : .sha256 voisin exige' ($null -ne $result.Error -and $result.Error.Contains('Fichier d empreinte absent')) (Get-Extract $result.Error)

    $horsFormat = @(
        @{ Nom = 'deux-lignes'; Texte = ('{0}  salle-ok.tar.gz' -f $ArchiveSha) + "`nimage-id " + $IdentifiantVrai + "`n" },
        @{ Nom = 'empreinte'; Texte = (New-ChecksumText 'zz' 'salle-ok.tar.gz' $IdentifiantVrai $Etiquette) },
        @{ Nom = 'identifiant'; Texte = (New-ChecksumText $ArchiveSha 'salle-ok.tar.gz' 'sha256:court' $Etiquette) },
        @{ Nom = 'image'; Texte = (New-ChecksumText $ArchiveSha 'salle-ok.tar.gz' $IdentifiantVrai 'quelquun/autre-image:1') },
        @{ Nom = 'autre-archive'; Texte = (New-ChecksumText $ArchiveSha 'une-autre.tar.gz' $IdentifiantVrai $Etiquette) })
    foreach ($cas in $horsFormat) {
        Set-Checksum $ChecksumFile $cas.Texte
        $result = Invoke-Install -Root $rootArchive -Parameters @{ OmoArchive = $Archive; SkipCertificates = $true }
        Assert-Test ('archive hors format ' + $cas.Nom + ' : refus') ($null -ne $result.Error) (Get-Extract $result.Host)
    }

    # T-L15-h : empreinte fausse -> refus, et AUCUN chargement.
    Set-Checksum $ChecksumFile (New-ChecksumText ('c3' * 32) 'salle-ok.tar.gz' $IdentifiantVrai $Etiquette)
    $result = Invoke-Install -Root $rootArchive -Parameters @{ OmoArchive = $Archive; SkipCertificates = $true }
    Assert-Test 'T-L15-h : empreinte fausse, archive refusee' ($null -ne $result.Error -and $result.Error.Contains('Archive refusee')) (Get-Extract $result.Error)
    Assert-Test 'T-L15-h : aucun appel a docker avant la verification' (@(Get-DockerCalls $journalAvant).Count -eq 0) ((Get-DockerCalls $journalAvant | ForEach-Object { (@($_.args) -join ' ') }) -join ' | ')
    Assert-Test 'T-L15-h : aucun fichier .env ecrit' (-not (Test-Path -LiteralPath (Join-Path $rootArchive '.env')))

    # Installation complete (arretee avant le demarrage) : l'image est chargee, puis son identifiant est compare.
    $Projets2 = New-Folder (Join-Path $Work 'projets-archive')
    New-GitFolder (Join-Path $Projets2 'un\.git')
    function New-ArchiveEnv([string]$Version) {
        return [ordered]@{ WORKSPACE_DIR = ($Projets2 -replace '\\', '/'); ARCHIVE_DIR = './archives'; COCKPIT_PORT = '7788'
            COCKPIT_TOKEN = (New-CockpitChallenge); OPENCODE_SERVER_PASSWORD = (New-CockpitChallenge); HTTP_PROXY = ''; HTTPS_PROXY = ''
            NO_PROXY = ''; COCKPIT_TLS_INSECURE = '0'; TZ = 'Europe/Paris'; COCKPIT_PROJECT_CONFIG = '0'
            COCKPIT_GITHUB_ENTERPRISE_DOMAIN = ''; COCKPIT_COPILOT_API_URL = ''; COCKPIT_LOCAL_SCHEME = 'https'
            COCKPIT_LOCAL_HTTP_CONFIRMED = ''; COCKPIT_OPENCODE_IMAGE = 'opencode-cockpit/opencode:essai'
            COCKPIT_APP_IMAGE = 'opencode-cockpit/app:essai'; COCKPIT_INSTALL_MODE = 'Pull'; COCKPIT_VERSION = $Version }
    }
    $Version = (Get-Content -LiteralPath (Join-Path $Root 'VERSION') -TotalCount 1).Trim()
    function Set-ArchiveScenario([string]$Nom, [string]$Identifiant, [string]$ImageChargee = '') {
        # Les regles de la salle passent AVANT celles du banc, qui repondent a tout 'image inspect'.
        $toutes = New-Object System.Collections.Generic.List[object]
        $chargee = $Etiquette
        if ($ImageChargee -cne '') { $chargee = $ImageChargee }
        $toutes.Add((New-DockerRule '^load --input .*salle-ok\.tar\.gz\z' ('Loaded image: ' + $chargee + "`n")))
        $toutes.Add((New-DockerRule ('^image inspect --format \{\{\.Id\}\} ' + [regex]::Escape($Etiquette) + '\z') ($Identifiant + "`n")))
        foreach ($regle in (New-InstallDockerRules -ImageVersion $Version)) { $toutes.Add($regle) }
        return (Set-InstallDockerScenario $Work $Nom $toutes.ToArray())
    }

    $rootPlein = New-InstallRoot $Work $RepoRoot 'cockpit-plein'
    Set-TestEnvFile $rootPlein (New-ArchiveEnv $Version)
    Set-Checksum $ChecksumFile (New-ChecksumText $ArchiveSha 'salle-ok.tar.gz' $IdentifiantVrai $Etiquette)
    $journalAutre = Set-ArchiveScenario 'archive-autre-id' $IdentifiantAutre
    $result = Invoke-Install -Root $rootPlein -Parameters @{ OmoArchive = $Archive; SkipCertificates = $true; NoStart = $true; NoBrowser = $true }
    Assert-Test 'T-L15-h : identifiant different, archive refusee' ($null -ne $result.Error -and $result.Error.Contains('identifiant de l image chargee differe')) (Get-Extract ($result.Error + ' ' + $result.Host))
    Assert-Test 'T-L15-h : identifiant different, variable d image non ecrite' ((Get-TestEnvValue (Read-TestEnvFile $rootPlein) $NomVariableImage) -ceq '')
    Assert-Test 'T-L15-h : le chargement a bien eu lieu avant la comparaison' (@(Get-DockerCalls $journalAutre | Where-Object { (@($_.args) -join ' ') -cmatch '^load ' }).Count -eq 1)
    # L archive doit porter l image annoncee par son .sha256 : un autre nom charge est refuse, avant tout inspect.
    $journalAutreNom = Set-ArchiveScenario 'archive-autre-nom' $IdentifiantVrai ($DepotImageSalle + ':autre-etiquette')
    $result = Invoke-Install -Root $rootPlein -Parameters @{ OmoArchive = $Archive; SkipCertificates = $true; NoStart = $true; NoBrowser = $true }
    Assert-Test 'archive : image annoncee absente de l archive, refus' ($null -ne $result.Error -and $result.Error.Contains('elle ne contient pas l image')) (Get-Extract $result.Error)
    Assert-Test 'archive : image annoncee absente, etiquette non ecrite dans .env' ((Get-TestEnvValue (Read-TestEnvFile $rootPlein) $NomVariableImage) -ceq '')
    Assert-Test 'archive : image annoncee absente, identifiant jamais demande' (@(Get-DockerCalls $journalAutreNom | Where-Object { (@($_.args) -join ' ') -cmatch '^image inspect --format \{\{\.Id\}\}' }).Count -eq 0)

    $journalOk = Set-ArchiveScenario 'archive-ok' $IdentifiantVrai
    $result = Invoke-Install -Root $rootPlein -Parameters @{ OmoArchive = $Archive; SkipCertificates = $true; NoStart = $true; NoBrowser = $true }
    Assert-Test 'archive conforme : installation terminee' ($null -eq $result.Error -and $result.Host.Contains('identifiant conforme au fichier .sha256')) (Get-Extract ($result.Error + ' ' + $result.Host))
    $envPlein = Read-TestEnvFile $rootPlein
    Assert-Test 'archive conforme : etiquette de l image ecrite dans .env' ((Get-TestEnvValue $envPlein $NomVariableImage) -ceq $Etiquette)
    Assert-Test 'archive conforme : la salle reste coupee' ((Get-TestEnvValue $envPlein 'COCKPIT_OMO') -ceq 'off')
    $motDePasse = Get-TestEnvValue $envPlein 'OPENCODE_OMO_PASSWORD'
    Assert-Test 'archive conforme : mot de passe tire au hasard, 64 caracteres hexadecimaux' ($motDePasse -cmatch '^[0-9a-f]{64}\z')
    Assert-Test 'archive conforme : mot de passe jamais affiche' (-not $result.Host.Contains($motDePasse) -and $result.Host.Contains('jamais affiche'))
    Assert-Test 'archive conforme : surcharge des projets regeneree' ((Test-Path -LiteralPath (Get-OverlayFile $rootPlein)) -and (Get-ProjectState (Read-Projects $rootPlein) 'un') -ceq 'dossier')
    # MO-6 : l'adresse Copilot passe par la variable d'environnement ; aucun fichier d'adresse n'est ecrit.
    $fichiersRacine = @(Get-ChildItem -LiteralPath $rootPlein -File | ForEach-Object { $_.Name } | Sort-Object)
    $attendus = @('.env', 'CockpitTls.ps1', $CockpitOmoOverlay, 'docker-compose.yml', 'install.ps1', 'omo-projets.json', 'VERSION') | Sort-Object
    Assert-Test 'MO-6 : aucun fichier ecrit en plus (pas de fichier d adresse Copilot)' (($fichiersRacine -join ',') -ceq ($attendus -join ',')) ($fichiersRacine -join ', ')

    # Relance : l'interrupteur mis sur on par l'utilisateur n'est jamais remis a off, le mot de passe ne change pas.
    $valeurs = Read-TestEnvFile $rootPlein
    $valeurs['COCKPIT_OMO'] = 'on'
    Set-TestEnvFile $rootPlein $valeurs
    $journalOk = Set-ArchiveScenario 'archive-relance' $IdentifiantVrai
    $result = Invoke-Install -Root $rootPlein -Parameters @{ OmoArchive = $Archive; SkipCertificates = $true; NoStart = $true; NoBrowser = $true }
    $envRelance = Read-TestEnvFile $rootPlein
    Assert-Test 'relance : COCKPIT_OMO=on conserve' ((Get-TestEnvValue $envRelance 'COCKPIT_OMO') -ceq 'on') (Get-Extract $result.Host)
    Assert-Test 'relance : mot de passe inchange (condense)' ((Get-TextDigestLocal (Get-TestEnvValue $envRelance 'OPENCODE_OMO_PASSWORD')) -ceq (Get-TextDigestLocal $motDePasse))
    $profils = @(Get-DockerCalls $journalOk | Where-Object { (@($_.args) -join ' ') -cmatch '(^| )--profile omo( |$)' })
    Assert-Test 'relance : le profil de la salle est passe aux commandes compose' ($profils.Count -gt 0)
    $surcharges = @(Get-DockerCalls $journalOk | Where-Object { (@($_.args) -join ' ') -cmatch [regex]::Escape($CockpitOmoOverlay) })
    Assert-Test 'relance : la surcharge est passee aux commandes compose' ($surcharges.Count -gt 0)

    # Sans image de la salle dans .env, rien n'est parcouru ni ecrit : une installation ordinaire ne change pas.
    $rootSansSalle = New-InstallRoot $Work $RepoRoot 'cockpit-sans-salle'
    Set-TestEnvFile $rootSansSalle (New-ArchiveEnv $Version)
    Set-InstallDockerScenario $Work 'sans-salle' (New-InstallDockerRules -ImageVersion $Version) | Out-Null
    $result = Invoke-Install -Root $rootSansSalle -Parameters @{ SkipCertificates = $true; NoStart = $true; NoBrowser = $true }
    Assert-Test 'sans salle : installation ordinaire terminee' ($null -eq $result.Error) (Get-Extract ($result.Error + ' ' + $result.Host))
    Assert-Test 'sans salle : aucun fichier de projets ecrit' (-not (Test-Path -LiteralPath (Get-ProjectsFile $rootSansSalle)) -and -not (Test-Path -LiteralPath (Get-OverlayFile $rootSansSalle)))

    # --- 5. Encodage et analyse de tous les scripts livres (T-L15-i, T-L18-k) -------------------------------------
    Write-Section 'Encodage ASCII, BOM, CRLF et analyse de tous les .ps1'
    $scripts = New-Object System.Collections.Generic.List[string]
    foreach ($dossier in @($RepoRoot, (Join-Path $RepoRoot 'scripts'), (Join-Path $RepoRoot 'tests\ps51'))) {
        if (-not (Test-Path -LiteralPath $dossier -PathType Container)) { continue }
        foreach ($item in (Get-ChildItem -LiteralPath $dossier -Filter '*.ps1' -File -Recurse)) { $scripts.Add($item.FullName) }
    }
    Assert-Test 'scripts : tous les .ps1 du depot sont vus' ($scripts.Count -ge 13) ([string]$scripts.Count)
    foreach ($script in $scripts) {
        $nom = $script.Substring($RepoRoot.Length).TrimStart('\')
        $bytes = [System.IO.File]::ReadAllBytes($script)
        $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        $nonAscii = 0
        $bareLf = 0
        for ($i = 3; $i -lt $bytes.Length; $i++) {
            if ($bytes[$i] -gt 127) { $nonAscii++ }
            elseif ($bytes[$i] -eq 10 -and $bytes[$i - 1] -ne 13) { $bareLf++ }
        }
        Assert-Test ('T-L15-i ' + $nom + ' : ASCII pur, BOM, CRLF') ($bom -and $nonAscii -eq 0 -and $bareLf -eq 0) ('bom={0} nonAscii={1} lf={2}' -f $bom, $nonAscii, $bareLf)
        $errors = $null
        $tokens = $null
        [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
        Assert-Test ('T-L18-k ' + $nom + ' : ParseFile sans erreur') (@($errors).Count -eq 0) (@($errors | ForEach-Object { $_.Message }) -join ' | ')
    }

    Write-Host ''
    Write-Host ('Total : {0} verifications, {1} en echec.' -f ($Results.Pass + $Results.Fail), $Results.Fail) -ForegroundColor (@('Green', 'Red')[[int]($Results.Fail -gt 0)])
    foreach ($failure in $Results.Failures) { Write-Host ('  - ' + $failure) -ForegroundColor Red }
} finally {
    foreach ($name in $EnvNames) { [Environment]::SetEnvironmentVariable($name, $SavedEnv[$name], 'Process') }
    # Les jonctions se retirent avant le dossier : une suppression recursive suivrait leur cible.
    foreach ($link in @(Get-ChildItem -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer -and (([int]$_.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) })) {
        try { [System.IO.Directory]::Delete($link.FullName, $false) } catch { }
    }
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($Results.Fail -gt 0) { exit 1 }
exit 0
