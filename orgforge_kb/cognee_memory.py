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
is asked rather than how much exists.

Each question gets its own dataset, and its own exported graph. Sharing one
dataset merges everything ever asked into a single picture, where a relationship
can no longer be attributed to the question that found it — which is exactly what
makes an emergent graph worth looking at.

Storage is cognee's embedded default — Ladybug for the graph, LanceDB for
vectors, SQLite for metadata — so it is all local files under `.cognee/` and
nothing has to be deployed. This is deliberately separate from Postgres: the
deterministic graph stays authoritative there, and nothing here is allowed to
write back.

Configuration comes from the environment, via any OpenAI-compatible endpoint::

    LLM_PROVIDER=custom
    LLM_ENDPOINT=https://.../v1
    LLM_MODEL=openai/deepseek-flash
    LLM_API_KEY=...
    EMBEDDING_PROVIDER=fastembed
    EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
    EMBEDDING_DIMENSIONS=384

Usage
-----
    # build memory from one question's slice, then ask it something
    python query_slice.py "why did the TiDB migration slip" -o slice.json
    python cognee_memory.py remember slice.json
    python cognee_memory.py recall "who raised the TiDB risk first?"

    # one graph per question, written where /graph reads them
    python cognee_memory.py graph
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Reads the repository's .env, so DATABASE_URL and the LLM settings do not
# have to be exported by hand. Must precede any use of os.environ.
import _env  # noqa: F401  (imported for its side effect)

# Keep cognee's files beside the code rather than in a home directory, so a
# checkout is self-contained and easy to throw away.
STORAGE = Path(__file__).resolve().parent / ".cognee"
# One dataset per question, so a graph shows what that question turned up rather
# than the union of everything ever asked. A relationship in a shared dataset
# cannot be traced back to the question that found it, which makes the picture
# unreadable as soon as there is more than one.
DATASET_PREFIX = "orgforge_q_"
# What has been extracted, and under which dataset. Written by remember, read by
# graph and by the background worker deciding what still needs doing.
QUESTIONS = STORAGE / "questions.json"
# Where the web view looks: one file per question, plus an index. `data/` is
# already ignored by Git.
WEB_EXPORT_DIR = Path(__file__).resolve().parent.parent / "data" / "emergent-graph"

# cognee's own scaffolding, as opposed to what it extracted from the text.
STRUCTURAL_NODES = {"TextDocument", "DocumentChunk", "TextSummary"}
# Relationships cognee creates to hold its structure together, rather than
# relationships it found in the prose. They are two thirds of all edges.
STRUCTURAL_EDGES = {"contains", "is_a", "made_from", "is_part_of"}


def slug_for(question: str) -> str:
    """A short, stable, filesystem- and dataset-safe name for a question.

    The readable prefix makes an export directory browsable; the hash keeps two
    similar questions apart, and keeps the name stable across runs.
    """
    normalized = re.sub(r"[^a-z0-9]+", "_", question.strip().lower()).strip("_")
    digest = hashlib.sha256(question.strip().encode("utf-8")).hexdigest()[:8]
    return f"{normalized[:48].rstrip('_')}_{digest}" if normalized else digest


def dataset_for(question: str) -> str:
    return f"{DATASET_PREFIX}{slug_for(question)}"


