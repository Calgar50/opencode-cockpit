# Test-OmoInstall.ps1 - installation de la salle par install.ps1 sous Windows PowerShell 5.1 (paquet L15c). Sans Pester.
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Test-OmoInstall.ps1 [-FailFast]
# Banc partage : copie jetable du cockpit (install/InstallBench.ps1), faux docker en tete du PATH, espions (Spies.ps1).
# Couvre : le contrat machine, l'archive de la salle (empreinte verifiee AVANT tout chargement, identifiant compare),
# les projets prepares et la protection des depots git du dossier de travail, enfin l'encodage de tous les .ps1 livres.
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
# 2bis-vague-2 : les binds .git:ro de la salle, et la source de la liste des projets prepares sur le cockpit.
function Get-OverlayLines([string]$Root, [string]$Service = $NomSalle) {
    $montages = New-Object System.Collections.Generic.List[string]
    $dedans = $false
    foreach ($ligne in @([System.IO.File]::ReadAllLines((Get-OverlayFile $Root)))) {
        if ($ligne -cmatch '^  [A-Za-z0-9_.-]+:$') { $dedans = ($ligne -ceq ('  ' + $Service + ':')); continue }
        if ($dedans -and $ligne.StartsWith('      - ')) { $montages.Add($ligne.Substring(8)) }
    }
    return @($montages)
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

    $lines = Get-OverlayLines $Root
    Assert-Test 'surcharge : un montage par depot protege' ($lines.Count -eq @($Projects.gitProteges).Count) ('{0} / {1}' -f $lines.Count, @($Projects.gitProteges).Count)
    Assert-Test 'surcharge : service du contrat' (([System.IO.File]::ReadAllText((Get-OverlayFile $Root))).Contains('  ' + $NomSalle + ':'))
    Assert-Test 'surcharge : chaque montage est entre guillemets et en lecture seule' (@($lines | Where-Object { $_.StartsWith('"') -and $_.EndsWith(':ro"') }).Count -eq $lines.Count) ($lines -join ' | ')
    $attendu = '"' + ($Ws -replace '\\', '/') + '/alpha/.git:/workspace/alpha/.git:ro"'
    Assert-Test 'surcharge : source de l hote et cible sous /workspace' ($lines -ccontains $attendu) ($lines -join ' | ')
    $dollar = @($lines | Where-Object { $_.Contains('pro jet') })
    Assert-Test 'surcharge : un dollar du nom de dossier est double pour compose' ($dollar.Count -eq 0) ($dollar -join ' | ')

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

    # Le dossier a dollar n'a pas de depot git : il n'apparait donc pas dans la surcharge. On eprouve l'echappement
    # sur un arbre dedie, ou ce dossier porte un .git.
    $WsDollar = New-Folder (Join-Path $Work 'ws-dollar')
    New-GitFolder (Join-Path $WsDollar 'pro jet $test\.git')
    $RootDollar = New-InstallRoot $Work $RepoRoot 'cockpit-dollar'
    $result = Invoke-Install -Root $RootDollar -Parameters @{ OmoProjetsSeulement = $true; WorkspacePath = $WsDollar }
    $lignesDollar = Get-OverlayLines $RootDollar
    Assert-Test 'surcharge : dollar double et espace conserve' ($result.ExitCode -eq 0 -and @($lignesDollar | Where-Object { $_.Contains('pro jet $$test/.git') }).Count -eq 1) ($lignesDollar -join ' | ')
    Assert-Test 'omo-projets.json : le chemin garde le dollar tel quel' ((Get-ProjectState (Read-Projects $RootDollar) 'pro jet $test') -ceq 'dossier')

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
