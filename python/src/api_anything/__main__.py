"""`python -m api_anything gen <site>`: write a typed module for a site's read operations."""

import sys
from typing import List, Optional

from . import __version__


def main(argv: Optional[List[str]] = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args[:1] == ["gen"]:
        from .codegen import main as gen

        return gen(args[1:])
    if args[:1] in (["--version"], ["-V"]):
        print(__version__)
        return 0
    print(
        "usage: python -m api_anything gen <site> [-o file.py] [--url URL]\n       python -m api_anything --version",
        file=sys.stderr,
    )
    return 0 if args[:1] in (["-h"], ["--help"]) else 2


if __name__ == "__main__":
    sys.exit(main())
