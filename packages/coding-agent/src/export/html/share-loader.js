    (function() {
      'use strict';

      // ============================================================
      // SHARE VIEWER BOOTSTRAP
      // ============================================================
      //
      // Served by the omp relay at /s/<id>; the AES-256-GCM key rides in the
      // URL fragment and never leaves the browser. Resolves the session JSON
      // and hands it to template.js via `window.__OMP_SESSION_DATA__`:
      //   1. hex ids -> secret GitHub gist holding base64(sealed blob)
      //   2. anything else -> relay blob store at /s/<id>/raw
      // Sealed layout: [12B IV][AES-256-GCM(gzip(session JSON))].

      var GIST_ID_RE = /^[0-9a-f]{20,64}$/;
      var SHARE_PATH_RE = /\/s\/([A-Za-z0-9_-]{10,64})\/?$/;

      function decodeBase64(text) {
        var binary = atob(text);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }

      function decodeBase64Url(text) {
        var b64 = text.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return decodeBase64(b64);
      }

      async function fetchGistBlob(id) {
        var res = await fetch('https://api.github.com/gists/' + id, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (res.status === 404) throw new Error('此分享已不存在(gist 可能已被删除)。');
        if (!res.ok) throw new Error('Gist 获取失败:HTTP ' + res.status);
        var gist = await res.json();
        var files = Object.values(gist.files || {});
        var file = files.find(function(f) { return /\.ompshare\.txt$/.test(f.filename); }) || files[0];
        if (!file) throw new Error('Gist 中没有文件。');
        var text = file.content;
        if (!text || file.truncated) {
          var raw = await fetch(file.raw_url);
          if (!raw.ok) throw new Error('Gist 原始内容获取失败:HTTP ' + raw.status);
          text = await raw.text();
        }
        return decodeBase64(text.replace(/\s+/g, ''));
      }

      async function fetchServerBlob(id) {
        var res = await fetch('/s/' + id + '/raw');
        if (res.status === 404 || res.status === 410) {
          throw new Error('此分享已不存在(可能已过期或已删除)。');
        }
        if (!res.ok) throw new Error('分享获取失败:HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      }

      async function load() {
        var match = SHARE_PATH_RE.exec(location.pathname);
        if (!match) throw new Error('分享 URL 无效;应为 /s/<id>。');
        var keyText = location.hash.replace(/^#/, '');
        if (!keyText) throw new Error('分享链接缺少 #key 片段;请粘贴完整链接。');
        var keyBytes;
        try {
          keyBytes = decodeBase64Url(keyText);
        } catch (_err) {
          throw new Error('分享密钥不是有效的 base64url。');
        }
        if (keyBytes.length !== 32) throw new Error('分享密钥必须解码为 32 字节。');

        var id = match[1];
        var sealed = await (GIST_ID_RE.test(id) ? fetchGistBlob(id) : fetchServerBlob(id));
        if (sealed.length <= 12) throw new Error('密封的会话数据不完整。');

        var key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
        var plain;
        try {
          plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: sealed.subarray(0, 12) },
            key,
            sealed.subarray(12)
          );
        } catch (_err) {
          throw new Error('解密失败:#key 错误或已损坏。');
        }

        var data = await new Response(
          new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))
        ).json();
        if (data && data.header && data.header.title) {
          document.title = data.header.title + ' — omp 会话';
        }
        return data;
      }

      var pending = load();
      // template.js surfaces the failure in-page; swallow the duplicate here
      // so the console does not report an unhandled rejection.
      pending.catch(function() {});
      window.__OMP_SESSION_DATA__ = pending;
    })();
