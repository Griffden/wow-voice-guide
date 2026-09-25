# Build the in-game TGA sprite sheets from the supplied portraits and generated
# mouth poses. Frame zero stays the exact reference image before scaling; the
# other frames replace only a feathered area around each character's mouth.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$frameSize = 128
$portraits = @(
    @{
        name = 'peon'; original = 'talking-head-reference.png'; poses = 'talking-head-frames-concept.png'
        crop = [System.Drawing.Rectangle]::new(0, 0, 154, 158)
        mouthX = 80.0; mouthY = 94.0; radiusX = 41.0; radiusY = 28.0
        preview = 'talking-head-final-preview.png'
    },
    @{
        name = 'knight'; original = 'knight-reference.png'; poses = 'knight-frames-concept.png'
        crop = [System.Drawing.Rectangle]::new(175, 15, 260, 300)
        mouthX = 327.0; mouthY = 231.0; radiusX = 93.0; radiusY = 69.0
        preview = 'knight-final-preview.png'
    }
)

foreach ($portrait in $portraits) {
    $originalPath = Join-Path $root "concepts/$($portrait.original)"
    $posesPath = Join-Path $root "concepts/$($portrait.poses)"
    $previewPath = Join-Path $root "concepts/$($portrait.preview)"
    $texturePath = Join-Path $root "addon/WoWClaude/portrait-$($portrait.name).tga"

    $original = [System.Drawing.Bitmap]::new($originalPath)
    $poses = [System.Drawing.Bitmap]::new($posesPath)
    $sheet = [System.Drawing.Bitmap]::new($frameSize * 4, $frameSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $poseWidth = [int]($poses.Width / 2)
        $poseHeight = [int]($poses.Height / 2)
        for ($frame = 0; $frame -lt 4; $frame++) {
            $composite = [System.Drawing.Bitmap]::new($original.Width, $original.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $poseScaled = [System.Drawing.Bitmap]::new($original.Width, $original.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            try {
                $g = [System.Drawing.Graphics]::FromImage($composite)
                try { $g.DrawImage($original, 0, 0, $original.Width, $original.Height) } finally { $g.Dispose() }
                if ($frame -gt 0) {
                    $column = $frame % 2
                    $row = [int][Math]::Floor($frame / 2)
                    $sourceRect = [System.Drawing.Rectangle]::new($column * $poseWidth, $row * $poseHeight, $poseWidth, $poseHeight)
                    $destRect = [System.Drawing.Rectangle]::new(0, 0, $original.Width, $original.Height)
                    $g = [System.Drawing.Graphics]::FromImage($poseScaled)
                    try {
                        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                        $g.DrawImage($poses, $destRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
                    } finally { $g.Dispose() }

                    $left = [Math]::Max(0, [int]($portrait.mouthX - $portrait.radiusX))
                    $right = [Math]::Min($original.Width, [int]($portrait.mouthX + $portrait.radiusX + 1))
                    $top = [Math]::Max(0, [int]($portrait.mouthY - $portrait.radiusY))
                    $bottom = [Math]::Min($original.Height, [int]($portrait.mouthY + $portrait.radiusY + 1))
                    for ($y = $top; $y -lt $bottom; $y++) {
                        for ($x = $left; $x -lt $right; $x++) {
                            $distance = [Math]::Pow(($x - $portrait.mouthX) / $portrait.radiusX, 2) + [Math]::Pow(($y - $portrait.mouthY) / $portrait.radiusY, 2)
                            if ($distance -ge 1) { continue }
                            $alpha = [Math]::Min(1.0, (1.0 - $distance) / 0.25)
                            $base = $original.GetPixel($x, $y)
                            $mouth = $poseScaled.GetPixel($x, $y)
                            $r = [int][Math]::Round($base.R * (1 - $alpha) + $mouth.R * $alpha)
                            $green = [int][Math]::Round($base.G * (1 - $alpha) + $mouth.G * $alpha)
                            $b = [int][Math]::Round($base.B * (1 - $alpha) + $mouth.B * $alpha)
                            $composite.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $r, $green, $b))
                        }
                    }
                }
                $g = [System.Drawing.Graphics]::FromImage($sheet)
                try {
                    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $g.DrawImage($composite, [System.Drawing.Rectangle]::new($frame * $frameSize, 0, $frameSize, $frameSize), $portrait.crop, [System.Drawing.GraphicsUnit]::Pixel)
                } finally { $g.Dispose() }
            } finally {
                $poseScaled.Dispose()
                $composite.Dispose()
            }
        }

        $sheet.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $stream = [System.IO.File]::Open($texturePath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
        try {
            $writer = [System.IO.BinaryWriter]::new($stream)
            try {
                $writer.Write([byte[]]@(0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0))
                $writer.Write([uint16]$sheet.Width)
                $writer.Write([uint16]$sheet.Height)
                $writer.Write([byte]32)
                $writer.Write([byte]0x28) # top-left origin, 8-bit alpha
                for ($y = 0; $y -lt $sheet.Height; $y++) {
                    for ($x = 0; $x -lt $sheet.Width; $x++) {
                        $pixel = $sheet.GetPixel($x, $y)
                        $writer.Write([byte[]]@($pixel.B, $pixel.G, $pixel.R, 255))
                    }
                }
            } finally { $writer.Dispose() }
        } finally { $stream.Dispose() }
    } finally {
        $sheet.Dispose()
        $poses.Dispose()
        $original.Dispose()
    }
    Write-Output "Portrait texture: $texturePath"
}
