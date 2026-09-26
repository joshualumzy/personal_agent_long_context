#!/usr/bin/env python3
"""Build emergent memory from one question's slice, and read it back.

The deterministic graph states what the corpus already records: which artifact
references which, and who appears in each. What it cannot state is what the text
means — that a decision was reversed, that two teams disagreed about a cause,
that a risk was raised before it happened. Extracting that needs a language
model reading the prose.

Doing it over the whole corpus would be slow and expensive and mostly wasted, so
it is done per question: `query_slice.py` selects the dozen or so artifacts a
question is about, and only those are extracted here. Cost then follows how much
is asked rather than how much exists, and memory accumulates around real use.

Storage is cognee's embedded default — Ladybug for the graph, LanceDB for
vectors, SQLite for metadata — so it is all local files under `.cognee/` and
nothing has to be deployed. This is deliberately separate from Postgres: the
deterministic graph stays authoritative there, and nothing here is allowed to
write back.

Configuration comes from the environment, via any OpenAI-compatible endpoint::

    LLM_PROVIDER=custom
    LLM_ENDPOINT=https://.../v1
    LLM_MODEL=openai/qwen3.8:27b
    LLM_API_KEY=...

Usage
-----
    # build memory from a slice, then ask it something
    python query_slice.py "why did the TiDB migration slip" -o slice.json
    python cognee_memory.py remember slice.json
    python cognee_memory.py recall "who raised the TiDB risk first?"

    # what the extractor made of it
    python cognee_memory.py graph -o emergent.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

# Reads the repository's .env, so DATABASE_URL and the LLM settings do not
# have to be exported by hand. Must precede any use of os.environ.
import _env  # noqa: F401  (imported for its side effect)

# Keep cognee's files beside the code rather than in a home directory, so a
# checkout is self-contained and easy to throw away.
STORAGE = Path(__file__).resolve().parent / ".cognee"
DATASET = "orgforge_slices"


def configure() -> None:
    """Point cognee at local storage and check it has what it needs."""
    STORAGE.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("DATA_ROOT_DIRECTORY", str(STORAGE / "data"))
    os.environ.setdefault("SYSTEM_ROOT_DIRECTORY", str(STORAGE / "system"))

    if not os.environ.get("LLM_API_KEY"):
        raise SystemExit(
            "LLM_API_KEY is not set, so there is no model to extract with.\n"
            "Add it to .env, along with an OpenAI-compatible endpoint:\n"
            "  LLM_PROVIDER=custom\n"
            "  LLM_ENDPOINT=https://api.deepseek.com\n"
            "  LLM_MODEL=openai/deepseek-v4-pro\n"
            "  LLM_API_KEY=..."
        )

    # Extraction embeds as well as prompts, and cognee defaults to OpenAI
    # embeddings. A DeepSeek key cannot serve those — DeepSeek publishes no
    # /embeddings endpoint — so say so here rather than failing mid-run.
    provider = (os.environ.get("EMBEDDING_PROVIDER") or "").lower()
    if not provider or provider == "openai":
        endpoint = os.environ.get("LLM_ENDPOINT", "")
        if "openai.com" not in endpoint:
            raise SystemExit(
                "EMBEDDING_PROVIDER is unset, so cognee would ask OpenAI to embed, "
                f"but LLM_ENDPOINT is {endpoint or '(unset)'}.\n"
                "Embed locally instead — fastembed ships with cognee:\n"
                "  EMBEDDING_PROVIDER=fastembed\n"
                "  EMBEDDING_MODEL=BAAI/bge-small-en-v1.5\n"
                "  EMBEDDING_DIMENSIONS=384"
            )


def as_document(document: dict[str, Any]) -> str:
    """Render one artifact for the extractor.

    The heading carries the identifier and provenance so an extracted claim can
    be traced back to the artifact it came from, and so the model can tell a
    ticket from a chat log rather than inferring it from prose.
    """
    header = [
        f"# {document['title']}",
        f"artifact: {document['source_id']}",
        f"type: {document['source_type']}",
    ]
    if document.get("occurred_at"):
        header.append(f"date: {document['occurred_at']}")
    if document.get("department"):
        header.append(f"department: {document['department']}")
    if document.get("is_incident"):
        header.append("part of an incident: yes")
    return "\n".join(header) + "\n\n" + document["text"]


async def remember(slice_path: Path) -> None:
    import cognee

    payload = json.loads(slice_path.read_text(encoding="utf-8"))
    documents = payload.get("documents", [])
    if not documents:
        raise SystemExit(f"{slice_path} holds no documents.")

    question = payload.get("question", "(unknown question)")
    characters = sum(len(d.get("text", "")) for d in documents)
    print(f"Question: {question}", file=sys.stderr)
    print(f"Extracting from {len(documents)} artifacts "
          f"({characters} characters)...", file=sys.stderr)

    for index, document in enumerate(documents, start=1):
        await cognee.add(as_document(document), dataset_name=DATASET)
        print(f"  added {index}/{len(documents)}  {document['source_id']}",
              file=sys.stderr)

    # This is the expensive step: the model reads each document and proposes
    # entities and relationships.
    await cognee.cognify(datasets=[DATASET])
    print("Extraction finished.", file=sys.stderr)


async def recall(question: str) -> None:
    import cognee
    from cognee.api.v1.search import SearchType

    results = await cognee.search(
        query_text=question, query_type=SearchType.GRAPH_COMPLETION,
        datasets=[DATASET],
    )
    if not results:
        print("Nothing recalled. Has a slice been remembered yet?", file=sys.stderr)
        return
    for result in results:
        print(result if isinstance(result, str) else json.dumps(
            result, indent=2, ensure_ascii=False, default=str))


async def export_graph(output: str | None) -> None:
    """Write the extracted graph out, in the same shape as export_graph.py.

    Matching that shape means the emergent graph and the deterministic one can be
    rendered by the same front end, and compared side by side.

    Access control is on by default, so the graph has to be read through the
    owning user and dataset. Asking the graph engine directly returns nothing:
    the data is there, but scoped, and an unscoped read simply does not see it.
    """
    from cognee.modules.users.methods import get_default_user
    from cognee.modules.data.methods import get_authorized_existing_datasets
    from cognee.api.v1.visualize.visualize import fetch_dataset_graph_data

    user = await get_default_user()
    authorized = await get_authorized_existing_datasets([DATASET], "read", user)
    if not authorized:
        raise SystemExit(
            f"Dataset {DATASET!r} is not readable, or nothing has been "
            "remembered into it yet."
        )

    # full=True asks for the whole dataset rather than a neighbourhood around a
    # query, which is what an export wants. The dataset carries its own owner, so
    # no user has to be passed: the read is scoped from the dataset itself.
    graph_data = await fetch_dataset_graph_data(authorized[0], full=True)
    raw_nodes = getattr(graph_data, "nodes", None)
    raw_edges = getattr(graph_data, "edges", None)
    if raw_nodes is None:
        raw_nodes, raw_edges = graph_data[0], graph_data[1]

    nodes = []
    for entry in raw_nodes:
        identifier, properties = entry if isinstance(entry, tuple) else (entry, {})
        properties = properties or {}
        nodes.append({
            "id": str(identifier),
            "type": properties.get("type", "entity"),
            "label": properties.get("name") or properties.get("text")
                     or str(identifier),
        })

    edges = []
    for entry in raw_edges:
        source, target, relationship, *rest = entry
        properties = rest[0] if rest else {}
        edges.append({
            "source": str(source),
            "target": str(target),
            "type": relationship,
            **{k: v for k, v in (properties or {}).items()
               if isinstance(v, (str, int, float, bool))},
        })

    graph = {"nodes": nodes, "edges": edges,
             "meta": {"source": "cognee", "dataset": DATASET,
                      "node_count": len(nodes), "edge_count": len(edges)}}
    payload = json.dumps(graph, indent=2, ensure_ascii=False, default=str)
    if output:
        Path(output).write_text(payload + "\n", encoding="utf-8")
        print(f"Wrote {len(nodes)} nodes and {len(edges)} edges to {output}.",
              file=sys.stderr)
    else:
        print(payload)


async def forget() -> None:
    import cognee

    await cognee.prune.prune_data()
    await cognee.prune.prune_system(metadata=True)
    print("Emergent memory cleared.", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    remember_command = subcommands.add_parser(
        "remember", help="extract a graph from a slice written by query_slice.py")
    remember_command.add_argument("slice", help="path to the slice JSON")

    recall_command = subcommands.add_parser(
        "recall", help="answer from what has been extracted")
    recall_command.add_argument("question")

    graph_command = subcommands.add_parser(
        "graph", help="export the extracted graph as JSON")
    graph_command.add_argument("-o", "--output")

    subcommands.add_parser("forget", help="delete all extracted memory")

    arguments = parser.parse_args()
    configure()

    if arguments.command == "remember":
        asyncio.run(remember(Path(arguments.slice)))
    elif arguments.command == "recall":
        asyncio.run(recall(arguments.question))
    elif arguments.command == "graph":
        asyncio.run(export_graph(arguments.output))
    elif arguments.command == "forget":
        asyncio.run(forget())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
