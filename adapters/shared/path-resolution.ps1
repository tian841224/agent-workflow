function Get-WorkflowCanonicalRoot {
    param([string]$Root = (Join-Path $env:USERPROFILE '.agents'))
    return (Join-Path $Root 'core')
}
