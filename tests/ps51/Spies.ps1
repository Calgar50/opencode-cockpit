# Spies.ps1 - espions du banc PowerShell 5.1 (contrat : tests/ps51/README.md). A charger par dot-sourcing dans la portee du test.
# Fonctions homonymes des cmdlets (P6) : elles masquent Read-Host, Start-Process, Get-ItemProperty et Test-Path, y compris dans un
# script appele par &. Etat partage par l'objet $SpyState, lu par une variable NON qualifiee (un $script: y vaudrait $null).
# Aucun crochet dans les scripts livres. Seules les cles SOFTWARE\Policies de HKLM et HKCU sont simulees ; le reste est delegue.
Set-StrictMode -Version 2.0

$SpyState = @{
    ReadHostAnswers = New-Object System.Collections.Queue
    ReadHostCalls = New-Object System.Collections.ArrayList
    StartProcessCalls = New-Object System.Collections.ArrayList
    Policies = @{}
    PolicyReads = New-Object System.Collections.ArrayList
}
# Reponse speciale : Read-Host leve l'exception de powershell.exe -NonInteractive.
$SpyNonInteractive = '<<espion:NonInteractive>>'

function Reset-SpyState {
    $SpyState.ReadHostAnswers.Clear()
    $SpyState.ReadHostCalls.Clear()
    $SpyState.StartProcessCalls.Clear()
    $SpyState.Policies.Clear()
    $SpyState.PolicyReads.Clear()
}

# Add-SpyReadHostAnswer 'HTTP EN CLAIR' ; Add-SpyReadHostAnswer $null (entree vide) ; Add-SpyReadHostAnswer $SpyNonInteractive
function Add-SpyReadHostAnswer { foreach ($answer in $args) { $SpyState.ReadHostAnswers.Enqueue($answer) } }

# Set-SpyPolicy -Hive HKLM -Browser Edge -Name SSLErrorOverrideAllowed -Value 0 -Origins @('https://127.0.0.1:7777')
function Set-SpyPolicy([string]$Hive, [string]$Browser = 'Edge', [string]$Name, $Value, [string[]]$Origins) {
    $subKey = 'Microsoft\Edge'
    if ($Browser -eq 'Chrome') { $subKey = 'Google\Chrome' }
    $key = ('{0}:\SOFTWARE\Policies\{1}' -f $Hive, $subKey).ToLowerInvariant()
    if ($Name) {
        if (-not $SpyState.Policies.ContainsKey($key)) { $SpyState.Policies[$key] = [ordered]@{} }
        $SpyState.Policies[$key][$Name] = $Value
    }
    if ($null -ne $Origins) {
        $list = [ordered]@{}
        for ($i = 0; $i -lt $Origins.Count; $i++) { $list[[string]($i + 1)] = $Origins[$i] }
        $SpyState.Policies[($key + '\SSLErrorOverrideAllowedForOrigins').ToLowerInvariant()] = $list
    }
}

