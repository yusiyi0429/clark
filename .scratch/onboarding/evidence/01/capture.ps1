param([Parameter(Mandatory=$true)][string]$Name, [string]$Session = 'onboarding01')
$browserCli = 'C:/Users/10021/AppData/Local/npm-cache/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser-win32-x64.exe'
$evidencePath = $PSScriptRoot
foreach ($size in @(@('desktop',1440,900), @('tablet',834,1194), @('phone',375,812))) {
  & $browserCli --session $Session set viewport $size[1] $size[2]
  & $browserCli --session $Session screenshot (Join-Path $evidencePath ($Name + '-' + $size[0] + '.png'))
  & $browserCli --session $Session eval 'JSON.stringify({url:location.pathname,viewport:[innerWidth,innerHeight],horizontalOverflow:document.documentElement.scrollWidth>innerWidth,overlay:!!document.querySelector("[data-nextjs-dialog]"),heading:document.querySelector("h1")?.textContent})' | Add-Content -LiteralPath (Join-Path $evidencePath 'browser-checks.log')
}
& $browserCli --session $Session set media light reduced-motion
& $browserCli --session $Session screenshot (Join-Path $evidencePath ($Name + '-reduced-motion.png'))
& $browserCli --session $Session set media light no-reduced-motion
