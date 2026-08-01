#!/usr/bin/env python3
"""Быстрая проверка статического сайта без сторонних зависимостей."""

from html.parser import HTMLParser
from json import load
from pathlib import Path
from re import finditer
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
errors: list[str] = []


class PageParser(HTMLParser):
    def __init__(self, path: Path) -> None:
        super().__init__()
        self.path = path
        self.ids: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        element_id = values.get("id")
        if element_id:
            if element_id in self.ids:
                errors.append(f"{self.path}: повторяющийся id={element_id!r}")
            self.ids.add(element_id)

        for attr in ("href", "src"):
            value = values.get(attr)
            if value:
                check_reference(self.path, value)


def check_reference(page: Path, value: str) -> None:
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or value.startswith(("#", "mailto:", "tel:", "tg:")):
        return
    raw_path = unquote(parsed.path)
    if not raw_path:
        return
    if raw_path.startswith("/downloads/") or raw_path.startswith("downloads/"):
        return  # сборки кладутся на сервер при релизе и не хранятся в git

    candidate = SITE / raw_path.lstrip("/") if raw_path.startswith("/") else page.parent / raw_path
    candidates = [candidate]
    if raw_path.endswith("/"):
        candidates.append(candidate / "index.html")
    elif not candidate.suffix:
        candidates.extend((candidate.with_suffix(".html"), candidate / "index.html"))
    if raw_path == "/":
        candidates.append(SITE / "index.html")
    if not any(path.exists() for path in candidates):
        errors.append(f"{page}: не найден локальный ресурс {value!r}")


for html in sorted(SITE.glob("*.html")):
    parser = PageParser(html)
    try:
        parser.feed(html.read_text(encoding="utf-8"))
        parser.close()
    except Exception as error:  # pragma: no cover - сообщение только для CI
        errors.append(f"{html}: HTML не разобран: {error}")

for script in sorted((SITE / "js").glob("*.js")):
    source = script.read_text(encoding="utf-8")
    for match in finditer(r'(?:from\s+|import\s*)["\'](\.[^"\']+)["\']', source):
        target = (script.parent / match.group(1)).resolve()
        if not target.exists():
            errors.append(f"{script}: не найден импорт {match.group(1)!r}")

try:
    with (SITE / "downloads.json").open(encoding="utf-8") as stream:
        load(stream)
except Exception as error:
    errors.append(f"site/downloads.json: некорректный JSON: {error}")

if errors:
    raise SystemExit("\n".join(errors))

print("Site references, HTML ids, JavaScript imports and downloads.json: OK")
