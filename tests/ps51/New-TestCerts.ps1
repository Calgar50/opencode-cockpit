# New-TestCerts.ps1 - certificats de test du banc PowerShell 5.1, entierement en .NET 4.8 : cle CNG ECDSA P-256 EPHEMERE
# (exportable en memoire) et CertificateRequest, memes extensions que le serveur (SAN, CA:FALSE, digitalSignature, serverAuth).
# Ecrit seulement dans -Directory, qui doit etre sous le dossier temporaire ; jamais dans un magasin Windows ni dans le depot.
# Pour chaque nom : <nom>.crt, <nom>.key (PKCS#8 PEM, lu par Node) et un objet { Name ; PemText ; JsonText ; Sha256Hex }.
# JsonText reproduit public/cockpit-tls.json du serveur (app/server/tls.ts). Le dossier est supprime par l'appelant.
param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [string[]]$Names = @('A', 'B', 'expire', 'dns')
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$full = [System.IO.Path]::GetFullPath($Directory)
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $full.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'New-TestCerts : dossier hors du dossier temporaire refuse.' }
if (-not (Test-Path -LiteralPath $full -PathType Container)) { New-Item -ItemType Directory -Path $full | Out-Null }

$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$ascii = New-Object System.Text.ASCIIEncoding

function ConvertTo-Pem([string]$Label, [byte[]]$Bytes) {
    return ("-----BEGIN $Label-----`n" + [Convert]::ToBase64String($Bytes, 'InsertLineBreaks').Replace("`r`n", "`n") + "`n-----END $Label-----`n")
}

function New-TestCert([string]$Name, [string[]]$San, [DateTimeOffset]$NotBefore, [DateTimeOffset]$NotAfter) {
    $params = New-Object System.Security.Cryptography.CngKeyCreationParameters
    $params.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::AllowPlaintextExport
    # [NullString]::Value : un $null passe a ce parametre deviendrait "" et creerait une cle PERSISTANTE (mesure du lot 5).
    $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, [NullString]::Value, $params)
    try {
        if (-not $key.IsEphemeral) { $key.Delete(); throw 'New-TestCerts : cle CNG persistante inattendue (supprimee).' }
        $ecdsa = New-Object System.Security.Cryptography.ECDsaCng -ArgumentList (, $key)
        $request = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest -ArgumentList 'CN=opencode-cockpit (local)', ([System.Security.Cryptography.ECDsa]$ecdsa), ([System.Security.Cryptography.HashAlgorithmName]::SHA256)
        $builder = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
        foreach ($entry in $San) {
            if ($entry.StartsWith('IP:')) { $builder.AddIpAddress([System.Net.IPAddress]::Parse($entry.Substring(3))) } else { $builder.AddDnsName($entry.Substring(4)) }
        }
        $request.CertificateExtensions.Add($builder.Build($false))
        $request.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension -ArgumentList $false, $false, 0, $true))
        $request.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension -ArgumentList ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature), $true))
        $oids = New-Object System.Security.Cryptography.OidCollection
        [void]$oids.Add((New-Object System.Security.Cryptography.Oid '1.3.6.1.5.5.7.3.1'))
        $request.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension -ArgumentList $oids, $false))
        $cert = $request.CreateSelfSigned($NotBefore, $NotAfter)
        try {
            $raw = $cert.RawData
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                $hex = [BitConverter]::ToString($sha.ComputeHash($raw)).Replace('-', '').ToLowerInvariant()
                $spkiDer = [byte[]]([Convert]::FromBase64String('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgA=') + $cert.PublicKey.EncodedKeyValue.RawData)
                $spki = [Convert]::ToBase64String($sha.ComputeHash($spkiDer))
            } finally { $sha.Dispose() }
            $pem = ConvertTo-Pem 'CERTIFICATE' $raw
            [System.IO.File]::WriteAllText((Join-Path $full "$Name.crt"), $pem, $ascii)
            [System.IO.File]::WriteAllText((Join-Path $full "$Name.key"), (ConvertTo-Pem ('PRIVATE' + ' KEY') $key.Export([System.Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob)), $ascii)
            $pairs = for ($i = 0; $i -lt 64; $i += 2) { $hex.Substring($i, 2).ToUpperInvariant() }
            $info = [ordered]@{
                schema = 1; source = 'genere'; sha256 = ($pairs -join ':'); sha256Hex = $hex; spkiSha256Base64 = $spki
                notBefore = $NotBefore.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'.000Z'", $invariant)
                notAfter = $NotAfter.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'.000Z'", $invariant)
                san = @($San); ignoredHosts = 0
                generatedAt = $NotBefore.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'.000Z'", $invariant); previousSha256 = $null
            }
            return [pscustomobject]@{ Name = $Name; PemText = $pem; JsonText = (ConvertTo-Json -Depth 3 $info); Sha256Hex = $hex }
        } finally { $cert.Dispose(); $ecdsa.Dispose() }
    } finally { $key.Dispose() }
}

$now = [DateTimeOffset]::UtcNow
$base = @('IP:127.0.0.1', 'DNS:localhost', 'IP:::1')
foreach ($name in $Names) {
    switch ($name) {
        'expire' { New-TestCert $name $base ([DateTimeOffset]'2024-01-01T00:00:00Z') ([DateTimeOffset]'2025-01-01T00:00:00Z') }
        'dns' { New-TestCert $name @('DNS:cockpit.example') $now.AddMinutes(-5) $now.AddDays(397) }
        default { New-TestCert $name $base $now.AddMinutes(-5) $now.AddDays(397) }
    }
}