def note_question(question: str) -> None:
    """Record a question and the dataset holding what was extracted from it."""
    question = question.strip()
    record = recorded()
    record = [entry for entry in record if entry.get("question") != question]
    record.append({
        "question": question,
        "slug": slug_for(question),
        "dataset": dataset_for(question),
        "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    QUESTIONS.parent.mkdir(parents=True, exist_ok=True)
    QUESTIONS.write_text(json.dumps(record, indent=2, ensure_ascii=False),
                         encoding="utf-8")


def recorded() -> list[dict[str, str]]:
    """Every question extracted so far.

    Tolerates the older format, a bare list of question strings, so an existing
    checkout does not have to be cleared by hand.
    """
    if not QUESTIONS.is_file():
        return []
    try:
        parsed = json.loads(QUESTIONS.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    if not isinstance(parsed, list):
        return []
    entries = []
    for item in parsed:
        if isinstance(item, str):
            entries.append({"question": item, "slug": slug_for(item),
                            "dataset": dataset_for(item), "extracted_at": ""})
        elif isinstance(item, dict) and isinstance(item.get("question"), str):
            entries.append(item)
    return entries


def recorded_questions() -> list[str]:
    return [entry["question"] for entry in recorded()]


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
    dataset = dataset_for(question)
    print(f"Question: {question}", file=sys.stderr)
    print(f"Dataset:  {dataset}", file=sys.stderr)
    print(f"Extracting from {len(documents)} artifacts "
          f"({characters} characters)...", file=sys.stderr)

    for index, document in enumerate(documents, start=1):
        await cognee.add(as_document(document), dataset_name=dataset)
        print(f"  added {index}/{len(documents)}  {document['source_id']}",
              file=sys.stderr)

    # This is the expensive step: the model reads each document and proposes
    # entities and relationships.
    await cognee.cognify(datasets=[dataset])
    note_question(question)
    print("Extraction finished.", file=sys.stderr)


async def recall(question: str, about: str | None) -> None:
    """Answer from what was extracted.

    Each question has its own dataset, so recall needs to know which one to read.
    `about` names it; without it, every dataset is searched, which is the right
    default for a question that was never itself extracted.
    """
    import cognee
    from cognee.api.v1.search import SearchType

    record = recorded()
    if not record:
        print("Nothing has been extracted yet.", file=sys.stderr)
        return
    datasets = (
        [dataset_for(about)]
        if about
        else [entry["dataset"] for entry in record]
    )

    results = await cognee.search(
        query_text=question, query_type=SearchType.GRAPH_COMPLETION,
        datasets=datasets,
    )
    if not results:
        print("Nothing recalled from " + ", ".join(datasets), file=sys.stderr)
        return
    for result in results:
        print(result if isinstance(result, str) else json.dumps(
            result, indent=2, ensure_ascii=False, default=str))


async def fetch_graph(dataset: str) -> tuple[list[Any], list[Any]]:
    """Read one dataset's graph.

    Access control is on by default and graph data is scoped to its dataset, so
    this has to go through the owning user and dataset. Asking the graph engine
    directly returns nothing: the data is there, but scoped, and an unscoped read
    simply does not see it. `full=True` asks for the whole dataset rather than a
    neighbourhood around a query.
    """
    from cognee.modules.users.methods import get_default_user
    from cognee.modules.data.methods import get_authorized_existing_datasets
    from cognee.api.v1.visualize.visualize import fetch_dataset_graph_data

    user = await get_default_user()
    authorized = await get_authorized_existing_datasets([dataset], "read", user)
    if not authorized:
        return [], []

    graph_data = await fetch_dataset_graph_data(authorized[0], full=True)
    raw_nodes = getattr(graph_data, "nodes", None)
    raw_edges = getattr(graph_data, "edges", None)
    if raw_nodes is None:
        raw_nodes, raw_edges = graph_data[0], graph_data[1]
    return list(raw_nodes), list(raw_edges or [])


def shape_graph(raw_nodes: list[Any], raw_edges: list[Any],
                semantic_only: bool) -> tuple[list[dict], list[dict]]:
    """Turn cognee's tuples into the shape export_graph.py produces, so the two
    graphs can be rendered by one front end.

    `semantic_only` drops cognee's own scaffolding — the document, chunk and
    summary nodes, and the edges holding them together. Those are two thirds of
    the graph and none of it was found in the prose, so leaving them in buries
    the extracted relationships in structure.
    """
    nodes = []
    for entry in raw_nodes:
        identifier, properties = entry if isinstance(entry, tuple) else (entry, {})
        properties = properties or {}
        nodes.append({
            "id": str(identifier),
            "type": properties.get("type", "entity"),
            "label": properties.get("name") or properties.get("text") or str(identifier),
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

    if semantic_only:
        nodes = [n for n in nodes if n["type"] not in STRUCTURAL_NODES]
        edges = [e for e in edges if e["type"] not in STRUCTURAL_EDGES]
        # Drop edges whose ends went with the structural nodes, then drop nodes
        # left with nothing attached: an isolated dot says nothing.
        present = {n["id"] for n in nodes}
        edges = [e for e in edges if e["source"] in present and e["target"] in present]
        attached = {e["source"] for e in edges} | {e["target"] for e in edges}
        nodes = [n for n in nodes if n["id"] in attached]

    return nodes, edges


async def export_graph(output_dir: str | None, semantic_only: bool) -> None:
    """Write one graph per question, plus an index of them.

    One file per question is the point: a graph shows what that question turned
    up. Merging them would make a relationship impossible to attribute, which is
    what a shared dataset did.
    """
    directory = Path(output_dir) if output_dir else WEB_EXPORT_DIR
    directory.mkdir(parents=True, exist_ok=True)

    record = recorded()
    if not record:
        raise SystemExit("Nothing has been extracted yet, so there is nothing to export.")

    index = []
    for entry in record:
        raw_nodes, raw_edges = await fetch_graph(entry["dataset"])
        if not raw_nodes:
            print(f"  skipped {entry['slug']}: its dataset holds no graph",
                  file=sys.stderr)
            continue
        nodes, edges = shape_graph(raw_nodes, raw_edges, semantic_only)
        graph = {
            "nodes": nodes,
            "edges": edges,
            "meta": {
                "source": "cognee",
                "question": entry["question"],
                "slug": entry["slug"],
                "dataset": entry["dataset"],
                "extracted_at": entry.get("extracted_at", ""),
                "semantic_only": semantic_only,
                "node_count": len(nodes),
                "edge_count": len(edges),
            },
        }
        (directory / f"{entry['slug']}.json").write_text(
            json.dumps(graph, indent=2, ensure_ascii=False, default=str) + "\n",
            encoding="utf-8",
        )
        index.append({k: graph["meta"][k] for k in
                      ("question", "slug", "extracted_at", "node_count", "edge_count")})
        print(f"  {entry['slug']}: {len(nodes)} nodes, {len(edges)} edges",
              file=sys.stderr)

    (directory / "index.json").write_text(
        json.dumps({"graphs": index, "semantic_only": semantic_only},
                   indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(index)} graphs to {directory}.", file=sys.stderr)


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
    recall_command.add_argument("--about",
                               help="read only the graph extracted for this "
                                    "question; defaults to all of them")

    graph_command = subcommands.add_parser(
        "graph", help="export one graph per question, plus an index")
    graph_command.add_argument("-o", "--output-dir",
                               help=f"defaults to {WEB_EXPORT_DIR}, where /graph reads it")
    graph_command.add_argument("--everything", action="store_true",
                               help="keep cognee's own document, chunk and summary "
                                    "scaffolding as well as what it extracted")

    subcommands.add_parser("forget", help="delete all extracted memory")

    arguments = parser.parse_args()
    configure()

    if arguments.command == "remember":
        asyncio.run(remember(Path(arguments.slice)))
    elif arguments.command == "recall":
        asyncio.run(recall(arguments.question, arguments.about))
    elif arguments.command == "graph":
        asyncio.run(export_graph(arguments.output_dir, not arguments.everything))
    elif arguments.command == "forget":
        asyncio.run(forget())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
