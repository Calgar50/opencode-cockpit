# Validate-Scripts.ps1 - regles statiques des scripts PowerShell 5.1 du cockpit (plan 3.7.8), puis auto-test d'injection.
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Validate-Scripts.ps1 [-Path <fichiers>] [-SkipSelfTest]
# -Path : chemins relatifs a la racine du depot ; les regles dependent du nom. Defaut : tous les .ps1 livres, c'est-a-dire
# ceux de la racine du depot et ceux du dossier scripts\ (les bancs de tests\ps51 ont leurs propres suites).
# Code de sortie : 0 si chaque fichier est conforme et si l'auto-test est vert, 1 sinon.
param([string[]]$Path, [switch]$SkipSelfTest)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

$ForbiddenWords = @('Invoke-WebRequest', 'Invoke-RestMethod', 'ServicePointManager', 'DefaultWebProxy', 'SecurityProtocol', 'SkipCertificateCheck',
    'Import-Certificate', 'certutil', 'X509Store', 'Invoke-Expression')
$ForbiddenCommands = @('iwr', 'irm', 'iex', 'curl', 'curl.exe', 'git', 'git.exe', 'wget')
$DockerFunctions = @('Invoke-Docker', 'Get-DockerOutput', 'Invoke-DockerTimeout', 'Get-ArchiveDir', 'Invoke-CockpitDocker')
$ReadHostPrompts = @{
    'install.ps1' = @('Dossier de vos projets', "Le dossier '", 'Continuer quand meme ?')
    'cockpit.ps1' = @('Tapez RESTAURER pour confirmer', 'Tapez SUPPRIMER pour confirmer', 'Tapez RENOUVELER pour confirmer', 'Tapez REVENIR pour confirmer')
    'CockpitTls.ps1' = @('Tapez HTTP EN CLAIR pour confirmer')
}
$InstallParams = @('WorkspaceDir', 'Port', 'Mode', 'ImagesArchive', 'ImageRegistry', 'Proxy', 'NoProxy', 'CopilotApiUrl', 'SkipCertificates',
    'InsecureTls', 'SecureTls', 'NoStart', 'NoBrowser', 'Http', 'Https', 'TlsPreflight', 'AcceptBrowserBlock',
    'OmoArchive', 'OmoProjetsSeulement', 'WorkspacePath')
$CockpitParams = @('Command', 'Target', 'Purge', 'PurgeOmo', 'Renew')
$CockpitCommands = @('open', 'start', 'stop', 'restart', 'status', 'logs', 'diag', 'certs', 'update', 'backup', 'restore', 'uninstall', 'help', 'tls', 'rollback')

function Find-Ast($Ast, [scriptblock]$Predicate) { return @($Ast.FindAll($Predicate, $true)) }

function Get-FunctionAt($Functions, [int]$Offset) {
    $best = $null
    foreach ($f in $Functions) {
        if ($f.Extent.StartOffset -le $Offset -and $Offset -lt $f.Extent.EndOffset -and ($null -eq $best -or $f.Extent.StartOffset -gt $best.Extent.StartOffset)) { $best = $f }
    }
    if ($null -eq $best) { return '' }
    return $best.Name
}

function Get-SwitchClauseExtent($Ast, [string]$Label) {
    foreach ($switch in (Find-Ast $Ast { param($n) $n -is [System.Management.Automation.Language.SwitchStatementAst] })) {
        foreach ($clause in $switch.Clauses) {
            if ($clause.Item1 -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $clause.Item1.Value -ceq $Label) { return $clause.Item2.Extent }
        }
    }
    return $null
}

function Test-InExtent($Extent, [int]$Offset) { return ($null -ne $Extent -and $Extent.StartOffset -le $Offset -and $Offset -lt $Extent.EndOffset) }

