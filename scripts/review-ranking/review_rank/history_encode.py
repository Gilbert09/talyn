"""Encode reconstructed PR titles locally with resumable private output."""

import argparse
import json
from pathlib import Path

from .encoder import Encoder
from .historical_content import title_history
from .outcomes import digest, write_private
from .replay import load_history


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path("artifacts/encoder-cache"))
    parser.add_argument("--vector-cache", type=Path, default=Path("artifacts/title-vectors"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--download-model", action="store_true")
    args = parser.parse_args()
    history = load_history(args.history)
    encoder = Encoder(args.cache, args.download_model)
    texts = {}
    for pull in history["pulls"]:
        if pull.get("quality", {}).get("title") is False:
            continue
        times, titles = title_history(pull)
        for at, title in zip(times, titles, strict=True):
            if at < history["end"]:
                texts[digest(title)] = title
    vectors = {}
    namespace = args.vector_cache / digest(encoder.provenance)
    for index, (key, text) in enumerate(sorted(texts.items())):
        path = namespace / f"{key}.json"
        if path.exists():
            record = json.loads(path.read_text())
        else:
            vector, audit = encoder.encode(text)
            record = {"text_sha256": key, "vector": vector, "audit": audit}
            write_private(path, record)
        if record["text_sha256"] != key:
            raise ValueError("Title vector cache identity mismatch")
        vectors[key] = record["vector"]
        if index % 1000 == 0:
            print(json.dumps({"encoded_titles": index + 1, "total": len(texts)}), flush=True)
    write_private(
        args.output,
        {
            "schema_version": 1,
            "source_sha256": digest(history),
            "encoder": encoder.provenance,
            "vectors": vectors,
        },
    )
    print(json.dumps({"encoded_titles": len(vectors), "complete": True}), flush=True)


if __name__ == "__main__":
    main()
