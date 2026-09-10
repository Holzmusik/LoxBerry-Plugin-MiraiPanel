<?php
// MiraiBridge – Cover-Bild Proxy
// Leitet JPEG durch, wandelt PNG/WebP via php-gd in JPEG um.
// Liegt in html/ (nicht htmlauth/) → kein Login nötig (Zugriff vom ESP).

// Timing-Diagnose (temporär, 2026-08-19): externer CDN-Fetch vs. GD-Resize
// vs. Gesamtzeit lassen sich vom ESP32 aus nicht unterscheiden — beide
// landen als X-Debug-*-Response-Header UND im PHP-error_log, damit sich
// klären lässt, wo die 1-4s bei neuen Cover-URLs tatsächlich hingehen.
$t_start = microtime(true);

$url = isset($_GET['url']) ? trim($_GET['url']) : '';
if ($url === '') {
    http_response_code(400);
    exit;
}
$target_w = isset($_GET['w']) ? max(1, (int)$_GET['w']) : 0;
$target_h = isset($_GET['h']) ? max(1, (int)$_GET['h']) : 0;

$scheme = parse_url($url, PHP_URL_SCHEME);
if (!in_array($scheme, ['http', 'https'], true)) {
    http_response_code(400);
    exit;
}

// ── Output-Cache: fertig resized+re-encodetes JPEG, pro URL+Zielgröße ──
// Cover-URLs (TuneIn etc.) tragen i.d.R. einen Cache-Buster-Query-Parameter
// (z.B. "?t=160097") — ändert sich das Motiv, ändert sich die URL. Der
// Cache-Key ist damit implizit content-adressiert und kann lange (statt nur
// 30s wie vorher der reine Quell-Cache) gültig bleiben. Zusätzlich werden
// jetzt ETag/Last-Modified gesendet: ESPHomes online_image-Komponente
// unterstützt If-None-Match/If-Modified-Since nativ (siehe
// esphome/components/online_image/online_image.cpp) — vorher hat dieser
// Proxy nie welche geschickt, jede Anfrage hat also immer voll neu resized
// und encodiert, obwohl derselbe Sender oft mehrfach pro Session geladen
// wird. Spart bei Cache-Hit sowohl das GD-Resize hier als auch den
// Full-Download + JPEG-Decode auf dem ESP32 (nur noch ein 304 statt Body).
$out_cache_dir = sys_get_temp_dir() . '/miraibridge_cover_out';
$out_cache_key = md5($url . '|' . $target_w . 'x' . $target_h);
$out_cache_file = $out_cache_dir . '/' . $out_cache_key . '.jpg';
$out_cache_max_age = 30 * 86400; // reine Aufräum-Frist, keine Gültigkeits-TTL

if (is_file($out_cache_file)) {
    $mtime = filemtime($out_cache_file);
    $etag = '"' . $out_cache_key . '-' . $mtime . '"';
    $last_modified = gmdate('D, d M Y H:i:s', $mtime) . ' GMT';

    $if_none_match = $_SERVER['HTTP_IF_NONE_MATCH'] ?? '';
    $if_modified_since = $_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '';
    $not_modified = ($if_none_match === $etag)
        || ($if_modified_since !== '' && @strtotime($if_modified_since) >= $mtime);

    header('ETag: ' . $etag);
    header('Last-Modified: ' . $last_modified);
    if ($not_modified) {
        http_response_code(304);
        exit;
    }

    header('Content-Type: image/jpeg');
    header('Content-Length: ' . filesize($out_cache_file));
    header('Cache-Control: public, max-age=86400');
    header('X-Debug-Src: output-cache');
    header('X-Debug-Total-Ms: ' . (int) round((microtime(true) - $t_start) * 1000));
    readfile($out_cache_file);
    exit;
}

// Quell-Bytes kurz cachen: pro Titelwechsel fragt das Panel dieselbe
// externe URL zweimal ab (600x600 fürs Overlay, 140x140 fürs Klein-Cover).
// Ohne Cache holt jede Anfrage das Original erneut von der CDN — der
// zweite Request kostet dann nur noch Resize+Encode, keinen externen
// Roundtrip mehr. TTL kurz halten (Cover ändert sich nur bei Titelwechsel,
// aber soll auch nicht ewig hängen bleiben falls sich die URL mal ändert
// ohne dass ein Request dazwischen kommt).
$cache_dir = sys_get_temp_dir() . '/miraibridge_cover_src';
$cache_file = $cache_dir . '/' . md5($url) . '.bin';
$cache_ttl = 30; // Sekunden

$data = false;
$src_from_cache = false;
if (is_file($cache_file) && (time() - filemtime($cache_file)) < $cache_ttl) {
    $data = @file_get_contents($cache_file);
    $src_from_cache = ($data !== false && strlen($data) >= 8);
}

