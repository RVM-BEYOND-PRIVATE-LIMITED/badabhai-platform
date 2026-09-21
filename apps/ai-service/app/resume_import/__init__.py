"""Résumé import (ADR-0041) — the deterministic half.

This package holds everything that turns an uploaded FILE into TEXT. It contains no LLM
call, no prompt and no network I/O of any kind; `extract.py` is a pure function from
bytes to lines. The model only ever sees what comes out of here, which is what makes
RI-3's "cite a line index or return null" contract checkable at all.

DELIBERATELY RE-EXPORTS NOTHING. The obvious `from .extract import extract` would bind
the FUNCTION to the package attribute `extract`, shadowing the SUBMODULE of the same
name — after which `import app.resume_import.extract as m` silently hands you the
function instead of the module, and the failure surfaces as a baffling
`'function' object has no attribute ...` several files away. Import from the module
path directly:

    from .resume_import.extract import ExtractionResult, extract
"""
