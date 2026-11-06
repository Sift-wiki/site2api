"""A typed module for one site's read operations, from the server's description of them.

The module declares types and leaves the sending to api-anything: each function calls `Client.call`, so the
tier ladder, healing and the classifier still apply. It depends only on the operations' names, arguments and
output hints, so the same description always gives the same bytes, and a healed site the same file.
Example values, notes and anything else a session could have put in the description are never read.
"""

from __future__ import annotations

import keyword
import re
from typing import Any, List, Mapping, Optional, Sequence, Set, Tuple

PARAM_TYPES = {"string": "str", "number": "float", "integer": "int", "boolean": "bool"}
FIELD_TYPES = {
    "string": "str",
    "number": "float",
    "integer": "int",
    "boolean": "bool",
    "array": "List[Any]",
    "object": "Dict[str, Any]",
}
# names the module itself defines or imports
RESERVED = {"SITE", "Client", "Result", "Any", "Dict", "List", "Literal", "Optional", "TypedDict", "annotations"}
FUNCTION_RESERVED = {"_call", "_client"}
PARAM_RESERVED = {"client", "options", "args"}


def _words(name: str) -> List[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    return [w for w in re.split(r"[^A-Za-z0-9]+", spaced) if w]


def snake(name: str) -> str:
    out = "_".join(w.lower() for w in _words(name)) or "op"
    if out[0].isdigit():
        out = "_" + out
    return out + "_" if keyword.iskeyword(out) else out


def pascal(name: str) -> str:
    out = "".join(w[:1].upper() + w[1:] for w in _words(name)) or "Op"
    return "_" + out if out[0].isdigit() else out


def _unique(name: str, taken: Set[str]) -> str:
    candidate = name if name not in taken else name + "_"
    n = 2
    while candidate in taken:
        candidate, n = f"{name}_{n}", n + 1
    taken.add(candidate)
    return candidate


def _text(value: Any) -> str:
    """Site text made safe for a docstring: one line, no control characters, no way to close the string."""
    s = re.sub(r"[\x00-\x1f\x7f\x85\u2028\u2029]+", " ", str(value))
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace("\\", "\\\\")
    # every quote followed by another is escaped, so no run of three can end the docstring
    return re.sub(r'"(?=")', '\\"', s)


def _literal(value: Any) -> str:
    if value is None or isinstance(value, (bool, int, float, str)):
        return repr(value)
    return repr(str(value))


def _wrap(text: str, indent: str, width: int = 100, hang: str = "") -> List[str]:
    lines: List[str] = []
    line = ""
    for word in text.split(" "):
        if line and len(indent) + len(line) + 1 + len(word) > width:
            lines.append(indent + line)
            line = word
            indent += hang
            hang = ""
        else:
            line = f"{line} {word}" if line else word
    if line:
        lines.append(indent + line)
    return lines


def _param_type(schema: Mapping[str, Any]) -> str:
    enum = schema.get("enum")
    # PEP 586: Literal takes str, int and bool values, not floats
    if isinstance(enum, list) and enum and all(isinstance(v, (str, int, bool)) for v in enum):
        return f"Literal[{', '.join(_literal(v) for v in enum)}]"
    return PARAM_TYPES.get(str(schema.get("type")), "Any")


def _param_doc(schema: Mapping[str, Any]) -> str:
    parts = []
    if schema.get("description"):
        parts.append(_text(schema["description"]).rstrip("."))
    enum = schema.get("enum")
    if isinstance(enum, list) and enum and not _param_type(schema).startswith("Literal"):
        parts.append("One of " + ", ".join(_text(_literal(v)) for v in enum))
    if schema.get("pattern") is not None:
        parts.append(f"Pattern: {_text(schema['pattern'])}")
    if schema.get("minimum") is not None:
        parts.append(f"Minimum {_text(_literal(schema['minimum']))}")
    if schema.get("maximum") is not None:
        parts.append(f"Maximum {_text(_literal(schema['maximum']))}")
    if "default" in schema:
        parts.append(f"Default {_text(_literal(schema['default']))}")
    return ". ".join(parts) + "." if parts else ""


def _data_type(op: Mapping[str, Any], typed_name: str) -> Tuple[str, List[str]]:
    """The data's annotation, and the TypedDict that declares it (empty when the hints are too thin)."""
    output = op.get("output") or {}
    cardinality = output.get("cardinality")
    fields = output.get("fields") or {}
    if cardinality not in ("list", "one") or not isinstance(fields, dict) or not fields:
        return ("List[Any]" if cardinality == "list" else "Any"), []
    entries = [(str(k), FIELD_TYPES.get(str((v or {}).get("type")), "Any")) for k, v in fields.items()]
    if all(k.isidentifier() and k.isascii() and not keyword.iskeyword(k) for k, _ in entries):
        lines = [f"class {typed_name}(TypedDict, total=False):"]
        lines += [f"    {k}: {t}" for k, t in entries]
    else:
        lines = [f"{typed_name} = TypedDict("]
        lines.append(f"    {typed_name!r},")
        lines.append("    {")
        lines += [f"        {k!r}: {t}," for k, t in entries]
        lines.append("    },")
        lines.append("    total=False,")
        lines.append(")")
    return (f"List[{typed_name}]" if cardinality == "list" else typed_name), lines


def generate(description: Mapping[str, Any], site: Optional[str] = None) -> str:
    """The module's source for a `GET /v1/sites/{site}` answer (MCP `list_operations`)."""
    site_name = str(site or description.get("site") or "")
    if not site_name:
        raise ValueError("the description names no site")
    ops = [o for o in description.get("operations") or [] if isinstance(o, Mapping) and o.get("name")]
    reads = sorted((o for o in ops if not o.get("write")), key=lambda o: str(o["name"]))
    writes = [o for o in ops if o.get("write")]

    taken_functions = set(RESERVED) | FUNCTION_RESERVED
    taken_types = set(RESERVED)
    blocks: List[List[str]] = []
    used: Set[str] = {"Any", "Dict", "Optional"}
    for op in reads:
        op_name = str(op["name"])
        fn = _unique(snake(op_name), taken_functions)
        cardinality = (op.get("output") or {}).get("cardinality")
        typed = _unique(pascal(op_name) + ("Item" if cardinality == "list" else "Data"), taken_types)
        data, typed_lines = _data_type(op, typed)
        if typed_lines:
            used.add("TypedDict")
            blocks.append(typed_lines)
        schema = op.get("inputSchema") or {}
        properties = schema.get("properties") or {}
        required = set(schema.get("required") or [])
        taken_params = set(PARAM_RESERVED)
        params: List[Tuple[str, str, Mapping[str, Any], bool]] = []
        for key, prop in properties.items():
            py = _unique(snake(str(key)), taken_params)
            params.append((py, str(key), prop if isinstance(prop, Mapping) else {}, key in required))

        lines = [f"def {fn}(", "    *,"]
        for py, _key, prop, req in params:
            t = _param_type(prop)
            if t.startswith("Literal"):
                used.add("Literal")
            lines.append(f"    {py}: {t}," if req else f"    {py}: Optional[{t}] = None,")
        lines += ["    client: Optional[Client] = None,", "    **options: Any,", f") -> Result[{data}]:"]
        if "List[" in data or any("List[" in line for line in typed_lines):
            used.add("List")

        doc = _wrap('"""' + _text(op.get("description") or f"{op_name} on {site_name}."), "    ") + [""]
        if fn != op_name:
            doc.append(f"    Operation {_text(op_name)}.")
            doc.append("")
        doc.append("    Args:")
        for py, key, prop, _req in params:
            label = py if py == key else f"{py} ({_text(key)})"
            text = _param_doc(prop)
            doc += _wrap(f"{label}: {text}" if text else f"{label}:", "        ", hang="    ")
        doc.append("        client: the Client to call through; default Client(), set up from the environment.")
        doc.append("        **options: passed to Client.call: fields, max_chars, max_tier, max_age, wait, ...")
        doc.append("")
        if typed_lines:
            doc.append(
                f"    Data: {'a list of ' + typed if cardinality == 'list' else 'one ' + typed}; a key the site "
                "leaves out is absent."
            )
        else:
            doc.append("    Data: whatever the site answers; the operation records no field hints.")
        doc.append('    """')
        lines += doc

        req_items = [f"{key!r}: {py}" for py, key, _, req in params if req]
        lines.append(f"    args: Dict[str, Any] = {{{', '.join(req_items)}}}")
        for py, key, _, req in params:
            if not req:
                lines += [f"    if {py} is not None:", f"        args[{key!r}] = {py}"]
        lines.append(f"    return _call({op_name!r}, args, client, options)")
        blocks.append(lines)

    header = [
        f'"""Typed functions for the {_text(site_name)} site\'s read operations.',
        "",
        f"Generated by `python -m api_anything gen {_text(site_name)}` from the site's operations: regenerate it",
        "rather than editing it. Each function calls its operation through a running api-anything server",
        "(Client.call), so its tiers, repairs and failure classes still apply, and returns the Result:",
        "result.raise_for_status() raises the class's exception. The server checks each argument's",
        "pattern and bounds. No credential is in this file: the server keeps the session.",
    ]
    if writes:
        header += ["", "Writes are left out; send one with Client.write."]
    header.append('"""')

    typing_names = sorted(used)
    out: List[str] = header + [
        "",
        "from __future__ import annotations",
        "",
        f"from typing import {', '.join(typing_names)}",
        "",
        "from api_anything import Client, Result",
        "",
        f"SITE = {site_name!r}",
        "",
        "_client: Optional[Client] = None",
        "",
        "",
        "def _call(op: str, args: Dict[str, Any], client: Optional[Client], options: Dict[str, Any]) -> Result[Any]:",
        "    global _client",
        "    if client is None:",
        "        if _client is None:",
        "            _client = Client()",
        "        client = _client",
        "    return client.call(SITE, op, args, **options)",
    ]
    for block in blocks:
        out += ["", ""] + block
    return "\n".join(line.rstrip() for line in out) + "\n"


def generate_site(client: Any, site: str) -> str:
    """Fetch the site's operations from the server and generate its module."""
    return generate(client.operations(site), site)


def main(argv: Optional[Sequence[str]] = None) -> int:
    import argparse
    import sys

    from .client import Client
    from .errors import ApiAnythingError

    parser = argparse.ArgumentParser(
        prog="python -m api_anything gen", description="Write a typed Python module for a site's read operations."
    )
    parser.add_argument("site")
    parser.add_argument("-o", "--output", help="file to write; default: stdout")
    parser.add_argument("--url", help="the server; default: API_ANYTHING_URL or http://127.0.0.1:8787")
    options = parser.parse_args(argv)
    try:
        source = generate_site(Client(options.url), options.site)
    except ApiAnythingError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if options.output:
        with open(options.output, "w", encoding="utf-8", newline="\n") as f:
            f.write(source)
        print(f"wrote {options.output}", file=sys.stderr)
    else:
        sys.stdout.write(source)
    return 0
