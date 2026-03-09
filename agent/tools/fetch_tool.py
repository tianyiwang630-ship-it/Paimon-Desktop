"""
Fetch Tool -  URL 
"""

import re
import json
import html
import hashlib
from pathlib import Path
from typing import Dict, Any
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from urllib.parse import urlparse

from agent.tools.base_tool import BaseTool


class FetchTool(BaseTool):
    """URL  - """

    @property
    def name(self) -> str:
        return "fetch"

    PREVIEW_THRESHOLD = 15000  # conversation 

    DEFAULT_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }

    def get_tool_definition(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "fetch",
                "description": (
                    " URL  HTML/XML "
                    "/ API "
                    " max_length max_length 3000"
                    " JavaScript  SPA  Yahoo FinanceGoogle Finance "
                    " API "
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": " URL"
                        },
                        "max_length": {
                            "type": "integer",
                            "description": " 5000 8000",
                            "default": 5000
                        }
                    },
                    "required": ["url"]
                }
            }
        }

    def execute(self, **kwargs) -> str:
        """ URL """
        url = kwargs.get('url', '')
        max_length = kwargs.get('max_length', 5000)
        #  URL
        try:
            parsed = urlparse(url)
            if not parsed.scheme:
                url = "https://" + url
                parsed = urlparse(url)
            if parsed.scheme not in ("http", "https"):
                return f":  '{parsed.scheme}' http/https"
            if not parsed.netloc:
                return ":  URL"
        except Exception as e:
            return f": URL : {e}"

        # 
        try:
            req = Request(url, headers=self.DEFAULT_HEADERS)
            with urlopen(req, timeout=15) as response:
                content_type = response.headers.get("Content-Type", "")
                charset = self._extract_charset(content_type)
                raw = response.read(500_000)  #  500KB
                body = self._decode(raw, charset)

        except HTTPError as e:
            return f"HTTP  {e.code}: {e.reason}\nURL: {url}"
        except URLError as e:
            return f": {e.reason}\nURL: {url}"
        except TimeoutError:
            return f"15\nURL: {url}"
        except Exception as e:
            return f": {type(e).__name__}: {e}\nURL: {url}"

        # 
        if "application/json" in content_type:
            text = self._format_json_text(body)
        else:
            if "xml" in content_type:
                body = self._clean_xml(body)
            text = self._html_to_text(body)
            text = self._clean_text(text)

        #  / 
        return self._finalize_output(text, url, max_length)

    # ========================================
    #  / 
    # ========================================

    def _finalize_output(self, text: str, url: str, max_length: int) -> str:
        """ max_length """
        if not text.strip():
            return f"\nURL: {url}"

        if len(text) > self.PREVIEW_THRESHOLD:
            filename = hashlib.md5(url.encode()).hexdigest()[:8] + ".txt"
            temp_dir = getattr(self, 'temp_dir', None) or Path("temp/fetch_results")
            fetch_dir = temp_dir / "fetch_results"
            fetch_dir.mkdir(parents=True, exist_ok=True)
            filepath = fetch_dir / filename
            filepath.write_text(f"URL: {url}\n\n{text}", encoding="utf-8")

            preview = text[:3000]
            return (
                f"URL: {url}\n\n{preview}\n\n"
                f"... ( {len(text)}  {filepath})\n"
                f" read  offset/limit "
            )

        if len(text) > max_length:
            text = text[:max_length] + f"\n\n... ( {len(text)} )"

        return f"URL: {url}\n\n{text}"

    # ========================================
    # 
    # ========================================

    def _extract_charset(self, content_type: str) -> str:
        match = re.search(r'charset=([^\s;]+)', content_type, re.IGNORECASE)
        return match.group(1).strip('"\'') if match else "utf-8"

    def _decode(self, raw: bytes, charset: str) -> str:
        for enc in [charset, "utf-8", "gbk", "gb2312", "latin-1"]:
            try:
                return raw.decode(enc)
            except (UnicodeDecodeError, LookupError):
                continue
        return raw.decode("utf-8", errors="replace")

    # ========================================
    # HTML -> 
    # ========================================

    def _html_to_text(self, raw_html: str) -> str:
        """HTML  bs4"""
        try:
            from bs4 import BeautifulSoup
            return self._bs4_extract(raw_html)
        except ImportError:
            return self._regex_extract(raw_html)

    def _bs4_extract(self, raw_html: str) -> str:
        """ BeautifulSoup """
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(raw_html, "html.parser")

        # 1. 
        for tag in soup([
            "script", "style", "noscript", "iframe", "svg",
            "link", "meta", "template",     # head 
            "nav", "footer", "header",      # //
            "aside",                         # 
            "form", "button", "input", "select", "textarea",  # 
            "img", "video", "audio", "source", "picture",      # 
            "object", "embed", "canvas",     # 
        ]):
            tag.decompose()

        # 2. 
        for tag in soup.find_all(style=re.compile(r'display\s*:\s*none', re.I)):
            tag.decompose()
        for tag in soup.find_all(attrs={"hidden": True}):
            tag.decompose()
        for tag in soup.find_all(attrs={"aria-hidden": "true"}):
            tag.decompose()

        # 3.  JSON-LD / 
        for tag in soup.find_all("script", type=re.compile(r'application/(ld\+json|json)', re.I)):
            tag.decompose()

        # 4. 
        main = (
            soup.find("main")
            or soup.find("article")
            or soup.find(id=re.compile(r'^(content|main|article|post|entry)$', re.I))
            or soup.find(class_=re.compile(r'^(content|main|article|post|entry)[-_]?(body|text|content)?$', re.I))
            or soup.body
            or soup
        )

        # 5. 
        text = main.get_text(separator="\n", strip=True)

        return text

    def _regex_extract(self, raw_html: str) -> str:
        """ bs4 """
        text = raw_html

        # 
        text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL | re.I)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.I)
        text = re.sub(r'<noscript[^>]*>.*?</noscript>', '', text, flags=re.DOTALL | re.I)
        text = re.sub(r'<!--.*?-->', '', text, flags=re.DOTALL)

        # XML  <?xml ... ?> / CDATA
        text = re.sub(r'<\?[^>]+\?>', '', text)
        text = re.sub(r'<!\[CDATA\[.*?\]\]>', '', text, flags=re.DOTALL)

        #  -> 
        text = re.sub(r'<(?:br|p|div|h[1-6]|li|tr|blockquote|section|article)[^>]*/?>', '\n', text, flags=re.I)

        # 
        text = re.sub(r'<[^>]+>', '', text)

        #  HTML 
        text = html.unescape(text)

        return text

    # ========================================
    # XML 
    # ========================================

    def _clean_xml(self, raw_xml: str) -> str:
        """ XML RSSSOAP """
        #  XML 
        text = re.sub(r'<\?xml[^>]*\?>', '', raw_xml)
        #  CDATA
        text = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', text, flags=re.DOTALL)
        #  <ns:tag> -> <tag>
        text = re.sub(r'<(/?)[\w-]+:', r'<\1', text)
        return text

    # ========================================
    # 
    # ========================================

    def _clean_text(self, text: str) -> str:
        """"""
        # HTML 
        text = html.unescape(text)

        # 
        text = re.sub(r'[\u200b\u200c\u200d\u200e\u200f\ufeff\u00ad]', '', text)
        text = re.sub(r'[^\S\n]+', ' ', text)  # 

        # 
        lines = text.split('\n')
        cleaned = []
        for line in lines:
            line = line.strip()
            if not line:
                cleaned.append('')
                continue

            # 
            #  "|||", "---", ">>>"
            if len(line) <= 3 and not any(c.isalnum() for c in line):
                continue
            # Cookie / 
            if re.match(r'^(cookie|privacy|accept|dismiss|close|skip|loading)', line, re.I):
                continue
            #  ID 
            if re.match(r'^\d+$', line) and len(line) > 6:
                continue

            cleaned.append(line)

        text = '\n'.join(cleaned)

        # 
        text = re.sub(r'\n{3,}', '\n\n', text)

        # /
        #  5+  1-3 
        lines = text.split('\n')
        result = []
        short_streak = []
        for line in lines:
            if 0 < len(line) <= 4 and not re.search(r'\d', line):
                short_streak.append(line)
            else:
                if len(short_streak) >= 5:
                    # 
                    result.append(' | '.join(short_streak))
                else:
                    result.extend(short_streak)
                short_streak = []
                result.append(line)
        # 
        if len(short_streak) >= 5:
            result.append(' | '.join(short_streak))
        else:
            result.extend(short_streak)

        return '\n'.join(result).strip()

    # ========================================
    # JSON 
    # ========================================

    def _format_json_text(self, body: str) -> str:
        """JSON  _finalize_output """
        try:
            data = json.loads(body)
            return json.dumps(data, ensure_ascii=False, indent=2)
        except json.JSONDecodeError:
            return body


# ============================================
# 
# ============================================

if __name__ == "__main__":
    print("=" * 70)
    print("Fetch Tool Test")
    print("=" * 70)

    tool = FetchTool()

    #  1: 
    print("\nTest 1: Fetch baidu.com\n")
    result = tool.execute(url="https://www.baidu.com", max_length=500)
    print(result[:500])

    #  2:  JSON API
    print("\n\nTest 2: Fetch JSON API\n")
    result = tool.execute(url="https://httpbin.org/json", max_length=1000)
    print(result[:500])

    #  3:  URL
    print("\n\nTest 3: Invalid URL\n")
    result = tool.execute(url="not-a-url")
    print(result)
