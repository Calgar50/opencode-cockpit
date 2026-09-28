# ComposeConfig.ps1 - sortie type de "docker compose config --format json" pour les faux docker des bancs (repetition generale F2).
# A charger par dot-sourcing : Test-CockpitTls.ps1, cockpit\Helpers.ps1 et install\InstallBench.ps1 la rendent tous.
# Depuis la 1.0.6, le service opencode porte HTTP_PROXY ET http_proxy, HTTPS_PROXY et https_proxy, NO_PROXY et no_proxy
# (docker-compose.yml, invariant I2) : Windows PowerShell 5.1 refuse ce JSON tel quel dans ConvertFrom-Json
# (DuplicateKeysInJsonString). Les faux docker rendaient jusque-la un JSON simplifie, sans ces cles : ils cachaient le defaut
# (backup et restore toujours en echec, nom du projet retombe sur opencode-cockpit). Mise en forme de compose (indentation,
# une cle par ligne). Texte assemble a la main : une table de hachage PowerShell ne peut pas porter deux cles de casse
# differente. Valeurs factices.
Set-StrictMode -Version 2.0

# -Project : champ name ; -ArchiveDir : source du montage /archives du service cockpit (aucun montage si vide).
function New-FakeComposeConfigJson([string]$Project = 'opencode-cockpit', [string]$ArchiveDir = '') {
    $relais = 'http://cockpit:3128'
    $exceptions = 'localhost,127.0.0.1,::1,0.0.0.0,opencode,cockpit'
    $lines = @('{', ('  "name": {0},' -f (ConvertTo-Json $Project)), '  "services": {', '    "cockpit": {',
        '      "environment": {', '        "HTTP_PROXY": "",', '        "HTTPS_PROXY": "",', '        "NO_PROXY": "localhost,127.0.0.1,::1,opencode,cockpit"')
    if ($ArchiveDir) {
        $lines += @('      },', '      "volumes": [', '        {', '          "type": "bind",', ('          "source": {0},' -f (ConvertTo-Json ($ArchiveDir -replace '\\', '/'))),
            '          "target": "/archives",', '          "bind": {', '            "create_host_path": true', '          }', '        }', '      ]')
    } else {
        $lines += '      }'
    }
    $lines += @('    },', '    "opencode": {', '      "environment": {', ('        "HTTP_PROXY": "{0}",' -f $relais), ('        "HTTPS_PROXY": "{0}",' -f $relais),
        ('        "NO_PROXY": "{0}",' -f $exceptions), ('        "http_proxy": "{0}",' -f $relais), ('        "https_proxy": "{0}",' -f $relais),
        ('        "no_proxy": "{0}"' -f $exceptions), '      }', '    }', '  }', '}')
    return (($lines -join "`n") + "`n")
}
