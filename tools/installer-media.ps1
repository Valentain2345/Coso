# Draws the NSIS installer branding panels (header 150x57, sidebar 164x314)
# in the app's identity: charcoal background, orange waveform bars, Coso wordmark.
Add-Type -AssemblyName System.Drawing

function Draw-Panel {
  param([int]$Width, [int]$Height, [string]$Path, [single]$BarScale, [hashtable]$Text)
  $bmp = New-Object System.Drawing.Bitmap $Width, $Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0x12,0x16,0x1a))
  $orange = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xd9,0x50,0x2b))
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xed,0xf0,0xeb))
  $grey = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0x8a,0x93,0x91))

  $g.FillRectangle($bg, 0, 0, $Width, $Height)

  $heights = @(0.35, 0.7, 1.0, 0.55, 0.3)
  $barWidth = [Math]::Max(3, [int]($Width * 0.045))
  $gap = $barWidth * 0.8
  $totalWidth = ($barWidth + $gap) * $heights.Count - $gap
  $maxBar = [int]($Height * $BarScale)
  $startX = [int](($Width - $totalWidth) / 2)
  $centerY = [int]$Text.waveCenter
  for ($i = 0; $i -lt $heights.Count; $i++) {
    $h = [Math]::Max(3, [int]($maxBar * $heights[$i]))
    $x = $startX + $i * ($barWidth + $gap)
    $y = $centerY - [int]($h / 2)
    $g.FillRectangle($orange, $x, $y, $barWidth, $h)
  }

  $font = New-Object System.Drawing.Font 'Segoe UI', $Text.size, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Point)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString($Text.title, $font, $white, (New-Object System.Drawing.RectangleF 0, $Text.titleY, $Width, ($Height - $Text.titleY)), $sf)
  if ($Text.subtitle) {
    $small = New-Object System.Drawing.Font 'Segoe UI', $Text.subSize, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Point)
    $g.DrawString($Text.subtitle, $small, $grey, (New-Object System.Drawing.RectangleF 8, $Text.subY, ($Width - 16), ($Height - $Text.subY)), $sf)
  }

  # NSIS MUI2 only accepts BMP for the header/sidebar panels.
  $bmpPath = [System.IO.Path]::ChangeExtension($Path, '.bmp')
  $bmp.Save($bmpPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Dispose()
  $g.Dispose()
  Write-Output "wrote $bmpPath"
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$icons = Join-Path (Split-Path -Parent $here) 'src-tauri\icons'

Draw-Panel -Width 150 -Height 57 -Path (Join-Path $icons 'installer-header.png') -BarScale 0.5 -Text @{
  waveCenter = 21; size = 10; title = 'Coso'; titleY = 36
}
Draw-Panel -Width 164 -Height 314 -Path (Join-Path $icons 'installer-sidebar.png') -BarScale 0.28 -Text @{
  waveCenter = 90; size = 14; title = 'Coso'; titleY = 130
  subtitle = "Lecture transcription,`non your device"; subSize = 8; subY = 160
}
