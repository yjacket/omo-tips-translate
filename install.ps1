# Install omo-tips-translate:
#   irm https://raw.githubusercontent.com/yjacket/omo-tips-translate/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

if (-not (Get-Command omo -ErrorAction SilentlyContinue)) {
	Write-Host "omo is not on PATH. Install OMO first, then run this script again."
	return
}

& omo install git:github.com/yjacket/omo-tips-translate
if ($LASTEXITCODE -ne 0) {
	Write-Host "omo install failed (exit $LASTEXITCODE)."
	return
}
Write-Host "Type /reload in running omo sessions."