$t_fetch_start = microtime(true);
$fetch_ms = 0;
if ($data === false || strlen($data) < 8) {
    $ctx = stream_context_create(['http' => [
        'timeout'       => 8,
        'user_agent'    => 'ESPHome-CoverProxy/1.0',
        'ignore_errors' => true,
    ]]);
    $data = @file_get_contents($url, false, $ctx);
    $fetch_ms = (int) round((microtime(true) - $t_fetch_start) * 1000);
    if ($data === false || strlen($data) < 8) {
        error_log(sprintf('cover_proxy: FETCH FEHLGESCHLAGEN nach %dms url=%s', $fetch_ms, $url));
        http_response_code(502);
        exit;
    }
    if (!is_dir($cache_dir)) @mkdir($cache_dir, 0755, true);
    @file_put_contents($cache_file, $data);

    // Beiläufige Bereinigung statt Cronjob: bei ~5% der Requests, die eh
    // schon einen externen Fetch machen, abgelaufene Cache-Dateien löschen
    // (Quell-Cache nach cache_ttl, Output-Cache nach out_cache_max_age).
    if (mt_rand(1, 20) === 1 && is_dir($cache_dir)) {
        foreach (glob($cache_dir . '/*.bin') ?: [] as $f) {
            if (time() - filemtime($f) > $cache_ttl) @unlink($f);
        }
        foreach (glob($out_cache_dir . '/*.jpg') ?: [] as $f) {
            if (time() - filemtime($f) > $out_cache_max_age) @unlink($f);
        }
    }
}

// Alle Formate (auch JPEG) via php-gd re-encodieren → garantiert Baseline-JPEG
// Progressive JPEGs (TuneIn CDN) würden sonst den ESP32-Decoder crashen
if (function_exists('imagecreatefromstring') && function_exists('imagejpeg')) {
    $img = @imagecreatefromstring($data);
    if ($img !== false) {
        // Transparenz für PNG/WebP: weißen Hintergrund unterlegen; optional skalieren
        $w = imagesx($img);
        $h = imagesy($img);
        $ow = ($target_w > 0) ? $target_w : $w;
        $oh = ($target_h > 0) ? $target_h : $h;
        $bg = imagecreatetruecolor($ow, $oh);
        imagefill($bg, 0, 0, imagecolorallocate($bg, 255, 255, 255));
        if ($ow !== $w || $oh !== $h) {
            imagecopyresampled($bg, $img, 0, 0, 0, 0, $ow, $oh, $w, $h);
        } else {
            imagecopy($bg, $img, 0, 0, 0, 0, $w, $h);
        }
        imagedestroy($img);

        $t_resize_done = microtime(true);

        // Content-Length senden: ESPHome online_image braucht known size
        // für JPEG-Dekodierung (resize download buffer). Chunked transfer → Deadlock.
        // Qualität 85→75: bei Cover-Thumbnail-Größen visuell kaum ein
        // Unterschied, aber spürbar kleinere Datei → schnellerer Transfer
        // und schnelleres Decodieren auf dem ESP32.
        ob_start();
        imagejpeg($bg, null, 75);
        $jpeg = ob_get_clean();
        imagedestroy($bg);

        // Output-Cache schreiben + darauf mtime fixieren, damit der ETag,
        // den wir jetzt ausliefern, exakt zu dem passt, den ein Cache-Hit
        // beim nächsten Request aus filemtime() ableiten würde.
        if (!is_dir($out_cache_dir)) @mkdir($out_cache_dir, 0755, true);
        @file_put_contents($out_cache_file, $jpeg);
        $mtime = time();
        @touch($out_cache_file, $mtime);

        $resize_ms = (int) round(($t_resize_done - $t_fetch_start) * 1000) - $fetch_ms;
        $encode_ms = (int) round((microtime(true) - $t_resize_done) * 1000);
        $total_ms = (int) round((microtime(true) - $t_start) * 1000);
        $src_label = $src_from_cache ? 'src-cache' : ($fetch_ms > 0 ? 'external-fetch' : 'unknown');

        header('Content-Type: image/jpeg');
        header('Content-Length: ' . strlen($jpeg));
        header('ETag: "' . $out_cache_key . '-' . $mtime . '"');
        header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
        header('Cache-Control: public, max-age=86400');
        header('X-Debug-Src: ' . $src_label);
        header('X-Debug-Fetch-Ms: ' . $fetch_ms);
        header('X-Debug-Resize-Ms: ' . max(0, $resize_ms));
        header('X-Debug-Encode-Ms: ' . $encode_ms);
        header('X-Debug-Total-Ms: ' . $total_ms);
        error_log(sprintf(
            'cover_proxy: total=%dms fetch=%dms resize=%dms encode=%dms src=%s size=%dB url=%s',
            $total_ms, $fetch_ms, max(0, $resize_ms), $encode_ms, $src_label, strlen($jpeg), $url
        ));
        echo $jpeg;
        exit;
    }
}

// Fallback: raw durchreichen (ESP schlägt fehl → on_error)
http_response_code(502);
