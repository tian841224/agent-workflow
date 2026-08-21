"""Path operations with no shell or locale-dependent string parsing."""

from __future__ import annotations

import os
from pathlib import Path


def resolved(path: os.PathLike[str] | str) -> Path:
    return Path(path).expanduser().resolve(strict=True)


def normalized(path: os.PathLike[str] | str) -> str:
    return str(Path(path).expanduser().resolve(strict=False)).rstrip("\\/").replace("\\", "/").casefold()


def is_within(path: os.PathLike[str] | str, parent: os.PathLike[str] | str) -> bool:
    try:
        Path(path).resolve(strict=False).relative_to(Path(parent).resolve(strict=False))
        return True
    except ValueError:
        return False