# Un appel porte-t-il "-RemoveEnv $CockpitComposeEnvNames" ? Le NOM Invoke-CockpitProcess ne garantit rien : sa signature
# (CockpitTls.ps1) donne $RemoveEnv = @() par defaut, donc sans cet argument l'enfant herite des variables de compose du shell.
# C'est l'argument, sur le CommandAst lui-meme, qui est exige : nom du parametre, puis la variable attendue derriere lui.
function Test-CockpitRemoveEnv($Command) {
    $elements = @($Command.CommandElements)
    for ($i = 1; $i -lt $elements.Count; $i++) {
        $element = $elements[$i]
        if (-not ($element -is [System.Management.Automation.Language.CommandParameterAst])) { continue }
        if ($element.ParameterName -ine 'RemoveEnv') { continue }
        # Forme "-RemoveEnv:$x" : la valeur est portee par le parametre ; forme "-RemoveEnv $x" : c'est l'element suivant.
        $value = $element.Argument
        if ($null -eq $value -and $i + 1 -lt $elements.Count) { $value = $elements[$i + 1] }
        return ($value -is [System.Management.Automation.Language.VariableExpressionAst] -and $value.VariablePath.UserPath -ceq 'CockpitComposeEnvNames')
    }
    return $false
}

function Get-Violations([string]$File, [string]$Kind, [string]$ComposeFile) {
    $found = New-Object System.Collections.Generic.List[string]
    $bytes = [System.IO.File]::ReadAllBytes($File)
    $start = 0
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $start = 3 } else { $found.Add('encodage : BOM UTF-8 absent') }
    $nonAscii = 0; $control = 0; $bareLf = 0
    for ($i = $start; $i -lt $bytes.Length; $i++) {
        $b = $bytes[$i]
        if ($b -gt 127) { $nonAscii++ } elseif ($b -eq 10) { if ($i -eq 0 -or $bytes[$i - 1] -ne 13) { $bareLf++ } } elseif ($b -lt 32 -and $b -ne 9 -and $b -ne 13) { $control++ }
    }
    if ($nonAscii -gt 0) { $found.Add(('encodage : {0} octet(s) non ASCII' -f $nonAscii)) }
    if ($control -gt 0) { $found.Add(('encodage : {0} caractere(s) de controle' -f $control)) }
    if ($bareLf -gt 0) { $found.Add(('encodage : {0} fin(s) de ligne LF sans CR' -f $bareLf)) }
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$tokens, [ref]$errors)
    foreach ($e in @($errors)) { $found.Add(('analyse : {0} (ligne {1})' -f $e.Message, $e.Extent.StartLineNumber)) }
    if (@($errors).Count -gt 0) { return $found }
    $functions = Find-Ast $ast { param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }
    $certsClause = $null
    $uninstallClause = $null
    if ($Kind -ceq 'cockpit.ps1') {
        $certsClause = Get-SwitchClauseExtent $ast 'certs'
        $uninstallClause = Get-SwitchClauseExtent $ast 'uninstall'
    }
    $code = @($tokens | Where-Object { $_.Kind -ne [System.Management.Automation.Language.TokenKind]::Comment })

    foreach ($token in $code) {
        $text = $token.Text
        $offset = $token.Extent.StartOffset
        $line = $token.Extent.StartLineNumber
        $function = Get-FunctionAt $functions $offset
        # '://' seul : une adresse assemblee ($scheme + '://127.0.0.1:') est aussi une adresse litterale.
        if ($text -match '(?i)://(127\.0\.0\.1|localhost)' -and @('Get-CockpitBaseUrl', 'Get-CockpitBrowserTlsPolicy') -notcontains $function) {
            $found.Add(('url-litterale : adresse locale ecrite hors de Get-CockpitBaseUrl (ligne {0})' -f $line))
        }
        # Processus lance a la main : curl et git passent par Invoke-CockpitProcess, docker par ses fonctions d'appel.
        if ($text -match '(?i)(ProcessStartInfo|(^|\.)Diagnostics\.Process$)' -and @(@('Invoke-CockpitProcess') + $DockerFunctions) -notcontains $function) {
            $found.Add(('appel-natif : processus lance hors d Invoke-CockpitProcess (ligne {0})' -f $line))
        }
        foreach ($word in $ForbiddenWords) { if ($text.IndexOf($word, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $found.Add(('interdit : {0} (ligne {1})' -f $word, $line)) } }
        if (@('-k', '--insecure') -contains $text.Trim([char]39, [char]34)) { $found.Add(('interdit : option {0} (ligne {1})' -f $text, $line)) }
        if ($text.IndexOf('Cert:\', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $function -cne 'Export-WindowsCertificates' -and -not (Test-InExtent $certsClause $offset)) {
            $found.Add(('interdit : Cert:\ hors de l export des autorites (ligne {0})' -f $line))
        }
        if ($text.IndexOf('.Config.Env', [System.StringComparison]::Ordinal) -ge 0 -and $function -cne 'Get-CockpitImageVersion') {
            $found.Add(('docker-inspect : .Config.Env hors de Get-CockpitImageVersion (ligne {0})' -f $line))
        }
        # Desinstallation en masse : --volumes emporterait les conversations de la salle et --rmi son image, que
        # 'uninstall -Purge' doit garder (decision du 17/09, point 3). Les commentaires ne comptent pas.
        if ((Test-InExtent $uninstallClause $offset) -and @('--volumes', '--rmi') -ccontains $text.Trim([char]39, [char]34)) {
            $found.Add(('desinstallation : option {0} dans uninstall (ligne {1})' -f $text, $line))
        }
    }
    foreach ($member in (Find-Ast $ast { param($n) $n -is [System.Management.Automation.Language.MemberExpressionAst] })) {
        if ($member.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $member.Member.Value -ieq 'Thumbprint') {
            $offset = $member.Extent.StartOffset
            if ((Get-FunctionAt $functions $offset) -cne 'Export-WindowsCertificates' -and -not (Test-InExtent $certsClause $offset)) {
                $found.Add(('interdit : .Thumbprint hors de l export des autorites (ligne {0})' -f $member.Extent.StartLineNumber))
            }
        }
    }
    foreach ($command in (Find-Ast $ast { param($n) $n -is [System.Management.Automation.Language.CommandAst] })) {
        # Nom sans module ni dossier : Microsoft.PowerShell.Utility\Read-Host et C:\Windows\System32\curl.exe comptent aussi.
        $name = $command.GetCommandName()
        if ($null -ne $name) { $name = $name -replace '^.*[\\/]', '' }
        $offset = $command.Extent.StartOffset
        $line = $command.Extent.StartLineNumber
        $function = Get-FunctionAt $functions $offset
        if ($null -eq $name -and $command.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst]) {
            $variable = $command.CommandElements[0].VariablePath.UserPath
            if ($variable -match '(?i)curl|git' -or ($variable -match '(?i)docker' -and $DockerFunctions -notcontains $function)) { $found.Add(('appel-natif : & ${0} (ligne {1})' -f $variable, $line)) }
            continue
        }
        if ($null -eq $name) {
            # & "$env:SystemRoot\System32\curl.exe" : cible calculee, reconnue par son texte.
            $target = $command.CommandElements[0].Extent.Text.Trim([char]39, [char]34)
            if ($target -match '(?i)(^|[\\/])(curl|git)(\.exe)?$' -or ($target -match '(?i)(^|[\\/])docker(\.exe)?$' -and $DockerFunctions -notcontains $function)) { $found.Add(('appel-natif : & {0} (ligne {1})' -f $target, $line)) }
            continue
        }
        if ($ForbiddenCommands -contains $name) { $found.Add(('appel-natif : {0} hors d Invoke-CockpitProcess (ligne {1})' -f $name, $line)) }
        if (@('docker', 'docker.exe') -contains $name -and $DockerFunctions -notcontains $function) { $found.Add(('appel-natif : docker hors des fonctions d appel docker (ligne {0})' -f $line)) }
        if ($name -ieq 'Add-Type' -and ($Kind -cne 'CockpitTls.ps1' -or $function -cne 'Initialize-CockpitPinnedHttp')) { $found.Add(('add-type : hors d Initialize-CockpitPinnedHttp (ligne {0})' -f $line)) }
        if ($name -ieq 'Read-Host') {
            $prompt = $null
            for ($i = 1; $i -lt $command.CommandElements.Count; $i++) {
                $element = $command.CommandElements[$i]
                if ($element -is [System.Management.Automation.Language.CommandParameterAst]) { if ($element.ParameterName -ieq 'Prompt' -and $i + 1 -lt $command.CommandElements.Count) { $i++; $element = $command.CommandElements[$i] } else { continue } }
                if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) { $prompt = $element.Value }
                break
            }
            $allowed = @()
            if ($ReadHostPrompts.ContainsKey($Kind)) { $allowed = @($ReadHostPrompts[$Kind]) }
            $ok = $null -ne $prompt -and @($allowed | Where-Object { $prompt.StartsWith($_, [System.StringComparison]::Ordinal) }).Count -gt 0
            if ($Kind -ceq 'CockpitTls.ps1' -and $function -cne 'Confirm-CockpitHttpMode') { $ok = $false }
            if (-not $ok) { $found.Add(('read-host : invite hors de la liste fermee (ligne {0})' -f $line)) }
        }
    }
    foreach ($function in $functions) {
        if ($DockerFunctions -notcontains $function.Name) { continue }
        $names = @(Find-Ast $function.Body { param($n) $n -is [System.Management.Automation.Language.CommandAst] } | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ })
        $variables = @(Find-Ast $function.Body { param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] } | ForEach-Object { $_.VariablePath.UserPath })
        # Invoke-CockpitProcess n'est admis qu'avec l'ARGUMENT "-RemoveEnv $CockpitComposeEnvNames" : le nom seul laisserait
        # passer un appel qui garde les variables de compose du shell de l'utilisateur (COCKPIT_TOKEN, WORKSPACE_DIR,
        # COMPOSE_PROFILES...), c'est-a-dire la fuite meme que cette regle ferme. Le parametre est cherche sur l'appel.
        $viaProcess = @(Find-Ast $function.Body { param($n) $n -is [System.Management.Automation.Language.CommandAst] } |
            Where-Object { $_.GetCommandName() -ieq 'Invoke-CockpitProcess' } | Where-Object { Test-CockpitRemoveEnv $_ }).Count -gt 0
        $isolated = ($names -contains 'Invoke-CockpitDocker') -or $viaProcess -or
            (($names -contains 'ConvertTo-CockpitDockerArgs') -and (($names -contains 'Clear-CockpitComposeEnv') -or ($variables -contains 'CockpitComposeEnvNames')))
        if (-not $isolated) { $found.Add(('docker-isolation : {0} sans ConvertTo-CockpitDockerArgs et masquage des variables de compose' -f $function.Name)) }
    }
    if ($Kind -ceq 'CockpitTls.ps1') {
        $assignment = @(Find-Ast $ast { param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $n.Left.VariablePath.UserPath -ceq 'CockpitComposeEnvNames' })
        $listed = @()
        if ($assignment.Count -gt 0) { $listed = @(Find-Ast $assignment[0].Right { param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] } | ForEach-Object { $_.Value }) }
        $expected = @([regex]::Matches([System.IO.File]::ReadAllText($ComposeFile), '\$\{([A-Z_][A-Z0-9_]*)') | ForEach-Object { $_.Groups[1].Value }) + @('COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROFILES')
        foreach ($name in ($expected | Sort-Object -Unique)) { if ($listed -cnotcontains $name) { $found.Add(('compose-variables : {0} absent de $CockpitComposeEnvNames' -f $name)) } }
        $lines = [System.IO.File]::ReadAllLines($File).Count
        if ($lines -gt 700) { $found.Add(('taille : {0} lignes (700 au plus)' -f $lines)) }
    }
    if ($null -ne $ast.ParamBlock -and @('install.ps1', 'cockpit.ps1') -contains $Kind) {
        $params = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
        $wanted = $InstallParams
        if ($Kind -ceq 'cockpit.ps1') { $wanted = $CockpitParams }
        if (@(Compare-Object -ReferenceObject $wanted -DifferenceObject $params).Count -gt 0) { $found.Add(('parametres : bloc param different de la liste attendue ({0})' -f ($params -join ', '))) }
        if ($Kind -ceq 'cockpit.ps1') {
            foreach ($parameter in $ast.ParamBlock.Parameters) {
                $pname = $parameter.Name.VariablePath.UserPath
                if ($pname -ceq 'Renew' -and $parameter.StaticType -ne [System.Management.Automation.SwitchParameter]) { $found.Add('parametres : Renew doit etre un [switch]') }
                if ($pname -ceq 'Command') {
                    $set = @($parameter.Attributes | Where-Object { $_.TypeName.Name -ceq 'ValidateSet' } | ForEach-Object { $_.PositionalArguments } | ForEach-Object { $_.Value })
                    if (@(Compare-Object -ReferenceObject $CockpitCommands -DifferenceObject $set).Count -gt 0) { $found.Add('parametres : ValidateSet de Command different de la liste attendue') }
                }
            }
            $backup = Get-SwitchClauseExtent $ast 'backup'
            if ($null -ne $backup -and $backup.Text -match '(?i)cockpit-tls:') { $found.Add('sauvegarde : volume cockpit-tls monte dans backup') }
            # Options de desinstallation en masse interdites : voir la regle 'desinstallation' de la boucle de jetons.
        }
    } elseif (@('install.ps1', 'cockpit.ps1') -contains $Kind) {
        $found.Add('parametres : bloc param absent')
    }
    return $found
}

