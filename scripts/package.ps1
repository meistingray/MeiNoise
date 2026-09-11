param(
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$distDirectory = Join-Path $projectRoot "dist"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $distDirectory "MeiNoise.ccx"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $projectRoot $OutputPath
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput
$temporaryZip = Join-Path $distDirectory "MeiNoise.package.zip"

New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$runtimeFiles = @(
    (Join-Path $projectRoot "manifest.json"),
    (Join-Path $projectRoot "index.html"),
    (Join-Path $projectRoot "styles.css"),
    (Join-Path $projectRoot "src")
)

Compress-Archive -Path $runtimeFiles -DestinationPath $temporaryZip -CompressionLevel Optimal -Force

if (Test-Path -LiteralPath $resolvedOutput) {
    Remove-Item -LiteralPath $resolvedOutput -Force
}
Move-Item -LiteralPath $temporaryZip -Destination $resolvedOutput

Write-Output $resolvedOutput
