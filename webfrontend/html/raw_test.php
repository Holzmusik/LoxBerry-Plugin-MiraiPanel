<?php
// Temporäres Diagnose-Skript (2026-08-19): testet, ob Apache/PHP bei einer
// großen Antwort in einem Rutsch schreibt, oder in mehreren kleineren
// Schreibvorgängen (die den in cover_proxy.php beobachteten "1 Segment,
// dann Pause"-Effekt erklären könnten) — ganz ohne GD/imagejpeg, um zu
// sehen ob das Verhalten allgemein an Apache/PHP liegt oder spezifisch an
// imagejpeg()s Art, Ausgaben zu schreiben. Größe per ?size= einstellbar,
// Default entspricht einem typischen Cover (48000 Bytes).
$size = isset($_GET['size']) ? max(1, (int) $_GET['size']) : 48000;
$data = str_repeat('A', $size);
header('Content-Type: application/octet-stream');
header('Content-Length: ' . strlen($data));
echo $data;
