"""Load the presentation assets embedded by visualize.py.

Keep PAGE, CSS and JS as strings so the renderer emits a standalone page.
Highlight.js and its theme load from the template's pinned CDN; inspection
remains usable as plain text when those assets are unavailable.
"""

from pathlib import Path


def _read(name: str) -> str:
  return Path(__file__).with_name(name).read_text(encoding="utf-8")


PAGE = _read("visualize_ui.html")
CSS = _read("visualize_theme.css") + _read("visualize_ui.css")
JS = _read("visualize_ui.js")