# Chemin de registre -> cle simulee en minuscules, ou $null si le chemin n'est pas sous SOFTWARE\Policies.
function ConvertTo-SpyPolicyKey([string]$Path) {
    $normalized = $Path -replace '^(Microsoft\.PowerShell\.Core\\)?Registry::', ''
    $normalized = ($normalized -replace '^HKEY_LOCAL_MACHINE', 'HKLM:') -replace '^HKEY_CURRENT_USER', 'HKCU:'
    $normalized = $normalized.TrimEnd('\')
    if ($normalized -match '^(HKLM|HKCU):\\SOFTWARE\\Policies(\\|\z)') { return $normalized.ToLowerInvariant() }
    return ''
}

function Read-Host {
    [CmdletBinding()]
    param([Parameter(Position = 0)][object]$Prompt, [switch]$AsSecureString)
    $text = [string]$Prompt
    [void]$SpyState.ReadHostCalls.Add($text)
    if ($SpyState.ReadHostAnswers.Count -eq 0) { throw ('espion Read-Host : aucune reponse prevue pour : {0}' -f $text) }
    $answer = $SpyState.ReadHostAnswers.Dequeue()
    if ($null -ne $answer -and [string]$answer -ceq $SpyNonInteractive) {
        throw (New-Object System.Management.Automation.PSInvalidOperationException 'PowerShell est en mode NonInteractive (espion).')
    }
    return $answer
}

# Consigne sans afficher (l'URL de connexion ne doit jamais apparaitre dans une sortie).
function Start-Process {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$FilePath, [Parameter(Position = 1)][string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru,
        [switch]$NoNewWindow, [string]$WindowStyle, [string]$WorkingDirectory)
    [void]$SpyState.StartProcessCalls.Add([pscustomobject]@{ FilePath = $FilePath; ArgumentList = $ArgumentList })
}

function Test-Path {
    [CmdletBinding(DefaultParameterSetName = 'Path')]
    param(
        [Parameter(ParameterSetName = 'Path', Position = 0, ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)][string[]]$Path,
        [Parameter(ParameterSetName = 'LiteralPath', ValueFromPipelineByPropertyName = $true)][Alias('PSPath')][string[]]$LiteralPath,
        [string]$Filter, [string[]]$Include, [string[]]$Exclude,
        [Microsoft.PowerShell.Commands.TestPathType]$PathType = 'Any', [switch]$IsValid
    )
    process {
        $targets = @(@($Path) + @($LiteralPath) | Where-Object { $null -ne $_ })
        $keys = @(foreach ($target in $targets) { ConvertTo-SpyPolicyKey $target })
        if ($targets.Count -eq 0 -or @($keys | Where-Object { $_ -ceq '' }).Count -gt 0) {
            Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
            return
        }
        foreach ($key in $keys) {
            [void]$SpyState.PolicyReads.Add($key)
            $exists = $SpyState.Policies.ContainsKey($key) -or @($SpyState.Policies.Keys | Where-Object { $_.StartsWith($key + '\') }).Count -gt 0
            ($exists -and $PathType -ne 'Leaf')
        }
    }
}

function Get-ItemProperty {
    [CmdletBinding(DefaultParameterSetName = 'Path')]
    param(
        [Parameter(ParameterSetName = 'Path', Position = 0, ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)][string[]]$Path,
        [Parameter(ParameterSetName = 'LiteralPath', ValueFromPipelineByPropertyName = $true)][Alias('PSPath')][string[]]$LiteralPath,
        [Parameter(Position = 1)][string[]]$Name, [string]$Filter, [string[]]$Include, [string[]]$Exclude
    )
    process {
        $targets = @(@($Path) + @($LiteralPath) | Where-Object { $null -ne $_ })
        $keys = @(foreach ($target in $targets) { ConvertTo-SpyPolicyKey $target })
        if ($targets.Count -eq 0 -or @($keys | Where-Object { $_ -ceq '' }).Count -gt 0) {
            Microsoft.PowerShell.Management\Get-ItemProperty @PSBoundParameters
            return
        }
        foreach ($key in $keys) {
            [void]$SpyState.PolicyReads.Add($key)
            if (-not $SpyState.Policies.ContainsKey($key)) {
                Write-Error -Message ("Impossible de trouver le chemin '{0}' (espion)." -f $key) -Category ObjectNotFound
                continue
            }
            $values = $SpyState.Policies[$key]
            $object = [ordered]@{ PSPath = $key }
            foreach ($valueName in @($values.Keys)) { if (-not $Name -or $Name -contains $valueName) { $object[$valueName] = $values[$valueName] } }
            foreach ($wanted in @($Name | Where-Object { $_ })) {
                if (-not $values.Contains($wanted)) { Write-Error -Message ("Propriete '{0}' absente (espion)." -f $wanted) -Category InvalidArgument }
            }
            [pscustomobject]$object
        }
    }
}
