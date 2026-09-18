<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';

/**
 * 极简 SMTP 客户端 + 邮件模板 (原生实现, 无第三方依赖)。
 * 支持: smtps(465 直连 TLS) / STARTTLS(587) / 明文, AUTH LOGIN。
 * 邮件发送 multipart/alternative (HTML 模板 + 纯文本回退), 兼容 QQ/163 等客户端。
 */

const MAIL_BRAND = '零一·无限画布';
const MAIL_BRAND_EN = 'INFINITE CANVAS';

function send_verification_code(string $to, string $code): void
{
    [$html, $plain] = email_verification_template($code);
    send_mail($to, "【" . MAIL_BRAND . "】注册验证码：{$code}", $plain, $html);
}

function send_test_mail(string $to): void
{
    [$html, $plain] = email_test_template();
    send_mail($to, "【" . MAIL_BRAND . "】SMTP 配置测试成功", $plain, $html);
}

/** 通用发信。$html 提供时发送 multipart/alternative, 否则纯文本。配置缺失或失败直接 fail。 */
function send_mail(string $to, string $subject, string $plain, string $html = ''): void
{
    $host = (string) get_setting('smtp_host', '');
    if ($host === '') {
        fail('SMTP 服务未配置，请联系管理员在后台填写', 500);
    }
    $port = (int) get_setting('smtp_port', '465');
    $secure = (string) get_setting('smtp_secure', 'ssl');
    $username = (string) get_setting('smtp_username', '');
    $password = (string) get_setting('smtp_password', '');
    $from = (string) (get_setting('smtp_from', '') ?: $username);
    $fromName = (string) get_setting('smtp_from_name', MAIL_BRAND);
    if ($from === '') {
        fail('SMTP 发件人未配置', 500);
    }

    $messageId = '<' . bin2hex(random_bytes(16)) . '@' . (substr(strrchr($from, '@'), 1) ?: 'localhost') . '>';
    $headers = [
        'From: =?UTF-8?B?' . base64_encode($fromName) . '?= <' . $from . '>',
        'To: <' . $to . '>',
        'Subject: =?UTF-8?B?' . base64_encode($subject) . '?=',
        'Message-ID: ' . $messageId,
        'MIME-Version: 1.0',
        'Date: ' . date('r'),
        'X-Mailer: infinite-canvas',
    ];

    if ($html !== '') {
        // multipart/alternative: 文本客户端读纯文本, 常规客户端读 HTML
        $boundary = '=_ic_' . bin2hex(random_bytes(12));
        $headers[] = 'Content-Type: multipart/alternative; boundary="' . $boundary . '"';
        $body = "--{$boundary}\r\n"
            . "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
            . chunk_split(base64_encode($plain))
            . "--{$boundary}\r\n"
            . "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
            . chunk_split(base64_encode($html))
            . "--{$boundary}--\r\n";
    } else {
        $headers[] = 'Content-Type: text/plain; charset=UTF-8';
        $headers[] = 'Content-Transfer-Encoding: base64';
        $body = chunk_split(base64_encode($plain));
    }

    try {
        $socket = smtp_connect($host, $port, $secure);
        $ehloHost = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
        smtp_command($socket, 'EHLO ' . $ehloHost, [250]);

        if ($secure === 'tls') {
            smtp_command($socket, 'STARTTLS', [220]);
            if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new RuntimeException('STARTTLS 升级失败');
            }
            smtp_command($socket, 'EHLO ' . $ehloHost, [250]);
        }

        if ($username !== '') {
            smtp_command($socket, 'AUTH LOGIN', [334]);
            smtp_command($socket, base64_encode($username), [334]);
            smtp_command($socket, base64_encode($password), [235]);
        }

        smtp_command($socket, 'MAIL FROM:<' . $from . '>', [250]);
        smtp_command($socket, 'RCPT TO:<' . $to . '>', [250, 251]);
        smtp_command($socket, 'DATA', [354]);

        $data = implode("\r\n", $headers) . "\r\n\r\n" . $body;
        // SMTP 数据段: 单独的 "." 行需要转义
        $data = preg_replace('/^\./m', '..', $data) ?? $data;
        fwrite($socket, $data . "\r\n.\r\n");
        smtp_expect($socket, [250]);
        smtp_command($socket, 'QUIT', [221]);
        fclose($socket);
    } catch (Throwable $e) {
        fail('邮件发送失败：' . $e->getMessage(), 502);
    }
}

