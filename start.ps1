$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot 'mind-elixir-core-5.15.1')
& npm.cmd run dev
