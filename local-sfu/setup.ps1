$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$version = '1.13.6'
$asset = "livekit_${version}_windows_amd64.zip"
$runtime = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$archive = Join-Path $runtime $asset
$base = "https://github.com/livekit/livekit/releases/download/v$version"
if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $archive }
$checksums = (Invoke-WebRequest -UseBasicParsing "$base/checksums.txt").Content
if ($checksums -is [byte[]]) { $checksums = [Text.Encoding]::UTF8.GetString($checksums) }
$line = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith($asset) })
if (@($line).Count -ne 1) { throw 'Checksum oficial nao encontrado.' }
$expected = ($line.Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Download com checksum incorreto.' }
Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependencias.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar teste.' }
Write-Host 'Preparado. Abra Iniciar teste local.cmd.'
