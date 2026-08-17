<#
.SYNOPSIS
  Push the current feature branch to origin, merge it into main, push main,
  then delete the branch locally and on origin.

.USAGE
  From the repo root while on a feature branch:
    .\scripts\ship-branch.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Safety checks -----------------------------------------------------------

$branch = git branch --show-current
if (-not $branch) {
    Write-Error "Could not determine current branch (detached HEAD?)"
    exit 1
}
if ($branch -eq "main") {
    Write-Error "Already on main -- nothing to ship."
    exit 1
}

$status = git status --porcelain
if ($status) {
    Write-Error "Working tree is not clean. Commit or stash your changes first."
    exit 1
}

Write-Host ""
Write-Host "  Branch : $branch"
Write-Host "  Target : main"
Write-Host ""
$confirm = Read-Host "Ship '$branch' -> main? [y/N]"
if ($confirm -notmatch '^[Yy]$') {
    Write-Host "Aborted."
    exit 0
}

# --- Steps -------------------------------------------------------------------

function Run([string]$desc, [scriptblock]$cmd) {
    Write-Host "`n==> $desc"
    & $cmd
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Step failed: $desc"
        exit $LASTEXITCODE
    }
}

Run "Push '$branch' to origin" {
    git push origin $branch
}

Run "Switch to main" {
    git checkout main
}

Run "Pull main (fast-forward only)" {
    git pull --ff-only origin main
}

Run "Merge '$branch' into main (no-ff)" {
    git merge --no-ff $branch -m "Merge branch '$branch'"
}

Run "Push main to origin" {
    git push origin main
}

Run "Delete local branch '$branch'" {
    git branch -d $branch
}

Run "Delete remote branch '$branch'" {
    git push origin --delete $branch
}

Write-Host "`nDone. main is now at $(git rev-parse --short HEAD)."
