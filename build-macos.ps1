param(
  [ValidateSet("all", "arm64", "x64")]
  [string]$Architecture = "all"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DenoCompiler = Join-Path $ProjectRoot "deno.exe"
if (-not (Test-Path -LiteralPath $DenoCompiler)) { $DenoCompiler = "deno" }
$SourceFile = Join-Path $ProjectRoot "downloader.ts"
$AppVersion = [regex]::Match((Get-Content -LiteralPath $SourceFile -Raw), 'const APP_VERSION = "([^"]+)"').Groups[1].Value
$BuildArchitectures = if ($Architecture -eq "all") { @("arm64", "x64") } else { @($Architecture) }

$SignToolVersion = "0.29.0"
$SignToolDir = Join-Path $ProjectRoot "build\tools\apple-codesign-$SignToolVersion"
$SignToolName = "apple-codesign-$SignToolVersion-x86_64-pc-windows-msvc"
$SignToolExe = Join-Path $SignToolDir "$SignToolName\rcodesign.exe"
if (-not (Test-Path -LiteralPath $SignToolExe)) {
  New-Item -ItemType Directory -Force -Path $SignToolDir | Out-Null
  $SignToolZip = Join-Path $SignToolDir "apple-codesign.zip"
  if (-not (Test-Path -LiteralPath $SignToolZip)) {
    Invoke-WebRequest -Uri "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/$SignToolVersion/$SignToolName.zip" -OutFile $SignToolZip
  }
  $SignToolHash = (Get-FileHash -LiteralPath $SignToolZip -Algorithm SHA256).Hash
  if ($SignToolHash -ne "54BB500E2DA7A8DE02FCAE0F331D1CAC6E6D7173B4281042FF9C528BA3159AAA") {
    throw "The macOS signing tool checksum does not match."
  }
  Expand-Archive -LiteralPath $SignToolZip -DestinationPath $SignToolDir -Force
}

foreach ($MacArchitecture in $BuildArchitectures) {
  $MacTarget = if ($MacArchitecture -eq "arm64") { "aarch64-apple-darwin" } else { "x86_64-apple-darwin" }
  $MacBuildDir = Join-Path $ProjectRoot "build\macos-$MacArchitecture"
  $MacBinary = Join-Path $MacBuildDir "Svid"
  $MacArchive = Join-Path $ProjectRoot "dist\Svid-macOS-$MacArchitecture.zip"
  New-Item -ItemType Directory -Force -Path $MacBuildDir | Out-Null

  & $DenoCompiler compile --allow-all --target $MacTarget --app-name "Svid" `
    --include (Join-Path $ProjectRoot "live_capture.py") --output $MacBinary $SourceFile
  if ($LASTEXITCODE -ne 0) { throw "macOS $MacArchitecture compilation failed." }

  python (Join-Path $ProjectRoot "macos\package_app.py") --binary $MacBinary `
    --output $MacArchive --version $AppVersion --arch $MacArchitecture --rcodesign $SignToolExe
  if ($LASTEXITCODE -ne 0) { throw "macOS $MacArchitecture packaging failed." }
}

Write-Host "macOS preview packages are in dist. Test on a Mac before distributing them."