function Write-TestFile([string]$File, [string]$Text, [switch]$NoBom, [switch]$KeepLf) {
    if (-not $KeepLf) { $Text = $Text.Replace("`r`n", "`n").Replace("`n", "`r`n") }
    [System.IO.File]::WriteAllText($File, $Text, (New-Object System.Text.UTF8Encoding (-not $NoBom)))
}

# Auto-test : chaque motif interdit injecte dans une copie temporaire doit etre detecte par la regle attendue.
function Invoke-SelfTest([string]$ComposeFile) {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('cockpit-validate-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $failures = New-Object System.Collections.Generic.List[string]
    $count = 0
    try {
        $bases = @{
            'CockpitTls.ps1' = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'CockpitTls.ps1')).TrimStart([char]0xFEFF)
            'install.ps1' = @('[CmdletBinding()]',
                'param([string]$WorkspaceDir, [int]$Port = 0, [string]$Mode, [string]$ImagesArchive, [string]$ImageRegistry, [string]$Proxy, [string]$NoProxy, [string]$CopilotApiUrl,',
                '    [switch]$SkipCertificates, [switch]$InsecureTls, [switch]$SecureTls, [switch]$NoStart, [switch]$NoBrowser, [switch]$Http, [switch]$Https, [switch]$TlsPreflight, [switch]$AcceptBrowserBlock,',
                '    [string]$OmoArchive, [switch]$OmoProjetsSeulement, [string]$WorkspacePath)',
                'function Export-WindowsCertificates { foreach ($cert in (Get-ChildItem -Path ''Cert:\CurrentUser\Root'')) { $cert.Thumbprint } }',
                'function Invoke-Docker { $dockerArgs = ConvertTo-CockpitDockerArgs $Root @($args); $saved = Clear-CockpitComposeEnv; try { & docker @dockerArgs } finally { Restore-CockpitComposeEnv $saved } }',
                'function Get-DockerOutput { Invoke-CockpitProcess -FilePath $DockerPath -Arguments $Arguments -RemoveEnv $CockpitComposeEnvNames }',
                '$answer = Read-Host "Dossier de vos projets [$WorkspaceDir]"', '') -join "`n"
            'cockpit.ps1' = @('[CmdletBinding()]',
                'param([Parameter(Position = 0)][ValidateSet(''open'', ''start'', ''stop'', ''restart'', ''status'', ''logs'', ''diag'', ''certs'', ''update'', ''backup'', ''restore'', ''uninstall'', ''help'', ''tls'', ''rollback'')][string]$Command = ''help'',',
                '    [Parameter(Position = 1)][string]$Target = '''', [switch]$Purge, [switch]$PurgeOmo, [switch]$Renew)',
                'switch ($Command) {',
                '    ''certs'' { foreach ($cert in (Get-ChildItem -Path ''Cert:\LocalMachine\Root'')) { $cert.Thumbprint } }',
                '    ''backup'' { Invoke-Docker run --rm -v "${Project}_cockpit-data:/src/cockpit-data:ro" img; Write-Host ''Exclus : certificat HTTPS local (volume cockpit-tls).'' }',
                '    ''restore'' { $answer = Read-Host ''Tapez RESTAURER pour confirmer'' }',
                '    ''uninstall'' { Invoke-Docker compose down --remove-orphans; Invoke-DockerTimeout 180 volume rm -f @volumeArgs }',
                '}', '') -join "`n"
        }
        foreach ($kind in @($bases.Keys)) {
            $file = Join-Path $dir $kind
            Write-TestFile $file $bases[$kind]
            $base = @(Get-Violations $file $kind $ComposeFile)
            $count++
            if ($base.Count -gt 0) { $failures.Add(('base {0} non conforme : {1}' -f $kind, ($base -join ' | '))) }
        }
        $append = 'function Test-Injection {{ {0} }}'
        $cases = @(
            @('CockpitTls.ps1', 'encodage', 'nobom', ''), @('CockpitTls.ps1', 'encodage', 'append', ('# ' + [char]0xE9)), @('CockpitTls.ps1', 'encodage', 'append', ('# ' + [char]7)),
            @('CockpitTls.ps1', 'encodage', 'keeplf', "`n# lf"), @('CockpitTls.ps1', 'analyse', 'append', 'function Test-Casse {'),
            @('CockpitTls.ps1', 'url-litterale', 'append', ($append -f "Start-Process 'http://127.0.0.1:7777'")),
            @('CockpitTls.ps1', 'url-litterale', 'append', ($append -f '"https://127.0.0.1:{0}" -f 1')),
            @('install.ps1', 'url-litterale', 'append', '$url = ''http://localhost:7777/auth'''),
            @('CockpitTls.ps1', 'interdit', 'append', ($append -f 'Invoke-WebRequest -UseBasicParsing -Uri $u')),
            @('install.ps1', 'interdit', 'append', 'Invoke-RestMethod -Uri $u'),
            @('CockpitTls.ps1', 'interdit', 'append', ($append -f '[System.Net.ServicePointManager]::Expect100Continue = $false')),
            @('cockpit.ps1', 'interdit', 'append', '[System.Net.WebRequest]::DefaultWebProxy = $null'),
            @('install.ps1', 'interdit', 'append', '$p = [Net.ServicePointManager]::SecurityProtocol'),
            @('CockpitTls.ps1', 'interdit', 'append', ($append -f 'Get-Thing -SkipCertificateCheck')),
            @('CockpitTls.ps1', 'interdit', 'append', ($append -f "Invoke-CockpitProcess -FilePath `$c -Arguments @('-k', 'x')")),
            @('install.ps1', 'interdit', 'append', '$a = @(''--insecure'')'),
            @('install.ps1', 'interdit', 'append', 'Import-Certificate -FilePath x -CertStoreLocation y'),
            @('cockpit.ps1', 'interdit', 'append', '$tool = ''certutil'''),
            @('CockpitTls.ps1', 'interdit', 'append', ($append -f 'New-Object System.Security.Cryptography.X509Certificates.X509Store')),
            @('install.ps1', 'interdit', 'append', 'Get-ChildItem Cert:\CurrentUser\My'),
            @('cockpit.ps1', 'interdit', 'append', '$t = $x.Thumbprint'),
            @('CockpitTls.ps1', 'interdit', 'append', ($append -f 'Invoke-Expression $s')),
            @('install.ps1', 'appel-natif', 'append', 'iex $s'),
            @('CockpitTls.ps1', 'add-type', 'append', ($append -f "Add-Type -TypeDefinition 'x'")),
            @('install.ps1', 'add-type', 'append', "Add-Type -AssemblyName System.Web"),
            @('install.ps1', 'read-host', 'append', "`$secret = Read-Host 'Mot de passe'"),
            @('CockpitTls.ps1', 'read-host', 'append', ($append -f "Read-Host 'Tapez HTTP EN CLAIR pour confirmer'")),
            @('cockpit.ps1', 'read-host', 'append', '$answer = Read-Host'),
            @('CockpitTls.ps1', 'appel-natif', 'append', ($append -f '& curl.exe --version')),
            @('install.ps1', 'appel-natif', 'append', '& git -C $Root pull --ff-only'),
            @('cockpit.ps1', 'appel-natif', 'append', '& docker compose up -d'),
            @('CockpitTls.ps1', 'appel-natif', 'append', ($append -f '& $curl --version')),
            @('install.ps1', 'appel-natif', 'append', '& "$env:SystemRoot\System32\curl.exe" --version'),
            @('cockpit.ps1', 'appel-natif', 'append', '& ''C:\Program Files\Git\cmd\git.exe'' status'),
            @('CockpitTls.ps1', 'appel-natif', 'append', ($append -f '$p = New-Object System.Diagnostics.ProcessStartInfo')),
            @('cockpit.ps1', 'appel-natif', 'append', '[System.Diagnostics.Process]::Start(''git.exe'', ''pull'')'),
            @('install.ps1', 'url-litterale', 'append', '$u = $scheme + ''://127.0.0.1:'' + $Port'),
            @('install.ps1', 'read-host', 'append', '$x = Microsoft.PowerShell.Utility\Read-Host ''Mot de passe'''),
            @('CockpitTls.ps1', 'add-type', 'append', ($append -f "Microsoft.PowerShell.Utility\Add-Type -TypeDefinition 'x'")),
            @('install.ps1', 'docker-isolation', 'replace', 'ConvertTo-CockpitDockerArgs $Root @($args)|@($args)'),
            @('install.ps1', 'docker-isolation', 'replace', '$saved = Clear-CockpitComposeEnv; |'),
            @('CockpitTls.ps1', 'compose-variables', 'replace', "'COCKPIT_PORT', |"),
            @('CockpitTls.ps1', 'docker-inspect', 'append', ($append -f "Invoke-CockpitDocker '' @('inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', 'c')")),
            @('install.ps1', 'parametres', 'replace', '[switch]$AcceptBrowserBlock,|[switch]$AcceptBrowserBlock, [switch]$ConfirmHttp,'),
            @('install.ps1', 'parametres', 'replace', ' [switch]$Http,|'),
            @('cockpit.ps1', 'parametres', 'replace', ', ''rollback''|'),
            @('cockpit.ps1', 'parametres', 'replace', '[switch]$Renew|[string]$Renew'),
            @('cockpit.ps1', 'sauvegarde', 'replace', ':ro" img;|:ro" -v "${Project}_cockpit-tls:/src/tls:ro" img;'),
            @('install.ps1', 'docker-isolation', 'replace', 'Invoke-CockpitProcess -FilePath $DockerPath|& docker'),
            # Le seul retrait de l'argument suffit a rendre l'appel permeable : la regle doit le voir (relecture 2bis-vague-2).
            @('install.ps1', 'docker-isolation', 'replace', ' -RemoveEnv $CockpitComposeEnvNames|'),
            @('install.ps1', 'docker-isolation', 'replace', '-RemoveEnv $CockpitComposeEnvNames|-RemoveEnv @(''COCKPIT_PORT'')'),
            @('cockpit.ps1', 'desinstallation', 'replace', 'compose down --remove-orphans|compose down --volumes --rmi all'),
            @('cockpit.ps1', 'desinstallation', 'replace', 'compose down --remove-orphans|compose down --rmi local'),
            @('install.ps1', 'parametres', 'replace', '[string]$OmoArchive, |'),
            @('cockpit.ps1', 'parametres', 'replace', '[switch]$PurgeOmo, |'),
            @('CockpitTls.ps1', 'taille', 'append', ((1..760 | ForEach-Object { '# ligne ajoutee' }) -join "`n"))
        )
        foreach ($case in $cases) {
            $count++
            $kind = $case[0]; $rule = $case[1]; $how = $case[2]; $payload = $case[3]
            $text = $bases[$kind]
            if ($how -ceq 'replace') {
                $parts = $payload.Split([char]'|', 2)
                if ($text.IndexOf($parts[0], [System.StringComparison]::Ordinal) -lt 0) { $failures.Add(('injection {0} {1} : motif de remplacement introuvable' -f $kind, $rule)); continue }
                $text = $text.Replace($parts[0], $parts[1])
            } elseif ($how -ceq 'append' -or $how -ceq 'keeplf') { $text = $text.TrimEnd() + "`n" + $payload + "`n" }
            $file = Join-Path $dir $kind
            if ($how -ceq 'keeplf') {
                Write-TestFile $file $bases[$kind]
                [System.IO.File]::AppendAllText($file, $payload + "`n")
            } else { Write-TestFile $file $text -NoBom:($how -ceq 'nobom') }
            $violations = @(Get-Violations $file $kind $ComposeFile)
            if (@($violations | Where-Object { $_.StartsWith($rule + ' ') }).Count -eq 0) {
                $failures.Add(('injection non detectee : {0} / {1} / {2}' -f $kind, $rule, ($payload -replace '\s+', ' ').Substring(0, [Math]::Min(60, ($payload -replace '\s+', ' ').Length))))
            }
        }
    } finally {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{ Count = $count; Failures = $failures }
}

