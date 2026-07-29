# DJ Music Downloader — DJ Supermercado
# Double-click the Desktop shortcut, paste a YouTube URL (video or playlist), get MP3s in Downloads\dj-crate.
# Files then need a Serato pass (BPM/key tags) before uploading to the "DJ Supermercado Crate" Drive folder.

$outDir = Join-Path $env:USERPROFILE "Downloads\dj-crate"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

Write-Host ""
Write-Host "  DJ SUPERMERCADO MUSIC DOWNLOADER" -ForegroundColor Yellow
Write-Host "  no hands, puro cerebro" -ForegroundColor DarkYellow
Write-Host ""
Write-Host "  MP3s land in: $outDir"
Write-Host "  Paste a YouTube URL (video or playlist). Press Enter on an empty line to quit."
Write-Host ""

while ($true) {
    $url = Read-Host "  URL"
    if ([string]::IsNullOrWhiteSpace($url)) { break }

    # Playlist pick-mode: list numbered titles first (works for a single
    # video too - it just comes back as one line), and only prompt when
    # there's actually more than one item to choose from. A single video
    # never sees a prompt and downloads exactly as before.
    $listOutput = & yt-dlp --flat-playlist --print "%(playlist_index)s|%(title)s" $url 2>$null
    $lines = @($listOutput | Where-Object { $_ -and $_.Trim() -ne "" })

    $playlistItems = $null
    if ($lines.Count -gt 1) {
        Write-Host ""
        Write-Host "  Playlist detected - $($lines.Count) item(s):" -ForegroundColor Cyan
        foreach ($line in $lines) {
            Write-Host "    $line"
        }
        Write-Host ""
        $selection = Read-Host "  Which? (all / numbers like 1,3,5-9)"
        if ([string]::IsNullOrWhiteSpace($selection)) { $selection = "all" }
        if ($selection.Trim().ToLower() -ne "all") {
            $playlistItems = $selection.Trim()
        }
    }

    $ytDlpArgs = @(
        "-x", "--audio-format", "mp3", "--audio-quality", "0", "--embed-metadata",
        "-o", "$outDir\%(artist,creator,uploader)s - %(title)s.%(ext)s"
    )
    if ($playlistItems) {
        $ytDlpArgs += @("--playlist-items", $playlistItems)
    }
    $ytDlpArgs += $url

    yt-dlp @ytDlpArgs

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Done. Next?" -ForegroundColor Green
    } else {
        Write-Host "  That one failed (exit $LASTEXITCODE) - check the URL and try again." -ForegroundColor Red
    }
    Write-Host ""
}

Write-Host "  Later! Remember: Serato pass for BPM/key, then up to the Drive crate." -ForegroundColor Yellow
Start-Sleep -Seconds 2