/** 注册验证码模板: HTML(表格布局+内联样式, 邮件客户端兼容) + 纯文本回退。 @return array{0:string,1:string} */
function email_verification_template(string $code): array
{
    $digitCells = '';
    foreach (str_split($code) as $digit) {
        $digitCells .= '<td style="padding:0 4px;"><div style="width:38px;height:52px;line-height:52px;text-align:center;background:#1c1917;color:#ffffff;font-size:22px;font-weight:700;font-family:\'Courier New\',Consolas,monospace;border-radius:10px;">' . $digit . '</div></td>';
    }
    $html = '<!DOCTYPE html>
<html lang="zh-CN">
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:36px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e7e5e4;">
  <tr><td style="padding:26px 24px 0;">
    <span style="font-size:18px;font-weight:700;color:#1c1917;font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;">' . MAIL_BRAND . '</span>
    <span style="font-size:11px;color:#a8a29e;letter-spacing:2px;margin-left:10px;">' . MAIL_BRAND_EN . '</span>
  </td></tr>
  <tr><td style="padding:26px 24px 4px;">
    <div style="font-size:22px;font-weight:700;color:#1c1917;">注册验证码</div>
  </td></tr>
  <tr><td style="padding:0 24px;font-size:14px;color:#57534e;line-height:24px;">
    您好！您正在注册 <b style="color:#1c1917;">' . MAIL_BRAND . '</b>，请使用以下验证码完成注册：
  </td></tr>
  <tr><td align="center" style="padding:22px 24px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>' . $digitCells . '</tr></table>
  </td></tr>
  <tr><td style="padding:0 24px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;border:1px solid #e7e5e4;border-radius:10px;">
      <tr><td style="padding:14px 20px;font-size:13px;color:#78716c;line-height:24px;">
        · 验证码 <b style="color:#1c1917;">10 分钟</b>内有效，请尽快完成验证<br>
        · 为了账号安全，请勿将验证码透露给任何人<br>
        · 如非本人操作，请忽略本邮件
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 24px 28px;">
    <div style="border-top:1px solid #f0eeec;padding-top:18px;font-size:12px;color:#a8a29e;line-height:20px;">
      本邮件由系统自动发送，请勿直接回复。<br>© ' . MAIL_BRAND . ' · ' . date('Y') . '
    </div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>';
    $plain = "您的注册验证码是：{$code}\n\n"
        . "验证码 10 分钟内有效。为了账号安全，请勿将验证码透露给任何人。\n"
        . "如非本人操作，请忽略本邮件。\n\n"
        . MAIL_BRAND . ' · 系统邮件，请勿回复';
    return [$html, $plain];
}

/** SMTP 测试邮件模板。 @return array{0:string,1:string} */
function email_test_template(): array
{
    $html = '<!DOCTYPE html>
<html lang="zh-CN">
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:36px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e7e5e4;">
  <tr><td style="padding:26px 24px 0;">
    <span style="font-size:18px;font-weight:700;color:#1c1917;">' . MAIL_BRAND . '</span>
    <span style="font-size:11px;color:#a8a29e;letter-spacing:2px;margin-left:10px;">' . MAIL_BRAND_EN . '</span>
  </td></tr>
  <tr><td style="padding:26px 24px 4px;">
    <div style="font-size:22px;font-weight:700;color:#16a34a;">&#10003; SMTP 配置测试成功</div>
  </td></tr>
  <tr><td style="padding:0 24px;font-size:14px;color:#57534e;line-height:26px;">
    收到本邮件说明 SMTP 服务配置正确，<b style="color:#1c1917;">用户注册验证码</b>将可以正常发送。<br>
    测试时间：' . date('Y-m-d H:i:s') . '
  </td></tr>
  <tr><td style="padding:0 24px 28px;">
    <div style="border-top:1px solid #f0eeec;padding-top:18px;font-size:12px;color:#a8a29e;line-height:20px;">
      本邮件由系统自动发送，请勿直接回复。<br>© ' . MAIL_BRAND . ' · ' . date('Y') . '
    </div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>';
    $plain = "SMTP 配置测试成功。\n\n收到本邮件说明 SMTP 服务配置正确，用户注册验证码将可以正常发送。\n测试时间：" . date('Y-m-d H:i:s');
    return [$html, $plain];
}

/** @return resource */
function smtp_connect(string $host, int $port, string $secure)
{
    // 服务器 DNS 的 AAAA 解析间歇性故障, 优先解析 A 记录直连 IPv4 (SNI/证书校验仍按域名);
    // 解析失败再退回域名直连。
    $connectHost = $host;
    $records = @dns_get_record($host, DNS_A);
    if (is_array($records) && $records && isset($records[0]['ip'])) {
        $connectHost = (string) $records[0]['ip'];
    }
    $remote = ($secure === 'ssl' ? 'ssl://' : 'tcp://') . $connectHost . ':' . $port;
    $context = stream_context_create(['ssl' => ['peer_name' => $host, 'verify_peer' => true, 'verify_peer_name' => true, 'SNI_enabled' => true]]);
    $socket = @stream_socket_client($remote, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $context);
    if ($socket === false) {
        throw new RuntimeException("连接失败 ({$errno}): {$errstr}");
    }
    stream_set_timeout($socket, 15);
    smtp_expect($socket, [220]);
    return $socket;
}

/** @param resource $socket */
function smtp_command($socket, string $command, array $expectCodes): string
{
    fwrite($socket, $command . "\r\n");
    return smtp_expect($socket, $expectCodes);
}

/** @param resource $socket */
function smtp_expect($socket, array $expectCodes): string
{
    $response = '';
    while (($line = fgets($socket, 1024)) !== false) {
        $response .= $line;
        // 多行应答格式: "250-..." 继续, "250 ..." 结束
        if (strlen($line) < 4 || $line[3] !== '-') {
            break;
        }
    }
    $code = (int) substr($response, 0, 3);
    if (!in_array($code, $expectCodes, true)) {
        throw new RuntimeException('SMTP 应答异常: ' . trim($response));
    }
    return $response;
}