# Tous les scripts livres : racine du depot, puis dossier scripts\ (aucun nom en dur : un script neuf est couvert d office).
if (-not $Path) {
    $defaults = @(Get-ChildItem -LiteralPath $RepoRoot -Filter '*.ps1' -File | ForEach-Object { $_.Name } | Sort-Object)
    $scriptsDir = Join-Path $RepoRoot 'scripts'
    if (Test-Path -LiteralPath $scriptsDir -PathType Container) {
        $defaults += @(Get-ChildItem -LiteralPath $scriptsDir -Filter '*.ps1' -File | ForEach-Object { 'scripts/' + $_.Name } | Sort-Object)
    }
    $Path = $defaults
}
$composeFile = Join-Path $RepoRoot 'docker-compose.yml'
$bad = 0
foreach ($item in @($Path | ForEach-Object { $_ -split ',' } | Where-Object { $_.Trim() })) {
    $candidate = $item.Trim()
    if (-not [System.IO.Path]::IsPathRooted($candidate)) { $candidate = Join-Path $RepoRoot $candidate }
    $kind = Split-Path -Leaf $candidate
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { Write-Host ('[ECHEC] {0} : fichier introuvable' -f $item); $bad++; continue }
    $violations = @(Get-Violations $candidate $kind $composeFile)
    if ($violations.Count -eq 0) { Write-Host ('[OK] {0}' -f $kind) -ForegroundColor Green; continue }
    $bad++
    Write-Host ('[ECHEC] {0} : {1} ecart(s)' -f $kind, $violations.Count) -ForegroundColor Red
    foreach ($v in $violations) { Write-Host ('    - ' + $v) }
}
if (-not $SkipSelfTest) {
    $self = Invoke-SelfTest $composeFile
    if ($self.Failures.Count -eq 0) { Write-Host ('[OK] auto-test : {0} cas (bases conformes et injections detectees)' -f $self.Count) -ForegroundColor Green }
    else {
        $bad++
        Write-Host ('[ECHEC] auto-test : {0} cas sur {1} en echec' -f $self.Failures.Count, $self.Count) -ForegroundColor Red
        foreach ($f in $self.Failures) { Write-Host ('    - ' + $f) }
    }
}
if ($bad -gt 0) { exit 1 }
exit 0
