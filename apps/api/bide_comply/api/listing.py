"""Lists the way the design shows them (Components board): quick views first, labelled filters with a count on each
option, a sentence saying exactly what is on screen, server-side search, sort and pagination.

Counts on each filter's options are computed with every *other* filter applied, so they say how many results
picking that option would give. Options that would give nothing are still listed (greyed in the UI), not hidden.
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

Row = dict[str, Any]


@dataclass
class Facet:
    key: str
    name: str
    field: Callable[[Row], Any]
    options: list[tuple[Any, str]]  # (value, label)
    hint: str = ""
    multi_value: bool = False  # the field returns a list (a row can match several options)


@dataclass
class View:
    key: str
    label: str
    test: Callable[[Row], bool]
    phrase: str = ""  # inserted before the noun: "urgent "
    suffix: str = ""  # appended: " due this week"


@dataclass
class ListResult:
    rows: list[Row]
    total: int
    page: int
    page_size: int
    views: list[dict] = field(default_factory=list)
    facets: list[dict] = field(default_factory=list)
    summary: str = ""
    any_filter: bool = False

    def dump(self, rows: list[Row] | None = None) -> dict:
        return {
            "rows": rows if rows is not None else self.rows,
            "total": self.total,
            "page": self.page,
            "page_size": self.page_size,
            "views": self.views,
            "facets": self.facets,
            "summary": self.summary,
            "any_filter": self.any_filter,
        }


def _matches(row: Row, fc: Facet, selected: list[str]) -> bool:
    if not selected:
        return True
    v = fc.field(row)
    vals = v if fc.multi_value else [v]
    return any(str(x) in selected for x in vals)


def run(
    rows: Iterable[Row],
    *,
    q: str | None,
    search: Callable[[Row], str],
    views: list[View],
    view: str | None,
    facets: list[Facet],
    selected: dict[str, list[str]],
    sort: Callable[[Row], Any] | None = None,
    reverse: bool = False,
    page: int = 1,
    page_size: int = 25,
    noun: tuple[str, str] = ("item", "items"),
    where: str = "",
    order_phrase: str = "",
) -> ListResult:
    rows = list(rows)
    needle = (q or "").strip().lower()
    match_q = (lambda r: needle in search(r).lower()) if len(needle) >= 2 else (lambda r: True)
    vw = next((v for v in views if v.key == view), views[0] if views else None)
    test_view = vw.test if vw else (lambda r: True)

    def passes(r: Row, except_key: str | None) -> bool:
        return all(fc.key == except_key or _matches(r, fc, selected.get(fc.key, [])) for fc in facets)

    out_facets = []
    for fc in facets:
        pool = [r for r in rows if match_q(r) and test_view(r) and passes(r, fc.key)]
        sel = selected.get(fc.key, [])
        opts = []
        for value, label in fc.options:
            cnt = sum(1 for r in pool if _matches(r, fc, [str(value)]))
            opts.append({"value": str(value), "label": label, "count": cnt, "checked": str(value) in sel})
        labels = [lbl for v, lbl in fc.options if str(v) in sel]
        shown = "Any" if not labels else labels[0] if len(labels) == 1 else f"{labels[0]} +{len(labels) - 1}"
        out_facets.append(
            {"key": fc.key, "name": fc.name, "hint": fc.hint, "value": shown, "options": opts, "active": bool(sel)}
        )

    filtered = [r for r in rows if match_q(r) and test_view(r) and passes(r, None)]
    if sort:
        filtered.sort(key=sort, reverse=reverse)
    out_views = [
        {
            "key": v.key,
            "label": v.label,
            "count": sum(1 for r in rows if match_q(r) and v.test(r)),
            "on": vw is not None and v.key == vw.key,
        }
        for v in views
    ]

    n = len(filtered)
    phrase = vw.phrase if vw else ""
    summary = f"Showing {n} {phrase}{noun[0] if n == 1 else noun[1]}{vw.suffix if vw else ''}"
    if where:
        summary += f" {where}"
    parts = []
    for fc in facets:
        sel = selected.get(fc.key, [])
        if sel:
            labels = [lbl for v, lbl in fc.options if str(v) in sel]
            parts.append(f"{fc.name.lower()} {' or '.join(labels)}")
    if parts:
        summary += ", where " + ", and ".join(parts)
    if needle:
        summary += f", matching “{q.strip()}”"
    summary += f". {order_phrase}" if n and order_phrase else "."
    any_filter = bool(parts) or bool(needle) or (vw is not None and views and vw.key != views[0].key)

    page_size = max(1, min(page_size, 100))
    page = max(1, page)
    start = (page - 1) * page_size
    return ListResult(
        filtered[start : start + page_size],
        n,
        page,
        page_size,
        out_views,
        out_facets,
        summary.strip(),
        bool(any_filter),
    )


def multi(values: list[str] | None) -> list[str]:
    """Filters come as repeated query params or comma-separated: ?prop=a&prop=b or ?prop=a,b."""
    out: list[str] = []
    for v in values or []:
        out.extend(x for x in v.split(",") if x)
    return out
